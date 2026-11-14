//! `bunsen`：本机服务、命令行子命令与 MCP 服务三个入口，共用 bunsen-core。

mod http;
mod mcp;

use bunsen_core::import::Upload;
use bunsen_core::model::*;
use bunsen_core::term::TermTarget;
use bunsen_core::{Core, Error};
use clap::{Parser, Subcommand};
use serde::Serialize;
use std::process::ExitCode;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "bunsen", version, about = "开源科研工作台：在自己的服务器上部署、接入并管理做研究的命令行 Agent")]
struct Cli {
    /// 以 JSON 输出
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 启动本机服务（界面 + HTTP/WebSocket 接口）
    Serve {
        #[arg(long, default_value_t = 7878)]
        port: u16,
        /// 不自动打开浏览器
        #[arg(long)]
        no_open: bool,
        /// 开发模式：令牌固定为 dev，放行 5173 端口的前端开发服务器
        #[arg(long)]
        dev: bool,
    },
    /// 列出服务器
    Servers,
    /// 列出研究项目
    Projects,
    /// 管理研究项目
    Project {
        #[command(subcommand)]
        cmd: ProjectCmd,
    },
    /// 导入 ssh 配置、私钥或 ZIP（自动测试连接）
    Import {
        #[arg(required = true)]
        files: Vec<std::path::PathBuf>,
    },
    /// 测试连接
    Test {
        server: String,
        /// 逐把尝试已保存的私钥
        #[arg(long)]
        try_all_keys: bool,
    },
    /// 探测服务器
    Probe { server: String },
    /// 列出 Agent
    Agents,
    /// 列出会话
    Sessions {
        /// 连服务器刷新状态并发现会话
        #[arg(long)]
        refresh: bool,
    },
    /// 部署一个会话
    Deploy {
        #[arg(long)]
        server: String,
        #[arg(long)]
        agent: String,
        #[arg(long)]
        workdir: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        prompt: Option<String>,
        #[arg(long)]
        yolo: bool,
        /// 只带指定的插件（可多次）；默认带全部可用插件
        #[arg(long = "plugin", value_name = "名")]
        plugins: Vec<String>,
        /// 不带任何插件
        #[arg(long, conflicts_with = "plugins")]
        no_plugins: bool,
        /// 接入研究项目（id 或名称）
        #[arg(long)]
        project: Option<String>,
        /// 原样追加到启动命令
        #[arg(long, allow_hyphen_values = true)]
        extra_args: Option<String>,
    },
    /// 在当前终端里直接接入会话
    Attach {
        id: String,
        /// 接入工作区 shell 而不是代理窗格
        #[arg(long)]
        shell: bool,
    },
    /// 把文字粘贴进代理窗格并回车
    Send {
        id: String,
        text: String,
        /// 只粘贴，不回车
        #[arg(long)]
        no_enter: bool,
    },
    /// 读取代理窗格最近若干行
    Capture {
        id: String,
        #[arg(long)]
        lines: Option<u32>,
    },
    /// 在原会话里重启代理
    Restart {
        id: String,
        /// 不用 resume 命令，重新开始
        #[arg(long)]
        no_resume: bool,
    },
    /// 结束服务器上的会话（记录保留）
    Stop { id: String },
    /// 列出可下发的插件（内嵌的与本机目录）
    Plugins,
    /// 列出会话工作目录里的产物（图、PDF、表格、notebook、报告）
    Artifacts {
        id: String,
        #[arg(long)]
        limit: Option<u32>,
    },
    /// 科研面板；--run 看运行详情，--trust 看研究可信度
    Research {
        id: String,
        #[arg(long, conflicts_with_all = ["run", "lines"])]
        trust: bool,
        #[arg(long)]
        run: Option<String>,
        #[arg(long)]
        lines: Option<u32>,
    },
    /// 读或写服务器上的主机笔记 ~/.bunsen/HOST.md
    Notes {
        server: String,
        /// 用这个本机文件的内容覆盖主机笔记
        #[arg(long, value_name = "文件")]
        set: Option<std::path::PathBuf>,
    },
    /// 标准输入输出上的 MCP 服务
    Mcp,
}

#[derive(Subcommand)]
enum ProjectCmd {
    /// 添加研究项目，并验证汇合点
    Add {
        name: String,
        hub: String,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        home: Option<String>,
        /// 路径不存在时在汇合点所在服务器上建立裸仓库
        #[arg(long)]
        create: bool,
    },
    /// 查看机器、研究线、运行和待决定事项
    View {
        project: String,
        #[arg(long)]
        refresh: bool,
    },
    /// 同步项目的所有成员会话
    Sync { project: String },
    /// 删除项目记录与本机镜像（保留会话和汇合点）
    Rm { project: String },
}

fn print_projects(projects: &[Project]) {
    if projects.is_empty() {
        println!("还没有研究项目。用 bunsen project add <名称> <汇合点> 添加。");
    }
    for p in projects {
        println!("{}  {}  {}  {}", p.id, p.name, p.branch, p.hub);
    }
}

fn member_sync_line(m: &MemberSync) -> String {
    format!("{}  {}  {}  {}", m.session_id, m.server_alias, m.title, m.detail)
}

fn print_project_view(v: &ProjectView) {
    print_projects(std::slice::from_ref(&v.project));
    for m in &v.machines {
        println!("机器 {}  领先 {}  落后 {}  {}", m.code, m.ahead, m.behind, if m.conflict == Some(true) { "有冲突" } else { "" });
    }
    if let Some(t) = &v.trust {
        println!(
            "可信度：未关闭问题 {}；未核文件 {}；解析不到的引用 {}；已撤稿 {}",
            t.open_fails, t.unreviewed, t.unresolved_citations, t.retracted_citations
        );
    }
    for l in &v.lines {
        println!(
            "研究线 {}  #{}  推进者={}  阶段={}  来源={}  未关闭问题={}  未核文件={}",
            l.line,
            l.token,
            l.holder.as_deref().unwrap_or("-"),
            l.stage.as_deref().unwrap_or("-"),
            l.source,
            l.open_fails.map(|n| n.to_string()).as_deref().unwrap_or("—"),
            l.unreviewed.map(|n| n.to_string()).as_deref().unwrap_or("—")
        );
        for next in &l.next {
            println!("  {next}");
        }
    }
    for r in &v.runs {
        println!("运行 {}  {}  {}  来源={}  {}", r.run_id, r.kind, r.state, r.source, r.note);
    }
    for m in &v.members {
        println!("会话 {}  {}  {}:{}  {}", m.session_id, m.title, m.server_alias, m.workdir, state_text(m.state));
    }
    if let Some(d) = &v.decisions {
        println!("需要你决定：\n{d}");
    }
    for w in &v.warnings {
        println!("注意：{w}");
    }
}

fn print_trust(v: &ResearchTrust) {
    if !v.available {
        println!("{}", v.reason.as_deref().unwrap_or("研究可信度不可用"));
        return;
    }
    println!("研究可信度（rk {}；{}）", v.rk_version.as_deref().unwrap_or("-"), v.checked_at);
    if let Some(check) = &v.check {
        let claims = check["claims"].as_array();
        let count = |state: &str| claims.map(|a| a.iter().filter(|c| c["trust"] == state).count()).unwrap_or(0);
        println!(
            "结论数 {}；可信 {}；需留意 {}；有问题 {}",
            check["counts"]["claims"].as_u64().unwrap_or_else(|| claims.map_or(0, |a| a.len() as u64)),
            count("ok"),
            count("warn"),
            count("fail")
        );
        for (key, label) in [("errors", "错误"), ("warnings", "警告")] {
            if let Some(issues) = check[key].as_array() {
                println!("{label}：{}", issues.len());
                for issue in issues {
                    println!("  [{}] {}", issue["code"].as_str().unwrap_or(""), issue["message"].as_str().unwrap_or(""));
                }
            }
        }
    }
    if let Some(fails) = v.review.as_ref().and_then(|r| r["open_fails"].as_array()) {
        println!("未关闭的 fail：{}", fails.len());
        for f in fails {
            println!(
                "  {} {}:{} {}",
                f["ref"].as_str().unwrap_or(""),
                f["file"].as_str().unwrap_or(""),
                f["line"],
                f["note"].as_str().unwrap_or("")
            );
        }
    }
    for f in &v.failures {
        println!("执行失败 [{}]：{}", serde_json::to_value(&f.command).unwrap().as_str().unwrap(), f.message);
    }
}

fn print_json<T: Serialize>(v: &T) {
    println!("{}", serde_json::to_string_pretty(v).unwrap_or_default());
}

fn fail(json: bool, e: &Error) -> ExitCode {
    if json {
        print_json(&serde_json::json!({ "error": e }));
    } else {
        match &e.hint {
            Some(h) => eprintln!("错误：{}\n提示：{}", e.message, h),
            None => eprintln!("错误：{}", e.message),
        }
    }
    ExitCode::from(1)
}

fn status_text(s: ServerStatus) -> &'static str {
    match s {
        ServerStatus::Unknown => "未知",
        ServerStatus::Online => "在线",
        ServerStatus::Offline => "离线",
        ServerStatus::AuthFailed => "认证失败",
    }
}

fn state_text(s: SessionState) -> &'static str {
    match s {
        SessionState::Running => "运行中",
        SessionState::Exited => "已退出",
        SessionState::Stopped => "已停止",
        SessionState::Unreachable => "连不上",
        SessionState::Unknown => "未知",
    }
}

fn print_servers(v: &[Server]) {
    if v.is_empty() {
        println!("还没有服务器。用 bunsen import <ssh 配置> <私钥> 导入。");
    }
    for s in v {
        println!(
            "{}  {}  {}@{}:{}  密钥={}  状态={}{}",
            s.id,
            s.alias,
            s.user,
            s.host,
            s.port,
            s.key.as_deref().unwrap_or("-"),
            status_text(s.status),
            s.status_detail.as_deref().map(|d| format!("（{d}）")).unwrap_or_default()
        );
    }
}

fn print_sessions(v: &[Session]) {
    if v.is_empty() {
        println!("还没有会话。");
    }
    for s in v {
        println!(
            "{}  {}  {}  {}:{}  {}{}",
            s.id,
            state_text(s.state),
            s.agent_id,
            s.server_alias,
            s.workdir,
            s.title,
            s.exit_status.map(|c| format!("  退出码 {c}")).unwrap_or_default()
        );
    }
}

fn print_step(s: &Step) {
    let mark = match s.status {
        StepStatus::Running => return,
        StepStatus::Ok => "[完成]",
        StepStatus::Failed => "[失败]",
        StepStatus::Skipped => "[跳过]",
    };
    let ms = s.ms.map(|m| format!(" {m}ms")).unwrap_or_default();
    eprintln!("{mark} {}{}  {}", s.label, ms, s.detail.as_deref().unwrap_or(""));
}

async fn serve(core: Arc<Core>, port: u16, no_open: bool, dev: bool) -> Result<(), Error> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| Error::internal(format!("无法监听 127.0.0.1:{port}：{e}")).with_hint("端口可能被占用，用 --port 换一个"))?;
    let port = listener.local_addr()?.port();
    let token = http::make_token(dev);
    let url = format!("http://127.0.0.1:{port}/#token={token}");
    println!("Bunsen 已启动：{url}");
    println!("数据目录：{}", core.paths().data.display());
    use std::io::Write;
    let _ = std::io::stdout().flush();
    if !no_open {
        open_browser(&url);
    }
    let app = http::router(core, token, port, dev);
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| Error::internal(format!("服务异常退出：{e}")))
}

fn open_browser(url: &str) {
    let r = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(url).spawn()
    } else if cfg!(windows) {
        std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn()
    } else {
        std::process::Command::new("xdg-open").arg(url).spawn()
    };
    if r.is_err() {
        eprintln!("没能自动打开浏览器，请手动打开上面的地址。");
    }
}

async fn run(cli: Cli) -> Result<(), Error> {
    let json = cli.json;
    let core = Core::open()?;
    match cli.cmd {
        Cmd::Serve { port, no_open, dev } => serve(core, port, no_open, dev).await?,
        Cmd::Mcp => mcp::run(core).await?,
        Cmd::Servers => {
            let v = core.servers()?;
            if json {
                print_json(&v)
            } else {
                print_servers(&v)
            }
        }
        Cmd::Projects => {
            let projects = core.projects()?;
            if json {
                print_json(&projects)
            } else {
                print_projects(&projects)
            }
        }
        Cmd::Project { cmd } => match cmd {
            ProjectCmd::Add { name, hub, branch, home, create } => {
                let p = core.add_project(NewProject { name, hub, branch, home, create }).await?;
                if json {
                    print_json(&p)
                } else {
                    print_projects(&[p])
                }
            }
            ProjectCmd::View { project, refresh } => {
                let v = core.project_view(&project, refresh).await?;
                if json {
                    print_json(&v)
                } else {
                    print_project_view(&v)
                }
            }
            ProjectCmd::Sync { project } => {
                let v = core.sync_project(&project).await?;
                if json {
                    print_json(&v)
                } else {
                    for m in &v.members {
                        println!("{}", member_sync_line(m));
                    }
                    print_project_view(&v.view);
                }
            }
            ProjectCmd::Rm { project } => {
                core.delete_project(&project).await?;
                if !json {
                    println!("已删除项目，接入它的会话保留。");
                }
            }
        },
        Cmd::Import { files } => {
            let mut uploads = Vec::new();
            for f in files {
                let data = std::fs::read(&f).map_err(|e| Error::bad_request(format!("读不了 {}：{e}", f.display())))?;
                let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                uploads.push(Upload { name, data });
            }
            let r = core.import(uploads, None).await?;
            if json {
                print_json(&r);
            } else {
                for s in &r.servers_added {
                    println!("新增服务器 {}（{}@{}:{}）", s.alias, s.user, s.host, s.port);
                }
                for s in &r.servers_updated {
                    println!("更新服务器 {}", s.alias);
                }
                for k in &r.keys_added {
                    println!("保存私钥 {}（{} {}）", k.name, k.kind, k.fingerprint);
                }
                for t in &r.tests {
                    let alias = core.server_by_id(&t.server_id).map(|s| s.alias).unwrap_or_else(|_| t.server_id.clone());
                    if t.ok {
                        println!("连接 {alias}：成功（密钥 {}）", t.key_used.as_deref().unwrap_or("默认"));
                    } else {
                        println!("连接 {alias}：失败（{}）", t.detail.as_deref().unwrap_or("未知原因"));
                    }
                }
                for w in &r.warnings {
                    println!("注意：{w}");
                }
            }
        }
        Cmd::Test { server, try_all_keys } => {
            let r = core.test_server(&server, try_all_keys).await?;
            if json {
                print_json(&r);
            } else if r.ok {
                println!(
                    "连接 {} 成功，{} ms，密钥 {}",
                    r.server.alias,
                    r.latency_ms.unwrap_or(0),
                    r.key_used.as_deref().unwrap_or("默认")
                );
            } else {
                println!("连接 {} 失败：{}", r.server.alias, r.server.status_detail.as_deref().unwrap_or("未知原因"));
            }
        }
        Cmd::Probe { server } => {
            let s = core.probe_server(&server).await?;
            if json {
                print_json(&s);
            } else if let Some(p) = &s.probe {
                println!("{}（{}@{}）", s.alias, p.user, p.hostname);
                println!("系统：{}，内核 {}，{}，{} 核，内存 {}/{} GB 可用", p.os, p.kernel, p.arch, p.cpus, p.mem_free_gb, p.mem_total_gb);
                if let Some(d) = &p.disk_home {
                    println!("家目录磁盘：{}/{} GB 可用", d.free_gb, d.total_gb);
                }
                println!("tmux：{}", if p.tmux.present { p.tmux.version.as_deref().unwrap_or("有") } else { "没有" });
                for (id, a) in &p.agents {
                    if a.present {
                        println!("代理 {id}：{}（{}）", a.version.as_deref().unwrap_or("版本未知"), a.path.as_deref().unwrap_or(""));
                    }
                }
                for g in &p.gpus {
                    println!("GPU {}：{} {}/{} MB {}% 进程 {}", g.index, g.name, g.mem_used_mb, g.mem_total_mb, g.util_pct, g.procs);
                }
            }
        }
        Cmd::Agents => {
            let v = core.agents()?;
            if json {
                print_json(&v);
            } else {
                for a in &v {
                    println!("{}  {}  {}{}", a.id, a.name, a.launch, if a.builtin { "" } else { "  （自定义）" });
                }
            }
        }
        Cmd::Sessions { refresh } => {
            let v = core.sessions(refresh).await?;
            if json {
                print_json(&v)
            } else {
                print_sessions(&v)
            }
        }
        Cmd::Deploy { server, agent, workdir, title, prompt, yolo, plugins, no_plugins, extra_args, project } => {
            let plugins = if no_plugins {
                Some(vec![])
            } else if plugins.is_empty() {
                None
            } else {
                Some(plugins)
            };
            let req = DeployRequest {
                server_id: server,
                agent_id: agent,
                title,
                workdir,
                prompt,
                yolo: Some(yolo),
                plugin: None,
                plugins,
                extra_args,
                project_id: project.map(|p| core.project(&p).map(|p| p.id)).transpose()?,
            };
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Step>();
            let printer = tokio::spawn(async move {
                while let Some(s) = rx.recv().await {
                    if !json {
                        print_step(&s);
                    }
                }
            });
            let r = core.deploy(req, Some(tx)).await;
            let _ = printer.await;
            match r {
                Ok(out) => {
                    if json {
                        print_json(&serde_json::json!({ "session": out.session, "steps": out.steps }));
                    } else {
                        println!("已部署会话 {}：{}", out.session.id, out.session.title);
                        println!("接入：bunsen attach {}    或    {}", out.session.id, out.session.attach_cmd);
                    }
                }
                Err(f) => {
                    if json {
                        print_json(&serde_json::json!({ "error": f.error, "steps": f.steps }));
                        return Err(Error { message: String::new(), ..f.error });
                    }
                    return Err(f.error);
                }
            }
        }
        Cmd::Attach { id, shell } => {
            let t = if shell { TermTarget::Shell { session: id } } else { TermTarget::Agent { session: id } };
            let tc = core.term_command(&t)?;
            let mut cmd = std::process::Command::new(&tc.program);
            cmd.args(&tc.args);
            if tc.local {
                for (k, _) in std::env::vars_os() {
                    if k.to_str().is_some_and(bunsen_core::exec::scrub_var) {
                        cmd.env_remove(k);
                    }
                }
            }
            let status = cmd.status()?;
            if !status.success() {
                std::process::exit(status.code().unwrap_or(1));
            }
        }
        Cmd::Send { id, text, no_enter } => {
            core.send(&id, &text, !no_enter).await?;
            if json {
                print_json(&serde_json::json!({ "ok": true }))
            } else {
                println!("已发送")
            }
        }
        Cmd::Capture { id, lines } => {
            let text = core.capture(&id, lines).await?;
            if json {
                print_json(&serde_json::json!({ "text": text }))
            } else {
                println!("{text}")
            }
        }
        Cmd::Restart { id, no_resume } => {
            let s = core.restart(&id, !no_resume).await?;
            if json {
                print_json(&s)
            } else {
                println!("会话 {} 状态：{}", s.id, state_text(s.state))
            }
        }
        Cmd::Plugins => {
            let v = core.plugins()?;
            if json {
                print_json(&v);
            } else {
                for p in &v {
                    let src = match &p.path {
                        Some(path) => format!("本机 {path}"),
                        None => "内嵌".to_string(),
                    };
                    println!(
                        "{}  {}  {} 个技能  {} 个子代理  {}",
                        p.name,
                        if p.version.is_empty() { "-" } else { &p.version },
                        p.skills.len(),
                        p.agents.len(),
                        src
                    );
                }
            }
        }
        Cmd::Artifacts { id, limit } => {
            let v = core.artifacts(&id, limit).await?;
            if json {
                print_json(&v);
            } else {
                for a in &v.items {
                    let provenance = a
                        .run
                        .as_ref()
                        .map(|r| format!("  出自 {}{}", r.run_id, if r.verified == Some(false) { "（运行之后改过）" } else { "" }))
                        .unwrap_or_default();
                    println!("{}  {:>9}  {}  {}{}", a.mtime, a.size, a.kind, a.path, provenance);
                }
                if v.truncated {
                    println!("（只显示前 {} 条）", v.items.len());
                }
            }
        }
        Cmd::Research { id, trust: true, .. } => {
            let v = core.research_trust(&id).await?;
            if json {
                print_json(&v);
            } else {
                print_trust(&v);
            }
        }
        Cmd::Research { id, run, lines, .. } => match run {
            Some(r) => {
                let v = core.research_run(&id, &r, lines).await?;
                if json {
                    print_json(&v);
                } else {
                    println!("{}", serde_json::to_string_pretty(&v.meta).unwrap_or_default());
                    println!("--- 日志末尾 ---\n{}", v.log_tail);
                    if let Some(m) = &v.metrics {
                        println!("--- metrics.json ---\n{}", serde_json::to_string_pretty(m).unwrap_or_default());
                    }
                    for (name, value) in [("env.json", &v.env), ("outputs.json", &v.outputs)] {
                        if let Some(value) = value {
                            println!("--- {name} ---\n{}", serde_json::to_string_pretty(value).unwrap_or_default());
                        }
                    }
                    if let Some(r) = &v.result_md {
                        println!("--- 结果页 ---\n{r}");
                    }
                }
            }
            None => {
                let v = core.research(&id).await?;
                if json {
                    print_json(&v);
                } else if !v.present {
                    println!("工作目录里没有研究目录（{}/PROJECT.md）", v.home);
                } else {
                    println!("研究目录：{}；循环：{}", v.home, if v.loop_.on { "开" } else { "关" });
                    if let Some(b) = &v.loop_.blocked {
                        println!("在等用户：{b}");
                    }
                    if let Some(plan) = &v.plan_md {
                        println!("--- 计划 ---\n{plan}");
                    }
                    for r in &v.runs {
                        println!(
                            "{}  {}  {}  退出码 {}  {}",
                            r.run_id,
                            r.kind,
                            r.state,
                            r.exit_code.map(|c| c.to_string()).unwrap_or("-".into()),
                            r.elapsed
                        );
                    }
                }
            }
        },
        Cmd::Notes { server, set } => {
            let v = match set {
                Some(f) => {
                    let text = std::fs::read_to_string(&f).map_err(|e| Error::bad_request(format!("读不了 {}：{e}", f.display())))?;
                    core.set_host_notes(&server, &text).await?
                }
                None => core.host_notes(&server).await?,
            };
            if json {
                print_json(&v);
            } else if v.exists {
                print!("{}", v.text);
            } else {
                println!("这台服务器还没有主机笔记（探测一次会生成初稿）。");
            }
        }
        Cmd::Stop { id } => {
            let s = core.stop(&id).await?;
            if json {
                print_json(&s)
            } else {
                println!("会话 {} 状态：{}", s.id, state_text(s.state))
            }
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => {
            let code = err.exit_code();
            let text = bunsen_core::error::redact(&err.to_string());
            if err.use_stderr() {
                eprint!("{text}");
            } else {
                print!("{text}");
            }
            return ExitCode::from(code as u8);
        }
    };
    let json = cli.json;
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fail(json, &Error::internal(format!("无法启动运行时：{e}"))),
    };
    match rt.block_on(run(cli)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) if json && e.message.is_empty() => ExitCode::from(1),
        Err(e) => fail(json, &e),
    }
}

#[cfg(test)]
mod project_cli_tests {
    use super::*;

    // 两个同机、不同标题的会话；一个同步成功，一个缺少 rk.py。
    pub(crate) fn sync_members(core: &Core, project: &str) {
        let root = &core.paths().data;
        let workdir = root.join("member");
        std::fs::create_dir_all(workdir.join("research/tools")).unwrap();
        std::fs::write(workdir.join("research/tools/rk.py"), "print('{\"ok\":true}')\n").unwrap();
        let missing = root.join("missing");
        std::fs::create_dir_all(&missing).unwrap();
        let members = [("member", "训练甲", workdir), ("failed", "训练乙", missing)];
        let store = bunsen_core::store::Store::open(core.paths().clone()).unwrap();
        store
            .update_sessions(|v| {
                for (id, title, wd) in members {
                    v.push(
                        serde_json::from_value(serde_json::json!({
                            "id":id,"title":title,"server_id":"local","server_alias":"local","agent_id":"codex",
                            "workdir":wd,"tmux":format!("op-{id}"),"created_at":"2026-11-13T00:00:00Z",
                            "last_active_at":null,"state":"stopped","exit_status":null,"attached":0,
                            "pinned":false,"archived":false,"plugin":null,"plugins":[],"yolo":false,
                            "preview":null,"attach_cmd":"","origin":"local","project_id":project,"machine":null
                        }))
                        .unwrap(),
                    );
                }
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn project_sync_text_and_json_include_title() {
        let m = MemberSync {
            session_id: "abc123".into(),
            server_alias: "local".into(),
            title: "训练甲".into(),
            ok: true,
            detail: "完成".into(),
            result: None,
        };
        assert_eq!(member_sync_line(&m), "abc123  local  训练甲  完成");
        assert_eq!(serde_json::to_value(&m).unwrap()["title"], "训练甲");
    }

    #[test]
    fn parse_project_commands() {
        assert!(matches!(Cli::try_parse_from(["bunsen", "projects", "--json"]).unwrap(), Cli { json: true, cmd: Cmd::Projects }));
        let cli = Cli::try_parse_from([
            "bunsen",
            "project",
            "add",
            "示例",
            "local:/repo",
            "--branch",
            "research/demo",
            "--home",
            "lab",
            "--create",
            "--json",
        ])
        .unwrap();
        assert!(matches!(cli, Cli { json: true, cmd: Cmd::Project { cmd: ProjectCmd::Add { create: true, .. } } }));
        assert!(matches!(
            Cli::try_parse_from(["bunsen", "project", "view", "示例", "--refresh"]).unwrap().cmd,
            Cmd::Project { cmd: ProjectCmd::View { refresh: true, .. } }
        ));
        assert!(matches!(
            Cli::try_parse_from(["bunsen", "project", "sync", "示例"]).unwrap().cmd,
            Cmd::Project { cmd: ProjectCmd::Sync { .. } }
        ));
        assert!(matches!(
            Cli::try_parse_from(["bunsen", "project", "rm", "示例"]).unwrap().cmd,
            Cmd::Project { cmd: ProjectCmd::Rm { .. } }
        ));
        let deploy =
            Cli::try_parse_from(["bunsen", "deploy", "--server", "local", "--agent", "codex", "--workdir", "/repo", "--project", "示例"])
                .unwrap();
        assert!(matches!(deploy.cmd, Cmd::Deploy { project: Some(p), .. } if p == "示例"));
    }
}

#[cfg(test)]
#[path = "../tests/support/r5.rs"]
mod r5_support;

#[cfg(test)]
#[path = "../tests/support/quality.rs"]
mod quality_support;
