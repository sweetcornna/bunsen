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
    /// v1.3：本机（不经 ssh，脚本直接交给本机的 bash）。只有一条，id 固定为 `local`。
    Local,
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
    #[serde(serialize_with = "crate::error::safe_optional")]
    pub status_detail: Option<String>,
    pub last_checked: Option<String>,
    pub probe: Option<Probe>,
}

impl Server {
    pub fn is_local(&self) -> bool {
        self.source == ServerSource::Local
    }
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
    /// v1.3：部署时接入的研究项目
    #[serde(default)]
    pub project_id: Option<String>,
    /// v1.3：这台机器在研究项目里的代号（`rk id`，对应汇合点上的 `sync/<代号>`）
    #[serde(default)]
    pub machine: Option<String>,
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
    #[serde(serialize_with = "crate::error::safe_optional")]
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
    #[serde(serialize_with = "crate::error::safe_optional")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ImportResult {
    pub servers_added: Vec<Server>,
    pub servers_updated: Vec<Server>,
    pub keys_added: Vec<KeyInfo>,
    #[serde(serialize_with = "crate::error::safe_warnings")]
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
    /// v1.3：接入研究项目：工作目录里没有仓库时从汇合点克隆，然后 `rk sync --setup`
    #[serde(default)]
    pub project_id: Option<String>,
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
    #[serde(default)]
    pub env: Option<RkEnv>,
    #[serde(default)]
    pub outputs: Option<RkOutputs>,
}

// 保留 rk 对象的未知字段；Bunsen 不重新实现插件的 schema/业务校验。
pub type RkEnv = serde_json::Value;
pub type RkOutputs = serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchTrust {
    pub available: bool,
    #[serde(serialize_with = "crate::error::safe_optional")]
    pub reason: Option<String>,
    #[serde(serialize_with = "crate::error::safe_optional")]
    pub rk_version: Option<String>,
    #[serde(serialize_with = "crate::error::safe_text")]
    pub checked_at: String,
    #[serde(serialize_with = "crate::research_quality::safe_object")]
    pub check: Option<serde_json::Value>,
    #[serde(serialize_with = "crate::research_quality::safe_object")]
    pub review: Option<serde_json::Value>,
    #[serde(serialize_with = "crate::research_quality::safe_object")]
    pub cite: Option<serde_json::Value>,
    #[serde(serialize_with = "crate::research_quality::safe_object")]
    pub plan: Option<serde_json::Value>,
    pub failures: Vec<TrustFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustCommand {
    Check,
    Review,
    Cite,
    Plan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustFailure {
    pub command: TrustCommand,
    #[serde(serialize_with = "crate::error::safe_text")]
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactRun {
    pub run_id: String,
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Artifact {
    #[serde(default)]
    pub run: Option<ArtifactRun>,
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
    #[serde(default)]
    pub repo_prefix: Option<String>,
    pub present: bool,
    pub home: String,
    #[serde(rename = "loop")]
    pub loop_: LoopInfo,
    pub state_md: Option<String>,
    pub summary_md: Option<String>,
    pub ideas_md: Option<String>,
    pub ledger_md: Option<String>,
    #[serde(default)]
    pub plan_md: Option<String>,
    pub runs: Vec<ResearchRun>,
    // v1.1
    pub overview_md: Option<String>,
    pub lessons_md: Option<String>,
    pub log_tail: Option<String>,
    pub prereg: Vec<NamedDoc>,
    pub results: Vec<NamedDoc>,
}

/// v1.3：跨机器的研究项目。几台机器（本机、服务器）各有一份检出，经汇合点（git 远程）汇合：
/// 每台机器写 `sync/<代号>`，共同的研究分支是 `research/<简称>`。Bunsen 在本机保留汇合点的只读镜像，从中读出统一视图。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// git 地址（各台机器都能取到，例如私有 GitHub 仓库），或 `<服务器别名>:<路径>`（汇合点是 Bunsen 某台服务器上的裸仓库）
    pub hub: String,
    pub branch: String,
    /// 仓库里的研究目录
    #[serde(default = "default_research_home")]
    pub home: String,
    pub created_at: String,
    #[serde(default)]
    pub fetched_at: Option<String>,
    #[serde(default)]
    #[serde(serialize_with = "crate::error::safe_optional")]
    pub fetch_error: Option<String>,
}

fn default_research_home() -> String {
    "research".into()
}

/// `POST /api/projects`
#[derive(Debug, Clone, Default, Deserialize)]
pub struct NewProject {
    pub name: String,
    pub hub: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub home: Option<String>,
    /// 汇合点是某台服务器上的路径、且还不存在时，在那里建一个空的裸仓库
    #[serde(default)]
    pub create: bool,
}

/// 接入这个项目的会话。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectMember {
    pub session_id: String,
    pub title: String,
    pub server_id: String,
    pub server_alias: String,
    pub workdir: String,
    pub state: SessionState,
    pub machine: Option<String>,
}

/// 汇合点上一台机器的 `sync/<代号>` 分支。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectMachine {
    pub code: String,
    pub head: String,
    pub committed_at: Option<String>,
    pub subject: String,
    /// 研究分支还没有的提交数
    pub ahead: u32,
    /// 这台机器还没并入的研究分支提交数
    pub behind: u32,
    /// 并入研究分支会不会冲突；`None` 表示不用并（ahead 或 behind 为 0）或判断不了
    pub conflict: Option<bool>,
    /// 这台机器上接入本项目的会话 id
    pub sessions: Vec<String>,
    pub server_alias: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectLine {
    #[serde(default)]
    pub open_fails: Option<usize>,
    #[serde(default)]
    pub unreviewed: Option<usize>,
    pub line: String,
    pub holder: Option<String>,
    pub token: u64,
    pub stamped: Option<String>,
    pub stage: Option<String>,
    pub waiting: Option<String>,
    pub updated: Option<String>,
    pub next: Vec<String>,
    /// 取自哪个分支（推进者的 sync 分支比研究分支新时取前者）
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectRun {
    pub run_id: String,
    pub machine: Option<String>,
    pub kind: String,
    /// ok / failed / open（还没结束，或结束的记录还没同步上来）
    pub state: String,
    pub exit_code: Option<i64>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub line: Option<String>,
    pub note: String,
    pub has_metrics: bool,
    /// 研究分支里已经有这条运行
    pub integrated: bool,
    pub source: String,
}

/// `GET /api/projects/:id/view`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectView {
    #[serde(default)]
    pub trust: Option<ProjectTrust>,
    pub project: Project,
    pub research_head: Option<String>,
    pub machines: Vec<ProjectMachine>,
    pub lines: Vec<ProjectLine>,
    pub runs: Vec<ProjectRun>,
    pub members: Vec<ProjectMember>,
    /// 研究分支上 SUMMARY.md 里“需要你决定”一节
    pub decisions: Option<String>,
    #[serde(serialize_with = "crate::error::safe_warnings")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectTrust {
    pub open_fails: usize,
    pub unreviewed: usize,
    pub unresolved_citations: usize,
    pub retracted_citations: usize,
}

/// `POST /api/projects/:id/sync` 里一个会话的结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberSync {
    pub session_id: String,
    pub server_alias: String,
    pub title: String,
    pub ok: bool,
    #[serde(serialize_with = "crate::error::safe_text")]
    pub detail: String,
    #[serde(serialize_with = "crate::error::safe_result")]
    pub result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSync {
    pub members: Vec<MemberSync>,
    pub view: ProjectView,
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
            repo_prefix: None,
            present: false,
            home: "research".into(),
            loop_: LoopInfo { on: false, started: None, blocked: None },
            state_md: None,
            summary_md: None,
            ideas_md: None,
            ledger_md: None,
            plan_md: None,
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
