//! 服务器上 tmux 的脚本片段与输出解析。所有操作都在 `tmux -L bunsen` 上。
//! 注意：tmux 会把 `-F` 格式里的制表符输出成 `_`，所以字段分隔用 `|`。

use crate::shell::{quote, quote_path, TMUX};
use crate::util::{is_short_id, rfc3339_from_unix};
use std::collections::BTreeMap;

pub const CONF: &str = "# 由 Bunsen 写入。Bunsen 的会话都跑在专用套接字 tmux -L bunsen 上。\n\
# -q：老版本 tmux 不认识的选项静默忽略，不影响会话启动。\n\
set -gq mouse on\n\
set -gq history-limit 50000\n\
set -gq status off\n\
set -gq remain-on-exit on\n\
set -gq default-terminal \"screen-256color\"\n\
set -sgq escape-time 10\n\
set -gq window-size latest\n";

pub fn agent_session(id: &str) -> String {
    format!("op-{id}")
}
pub fn shell_session(id: &str) -> String {
    format!("op-{id}-sh")
}
pub fn install_session(agent_id: &str) -> String {
    format!("op-install-{agent_id}")
}
/// 精确匹配会话的目标写法（避免 `op-abc123` 前缀匹配到 `op-abc123-sh`）。
pub fn exact(session: &str) -> String {
    format!("={session}")
}
/// 会话当前窗格。
pub fn pane(session: &str) -> String {
    format!("={session}:")
}

/// 确保 `~/.bunsen/` 目录与 tmux.conf 存在（只在缺失时写），输出 `tmux -V`。
/// 没有 tmux 时输出 `__OP_NO_TMUX__`。
pub fn ensure_script() -> String {
    format!(
        "mkdir -p \"$HOME/.bunsen/sessions\" \"$HOME/.bunsen/plugins\"\n\
if [ ! -f \"$HOME/.bunsen/tmux.conf\" ]; then cat > \"$HOME/.bunsen/tmux.conf\" <<'__OP_CONF_EOF__'\n{CONF}__OP_CONF_EOF__\nfi\n\
if ! command -v tmux >/dev/null 2>&1; then echo __OP_NO_TMUX__; exit 0; fi\n\
tmux -V 2>/dev/null || echo 'tmux ?'\n"
    )
}

/// 在新的 tmux 会话里启动命令；会话已存在则以 4 退出。
pub fn new_session_script(session: &str, workdir: &str, command: &str) -> String {
    format!(
        "if tmux -L bunsen has-session -t {ex} 2>/dev/null; then echo '会话 {session} 已存在' >&2; exit 4; fi\n\
{TMUX} new-session -d -s {s} -x 200 -y 50 -c {wd} {cmd} \\; source-file \"$HOME/.bunsen/tmux.conf\" || exit 5\n",
        ex = quote(&exact(session)),
        s = quote(session),
        wd = quote_path(workdir),
        cmd = quote(command),
    )
}

/// 窗格状态：`死|退出码|当前命令`。会话不存在时输出 `__OP_GONE__`。
pub fn pane_state_script(session: &str) -> String {
    format!(
        "if ! tmux -L bunsen has-session -t {ex} 2>/dev/null; then echo __OP_GONE__; exit 0; fi\n\
tmux -L bunsen list-panes -t {p} -F '#{{pane_dead}}|#{{pane_dead_status}}|#{{pane_current_command}}' | head -n 1\n",
        ex = quote(&exact(session)),
        p = quote(&pane(session)),
    )
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PaneState {
    pub dead: bool,
    pub dead_status: Option<i32>,
    pub command: String,
}

/// 解析 `死|退出码|当前命令` 一行。
pub fn parse_pane_line(line: &str) -> Option<PaneState> {
    let mut it = line.trim_end_matches(['\r', '\n']).splitn(3, '|');
    let dead = it.next()?.trim();
    if dead != "0" && dead != "1" {
        return None;
    }
    let status = it.next().unwrap_or("").trim();
    let command = it.next().unwrap_or("").trim().to_string();
    Some(PaneState { dead: dead == "1", dead_status: status.parse().ok(), command })
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RemoteSession {
    pub id: String,
    pub attached: u32,
    pub activity: Option<String>,
    pub pane: Option<PaneState>,
    pub preview: Option<String>,
    pub meta: Option<String>,
}

/// 一次取回：所有 op-<id> 会话、窗格状态、末尾几行预览、`~/.bunsen/sessions/*.json`。
pub fn status_script(marker: &str) -> String {
    format!(
        "M={m}\n\
echo \"$M sessions\"\n\
tmux -L bunsen list-sessions -F '#{{session_name}}|#{{session_attached}}|#{{session_activity}}|#{{window_activity}}' 2>/dev/null\n\
echo \"$M panes\"\n\
tmux -L bunsen list-panes -a -F '#{{session_name}}|#{{pane_dead}}|#{{pane_dead_status}}|#{{pane_current_command}}' 2>/dev/null\n\
for s in $(tmux -L bunsen list-sessions -F '#{{session_name}}' 2>/dev/null | grep -E '^op-[a-z0-9]{{6}}$'); do\n\
  echo \"$M preview ${{s#op-}}\"\n\
  tmux -L bunsen capture-pane -p -J -t \"=$s:\" -S -40 2>/dev/null\n\
done\n\
for f in \"$HOME\"/.bunsen/sessions/*.json; do\n\
  [ -f \"$f\" ] || continue\n\
  n=$(basename \"$f\" .json)\n\
  echo \"$M meta $n\"\n\
  head -c 65536 \"$f\"; echo\n\
done\n\
echo \"$M end\"\n",
        m = quote(marker)
    )
}

/// 预览：末尾最多 5 行非空文本。
pub fn make_preview(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    let start = lines.len().saturating_sub(5);
    Some(lines[start..].join("\n"))
}

/// 解析 `status_script` 的输出，键是会话 id（不含 `op-`）。只收 `op-<6位id>` 形式的代理会话。
pub fn parse_status(out: &str, marker: &str) -> BTreeMap<String, RemoteSession> {
    #[derive(PartialEq)]
    enum Sec {
        None,
        Sessions,
        Panes,
        Preview(String),
        Meta(String),
    }
    let mut map: BTreeMap<String, RemoteSession> = BTreeMap::new();
    let mut metas: BTreeMap<String, String> = BTreeMap::new();
    let mut previews: BTreeMap<String, String> = BTreeMap::new();
    let mut sec = Sec::None;
    let prefix = format!("{marker} ");
    let id_of = |name: &str| -> Option<String> { name.strip_prefix("op-").filter(|r| is_short_id(r)).map(str::to_string) };
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            let mut parts = rest.splitn(2, ' ');
            sec = match (parts.next().unwrap_or(""), parts.next()) {
                ("sessions", _) => Sec::Sessions,
                ("panes", _) => Sec::Panes,
                ("preview", Some(id)) => Sec::Preview(id.trim().to_string()),
                ("meta", Some(id)) => Sec::Meta(id.trim().to_string()),
                _ => Sec::None,
            };
            continue;
        }
        match &sec {
            Sec::Sessions => {
                // 名字|连接数|会话活动时间|窗口活动时间（取两者较晚的）
                let f: Vec<&str> = line.splitn(4, '|').collect();
                if let Some(id) = f.first().and_then(|n| id_of(n)) {
                    let e = map.entry(id.clone()).or_insert_with(|| RemoteSession { id, ..Default::default() });
                    e.attached = f.get(1).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    let t = |i: usize| f.get(i).and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
                    e.activity = Some(t(2).max(t(3))).filter(|&t| t > 0).map(rfc3339_from_unix);
                }
            }
            Sec::Panes => {
                if let Some((name, rest)) = line.split_once('|') {
                    if let (Some(id), Some(p)) = (id_of(name), parse_pane_line(rest)) {
                        if let Some(e) = map.get_mut(&id) {
                            if e.pane.is_none() {
                                e.pane = Some(p);
                            }
                        }
                    }
                }
            }
            Sec::Preview(id) => {
                let buf = previews.entry(id.clone()).or_default();
                buf.push_str(line);
                buf.push('\n');
            }
            Sec::Meta(id) => {
                let buf = metas.entry(id.clone()).or_default();
                buf.push_str(line);
                buf.push('\n');
            }
            Sec::None => {}
        }
    }
    for (id, text) in previews {
        if let Some(e) = map.get_mut(&id) {
            e.preview = make_preview(&text);
        }
    }
    for (id, text) in metas {
        if let Some(e) = map.get_mut(&id) {
            e.meta = Some(text.trim().to_string());
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_line() {
        assert_eq!(parse_pane_line("0||bash"), Some(PaneState { dead: false, dead_status: None, command: "bash".into() }));
        assert_eq!(parse_pane_line("1|3|fake-agent"), Some(PaneState { dead: true, dead_status: Some(3), command: "fake-agent".into() }));
        assert_eq!(parse_pane_line("1|127|a|b"), Some(PaneState { dead: true, dead_status: Some(127), command: "a|b".into() }));
        assert_eq!(parse_pane_line("x|1|a"), None);
        assert_eq!(parse_pane_line(""), None);
    }

    #[test]
    fn status_output() {
        let m = "__OPM_x1__";
        let out = format!(
            "{m} sessions\nop-abc123|1|1794492000|1794492865\nop-abc123-sh|0|1794492865\nop-install-codex|0|1\nother|0|1\nop-zzz999|0|0\n\
{m} panes\nop-abc123|0||bash\nop-abc123|1|9|second-pane\nop-abc123-sh|0||bash\nop-zzz999|1|3|bash\n\
{m} preview abc123\nline1\n\n  line2  \n{m} preview zzz999\n\n\n\
{m} meta abc123\n{{\"id\":\"abc123\",\"title\":\"t\"}}\n{m} meta gone00\n{{}}\n{m} end\n"
        );
        let r = parse_status(&out, m);
        assert_eq!(r.keys().cloned().collect::<Vec<_>>(), ["abc123", "zzz999"]);
        let a = &r["abc123"];
        assert_eq!(a.attached, 1);
        assert_eq!(a.activity.as_deref(), Some("2026-11-12T14:14:25Z"));
        assert!(!a.pane.as_ref().unwrap().dead);
        assert_eq!(a.preview.as_deref(), Some("line1\n  line2"));
        assert_eq!(a.meta.as_deref(), Some("{\"id\":\"abc123\",\"title\":\"t\"}"));
        let z = &r["zzz999"];
        assert_eq!(z.pane.as_ref().unwrap().dead_status, Some(3));
        assert_eq!(z.activity, None);
        assert_eq!(z.preview, None);
    }

    #[test]
    fn empty_status_when_no_server() {
        let m = "__M__";
        let r = parse_status(&format!("{m} sessions\n{m} panes\n{m} end\n"), m);
        assert!(r.is_empty());
    }

    #[test]
    fn preview_keeps_last_five() {
        let t = (1..=9).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n");
        assert_eq!(make_preview(&t).unwrap(), "l5\nl6\nl7\nl8\nl9");
    }

    #[test]
    fn scripts_use_exact_targets() {
        let s = new_session_script("op-abc123", "~/w x", "bash -lc 'x'");
        assert!(s.contains("has-session -t =op-abc123 "));
        assert!(s.contains("new-session -d -s op-abc123 -x 200 -y 50 -c \"$HOME\"/'w x' 'bash -lc '\\''x'\\'''"));
        assert!(pane_state_script("op-abc123").contains("-t =op-abc123:"));
        assert!(ensure_script().contains("set -gq remain-on-exit on"));
    }
}
