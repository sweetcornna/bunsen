//! 集成测试：起真实的 `bunsen serve`，通过 HTTP / WebSocket 接口走完整条流程。
//! 目标是本机的一次性 SSH 容器（dev/test-server/run.sh up，默认 dev@127.0.0.1:2222）。
//! 自定义端口：`BUNSEN_TEST_PORT=2223 dev/test-server/run.sh up`，然后 `dev/itest.sh`。
//! `dev/itest.sh` 自动读取保存的端口；直接运行 cargo 时需设置同一个 `BUNSEN_TEST_PORT`（缺省 2222）。
//!
//! 运行：`dev/itest.sh`
//! 或：`BUNSEN_ITEST=1 cargo test -p bunsen-cli --test itest -- --ignored --nocapture`

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

fn app_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn fixtures() -> PathBuf {
    app_root().join("dev/test-server/.tmp")
}

fn rand_tag() -> String {
    bunsen_core::util::short_id()
}

fn step(name: &str) {
    println!("[通过] {name}");
}

struct Serve {
    child: Child,
    port: u16,
    token: String,
}

impl Serve {
    fn start(data: &Path, cm: &Path, envs: &[(&str, &str)]) -> Serve {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let mut child = Command::new(env!("CARGO_BIN_EXE_bunsen"))
            .args(["serve", "--port", &port.to_string(), "--no-open"])
            .env("BUNSEN_DATA_DIR", data)
            .env("BUNSEN_CM_DIR", cm)
            .envs(envs.iter().copied())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("启动 bunsen serve 失败");
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(i) = line.find("#token=") {
                    let _ = tx.send(line[i + 7..].trim().to_string());
                }
            }
        });
        let token = rx.recv_timeout(Duration::from_secs(20)).expect("服务没有打印带令牌的地址");
        assert_eq!(token.len(), 64, "令牌应为 32 字节十六进制");
        Serve { child, port, token }
    }

    fn url(&self, p: &str) -> String {
        format!("http://127.0.0.1:{}{p}", self.port)
    }

    fn client(&self) -> reqwest::Client {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert("x-bunsen-token", self.token.parse().unwrap());
        reqwest::Client::builder().default_headers(h).timeout(Duration::from_secs(120)).build().unwrap()
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn json_of(r: reqwest::Response) -> (u16, Value) {
    let status = r.status().as_u16();
    let text = r.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or_else(|_| panic!("不是 JSON：{text}")))
}

async fn get(c: &reqwest::Client, s: &Serve, p: &str) -> (u16, Value) {
    json_of(c.get(s.url(p)).send().await.unwrap()).await
}

async fn send_json(c: &reqwest::Client, method: reqwest::Method, s: &Serve, p: &str, body: Value) -> (u16, Value) {
    json_of(c.request(method, s.url(p)).json(&body).send().await.unwrap()).await
}

async fn post(c: &reqwest::Client, s: &Serve, p: &str, body: Value) -> (u16, Value) {
    send_json(c, reqwest::Method::POST, s, p, body).await
}

/// 原始 HTTP 请求（用于自定义 Host 头）。
fn raw_status(port: u16, host: &str, path: &str, token: Option<&str>, origin: Option<&str>) -> u16 {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(t) = token {
        req.push_str(&format!("x-bunsen-token: {t}\r\n"));
    }
    if let Some(o) = origin {
        req.push_str(&format!("Origin: {o}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).unwrap();
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0)
}

async fn import(c: &reqwest::Client, s: &Serve) -> Value {
    let fx = fixtures();
    let cfg = std::fs::read(fx.join("ssh_config")).expect("缺少 dev/test-server/.tmp/ssh_config：先执行 dev/test-server/run.sh up");
    let key = std::fs::read(fx.join("id_test")).unwrap();
    let form = reqwest::multipart::Form::new()
        .part("files", reqwest::multipart::Part::bytes(cfg).file_name("ssh_config"))
        .part("files", reqwest::multipart::Part::bytes(key).file_name("id_test"));
    let (code, v) = json_of(c.post(s.url("/api/servers/import")).multipart(form).send().await.unwrap()).await;
    assert_eq!(code, 200, "{v}");
    v
}

async fn session(c: &reqwest::Client, s: &Serve, id: &str) -> Value {
    let (code, v) = get(c, s, &format!("/api/sessions/{id}")).await;
    assert_eq!(code, 200, "{v}");
    v
}

async fn wait_session(c: &reqwest::Client, s: &Serve, id: &str, pred: impl Fn(&Value) -> bool, what: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let v = session(c, s, id).await;
        if pred(&v) {
            return v;
        }
        assert!(Instant::now() < deadline, "等待超时：{what}；最后状态 {v}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn capture(c: &reqwest::Client, s: &Serve, id: &str) -> String {
    let (code, v) = get(c, s, &format!("/api/sessions/{id}/capture?lines=200")).await;
    assert_eq!(code, 200, "{v}");
    v["text"].as_str().unwrap().to_string()
}

async fn wait_capture(c: &reqwest::Client, s: &Serve, id: &str, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let t = capture(c, s, id).await;
        if t.contains(needle) {
            return t;
        }
        assert!(Instant::now() < deadline, "窗格里没有出现“{needle}”：\n{t}");
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// ndjson 部署：返回 (所有行, 最后一行)。
async fn deploy_ndjson(c: &reqwest::Client, s: &Serve, body: Value) -> Vec<Value> {
    let mut r = c
        .post(s.url("/api/sessions"))
        .header("accept", "application/x-ndjson")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert!(r.headers()["content-type"].to_str().unwrap().starts_with("application/x-ndjson"));
    let mut buf = Vec::new();
    while let Some(chunk) = r.chunk().await.unwrap() {
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf)
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|_| panic!("不是 JSON 行：{l}")))
        .collect()
}

/// 连上终端通道，发一段输入，收输出直到出现 `needle`；返回 (输出, 是否收到 closed)。
async fn ws_expect(url: &str, input: Option<&str>, needle: &str, want_closed: bool) -> (String, bool) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.expect("WebSocket 连接失败");
    if let Some(i) = input {
        ws.send(Message::Text(json!({ "type": "input", "data": i }).to_string().into())).await.unwrap();
    }
    let mut out = Vec::new();
    let mut closed = false;
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let text = String::from_utf8_lossy(&out).to_string();
        if text.contains(needle) && (!want_closed || closed) {
            break;
        }
        match tokio::time::timeout_at(deadline.into(), ws.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => out.extend_from_slice(&b),
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["state"] == "closed" {
                    closed = true;
                }
            }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(Some(Ok(_))) => {}
            other => panic!("终端通道异常：{other:?}\n{text}"),
        }
    }
    let _ = ws.close(None).await;
    (String::from_utf8_lossy(&out).to_string(), closed)
}

/// 直接在测试服务器上执行脚本（准备测试数据、检查结果），用数据目录里生成的 ssh 配置。
fn remote(data: &Path, script: &str) -> (i32, String) {
    let mut ch = Command::new("ssh")
        .arg("-F")
        .arg(data.join("ssh/config"))
        .args(["-o", "BatchMode=yes", "bunsen-test", "bash", "-s"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    ch.stdin.take().unwrap().write_all(format!("export PATH=\"$HOME/.local/bin:$PATH\"\n{script}").as_bytes()).unwrap();
    let out = ch.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    (out.status.code().unwrap_or(-1), text)
}

/// 起一个 `bunsen mcp`，逐条发请求，按 id 收回复。
struct Mcp {
    child: Child,
    stdin: std::process::ChildStdin,
    rx: std::sync::mpsc::Receiver<Value>,
    next: u64,
}

impl Mcp {
    fn start(data: &Path, cm: &Path) -> Mcp {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bunsen"))
            .arg("mcp")
            .env("BUNSEN_DATA_DIR", data)
            .env("BUNSEN_CM_DIR", cm)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(v);
                }
            }
        });
        Mcp { child, stdin, rx, next: 1 }
    }

    fn notify(&mut self, method: &str) {
        writeln!(self.stdin, "{}", json!({ "jsonrpc": "2.0", "method": method })).unwrap();
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        writeln!(self.stdin, "{}", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).unwrap();
        loop {
            let v = self.rx.recv_timeout(Duration::from_secs(60)).expect("MCP 没有回复");
            if v["id"] == id {
                return v;
            }
        }
    }

    /// tools/call，返回 (isError, 文本里的 JSON)。
    fn tool(&mut self, name: &str, args: Value) -> (bool, Value) {
        let r = self.call("tools/call", json!({ "name": name, "arguments": args }));
        let res = &r["result"];
        let text = res["content"][0]["text"].as_str().unwrap_or_else(|| panic!("MCP 回复不对：{r}"));
        (res["isError"].as_bool().unwrap_or(false), serde_json::from_str(text).unwrap())
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn ssh_cleanup(data: &Path, script: &str) {
    let _ = Command::new("ssh")
        .arg("-F")
        .arg(data.join("ssh/config"))
        .args(["-o", "BatchMode=yes", "bunsen-test", "bash", "-s"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut ch| {
            ch.stdin.take().unwrap().write_all(script.as_bytes())?;
            ch.wait()
        });
    let _ = Command::new("ssh")
        .arg("-F")
        .arg(data.join("ssh/config"))
        .args(["-O", "exit", "bunsen-test"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要本机测试容器：dev/test-server/run.sh up；用 dev/itest.sh 运行"]
async fn full_flow() {
    if std::env::var("BUNSEN_ITEST").ok().as_deref() != Some("1") {
        println!("未设置 BUNSEN_ITEST=1，跳过集成测试");
        return;
    }
    tokio::time::timeout(Duration::from_secs(600), flow()).await.expect("集成测试整体超时");
}

async fn flow() {
    let tag = rand_tag();
    let base = std::env::temp_dir().join(format!("bunsen-itest-{tag}"));
    let data1 = base.join("data1");
    let data2 = base.join("data2");
    // ControlPath 是 unix 套接字，路径要短。
    let cm = PathBuf::from(format!("/tmp/opit-{tag}"));
    let plugin_src = base.join("research-plugin");
    std::fs::create_dir_all(plugin_src.join("skills/a")).unwrap();
    std::fs::write(plugin_src.join("marker.txt"), "插件标记\n").unwrap();
    std::fs::write(plugin_src.join("skills/a/SKILL.md"), "# a\n").unwrap();
    // 本机目录来源的插件：带上一堆不该下发的东西，验证过滤与可执行位。
    let labkit = base.join("labkit");
    for d in ["skills/lab", "scripts", "keys", "secrets", ".git", ".claude", "tests", "node_modules/m"] {
        std::fs::create_dir_all(labkit.join(d)).unwrap();
    }
    for (f, body) in [
        ("skills/lab/SKILL.md", "# 实验室\n"),
        ("scripts/run.sh", "#!/bin/sh\necho run\n"),
        ("notes.md", "笔记\n"),
        ("keys/id_lab", "secret"),
        ("secrets/token", "secret"),
        (".git/HEAD", "ref: x"),
        (".claude/settings.json", "{}"),
        ("tests/t.sh", "echo t"),
        ("node_modules/m/index.js", "x"),
        ("id_rsa", "secret"),
        ("cert.pem", "secret"),
        ("api.key", "secret"),
        ("lab.md", "secret"),
        (".env", "A=1"),
        (".env.local", "A=1"),
    ] {
        std::fs::write(labkit.join(f), body).unwrap();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(labkit.join("scripts/run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let remote_root = format!("itest-{tag}");
    let workdir = format!("~/{remote_root}/work dir");

    let mut a = Serve::start(&data1, &cm, &[]);
    let c = a.client();
    step("服务启动并打印 http://127.0.0.1:<port>/#token=<64 位十六进制>");

    // ---- 鉴权与防跨站 ----
    let host = format!("127.0.0.1:{}", a.port);
    assert_eq!(raw_status(a.port, &host, "/api/meta", None, None), 401);
    assert_eq!(raw_status(a.port, &host, "/api/meta", Some("wrong"), None), 401);
    assert_eq!(raw_status(a.port, "evil.example:80", "/api/meta", Some(&a.token), None), 403);
    assert_eq!(raw_status(a.port, &format!("127.0.0.1:{}", a.port + 1), "/api/meta", Some(&a.token), None), 403);
    assert_eq!(raw_status(a.port, &host, "/api/meta", Some(&a.token), Some("http://evil.example")), 403);
    assert_eq!(raw_status(a.port, &host, "/api/meta", Some(&a.token), Some(&format!("http://localhost:{}", a.port))), 200);
    assert_eq!(raw_status(a.port, &format!("localhost:{}", a.port), "/api/meta", Some(&a.token), None), 200);
    assert_eq!(raw_status(a.port, &host, "/", None, None), 200, "界面入口不需要令牌");
    assert_eq!(raw_status(a.port, "evil.example", "/", None, None), 403);
    assert_eq!(raw_status(a.port, &host, "/ws/term?session=x&pane=agent", None, None), 401);
    let (code, v) = get(&c, &a, "/api/nope").await;
    assert_eq!((code, v["error"]["code"].as_str()), (404, Some("not_found")));
    let code = reqwest::Client::new().get(a.url("/api/meta")).send().await.unwrap().status().as_u16();
    assert_eq!(code, 401);
    step("鉴权：无令牌 401、错误 Host 403、跨站 Origin 403、界面入口 200");

    let (_, meta) = get(&c, &a, "/api/meta").await;
    assert_eq!(meta["data_dir"].as_str().unwrap(), data1.to_string_lossy());
    assert_eq!(meta["dev"], false);

    // ---- 导入 ----
    let imp = import(&c, &a).await;
    assert_eq!(imp["servers_added"].as_array().unwrap().len(), 1, "{imp}");
    let sv = &imp["servers_added"][0];
    assert_eq!(sv["alias"], "bunsen-test");
    let expected_port = std::env::var("BUNSEN_TEST_PORT")
        .unwrap_or_else(|_| "2222".to_string())
        .parse::<u16>()
        .expect("BUNSEN_TEST_PORT 必须是有效端口");
    assert_eq!(sv["port"], expected_port);
    assert_eq!(sv["key"], "id_test");
    assert_eq!(sv["status"], "online", "{imp}");
    assert_eq!(imp["keys_added"][0]["name"], "id_test");
    assert!(imp["keys_added"][0]["fingerprint"].as_str().unwrap().starts_with("SHA256:"));
    assert_eq!(imp["tests"][0]["ok"], true, "{imp}");
    assert_eq!(imp["tests"][0]["key_used"], "id_test");
    let server_id = sv["id"].as_str().unwrap().to_string();
    // 清掉以前失败的运行留在服务器上的东西（只动集成测试自己建的会话与目录）。
    remote(
        &data1,
        "for f in ~/.bunsen/sessions/*.json; do [ -f \"$f\" ] || continue\n\
           if grep -q -e '\"workdir\":\"~/itest-' -e '\"agent_id\":\"fake-' \"$f\"; then\n\
             i=$(basename \"$f\" .json); tmux -L bunsen kill-session -t \"=op-$i\" 2>/dev/null; tmux -L bunsen kill-session -t \"=op-$i-sh\" 2>/dev/null; rm -f \"$f\"\n\
           fi\n\
         done\nrm -rf ~/itest-*; tmux -L bunsen kill-session -t =op-install-inst-it 2>/dev/null; true",
    );
    let imp_text = imp.to_string();
    assert!(!imp_text.contains("PRIVATE KEY"), "响应里不能出现私钥内容");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let m = std::fs::metadata(data1.join("keys/id_test")).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o600);
        let m = std::fs::metadata(&data1).unwrap().permissions().mode() & 0o777;
        assert_eq!(m, 0o700);
    }
    step("导入 ssh_config + id_test（multipart），自动测试连接成功，私钥 0600");

    let (code, keys) = get(&c, &a, "/api/keys").await;
    assert_eq!(code, 200);
    assert_eq!(keys[0]["used_by"][0], "bunsen-test");

    // ---- 测试连接 / 探测 ----
    let (code, t) = post(&c, &a, &format!("/api/servers/{server_id}/test"), json!({})).await;
    assert_eq!(code, 200);
    assert_eq!(t["ok"], true, "{t}");
    assert!(t["latency_ms"].as_u64().is_some());
    remote(&data1, "rm -f ~/.bunsen/HOST.md ~/.local/bin/nvidia-smi");
    let (code, p) = post(&c, &a, &format!("/api/servers/{server_id}/probe"), json!({})).await;
    assert_eq!(code, 200, "{p}");
    let probe = &p["probe"];
    assert_eq!(probe["tmux"]["present"], true, "{probe}");
    assert!(!probe["os"].as_str().unwrap().is_empty());
    assert_eq!(probe["user"], "dev");
    assert!(probe["cpus"].as_u64().unwrap() >= 1);
    assert_eq!(probe["gpus"], json!([]));
    assert_eq!(probe["agents"]["shell"]["present"], true);
    assert_eq!(probe["agents"]["claude-code"]["present"], false);
    step(&format!("probe：tmux {}、os “{}”、gpus=[]", probe["tmux"]["version"], probe["os"].as_str().unwrap()));

    let (code, g) = get(&c, &a, &format!("/api/servers/{server_id}/gpus")).await;
    assert_eq!((code, g), (200, json!([])));

    // ---- 主机笔记（v1.1）----
    let (code, n) = get(&c, &a, &format!("/api/servers/{server_id}/notes")).await;
    assert_eq!(code, 200, "{n}");
    assert_eq!(n["exists"], true, "探测成功后应写入初稿：{n}");
    let draft = n["text"].as_str().unwrap();
    assert!(draft.contains("主机笔记") && draft.contains("Alpine") && draft.contains("tmux：3"), "{draft}");
    let mine = "# 我的笔记\n- 数据在 /data，'引号' $HOME `x`\n";
    let (code, v) = send_json(&c, reqwest::Method::PUT, &a, &format!("/api/servers/{server_id}/notes"), json!({ "text": mine })).await;
    assert_eq!((code, &v), (200, &json!({ "text": mine, "exists": true })));
    let (code, _) = post(&c, &a, &format!("/api/servers/{server_id}/probe"), json!({})).await;
    assert_eq!(code, 200);
    let (_, n) = get(&c, &a, &format!("/api/servers/{server_id}/notes")).await;
    assert_eq!(n["text"], mine, "再次探测不应覆盖已有笔记");
    let (code, v) = send_json(&c, reqwest::Method::PUT, &a, &format!("/api/servers/{server_id}/notes"), json!({ "text": "x".repeat(256 * 1024 + 1) })).await;
    assert_eq!((code, v["error"]["code"].as_str()), (400, Some("bad_request")));
    step("主机笔记：探测后写初稿（含系统与 tmux），PUT 后原样读回，再探测不覆盖，超 256 KB 拒绝");

    // ---- 显卡进程（v1.1）：在容器里放一个假的 nvidia-smi ----
    let (rc, out) = remote(
        &data1,
        "cat > ~/.local/bin/nvidia-smi <<'EOF'\n#!/bin/sh\ncase \"$*\" in\n  *--query-gpu=*) echo '0, NVIDIA Fake A100, 1234, 81920, 37, GPU-fake-0, 61'; echo '1, NVIDIA Fake A100, 0, 81920, 0, GPU-fake-1, [N/A]' ;;\n  *--query-compute-apps=*) echo 'GPU-fake-0, 1, 1000, python train.py' ;;\nesac\nEOF\nchmod +x ~/.local/bin/nvidia-smi",
    );
    assert_eq!(rc, 0, "{out}");
    let (code, g) = get(&c, &a, &format!("/api/servers/{server_id}/gpus")).await;
    assert_eq!(code, 200, "{g}");
    assert_eq!(g[0]["temp_c"], 61);
    assert_eq!(g[0]["procs"], 1);
    assert_eq!(g[0]["apps"], json!([{ "pid": 1, "user": "root", "mem_mb": 1000, "name": "python train.py" }]));
    assert_eq!((g[1]["temp_c"].clone(), g[1]["apps"].clone(), g[1]["procs"].clone()), (Value::Null, json!([]), json!(0)));
    let (_, p2) = post(&c, &a, &format!("/api/servers/{server_id}/probe"), json!({})).await;
    assert_eq!(p2["probe"]["gpus"], g, "探测结果里的 gpus 也带 temp_c 与 apps");
    remote(&data1, "rm -f ~/.local/bin/nvidia-smi");
    step("显卡：temp_c 与 apps（nvidia-smi --query-compute-apps + ps 查用户），探测结果同样带上");

    // ---- 自定义 Agent ----
    let agent = json!({
        "name": "假代理", "vendor": "测试", "description": "回显输入",
        "detect": "fake-agent", "launch": "fake-agent",
        "launch_with_prompt": "fake-agent {prompt}", "resume": "fake-agent --continue",
        "yolo_flag": "--yolo", "plugin_dir_flag": "--plugin-dir {dir}", "install": []
    });
    let (code, v) = send_json(&c, reqwest::Method::PUT, &a, "/api/agents/fake-it", agent).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["builtin"], false);
    let (_, agents) = get(&c, &a, "/api/agents").await;
    let ids: Vec<&str> = agents.as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap()).collect();
    assert_eq!(ids.first(), Some(&"claude-code"));
    assert_eq!(ids.last(), Some(&"fake-it"));
    step("新增自定义 Agent fake-it（内置在前、自定义在后）");

    // ---- 设置（插件目录）----
    let (code, st) = get(&c, &a, "/api/settings").await;
    assert_eq!(code, 200);
    assert_eq!(st["status_interval_secs"], 30);
    assert_eq!(st["plugin_paths"], json!([]));
    let mut st2 = st.clone();
    st2["plugin_paths"] = json!([labkit.to_string_lossy()]);
    let (code, v) = send_json(&c, reqwest::Method::PUT, &a, "/api/settings", st2).await;
    assert_eq!(code, 200, "{v}");
    let (code, pl) = get(&c, &a, "/api/plugins").await;
    assert_eq!(code, 200, "{pl}");
    let names: Vec<&str> = pl.as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["research", "labkit"]);
    assert_eq!(pl[0]["source"], "bundled");
    assert_eq!(pl[0]["path"], Value::Null);
    assert!(pl[0]["skills"].as_array().unwrap().contains(&json!("orchestrator")));
    assert_eq!(pl[0]["hooks"], true);
    assert!(!pl[0]["version"].as_str().unwrap().is_empty());
    assert_eq!((pl[1]["source"].as_str(), pl[1]["skills"].clone()), (Some("local"), json!(["lab"])));
    step("GET /api/plugins：内嵌的 research 在前，plugin_paths 里的 labkit 在后");

    // ---- 部署（ndjson）----
    let prompt = "it's 中文提示 'q' $HOME `x`";
    let lines = deploy_ndjson(
        &c,
        &a,
        json!({ "server_id": server_id, "agent_id": "fake-it", "workdir": workdir, "prompt": prompt, "yolo": true }),
    )
    .await;
    let last = lines.last().unwrap();
    assert_eq!(last["type"], "done", "部署失败：{lines:?}");
    let order = ["connect", "tmux", "agent", "workdir", "project", "plugin", "start", "verify"];
    let finals: Vec<&Value> = lines.iter().filter(|l| l["type"] == "step" && l["status"] != "running").collect();
    let got: Vec<&str> = finals.iter().map(|l| l["step"].as_str().unwrap()).collect();
    assert_eq!(got, order);
    for f in &finals {
        if f["step"] == "project" {
            assert_eq!(f["status"], "skipped");
            assert_eq!(f["detail"], "未接入研究项目");
            assert!(f["ms"].is_null());
            continue;
        }
        assert_eq!(f["status"], "ok", "步骤没有成功：{f}");
        assert!(f["ms"].as_u64().is_some());
        let running_first = lines.iter().position(|l| l["step"] == f["step"] && l["status"] == "running").unwrap();
        let done_at = lines.iter().position(|l| l == *f).unwrap();
        assert!(running_first < done_at);
    }
    let sess = &last["session"];
    let id = sess["id"].as_str().unwrap().to_string();
    assert_eq!(id.len(), 6);
    assert_eq!(sess["tmux"], format!("op-{id}"));
    assert_eq!(sess["state"], "running");
    assert_eq!(sess["origin"], "local");
    assert!(sess["project_id"].is_null());
    assert!(sess["machine"].is_null());
    assert_eq!(sess["title"], prompt);
    assert_eq!(sess["plugin"], "research");
    assert_eq!(sess["plugins"], json!(["research", "labkit"]), "省略 plugins = 全部可用插件");
    let plug_step = finals.iter().find(|l| l["step"] == "plugin").unwrap();
    // 与 plugins::describe 一致，只统计 skills/<名称>/SKILL.md。
    let research_skills = std::fs::read_dir(app_root().join("plugins/research/skills"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_dir() && path.join("SKILL.md").is_file())
        .count();
    assert_eq!(plug_step["detail"], format!("research · {research_skills} 个技能；labkit · 1 个技能"), "{plug_step}");
    assert_eq!(sess["yolo"], true);
    assert!(sess["attach_cmd"].as_str().unwrap().contains(&format!("op-{id}")));
    let cap = wait_capture(&c, &a, &id, "参数: --plugin-dir").await;
    assert!(cap.contains(&format!("参数: {prompt}")), "初始提示没有原样到达：\n{cap}");
    assert!(cap.contains("参数: --yolo"));
    assert!(cap.contains(&format!("cwd=/home/dev/{remote_root}/work dir")), "{cap}");
    assert_eq!(cap.matches("参数: --plugin-dir").count(), 2, "每个插件各一次 --plugin-dir：\n{cap}");
    step("ndjson 部署（含单引号、中文、$、反引号的提示，工作目录含空格，默认带全部插件）：七步全部 ok");

    let (rc, out) = remote(
        &data1,
        "cd ~/.bunsen/plugins || exit 1\n\
         test -f research/skills/orchestrator/SKILL.md && echo HAS_SKILL\n\
         test -f research/.claude-plugin/plugin.json && echo HAS_MANIFEST\n\
         for f in research/scripts/*.sh research/hooks/*.sh research/templates/research/tools/*.py; do test -x \"$f\" || echo \"NOT_EXEC $f\"; done\n\
         test -x research/skills/orchestrator/SKILL.md && echo SKILL_EXEC\n\
         find research labkit \\( -name keys -o -name secrets -o -name .git -o -name .claude -o -name tests -o -name node_modules -o -name 'id_*' -o -name '*.pem' -o -name '*.key' -o -name lab.md -o -name '.env*' \\) | sed 's/^/LEAK /'\n\
         (cd labkit && find . -type f | sort | tr '\\n' ' '); echo\n\
         test -x labkit/scripts/run.sh && echo LAB_EXEC\n\
         ls -A | tr '\\n' ' '; echo",
    );
    assert_eq!(rc, 0, "{out}");
    assert!(out.contains("HAS_SKILL") && out.contains("HAS_MANIFEST"), "{out}");
    assert!(!out.contains("NOT_EXEC") && !out.contains("SKILL_EXEC"), "可执行位不对：{out}");
    assert!(!out.contains("LEAK"), "不该下发的文件被下发了：{out}");
    assert!(out.contains("./notes.md ./scripts/run.sh ./skills/lab/SKILL.md"), "{out}");
    assert!(out.contains("LAB_EXEC"), "{out}");
    assert!(out.contains("labkit research") && !out.contains(".tmp") && !out.contains(".old"), "临时目录应已替换掉：{out}");
    step("插件下发：research/skills/orchestrator/SKILL.md 在，keys/secrets/.git/id_*/*.pem/.env* 等都没有，scripts/hooks/tools 可执行");

    let (code, plug) = get(&c, &a, &format!("/api/sessions/{id}/files?path=~/.bunsen/plugins/labkit")).await;
    assert_eq!(code, 200, "{plug}");
    let names: Vec<&str> = plug["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["scripts", "skills", "notes.md"], "{plug}");

    // ---- send / capture ----
    let (code, v) = post(&c, &a, &format!("/api/sessions/{id}/send"), json!({ "text": "hello 世界 'x'" })).await;
    assert_eq!((code, &v), (200, &json!({ "ok": true })));
    wait_capture(&c, &a, &id, "收到: hello 世界 'x'").await;
    let (code, _) = post(&c, &a, &format!("/api/sessions/{id}/send"), json!({ "text": "partial", "enter": false })).await;
    assert_eq!(code, 200);
    let (code, _) = post(&c, &a, &format!("/api/sessions/{id}/keys"), json!({ "keys": ["Enter"] })).await;
    assert_eq!(code, 200);
    wait_capture(&c, &a, &id, "收到: partial").await;
    step("send 后 capture 能看到“收到: hello 世界 'x'”；enter=false + keys Enter 也生效");

    // ---- WebSocket ----
    let ws_url = format!("ws://127.0.0.1:{}/ws/term?token={}&session={id}&pane=agent&cols=100&rows=30", a.port, a.token);
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.expect("WebSocket 连接失败");
    let mut states: Vec<String> = Vec::new();
    let mut out = Vec::<u8>::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    while out.is_empty() {
        let m = tokio::time::timeout_at(deadline.into(), ws.next()).await.expect("没有收到终端输出").unwrap().unwrap();
        match m {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                assert_eq!(v["type"], "status");
                states.push(v["state"].as_str().unwrap().to_string());
            }
            Message::Binary(b) => out.extend_from_slice(&b),
            _ => {}
        }
    }
    assert_eq!(states, ["connecting", "connected"]);
    let v = wait_session(&c, &a, &id, |v| v["attached"] == 1, "接入后 attached=1").await;
    assert_eq!(v["state"], "running");
    ws.send(Message::Text(json!({ "type": "input", "data": "ws-ping 你好\r" }).to_string().into())).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&out).contains("收到: ws-ping 你好") {
        match tokio::time::timeout_at(deadline.into(), ws.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => out.extend_from_slice(&b),
            Ok(Some(Ok(Message::Text(t)))) => panic!("意外的文本帧：{t}"),
            Ok(Some(Ok(_))) => {}
            other => panic!("没有收到回显：{other:?}\n{}", String::from_utf8_lossy(&out)),
        }
    }
    ws.send(Message::Text(json!({ "type": "resize", "cols": 140, "rows": 40 }).to_string().into())).await.unwrap();
    // resize 后连接仍然正常：再发一次输入并收到回显。
    ws.send(Message::Text(json!({ "type": "input", "data": "after-resize\r" }).to_string().into())).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !String::from_utf8_lossy(&out).contains("收到: after-resize") {
        match tokio::time::timeout_at(deadline.into(), ws.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => out.extend_from_slice(&b),
            Ok(Some(Ok(Message::Text(t)))) => panic!("resize 后收到意外的文本帧：{t}"),
            Ok(Some(Ok(_))) => {}
            other => panic!("resize 后连接异常：{other:?}"),
        }
    }
    ws.close(None).await.unwrap();
    drop(ws);
    step("WebSocket 接入代理窗格：connecting→connected、二进制输出、input 回显、resize 后仍正常");

    let v = wait_session(&c, &a, &id, |v| v["attached"] == 0, "断开后 attached=0").await;
    assert_eq!(v["state"], "running", "{v}");
    let cap = capture(&c, &a, &id).await;
    assert!(!cap.contains("再见") && !cap.contains("出错退出"), "断开不应影响代理：\n{cap}");
    step("断开 WebSocket 后会话仍是 running（attached 回到 0）");

    // ---- 工作区 shell 窗格（WebSocket，pane=shell）----
    let ws_url = format!("ws://127.0.0.1:{}/ws/term?token={}&session={id}&pane=shell&cols=80&rows=24", a.port, a.token);
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    ws.send(Message::Text(json!({ "type": "input", "data": "echo SHELL-$((40+2)) && pwd\r" }).to_string().into())).await.unwrap();
    let mut sh_out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    while !String::from_utf8_lossy(&sh_out).contains("SHELL-42") {
        match tokio::time::timeout_at(deadline.into(), ws.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => sh_out.extend_from_slice(&b),
            Ok(Some(Ok(_))) => {}
            other => panic!("shell 窗格没有输出：{other:?}\n{}", String::from_utf8_lossy(&sh_out)),
        }
    }
    ws.close(None).await.unwrap();
    step("WebSocket 接入工作区 shell（op-<id>-sh）");

    // ---- 退出码与重启 ----
    let (code, _) = post(&c, &a, &format!("/api/sessions/{id}/send"), json!({ "text": "/fail" })).await;
    assert_eq!(code, 200);
    let v = wait_session(&c, &a, &id, |v| v["state"] == "exited", "发送 /fail 后变成 exited").await;
    assert_eq!(v["exit_status"], 3, "{v}");
    let (code, e) = post(&c, &a, &format!("/api/sessions/{id}/send"), json!({ "text": "x" })).await;
    assert_eq!((code, e["error"]["code"].as_str()), (409, Some("conflict")), "{e}");
    step("发送 /fail 后 state=exited、exit_status=3；退出后再 send 返回 conflict");

    let (code, v) = post(&c, &a, &format!("/api/sessions/{id}/restart"), json!({})).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["state"], "running", "{v}");
    assert_eq!(v["exit_status"], Value::Null);
    wait_capture(&c, &a, &id, "参数: --continue").await;
    step("restart 后回到 running（用 resume 命令 fake-agent --continue）");

    // ---- 工作区文件 / git / 科研面板 ----
    let (code, f) = get(&c, &a, &format!("/api/sessions/{id}/files")).await;
    assert_eq!(code, 200, "{f}");
    assert_eq!(f["path"], format!("/home/dev/{remote_root}/work dir"));
    assert_eq!(f["parent"], format!("/home/dev/{remote_root}"));
    let (code, f) = get(&c, &a, &format!("/api/sessions/{id}/file?path=~/.bunsen/sessions/{id}.json")).await;
    assert_eq!(code, 200, "{f}");
    assert_eq!(f["binary"], false);
    let meta: Value = serde_json::from_str(f["text"].as_str().unwrap().trim()).unwrap();
    assert_eq!(meta["agent_id"], "fake-it");
    assert_eq!(meta["title"], prompt);
    let (code, f) = get(&c, &a, &format!("/api/sessions/{id}/file?path=nope.txt")).await;
    assert_eq!((code, f["error"]["code"].as_str()), (404, Some("not_found")));
    let (code, g) = get(&c, &a, &format!("/api/sessions/{id}/git")).await;
    assert_eq!((code, &g), (200, &json!({ "is_repo": false, "branch": null, "changes": [] })));
    let (code, r) = get(&c, &a, &format!("/api/sessions/{id}/research")).await;
    assert_eq!(code, 200);
    assert_eq!(r["present"], false);
    assert_eq!(r["home"], "research");
    assert_eq!(r["loop"], json!({ "on": false, "started": null, "blocked": null }));
    assert_eq!(r["state_md"], Value::Null);
    assert_eq!(r["runs"], json!([]));
    step("files / file / git（非仓库 is_repo=false）/ research（present=false）");

    // git 仓库：用内置的“纯终端”Agent 在另一个目录里建仓库。
    let lines = deploy_ndjson(
        &c,
        &a,
        json!({ "server_id": "bunsen-test", "agent_id": "shell", "workdir": format!("~/{remote_root}/repo"), "title": "仓库" }),
    )
    .await;
    assert_eq!(lines.last().unwrap()["type"], "done", "{lines:?}");
    let sid2 = lines.last().unwrap()["session"]["id"].as_str().unwrap().to_string();
    let (code, _) = post(&c, &a, &format!("/api/sessions/{sid2}/send"), json!({ "text": "git init -q && printf 'hi\\n' > a.txt && echo READY-$((1+1))" })).await;
    assert_eq!(code, 200);
    wait_capture(&c, &a, &sid2, "READY-2").await;
    let (code, g) = get(&c, &a, &format!("/api/sessions/{sid2}/git")).await;
    assert_eq!(code, 200, "{g}");
    assert_eq!(g["is_repo"], true);
    assert_eq!(g["changes"], json!([{ "path": "a.txt", "status": "??" }]), "{g}");
    let (code, d) = get(&c, &a, &format!("/api/sessions/{sid2}/git/diff?path=a.txt")).await;
    assert_eq!(code, 200, "{d}");
    assert!(d["diff"].as_str().unwrap().contains("+hi"), "{d}");
    let (code, f) = get(&c, &a, &format!("/api/sessions/{sid2}/file?path=a.txt")).await;
    assert_eq!((code, f["text"].as_str()), (200, Some("hi\n")));
    let (code, _) = send_json(&c, reqwest::Method::DELETE, &a, &format!("/api/sessions/{sid2}"), json!({})).await;
    assert_eq!(code, 409, "运行中的会话 force=0 删除应返回 conflict");
    let (code, _) = send_json(&c, reqwest::Method::DELETE, &a, &format!("/api/sessions/{sid2}?force=1"), json!({})).await;
    assert_eq!(code, 200);
    step("git 仓库：changes 含 “?? a.txt”，diff 含 +hi；运行中删除 force=0 → 409，force=1 → 200");

    // ---- 安装任务与服务器 shell（终端通道的另两种 pane）----
    let (code, v) = send_json(
        &c,
        reqwest::Method::PUT,
        &a,
        "/api/agents/inst-it",
        json!({ "name": "安装测试", "detect": "true", "launch": "true", "install": [{ "label": "测试", "cmd": "echo INSTALL-$((6*7))" }] }),
    )
    .await;
    assert_eq!(code, 200, "{v}");
    let (code, v) = post(&c, &a, &format!("/api/servers/{server_id}/install-agent"), json!({ "agent_id": "inst-it" })).await;
    assert_eq!((code, &v), (200, &json!({ "tmux": "op-install-inst-it" })));
    let url = format!("ws://127.0.0.1:{}/ws/term?token={}&server={server_id}&pane=install&agent=inst-it&cols=100&rows=30", a.port, a.token);
    let (out, _) = ws_expect(&url, None, "INSTALL-42", false).await;
    assert!(out.contains("安装命令已结束"), "{out}");
    let url = format!("ws://127.0.0.1:{}/ws/term?token={}&server={server_id}&pane=shell&cols=100&rows=30", a.port, a.token);
    let (out, closed) = ws_expect(&url, Some("echo SRV-$((1+2)); exit\r"), "SRV-3", true).await;
    assert!(closed, "远程 shell 退出后应收到 closed 状态：{out}");
    step("install-agent 在 op-install-<agent> 里运行并可经 pane=install 观看；server shell 退出后收到 closed");

    // ---- 修改与删除的约束 ----
    let (code, v) = send_json(&c, reqwest::Method::PATCH, &a, &format!("/api/servers/{server_id}"), json!({ "note": "测试机", "default_workdir": "~/w" })).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!((v["note"].as_str(), v["default_workdir"].as_str(), v["key"].as_str()), (Some("测试机"), Some("~/w"), Some("id_test")));
    let (code, v) = send_json(&c, reqwest::Method::PATCH, &a, &format!("/api/servers/{server_id}"), json!({ "key": "no-such-key" })).await;
    assert_eq!((code, v["error"]["code"].as_str()), (400, Some("bad_request")));
    let (code, v) = send_json(&c, reqwest::Method::DELETE, &a, "/api/keys/id_test", json!({})).await;
    assert_eq!((code, v["error"]["code"].as_str()), (409, Some("conflict")));
    let (code, v) = send_json(&c, reqwest::Method::DELETE, &a, &format!("/api/servers/{server_id}"), json!({})).await;
    assert_eq!((code, v["error"]["code"].as_str()), (409, Some("conflict")));
    let (code, v) = send_json(&c, reqwest::Method::PATCH, &a, &format!("/api/sessions/{id}"), json!({ "title": "改过的标题", "pinned": true })).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!((v["title"].as_str(), v["pinned"].as_bool()), (Some("改过的标题"), Some(true)));
    let (code, v) = send_json(&c, reqwest::Method::PATCH, &a, &format!("/api/sessions/{id}"), json!({ "title": prompt })).await;
    assert_eq!(code, 200, "{v}");
    step("PATCH 服务器/会话；仍被引用的私钥、还有会话的服务器删除时返回 conflict");

    // ---- 没有 plugin_dir_flag 的 Agent：plugin_prompt 放在初始提示前面（v1.2）----
    let (code, v) = send_json(
        &c,
        reqwest::Method::PUT,
        &a,
        "/api/agents/fake-pp",
        json!({ "name": "提示型假代理", "detect": "fake-agent", "launch": "fake-agent", "launch_with_prompt": "fake-agent {prompt}",
                "plugin_prompt": "插件在 {dirs}，先读。" }),
    )
    .await;
    assert_eq!(code, 200, "{v}");
    let lines = deploy_ndjson(&c, &a, json!({ "server_id": server_id, "agent_id": "fake-pp", "workdir": "~", "prompt": "开始", "plugins": ["research"] })).await;
    assert_eq!(lines.last().unwrap()["type"], "done", "{lines:?}");
    let pp = lines.last().unwrap()["session"].clone();
    assert_eq!(pp["plugins"], json!(["research"]));
    assert_eq!(pp["title"], "开始");
    let pp_id = pp["id"].as_str().unwrap().to_string();
    let cap = wait_capture(&c, &a, &pp_id, "参数: 插件在 ~/.bunsen/plugins/research，先读。").await;
    assert!(cap.contains("开始") && !cap.contains("--plugin-dir") && !cap.contains("labkit"), "{cap}");
    let (code, _) = send_json(&c, reqwest::Method::DELETE, &a, &format!("/api/sessions/{pp_id}?force=1"), json!({})).await;
    assert_eq!(code, 200);
    let (code, v) = post(&c, &a, "/api/sessions", json!({ "server_id": server_id, "agent_id": "fake-it", "workdir": "~", "plugins": ["nope"] })).await;
    assert_eq!((code, v["error"]["code"].as_str()), (422, Some("bad_request")), "{v}");
    step("plugin_prompt：插件目录作为初始提示前缀；plugins 只选 research；未知插件 bad_request");

    // ---- 科研项目（v1.1）：用插件里的模板和 rk.py 在容器里造一个研究目录 ----
    let proj = format!("~/{remote_root}/proj");
    let (rc, out) = remote(
        &data1,
        &format!(
            "set -e\nmkdir -p {proj} && cd {proj}\n\
             cp -r ~/.bunsen/plugins/research/templates/research research\n\
             mkdir -p figures results paper .cache node_modules/pkg out/a/b/c/d/e/f/g/h research/.loop\n\
             printf '# 预登记：H1\\n' > research/prereg/h1.md\n\
             printf 'png' > figures/loss.png; printf 'a,b\\n1,2\\n' > results/table.csv; printf '# 报告\\n' > results/report.md\n\
             printf 'pdf' > paper/main.pdf; printf 'x' > README.md; printf 'x' > .cache/hidden.png; printf 'x' > node_modules/pkg/x.png\n\
             printf 'x' > out/a/b/c/d/e/f/g/h/too-deep.png; printf '{{}}' > analysis.ipynb\n\
             python3 -c \"import os; os.utime('figures/loss.png', (2000000000, 2000000000))\"\n\
             printf 'started: 2026-11-12T10:00:00+08:00\\nsession: x\\n' > research/.loop/active\n\
             cd research\n\
             run_id=$(python3 tools/rk.py id smoke)\n\
             printf 'RUN_ID=%s\\n' \"$run_id\"\n\
             python3 tools/rk.py run \"$run_id\" --explore -- sh -c 'echo hello-run; echo line2'\n\
             for i in $(seq 1 50); do [ -f \"runs/$run_id/exit_code\" ] && break; sleep 0.2; done\n\
             test -f \"runs/$run_id/exit_code\"\n\
             printf '{{\"acc\": 0.9}}' > \"runs/$run_id/metrics.json\"\n\
             printf '# %s：冒烟\\n结论\\n' \"$run_id\" > \"results/$run_id.md\"\n"
        ),
    );
    assert_eq!(rc, 0, "{out}");
    let run_id = out.lines().find_map(|line| line.strip_prefix("RUN_ID=")).expect("夹具没有打印运行 ID").to_string();
    let lines = deploy_ndjson(&c, &a, json!({ "server_id": server_id, "agent_id": "shell", "workdir": proj, "plugins": [] })).await;
    assert_eq!(lines.last().unwrap()["type"], "done", "{lines:?}");
    assert!(lines.iter().any(|l| l["step"] == "plugin" && l["status"] == "skipped"), "plugins:[] 时 plugin 步骤 skipped");
    let rid = lines.last().unwrap()["session"]["id"].as_str().unwrap().to_string();
    assert_eq!(lines.last().unwrap()["session"]["plugin"], Value::Null);

    let (code, r) = get(&c, &a, &format!("/api/sessions/{rid}/research")).await;
    assert_eq!(code, 200, "{r}");
    assert_eq!(r["present"], true);
    assert_eq!(r["loop"], json!({ "on": true, "started": "2026-11-12T10:00:00+08:00", "blocked": null }));
    for k in ["state_md", "summary_md", "ideas_md", "ledger_md", "overview_md", "lessons_md", "log_tail"] {
        assert!(r[k].is_string(), "{k} 应有内容：{r}");
    }
    assert_eq!(r["prereg"], json!([{ "name": "h1.md", "title": "预登记：H1" }]));
    assert_eq!(r["results"], json!([{ "name": format!("{run_id}.md"), "title": format!("{run_id}：冒烟") }]));
    let run = &r["runs"][0];
    assert_eq!((run["run_id"].as_str(), run["state"].as_str(), run["exit_code"].as_i64()), (Some(run_id.as_str()), Some("ok"), Some(0)), "{r}");
    assert_eq!(run["cmd"], "sh -c 'echo hello-run; echo line2'");
    assert!(run["cwd"].as_str().unwrap().ends_with("/proj/research"));
    assert!(run["ended_at"].is_string());
    assert_eq!((run["has_metrics"].as_bool(), run["has_result"].as_bool(), run["prereg"].clone()), (Some(true), Some(true), json!([])));
    step("科研面板 v1.1：overview/lessons/log_tail、prereg/results 列表、runs 带 cmd/cwd/ended_at/has_metrics/has_result（真实 rk.py）");

    let (code, d) = get(&c, &a, &format!("/api/sessions/{rid}/research/run?run_id={run_id}&lines=1")).await;
    assert_eq!(code, 200, "{d}");
    assert_eq!(d["run_id"], run_id);
    assert_eq!(d["meta"]["kind"], "explore");
    assert_eq!(d["log_tail"], "line2\n", "lines=1 只取最后一行：{d}");
    assert_eq!(d["metrics"], json!({ "acc": 0.9 }));
    assert_eq!(d["result_md"], format!("# {run_id}：冒烟\n结论\n"));
    for bad in ["..", "../x", "a%20b", "%24(touch%20%2Ftmp%2Fop-pwned)", ""] {
        let (code, e) = get(&c, &a, &format!("/api/sessions/{rid}/research/run?run_id={bad}")).await;
        assert_eq!((code, e["error"]["code"].as_str()), (400, Some("bad_request")), "run_id={bad}: {e}");
    }
    let (code, _) = get(&c, &a, &format!("/api/sessions/{rid}/research/run?run_id=20991231-r09-none")).await;
    assert_eq!(code, 404);
    step("research/run：meta、log_tail（lines）、metrics、result_md；非法 run_id 400，不存在 404");

    let (code, art) = get(&c, &a, &format!("/api/sessions/{rid}/artifacts")).await;
    assert_eq!(code, 200, "{art}");
    let expect_art = |art: &Value| {
        let items = art["items"].as_array().unwrap();
        assert_eq!(items[0]["path"], "figures/loss.png", "按修改时间倒序：{art}");
        assert_eq!((items[0]["kind"].as_str(), items[0]["name"].as_str(), items[0]["size"].as_u64()), (Some("image"), Some("loss.png"), Some(3)));
        assert_eq!(items[0]["mtime"], "2033-05-18T03:33:20Z");
        let mut got: Vec<(String, String)> =
            items.iter().map(|i| (i["path"].as_str().unwrap().to_string(), i["kind"].as_str().unwrap().to_string())).collect();
        got.sort();
        let want: Vec<(String, String)> = [
            ("analysis.ipynb", "notebook"),
            ("figures/loss.png", "image"),
            ("paper/main.pdf", "pdf"),
            (&format!("research/results/{run_id}.md"), "doc"),
            ("research/results/TEMPLATE.md", "doc"),
            ("results/report.md", "doc"),
            ("results/table.csv", "table"),
        ]
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        assert_eq!(got, want, "{art}");
        assert_eq!(art["truncated"], false);
    };
    expect_art(&art);
    let (_, art2) = get(&c, &a, &format!("/api/sessions/{rid}/artifacts?limit=2")).await;
    assert_eq!((art2["items"].as_array().unwrap().len(), art2["truncated"].as_bool()), (2, Some(true)));
    step("artifacts（python3）：跳过 . 开头目录、node_modules、过深的文件，md 只收报告类目录，按 mtime 倒序，limit 截断");

    let r = c.get(a.url(&format!("/api/sessions/{rid}/raw?path=figures/loss.png"))).send().await.unwrap();
    assert_eq!(r.status().as_u16(), 200);
    let h = r.headers().clone();
    assert_eq!(h["content-type"], "application/octet-stream");
    assert_eq!(h["x-content-type-options"], "nosniff");
    assert_eq!(h["content-disposition"], "attachment");
    assert_eq!(r.bytes().await.unwrap().as_ref(), b"png");
    let rk_local = std::fs::read(app_root().join("plugins/research/templates/research/tools/rk.py")).unwrap();
    let r = c.get(a.url(&format!("/api/sessions/{rid}/raw?path=~/.bunsen/plugins/research/templates/research/tools/rk.py"))).send().await.unwrap();
    assert_eq!(r.bytes().await.unwrap().as_ref(), rk_local.as_slice(), "下发的 rk.py 与内嵌的一字不差");
    remote(&data1, &format!("head -c 33600000 /dev/zero > {proj}/big.bin; rm -f /tmp/op-pwned"));
    let (code, e) = get(&c, &a, &format!("/api/sessions/{rid}/raw?path=big.bin")).await;
    assert_eq!((code, e["error"]["code"].as_str()), (400, Some("bad_request")), "{e}");
    let (code, _) = get(&c, &a, &format!("/api/sessions/{rid}/raw?path=%24(touch%20%2Ftmp%2Fop-pwned)")).await;
    assert_eq!(code, 404);
    let (code, _) = get(&c, &a, &format!("/api/sessions/{rid}/raw?path=x%27%3Btouch%20%2Ftmp%2Fop-pwned%3B%27")).await;
    assert_eq!(code, 404);
    let (rc, out) = remote(&data1, "test -e /tmp/op-pwned && echo PWNED; rm -f /tmp/op-pwned; true");
    assert!(rc == 0 && !out.contains("PWNED"), "路径参数被当成命令执行了");
    step("raw：octet-stream + nosniff + attachment，字节一致；超过 32 MB 400；带 $( ) 和引号的路径不会被执行");

    // ---- MCP（v1.1 / v1.2 的工具）----
    let mut m = Mcp::start(&data1, &cm);
    let init = m.call("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "itest", "version": "0" } }));
    assert_eq!(init["result"]["serverInfo"]["name"], "bunsen", "{init}");
    m.notify("notifications/initialized");
    let tl = m.call("tools/list", json!({}));
    let tools: Vec<&str> = tl["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for t in ["session_artifacts", "research_show", "host_notes_get", "host_notes_set", "plugin_list", "session_deploy", "list_projects", "project_view", "project_sync"] {
        assert!(tools.contains(&t), "缺少工具 {t}");
    }
    let (err, v) = m.tool("plugin_list", json!({}));
    assert!(!err && v[0]["name"] == "research", "{v}");
    let (err, v) = m.tool("host_notes_get", json!({ "server_id": "bunsen-test" }));
    assert!(!err && v["text"] == mine, "{v}");
    let (err, v) = m.tool("session_artifacts", json!({ "session_id": rid, "limit": 1 }));
    assert!(!err && v["items"][0]["path"] == "figures/loss.png" && v["truncated"] == true, "{v}");
    let (err, v) = m.tool("research_show", json!({ "session_id": rid }));
    assert!(!err && v["present"] == true, "{v}");
    let (err, v) = m.tool("research_show", json!({ "session_id": rid, "run_id": run_id }));
    assert!(!err && v["metrics"]["acc"] == 0.9, "{v}");
    let (err, v) = m.tool("research_show", json!({ "session_id": rid, "run_id": "../x" }));
    assert!(err && v["error"]["code"] == "bad_request", "{v}");
    let (err, v) = m.tool("session_capture", json!({ "session_id": id, "lines": 50 }));
    assert!(!err && v["text"].as_str().unwrap().contains("fake-agent"), "{v}");
    let (err, v) = m.tool("session_deploy", json!({ "server_id": server_id, "agent_id": "nope-x", "workdir": "~" }));
    assert!(err && v["error"]["code"] == "not_found", "{v}");
    drop(m);
    step("MCP：initialize / tools/list / plugin_list / host_notes_get / session_artifacts / research_show / session_capture");

    // ---- 找不到代理程序 ----
    let (code, _) = send_json(
        &c,
        reqwest::Method::PUT,
        &a,
        "/api/agents/nope-it",
        json!({ "name": "不存在", "detect": "definitely-not-installed-xyz", "launch": "definitely-not-installed-xyz" }),
    )
    .await;
    assert_eq!(code, 200);
    let (code, v) = post(&c, &a, "/api/sessions", json!({ "server_id": server_id, "agent_id": "nope-it", "workdir": "~" })).await;
    assert_eq!(code, 422, "{v}");
    assert_eq!(v["error"]["code"], "agent_missing");
    let steps = v["steps"].as_array().unwrap();
    let last_step = steps.last().unwrap();
    assert_eq!((last_step["step"].as_str(), last_step["status"].as_str()), (Some("agent"), Some("failed")), "{v}");
    let lines = deploy_ndjson(&c, &a, json!({ "server_id": server_id, "agent_id": "nope-it", "workdir": "~" })).await;
    let l = lines.last().unwrap();
    assert_eq!((l["type"].as_str(), l["error"]["code"].as_str()), (Some("error"), Some("agent_missing")));
    assert!(lines.iter().any(|x| x["step"] == "agent" && x["status"] == "failed"));
    step("部署到不存在的可执行文件：agent_missing，agent 步骤 failed（JSON 422 与 ndjson 两种）");

    // ---- 模拟退出软件再打开：全新的空数据目录 ----
    a.stop();
    drop(a);
    let b = Serve::start(&data2, &cm, &[("BUNSEN_SYNC_METHOD", "tar"), ("BUNSEN_REMOTE_NO_PYTHON", "1")]);
    let c = b.client();
    let imp = import(&c, &b).await;
    assert_eq!(imp["tests"][0]["ok"], true, "{imp}");
    let (code, list) = get(&c, &b, "/api/sessions?refresh=1").await;
    assert_eq!(code, 200, "{list}");
    let found = list.as_array().unwrap().iter().find(|s| s["id"] == id.as_str()).unwrap_or_else(|| panic!("没有发现会话 {id}：{list}"));
    assert_eq!(found["origin"], "discovered");
    assert_eq!(found["state"], "running");
    assert_eq!(found["agent_id"], "fake-it");
    assert_eq!(found["title"], prompt);
    assert_eq!(found["workdir"], workdir);
    assert_eq!(found["plugins"], json!(["research", "labkit"]));
    assert!(found["preview"].as_str().unwrap_or("").contains("fake>"), "{found}");
    let cap = capture(&c, &b, &id).await;
    assert!(cap.contains("fake-agent 1.0"), "{cap}");
    step("停掉服务、换全新数据目录重新导入：refresh=1 发现会话（origin=discovered），能再次 capture");

    // 没有 python3 时的退路（这个服务进程设置了 BUNSEN_REMOTE_NO_PYTHON=1）：BusyBox 的 find + stat。
    let (code, art) = get(&c, &b, &format!("/api/sessions/{rid}/artifacts")).await;
    assert_eq!(code, 200, "{art}");
    expect_art(&art);
    let (code, f) = get(&c, &b, &format!("/api/sessions/{rid}/files?path=figures")).await;
    assert_eq!(code, 200, "{f}");
    assert_eq!(f["entries"], json!([{ "name": "loss.png", "kind": "file", "size": 3, "mtime": "2033-05-18T03:33:20Z" }]));
    let (code, _) = send_json(&c, reqwest::Method::DELETE, &b, &format!("/api/sessions/{rid}?force=1"), json!({})).await;
    assert_eq!(code, 200);
    step("没有 python3 时（BusyBox find + stat）：artifacts 结果相同，files 也能列目录");

    // tar 回退（这个服务进程设置了 BUNSEN_SYNC_METHOD=tar）；research_plugin_path 覆盖内嵌的 research
    let (_, st) = get(&c, &b, "/api/settings").await;
    let mut st2 = st.clone();
    st2["research_plugin_path"] = json!(plugin_src.to_string_lossy());
    let (code, _) = send_json(&c, reqwest::Method::PUT, &b, "/api/settings", st2).await;
    assert_eq!(code, 200);
    std::fs::write(plugin_src.join("marker2.txt"), "第二次同步\n").unwrap();
    let (_, pl) = get(&c, &b, "/api/plugins").await;
    assert_eq!((pl[0]["name"].as_str(), pl[0]["source"].as_str()), (Some("research"), Some("local")), "{pl}");
    let lines = deploy_ndjson(&c, &b, json!({ "server_id": "bunsen-test", "agent_id": "shell", "workdir": format!("~/{remote_root}/tar"), "plugin": "research" })).await;
    assert_eq!(lines.last().unwrap()["type"], "done", "{lines:?}");
    let plug_step = lines.iter().find(|l| l["step"] == "plugin" && l["status"] == "ok").expect("plugin 步骤没有 ok");
    let d = plug_step["detail"].as_str().unwrap();
    assert!(d.starts_with("research · 1 个技能") && d.contains("tar"), "{plug_step}");
    let sid3 = lines.last().unwrap()["session"]["id"].as_str().unwrap().to_string();
    let (code, plug) = get(&c, &b, &format!("/api/sessions/{sid3}/files?path=~/.bunsen/plugins/research")).await;
    assert_eq!(code, 200);
    let names: Vec<&str> = plug["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["skills", "marker.txt", "marker2.txt"], "{plug}");
    let (code, _) = send_json(&c, reqwest::Method::DELETE, &b, &format!("/api/sessions/{sid3}?force=1"), json!({})).await;
    assert_eq!(code, 200);
    step("插件同步的 tar 回退（本机或服务器没有 rsync 时）");

    let (code, v) = post(&c, &b, &format!("/api/sessions/{id}/stop"), json!({})).await;
    assert_eq!(code, 200, "{v}");
    assert_eq!(v["state"], "stopped");
    let v = session(&c, &b, &id).await;
    assert_eq!(v["state"], "stopped");
    let (code, e) = get(&c, &b, &format!("/api/sessions/{id}/capture")).await;
    assert_eq!((code, e["error"]["code"].as_str()), (409, Some("conflict")));
    let (code, _) = send_json(&c, reqwest::Method::DELETE, &b, &format!("/api/sessions/{id}"), json!({})).await;
    assert_eq!(code, 200);
    step("stop 后 state=stopped；已停止的会话可直接删除记录");

    // ---- 清理 ----
    drop(b);
    ssh_cleanup(
        &data2,
        &format!(
            "rm -rf ~/{remote_root} ~/.bunsen/sessions/{id}.json ~/.bunsen/sessions/{sid2}.json ~/.local/bin/nvidia-smi\n\
             tmux -L bunsen kill-session -t =op-install-inst-it 2>/dev/null; true\n"
        ),
    );
    let _ = std::fs::remove_dir_all(&base);
    let _ = std::fs::remove_dir_all(&cm);
    step("清理临时目录与服务器上的测试目录");
}
