//! 云端对话（会话）：部署、状态刷新与发现、send/keys/capture、restart/stop/delete。

use crate::core::{target, tmux_missing, Core, OP_TIMEOUT};
use crate::error::{Code, Error, Result};
use crate::model::*;
use crate::plugins;
use crate::shell::{build_launch, pane_command, quote, quote_path, LaunchOpts};
use crate::ssh::local_has;
use crate::tmux::{self, RemoteSession};
use crate::util::{now_rfc3339, short_id, take_chars};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

/// 部署失败：错误与已经走过的步骤。
#[derive(Debug, Clone)]
pub struct DeployFailure {
    pub error: Error,
    pub steps: Vec<Step>,
}

struct Steps {
    list: Vec<Step>,
    tx: Option<UnboundedSender<Step>>,
    started: Instant,
}

/// 远程补可执行位的脚本片段，`__DIR__` 换成已转义的目录。
const FIX_EXEC: &str = "find __DIR__ -type f \\( -name '*.sh' -o -path '*/tools/*.py' \\) -exec chmod +x {} + 2>/dev/null\n\
find __DIR__ -type f -exec sh -c 'for f; do case \"$(head -c 2 \"$f\" 2>/dev/null)\" in \"#!\") chmod +x \"$f\";; esac; done' _ {} + 2>/dev/null\n";

impl Steps {
    fn emit(&self) {
        if let (Some(tx), Some(s)) = (&self.tx, self.list.last()) {
            let _ = tx.send(s.clone());
        }
    }
    fn begin(&mut self, step: &str, label: &str) {
        self.started = Instant::now();
        self.list.push(Step { step: step.into(), label: label.into(), status: StepStatus::Running, detail: None, ms: None });
        self.emit();
    }
    fn end(&mut self, status: StepStatus, detail: Option<String>) {
        let ms = self.started.elapsed().as_millis() as u64;
        if let Some(s) = self.list.last_mut() {
            s.status = status;
            s.detail = detail;
            s.ms = Some(ms);
        }
        self.emit();
    }
    fn ok(&mut self, detail: impl Into<String>) {
        self.end(StepStatus::Ok, Some(detail.into()));
    }
    fn fail(&mut self, e: Error) -> DeployFailure {
        let detail = match &e.hint {
            Some(h) => format!("{}（{}）", e.message, h),
            None => e.message.clone(),
        };
        self.end(StepStatus::Failed, Some(detail));
        DeployFailure { error: e, steps: self.list.clone() }
    }
    fn skip(&mut self, step: &str, label: &str, detail: &str) {
        self.list.push(Step {
            step: step.into(),
            label: label.into(),
            status: StepStatus::Skipped,
            detail: Some(detail.into()),
            ms: None,
        });
        self.emit();
    }
}

fn gone(id: &str) -> Error {
    Error::conflict(format!("会话 {id} 在服务器上已经不存在"))
        .with_hint("会话已停止；可以用“重启”在原工作目录里重新拉起代理")
}

fn dead(id: &str) -> Error {
    Error::conflict(format!("会话 {id} 的代理已经退出")).with_hint("先“重启”代理再发送")
}

/// 远端元数据 `~/.outpost/sessions/<id>.json`。
fn meta_json(s: &Session, extra_args: &Option<String>) -> String {
    serde_json::json!({
        "id": s.id,
        "title": s.title,
        "agent_id": s.agent_id,
        "workdir": s.workdir,
        "created_at": s.created_at,
        "plugin": s.plugin,
        "plugins": s.plugins,
        "yolo": s.yolo,
        "extra_args": extra_args,
        "created_by": "outpost",
    })
    .to_string()
}

fn write_meta_script(id: &str, json: &str) -> String {
    format!(
        "mkdir -p \"$HOME/.outpost/sessions\" && printf '%s\\n' {} > \"$HOME/.outpost/sessions/{id}.json\"\n",
        quote(json)
    )
}

fn single_line_title(s: &str) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    take_chars(&flat, 40)
}

impl Core {
    pub fn attach_cmd(&self, alias: &str, id: &str) -> String {
        format!(
            "ssh -F {} -t {} tmux -L outpost attach-session -t {}",
            quote(&self.paths().ssh_config().to_string_lossy()),
            quote(alias),
            tmux::agent_session(id)
        )
    }

    fn present(&self, r: &SessionRecord) -> Session {
        let mut s = r.session.clone();
        normalize_plugins(&mut s);
        s.tmux = tmux::agent_session(&s.id);
        s.attach_cmd = self.attach_cmd(&s.server_alias, &s.id);
        s
    }

    fn record(&self, id: &str) -> Result<SessionRecord> {
        self.store
            .sessions()?
            .into_iter()
            .find(|r| r.session.id == id)
            .ok_or_else(|| Error::not_found(format!("没有 id 为 {id} 的会话")))
    }

    fn save_record(&self, rec: SessionRecord) -> Result<Session> {
        let out = self.present(&rec);
        self.store.update_sessions(|v| {
            match v.iter_mut().find(|r| r.session.id == rec.session.id) {
                Some(r) => *r = rec,
                None => v.push(rec),
            }
            Ok(())
        })?;
        Ok(out)
    }

    /// 一次 ssh 取回一台服务器上所有 op-<id> 会话的状态、预览与元数据。
    async fn fetch_remote(&self, sv: &Server) -> Result<BTreeMap<String, RemoteSession>> {
        let marker = format!("__OPM_{}__", short_id());
        let out = self.ssh.run(&target(sv), &tmux::status_script(&marker), OP_TIMEOUT).await?;
        if !out.text().contains(&format!("{marker} end")) {
            return Err(Error::new(Code::SshFailed, format!("读取会话状态失败：{}", out.err_line())));
        }
        Ok(tmux::parse_status(&out.text(), &marker))
    }

    fn apply_remote(s: &mut Session, remote: Option<&RemoteSession>) {
        match remote {
            Some(r) => {
                let pane = r.pane.clone().unwrap_or_default();
                s.state = if pane.dead { SessionState::Exited } else { SessionState::Running };
                s.exit_status = if pane.dead { pane.dead_status } else { None };
                s.attached = r.attached;
                if r.activity.is_some() {
                    s.last_active_at = r.activity.clone();
                }
                if r.preview.is_some() {
                    s.preview = r.preview.clone();
                }
            }
            None => {
                s.state = SessionState::Stopped;
                s.exit_status = None;
                s.attached = 0;
            }
        }
    }

    fn discovered(&self, sv: &Server, r: &RemoteSession) -> SessionRecord {
        let meta: serde_json::Value = r.meta.as_deref().and_then(|m| serde_json::from_str(m).ok()).unwrap_or_default();
        let st = |k: &str| meta.get(k).and_then(|v| v.as_str()).map(str::to_string).filter(|v| !v.is_empty());
        let mut s = Session {
            id: r.id.clone(),
            title: st("title").unwrap_or_else(|| format!("op-{}", r.id)),
            server_id: sv.id.clone(),
            server_alias: sv.alias.clone(),
            agent_id: st("agent_id").unwrap_or_else(|| "unknown".into()),
            workdir: st("workdir").unwrap_or_else(|| "~".into()),
            tmux: tmux::agent_session(&r.id),
            created_at: st("created_at").or_else(|| r.activity.clone()).unwrap_or_else(now_rfc3339),
            last_active_at: None,
            state: SessionState::Unknown,
            exit_status: None,
            attached: 0,
            pinned: false,
            archived: false,
            plugin: st("plugin"),
            plugins: meta
                .get("plugins")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            yolo: meta.get("yolo").and_then(|v| v.as_bool()).unwrap_or(false),
            preview: None,
            attach_cmd: String::new(),
            origin: Origin::Discovered,
        };
        Self::apply_remote(&mut s, Some(r));
        SessionRecord { session: s, extra_args: st("extra_args") }
    }

    /// 会话列表。`refresh` 时逐台连服务器更新状态，并把服务器上发现的会话并入。
    pub async fn sessions(self: &Arc<Self>, refresh: bool) -> Result<Vec<Session>> {
        if refresh {
            let servers = self.store.servers()?;
            let mut set = tokio::task::JoinSet::new();
            for sv in servers.clone() {
                let core = Arc::clone(self);
                set.spawn(async move {
                    let r = core.fetch_remote(&sv).await;
                    let _ = core.record_conn(&sv.id, &r.as_ref().map(|_| ()).map_err(|e| e.clone()));
                    (sv.id.clone(), r)
                });
            }
            let mut fetched: BTreeMap<String, Result<BTreeMap<String, RemoteSession>>> = BTreeMap::new();
            while let Some(j) = set.join_next().await {
                if let Ok((id, r)) = j {
                    fetched.insert(id, r);
                }
            }
            self.store.update_sessions(|v| {
                for rec in v.iter_mut() {
                    let s = &mut rec.session;
                    match servers.iter().find(|sv| sv.id == s.server_id) {
                        None => s.state = SessionState::Unknown,
                        Some(sv) => {
                            s.server_alias = sv.alias.clone();
                            match fetched.get(&sv.id) {
                                Some(Ok(map)) => Self::apply_remote(s, map.get(&s.id)),
                                _ => s.state = SessionState::Unreachable,
                            }
                        }
                    }
                }
                for sv in &servers {
                    if let Some(Ok(map)) = fetched.get(&sv.id) {
                        for (id, r) in map {
                            if !v.iter().any(|x| &x.session.id == id) {
                                v.push(self.discovered(sv, r));
                            }
                        }
                    }
                }
                Ok(())
            })?;
        }
        Ok(self.store.sessions()?.iter().map(|r| self.present(r)).collect())
    }

    /// 连服务器取一个会话的最新状态；连不上时状态为 unreachable（不报错）。
    pub async fn session(&self, id: &str) -> Result<Session> {
        let mut rec = self.record(id)?;
        match self.server(&rec.session.server_id) {
            Err(_) => rec.session.state = SessionState::Unknown,
            Ok(sv) => {
                rec.session.server_alias = sv.alias.clone();
                match self.fetch_remote(&sv).await {
                    Ok(map) => Self::apply_remote(&mut rec.session, map.get(id)),
                    Err(_) => rec.session.state = SessionState::Unreachable,
                }
            }
        }
        let id = rec.session.id.clone();
        let fresh = rec.session.clone();
        self.store.update_sessions(|v| {
            if let Some(r) = v.iter_mut().find(|r| r.session.id == id) {
                let keep = (r.session.title.clone(), r.session.pinned, r.session.archived);
                r.session = fresh.clone();
                (r.session.title, r.session.pinned, r.session.archived) = keep;
            }
            Ok(())
        })?;
        Ok(self.present(&self.record(&id)?))
    }

    pub async fn patch_session(self: &Arc<Self>, id: &str, p: SessionPatch) -> Result<Session> {
        let title = match p.title {
            Some(t) => {
                let t = t.trim().to_string();
                if t.is_empty() {
                    return Err(Error::bad_request("标题不能为空"));
                }
                Some(t)
            }
            None => None,
        };
        let title_changed = title.is_some();
        let rec = self.store.update_sessions(|v| {
            let r = v.iter_mut().find(|r| r.session.id == id).ok_or_else(|| Error::not_found(format!("没有 id 为 {id} 的会话")))?;
            if let Some(t) = title {
                r.session.title = t;
            }
            if let Some(x) = p.pinned {
                r.session.pinned = x;
            }
            if let Some(x) = p.archived {
                r.session.archived = x;
            }
            Ok(r.clone())
        })?;
        if title_changed {
            // 尽力同步服务器上的元数据（只在文件已存在时改写），失败不影响本机。
            let core = Arc::clone(self);
            let r = rec.clone();
            tokio::spawn(async move {
                if let Ok(sv) = core.server(&r.session.server_id) {
                    let json = meta_json(&r.session, &r.extra_args);
                    let script = format!(
                        "if [ -f \"$HOME/.outpost/sessions/{id}.json\" ]; then {}fi\n",
                        write_meta_script(&r.session.id, &json),
                        id = r.session.id
                    );
                    let _ = core.ssh.run(&target(&sv), &script, OP_TIMEOUT).await;
                }
            });
        }
        Ok(self.present(&rec))
    }

    fn rec_and_server(&self, id: &str) -> Result<(SessionRecord, Server)> {
        let rec = self.record(id)?;
        let sv = self.server(&rec.session.server_id)?;
        Ok((rec, sv))
    }

    /// 检查会话在且代理活着的脚本前缀。
    fn alive_guard(session: &str) -> String {
        format!(
            "if ! tmux -L outpost has-session -t {ex} 2>/dev/null; then echo __OP_GONE__; exit 0; fi\n\
             if [ \"$(tmux -L outpost list-panes -t {p} -F '#{{pane_dead}}' | head -n 1)\" = 1 ]; then echo __OP_DEAD__; exit 0; fi\n",
            ex = quote(&tmux::exact(session)),
            p = quote(&tmux::pane(session)),
        )
    }

    fn check_guard(id: &str, out: &str) -> Result<()> {
        if out.contains("__OP_GONE__") {
            return Err(gone(id));
        }
        if out.contains("__OP_DEAD__") {
            return Err(dead(id));
        }
        Ok(())
    }

    /// 把文字粘贴进代理窗格（load-buffer + paste-buffer，多行安全），可选回车。
    pub async fn send(&self, id: &str, text: &str, enter: bool) -> Result<()> {
        let (rec, sv) = self.rec_and_server(id)?;
        let sess = tmux::agent_session(&rec.session.id);
        let p = quote(&tmux::pane(&sess));
        let buf = quote(&format!("op-in-{}", rec.session.id));
        let mut script = Self::alive_guard(&sess);
        if !text.is_empty() {
            script.push_str(&format!(
                "printf '%s' {} | tmux -L outpost load-buffer -b {buf} - || exit 6\n\
                 tmux -L outpost paste-buffer -p -d -b {buf} -t {p} || exit 6\n",
                quote(text)
            ));
        }
        if enter {
            if !text.is_empty() {
                // 有些代理在粘贴后立刻收到回车会当成粘贴内容的一部分，稍等一下。
                script.push_str("sleep 0.3 2>/dev/null || sleep 1\n");
            }
            script.push_str(&format!("tmux -L outpost send-keys -t {p} Enter || exit 6\n"));
        }
        script.push_str("echo __OP_DONE__\n");
        let out = self.ssh.run(&target(&sv), &script, OP_TIMEOUT).await?;
        Self::check_guard(id, &out.text())?;
        if out.code != 0 || !out.text().contains("__OP_DONE__") {
            return Err(Error::new(Code::SshFailed, format!("发送失败：{}", out.err_line())));
        }
        Ok(())
    }

    /// 发送 tmux 键名，如 Escape、C-c、Enter。
    pub async fn send_keys(&self, id: &str, keys: &[String]) -> Result<()> {
        if keys.is_empty() {
            return Err(Error::bad_request("keys 不能为空"));
        }
        for k in keys {
            if k.is_empty() || k.chars().count() > 32 || k.chars().any(|c| c.is_whitespace() || c.is_control()) {
                return Err(Error::bad_request(format!("键名“{k}”不合法")).with_hint("用 tmux 的键名，例如 Escape、C-c、Enter、Up"));
            }
        }
        let (rec, sv) = self.rec_and_server(id)?;
        let sess = tmux::agent_session(&rec.session.id);
        let mut script = Self::alive_guard(&sess);
        let ks: Vec<String> = keys.iter().map(|k| quote(k)).collect();
        script.push_str(&format!("tmux -L outpost send-keys -t {} {} || exit 6\necho __OP_DONE__\n", quote(&tmux::pane(&sess)), ks.join(" ")));
        let out = self.ssh.run(&target(&sv), &script, OP_TIMEOUT).await?;
        Self::check_guard(id, &out.text())?;
        if out.code != 0 || !out.text().contains("__OP_DONE__") {
            return Err(Error::new(Code::SshFailed, format!("发送按键失败：{}", out.err_line())));
        }
        Ok(())
    }

    /// 代理窗格最近若干行纯文本（代理退出后窗格保留，照样能取）。
    pub async fn capture(&self, id: &str, lines: Option<u32>) -> Result<String> {
        let n = lines.unwrap_or(200).clamp(1, 20_000);
        let (rec, sv) = self.rec_and_server(id)?;
        let sess = tmux::agent_session(&rec.session.id);
        let script = format!(
            "if ! tmux -L outpost has-session -t {ex} 2>/dev/null; then echo __OP_GONE__; exit 0; fi\n\
             echo __OP_CAP__\n\
             tmux -L outpost capture-pane -p -J -t {p} -S -{n}\n",
            ex = quote(&tmux::exact(&sess)),
            p = quote(&tmux::pane(&sess)),
        );
        let out = self.ssh.run(&target(&sv), &script, OP_TIMEOUT).await?;
        let text = out.text();
        let Some((_, body)) = text.split_once("__OP_CAP__\n") else {
            if text.contains("__OP_GONE__") {
                return Err(gone(id));
            }
            return Err(Error::new(Code::SshFailed, format!("读取窗格失败：{}", out.err_line())));
        };
        let mut lines_v: Vec<&str> = body.lines().map(str::trim_end).collect();
        while lines_v.last().is_some_and(|l| l.is_empty()) {
            lines_v.pop();
        }
        let start = lines_v.len().saturating_sub(n as usize);
        Ok(lines_v[start..].join("\n"))
    }

    /// 在原 tmux 会话里重新拉起代理（窗格在就 respawn-pane -k，会话不在就按原参数重建）。
    pub async fn restart(&self, id: &str, resume: bool) -> Result<Session> {
        let (rec, sv) = self.rec_and_server(id)?;
        let s = &rec.session;
        let sess = tmux::agent_session(&s.id);
        let agent = self.agent(&s.agent_id).ok();
        let mut plugin_names = s.plugins.clone();
        if plugin_names.is_empty() {
            plugin_names.extend(s.plugin.clone());
        }
        let mut paste: Option<String> = None;
        let cmd = match &agent {
            Some(a) => {
                let l = build_launch(
                    a,
                    &LaunchOpts { prompt: None, yolo: s.yolo, plugins: &plugin_names, extra_args: rec.extra_args.as_deref(), resume },
                )?;
                if !l.prompt_in_cmd {
                    paste = l.prompt.clone();
                }
                Some(pane_command(&s.workdir, &l.cmd))
            }
            None => None,
        };
        let respawn = match &cmd {
            Some(c) => format!("tmux -L outpost respawn-pane -k -t {} -c {} {} || exit 5\n", quote(&tmux::pane(&sess)), quote_path(&s.workdir), quote(c)),
            None => format!("tmux -L outpost respawn-pane -k -t {} || exit 5\n", quote(&tmux::pane(&sess))),
        };
        let recreate = match &cmd {
            Some(c) => format!("{}{}", tmux::ensure_script(), tmux::new_session_script(&sess, &s.workdir, c)),
            None => "echo __OP_NOAGENT__; exit 0\n".to_string(),
        };
        let script = format!(
            "if tmux -L outpost has-session -t {ex} 2>/dev/null; then\n{respawn}else\n{recreate}fi\necho __OP_DONE__\n",
            ex = quote(&tmux::exact(&sess)),
        );
        let out = self.ssh.run(&target(&sv), &script, OP_TIMEOUT).await?;
        let text = out.text();
        if text.contains("__OP_NO_TMUX__") {
            return Err(tmux_missing());
        }
        if text.contains("__OP_NOAGENT__") {
            return Err(Error::not_found(format!("本机没有 Agent {}，无法重建已停止的会话", s.agent_id))
                .with_hint("先在 Agent 列表里添加同 id 的 Agent"));
        }
        if out.code != 0 || !text.contains("__OP_DONE__") {
            return Err(Error::new(Code::SshFailed, format!("重启失败：{}", out.err_line())));
        }
        tokio::time::sleep(Duration::from_millis(700)).await;
        if let Some(p) = paste {
            // 启动命令不支持带提示（插件提示）：等界面起来后粘贴进去。
            tokio::time::sleep(Duration::from_millis(1000)).await;
            let _ = self.send(id, &p, true).await;
        }
        self.session(id).await
    }

    /// 结束服务器上的两个 tmux 会话（代理与 shell），记录保留。
    pub async fn stop(&self, id: &str) -> Result<Session> {
        let (mut rec, sv) = self.rec_and_server(id)?;
        let s = &rec.session;
        let script = format!(
            "tmux -L outpost kill-session -t {} 2>/dev/null\ntmux -L outpost kill-session -t {} 2>/dev/null\necho __OP_DONE__\n",
            quote(&tmux::exact(&tmux::agent_session(&s.id))),
            quote(&tmux::exact(&tmux::shell_session(&s.id))),
        );
        let out = self.ssh.run(&target(&sv), &script, OP_TIMEOUT).await?;
        if !out.text().contains("__OP_DONE__") {
            return Err(Error::new(Code::SshFailed, format!("停止失败：{}", out.err_line())));
        }
        let cur = self.record(id)?;
        rec.session = cur.session;
        Self::apply_remote(&mut rec.session, None);
        self.save_record(rec)
    }

    /// 删除记录。会话还在且 `force=false` 时返回 conflict；`force` 先停再删。
    pub async fn delete_session(&self, id: &str, force: bool) -> Result<()> {
        let rec = self.record(id)?;
        let sv = self.server(&rec.session.server_id).ok();
        let alive = match &sv {
            Some(sv) => match self.fetch_remote(sv).await {
                Ok(map) => map.contains_key(id),
                Err(_) => rec.session.state.is_alive(),
            },
            None => false,
        };
        if alive && !force {
            return Err(Error::conflict("会话还在服务器上运行").with_hint("先停止会话，或用 force=1 先停再删"));
        }
        if let Some(sv) = &sv {
            let script = format!(
                "tmux -L outpost kill-session -t {} 2>/dev/null\ntmux -L outpost kill-session -t {} 2>/dev/null\nrm -f \"$HOME/.outpost/sessions/{}.json\"\necho __OP_DONE__\n",
                quote(&tmux::exact(&tmux::agent_session(id))),
                quote(&tmux::exact(&tmux::shell_session(id))),
                rec.session.id,
            );
            let r = self.ssh.run(&target(sv), &script, OP_TIMEOUT).await;
            if alive {
                // 强制删除时必须确实停掉；连不上就报错，免得留下没人管的会话。
                r?;
            }
        }
        self.store.update_sessions(|v| {
            v.retain(|r| r.session.id != id);
            Ok(())
        })
    }

    // ---------- 部署 ----------

    /// 部署一个会话。`tx` 不为空时每一步的开始与结束都会发过去（ndjson 流用）。
    pub async fn deploy(&self, req: DeployRequest, tx: Option<UnboundedSender<Step>>) -> std::result::Result<DeployOutcome, DeployFailure> {
        let pre = |e: Error| DeployFailure { error: e, steps: vec![] };
        let sv = self.server(req.server_id.trim()).map_err(pre)?;
        let agent = self.agent(req.agent_id.trim()).map_err(pre)?;
        let workdir = {
            let w = req.workdir.trim();
            if w.is_empty() { sv.default_workdir.clone() } else { w.to_string() }
        };
        crate::sshconfig::validate_single_line("工作目录", &workdir).map_err(pre)?;
        let settings = self.settings().map_err(pre)?;
        let mut plugin_warnings = Vec::new();
        let avail = plugins::available(&settings, &mut plugin_warnings);
        let chosen: Vec<plugins::Available> = match req.selected_plugins() {
            None => avail.clone(),
            Some(names) => {
                let mut v: Vec<plugins::Available> = Vec::new();
                for n in names {
                    if v.iter().any(|a| a.info.name == n) {
                        continue;
                    }
                    let a = avail.iter().find(|a| a.info.name == n).cloned().ok_or_else(|| {
                        pre(Error::bad_request(format!("没有名为 {n} 的插件")).with_hint("用 GET /api/plugins 查看可用插件"))
                    })?;
                    v.push(a);
                }
                v
            }
        };
        let plugin_names: Vec<String> = chosen.iter().map(|a| a.info.name.clone()).collect();
        if let Some(x) = &req.extra_args {
            crate::sshconfig::validate_single_line("extra_args", x).map_err(pre)?;
        }
        let prompt = req.prompt.clone().filter(|p| !p.trim().is_empty());
        let yolo = req.yolo.unwrap_or(false);
        let extra_args = req.extra_args.clone().map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
        let title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .or_else(|| prompt.as_deref().map(single_line_title).filter(|t| !t.is_empty()))
            .unwrap_or_else(|| format!("{} @ {}", agent.name, sv.alias));
        let launch = build_launch(
            &agent,
            &LaunchOpts { prompt: prompt.as_deref(), yolo, plugins: &plugin_names, extra_args: extra_args.as_deref(), resume: false },
        )
        .map_err(pre)?;

        let mut st = Steps { list: vec![], tx, started: Instant::now() };
        let tg = target(&sv);

        // connect
        st.begin("connect", "连接服务器");
        let r = self.ssh.run(&tg, "echo __OP_OK__", crate::core::TEST_TIMEOUT).await.and_then(|o| {
            if o.text().contains("__OP_OK__") {
                Ok(())
            } else {
                Err(Error::new(Code::SshFailed, format!("远程 shell 没有正常执行命令：{}", o.err_line())))
            }
        });
        let _ = self.record_conn(&sv.id, &r);
        if let Err(e) = r {
            return Err(st.fail(e));
        }
        st.ok(if sv.port == 22 { format!("{}@{}", sv.user, sv.host) } else { format!("{}@{}:{}", sv.user, sv.host, sv.port) });

        // tmux
        st.begin("tmux", "检查 tmux");
        match self.ssh.run(&tg, &tmux::ensure_script(), OP_TIMEOUT).await {
            Err(e) => return Err(st.fail(e)),
            Ok(o) if o.text().contains("__OP_NO_TMUX__") => return Err(st.fail(tmux_missing())),
            Ok(o) => st.ok(o.text().lines().last().unwrap_or("tmux").trim().to_string()),
        }

        // agent
        st.begin("agent", "查找代理程序");
        let script = format!("command -v {} 2>/dev/null || true\n", quote(&agent.detect));
        match self.ssh.run(&tg, &script, OP_TIMEOUT).await {
            Err(e) => return Err(st.fail(e)),
            Ok(o) => {
                let path = o.text().lines().next().unwrap_or("").trim().to_string();
                if path.is_empty() {
                    let hint = match agent.install.first() {
                        Some(i) => format!("可以在 Agent 面板里一键安装，或在服务器上执行：{}", i.cmd),
                        None => "确认它已安装并在 PATH 里；Outpost 会额外查找 ~/.local/bin、~/.npm-global/bin、~/.bun/bin、~/.cargo/bin 和 nvm 目录，也可以在服务器的 ~/.outpost/env.sh 里补充 PATH".to_string(),
                    };
                    return Err(st.fail(Error::new(Code::AgentMissing, format!("服务器上找不到 {}（{}）", agent.name, agent.detect)).with_hint(hint)));
                }
                st.ok(path);
            }
        }

        // workdir
        st.begin("workdir", "准备工作目录");
        let script = format!("mkdir -p {wd} && cd {wd} && pwd\n", wd = quote_path(&workdir));
        match self.ssh.run(&tg, &script, OP_TIMEOUT).await {
            Err(e) => return Err(st.fail(e)),
            Ok(o) if o.code != 0 => {
                return Err(st.fail(Error::bad_request(format!("工作目录 {workdir} 无法创建：{}", o.err_line()))))
            }
            Ok(o) => st.ok(o.text().lines().last().unwrap_or("").trim().to_string()),
        }

        // plugin
        if chosen.is_empty() {
            st.skip("plugin", "同步插件", "未选择插件");
        } else {
            st.begin("plugin", "同步插件");
            match self.sync_plugins(&sv, &chosen).await {
                Err(e) => return Err(st.fail(e)),
                Ok(mut d) => {
                    let no_flag = agent.plugin_dir_flag.as_deref().is_none_or(|f| f.trim().is_empty());
                    let no_prompt = agent.plugin_prompt.as_deref().is_none_or(|f| f.trim().is_empty());
                    if no_flag && no_prompt {
                        d.push_str(&format!("（{} 不会自动加载插件）", agent.name));
                    }
                    st.ok(d)
                }
            }
        }

        // start
        st.begin("start", "启动会话");
        let existing: Vec<String> = self.store.sessions().map_err(|e| st.fail(e))?.into_iter().map(|r| r.session.id).collect();
        let mut id = short_id();
        while existing.contains(&id) {
            id = short_id();
        }
        let sess = tmux::agent_session(&id);
        let now = now_rfc3339();
        let session = Session {
            id: id.clone(),
            title,
            server_id: sv.id.clone(),
            server_alias: sv.alias.clone(),
            agent_id: agent.id.clone(),
            workdir: workdir.clone(),
            tmux: sess.clone(),
            created_at: now.clone(),
            last_active_at: Some(now),
            state: SessionState::Running,
            exit_status: None,
            attached: 0,
            pinned: false,
            archived: false,
            plugin: plugin_names.first().cloned(),
            plugins: plugin_names.clone(),
            yolo,
            preview: None,
            attach_cmd: String::new(),
            origin: Origin::Local,
        };
        let pane_cmd = pane_command(&workdir, &launch.cmd);
        let script = format!(
            "{}{}echo __OP_DONE__\n",
            tmux::new_session_script(&sess, &workdir, &pane_cmd),
            write_meta_script(&id, &meta_json(&session, &extra_args))
        );
        match self.ssh.run(&tg, &script, OP_TIMEOUT).await {
            Err(e) => return Err(st.fail(e)),
            Ok(o) if o.code != 0 || !o.text().contains("__OP_DONE__") => {
                return Err(st.fail(Error::new(Code::SshFailed, format!("启动 tmux 会话失败：{}", o.err_line()))))
            }
            Ok(_) => {}
        }
        let mut rec = SessionRecord { session, extra_args };
        if let Err(e) = self.save_record(rec.clone()) {
            return Err(st.fail(e));
        }
        st.ok(format!("tmux 会话 {sess}"));

        // verify
        st.begin("verify", "确认代理在运行");
        tokio::time::sleep(Duration::from_secs(1)).await;
        let script = format!("{}tmux -L outpost capture-pane -p -J -t {} -S -20 2>/dev/null\n", tmux::pane_state_script(&sess), quote(&tmux::pane(&sess)));
        let out = match self.ssh.run(&tg, &script, OP_TIMEOUT).await {
            Ok(o) => o,
            Err(e) => return Err(st.fail(e)),
        };
        let text = out.text();
        let mut lines = text.lines();
        let first = lines.next().unwrap_or("").trim().to_string();
        let tail: Vec<&str> = lines.map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
        rec.session.preview = tmux::make_preview(&tail.join("\n"));
        if first == "__OP_GONE__" {
            Self::apply_remote(&mut rec.session, None);
            let _ = self.save_record(rec);
            return Err(st.fail(Error::internal("tmux 会话启动后马上消失了").with_hint("检查服务器上的 tmux 是否正常（tmux -L outpost ls）")));
        }
        let pane = tmux::parse_pane_line(&first).unwrap_or_default();
        if pane.dead {
            rec.session.state = SessionState::Exited;
            rec.session.exit_status = pane.dead_status;
            let _ = self.save_record(rec.clone());
            let code = pane.dead_status.map(|c| c.to_string()).unwrap_or_else(|| "未知".into());
            let last = tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" / ");
            let e = if pane.dead_status == Some(127) {
                Error::new(Code::AgentMissing, format!("代理启动失败：找不到命令（退出码 127）：{last}"))
            } else {
                Error::internal(format!("代理启动后立即退出（退出码 {code}）"))
                    .with_hint(if last.is_empty() { "接入会话查看输出".to_string() } else { format!("最后的输出：{last}") })
            };
            return Err(st.fail(e));
        }
        let mut detail = format!("代理在运行（{}）", if pane.command.is_empty() { "?" } else { &pane.command });
        if let (Some(p), false) = (&launch.prompt, launch.prompt_in_cmd) {
            // 启动命令不支持带提示：等界面起来后粘贴进去。
            tokio::time::sleep(Duration::from_millis(1500)).await;
            match self.send(&id, p, true).await {
                Ok(()) => detail.push_str("，已粘贴初始提示"),
                Err(e) => detail.push_str(&format!("，粘贴初始提示失败：{}", e.message)),
            }
        }
        let saved = match self.save_record(rec) {
            Ok(s) => s,
            Err(e) => return Err(st.fail(e)),
        };
        st.ok(detail);
        Ok(DeployOutcome { session: saved, steps: st.list })
    }

    /// 把选中的插件同步到服务器 `~/.outpost/plugins/<name>/`：先在本机展开到 `plugins-cache/`（已过滤），
    /// 再同步到服务器上的临时目录（优先 rsync，退回 tar 经 ssh 管道），最后替换正式目录。
    async fn sync_plugins(&self, sv: &Server, chosen: &[plugins::Available]) -> Result<String> {
        let cache_root = self.paths().data.join("plugins-cache");
        let mut staged: Vec<(String, std::path::PathBuf, usize)> = Vec::new();
        for a in chosen {
            let (dir, _) = {
                let cache_root = cache_root.clone();
                let a2 = a.clone();
                tokio::task::spawn_blocking(move || plugins::materialize(&cache_root, &a2))
                    .await
                    .map_err(|e| Error::internal(format!("展开插件失败：{e}")))??
            };
            staged.push((a.info.name.clone(), dir, a.info.skills.len()));
        }
        let out = self
            .ssh
            .run(&target(sv), "mkdir -p \"$HOME/.outpost/plugins\" || exit 7\ncommand -v rsync 2>/dev/null || true\n", OP_TIMEOUT)
            .await?;
        if out.code != 0 {
            return Err(Error::new(Code::SshFailed, format!("无法在服务器上创建插件目录：{}", out.err_line())));
        }
        let remote_rsync = out.text().lines().next().unwrap_or("").trim().to_string();
        // OUTPOST_SYNC_METHOD=tar 强制走 tar 回退（测试与排障用）。
        let force_tar = std::env::var("OUTPOST_SYNC_METHOD").ok().as_deref() == Some("tar");
        let use_rsync = !force_tar && !remote_rsync.is_empty() && local_has("rsync").await;
        for (name, dir, _) in &staged {
            if use_rsync {
                self.rsync_dir(sv, dir, &format!(".outpost/plugins/.{name}.tmp/"), &remote_rsync).await?;
            } else {
                self.tar_dir(sv, dir, &format!(".outpost/plugins/.{name}.tmp")).await?;
            }
        }
        let mut swap = String::from("cd \"$HOME/.outpost/plugins\" || exit 7\n");
        for (name, _, _) in &staged {
            let n = quote(name);
            let tmp = quote(&format!(".{name}.tmp"));
            let old = quote(&format!(".{name}.old"));
            // 从 Windows 打包过来的文件没有可执行位，这里按同一套规则补上（脚本、tools 下的 py、带 #! 的文件）。
            swap.push_str(&FIX_EXEC.replace("__DIR__", &tmp));
            swap.push_str(&format!(
                "rm -rf {old} && {{ [ ! -e {n} ] || mv {n} {old}; }} && mv {tmp} {n} && rm -rf {old} || exit 8\n"
            ));
        }
        swap.push_str("echo __OP_DONE__\n");
        let out = self.ssh.run(&target(sv), &swap, OP_TIMEOUT).await?;
        if !out.text().contains("__OP_DONE__") {
            return Err(Error::new(Code::SshFailed, format!("替换服务器上的插件目录失败：{}", out.err_line())));
        }
        let mut detail = staged
            .iter()
            .map(|(n, _, skills)| format!("{n} · {skills} 个技能"))
            .collect::<Vec<_>>()
            .join("；");
        if !use_rsync {
            detail.push_str("（经 tar：本机或服务器没有 rsync）");
        }
        Ok(detail)
    }

    async fn rsync_dir(&self, sv: &Server, local: &Path, remote_rel: &str, remote_rsync: &str) -> Result<()> {
        let src = format!("{}/", local.to_string_lossy().trim_end_matches('/'));
        let child = tokio::process::Command::new("rsync")
            .arg("-az")
            .arg("--delete")
            .arg("-e")
            .arg(self.ssh.rsync_rsh())
            .arg(format!("--rsync-path={remote_rsync}"))
            .arg(&src)
            .arg(format!("{}:{remote_rel}", target(sv)))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .output();
        let out = tokio::time::timeout(Duration::from_secs(600), child)
            .await
            .map_err(|_| Error::timeout("同步插件超时（10 分钟）"))??;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            let last = err.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").to_string();
            return Err(Error::new(Code::SshFailed, format!("rsync 同步失败：{last}")));
        }
        Ok(())
    }

    /// `tar -C <本机目录> -cf - . | ssh … 'rm -rf <远程> && mkdir -p <远程> && tar -C <远程> -xf -'`。
    async fn tar_dir(&self, sv: &Server, local: &Path, remote_rel: &str) -> Result<()> {
        let cfg = self.ssh.clone();
        let tg = target(sv);
        let local_dir = local.to_path_buf();
        let r = quote(remote_rel);
        let remote = format!("cd \"$HOME\" && rm -rf {r} && mkdir -p {r} && tar -C {r} -xf -");
        tokio::task::spawn_blocking(move || -> Result<()> {
            use std::process::{Command, Stdio};
            let mut tar = Command::new("tar")
                .env("COPYFILE_DISABLE", "1")
                .arg("-C")
                .arg(&local_dir)
                .arg("-cf")
                .arg("-")
                .arg(".")
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| Error::internal(format!("无法启动本机 tar：{e}")))?;
            let tar_out = tar.stdout.take().unwrap();
            let out = Command::new("ssh")
                .args(cfg.batch_args())
                .arg("-T")
                .arg(&tg)
                .arg(remote)
                .stdin(Stdio::from(tar_out))
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
                .map_err(|e| Error::internal(format!("无法启动本机 ssh：{e}")))?;
            let _ = tar.wait();
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr).into_owned();
                if out.status.code() == Some(255) {
                    return Err(crate::error::classify_ssh_error(&err));
                }
                return Err(Error::new(Code::SshFailed, format!("tar 同步失败：{}", err.trim())));
            }
            Ok(())
        })
        .await
        .map_err(|e| Error::internal(format!("同步任务异常：{e}")))?
    }
}

/// 兼容旧记录：只有 `plugin` 没有 `plugins` 时补上；`plugin` 始终是 `plugins[0]`。
fn normalize_plugins(s: &mut Session) {
    if s.plugins.is_empty() {
        if let Some(p) = &s.plugin {
            s.plugins.push(p.clone());
        }
    }
    s.plugin = s.plugins.first().cloned();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles() {
        assert_eq!(single_line_title("  hello\n world  "), "hello world");
        let long = "一".repeat(50);
        assert_eq!(single_line_title(&long).chars().count(), 40);
    }

    #[test]
    fn meta_has_fields() {
        let s = Session {
            id: "abc123".into(),
            title: "it's 中文".into(),
            server_id: "s".into(),
            server_alias: "a".into(),
            agent_id: "codex".into(),
            workdir: "~/w".into(),
            tmux: "op-abc123".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            last_active_at: None,
            state: SessionState::Running,
            exit_status: None,
            attached: 0,
            pinned: false,
            archived: false,
            plugin: None,
            plugins: vec![],
            yolo: true,
            preview: None,
            attach_cmd: String::new(),
            origin: Origin::Local,
        };
        let j: serde_json::Value = serde_json::from_str(&meta_json(&s, &Some("--x".into()))).unwrap();
        assert_eq!(j["title"], "it's 中文");
        assert_eq!(j["yolo"], true);
        assert_eq!(j["extra_args"], "--x");
        let script = write_meta_script("abc123", &meta_json(&s, &None));
        assert!(script.contains("> \"$HOME/.outpost/sessions/abc123.json\""));
    }
}
