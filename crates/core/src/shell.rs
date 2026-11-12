//! shell 转义、PATH 前导与启动命令拼装。

use crate::error::{Error, Result};
use crate::model::Agent;

/// POSIX shell 单引号转义：安全字符原样，其余整体放进单引号，内部的 `'` 写成 `'\''`。
/// NUL 无法出现在 shell 参数里，直接去掉。
pub fn quote(s: &str) -> String {
    let s: String = s.chars().filter(|&c| c != '\0').collect();
    if s.is_empty() {
        return "''".to_string();
    }
    let safe = s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./:=@%+,-".contains(&b));
    if safe {
        return s;
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// 远程路径转义，保留 `~` 的含义：`~` → `"$HOME"`，`~/x y` → `"$HOME"/'x y'`。
pub fn quote_path(p: &str) -> String {
    if p == "~" || p.is_empty() {
        return "\"$HOME\"".to_string();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if rest.is_empty() {
            return "\"$HOME\"".to_string();
        }
        return format!("\"$HOME\"/{}", quote(rest));
    }
    quote(p)
}

/// 远程命令统一的 PATH 前导（单行，可嵌进 `bash -lc '…'`）。
pub const PATH_PRELUDE: &str = concat!(
    "export PATH=\"$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.opencode/bin:/usr/local/bin:$PATH\"; ",
    "for __op_d in \"$HOME\"/.nvm/versions/node/*/bin; do if [ -d \"$__op_d\" ]; then PATH=\"$__op_d:$PATH\"; fi; done; ",
    "if [ -f \"$HOME/.bunsen/env.sh\" ]; then . \"$HOME/.bunsen/env.sh\"; fi"
);

/// 服务器上的 tmux 前缀。
pub const TMUX: &str = "tmux -L bunsen -f \"$HOME/.bunsen/tmux.conf\"";

/// 把脚本包成 `{ 前导; 脚本 } </dev/null`，送进 `bash -s`。
pub fn wrap_script(body: &str) -> String {
    format!("{{\n{PATH_PRELUDE}\n{body}\n}} </dev/null\n")
}

/// 插件在服务器上的目录（`~` 开头，交给 quote_path）。
pub fn plugin_dir(name: &str) -> String {
    format!("~/.bunsen/plugins/{name}")
}

/// 启动参数。
#[derive(Debug, Clone, Default)]
pub struct LaunchOpts<'a> {
    pub prompt: Option<&'a str>,
    pub yolo: bool,
    /// 要加载的插件名（已同步到 `~/.bunsen/plugins/<name>`）
    pub plugins: &'a [String],
    pub extra_args: Option<&'a str>,
    pub resume: bool,
}

/// 拼装结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Launch {
    /// 一条 shell 命令行
    pub cmd: String,
    /// 实际的初始提示（插件提示 + 用户提示），没有则为 None
    pub prompt: Option<String>,
    /// 提示是否已经放进命令行；为假且 `prompt` 有值时由调用方在启动后粘贴
    pub prompt_in_cmd: bool,
}

/// 实际的初始提示：Agent 没有 `plugin_dir_flag` 而 `plugin_prompt` 非空时，把它（`{dirs}` 换成
/// 逗号分隔的远程插件目录）放在用户提示前面。接续（用 resume 命令）时不加。
pub fn effective_prompt(agent: &Agent, o: &LaunchOpts) -> Option<String> {
    let user = o.prompt.filter(|p| !p.trim().is_empty()).map(str::to_string);
    if resuming(agent, o) {
        return None;
    }
    let prefix = if !o.plugins.is_empty() && agent.plugin_dir_flag.as_deref().is_none_or(|f| f.trim().is_empty()) {
        agent.plugin_prompt.as_deref().filter(|t| !t.trim().is_empty()).map(|t| {
            let dirs: Vec<String> = o.plugins.iter().map(|n| plugin_dir(n)).collect();
            t.replace("{dirs}", &dirs.join(","))
        })
    } else {
        None
    };
    match (prefix, user) {
        (Some(p), Some(u)) => Some(format!("{p}\n\n{u}")),
        (Some(p), None) => Some(p),
        (None, u) => u,
    }
}

fn resuming(agent: &Agent, o: &LaunchOpts) -> bool {
    o.resume && agent.resume.as_deref().is_some_and(|r| !r.trim().is_empty())
}

/// 拼出代理的启动命令。
/// - `resume` 为真且 Agent 有 `resume` → 用它；
/// - 有提示且有 `launch_with_prompt` → `{prompt}` 换成转义后的提示；
/// - 否则用 `launch`（有提示时由调用方在启动后粘贴进去）；
/// - 依次追加 `yolo_flag`、每个插件一次 `plugin_dir_flag`（`{dir}` → `~/.bunsen/plugins/<name>`）、`extra_args`。
pub fn build_launch(agent: &Agent, o: &LaunchOpts) -> Result<Launch> {
    let prompt = effective_prompt(agent, o);
    let mut prompt_in_cmd = false;
    let mut cmd = if resuming(agent, o) {
        agent.resume.clone().unwrap()
    } else if let (Some(p), Some(tpl)) = (prompt.as_deref(), agent.launch_with_prompt.as_deref()) {
        if !tpl.contains("{prompt}") {
            return Err(Error::bad_request(format!("Agent {} 的 launch_with_prompt 里没有 {{prompt}} 占位符", agent.id)));
        }
        prompt_in_cmd = true;
        tpl.replace("{prompt}", &quote(p))
    } else {
        agent.launch.clone()
    };
    if cmd.trim().is_empty() {
        return Err(Error::bad_request(format!("Agent {} 没有启动命令", agent.id)));
    }
    if o.yolo {
        if let Some(f) = agent.yolo_flag.as_deref().filter(|f| !f.trim().is_empty()) {
            cmd.push(' ');
            cmd.push_str(f.trim());
        }
    }
    if let Some(f) = agent.plugin_dir_flag.as_deref().filter(|f| !f.trim().is_empty()) {
        for name in o.plugins {
            cmd.push(' ');
            cmd.push_str(&f.trim().replace("{dir}", &quote_path(&plugin_dir(name))));
        }
    }
    if let Some(extra) = o.extra_args.map(str::trim).filter(|e| !e.is_empty()) {
        cmd.push(' ');
        cmd.push_str(extra);
    }
    Ok(Launch { cmd, prompt, prompt_in_cmd })
}

/// tmux 窗格里实际运行的命令：`bash -lc '<前导>; cd <workdir> && exec <启动命令>'`。
pub fn pane_command(workdir: &str, launch: &str) -> String {
    let inner = format!("{PATH_PRELUDE}; cd {} && exec {launch}", quote_path(workdir));
    format!("bash -lc {}", quote(&inner))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// 用本机 sh 解析转义结果，确认还原出原文。
    fn sh_roundtrip(s: &str) -> String {
        let out = Command::new("sh").arg("-c").arg(format!("printf '%s' {}", quote(s))).output().unwrap();
        String::from_utf8(out.stdout).unwrap()
    }

    #[test]
    fn quote_basic() {
        assert_eq!(quote(""), "''");
        assert_eq!(quote("abc-1.2_x/y"), "abc-1.2_x/y");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), "'it'\\''s'");
        assert_eq!(quote("a\0b"), "ab");
    }

    #[test]
    fn quote_roundtrip_hard_cases() {
        for s in [
            "it's",
            "'",
            "''",
            "line1\nline2\n",
            "中文提示：你好",
            "$HOME $(whoami) ${x}",
            "`id` and `uname`",
            "back\\slash \\n",
            "tab\there",
            "!history ~tilde *glob ?q [a] {b} | & ; < > #",
            "混合 'quote' \"dq\" $v `bt`\n第二行",
        ] {
            assert_eq!(sh_roundtrip(s), s, "原文：{s:?}");
        }
    }

    #[test]
    fn quote_nested_two_levels() {
        // 提示 → launch 命令 → bash -lc 再转义一层，sh 执行后应还原原文。
        let p = "it's 中文 $x `y`";
        let inner = format!("printf '%s' {}", quote(p));
        let outer = format!("sh -c {}", quote(&inner));
        let out = Command::new("sh").arg("-c").arg(&outer).output().unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), p);
    }

    #[test]
    fn quote_path_keeps_tilde() {
        assert_eq!(quote_path("~"), "\"$HOME\"");
        assert_eq!(quote_path("~/"), "\"$HOME\"");
        assert_eq!(quote_path("~/proj"), "\"$HOME\"/proj");
        assert_eq!(quote_path("~/my proj"), "\"$HOME\"/'my proj'");
        assert_eq!(quote_path("/data/x y"), "'/data/x y'");
        assert_eq!(quote_path("rel"), "rel");
        let out = Command::new("sh")
            .arg("-c")
            .arg(format!("printf '%s' {}", quote_path("~/a b")))
            .env("HOME", "/h")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), "/h/a b");
    }

    fn agent() -> Agent {
        Agent {
            id: "claude-code".into(),
            name: "Claude Code".into(),
            vendor: String::new(),
            description: String::new(),
            detect: "claude".into(),
            launch: "claude".into(),
            launch_with_prompt: Some("claude {prompt}".into()),
            resume: Some("claude --continue".into()),
            yolo_flag: Some("--dangerously-skip-permissions".into()),
            plugin_dir_flag: Some("--plugin-dir {dir}".into()),
            plugin_prompt: None,
            install: vec![],
            auth_hint: String::new(),
            docs_url: String::new(),
            builtin: true,
        }
    }

    #[test]
    fn launch_assembly() {
        let a = agent();
        let none: Vec<String> = vec![];
        let research = vec!["research".to_string()];
        let two = vec!["research".to_string(), "lab".to_string()];
        let l = build_launch(&a, &LaunchOpts::default()).unwrap();
        assert_eq!((l.cmd.as_str(), l.prompt_in_cmd, l.prompt), ("claude", false, None));

        let l = build_launch(&a, &LaunchOpts { prompt: Some("it's 中文"), ..Default::default() }).unwrap();
        assert_eq!(l.cmd, "claude 'it'\\''s 中文'");
        assert!(l.prompt_in_cmd);

        let o = LaunchOpts { prompt: Some("hi"), yolo: true, plugins: &two, extra_args: Some("  --model opus "), resume: false };
        let l = build_launch(&a, &o).unwrap();
        assert_eq!(
            l.cmd,
            "claude hi --dangerously-skip-permissions --plugin-dir \"$HOME\"/.bunsen/plugins/research --plugin-dir \"$HOME\"/.bunsen/plugins/lab --model opus"
        );
        // 有 plugin_dir_flag 时不加插件提示。
        assert_eq!(l.prompt.as_deref(), Some("hi"));

        let l = build_launch(&a, &LaunchOpts { resume: true, prompt: Some("x"), yolo: true, plugins: &research, ..Default::default() }).unwrap();
        assert_eq!(l.cmd, "claude --continue --dangerously-skip-permissions --plugin-dir \"$HOME\"/.bunsen/plugins/research");
        assert!(!l.prompt_in_cmd);
        assert_eq!(l.prompt, None);

        // 没有 launch_with_prompt：用 launch，提示由调用方稍后粘贴。
        let mut b = a.clone();
        b.launch_with_prompt = None;
        b.yolo_flag = None;
        b.plugin_dir_flag = None;
        let l = build_launch(&b, &LaunchOpts { prompt: Some("x"), yolo: true, plugins: &research, ..Default::default() }).unwrap();
        assert_eq!((l.cmd.as_str(), l.prompt_in_cmd, l.prompt.as_deref()), ("claude", false, Some("x")));

        // 空白提示视为没有提示。
        let l = build_launch(&a, &LaunchOpts { prompt: Some("  "), plugins: &none, ..Default::default() }).unwrap();
        assert_eq!((l.cmd.as_str(), l.prompt_in_cmd), ("claude", false));

        let mut bad = a.clone();
        bad.launch_with_prompt = Some("claude".into());
        assert!(build_launch(&bad, &LaunchOpts { prompt: Some("x"), ..Default::default() }).is_err());
    }

    #[test]
    fn plugin_prompt_prefix() {
        let mut c = agent();
        c.id = "codex".into();
        c.launch = "codex".into();
        c.plugin_dir_flag = None;
        c.resume = Some("codex resume --last".into());
        c.launch_with_prompt = Some("codex {prompt}".into());
        c.plugin_prompt = Some("文档在 {dirs}，先读。".into());
        let two = vec!["research".to_string(), "lab".to_string()];
        let l = build_launch(&c, &LaunchOpts { prompt: Some("做实验"), plugins: &two, ..Default::default() }).unwrap();
        assert_eq!(l.prompt.as_deref(), Some("文档在 ~/.bunsen/plugins/research,~/.bunsen/plugins/lab，先读。\n\n做实验"));
        assert!(l.cmd.starts_with("codex '文档在 ~/.bunsen/plugins/research,"));
        // 没有用户提示：插件提示单独作为初始提示。
        let l = build_launch(&c, &LaunchOpts { plugins: &two, ..Default::default() }).unwrap();
        assert_eq!(l.prompt.as_deref(), Some("文档在 ~/.bunsen/plugins/research,~/.bunsen/plugins/lab，先读。"));
        // 不带插件：没有插件提示。
        let l = build_launch(&c, &LaunchOpts::default()).unwrap();
        assert_eq!((l.cmd.as_str(), l.prompt), ("codex", None));
        // 接续时不重复加提示。
        let l = build_launch(&c, &LaunchOpts { plugins: &two, resume: true, ..Default::default() }).unwrap();
        assert_eq!((l.cmd.as_str(), l.prompt), ("codex resume --last", None));
        // 没有 resume 命令的 restart 是重新开始：带上插件提示。
        c.resume = None;
        let l = build_launch(&c, &LaunchOpts { plugins: &two, resume: true, ..Default::default() }).unwrap();
        assert!(l.prompt_in_cmd && l.prompt.is_some());
    }

    #[test]
    fn pane_command_runs_in_sh() {
        // 在本机用 sh 执行窗格命令的外层（bash -lc），验证多层转义后提示原样到达。
        let a = Agent { launch_with_prompt: Some("printf '[%s]' {prompt}".into()), ..agent() };
        let l = build_launch(&a, &LaunchOpts { prompt: Some("it's 中文 $HOME `x`\n2"), ..Default::default() }).unwrap();
        let cmd = pane_command("/tmp", &l.cmd);
        assert!(cmd.starts_with("bash -lc '"));
        // 本机测试不读用户的登录配置。
        let cmd = cmd.replacen("bash -lc ", "bash --noprofile --norc -c ", 1);
        let out = Command::new("sh").arg("-c").arg(&cmd).env("HOME", "/nonexistent-bunsen-test").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "[it's 中文 $HOME `x`\n2]");
    }

    #[test]
    fn wrap_script_shape() {
        let s = wrap_script("echo hi");
        assert!(s.starts_with("{\nexport PATH="));
        assert!(s.ends_with("} </dev/null\n"));
        let out = Command::new("bash").arg("-s").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().and_then(|mut c| {
            use std::io::Write;
            c.stdin.take().unwrap().write_all(s.as_bytes())?;
            c.wait_with_output()
        }).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "hi\n");
    }
}
