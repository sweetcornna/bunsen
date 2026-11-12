//! Core：全部能力的入口。本机服务、命令行、MCP 都只调这里。
//! 这个文件放设置、Agent、服务器、密钥、导入、测试连接、探测；会话在 sessions.rs，工作区在 workspace.rs。

use crate::agents;
use crate::error::{Code, Error, Result};
use crate::import::{self, Kind, Upload};
use crate::keys;
use crate::model::*;
use crate::probe;
use crate::shell::{quote, PATH_PRELUDE, TMUX};
use crate::ssh::{only_key_args, Ssh};
use crate::sshconfig::{self, identity_basename, validate_alias, validate_single_line, validate_word};
use crate::store::{Paths, Store};
use crate::tmux;
use crate::util::{now_rfc3339, short_id};
use std::sync::Arc;
use std::time::Duration;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct Core {
    pub store: Store,
    pub ssh: Ssh,
}

pub(crate) const TEST_TIMEOUT: Duration = Duration::from_secs(25);
pub(crate) const OP_TIMEOUT: Duration = Duration::from_secs(40);
pub const HOST_NOTES_MAX: usize = 256 * 1024;

pub fn target(sv: &Server) -> String {
    format!("op-{}", sv.id)
}

impl Core {
    /// 按环境变量（`BUNSEN_DATA_DIR`、`BUNSEN_CM_DIR`）打开数据目录。
    pub fn open() -> Result<Arc<Core>> {
        Self::open_at(Paths::from_env()?)
    }

    pub fn open_at(paths: Paths) -> Result<Arc<Core>> {
        let ssh = Ssh::new(paths.ssh_config());
        let store = Store::open(paths)?;
        let core = Core { store, ssh };
        core.regen_ssh_config()?;
        Ok(Arc::new(core))
    }

    pub fn paths(&self) -> &Paths {
        &self.store.paths
    }

    /// 由服务器记录重写 `ssh/config`。
    pub fn regen_ssh_config(&self) -> Result<()> {
        let servers = self.store.servers()?;
        let p = self.paths();
        let text = sshconfig::render(&servers, &p.keys_dir(), &p.known_hosts(), &p.cm_dir);
        self.store.write_ssh_config(&text)
    }

    // ---------- 设置 ----------

    pub fn settings(&self) -> Result<Settings> {
        self.store.settings()
    }

    pub fn put_settings(&self, s: Settings) -> Result<Settings> {
        if s.status_interval_secs == 0 {
            return Err(Error::bad_request("status_interval_secs 必须大于 0"));
        }
        let s = Settings {
            research_plugin_path: s.research_plugin_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()),
            plugin_paths: s.plugin_paths.iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect(),
            ..s
        };
        self.store.put_settings(&s)?;
        Ok(s)
    }

    // ---------- 插件（v1.2）----------

    /// 全部可用插件：内嵌的在前，然后是本机目录（同名覆盖内嵌的）。
    pub fn plugins(&self) -> Result<Vec<Plugin>> {
        let mut w = Vec::new();
        Ok(crate::plugins::available(&self.settings()?, &mut w).into_iter().map(|a| a.info).collect())
    }

    // ---------- Agent ----------

    pub fn agents(&self) -> Result<Vec<Agent>> {
        Ok(agents::merge(&self.store.custom_agents()?))
    }

    pub fn agent(&self, id: &str) -> Result<Agent> {
        self.agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or_else(|| Error::not_found(format!("没有 id 为 {id} 的 Agent")))
    }

    pub fn put_agent(&self, id: &str, a: Agent) -> Result<Agent> {
        let a = agents::validate(id, a)?;
        let saved = a.clone();
        self.store.update_agents(|v| {
            match v.iter_mut().find(|x| x.id == saved.id) {
                Some(x) => *x = saved.clone(),
                None => v.push(saved.clone()),
            }
            Ok(())
        })?;
        Ok(a)
    }

    /// 删除自定义项；内置项则还原为默认。
    pub fn delete_agent(&self, id: &str) -> Result<()> {
        let builtin = agents::is_builtin(id);
        self.store.update_agents(|v| {
            let before = v.len();
            v.retain(|a| a.id != id);
            if before == v.len() && !builtin {
                return Err(Error::not_found(format!("没有 id 为 {id} 的自定义 Agent")));
            }
            Ok(())
        })
    }

    // ---------- 服务器 ----------

    pub fn servers(&self) -> Result<Vec<Server>> {
        self.store.servers()
    }

    /// 按 id 或别名找服务器。
    pub fn server(&self, key: &str) -> Result<Server> {
        let v = self.store.servers()?;
        v.iter()
            .find(|s| s.id == key)
            .or_else(|| v.iter().find(|s| s.alias == key))
            .cloned()
            .ok_or_else(|| Error::not_found(format!("没有找到服务器 {key}")))
    }

    fn check_key_exists(&self, key: &Option<String>) -> Result<()> {
        if let Some(k) = key {
            if !keys::valid_key_name(k) || !self.paths().keys_dir().join(k).is_file() {
                return Err(Error::bad_request(format!("没有名为 {k} 的私钥")).with_hint("先在“导入”里上传这把私钥"));
            }
        }
        Ok(())
    }

    fn check_server_fields(alias: &str, host: &str, user: &str, pj: &Option<String>, pc: &Option<String>) -> Result<()> {
        validate_alias(alias)?;
        validate_word("主机地址", host)?;
        validate_word("用户名", user)?;
        if let Some(j) = pj {
            validate_word("ProxyJump", j)?;
        }
        if let Some(c) = pc {
            validate_single_line("ProxyCommand", c)?;
        }
        Ok(())
    }

    pub fn add_server(&self, n: NewServer) -> Result<Server> {
        let alias = n.alias.trim().to_string();
        let host = n.host.trim().to_string();
        let user = n.user.trim().to_string();
        let norm = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let key = norm(n.key);
        let pj = norm(n.proxy_jump);
        let pc = norm(n.proxy_command);
        Self::check_server_fields(&alias, &host, &user, &pj, &pc)?;
        self.check_key_exists(&key)?;
        let sv = self.store.update_servers(|v| {
            if v.iter().any(|s| s.alias == alias) {
                return Err(Error::conflict(format!("别名 {alias} 已存在")).with_hint("换一个别名，或直接修改那台服务器"));
            }
            let mut id = short_id();
            while v.iter().any(|s| s.id == id) {
                id = short_id();
            }
            let sv = Server {
                id,
                alias: alias.clone(),
                host,
                user,
                port: n.port.unwrap_or(22),
                key,
                proxy_jump: pj,
                proxy_command: pc,
                source: ServerSource::Manual,
                note: n.note.unwrap_or_default(),
                default_workdir: norm(n.default_workdir).unwrap_or_else(|| "~".into()),
                status: ServerStatus::Unknown,
                status_detail: None,
                last_checked: None,
                probe: None,
            };
            v.push(sv.clone());
            Ok(sv)
        })?;
        self.regen_ssh_config()?;
        Ok(sv)
    }

    pub async fn patch_server(&self, key: &str, p: ServerPatch) -> Result<Server> {
        let cur = self.server(key)?;
        let norm = |v: String| v.trim().to_string();
        let norm_opt = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let mut next = cur.clone();
        if let Some(a) = p.alias {
            next.alias = norm(a);
        }
        if let Some(h) = p.host {
            next.host = norm(h);
        }
        if let Some(u) = p.user {
            next.user = norm(u);
        }
        if let Some(port) = p.port {
            next.port = port;
        }
        if let Some(k) = p.key {
            next.key = norm_opt(k);
        }
        if let Some(j) = p.proxy_jump {
            next.proxy_jump = norm_opt(j);
        }
        if let Some(c) = p.proxy_command {
            next.proxy_command = norm_opt(c);
        }
        if let Some(n) = p.note {
            next.note = n;
        }
        if let Some(w) = p.default_workdir {
            next.default_workdir = norm_opt(Some(w)).unwrap_or_else(|| "~".into());
        }
        Self::check_server_fields(&next.alias, &next.host, &next.user, &next.proxy_jump, &next.proxy_command)?;
        self.check_key_exists(&next.key)?;
        let conn_changed = (&cur.host, &cur.user, cur.port, &cur.key, &cur.proxy_jump, &cur.proxy_command)
            != (&next.host, &next.user, next.port, &next.key, &next.proxy_jump, &next.proxy_command);
        if conn_changed {
            next.status = ServerStatus::Unknown;
            next.status_detail = None;
        }
        let saved = next.clone();
        self.store.update_servers(|v| {
            if v.iter().any(|s| s.alias == saved.alias && s.id != saved.id) {
                return Err(Error::conflict(format!("别名 {} 已存在", saved.alias)));
            }
            let s = v.iter_mut().find(|s| s.id == saved.id).ok_or_else(|| Error::not_found("服务器已被删除"))?;
            *s = saved.clone();
            Ok(())
        })?;
        if cur.alias != next.alias {
            self.store.update_sessions(|v| {
                for r in v.iter_mut().filter(|r| r.session.server_id == next.id) {
                    r.session.server_alias = next.alias.clone();
                }
                Ok(())
            })?;
        }
        self.regen_ssh_config()?;
        if conn_changed {
            // 旧的 ControlMaster 还按旧参数连着，关掉它。
            self.ssh.close_master(&target(&cur)).await;
        }
        Ok(next)
    }

    pub async fn delete_server(&self, key: &str) -> Result<()> {
        let sv = self.server(key)?;
        let live: Vec<String> = self
            .store
            .sessions()?
            .iter()
            .filter(|r| r.session.server_id == sv.id && !r.session.archived)
            .map(|r| r.session.id.clone())
            .collect();
        if !live.is_empty() {
            return Err(Error::conflict(format!("服务器 {} 上还有 {} 个未归档的会话", sv.alias, live.len()))
                .with_hint("先停止并删除或归档这些会话"));
        }
        self.ssh.close_master(&target(&sv)).await;
        self.store.update_servers(|v| {
            v.retain(|s| s.id != sv.id);
            Ok(())
        })?;
        self.regen_ssh_config()
    }

    fn set_status(&self, id: &str, f: impl FnOnce(&mut Server)) -> Result<Server> {
        self.store.update_servers(|v| {
            let s = v.iter_mut().find(|s| s.id == id).ok_or_else(|| Error::not_found("服务器已被删除"))?;
            f(s);
            Ok(s.clone())
        })
    }

    /// 根据一次连接的结果更新服务器状态。
    pub(crate) fn record_conn(&self, id: &str, r: &std::result::Result<(), Error>) -> Result<Server> {
        let now = now_rfc3339();
        self.set_status(id, |s| {
            s.last_checked = Some(now);
            match r {
                Ok(()) => {
                    s.status = ServerStatus::Online;
                    s.status_detail = None;
                }
                Err(e) => {
                    s.status = if e.code == Code::AuthFailed { ServerStatus::AuthFailed } else { ServerStatus::Offline };
                    s.status_detail = Some(match &e.hint {
                        Some(h) => format!("{}。{}", e.message, h),
                        None => e.message.clone(),
                    });
                }
            }
        })
    }

    async fn try_connect(&self, sv: &Server, key: Option<&str>) -> Result<Duration> {
        let extra = key.map(|k| only_key_args(&self.paths().keys_dir().join(k))).unwrap_or_default();
        let out = self.ssh.run_with(&target(sv), "echo __OP_OK__", TEST_TIMEOUT, &extra).await?;
        if out.text().contains("__OP_OK__") {
            Ok(out.elapsed)
        } else {
            Err(Error::new(Code::SshFailed, format!("连上了，但远程 shell 没有正常执行命令：{}", out.err_line()))
                .with_hint("检查服务器上的登录 shell 配置（例如 .bashrc 里有交互式命令）"))
        }
    }

    /// 测试连接。`try_all_keys` 时逐把尝试已保存的私钥，把能用的记到服务器上。
    pub async fn test_server(&self, key: &str, try_all_keys: bool) -> Result<TestResult> {
        let sv = self.server(key)?;
        let saved_keys = keys::list_names(&self.paths().keys_dir())?;
        // 尝试顺序：None 表示“按当前配置”。
        let mut attempts: Vec<Option<String>> = Vec::new();
        if sv.key.is_some() || !try_all_keys {
            attempts.push(None);
        }
        if try_all_keys {
            attempts.extend(saved_keys.iter().filter(|k| Some(*k) != sv.key.as_ref()).map(|k| Some(k.clone())));
            if sv.key.is_none() {
                attempts.push(None);
            }
        }
        let mut first_err: Option<Error> = None;
        let mut success: Option<(Duration, Option<String>)> = None;
        for a in &attempts {
            match self.try_connect(&sv, a.as_deref()).await {
                Ok(d) => {
                    success = Some((d, a.clone()));
                    break;
                }
                Err(e) => {
                    let fatal = matches!(e.code, Code::HostUnreachable | Code::Timeout);
                    if first_err.is_none() || (first_err.as_ref().unwrap().code != Code::AuthFailed && e.code == Code::AuthFailed) {
                        first_err = Some(e);
                    }
                    if fatal {
                        break; // 网络不通，换钥也没用
                    }
                }
            }
        }
        match success {
            Some((d, found)) => {
                if let Some(k) = &found {
                    let k = k.clone();
                    self.set_status(&sv.id, |s| s.key = Some(k))?;
                    self.regen_ssh_config()?;
                }
                let server = self.record_conn(&sv.id, &Ok(()))?;
                Ok(TestResult { ok: true, latency_ms: Some(d.as_millis() as u64), key_used: server.key.clone(), server })
            }
            None => {
                let e = first_err.unwrap_or_else(|| Error::new(Code::SshFailed, "没有可尝试的密钥"));
                let server = self.record_conn(&sv.id, &Err(e))?;
                Ok(TestResult { ok: false, latency_ms: None, key_used: None, server })
            }
        }
    }

    /// 探测并保存。连不上时返回对应错误（同时更新服务器状态）。
    pub async fn probe_server(&self, key: &str) -> Result<Server> {
        let sv = self.server(key)?;
        let agents = self.agents()?;
        let script = probe::probe_script(&agents);
        let out = match self.ssh.run(&target(&sv), &script, Duration::from_secs(60)).await {
            Ok(o) => o,
            Err(e) => {
                let _ = self.record_conn(&sv.id, &Err(e.clone()));
                return Err(e);
            }
        };
        let p = probe::parse_probe(&out.text(), &agents);
        if p.home.is_empty() && p.os.is_empty() {
            let e = Error::new(Code::SshFailed, format!("探测没有拿到结果：{}", out.err_line()));
            return Err(e);
        }
        self.record_conn(&sv.id, &Ok(()))?;
        // 主机笔记初稿：文件不存在时才写，之后不再自动覆盖；失败不影响探测结果。
        let draft = probe::host_notes_draft(&p, &agents);
        let script = format!(
            "mkdir -p \"$HOME/.bunsen\" || exit 0\nif [ ! -e \"$HOME/.bunsen/HOST.md\" ]; then printf '%s' {} > \"$HOME/.bunsen/.HOST.md.tmp\" && mv \"$HOME/.bunsen/.HOST.md.tmp\" \"$HOME/.bunsen/HOST.md\"; fi\n",
            quote(&draft)
        );
        let _ = self.ssh.run(&target(&sv), &script, OP_TIMEOUT).await;
        self.set_status(&sv.id, |s| s.probe = Some(p))
    }

    // ---------- 主机笔记（v1.1）----------

    pub async fn host_notes(&self, key: &str) -> Result<HostNotes> {
        let sv = self.server(key)?;
        let script = "if [ -f \"$HOME/.bunsen/HOST.md\" ]; then echo __OP_YES__; head -c 262144 \"$HOME/.bunsen/HOST.md\"; else echo __OP_NO__; fi\n";
        let out = self.ssh.run(&target(&sv), script, OP_TIMEOUT).await?;
        let raw = String::from_utf8_lossy(&out.stdout).into_owned();
        if let Some(text) = raw.strip_prefix("__OP_YES__\n") {
            return Ok(HostNotes { text: text.to_string(), exists: true });
        }
        if raw.starts_with("__OP_NO__") {
            return Ok(HostNotes { text: String::new(), exists: false });
        }
        Err(Error::new(Code::SshFailed, format!("读取主机笔记失败：{}", out.err_line())))
    }

    pub async fn set_host_notes(&self, key: &str, text: &str) -> Result<HostNotes> {
        if text.len() > HOST_NOTES_MAX {
            return Err(Error::bad_request("主机笔记超过 256 KB"));
        }
        let sv = self.server(key)?;
        let script = format!(
            "mkdir -p \"$HOME/.bunsen\" && printf '%s' {} > \"$HOME/.bunsen/.HOST.md.tmp\" && mv \"$HOME/.bunsen/.HOST.md.tmp\" \"$HOME/.bunsen/HOST.md\" && echo __OP_DONE__\n",
            quote(text)
        );
        let out = self.ssh.run(&target(&sv), &script, OP_TIMEOUT).await?;
        if !out.text().contains("__OP_DONE__") {
            return Err(Error::new(Code::SshFailed, format!("写入主机笔记失败：{}", out.err_line())));
        }
        Ok(HostNotes { text: text.to_string(), exists: true })
    }

    pub async fn gpus(&self, key: &str) -> Result<Vec<Gpu>> {
        let sv = self.server(key)?;
        let out = self.ssh.run(&target(&sv), &probe::gpu_script(), Duration::from_secs(30)).await?;
        Ok(probe::parse_gpus(&out.text()))
    }

    /// 在服务器的 tmux 里启动安装任务 `op-install-<agent_id>`，返回 tmux 会话名。
    pub async fn install_agent(&self, key: &str, agent_id: &str, method: Option<usize>) -> Result<String> {
        let sv = self.server(key)?;
        let agent = self.agent(agent_id)?;
        if agent.install.is_empty() {
            return Err(Error::bad_request(format!("{} 不需要安装", agent.name)));
        }
        let m = method.unwrap_or(0);
        let inst = agent
            .install
            .get(m)
            .ok_or_else(|| Error::bad_request(format!("{} 没有第 {} 种安装方式", agent.name, m)))?;
        let name = tmux::install_session(&agent.id);
        // 安装结束后留一个 shell（可以接着登录代理）。不让窗格直接死掉：
        // tmux 把 “Pane is dead” 写在最底行，客户端窗口比 50 行小时前面的输出会被推进历史里，看起来一片空白。
        let inner = format!(
            "{PATH_PRELUDE}; cd \"$HOME\"; echo {banner}; {cmd}; __op_s=$?; echo; \
             if [ $__op_s -eq 0 ]; then echo {ok}; else echo \"安装命令失败（退出码 $__op_s）\"; fi; exec bash",
            banner = quote(&format!("$ {}", inst.cmd)),
            cmd = inst.cmd,
            ok = quote("安装命令已结束。回到 Bunsen 重新探测服务器即可看到结果；这个终端可以继续使用（例如登录代理）。"),
        );
        let pane_cmd = format!("bash -lc {}", quote(&inner));
        let script = format!(
            "{ensure}\ntmux -L bunsen kill-session -t {ex} 2>/dev/null\n\
             {TMUX} new-session -d -s {s} -x 200 -y 50 -c \"$HOME\" {cmd} \\; source-file \"$HOME/.bunsen/tmux.conf\" || exit 5\n",
            ensure = tmux::ensure_script(),
            ex = quote(&tmux::exact(&name)),
            s = quote(&name),
            cmd = quote(&pane_cmd),
        );
        let out = self.ssh.run(&target(&sv), &script, OP_TIMEOUT).await?;
        if out.text().contains("__OP_NO_TMUX__") {
            return Err(tmux_missing());
        }
        if out.code != 0 {
            return Err(Error::new(Code::SshFailed, format!("启动安装任务失败：{}", out.err_line())));
        }
        Ok(name)
    }

    // ---------- 密钥 ----------

    pub fn keys(&self) -> Result<Vec<KeyInfo>> {
        keys::list(&self.paths().keys_dir(), &self.store.servers()?)
    }

    pub fn delete_key(&self, name: &str) -> Result<()> {
        keys::delete(&self.paths().keys_dir(), name, &self.store.servers()?)
    }

    // ---------- 导入 ----------

    pub async fn import(self: &Arc<Self>, uploads: Vec<Upload>, config_text: Option<String>) -> Result<ImportResult> {
        let mut res = ImportResult::default();
        let items = import::expand(uploads, &mut res.warnings);
        let keys_dir = self.paths().keys_dir();

        // 1. 私钥（先存，配置里的 IdentityFile 才能匹配到同一批上传的密钥）
        let mut name_map: Vec<(String, String)> = Vec::new();
        let mut added_keys: Vec<String> = Vec::new();
        for (u, _) in items.iter().filter(|(_, k)| *k == Kind::PrivateKey) {
            let saved = keys::save_private(&keys_dir, &u.name, &u.data)?;
            let uploaded = keys::sanitize_name(&u.name);
            if !saved.added && saved.name != uploaded {
                res.warnings.push(format!("私钥 {} 与已保存的 {} 是同一把，已合并", u.name, saved.name));
            }
            if saved.added {
                added_keys.push(saved.name.clone());
            }
            name_map.push((uploaded, saved.name));
        }
        // 2. 公钥
        for (u, _) in items.iter().filter(|(_, k)| *k == Kind::PublicKey) {
            if keys::save_public(&keys_dir, &u.name, &u.data, &name_map)?.is_none() {
                res.warnings.push(format!("公钥 {} 没有对应的私钥，已忽略", u.name));
            }
        }
        // 3. 配置
        let mut texts: Vec<String> = items
            .iter()
            .filter(|(_, k)| *k == Kind::Config)
            .map(|(u, _)| String::from_utf8_lossy(&u.data).into_owned())
            .collect();
        if let Some(t) = config_text.filter(|t| !t.trim().is_empty()) {
            if sshconfig::looks_like_config(&t) {
                texts.push(t);
            } else {
                res.warnings.push("粘贴的文本里没有 Host 行，不像 ssh 配置，已忽略".to_string());
            }
        }
        let mut entries = Vec::new();
        for t in &texts {
            let p = sshconfig::parse(t);
            res.warnings.extend(p.warnings);
            entries.extend(p.hosts);
        }
        if entries.is_empty() && texts.is_empty() && added_keys.is_empty() && items.is_empty() {
            res.warnings.push("没有识别到 ssh 配置或私钥".to_string());
        }

        let saved_names = keys::list_names(&keys_dir)?;
        let local_user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "root".into());
        let mut added_ids: Vec<String> = Vec::new();
        let mut updated_ids: Vec<String> = Vec::new();
        let mut warnings = Vec::new();
        self.store.update_servers(|servers| {
            for e in entries {
                let user = e.user.clone().unwrap_or_else(|| local_user.clone());
                if let Err(err) = Self::check_server_fields(&e.alias, &e.host, &user, &e.proxy_jump, &e.proxy_command) {
                    warnings.push(format!("Host {} 已跳过：{}", e.alias, err.message));
                    continue;
                }
                let mut key: Option<String> = None;
                let mut missing: Vec<String> = Vec::new();
                for f in &e.identity_files {
                    let base = keys::sanitize_name(&identity_basename(f));
                    let hit = name_map
                        .iter()
                        .find(|(from, _)| *from == base)
                        .map(|(_, to)| to.clone())
                        .or_else(|| saved_names.iter().find(|n| **n == base).cloned());
                    match hit {
                        Some(k) => {
                            key = Some(k);
                            break;
                        }
                        None => missing.push(identity_basename(f)),
                    }
                }
                if key.is_none() && !missing.is_empty() {
                    warnings.push(format!("Host {} 引用的密钥 {} 没有上传", e.alias, missing.join("、")));
                }
                match servers.iter_mut().find(|s| s.alias == e.alias) {
                    Some(s) => {
                        let before = (s.host.clone(), s.user.clone(), s.port, s.key.clone(), s.proxy_jump.clone(), s.proxy_command.clone());
                        s.host = e.host.clone();
                        s.user = user;
                        s.port = e.port.unwrap_or(22);
                        if key.is_some() {
                            s.key = key;
                        }
                        s.proxy_jump = e.proxy_jump.clone();
                        s.proxy_command = e.proxy_command.clone();
                        s.source = ServerSource::Upload;
                        let after = (s.host.clone(), s.user.clone(), s.port, s.key.clone(), s.proxy_jump.clone(), s.proxy_command.clone());
                        if before != after {
                            s.status = ServerStatus::Unknown;
                            s.status_detail = None;
                        }
                        if !updated_ids.contains(&s.id) && !added_ids.contains(&s.id) {
                            updated_ids.push(s.id.clone());
                        }
                    }
                    None => {
                        let mut id = short_id();
                        while servers.iter().any(|s| s.id == id) {
                            id = short_id();
                        }
                        servers.push(Server {
                            id: id.clone(),
                            alias: e.alias.clone(),
                            host: e.host.clone(),
                            user,
                            port: e.port.unwrap_or(22),
                            key,
                            proxy_jump: e.proxy_jump.clone(),
                            proxy_command: e.proxy_command.clone(),
                            source: ServerSource::Upload,
                            note: String::new(),
                            default_workdir: "~".into(),
                            status: ServerStatus::Unknown,
                            status_detail: None,
                            last_checked: None,
                            probe: None,
                        });
                        added_ids.push(id);
                    }
                }
            }
            Ok(())
        })?;
        res.warnings.extend(warnings);
        self.regen_ssh_config()?;

        // 4. 自动测试（并发）：没有指定密钥的逐把尝试已保存的私钥。
        let mut set = tokio::task::JoinSet::new();
        for id in added_ids.iter().chain(updated_ids.iter()) {
            let core = Arc::clone(self);
            let id = id.clone();
            set.spawn(async move {
                let sv = core.server(&id)?;
                let r = core.test_server(&id, sv.key.is_none()).await?;
                Ok::<_, Error>((id, r))
            });
        }
        let mut results: Vec<(String, TestResult)> = Vec::new();
        while let Some(j) = set.join_next().await {
            match j {
                Ok(Ok(r)) => results.push(r),
                Ok(Err(e)) => res.warnings.push(format!("自动测试连接出错：{}", e.message)),
                Err(e) => res.warnings.push(format!("自动测试连接出错：{e}")),
            }
        }
        for id in added_ids.iter().chain(updated_ids.iter()) {
            if let Some((_, r)) = results.iter().find(|(i, _)| i == id) {
                res.tests.push(ImportTest {
                    server_id: id.clone(),
                    ok: r.ok,
                    key_used: r.key_used.clone(),
                    detail: r.server.status_detail.clone(),
                });
            }
        }
        let servers = self.store.servers()?;
        res.servers_added = servers.iter().filter(|s| added_ids.contains(&s.id)).cloned().collect();
        res.servers_updated = servers.iter().filter(|s| updated_ids.contains(&s.id)).cloned().collect();
        res.keys_added = added_keys.iter().map(|n| keys::info(&keys_dir, n, &servers)).collect();
        Ok(res)
    }
}

pub(crate) fn tmux_missing() -> Error {
    Error::new(Code::TmuxMissing, "服务器上没有 tmux")
        .with_hint("先在服务器上安装 tmux，例如 sudo apt install tmux、sudo dnf install tmux 或 conda install -c conda-forge tmux")
}
