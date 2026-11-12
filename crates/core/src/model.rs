//! API.md 第 1 节的数据类型。字段名与文档逐一对应。

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstallMethod {
    pub label: String,
    pub cmd: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Agent {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub description: String,
    pub detect: String,
    pub launch: String,
    #[serde(default)]
    pub launch_with_prompt: Option<String>,
    #[serde(default)]
    pub resume: Option<String>,
    #[serde(default)]
    pub yolo_flag: Option<String>,
    #[serde(default)]
    pub plugin_dir_flag: Option<String>,
    /// v1.2：没有 plugin_dir_flag 时，把它（`{dirs}` 换成逗号分隔的远程插件目录）放在初始提示前面
    #[serde(default)]
    pub plugin_prompt: Option<String>,
    #[serde(default)]
    pub install: Vec<InstallMethod>,
    #[serde(default)]
    pub auth_hint: String,
    #[serde(default)]
    pub docs_url: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerSource {
    Upload,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerStatus {
    Unknown,
    Online,
    Offline,
    AuthFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Server {
    pub id: String,
    pub alias: String,
    pub host: String,
    pub user: String,
    pub port: u16,
    pub key: Option<String>,
    pub proxy_jump: Option<String>,
    pub proxy_command: Option<String>,
    pub source: ServerSource,
    pub note: String,
    pub default_workdir: String,
    pub status: ServerStatus,
    pub status_detail: Option<String>,
    pub last_checked: Option<String>,
    pub probe: Option<Probe>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiskInfo {
    pub total_gb: f64,
    pub free_gb: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TmuxInfo {
    pub present: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolsInfo {
    pub git: Option<String>,
    pub python: Option<String>,
    pub node: Option<String>,
    pub rsync: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentPresence {
    pub present: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Probe {
    pub checked_at: String,
    pub hostname: String,
    pub user: String,
    pub home: String,
    pub os: String,
    pub kernel: String,
    pub arch: String,
    pub shell: String,
    pub cpus: u32,
    pub mem_total_gb: f64,
    pub mem_free_gb: f64,
    pub disk_home: Option<DiskInfo>,
    pub tmux: TmuxInfo,
    pub tools: ToolsInfo,
    pub agents: BTreeMap<String, AgentPresence>,
    pub gpus: Vec<Gpu>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gpu {
    pub index: u32,
    pub name: String,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub util_pct: u32,
    /// `apps.len()`
    pub procs: u32,
    /// v1.1
    #[serde(default)]
    pub temp_c: Option<i32>,
    /// v1.1：这张卡上的计算进程
    #[serde(default)]
    pub apps: Vec<GpuApp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GpuApp {
    pub pid: u32,
    pub user: String,
    pub mem_mb: u64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyInfo {
    pub name: String,
    pub kind: String,
    pub fingerprint: String,
    pub has_pub: bool,
    pub used_by: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Running,
    Exited,
    Stopped,
    Unreachable,
    Unknown,
}

impl SessionState {
    /// tmux 会话还在（代理活着或窗格保留着）。
    pub fn is_alive(self) -> bool {
        matches!(self, SessionState::Running | SessionState::Exited)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Local,
    Discovered,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub server_id: String,
    pub server_alias: String,
    pub agent_id: String,
    pub workdir: String,
    pub tmux: String,
    pub created_at: String,
    pub last_active_at: Option<String>,
    pub state: SessionState,
    pub exit_status: Option<i32>,
    pub attached: u32,
    pub pinned: bool,
    pub archived: bool,
    pub plugin: Option<String>,
    /// v1.2；`plugin` 为 `plugins[0]`
    #[serde(default)]
    pub plugins: Vec<String>,
    pub yolo: bool,
    pub preview: Option<String>,
    pub attach_cmd: String,
    pub origin: Origin,
}

/// 本机持久化的会话记录：对外的 `Session` 加上只在本机用的字段。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionRecord {
    #[serde(flatten)]
    pub session: Session,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_args: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Running,
    Ok,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub step: String,
    pub label: String,
    pub status: StepStatus,
    pub detail: Option<String>,
    pub ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: Theme,
    #[serde(default)]
    pub default_server: Option<String>,
    #[serde(default)]
    pub default_agent: Option<String>,
    #[serde(default)]
    pub research_plugin_path: Option<String>,
    #[serde(default = "default_interval")]
    pub status_interval_secs: u32,
    /// v1.2：本机插件目录
    #[serde(default)]
    pub plugin_paths: Vec<String>,
}

fn default_theme() -> Theme {
    Theme::System
}
fn default_interval() -> u32 {
    30
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: Theme::System,
            default_server: None,
            default_agent: None,
            research_plugin_path: None,
            status_interval_secs: 30,
            plugin_paths: vec![],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImportTest {
    pub server_id: String,
    pub ok: bool,
    pub key_used: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ImportResult {
    pub servers_added: Vec<Server>,
    pub servers_updated: Vec<Server>,
    pub keys_added: Vec<KeyInfo>,
    pub warnings: Vec<String>,
    pub tests: Vec<ImportTest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub key_used: Option<String>,
    pub server: Server,
}

/// 手工添加服务器的请求体。
#[derive(Debug, Clone, Deserialize)]
pub struct NewServer {
    pub alias: String,
    pub host: String,
    pub user: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub proxy_command: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub default_workdir: Option<String>,
}

/// PATCH 服务器：字段缺省表示不改；可空字段写 `null` 表示清空。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ServerPatch {
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default, deserialize_with = "double_option")]
    pub key: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub proxy_jump: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub proxy_command: Option<Option<String>>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub default_workdir: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SessionPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
}

/// 部署请求体。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct DeployRequest {
    pub server_id: String,
    pub agent_id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub workdir: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub yolo: Option<bool>,
    /// 旧字段：`"research"` 等价 `plugins:["research"]`，`null` 等价 `[]`；缺省看 `plugins`
    #[serde(default, deserialize_with = "double_option")]
    pub plugin: Option<Option<String>>,
    /// v1.2：缺省 = 全部可用插件；`[]` = 不带
    #[serde(default)]
    pub plugins: Option<Vec<String>>,
    #[serde(default)]
    pub extra_args: Option<String>,
}

impl DeployRequest {
    /// 按兼容规则得出要带的插件；`None` 表示“全部可用插件”。
    pub fn selected_plugins(&self) -> Option<Vec<String>> {
        if let Some(p) = &self.plugins {
            return Some(p.iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect());
        }
        match &self.plugin {
            Some(Some(p)) if !p.trim().is_empty() => Some(vec![p.trim().to_string()]),
            Some(_) => Some(vec![]),
            None => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DeployOutcome {
    pub session: Session,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub mtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContent {
    pub path: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitChange {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub changes: Vec<GitChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitDiff {
    pub diff: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopInfo {
    pub on: bool,
    pub started: Option<String>,
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchRun {
    pub run_id: String,
    pub kind: String,
    pub state: String,
    pub exit_code: Option<i64>,
    pub host: String,
    pub started_at: String,
    pub elapsed: String,
    pub note: String,
    // v1.1：取自 runs/<run_id>/meta.json
    pub cmd: Option<String>,
    pub cwd: Option<String>,
    pub ended_at: Option<String>,
    pub prereg: Vec<String>,
    pub commit: Option<String>,
    pub dirty: Option<bool>,
    pub has_metrics: bool,
    pub has_result: bool,
}

/// prereg/*.md、results/*.md 的条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedDoc {
    pub name: String,
    pub title: String,
}

/// `GET /api/sessions/:id/research/run`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunDetail {
    pub run_id: String,
    pub meta: serde_json::Value,
    pub log_tail: String,
    pub metrics: Option<serde_json::Value>,
    pub result_md: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Artifact {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub mtime: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactList {
    pub items: Vec<Artifact>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginSourceKind {
    Bundled,
    Local,
}

/// v1.2
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Plugin {
    pub name: String,
    pub version: String,
    pub description: String,
    pub source: PluginSourceKind,
    pub path: Option<String>,
    pub skills: Vec<String>,
    pub agents: Vec<String>,
    pub hooks: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostNotes {
    pub text: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchPanel {
    pub present: bool,
    pub home: String,
    #[serde(rename = "loop")]
    pub loop_: LoopInfo,
    pub state_md: Option<String>,
    pub summary_md: Option<String>,
    pub ideas_md: Option<String>,
    pub ledger_md: Option<String>,
    pub runs: Vec<ResearchRun>,
    // v1.1
    pub overview_md: Option<String>,
    pub lessons_md: Option<String>,
    pub log_tail: Option<String>,
    pub prereg: Vec<NamedDoc>,
    pub results: Vec<NamedDoc>,
}

/// 区分“字段缺省”和“字段为 null”。
pub fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_distinguishes_null_and_absent() {
        let p: ServerPatch = serde_json::from_str(r#"{"key": null}"#).unwrap();
        assert_eq!(p.key, Some(None));
        assert_eq!(p.proxy_jump, None);
        let p: ServerPatch = serde_json::from_str(r#"{"key": "id_x"}"#).unwrap();
        assert_eq!(p.key, Some(Some("id_x".into())));
    }

    #[test]
    fn deploy_plugin_compat() {
        let r = |j: &str| serde_json::from_str::<DeployRequest>(j).unwrap().selected_plugins();
        let base = r#""server_id":"s","agent_id":"a","workdir":"~""#;
        assert_eq!(r(&format!("{{{base}}}")), None);
        assert_eq!(r(&format!("{{{base},\"plugins\":[]}}")), Some(vec![]));
        assert_eq!(r(&format!("{{{base},\"plugin\":\"research\"}}")), Some(vec!["research".to_string()]));
        assert_eq!(r(&format!("{{{base},\"plugin\":null}}")), Some(vec![]));
        assert_eq!(r(&format!("{{{base},\"plugin\":\"research\",\"plugins\":[\"x\"]}}")), Some(vec!["x".to_string()]));
    }

    #[test]
    fn research_panel_uses_loop_key() {
        let p = ResearchPanel {
            present: false,
            home: "research".into(),
            loop_: LoopInfo { on: false, started: None, blocked: None },
            state_md: None,
            summary_md: None,
            ideas_md: None,
            ledger_md: None,
            runs: vec![],
            overview_md: None,
            lessons_md: None,
            log_tail: None,
            prereg: vec![],
            results: vec![],
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("loop").is_some());
    }
}
