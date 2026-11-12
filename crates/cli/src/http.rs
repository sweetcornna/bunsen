//! 本机 HTTP / WebSocket 服务（API.md 第 0、2–8 节）。只监听 127.0.0.1。

use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Multipart, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::Router;
use bunsen_core::import::Upload;
use bunsen_core::model::*;
use bunsen_core::term::{self, TermTarget};
use bunsen_core::util::{constant_time_eq, random_token};
use bunsen_core::{Code, Core, Error};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    core: Arc<Core>,
    token: Arc<String>,
    port: u16,
    dev: bool,
}

#[derive(rust_embed::RustEmbed)]
#[folder = "../../ui/dist"]
struct UiAssets;

// ---------- 错误 ----------

pub struct ApiError(Error);

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error_response(&self.0)
    }
}

fn error_response(e: &Error) -> Response {
    let status = StatusCode::from_u16(e.code.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, axum::Json(json!({ "error": e }))).into_response()
}

type ApiResult<T> = Result<axum::Json<T>, ApiError>;

fn ok<T>(v: T) -> ApiResult<T> {
    Ok(axum::Json(v))
}

/// 请求体按 JSON 解析；空体视为 `{}`。解析失败给中文的 bad_request。
fn body<T: DeserializeOwned>(b: &Bytes) -> Result<T, ApiError> {
    let src: &[u8] = if b.iter().all(u8::is_ascii_whitespace) { b"{}" } else { b };
    serde_json::from_slice(src).map_err(|e| ApiError(Error::bad_request(format!("请求体格式不对：{e}"))))
}

// ---------- 鉴权与防跨站 ----------

fn allowed_origins(port: u16, dev: bool) -> Vec<String> {
    let mut v = vec![format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")];
    if dev {
        v.push("http://localhost:5173".into());
        v.push("http://127.0.0.1:5173".into());
    }
    v
}

fn is_dev_origin(o: &str) -> bool {
    o == "http://localhost:5173" || o == "http://127.0.0.1:5173"
}

fn deny(code: Code, msg: &str) -> Response {
    error_response(&Error::new(code, msg))
}

fn add_cors(h: &mut HeaderMap, origin: &str) {
    if let Ok(v) = HeaderValue::from_str(origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("x-bunsen-token, content-type, accept"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"));
    h.insert(header::VARY, HeaderValue::from_static("Origin"));
}

async fn guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let port = st.port;
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return deny(Code::Forbidden, "拒绝访问：Host 头不是本机服务地址");
    }
    let origin = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_string);
    if let Some(o) = &origin {
        if !allowed_origins(port, st.dev).iter().any(|a| a == o) {
            return deny(Code::Forbidden, "拒绝访问：跨站请求");
        }
    }
    let cors_origin = origin.filter(|o| st.dev && is_dev_origin(o));
    if req.method() == Method::OPTIONS {
        if let Some(o) = &cors_origin {
            let mut r = StatusCode::NO_CONTENT.into_response();
            add_cors(r.headers_mut(), o);
            return r;
        }
    }
    let path = req.uri().path();
    let needs_token = path.starts_with("/api/") || path == "/api" || path.starts_with("/ws/");
    if needs_token {
        let given = if path.starts_with("/ws/") {
            req.uri()
                .query()
                .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")))
                .map(percent_decode)
        } else {
            req.headers().get("x-bunsen-token").and_then(|v| v.to_str().ok()).map(str::to_string)
        };
        if !given.as_deref().is_some_and(|g| constant_time_eq(g, &st.token)) {
            let mut r = deny(Code::Unauthorized, "缺少或错误的访问令牌");
            if let Some(o) = &cors_origin {
                add_cors(r.headers_mut(), o);
            }
            return r;
        }
    }
    let mut resp = next.run(req).await;
    if let Some(o) = &cors_origin {
        add_cors(resp.headers_mut(), o);
    }
    resp
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- 路由 ----------

pub fn router(core: Arc<Core>, token: String, port: u16, dev: bool) -> Router {
    let st = AppState { core, token: Arc::new(token), port, dev };
    Router::new()
        .route("/api/meta", get(meta))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/plugins", get(list_plugins))
        .route("/api/agents", get(list_agents))
        .route("/api/agents/{id}", put(put_agent).delete(delete_agent))
        .route("/api/servers", get(list_servers).post(add_server))
        .route("/api/servers/import", post(import_servers))
        .route("/api/servers/{id}", axum::routing::patch(patch_server).delete(delete_server))
        .route("/api/servers/{id}/test", post(test_server))
        .route("/api/servers/{id}/probe", post(probe_server))
        .route("/api/servers/{id}/gpus", get(server_gpus))
        .route("/api/servers/{id}/install-agent", post(install_agent))
        .route("/api/servers/{id}/notes", get(get_notes).put(put_notes))
        .route("/api/keys", get(list_keys))
        .route("/api/keys/{name}", axum::routing::delete(delete_key))
        .route("/api/sessions", get(list_sessions).post(deploy))
        .route("/api/sessions/{id}", get(get_session).patch(patch_session).delete(delete_session))
        .route("/api/sessions/{id}/send", post(send))
        .route("/api/sessions/{id}/keys", post(send_keys))
        .route("/api/sessions/{id}/capture", get(capture))
        .route("/api/sessions/{id}/restart", post(restart))
        .route("/api/sessions/{id}/stop", post(stop))
        .route("/api/sessions/{id}/files", get(files))
        .route("/api/sessions/{id}/file", get(file))
        .route("/api/sessions/{id}/git", get(git))
        .route("/api/sessions/{id}/git/diff", get(git_diff))
        .route("/api/sessions/{id}/research", get(research))
        .route("/api/sessions/{id}/research/run", get(research_run))
        .route("/api/sessions/{id}/raw", get(raw))
        .route("/api/sessions/{id}/artifacts", get(artifacts))
        .route("/ws/term", get(ws_term))
        .fallback(fallback)
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(st.clone(), guard))
        .with_state(st)
}

pub fn make_token(dev: bool) -> String {
    if dev {
        "dev".into()
    } else {
        random_token()
    }
}

async fn fallback(method: Method, uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") || path == "/api" || path.starts_with("/ws/") {
        return error_response(&Error::not_found(format!("没有这个接口：{method} {path}")));
    }
    if method != Method::GET && method != Method::HEAD {
        return error_response(&Error::not_found("没有这个页面"));
    }
    let rel = path.trim_start_matches('/');
    let (file, name) = match (!rel.is_empty()).then(|| UiAssets::get(rel)).flatten() {
        Some(f) => (f, rel.to_string()),
        None => match UiAssets::get("index.html") {
            Some(f) => (f, "index.html".to_string()),
            None => return (StatusCode::NOT_FOUND, "界面没有构建（ui/dist 为空）：在仓库根目录运行 ./build.sh").into_response(),
        },
    };
    let mime = file.metadata.mimetype().to_string();
    let cache = if name == "index.html" { "no-cache" } else { "public, max-age=3600" };
    ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache.to_string())], file.data.into_owned()).into_response()
}

// ---------- 基本信息与设置 ----------

async fn meta(State(st): State<AppState>) -> ApiResult<serde_json::Value> {
    ok(json!({
        "version": bunsen_core::VERSION,
        "data_dir": st.core.paths().data.to_string_lossy(),
        "platform": std::env::consts::OS,
        "dev": st.dev,
    }))
}

async fn get_settings(State(st): State<AppState>) -> ApiResult<Settings> {
    ok(st.core.settings()?)
}

async fn put_settings(State(st): State<AppState>, b: Bytes) -> ApiResult<Settings> {
    ok(st.core.put_settings(body(&b)?)?)
}

// ---------- 插件 ----------

async fn list_plugins(State(st): State<AppState>) -> ApiResult<Vec<Plugin>> {
    ok(st.core.plugins()?)
}

// ---------- Agent ----------

async fn list_agents(State(st): State<AppState>) -> ApiResult<Vec<Agent>> {
    ok(st.core.agents()?)
}

async fn put_agent(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<Agent> {
    ok(st.core.put_agent(&id, body(&b)?)?)
}

async fn delete_agent(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<serde_json::Value> {
    st.core.delete_agent(&id)?;
    ok(json!({ "ok": true }))
}

// ---------- 服务器与密钥 ----------

async fn list_servers(State(st): State<AppState>) -> ApiResult<Vec<Server>> {
    ok(st.core.servers()?)
}

async fn add_server(State(st): State<AppState>, b: Bytes) -> ApiResult<Server> {
    ok(st.core.add_server(body(&b)?)?)
}

async fn patch_server(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<Server> {
    ok(st.core.patch_server(&id, body(&b)?).await?)
}

async fn delete_server(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<serde_json::Value> {
    st.core.delete_server(&id).await?;
    ok(json!({ "ok": true }))
}

async fn import_servers(State(st): State<AppState>, mut mp: Multipart) -> ApiResult<ImportResult> {
    let mut uploads = Vec::new();
    let mut config_text: Option<String> = None;
    loop {
        let field = match mp.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => return Err(Error::bad_request(format!("上传内容读取失败：{e}")).into()),
        };
        let name = field.name().unwrap_or("").to_string();
        let file_name = field.file_name().unwrap_or("").to_string();
        let data = field.bytes().await.map_err(|e| ApiError(Error::bad_request(format!("上传内容读取失败：{e}"))))?;
        match name.as_str() {
            "config_text" => config_text = Some(String::from_utf8_lossy(&data).into_owned()),
            _ => uploads.push(Upload { name: if file_name.is_empty() { name } else { file_name }, data: data.to_vec() }),
        }
    }
    ok(st.core.import(uploads, config_text).await?)
}

#[derive(Deserialize, Default)]
struct TestBody {
    #[serde(default)]
    try_all_keys: Option<bool>,
}

async fn test_server(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<TestResult> {
    let t: TestBody = body(&b)?;
    ok(st.core.test_server(&id, t.try_all_keys.unwrap_or(false)).await?)
}

async fn probe_server(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<Server> {
    ok(st.core.probe_server(&id).await?)
}

async fn server_gpus(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<Vec<Gpu>> {
    ok(st.core.gpus(&id).await?)
}

#[derive(Deserialize)]
struct InstallBody {
    agent_id: String,
    #[serde(default)]
    method: Option<usize>,
}

async fn install_agent(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<serde_json::Value> {
    let ib: InstallBody = body(&b)?;
    let name = st.core.install_agent(&id, &ib.agent_id, ib.method).await?;
    ok(json!({ "tmux": name }))
}

async fn get_notes(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<HostNotes> {
    ok(st.core.host_notes(&id).await?)
}

#[derive(Deserialize)]
struct NotesBody {
    text: String,
}

async fn put_notes(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<HostNotes> {
    let nb: NotesBody = body(&b)?;
    ok(st.core.set_host_notes(&id, &nb.text).await?)
}

async fn list_keys(State(st): State<AppState>) -> ApiResult<Vec<KeyInfo>> {
    ok(st.core.keys()?)
}

async fn delete_key(State(st): State<AppState>, Path(name): Path<String>) -> ApiResult<serde_json::Value> {
    st.core.delete_key(&name)?;
    ok(json!({ "ok": true }))
}

// ---------- 会话 ----------

fn flag(q: &HashMap<String, String>, k: &str) -> bool {
    matches!(q.get(k).map(String::as_str), Some("1" | "true" | "yes"))
}

async fn list_sessions(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Vec<Session>> {
    ok(st.core.sessions(flag(&q, "refresh")).await?)
}

async fn get_session(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<Session> {
    ok(st.core.session(&id).await?)
}

async fn patch_session(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<Session> {
    ok(st.core.patch_session(&id, body(&b)?).await?)
}

async fn delete_session(State(st): State<AppState>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult<serde_json::Value> {
    st.core.delete_session(&id, flag(&q, "force")).await?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct SendBody {
    text: String,
    #[serde(default)]
    enter: Option<bool>,
}

async fn send(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<serde_json::Value> {
    let sb: SendBody = body(&b)?;
    st.core.send(&id, &sb.text, sb.enter.unwrap_or(true)).await?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct KeysBody {
    keys: Vec<String>,
}

async fn send_keys(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<serde_json::Value> {
    let kb: KeysBody = body(&b)?;
    st.core.send_keys(&id, &kb.keys).await?;
    ok(json!({ "ok": true }))
}

async fn capture(State(st): State<AppState>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult<serde_json::Value> {
    let lines = match q.get("lines") {
        Some(v) => Some(v.parse::<u32>().map_err(|_| ApiError(Error::bad_request("lines 必须是正整数")))?),
        None => None,
    };
    let text = st.core.capture(&id, lines).await?;
    ok(json!({ "text": text }))
}

#[derive(Deserialize)]
struct RestartBody {
    #[serde(default)]
    resume: Option<bool>,
}

async fn restart(State(st): State<AppState>, Path(id): Path<String>, b: Bytes) -> ApiResult<Session> {
    let rb: RestartBody = body(&b)?;
    ok(st.core.restart(&id, rb.resume.unwrap_or(true)).await?)
}

async fn stop(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<Session> {
    ok(st.core.stop(&id).await?)
}

#[derive(Serialize)]
struct StepLine<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(flatten)]
    step: &'a Step,
}

async fn deploy(State(st): State<AppState>, headers: HeaderMap, b: Bytes) -> Response {
    let req: DeployRequest = match body(&b) {
        Ok(r) => r,
        Err(e) => return e.into_response(),
    };
    let ndjson = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("application/x-ndjson"));
    if !ndjson {
        return match st.core.deploy(req, None).await {
            Ok(out) => axum::Json(json!({ "session": out.session, "steps": out.steps })).into_response(),
            Err(f) => (StatusCode::UNPROCESSABLE_ENTITY, axum::Json(json!({ "error": f.error, "steps": f.steps }))).into_response(),
        };
    }
    let (line_tx, line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (step_tx, mut step_rx) = tokio::sync::mpsc::unbounded_channel::<Step>();
    let fwd_tx = line_tx.clone();
    let forward = tokio::spawn(async move {
        while let Some(s) = step_rx.recv().await {
            let line = serde_json::to_string(&StepLine { kind: "step", step: &s }).unwrap_or_default();
            let _ = fwd_tx.send(line + "\n");
        }
    });
    let core = st.core.clone();
    tokio::spawn(async move {
        let r = core.deploy(req, Some(step_tx)).await;
        let _ = forward.await;
        let last = match r {
            Ok(out) => json!({ "type": "done", "session": out.session }),
            Err(f) => json!({ "type": "error", "error": f.error }),
        };
        let _ = line_tx.send(last.to_string() + "\n");
    });
    let stream = futures_util::stream::unfold(line_rx, |mut rx| async move {
        rx.recv().await.map(|l| (Ok::<_, std::convert::Infallible>(Bytes::from(l)), rx))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

// ---------- 工作区与科研面板 ----------

async fn files(State(st): State<AppState>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult<DirListing> {
    ok(st.core.files(&id, q.get("path").map(String::as_str)).await?)
}

async fn file(State(st): State<AppState>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult<FileContent> {
    ok(st.core.file(&id, q.get("path").map(String::as_str).unwrap_or("")).await?)
}

async fn git(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<GitStatus> {
    ok(st.core.git(&id).await?)
}

async fn git_diff(State(st): State<AppState>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult<GitDiff> {
    ok(st.core.git_diff(&id, q.get("path").map(String::as_str)).await?)
}

async fn research(State(st): State<AppState>, Path(id): Path<String>) -> ApiResult<ResearchPanel> {
    ok(st.core.research(&id).await?)
}

fn num_param(q: &HashMap<String, String>, k: &str) -> Result<Option<u32>, ApiError> {
    match q.get(k) {
        Some(v) => v.parse::<u32>().map(Some).map_err(|_| ApiError(Error::bad_request(format!("{k} 必须是正整数")))),
        None => Ok(None),
    }
}

async fn research_run(State(st): State<AppState>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult<RunDetail> {
    let run_id = q.get("run_id").map(String::as_str).unwrap_or("");
    ok(st.core.research_run(&id, run_id, num_param(&q, "lines")?).await?)
}

async fn artifacts(State(st): State<AppState>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult<ArtifactList> {
    ok(st.core.artifacts(&id, num_param(&q, "limit")?).await?)
}

/// 原始字节：服务器上的文件不可信，固定按下载处理，不让浏览器在本服务的源里解析它。
async fn raw(State(st): State<AppState>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    let path = q.get("path").map(String::as_str).unwrap_or("");
    match st.core.raw(&id, path).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                (header::CONTENT_DISPOSITION, "attachment"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => error_response(&e),
    }
}

// ---------- 终端通道 ----------

fn term_target(q: &HashMap<String, String>) -> Result<TermTarget, Error> {
    let pane = q.get("pane").map(String::as_str).unwrap_or("agent");
    match (q.get("session"), q.get("server"), pane) {
        (Some(s), _, "agent") => Ok(TermTarget::Agent { session: s.clone() }),
        (Some(s), _, "shell") => Ok(TermTarget::Shell { session: s.clone() }),
        (None, Some(sv), "shell") => Ok(TermTarget::ServerShell { server: sv.clone() }),
        (None, Some(sv), "install") => match q.get("agent") {
            Some(a) => Ok(TermTarget::Install { server: sv.clone(), agent_id: a.clone() }),
            None => Err(Error::bad_request("pane=install 需要 agent 参数")),
        },
        _ => Err(Error::bad_request("参数组合不对").with_hint("用 session=<id>&pane=agent|shell，或 server=<id>&pane=shell|install")),
    }
}

async fn ws_term(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>, ws: WebSocketUpgrade) -> Response {
    let target = match term_target(&q) {
        Ok(t) => t,
        Err(e) => return error_response(&e),
    };
    let args = match st.core.term_args(&target) {
        Ok(a) => a,
        Err(e) => return error_response(&e),
    };
    let num = |k: &str, d: u16| q.get(k).and_then(|v| v.parse::<u16>().ok()).filter(|v| *v > 0).unwrap_or(d);
    let (cols, rows) = (num("cols", 120), num("rows", 32));
    ws.on_upgrade(move |socket| term_session(socket, args, cols, rows))
}

fn status_frame(state: &str, detail: Option<String>) -> Message {
    Message::Text(json!({ "type": "status", "state": state, "detail": detail }).to_string().into())
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientFrame {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
}

async fn term_session(mut socket: WebSocket, args: Vec<String>, cols: u16, rows: u16) {
    if socket.send(status_frame("connecting", None)).await.is_err() {
        return;
    }
    let sp = match term::spawn("ssh", &args, cols, rows) {
        Ok(s) => s,
        Err(e) => {
            let _ = socket.send(status_frame("closed", Some(e.message))).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };
    let term::PtySpawn { pty, mut output, exit } = sp;
    if socket.send(status_frame("connected", None)).await.is_err() {
        pty.kill();
        return;
    }
    loop {
        tokio::select! {
            chunk = output.recv() => match chunk {
                Some(bytes) => {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        pty.kill();
                        return;
                    }
                }
                None => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<ClientFrame>(t.as_str()) {
                    Ok(ClientFrame::Input { data }) => pty.write(data.as_bytes()),
                    Ok(ClientFrame::Resize { cols, rows }) => {
                        let _ = pty.resize(cols, rows);
                    }
                    Err(_) => {}
                },
                Some(Ok(Message::Binary(b))) => pty.write(&b),
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    // 只结束本机的 ssh 客户端；服务器上的 tmux 会话不受影响。
                    pty.kill();
                    return;
                }
            },
        }
    }
    // 伪终端已关闭：ssh 退出了。
    let code = tokio::time::timeout(std::time::Duration::from_secs(3), exit).await.ok().and_then(|r| r.ok()).flatten();
    let detail = match code {
        Some(0) => None,
        Some(255) => Some("ssh 连接失败或被断开（退出码 255）".to_string()),
        Some(c) => Some(format!("远程进程已退出（退出码 {c}）")),
        None => Some("连接已结束".to_string()),
    };
    let _ = socket.send(status_frame("closed", detail)).await;
    let _ = socket.send(Message::Close(None)).await;
    pty.kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode() {
        assert_eq!(percent_decode("abc%20d"), "abc d");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("dev"), "dev");
    }

    #[test]
    fn targets() {
        let q = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>();
        assert_eq!(term_target(&q(&[("session", "abc123"), ("pane", "agent")])).unwrap(), TermTarget::Agent { session: "abc123".into() });
        assert_eq!(term_target(&q(&[("session", "abc123"), ("pane", "shell")])).unwrap(), TermTarget::Shell { session: "abc123".into() });
        assert_eq!(term_target(&q(&[("server", "s1"), ("pane", "shell")])).unwrap(), TermTarget::ServerShell { server: "s1".into() });
        assert!(term_target(&q(&[("server", "s1"), ("pane", "install")])).is_err());
        assert!(term_target(&q(&[("server", "s1"), ("pane", "agent")])).is_err());
    }
}
