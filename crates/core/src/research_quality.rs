//! 第四期：远程 rk 对象只透传，规则仍由插件维护。
use crate::error::{git_error_summary, redact, Code, Error, Result};
use crate::model::{ResearchTrust, TrustCommand, TrustFailure};
use crate::shell::quote;
use crate::util::{now_rfc3339, short_id};
use crate::workspace::{cd_workdir, parse_sections, python_test, RESOLVE_HOME};
use crate::Core;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

pub(crate) fn rk_version(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() != "RK_VERSION" {
            return None;
        }
        let value = value.trim();
        let quote = value.chars().next().filter(|c| *c == '\'' || *c == '"')?;
        Some(value[1..].split(quote).next()?.to_string())
    })
}

pub(crate) fn quality_version(version: &str) -> bool {
    let parts: Option<Vec<u64>> =
        version.split('.').map(|s| (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()).collect();
    parts.is_some_and(|p| p.len() == 3 && p.as_slice() >= [0, 6, 0].as_slice())
}

// 包括对象键：rk 可能把 URL 当键，不能只遮值。
fn redact_all(value: &mut Value) {
    match value {
        Value::String(s) => *s = redact(s),
        Value::Array(a) => a.iter_mut().for_each(redact_all),
        Value::Object(m) => {
            *m = std::mem::take(m)
                .into_iter()
                .map(|(k, mut v)| {
                    redact_all(&mut v);
                    (redact(&k), v)
                })
                .collect();
        }
        _ => (),
    }
}

pub(crate) fn safe_object<S: serde::Serializer>(value: &Option<Value>, serializer: S) -> std::result::Result<S::Ok, S::Error> {
    let mut value = value.clone();
    if let Some(v) = &mut value {
        redact_all(v);
    }
    value.serialize(serializer)
}

impl Core {
    pub async fn research_trust(&self, id: &str) -> Result<ResearchTrust> {
        let (session, server) = self.ws_ctx(id).await?;
        let marker = format!("__TRUST_{}__", short_id());
        let script = trust_script(&session.workdir, &marker, 60.0, 145.0);
        let out = self.exec(&server, &script, Duration::from_secs(150)).await?;
        parse_trust(&out.text(), &marker, &out.stderr)
    }
}

pub(crate) fn trust_script(workdir: &str, marker: &str, per_command: f64, total: f64) -> String {
    // 旧版/缺文件时不运行 rk；无 python3 的新版仍 available，但四个命令分别失败。
    format!(
        r#"M={marker}
{cd}{home}
[ -d "$h" ] || {{ echo "$M absent"; exit 0; }}
[ -f "$h/tools/rk.py" ] || {{ echo "$M no_rk"; exit 0; }}
echo "$M version"
head -c 1048576 "$h/tools/rk.py" | sed -n '/^[[:space:]]*RK_VERSION[[:space:]]*=/p' | head -n 1
echo "$M end"
if {python}; then
  python3 -c {runner} "$h" "$M" {per_command} {total}
else
  echo "$M no_python"
fi
"#,
        marker = quote(marker),
        cd = cd_workdir(workdir),
        home = RESOLVE_HOME,
        python = python_test(),
        runner = quote(include_str!("scripts/research_trust.py"))
    )
}

pub(crate) fn parse_trust(text: &str, marker: &str, stderr: &str) -> Result<ResearchTrust> {
    if text.contains("__OP_NOWD__") {
        return Err(Error::not_found("工作目录在服务器上不存在"));
    }
    let sections = parse_sections(text, marker);
    let get = |key: &str| sections.iter().find(|(k, _)| k == key).map(|(_, body)| body.as_str());
    let version = get("version").and_then(rk_version);
    let reason = if get("absent").is_some() {
        Some("没有研究目录")
    } else if get("no_rk").is_some() {
        Some("没有 rk.py")
    } else if get("version").is_none() {
        return Err(Error::new(Code::SshFailed, format!("读取可信度失败：{}", git_error_summary(stderr))));
    } else if !version.as_deref().is_some_and(quality_version) {
        Some("rk.py 旧于 0.6.0（或版本无法识别）：在这台机器上执行 /research:resume 升级研究工具")
    } else {
        None
    };
    let mut result = ResearchTrust {
        available: reason.is_none(),
        reason: reason.map(str::to_string),
        rk_version: version.map(|s| redact(&s)),
        checked_at: now_rfc3339(),
        check: None,
        review: None,
        cite: None,
        plan: None,
        failures: vec![],
    };
    if !result.available {
        return Ok(result);
    }
    for (name, required, command, slot) in [
        ("check", "counts", TrustCommand::Check, &mut result.check),
        ("review", "files", TrustCommand::Review, &mut result.review),
        ("cite", "items", TrustCommand::Cite, &mut result.cite),
        ("plan", "present", TrustCommand::Plan, &mut result.plan),
    ] {
        let envelope = get(name).and_then(|s| serde_json::from_str::<Value>(s).ok());
        let error = match envelope {
            Some(mut v) if v["value"].is_object() => {
                let mut value = v["value"].take();
                if value["ok"] == false && value["error"].is_string() || value.get(required).is_none() {
                    value["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("命令结果缺少必有键：{required}"))
                } else {
                    redact_all(&mut value);
                    *slot = Some(value);
                    continue;
                }
            }
            Some(v) => v["error"].as_str().unwrap_or("命令没有返回 JSON 对象").to_string(),
            None if get("no_python").is_some() => "服务器没有 python3，无法执行研究工具".into(),
            None => format!("命令没有返回完整结果：{}", git_error_summary(stderr)),
        };
        result.failures.push(TrustFailure { command, message: git_error_summary(&error) });
    }
    Ok(result)
}

#[cfg(test)]
#[path = "research_quality_tests.rs"]
pub(crate) mod tests;
