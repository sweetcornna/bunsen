//! 错误类型：统一映射到 API.md 第 0 节的错误码，`message` 与 `hint` 用中文。

use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    Unauthorized,
    Forbidden,
    NotFound,
    BadRequest,
    Conflict,
    SshFailed,
    AuthFailed,
    HostUnreachable,
    TmuxMissing,
    AgentMissing,
    Timeout,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Unauthorized => "unauthorized",
            Code::Forbidden => "forbidden",
            Code::NotFound => "not_found",
            Code::BadRequest => "bad_request",
            Code::Conflict => "conflict",
            Code::SshFailed => "ssh_failed",
            Code::AuthFailed => "auth_failed",
            Code::HostUnreachable => "host_unreachable",
            Code::TmuxMissing => "tmux_missing",
            Code::AgentMissing => "agent_missing",
            Code::Timeout => "timeout",
            Code::Internal => "internal",
        }
    }

    /// HTTP 状态码。`auth_failed` 指 ssh 认证失败，不用 401，免得界面误以为令牌失效。
    pub fn http_status(self) -> u16 {
        match self {
            Code::Unauthorized => 401,
            Code::Forbidden => 403,
            Code::NotFound => 404,
            Code::BadRequest => 400,
            Code::Conflict => 409,
            Code::TmuxMissing | Code::AgentMissing => 422,
            Code::SshFailed | Code::AuthFailed | Code::HostUnreachable => 502,
            Code::Timeout => 504,
            Code::Internal => 500,
        }
    }
}

/// 对外的错误体：`{"code","message","hint"}`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Error {
    pub code: Code,
    #[serde(serialize_with = "safe_text")]
    pub message: String,
    #[serde(serialize_with = "safe_optional")]
    pub hint: Option<String>,
}

pub type Result<T> = std::result::Result<T, Error>;

/// G20：在诊断文本离开内核或写盘前遮掉所有 URL authority 中的 userinfo。
/// 不依赖协议种类，也不解码/复述凭据；保留主机和路径供定位。
pub fn redact(text: &str) -> String {
    let mut result = String::new();
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find("://") {
        let start = cursor + offset + 3;
        result.push_str(&text[cursor..start]);
        let end = text[start..]
            .char_indices()
            .find(|(_, c)| c.is_whitespace() || "/?#\"<>".contains(*c))
            .map(|(n, _)| start + n)
            .unwrap_or(text.len());
        let authority = &text[start..end];
        if let Some(at) = authority.rfind('@') {
            result.push_str("***@");
            cursor = start + at + 1;
        } else {
            cursor = start;
        }
        // 只消费 userinfo，不越过后续 URL 的 scheme（例如逗号相连的无路径 URL）。
    }
    result.push_str(&text[cursor..]);
    result
}

/// G22：只丢弃 Git 的固定尾注，保留最后三行真正原因；脱敏后按 Unicode 字符截断。
pub fn git_error_summary(text: &str) -> String {
    let mut lines = std::collections::VecDeque::with_capacity(3);
    for line in text.lines().map(str::trim).filter(|line| {
        !line.is_empty() && *line != "Please make sure you have the correct access rights" && *line != "and the repository exists."
    }) {
        if lines.len() == 3 {
            lines.pop_front();
        }
        lines.push_back(line);
    }
    let summary = if lines.is_empty() { "没有输出".into() } else { lines.into_iter().collect::<Vec<_>>().join("；") };
    redact(&summary).chars().take(300).collect()
}

/// 包括嵌套 rk 原始结果；不改需要用于连接的 hub/url 等配置字段。
pub(crate) fn redact_value(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => *s = redact(s),
        serde_json::Value::Array(a) => a.iter_mut().for_each(redact_value),
        serde_json::Value::Object(m) => m.values_mut().for_each(redact_value),
        _ => (),
    }
}

pub(crate) fn redact_diagnostics(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(m) => {
            for (k, v) in m {
                if matches!(k.as_str(), "error" | "message" | "hint" | "detail" | "status_detail" | "warnings" | "fetch_error") {
                    redact_value(v);
                } else {
                    redact_diagnostics(v);
                }
            }
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(redact_diagnostics),
        _ => (),
    }
}
pub(crate) fn safe_text<S: serde::Serializer>(s: &str, serializer: S) -> std::result::Result<S::Ok, S::Error> {
    serializer.serialize_str(&redact(s))
}
pub(crate) fn safe_optional<S: serde::Serializer>(s: &Option<String>, serializer: S) -> std::result::Result<S::Ok, S::Error> {
    use serde::Serialize;
    s.as_ref().map(|s| redact(s)).serialize(serializer)
}
pub(crate) fn safe_warnings<S: serde::Serializer>(s: &[String], serializer: S) -> std::result::Result<S::Ok, S::Error> {
    use serde::Serialize;
    s.iter().map(|s| redact(s)).collect::<Vec<_>>().serialize(serializer)
}
pub(crate) fn safe_result<S: serde::Serializer>(s: &Option<serde_json::Value>, serializer: S) -> std::result::Result<S::Ok, S::Error> {
    use serde::Serialize;
    let mut value = s.clone();
    if let Some(v) = &mut value {
        redact_value(v);
    }
    value.serialize(serializer)
}

impl Error {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Error { code, message: redact(&message.into()), hint: None }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(redact(&hint.into()));
        self
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::new(Code::NotFound, m)
    }
    pub fn bad_request(m: impl Into<String>) -> Self {
        Self::new(Code::BadRequest, m)
    }
    pub fn conflict(m: impl Into<String>) -> Self {
        Self::new(Code::Conflict, m)
    }
    pub fn internal(m: impl Into<String>) -> Self {
        Self::new(Code::Internal, m)
    }
    pub fn timeout(m: impl Into<String>) -> Self {
        Self::new(Code::Timeout, m)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}：{}", self.code.as_str(), redact(&self.message))?;
        if let Some(h) = &self.hint {
            write!(f, "（{}）", redact(h))?;
        }
        Ok(())
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::internal(format!("本机文件或进程操作失败：{e}"))
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::internal(format!("JSON 处理失败：{e}"))
    }
}

/// 把 ssh 客户端（退出码 255）的标准错误识别成错误码和中文提示。
pub fn classify_ssh_error(stderr: &str) -> Error {
    let s = stderr;
    let lower = s.to_ascii_lowercase();
    let last = last_meaningful_line(s);
    if lower.contains("permission denied") || lower.contains("too many authentication failures") {
        return Error::new(Code::AuthFailed, "认证失败：服务器拒绝了这把密钥或这个用户").with_hint(
            "检查用户名与私钥是否匹配；服务器的 ~/.ssh/authorized_keys 里要有对应公钥。也可以在“测试连接”里勾选“逐把尝试已保存的密钥”",
        );
    }
    if lower.contains("host key verification failed") || lower.contains("remote host identification has changed") {
        return Error::new(Code::SshFailed, "主机密钥校验失败：服务器的主机密钥和上次记录的不一样")
            .with_hint("如果确认是服务器重装等正常变化，删除数据目录里 ssh/known_hosts 中对应的行后重试");
    }
    if lower.contains("could not resolve hostname")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
    {
        return Error::new(Code::HostUnreachable, "无法解析主机名")
            .with_hint("检查服务器地址（HostName）是否写对，本机网络或 DNS 是否正常");
    }
    if lower.contains("connection refused") {
        return Error::new(Code::HostUnreachable, "连接被拒绝：对方端口没有在监听")
            .with_hint("确认地址和端口正确、服务器上的 sshd 在运行、防火墙放行了该端口");
    }
    if lower.contains("timed out") {
        return Error::new(Code::Timeout, "连接超时").with_hint("服务器可能关机、不在同一网络，或需要先连 VPN / 跳板机");
    }
    if lower.contains("no route to host")
        || lower.contains("network is unreachable")
        || lower.contains("connection reset")
        || lower.contains("connection closed by")
    {
        return Error::new(Code::HostUnreachable, format!("连不上服务器：{last}"))
            .with_hint("检查网络、地址与端口；如需跳板机请设置 ProxyJump");
    }
    if lower.contains("bad permissions")
        || lower.contains("invalid format")
        || lower.contains("incorrect passphrase")
        || lower.contains("load key")
    {
        return Error::new(Code::AuthFailed, format!("私钥无法使用：{last}"))
            .with_hint("带口令的私钥目前不支持；请上传无口令的私钥，或换一把密钥");
    }
    let msg = if last.is_empty() { "ssh 连接失败".to_string() } else { format!("ssh 连接失败：{last}") };
    Error::new(Code::SshFailed, msg)
}

fn last_meaningful_line(s: &str) -> String {
    let s = redact(s);
    s.lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty() && !l.starts_with("Warning: Permanently added"))
        .unwrap_or("")
        .chars()
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_common_failures() {
        let c = |s: &str| classify_ssh_error(s).code;
        assert_eq!(c("dev@127.0.0.1: Permission denied (publickey)."), Code::AuthFailed);
        assert_eq!(c("Received disconnect from 1.2.3.4 port 22:2: Too many authentication failures"), Code::AuthFailed);
        assert_eq!(c("ssh: connect to host 127.0.0.1 port 2223: Connection refused"), Code::HostUnreachable);
        assert_eq!(c("ssh: connect to host 10.9.9.9 port 22: Operation timed out"), Code::Timeout);
        assert_eq!(c("ssh: connect to host 10.9.9.9 port 22: Connection timed out"), Code::Timeout);
        assert_eq!(c("Connection timed out during banner exchange"), Code::Timeout);
        assert_eq!(c("ssh: Could not resolve hostname nope.invalid: nodename nor servname provided, or not known"), Code::HostUnreachable);
        assert_eq!(c("@@@@@\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed."), Code::SshFailed);
        assert_eq!(c("Host key verification failed."), Code::SshFailed);
        assert_eq!(c("kex_exchange_identification: read: Connection reset by peer"), Code::HostUnreachable);
        assert_eq!(c("something odd"), Code::SshFailed);
        let e = classify_ssh_error("Host key verification failed.");
        assert!(e.message.contains("主机密钥"));
        assert!(e.hint.unwrap().contains("known_hosts"));
    }

    #[test]
    fn redact_multiple_urls_and_long_userinfo_before_truncation() {
        let secret = format!("https://USER:{}@host/p", "TOKEN".repeat(150));
        let text = format!("asked for {secret}; redirect ssh://name:secret@other/x and git://public/path");
        let safe = redact(&text);
        assert_eq!(safe, "asked for https://***@host/p; redirect ssh://***@other/x and git://public/path");
        assert_eq!(redact(&safe), safe);
        assert_eq!(redact("https://public,ssh://name:secret@other"), "https://public,ssh://***@other");
        assert_eq!(redact("https://a:b@first,https://c:d@second"), "https://***@first,https://***@second");
        assert!(!last_meaningful_line(&text).contains("TOKEN"));
        let out = crate::ssh::RemoteOutput { code: 1, stdout: vec![], stderr: text, elapsed: std::time::Duration::ZERO };
        assert!(!out.err_line().contains("TOKEN"));
    }

    #[test]
    fn rfc3986_userinfo_redacted_before_json() {
        for cred in ["user:pa'ss", "user:pa%40ss", "user:pa:ss", "user:!$&()*+,;="] {
            for quote in ["", "'", "\""] {
                let text = format!("{quote}https://{cred}@host/repo{quote}");
                let safe = format!("{quote}https://***@host/repo{quote}");
                assert_eq!(redact(&text), safe);
                let error = Error::new(Code::HostUnreachable, &text).with_hint(&text);
                let json = serde_json::to_string(&error).unwrap();
                assert!(!json.contains(cred), "{json}");
                assert!(json.contains("https://***@host/repo"));
                let mut diagnostics = serde_json::json!({"warnings":[text],"detail":text,"fetch_error":text,"nested":{"error":text}});
                redact_diagnostics(&mut diagnostics);
                assert!(!diagnostics.to_string().contains(cred));
            }
        }
        for text in ["git@github.com:x", "worker:/srv/repo"] {
            assert_eq!(redact(text), text);
        }
    }

    #[test]
    fn integration_git_summary_filters_tail_redacts_and_limits_unicode() {
        let tail = "\nPlease make sure you have the correct access rights\nand the repository exists.\n";
        for (raw,reason) in [
            ("Host key verification failed.\nfatal: Could not read from remote repository.","Host key verification failed"),
            ("remote: Invalid username or token.\nfatal: unable to access 'https://USER:pa'ss%40@host/repo': The requested URL returned error: 401","401"),
            ("fatal: '/missing' does not appear to be a git repository\nfatal: Could not read from remote repository.","does not appear to be a git repository"),
        ] {
            let summary=git_error_summary(&format!("{raw}{tail}"));
            assert!(summary.contains(reason),"{summary}");
            assert!(!summary.contains("access rights") && !summary.contains("repository exists") && !summary.contains("USER:pa"));
            assert!(!summary.contains('\n'));
        }
        assert_eq!(git_error_summary(&format!("first\n  one \n\ntwo\nthree{tail}")), "one；two；three");
        let text = format!("https://USER:{}@host/{}", "TOKEN".repeat(100), "字".repeat(400));
        let summary = git_error_summary(&text);
        assert_eq!(summary.chars().count(), 300);
        assert!(!summary.contains("TOKEN"));
        assert!(summary.starts_with("https://***@host/"));
        assert_eq!(git_error_summary(tail), "没有输出");
    }

    #[test]
    fn status_mapping() {
        assert_eq!(Code::Unauthorized.http_status(), 401);
        assert_eq!(Code::AuthFailed.http_status(), 502);
        assert_eq!(serde_json::to_string(&Code::HostUnreachable).unwrap(), "\"host_unreachable\"");
    }
}
