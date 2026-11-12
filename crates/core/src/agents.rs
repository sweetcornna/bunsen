//! Agent 表：内置项来自 `crates/core/agents.json`（改数据只改那个文件），
//! 自定义与被覆盖的项存在数据目录的 `agents.json`。

use crate::error::{Error, Result};
use crate::model::Agent;
use std::sync::OnceLock;

const BUILTIN_JSON: &str = include_str!("../agents.json");

pub fn builtins() -> &'static [Agent] {
    static CELL: OnceLock<Vec<Agent>> = OnceLock::new();
    CELL.get_or_init(|| {
        let mut v: Vec<Agent> = serde_json::from_str(BUILTIN_JSON).expect("内置 agents.json 格式错误");
        for a in &mut v {
            a.builtin = true;
        }
        v
    })
}

pub fn is_builtin(id: &str) -> bool {
    builtins().iter().any(|a| a.id == id)
}

/// 合并：内置在前（被覆盖的用覆盖版本），自定义在后（按保存顺序）。
pub fn merge(custom: &[Agent]) -> Vec<Agent> {
    let mut out: Vec<Agent> = builtins()
        .iter()
        .map(|b| {
            let mut a = custom.iter().find(|c| c.id == b.id).cloned().unwrap_or_else(|| b.clone());
            a.builtin = true;
            a
        })
        .collect();
    for c in custom.iter().filter(|c| !is_builtin(&c.id)) {
        let mut a = c.clone();
        a.builtin = false;
        out.push(a);
    }
    out
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

/// 校验并规整一个将要保存的 Agent。
pub fn validate(id: &str, mut a: Agent) -> Result<Agent> {
    if !valid_id(id) {
        return Err(Error::bad_request(format!("Agent id“{id}”不合法"))
            .with_hint("只能用小写字母、数字、点、下划线和连字符，以字母或数字开头，最长 48 个字符"));
    }
    a.id = id.to_string();
    a.builtin = is_builtin(id);
    a.name = a.name.trim().to_string();
    a.detect = a.detect.trim().to_string();
    a.launch = a.launch.trim().to_string();
    if a.name.is_empty() {
        return Err(Error::bad_request("Agent 名称不能为空"));
    }
    if a.detect.is_empty() || !a.detect.bytes().all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b)) {
        return Err(Error::bad_request(format!("detect“{}”不合法", a.detect)).with_hint("填服务器上可执行文件的名字，例如 claude"));
    }
    if a.launch.is_empty() {
        return Err(Error::bad_request("launch 不能为空"));
    }
    let norm = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    a.launch_with_prompt = norm(a.launch_with_prompt);
    a.resume = norm(a.resume);
    a.yolo_flag = norm(a.yolo_flag);
    a.plugin_dir_flag = norm(a.plugin_dir_flag);
    if let Some(t) = &a.launch_with_prompt {
        if !t.contains("{prompt}") {
            return Err(Error::bad_request("launch_with_prompt 必须包含 {prompt} 占位符"));
        }
    }
    if let Some(t) = &a.plugin_dir_flag {
        if !t.contains("{dir}") {
            return Err(Error::bad_request("plugin_dir_flag 必须包含 {dir} 占位符"));
        }
    }
    for field in [Some(&a.launch), a.launch_with_prompt.as_ref(), a.resume.as_ref(), a.yolo_flag.as_ref(), a.plugin_dir_flag.as_ref()]
        .into_iter()
        .flatten()
    {
        crate::sshconfig::validate_single_line("命令", field)?;
    }
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_table() {
        let b = builtins();
        let ids: Vec<_> = b.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["claude-code", "codex", "gemini", "qwen", "opencode", "cursor-agent", "aider", "shell"]);
        assert!(b.iter().all(|a| a.builtin));
        let c = &b[0];
        assert_eq!(c.plugin_dir_flag.as_deref(), Some("--plugin-dir {dir}"));
        assert_eq!(c.install.len(), 2);
        let shell = b.iter().find(|a| a.id == "shell").unwrap();
        assert_eq!(shell.launch, "bash -l");
        assert!(shell.install.is_empty());
        for a in b {
            validate(&a.id, a.clone()).unwrap();
        }
    }

    #[test]
    fn merge_override_and_custom() {
        let mut over = builtins()[1].clone();
        over.name = "Codex（改）".into();
        let custom = Agent { id: "fake".into(), builtin: true, ..builtins()[0].clone() };
        let m = merge(&[custom, over]);
        assert_eq!(m.len(), builtins().len() + 1);
        assert_eq!(m[1].name, "Codex（改）");
        assert!(m[1].builtin);
        assert_eq!(m.last().unwrap().id, "fake");
        assert!(!m.last().unwrap().builtin);
    }

    #[test]
    fn validation_rules() {
        let base = builtins()[0].clone();
        assert!(validate("Bad Id", base.clone()).is_err());
        assert!(validate("ok-id", Agent { detect: "rm -rf".into(), ..base.clone() }).is_err());
        assert!(validate("ok-id", Agent { launch_with_prompt: Some("x".into()), ..base.clone() }).is_err());
        let a = validate("ok-id", Agent { resume: Some("  ".into()), ..base }).unwrap();
        assert_eq!(a.resume, None);
        assert!(!a.builtin);
    }
}
