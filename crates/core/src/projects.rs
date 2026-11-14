//! 研究项目：只读汇合点镜像、跨机器视图与接入脚本。

use crate::error::{git_error_summary, redact, Code, Error, Result};
use crate::model::*;
use crate::shell::{quote, quote_path};
use crate::util::{now_rfc3339, rfc3339_from_unix, short_id, unix_now};
use crate::Core;
#[path = "project_quality.rs"]
mod quality;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const SYNC_TIMEOUT: Duration = Duration::from_secs(200);
const FRESH_SECS: i64 = 20;

// 同一数据目录的多个 Core 也共用锁。完成时刻用来合并同时到达的强制刷新（失败也共用）。
#[derive(Default)]
struct FetchState {
    completed: Option<Instant>,
    #[cfg(test)]
    attempts: u64,
}
type ProjectLock = Arc<tokio::sync::Mutex<FetchState>>;
fn project_lock(path: &Path) -> ProjectLock {
    static LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, ProjectLock>>> = OnceLock::new();
    let key = path
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .map(|p| p.join(path.file_name().unwrap_or_default()))
        .unwrap_or_else(|| path.to_path_buf());
    LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner()).entry(key).or_default().clone()
}

async fn mirror_guard(path: &Path) -> Result<std::fs::File> {
    let lock = path.with_extension("lock");
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(lock.parent().unwrap())?;
        crate::store::lock_file(&lock)
    })
    .await
    .map_err(|e| Error::internal(format!("镜像锁任务中断：{e}")))?
}

fn wall_nanos() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos()
}

fn git_error(out: &Output) -> Error {
    Error::new(Code::HostUnreachable, format!("取不到汇合点：{}", git_error_summary(&String::from_utf8_lossy(&out.stderr))))
}

/// 非交互 git；只在 cat-file 写入去重后的哈希。所有管道和子孙进程共用超时。
async fn git_stream<T, F, Fut>(dir: &Path, args: &[&str], ssh: Option<&str>, input: Option<Vec<u8>>, read: F) -> Result<(T, Output)>
where
    F: FnOnce(tokio::process::ChildStdout) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    git_exchange(dir, args, ssh, input.is_some(), |stdin, stdout| async move {
        let write = async move {
            if let (Some(mut stdin), Some(input)) = (stdin, input) {
                stdin.write_all(&input).await?;
                stdin.shutdown().await?;
            }
            Ok::<_, Error>(())
        };
        let (_, value) = tokio::try_join!(write, read(stdout))?;
        Ok(value)
    })
    .await
}

// 交互式 batch 仍走同一个执行器、120 秒超时和进程组清理；可在读完 review 后决定是否请求结论正文。
async fn git_exchange<T, F, Fut>(dir: &Path, args: &[&str], ssh: Option<&str>, piped: bool, exchange: F) -> Result<(T, Output)>
where
    F: FnOnce(Option<tokio::process::ChildStdin>, tokio::process::ChildStdout) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "file:git:http:https:ssh")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env_remove("GIT_GLOB_PATHSPECS")
        .env_remove("GIT_NOGLOB_PATHSPECS")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(if piped { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    if let Some(ssh) = ssh {
        cmd.env("GIT_SSH_COMMAND", ssh);
    }
    let mut child = cmd.spawn().map_err(|e| Error::internal(format!("无法启动 git：{e}")))?;
    let mut group = crate::exec::ProcessGroup::new(&child);
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::time::timeout(GIT_TIMEOUT, async {
        let wait = async { child.wait().await.map_err(Error::from) };
        tokio::try_join!(exchange(stdin, stdout), bounded_output(stderr), wait)
    })
    .await;
    match result {
        Ok(Ok((value, stderr, status))) => {
            group.disarm();
            Ok((value, Output { status, stdout: vec![], stderr }))
        }
        other => {
            group.terminate().await;
            let _ = child.start_kill();
            let _ = child.wait().await;
            match other {
                Err(_) => Err(Error::timeout("git 超过 120 秒没有完成，请检查汇合点和网络")),
                Ok(Err(e)) => Err(e),
                _ => unreachable!(),
            }
        }
    }
}

async fn bounded_output(reader: impl tokio::io::AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut data = Vec::new();
    reader.take(8 * 1024 * 1024 + 1).read_to_end(&mut data).await?;
    if data.len() > 8 * 1024 * 1024 {
        return Err(Error::internal("git 输出超过 8 MiB 上限"));
    }
    Ok(data)
}

// merge-tree 等需要原始退出码，ls-tree/cat-file 则要求成功；共享同一监督机制。
async fn git(dir: &Path, args: &[&str], ssh: Option<&str>, input: Option<Vec<u8>>) -> Result<Output> {
    let (stdout, mut out) = git_stream(dir, args, ssh, input, bounded_output).await?;
    out.stdout = stdout;
    Ok(out)
}
async fn git_read<T, F, Fut>(dir: &Path, args: &[&str], input: Option<Vec<u8>>, read: F) -> Result<T>
where
    F: FnOnce(tokio::process::ChildStdout) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let (value, out) = git_stream(dir, args, None, input, read).await?;
    if !out.status.success() {
        return Err(git_error(&out));
    }
    Ok(value)
}
async fn git_ok(dir: &Path, args: &[&str], ssh: Option<&str>) -> Result<String> {
    let out = git(dir, args, ssh, None).await?;
    if !out.status.success() {
        return Err(git_error(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn validate_new(req: &NewProject) -> Result<(String, String)> {
    let name = req.name.trim().to_string();
    if name == "." || name == ".." {
        return Err(Error::bad_request("项目名称不能是 . 或 .."));
    }
    if name.contains('/') {
        return Err(Error::bad_request("项目名称不能含 /：名称可用于 API 路径，/ 会破坏路径分段"));
    }
    if name.is_empty() || name.chars().count() > 40 || req.name.chars().any(char::is_control) || req.name.contains(['\u{2028}', '\u{2029}'])
    {
        return Err(Error::bad_request("项目名称要写成一行，去掉首尾空白后为 1 到 40 个字符"));
    }
    if req.hub.is_empty() || req.hub.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(Error::bad_request("汇合点不能为空，也不能含空白或换行"));
    }
    if let Some(b) = &req.branch {
        validate_branch(b)?;
    }
    let home = req.home.as_deref().unwrap_or("research");
    if home.is_empty() || home.starts_with('/') || home.contains("..") || home.chars().any(char::is_control) {
        return Err(Error::bad_request("研究目录要用非空相对路径，不能含 .. 或换行"));
    }
    let home = home.split('/').filter(|p| !p.is_empty() && *p != ".").collect::<Vec<_>>().join("/");
    Ok((name, if home.is_empty() { ".".into() } else { home }))
}
fn validate_branch(branch: &str) -> Result<()> {
    let valid = branch.strip_prefix("research/").is_some_and(|s| {
        let mut chars = s.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && s.len() <= 40
            && chars.all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
            // git 自己也不允许这些 ref，不能存一个永远取不到的分支。
            && !s.contains("..") && !s.ends_with('.') && !s.ends_with(".lock")
    });
    if !valid {
        return Err(Error::bad_request("研究分支要写成 research/<简称>：ASCII 字母数字开头，只含 ASCII 字母数字、_、.、-，简称最多 40 个字符，不能含 .. 或以 .、.lock 结尾"));
    }
    Ok(())
}
fn repo_path(home: &str, file: &str) -> String {
    if home == "." {
        file.to_string()
    } else {
        format!("{home}/{file}")
    }
}
fn default_branch(name: &str) -> String {
    let mut slug = String::new();
    let mut replacing = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            slug.push(c);
            replacing = false;
        } else {
            if !replacing {
                slug.push('-');
            }
            replacing = true;
        }
    }
    let slug = slug.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    // 此时只含 ASCII，按字节截断也就是按字符截断。
    let slug = slug[..slug.len().min(40)].trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
    format!("research/{}", if slug.is_empty() { "main" } else { slug })
}

#[derive(Debug, Clone)]
struct HubAddress {
    url: String,
    home_relative: bool,
    ssh: Option<String>,
}
impl HubAddress {
    fn shell_url(&self) -> String {
        if self.home_relative {
            home_path(&self.url)
        } else {
            quote(&self.url)
        }
    }
}
fn home_path(path: &str) -> String {
    if path.starts_with('/') || path == "~" || path.starts_with("~/") {
        quote_path(path)
    } else {
        format!("\"$HOME\"/{}", quote(path))
    }
}
enum HubOwner<'a> {
    Local,
    Remote(&'a Server),
}
fn hub_server<'a>(hub: &'a str, servers: &'a [Server]) -> Option<(HubOwner<'a>, &'a str)> {
    let (alias, path) = hub.split_once(':')?;
    // local 是保留的本机标记，不依赖是否显示本机记录。
    if alias == "local" {
        return Some((HubOwner::Local, path));
    }
    // URL 与 user@host:path 永远是普通 git 地址。
    if alias.contains(['/', '@']) || path.starts_with("//") {
        return None;
    }
    let server = servers.iter().find(|s| s.alias == alias)?;
    Some((if server.is_local() { HubOwner::Local } else { HubOwner::Remote(server) }, path))
}
fn resolve_hub(hub: &str, servers: &[Server], destination: Option<&Server>, ssh: &str) -> Result<HubAddress> {
    let Some((owner, path)) = hub_server(hub, servers) else {
        return Ok(HubAddress { url: hub.to_string(), home_relative: false, ssh: None });
    };
    if path.is_empty() {
        return Err(Error::bad_request("汇合点缺少仓库路径"));
    }
    let local = destination.is_none_or(Server::is_local);
    if let HubOwner::Remote(server) = &owner {
        if local {
            return Ok(HubAddress { url: format!("op-{}:{path}", server.id), home_relative: false, ssh: Some(ssh.to_string()) });
        }
    }
    if !local && !matches!(&owner, HubOwner::Remote(server) if destination.is_some_and(|s| s.id == server.id)) {
        return Err(Error::bad_request("这台服务器不能访问另一台 Bunsen 服务器上的汇合点")
            .with_hint("改用各台机器都能访问的汇合点，例如私有 GitHub 仓库"));
    }
    if local {
        let url = if path.starts_with('/') {
            PathBuf::from(path)
        } else {
            let home = std::env::var_os("HOME").ok_or_else(|| Error::internal("找不到 HOME 目录"))?;
            PathBuf::from(home).join(if path == "~" { "" } else { path.strip_prefix("~/").unwrap_or(path) })
        };
        return Ok(HubAddress { url: url.to_string_lossy().into_owned(), home_relative: false, ssh: None });
    }
    Ok(HubAddress { url: path.to_string(), home_relative: true, ssh: None })
}

impl Core {
    fn mirror_path(&self, id: &str) -> PathBuf {
        self.paths().data.join("hubs").join(format!("{id}.git"))
    }
    fn project_ssh(&self) -> String {
        format!("ssh -F {} -o BatchMode=yes", quote(&self.paths().ssh_config().to_string_lossy()))
    }
    pub fn projects(&self) -> Result<Vec<Project>> {
        let mut projects = self.store.projects()?;
        projects.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        Ok(projects)
    }
    pub fn project(&self, id: &str) -> Result<Project> {
        let projects = self.store.projects()?;
        projects
            .iter()
            .find(|p| p.id == id)
            .or_else(|| projects.iter().find(|p| p.name == id))
            .cloned()
            .ok_or_else(|| Error::not_found(format!("没有项目 {id}")))
    }
    async fn fetch_project(&self, project: &Project) -> Result<()> {
        let path = self.mirror_path(&project.id);
        std::fs::create_dir_all(&path)?;
        if !path.join("HEAD").is_file() {
            git_ok(&path, &["init", "--bare", "-q"], None).await?;
        }
        let address = resolve_hub(&project.hub, &self.store.servers()?, None, &self.project_ssh())?;
        git_ok(
            &path,
            &[
                "fetch",
                "--atomic",
                "--prune",
                "--no-tags",
                "--",
                &address.url,
                "+refs/heads/research/*:refs/heads/research/*",
                "+refs/heads/sync/*:refs/heads/sync/*",
            ],
            address.ssh.as_deref(),
        )
        .await?;
        Ok(())
    }
    pub async fn add_project(&self, req: NewProject) -> Result<Project> {
        let (name, home) = validate_new(&req)?;
        if self.store.projects()?.iter().any(|p| p.name == name) {
            return Err(Error::conflict(format!("项目名称 {name} 已存在")));
        }
        let servers = self.store.servers()?;
        if let Some((sv, path)) = hub_server(&req.hub, &servers) {
            if path.is_empty() {
                return Err(Error::bad_request("汇合点缺少仓库路径"));
            }
            if req.create {
                let script = format!(
                    "export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=file:git:http:https:ssh\np={}\nif [ ! -e \"$p\" ] && [ ! -L \"$p\" ]; then git init --bare -q -- \"$p\"; fi\n",
                    home_path(path)
                );
                let out = match sv {
                    HubOwner::Local => crate::exec::run_local(&script, GIT_TIMEOUT).await,
                    HubOwner::Remote(server) => self.exec(server, &script, GIT_TIMEOUT).await,
                }
                .map_err(|e| Error::new(Code::HostUnreachable, e.message))?;
                if out.code != 0 {
                    return Err(Error::new(Code::HostUnreachable, format!("建立汇合点失败：{}", git_error_summary(&out.stderr))));
                }
            }
        }
        let mut project = Project {
            id: short_id(),
            name,
            hub: req.hub,
            branch: req.branch.clone().unwrap_or_default(),
            home,
            created_at: now_rfc3339(),
            fetched_at: None,
            fetch_error: None,
        };
        while self.mirror_path(&project.id).exists() || self.store.projects()?.iter().any(|p| p.id == project.id) {
            project.id = short_id();
        }
        let _file_guard = mirror_guard(&self.mirror_path(&project.id)).await?;
        let result = async {
            self.fetch_project(&project).await.map_err(|e| Error::new(Code::HostUnreachable, e.message))?;
            if req.branch.is_none() {
                let branches =
                    git_ok(&self.mirror_path(&project.id), &["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/research/"], None)
                        .await?;
                let branches: Vec<_> = branches.lines().collect();
                project.branch = match branches.as_slice() {
                    [] => default_branch(&project.name),
                    [b] => b.to_string(),
                    _ => return Err(Error::bad_request("汇合点上有多个研究分支，请指定 branch").with_hint(branches.join("、"))),
                };
                validate_branch(&project.branch)?;
            }
            project.fetched_at = Some(now_rfc3339());
            self.store.update_projects(|v| {
                if v.iter().any(|p| p.name == project.name || p.id == project.id) {
                    return Err(Error::conflict("项目名称或 id 已存在，请重试"));
                }
                v.push(project.clone());
                Ok(())
            })?;
            Ok(project.clone())
        }
        .await;
        if result.is_err() {
            let _ = std::fs::remove_dir_all(self.mirror_path(&project.id));
        }
        result
    }
    pub async fn delete_project(&self, id: &str) -> Result<()> {
        let project = self.project(id)?;
        let path = self.mirror_path(&project.id);
        let lock = project_lock(&path);
        let _guard = lock.lock().await;
        let _file_guard = mirror_guard(&path).await?;
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        match std::fs::remove_file(path.with_extension("fetch.json")) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        self.store.update_projects(|v| {
            v.retain(|p| p.id != project.id);
            Ok(())
        })
    }
    fn project_members(&self, id: &str) -> Result<Vec<ProjectMember>> {
        let servers = self.store.servers()?;
        Ok(self
            .store
            .sessions()?
            .into_iter()
            .map(|r| r.session)
            .filter(|s| !s.archived && s.project_id.as_deref() == Some(id))
            .map(|s| ProjectMember {
                session_id: s.id,
                title: s.title,
                server_alias: servers.iter().find(|sv| sv.id == s.server_id).map(|sv| sv.alias.clone()).unwrap_or(s.server_alias),
                server_id: s.server_id,
                workdir: s.workdir,
                state: s.state,
                machine: s.machine,
            })
            .collect())
    }
    pub async fn project_view(&self, id: &str, refresh: bool) -> Result<ProjectView> {
        let requested = Instant::now();
        let requested_wall = wall_nanos();
        let mut project = self.project(id)?;
        let path = self.mirror_path(&project.id);
        let lock = project_lock(&path);
        let mut guard = lock.lock().await;
        let _file_guard = mirror_guard(&path).await?;
        project = self.project(&project.id)?;
        let fresh = project.fetched_at.as_deref().and_then(timestamp).is_some_and(|t| unix_now() - t <= FRESH_SECS);
        let recent = std::fs::read(path.with_extension("fetch.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let disk_shared =
            recent.as_ref().and_then(|v| v["completed"].as_str()).and_then(|s| s.parse::<u128>().ok()).is_some_and(|t| t >= requested_wall);
        let shared = guard.completed.is_some_and(|t| t >= requested) || disk_shared;
        if !shared && (refresh || !fresh || !path.join("HEAD").exists()) {
            #[cfg(test)]
            {
                guard.attempts += 1;
            }
            match self.fetch_project(&project).await {
                Ok(()) => {
                    project.fetched_at = Some(now_rfc3339());
                    project.fetch_error = None;
                }
                Err(e) => project.fetch_error = Some(e.message.strip_prefix("取不到汇合点：").unwrap_or(&e.message).to_string()),
            }
            self.store.update_projects(|v| {
                let p = v.iter_mut().find(|p| p.id == project.id).ok_or_else(|| Error::not_found("项目已删除"))?;
                *p = project.clone();
                Ok(())
            })?;
            let record = serde_json::json!({"completed":wall_nanos().to_string(), "fetched_at":project.fetched_at, "fetch_error":project.fetch_error});
            crate::util::atomic_write(&path.with_extension("fetch.json"), &serde_json::to_vec(&record)?, Some(0o600))?;
            guard.completed = Some(Instant::now());
        }
        let members = self.project_members(&project.id)?;
        // 持锁读出完整快照，避免刷新/删除在多条 git 命令之间改掉 refs。
        derive_view(&path, project, members).await
    }
    pub async fn sync_project(self: &Arc<Self>, id: &str) -> Result<ProjectSync> {
        let project = self.project(id)?;
        let members = self.project_members(&project.id)?;
        let mut tasks = tokio::task::JoinSet::new();
        for (index, member) in members.into_iter().enumerate() {
            let Ok(server) = self.server_by_id(&member.server_id) else {
                continue;
            };
            let core = self.clone();
            let home = project.home.clone();
            tasks.spawn(async move {
                let script = format!("export GIT_TERMINAL_PROMPT=0\ncd -- {} || exit 2\nif [ ! -f {} ]; then echo '仓库里还没有 rk.py：先执行 /research:start' >&2; exit 2; fi\nif ! python3 {} sync --help >/dev/null 2>&1; then echo '这台机器上仓库里的 rk.py 是旧版，没有 sync：在那里执行 /research:resume 更新研究工具' >&2; exit 45; fi\npython3 {} sync --json\n",
                    quote_path(&member.workdir), quote(&format!("./{}", repo_path(&home, "tools/rk.py"))), quote(&format!("./{}", repo_path(&home, "tools/rk.py"))), quote(&format!("./{}", repo_path(&home, "tools/rk.py"))));
                let (ok, detail, result) = match core.exec(&server, &script, SYNC_TIMEOUT).await {
                    Ok(out) => {
                        let result = if out.code == 45 { None } else { last_json(&out.text()) };
                        let ok = out.code == 0;
                        let detail = if ok { hook_detail("完成",result.as_ref()) } else { sync_detail(result.as_ref(), &git_error_summary(&out.stderr)) };
                        (ok, detail, result)
                    }
                    Err(e) => (false, e.message, None),
                };
                (index, MemberSync { session_id: member.session_id, server_alias: server.alias, title: member.title, ok, detail, result })
            });
        }
        let mut results = Vec::new();
        while let Some(result) = tasks.join_next().await {
            results.push(result.map_err(|e| Error::internal(format!("同步任务中断：{e}")))?);
        }
        results.sort_by_key(|r| r.0);
        let view = self.project_view(&project.id, true).await?;
        Ok(ProjectSync { members: results.into_iter().map(|r| r.1).collect(), view })
    }
    pub(crate) async fn setup_project(&self, project: &Project, server: &Server, workdir: &str) -> Result<(Option<String>, String)> {
        let address = resolve_hub(&project.hub, &self.store.servers()?, Some(server), &self.project_ssh())?;
        let script = setup_script(project, workdir, &address);
        // 接入脚本整体限时 120 秒，克隆和初次 fetch 不会超过取汇合点的上限。
        setup_result(self.exec(server, &script, GIT_TIMEOUT).await)
    }
}

fn setup_result(result: Result<crate::ssh::RemoteOutput>) -> Result<(Option<String>, String)> {
    let out = result?;
    let text = out.text();
    if out.code != 0 {
        return Err(match out.code {
            41 => Error::bad_request("工作目录不是空的，也不是 git 仓库"),
            42 => Error::conflict("hub 远程已存在，但地址不是项目汇合点").with_hint("先核对仓库的 hub 远程地址，再重新部署"),
            43 => Error::bad_request("汇合点是空的").with_hint("先在一台已有仓库的机器上部署，它会推上研究分支"),
            44 => Error::new(Code::HostUnreachable, format!("取不到汇合点：{}", git_error_summary(&out.stderr))),
            _ => Error::bad_request(format!("接入研究项目失败：{}", git_error_summary(&out.stderr))),
        });
    }
    let identity = if text.lines().any(|l| l == "__BUNSEN_IDENTITY__") { "已设置仓库级 git 提交身份；" } else { "" };
    let (machine, detail) = if text.lines().last() == Some("__BUNSEN_NO_RK__") {
        (None, "仓库里还没有研究目录：/research:start 之后执行 rk sync --setup（研究分支已写进 git config）".into())
    } else if text.lines().last() == Some("__BUNSEN_OLD_RK__") {
        (None, "仓库里的 rk.py 是旧版，没有 sync：在这台机器上执行 /research:resume（会更新研究工具）后再执行 rk sync --setup（研究分支已写进 git config）".into())
    } else {
        let result = last_json(&text);
        let machine = result.as_ref().and_then(|v| v["machine"].as_str()).filter(|s| !s.is_empty()).map(str::to_string);
        let detail = if result.as_ref().is_some_and(|v| v["ok"] == true) {
            hook_detail("已接入研究项目", result.as_ref())
        } else {
            format!("已接入研究项目，同步没完成：{}", sync_detail(result.as_ref(), &git_error_summary(&out.stderr)))
        };
        (machine, detail)
    };
    Ok((machine, format!("{identity}{detail}")))
}

pub(crate) fn last_json(text: &str) -> Option<Value> {
    let mut value = serde_json::from_str::<Value>(text.lines().rfind(|l| !l.trim().is_empty())?).ok().filter(Value::is_object)?;
    crate::error::redact_value(&mut value);
    Some(value)
}
fn hook_detail(prefix: &str, result: Option<&Value>) -> String {
    match result.and_then(|v| v["hook_warning"].as_str()).filter(|s| !s.is_empty()) {
        Some(warning) => format!("{prefix}；{}", git_error_summary(warning)),
        None => prefix.to_string(),
    }
}
fn sync_detail(result: Option<&Value>, fallback: &str) -> String {
    if let Some(v) = result {
        if let Some(files) = v["conflict"].as_array().filter(|a| !a.is_empty()) {
            return redact(&format!("冲突的文件：{}", files.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("、")))
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
        }
        if let Some(error) = v["error"].as_str().filter(|s| !s.is_empty()) {
            return git_error_summary(error);
        }
    }
    if fallback.is_empty() {
        "同步没有返回有效结果，请在仓库里执行 rk sync --setup 后重试".into()
    } else {
        git_error_summary(fallback)
    }
}

fn setup_script(project: &Project, workdir: &str, address: &HubAddress) -> String {
    let ssh_env = address.ssh.as_ref().map(|s| format!("export GIT_SSH_COMMAND={}\n", quote(s))).unwrap_or_default();
    let ssh_config = address.ssh.as_ref().map(|s| format!("git config --local core.sshCommand {}\n", quote(s))).unwrap_or_default();
    format!(
        r#"set -e
export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=file:git:http:https:ssh GIT_LITERAL_PATHSPECS=1
{ssh_env}cd -- {workdir}
url={url}
branch={branch}
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [ -n "$(ls -A)" ]; then exit 41; fi
    refs=$(git ls-remote --heads -- "$url") || exit 44
    if [ -z "$refs" ]; then exit 43; fi
    if printf '%s\n' "$refs" | cut -f2 | grep -Fx -- "refs/heads/$branch" >/dev/null; then
        git clone -q -b "$branch" -- "$url" . || exit 44
    else
        git clone -q -- "$url" . || exit 44
        # 裸仓库的 HEAD 可能还指向已不存在的默认分支。
        if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
            first=$(printf '%s\n' "$refs" | head -n 1 | cut -f2)
            git checkout -q -b "${{first#refs/heads/}}" "refs/remotes/origin/${{first#refs/heads/}}"
        fi
    fi
fi
{ssh_config}remote=''
remotes=$(git remote) || exit 44
for r in $remotes; do
    case "$r" in -*) continue ;; esac
    r_url=$(git remote get-url -- "$r") || exit 44
    if [ "$r_url" = "$url" ]; then remote=$r; break; fi
done
if [ -z "$remote" ]; then
    if git remote get-url hub >/dev/null 2>&1; then exit 42; fi
    git remote add -- hub "$url"
    remote=hub
fi
git fetch -q -- "$remote" || exit 44
if [ -z "$(git config --get user.email || true)" ]; then
    host=$(hostname)
    git config --local user.name "$host (bunsen)"
    git config --local user.email "bunsen@$host.invalid"
    echo __BUNSEN_IDENTITY__
fi
git config --local rk.branch "$branch"
git config --local rk.hub "$remote"
if [ -f {rk} ]; then
    # rk 的冲突/离线不是接入失败；保留最后一行 JSON 和标准错误。
    if python3 {rk} sync --help >/dev/null 2>&1; then
        python3 {rk} sync --setup --json || true
    else
        echo __BUNSEN_OLD_RK__
    fi
else
    echo __BUNSEN_NO_RK__
fi
"#,
        workdir = quote_path(workdir),
        url = address.shell_url(),
        branch = quote(&project.branch),
        rk = quote(&format!("./{}", repo_path(&project.home, "tools/rk.py")))
    )
}

#[derive(Debug)]
struct Branch {
    name: String,
    head: String,
    committed: Option<i64>,
    subject: String,
}
type Tree = BTreeMap<String, String>;

const MAX_PATHS: usize = 20_000;
const MAX_BLOB: usize = 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
type Objects = (BTreeMap<String, Tree>, BTreeMap<String, Vec<u8>>, usize);

/// 单条记录也有界；不能让一个恶意 tree 路径/对象头撑爆 read_until 的缓冲区。
async fn record(reader: &mut (impl tokio::io::AsyncBufRead + Unpin), delim: u8, max: usize) -> Result<Vec<u8>> {
    let mut row = Vec::new();
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            return Ok(row);
        }
        let n = buf.iter().position(|b| *b == delim).map(|n| n + 1).unwrap_or(buf.len());
        if row.len() + n > max {
            return Err(Error::internal("git 对象记录超过长度上限"));
        }
        row.extend_from_slice(&buf[..n]);
        reader.consume(n);
        if row.last() == Some(&delim) {
            return Ok(row);
        }
    }
}

// G23：缓存达到阈值后只追加有序段；finish 才做最多 64 路的分批归并。
struct SkippedPaths {
    pending: BTreeSet<String>,
    bytes: usize,
    max_paths: usize,
    max_bytes: usize,
    dir: Option<PathBuf>,
    runs: Vec<PathBuf>,
    serial: usize,
    #[cfg(test)]
    written: usize,
    #[cfg(test)]
    read: usize,
    #[cfg(test)]
    io_gate: Option<(tokio::sync::oneshot::Sender<PathBuf>, std::sync::mpsc::Receiver<()>)>,
}
impl Default for SkippedPaths {
    fn default() -> Self {
        Self {
            pending: BTreeSet::new(),
            bytes: 0,
            max_paths: MAX_PATHS,
            max_bytes: 1024 * 1024,
            dir: None,
            runs: vec![],
            serial: 0,
            #[cfg(test)]
            written: 0,
            #[cfg(test)]
            read: 0,
            #[cfg(test)]
            io_gate: None,
        }
    }
}
impl SkippedPaths {
    #[cfg(test)]
    fn limits(paths: usize, bytes: usize) -> Self {
        assert!(paths > 0 && bytes > 0);
        {
            let mut state = Self::default();
            state.max_paths = paths;
            state.max_bytes = bytes;
            state
        }
    }
    async fn insert(&mut self, path: &str) -> Result<()> {
        if self.pending.contains(path) {
            return Ok(());
        }
        if !self.pending.is_empty() && (self.pending.len() == self.max_paths || self.bytes + path.len() > self.max_bytes) {
            self.spill().await?;
        }
        if path.len() > self.max_bytes {
            // 单条路径比测试注入的缓存还大时直接写单独段，不让缓存越界。
            let mut state = std::mem::take(self);
            let value = path.to_string();
            let (next, result) = tokio::task::spawn_blocking(move || {
                let result = state.write_run(std::iter::once(value));
                (state, result)
            })
            .await
            .map_err(|e| Error::internal(format!("拒绝路径溢写任务中断：{e}")))?;
            *self = next;
            return result;
        }
        self.pending.insert(path.to_string());
        self.bytes += path.len();
        if self.pending.len() >= self.max_paths || self.bytes >= self.max_bytes {
            self.spill().await?;
        }
        Ok(())
    }
    async fn spill(&mut self) -> Result<()> {
        let mut state = std::mem::take(self);
        let (next, result) = tokio::task::spawn_blocking(move || {
            let values = std::mem::take(&mut state.pending);
            state.bytes = 0;
            let result = if values.is_empty() { Ok(()) } else { state.write_run(values.into_iter()) };
            (state, result)
        })
        .await
        .map_err(|e| Error::internal(format!("拒绝路径溢写任务中断：{e}")))?;
        *self = next;
        result
    }
    fn output_path(&mut self) -> Result<PathBuf> {
        if self.dir.is_none() {
            loop {
                let dir = std::env::temp_dir().join(format!("bunsen-skipped-{}-{}", std::process::id(), short_id()));
                let mut builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                match builder.create(&dir) {
                    Ok(()) => {
                        self.dir = Some(dir);
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e.into()),
                }
            }
        }
        self.serial += 1;
        Ok(self.dir.as_ref().unwrap().join(format!("run-{}", self.serial)))
    }
    fn write_run(&mut self, values: impl Iterator<Item = String>) -> Result<()> {
        use std::io::Write;
        let path = self.output_path()?;
        #[cfg(test)]
        if let Some((entered, release)) = self.io_gate.take() {
            let _ = entered.send(self.dir.as_ref().unwrap().clone());
            release.recv_timeout(Duration::from_secs(5)).map_err(|_| Error::internal("测试溢写等待超时"))?;
        }
        let mut writer = std::io::BufWriter::new(std::fs::File::create_new(&path)?);
        for value in values {
            writer.write_all(value.as_bytes())?;
            writer.write_all(&[0])?;
            #[cfg(test)]
            {
                self.written += 1;
            }
        }
        writer.flush()?;
        self.runs.push(path);
        Ok(())
    }
    fn merge(&mut self, paths: &[PathBuf], pending: BTreeSet<String>, output: Option<&Path>) -> Result<usize> {
        use std::cmp::Reverse;
        use std::collections::BinaryHeap;
        use std::io::{BufRead, BufReader, BufWriter, Write};
        assert!(paths.len() <= 64);
        let mut readers: Vec<_> = paths.iter().map(|p| std::fs::File::open(p).map(BufReader::new)).collect::<std::io::Result<_>>()?;
        let read = |reader: &mut BufReader<std::fs::File>| -> Result<Option<String>> {
            let mut row = Vec::new();
            let n = std::io::Read::take(&mut *reader, 65537).read_until(0, &mut row)?;
            if n == 0 {
                return Ok(None);
            }
            if row.last() != Some(&0) {
                return Err(Error::internal("拒绝路径分段不完整或路径过长"));
            }
            row.pop();
            Ok(Some(String::from_utf8(row).map_err(|_| Error::internal("拒绝路径分段不是 UTF-8"))?))
        };
        let mut heap = BinaryHeap::new();
        for (i, reader) in readers.iter_mut().enumerate() {
            if let Some(path) = read(reader)? {
                heap.push(Reverse((path, i)));
                #[cfg(test)]
                {
                    self.read += 1;
                }
            }
        }
        let memory = readers.len();
        let mut pending = pending.into_iter();
        if let Some(path) = pending.next() {
            heap.push(Reverse((path, memory)));
        }
        let mut writer = output.map(std::fs::File::create_new).transpose()?.map(BufWriter::new);
        let mut last = None;
        let mut count = 0;
        while let Some(Reverse((path, i))) = heap.pop() {
            if last.as_ref() != Some(&path) {
                if let Some(writer) = writer.as_mut() {
                    writer.write_all(path.as_bytes())?;
                    writer.write_all(&[0])?;
                    #[cfg(test)]
                    {
                        self.written += 1;
                    }
                }
                count += 1;
                last = Some(path);
            }
            let next = if i == memory {
                pending.next()
            } else {
                let next = read(&mut readers[i])?;
                #[cfg(test)]
                if next.is_some() {
                    self.read += 1;
                }
                next
            };
            if let Some(path) = next {
                heap.push(Reverse((path, i)));
            }
        }
        if let Some(writer) = writer.as_mut() {
            writer.flush()?;
        }
        Ok(count)
    }
    fn finish_count(&mut self) -> Result<usize> {
        while self.runs.len() > 64 {
            let runs = std::mem::take(&mut self.runs);
            for batch in runs.chunks(64) {
                if batch.len() == 1 {
                    self.runs.push(batch[0].clone());
                    continue;
                }
                let output = self.output_path()?;
                self.merge(batch, BTreeSet::new(), Some(&output))?;
                for old in batch {
                    std::fs::remove_file(old)?;
                }
                self.runs.push(output);
            }
        }
        let runs = std::mem::take(&mut self.runs);
        let pending = std::mem::take(&mut self.pending);
        self.bytes = 0;
        self.merge(&runs, pending, None)
    }
    async fn finish(self) -> Result<usize> {
        tokio::task::spawn_blocking(move || {
            let mut state = self;
            state.finish_count()
        })
        .await
        .map_err(|e| Error::internal(format!("拒绝路径归并任务中断：{e}")))?
    }
}
impl Drop for SkippedPaths {
    fn drop(&mut self) {
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

async fn read_objects(path: &Path, home: &str, branches: &[Branch]) -> Result<Objects> {
    let mut trees = BTreeMap::new();
    let mut hashes = BTreeMap::<String, usize>::new();
    let mut skipped = SkippedPaths::default();
    for branch in branches {
        let tree = git_read(path, &["ls-tree", "-r", "-l", "-z", "--full-tree", &branch.head, "--", home], None, |stdout| async {
            let mut reader = BufReader::new(stdout);
            let mut tree = Tree::new();
            loop {
                let row = record(&mut reader, 0, 65536).await?;
                if row.is_empty() {
                    break;
                }
                let Some(tab) = row.iter().position(|b| *b == b'\t') else {
                    continue;
                };
                let info = String::from_utf8_lossy(&row[..tab]);
                let fields: Vec<_> = info.split_whitespace().collect();
                if fields.len() != 4 || fields[1] != "blob" {
                    continue;
                }
                let Ok(file) = std::str::from_utf8(&row[tab + 1..row.len() - 1]) else {
                    continue;
                };
                let state = file.strip_prefix(&repo_path(home, "state/"));
                let run = file.strip_prefix(&repo_path(home, "runs/")).and_then(|s| s.split_once('/'));
                let body = (branch.name.starts_with("research/") && quality::needed(home, file))
                    || file == repo_path(home, "SUMMARY.md")
                    || state.is_some_and(|s| s.ends_with(".md") && s != "TEMPLATE.md" && !s.contains('/'))
                    || run.is_some_and(|(_, s)| s == "meta.json" || s == "exit_code");
                let metrics = run.is_some_and(|(_, s)| s == "metrics.json");
                // 运行目录存在性独立于正文；即使 meta 过大或本分支只有日志，也用于 integrated。
                if let Some((id, _)) = run {
                    let dir = repo_path(home, &format!("runs/{id}/"));
                    if !tree.contains_key(&dir) {
                        if tree.len() >= MAX_PATHS {
                            skipped.insert(file).await?;
                            continue;
                        }
                        tree.insert(dir, String::new());
                    }
                }
                if !body && !metrics {
                    continue;
                }
                let size = fields[3].parse::<usize>().map_err(|_| Error::internal("git 对象长度不正确"))?;
                if tree.len() >= MAX_PATHS {
                    skipped.insert(file).await?;
                    continue;
                }
                if body {
                    hashes.insert(fields[2].to_string(), size);
                }
                tree.insert(file.to_string(), fields[2].to_string());
            }
            Ok(tree)
        })
        .await?;
        trees.insert(branch.name.clone(), tree);
    }
    let mut blobs = BTreeMap::new();
    if !hashes.is_empty() {
        let (loaded, out) = git_exchange(path, &["cat-file", "--batch"], None, true, |stdin, stdout| async {
            let mut batch = ObjectBatch { input: stdin.unwrap(), reader: BufReader::new(stdout), blobs: BTreeMap::new(), total: 0 };
            let version_path = repo_path(home, "tools/rk.py");
            let mut enabled = BTreeSet::new();
            // 先读取版本，再读取旧视图正文和质量记录，最后只请求没核过的结论正文。
            for (branch, tree) in &mut trees {
                if !branch.starts_with("research/") {
                    continue;
                }
                if let Some(hash) = tree.get(&version_path).cloned() {
                    if batch.load(&hash, hashes[&hash]).await? {
                        if blob_text(tree, &batch.blobs, &version_path)
                            .and_then(crate::research_quality::rk_version)
                            .as_deref()
                            .is_some_and(crate::research_quality::quality_version)
                        {
                            enabled.insert(branch.clone());
                        }
                    } else {
                        skipped.insert(&version_path).await?;
                        tree.remove(&version_path);
                    }
                }
            }
            for (branch, tree) in &mut trees {
                let paths: Vec<_> = tree.keys().cloned().collect();
                for file in paths {
                    // metrics 只看存在性；即使与某个未读取的质量记录共用 blob，也不能请求正文。
                    let metrics = file
                        .strip_prefix(&repo_path(home, "runs/"))
                        .and_then(|s| s.split_once('/'))
                        .is_some_and(|(_, name)| name == "metrics.json");
                    if metrics {
                        continue;
                    }
                    let hash = &tree[&file];
                    let Some(&size) = hashes.get(hash) else { continue };
                    let quality_only = quality::needed(home, &file) && file != repo_path(home, "SUMMARY.md");
                    if file == version_path || (quality_only && (!enabled.contains(branch) || quality::conclusion(home, &file))) {
                        continue;
                    }
                    if !batch.load(hash, size).await? {
                        skipped.insert(&file).await?;
                        tree.remove(&file);
                    }
                }
            }
            for (branch, tree) in &mut trees {
                if !enabled.contains(branch) {
                    continue;
                }
                let reviewed = quality::reviewed_paths(home, tree, &batch.blobs);
                let paths: Vec<_> = tree.keys().filter(|f| quality::conclusion(home, f) && !reviewed.contains(*f)).cloned().collect();
                for file in paths {
                    let hash = &tree[&file];
                    if !batch.load(hash, hashes[hash]).await? {
                        skipped.insert(&file).await?;
                        tree.remove(&file);
                    }
                }
            }
            batch.input.shutdown().await?;
            Ok(batch.blobs)
        })
        .await?;
        if !out.status.success() {
            return Err(git_error(&out));
        }
        blobs = loaded;
    }
    Ok((trees, blobs, skipped.finish().await?))
}

struct ObjectBatch {
    input: tokio::process::ChildStdin,
    reader: BufReader<tokio::process::ChildStdout>,
    blobs: BTreeMap<String, Vec<u8>>,
    total: usize,
}
impl ObjectBatch {
    async fn load(&mut self, hash: &str, expected: usize) -> Result<bool> {
        if self.blobs.contains_key(hash) {
            return Ok(true);
        }
        if expected > MAX_BLOB || self.total + expected > MAX_TOTAL {
            return Ok(false);
        }
        self.input.write_all(format!("{hash}\n").as_bytes()).await?;
        let header = record(&mut self.reader, b'\n', 256).await?;
        let header = String::from_utf8_lossy(&header);
        let fields: Vec<_> = header.split_whitespace().collect();
        let size = fields.get(2).and_then(|s| s.parse::<usize>().ok()).ok_or_else(|| Error::internal("git 对象长度不正确"))?;
        if fields.first() != Some(&hash) || fields.get(1) != Some(&"blob") || size != expected {
            return Err(Error::internal("git 对象头与 tree 不一致"));
        }
        let mut data = vec![0; size];
        self.reader.read_exact(&mut data).await?;
        if self.reader.read_u8().await? != b'\n' {
            return Err(Error::internal("git 对象内容不完整"));
        }
        self.total += size;
        self.blobs.insert(hash.to_string(), data);
        Ok(true)
    }
}

async fn derive_view(path: &Path, mut project: Project, members: Vec<ProjectMember>) -> Result<ProjectView> {
    project.fetch_error = project.fetch_error.map(|s| git_error_summary(&s));
    let refs = if path.join("HEAD").exists() {
        git_ok(
            path,
            &["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)%00%(committerdate:unix)%00%(subject)", "refs/heads/"],
            None,
        )
        .await?
    } else {
        String::new()
    };
    let branches: Vec<_> = refs
        .lines()
        .filter_map(|l| {
            let f: Vec<_> = l.splitn(4, '\0').collect();
            if f.len() != 4 || (f[0] != project.branch && !f[0].starts_with("sync/")) {
                return None;
            }
            Some(Branch { name: f[0].into(), head: f[1].into(), committed: f[2].parse().ok(), subject: f[3].into() })
        })
        .collect();
    let research_head = branches.iter().find(|b| b.name == project.branch).map(|b| b.head.clone());
    let mut machines = Vec::new();
    for branch in branches.iter().filter(|b| b.name.starts_with("sync/")) {
        let (ahead, behind) = if let Some(head) = &research_head {
            let counts = git_ok(path, &["rev-list", "--left-right", "--count", &format!("{head}...{}", branch.head)], None).await?;
            let counts: Vec<u32> = counts.split_whitespace().filter_map(|s| s.parse().ok()).collect();
            if counts.len() != 2 {
                return Err(Error::internal("git 提交计数不正确"));
            }
            (counts[1], counts[0])
        } else {
            let count = git_ok(path, &["rev-list", "--count", &branch.head], None).await?;
            (count.trim().parse().map_err(|_| Error::internal("git 提交计数不正确"))?, 0)
        };
        let conflict = if ahead > 0 && behind > 0 {
            match git(path, &["merge-tree", "--write-tree", "--quiet", research_head.as_deref().unwrap(), &branch.head], None, None).await {
                Ok(out) => match out.status.code() {
                    Some(0) => Some(false),
                    Some(1) => Some(true),
                    _ => None,
                },
                Err(_) => None,
            }
        } else {
            None
        };
        let code = branch.name.strip_prefix("sync/").unwrap();
        let matching: Vec<_> = members.iter().filter(|s| s.machine.as_deref() == Some(code)).collect();
        machines.push(ProjectMachine {
            code: code.into(),
            head: branch.head.clone(),
            committed_at: branch.committed.map(rfc3339_from_unix),
            subject: branch.subject.clone(),
            ahead,
            behind,
            conflict,
            sessions: matching.iter().map(|s| s.session_id.clone()).collect(),
            server_alias: matching.first().map(|s| s.server_alias.clone()),
        });
    }
    machines.sort_by(|a, b| a.code.cmp(&b.code));
    let (trees, blobs, skipped) = read_objects(path, &project.home, &branches).await?;
    let (mut lines, runs, decisions) = derive_records(&project, &trees, &blobs);
    let trust = quality::derive(&project, &trees, &blobs, &mut lines);
    let mut warnings = Vec::new();
    if let Some(error) = &project.fetch_error {
        warnings.push(match project.fetched_at.as_deref() {
            Some(at) => format!("取不到汇合点：{error}，显示的是 {} 的内容", fetched_time(Some(at))),
            None => format!("取不到汇合点：{error}，还没有成功取得过汇合点"),
        });
    }
    if research_head.is_none() {
        warnings.push(format!("汇合点上还没有 {}：在一台机器上部署接入本项目，或在仓库里执行 rk sync --setup", project.branch));
    }
    for machine in machines.iter().filter(|m| m.conflict == Some(true)) {
        warnings.push(format!("{} 的记录并入 {} 会冲突，要在那台机器上解决（rk sync 会列出冲突的文件）", machine.code, project.branch));
    }
    for machine in &machines {
        if let Some(age) = machine.committed_at.as_deref().and_then(timestamp).map(|t| unix_now() - t) {
            if machine.behind > 0 && age > 24 * 3600 {
                warnings.push(format!("{} 已经 {} 小时没有同步", machine.code, age / 3600));
            }
        }
    }
    for member in members.iter().filter(|s| s.machine.is_none()) {
        warnings.push(format!("会话 {} 还没有机器代号：仓库里有研究目录后在那里执行 rk sync --setup", member.title));
    }
    if let Some(trust) = &trust {
        quality::warnings(trust, &mut warnings);
    }
    if skipped > 0 {
        warnings.push(format!("汇合点里有 {skipped} 个文件过大或过多，没有读入视图"));
    }
    Ok(ProjectView {
        trust,
        project,
        research_head,
        machines,
        lines,
        runs,
        members,
        decisions,
        warnings: warnings.into_iter().map(|s| redact(&s)).collect(),
    })
}

fn fetched_time(value: Option<&str>) -> String {
    value
        .and_then(timestamp)
        .map(|secs| {
            let utc = rfc3339_from_unix(secs);
            format!("{} {} UTC", &utc[..10], &utc[11..16])
        })
        .unwrap_or_else(|| "尚未成功取得".into())
}

fn blob_text<'a>(tree: &Tree, blobs: &'a BTreeMap<String, Vec<u8>>, file: &str) -> Option<&'a str> {
    std::str::from_utf8(blobs.get(tree.get(file)?)?).ok()
}
fn derive_records(
    project: &Project,
    trees: &BTreeMap<String, Tree>,
    blobs: &BTreeMap<String, Vec<u8>>,
) -> (Vec<ProjectLine>, Vec<ProjectRun>, Option<String>) {
    let mut lines: BTreeMap<String, ProjectLine> = BTreeMap::new();
    let mut runs: BTreeMap<String, (bool, ProjectRun)> = BTreeMap::new();
    let state_prefix = repo_path(&project.home, "state/");
    let run_prefix = repo_path(&project.home, "runs/");
    let integrated: BTreeSet<_> = trees
        .get(&project.branch)
        .into_iter()
        .flat_map(|t| t.keys())
        .filter_map(|p| p.strip_prefix(&run_prefix)?.split_once('/').map(|p| p.0.to_string()))
        .collect();
    for (source, tree) in trees {
        for file in tree.keys() {
            if let Some(line) =
                file.strip_prefix(&state_prefix).and_then(|s| s.strip_suffix(".md")).filter(|s| *s != "TEMPLATE" && !s.contains('/'))
            {
                if let Some(text) = blob_text(tree, blobs, file) {
                    let new = parse_line(line, source, text);
                    if lines.get(line).is_none_or(|old| line_rank(&new) > line_rank(old)) {
                        lines.insert(line.to_string(), new);
                    }
                }
            }
            if let Some(id) = file.strip_prefix(&run_prefix).and_then(|s| s.strip_suffix("/meta.json")).filter(|s| !s.contains('/')) {
                let Some(meta) = blob_text(tree, blobs, file).and_then(|s| serde_json::from_str::<Value>(s).ok()).filter(Value::is_object)
                else {
                    continue;
                };
                let dir = format!("{run_prefix}{id}");
                let exit = blob_text(tree, blobs, &format!("{dir}/exit_code"))
                    .and_then(|s| s.trim().parse::<i64>().ok())
                    .or_else(|| meta["exit_code"].as_i64());
                let finished = tree.contains_key(&format!("{dir}/exit_code")) || meta.get("exit_code").is_some_and(|v| !v.is_null());
                let new = ProjectRun {
                    run_id: id.into(),
                    machine: json_string(&meta, "machine_name"),
                    kind: json_string(&meta, "kind").unwrap_or_default(),
                    state: match exit {
                        Some(0) => "ok",
                        Some(_) => "failed",
                        None => "open",
                    }
                    .into(),
                    exit_code: exit,
                    started_at: json_string(&meta, "started_at"),
                    ended_at: json_string(&meta, "ended_at"),
                    line: json_string(&meta, "line"),
                    note: json_string(&meta, "note").unwrap_or_default(),
                    has_metrics: tree.contains_key(&format!("{dir}/metrics.json")),
                    integrated: integrated.contains(id),
                    source: source.clone(),
                };
                if runs.get(id).is_none_or(|(done, old)| (finished, source == &project.branch) > (*done, old.source == project.branch)) {
                    runs.insert(id.to_string(), (finished, new));
                }
            }
        }
    }
    let mut runs: Vec<_> = runs.into_values().map(|(_, run)| run).collect();
    runs.sort_by(|a, b| {
        b.started_at.as_deref().and_then(time_key).cmp(&a.started_at.as_deref().and_then(time_key)).then(a.run_id.cmp(&b.run_id))
    });
    runs.truncate(500);
    let decisions = trees
        .get(&project.branch)
        .and_then(|t| blob_text(t, blobs, &repo_path(&project.home, "SUMMARY.md")))
        .and_then(|s| section(s, "需要你决定"))
        .and_then(decisions_text);
    (lines.into_values().collect(), runs, decisions)
}
fn list_content(line: &str) -> &str {
    let line = line.trim();
    if let Some(rest) = line.strip_prefix(['-', '*', '+']).filter(|s| s.starts_with(char::is_whitespace)) {
        return rest.trim();
    }
    if let Some((number, rest)) = line.split_once('.') {
        if !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) && rest.starts_with(char::is_whitespace) {
            return rest.trim();
        }
    }
    line
}
fn is_template_placeholder(text: &str) -> bool {
    let content = list_content(text);
    content.starts_with('<') && content.ends_with('>')
}
fn decisions_text(text: &str) -> Option<String> {
    let lines: Vec<_> = text.lines().filter(|line| !is_template_placeholder(line)).collect();
    let result = lines.join("\n").trim().to_string();
    if result.is_empty()
        || lines.iter().all(|line| {
            let c = list_content(line);
            c.is_empty() || c == "无"
        })
    {
        None
    } else {
        Some(result)
    }
}

fn json_string(meta: &Value, key: &str) -> Option<String> {
    meta[key].as_str().filter(|s| !s.is_empty()).map(str::to_string)
}
fn line_rank(line: &ProjectLine) -> (u64, bool, Option<(i64, &str)>, Option<&str>) {
    (
        line.token,
        line.holder.as_ref().is_some_and(|h| line.source == format!("sync/{h}")),
        line.stamped.as_deref().and_then(time_key),
        line.stamped.as_deref(),
    )
}
fn parse_line(line: &str, source: &str, text: &str) -> ProjectLine {
    let normalized = text.replace("\r\n", "\n");
    let (front, body) = normalized.strip_prefix("---\n").and_then(|s| s.split_once("\n---\n")).unwrap_or(("", &normalized));
    let front: BTreeMap<_, _> = front.lines().filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim(), v.trim())).collect();
    let field = |key: &str| front.get(key).filter(|s| !s.is_empty() && **s != "-").map(|s| s.to_string());
    let body_field = |key: &str| {
        body.lines().find_map(|l| {
            let (_, value) = l.split_once(&format!("**{key}**"))?;
            value.trim_start().strip_prefix([':', '：']).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
        })
    };
    let next = section_where(body, |level, title| level == 2 && title.trim().starts_with("下一步"))
        .into_iter()
        .flat_map(str::lines)
        .map(str::trim_start)
        .filter(|l| {
            if let Some(rest) = l.strip_prefix(['-', '*', '+']) {
                return rest.starts_with(char::is_whitespace) && !rest.trim().is_empty();
            }
            l.split_once('.').is_some_and(|(n, rest)| {
                !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && rest.starts_with(char::is_whitespace) && !rest.trim().is_empty()
            })
        })
        .filter(|line| !is_template_placeholder(line))
        .take(3)
        .map(str::to_string)
        .collect();
    ProjectLine {
        open_fails: None,
        unreviewed: None,
        line: line.into(),
        holder: field("holder"),
        token: field("token").and_then(|v| v.parse().ok()).unwrap_or(0),
        stamped: field("stamped"),
        stage: body_field("阶段").filter(|v| !is_template_placeholder(v)),
        waiting: body_field("在等什么").filter(|v| !is_template_placeholder(v)),
        updated: body_field("最后更新"),
        next,
        source: source.into(),
    }
}
/// 取标题所在节，子节仍属正文，到同级或更高级标题结束；忽略代码围栏内的标题。
fn section<'a>(text: &'a str, title: &str) -> Option<&'a str> {
    section_where(text, |_, heading| heading.contains(title))
}
fn section_where(text: &str, matches: impl Fn(usize, &str) -> bool) -> Option<&str> {
    let mut offset = 0;
    let mut start = None;
    let mut level = 0;
    let mut fence: Option<char> = None;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let c = trimmed.chars().next().unwrap();
            if fence == Some(c) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(c);
            }
        } else if fence.is_none() {
            let n = line.bytes().take_while(|b| *b == b'#').count();
            if (1..=6).contains(&n) && line[n..].starts_with(char::is_whitespace) {
                if let Some(start) = start {
                    if n <= level {
                        return Some(&text[start..offset]);
                    }
                } else if matches(n, &line[n..]) {
                    start = Some(offset + line.len());
                    level = n;
                }
            }
        }
        offset += line.len();
    }
    start.map(|s| &text[s..])
}

fn time_key(s: &str) -> Option<(i64, &str)> {
    let secs = timestamp(s)?;
    let fraction = s
        .get(19..)
        .and_then(|s| s.strip_prefix('.'))
        .map(|s| {
            let n = s.bytes().take_while(u8::is_ascii_digit).count();
            s[..n].trim_end_matches('0')
        })
        .unwrap_or("");
    Some((secs, fraction))
}

/// RFC 3339 → Unix 秒；无需为缓存新鲜度与时区排序增加依赖。
fn timestamp(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| std::str::from_utf8(b.get(a..z)?).ok()?.parse::<i64>().ok();
    let (year, month, day, hour, minute, second) = (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&month) || day < 1 || day > days[(month - 1) as usize] || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut pos = 19;
    if b.get(pos) == Some(&b'.') {
        pos += 1;
        let first = pos;
        while b.get(pos).is_some_and(u8::is_ascii_digit) {
            pos += 1;
        }
        if pos == first {
            return None;
        }
    }
    let offset = match b.get(pos)? {
        b'Z' | b'z' if pos + 1 == b.len() => 0,
        sign @ (b'+' | b'-') if pos + 6 == b.len() && b[pos + 3] == b':' => {
            let (h, m) = (num(pos + 1, pos + 3)?, num(pos + 4, pos + 6)?);
            if h > 23 || m > 59 {
                return None;
            }
            (h * 3600 + m * 60) * if *sign == b'+' { 1 } else { -1 }
        }
        _ => return None,
    };
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400 + hour * 3600 + minute * 60 + second - offset)
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
