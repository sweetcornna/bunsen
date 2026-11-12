//! 解析上传的 ssh 配置；生成 `<数据目录>/ssh/config`。

use crate::error::{Error, Result};
use crate::model::Server;
use std::path::Path;

/// 一个具体别名解析后的有效设置。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HostEntry {
    pub alias: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_files: Vec<String>,
    pub proxy_jump: Option<String>,
    pub proxy_command: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedConfig {
    pub hosts: Vec<HostEntry>,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
struct Opt {
    key: String,
    args: Vec<String>,
    raw: String,
}

#[derive(Debug)]
struct Block {
    /// None 表示文件开头、任何 Host 之前的全局设置。
    patterns: Option<Vec<String>>,
    is_match: bool,
    opts: Vec<Opt>,
}

/// 拆出关键字与其余部分：支持 `Key Value`、`Key=Value`、`Key = Value`。
fn split_keyword(line: &str) -> (String, String) {
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let key = line[..end].to_string();
    let mut rest = line[end..].trim_start();
    if let Some(r) = rest.strip_prefix('=') {
        rest = r.trim_start();
    }
    (key, rest.trim_end().to_string())
}

/// 按空白切分参数，双引号成组；不在引号里的 `#` 开头的词起注释。
fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut has = false;
    for c in s.chars() {
        if in_q {
            if c == '"' {
                in_q = false;
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '"' => {
                in_q = true;
                has = true;
            }
            '#' if !has => break,
            c if c.is_whitespace() => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

fn glob_match(pat: &str, s: &str) -> bool {
    let p: Vec<char> = pat.to_lowercase().chars().collect();
    let t: Vec<char> = s.to_lowercase().chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(sp) = star {
            pi = sp + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn block_matches(patterns: &[String], alias: &str) -> bool {
    let mut positive = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if glob_match(neg, alias) {
                return false;
            }
        } else if glob_match(p, alias) {
            positive = true;
        }
    }
    positive
}

fn is_concrete(p: &str) -> bool {
    !p.is_empty() && !p.starts_with('!') && !p.contains('*') && !p.contains('?')
}

pub fn parse(text: &str) -> ParsedConfig {
    let mut warnings = Vec::new();
    let mut blocks = vec![Block { patterns: None, is_match: false, opts: vec![] }];
    let mut aliases: Vec<String> = Vec::new();
    let mut warned_match = false;
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, rest) = split_keyword(line);
        let lk = key.to_ascii_lowercase();
        match lk.as_str() {
            "host" => {
                let pats = split_args(&rest);
                for p in &pats {
                    if is_concrete(p) && !aliases.iter().any(|a| a == p) {
                        aliases.push(p.clone());
                    }
                }
                blocks.push(Block { patterns: Some(pats), is_match: false, opts: vec![] });
            }
            "match" => {
                if !warned_match {
                    warnings.push("ssh 配置里的 Match 块暂不支持，已忽略其中的设置".to_string());
                    warned_match = true;
                }
                blocks.push(Block { patterns: Some(vec![]), is_match: true, opts: vec![] });
            }
            "include" => warnings.push(format!("ssh 配置里的 Include {rest} 暂不支持，请把被包含的文件一起上传")),
            _ => {
                let args = split_args(&rest);
                blocks.last_mut().unwrap().opts.push(Opt { key: lk, args, raw: rest });
            }
        }
    }

    let mut hosts = Vec::new();
    for alias in aliases {
        let mut e = HostEntry { alias: alias.clone(), ..Default::default() };
        let mut hostname: Option<String> = None;
        let mut proxy_jump: Option<Option<String>> = None;
        let mut proxy_command: Option<Option<String>> = None;
        for b in &blocks {
            if b.is_match {
                continue;
            }
            if let Some(p) = &b.patterns {
                if !block_matches(p, &alias) {
                    continue;
                }
            }
            for o in &b.opts {
                let first = o.args.first().cloned();
                match o.key.as_str() {
                    "hostname" if hostname.is_none() => hostname = first,
                    "user" if e.user.is_none() => e.user = first,
                    "port" if e.port.is_none() => match first.as_deref().map(str::parse::<u16>) {
                        Some(Ok(p)) => e.port = Some(p),
                        _ => warnings.push(format!("Host {alias} 的 Port 不是合法端口：{}", o.raw)),
                    },
                    "identityfile" => {
                        if let Some(f) = first {
                            if !f.eq_ignore_ascii_case("none") && !e.identity_files.contains(&f) {
                                e.identity_files.push(f);
                            }
                        }
                    }
                    "proxyjump" if proxy_jump.is_none() => {
                        proxy_jump = Some(first.filter(|v| !v.eq_ignore_ascii_case("none")));
                    }
                    "proxycommand" if proxy_command.is_none() => {
                        let v = o.raw.trim().to_string();
                        proxy_command = Some(if v.is_empty() || v.eq_ignore_ascii_case("none") { None } else { Some(v) });
                    }
                    _ => {}
                }
            }
        }
        e.host = expand_host_tokens(hostname.as_deref().unwrap_or(&alias), &alias);
        e.proxy_jump = proxy_jump.flatten();
        e.proxy_command = proxy_command.flatten();
        hosts.push(e);
    }
    ParsedConfig { hosts, warnings }
}

fn expand_host_tokens(v: &str, alias: &str) -> String {
    let mut out = String::new();
    let mut it = v.chars().peekable();
    while let Some(c) = it.next() {
        if c == '%' {
            match it.next() {
                Some('h') => out.push_str(alias),
                Some('%') => out.push('%'),
                Some(o) => {
                    out.push('%');
                    out.push(o);
                }
                None => out.push('%'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// IdentityFile 路径的文件名部分（`~/.ssh/id_x` → `id_x`）。
pub fn identity_basename(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// 内容是否像 ssh 配置：有一行以 `Host` 关键字开头。
pub fn looks_like_config(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim_start();
        l.len() > 4 && l[..4].eq_ignore_ascii_case("host") && {
            let c = l.as_bytes()[4];
            c == b' ' || c == b'\t' || c == b'='
        }
    })
}

/// 别名：非空、无空白与通配符，不以 `-` 开头。
pub fn validate_alias(a: &str) -> Result<()> {
    let bad = a.is_empty()
        || a.len() > 64
        || a.starts_with('-')
        || a.chars().any(|c| c.is_whitespace() || c.is_control() || "*?!\"'#,\\".contains(c));
    if bad {
        return Err(Error::bad_request(format!("别名“{a}”不合法"))
            .with_hint("别名不能为空，不能含空格、引号或 * ? ! # , 这类字符，也不能以 - 开头"));
    }
    Ok(())
}

/// 主机名、用户名：非空、无空白与引号。
pub fn validate_word(field: &str, v: &str) -> Result<()> {
    if v.is_empty() || v.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\'') {
        return Err(Error::bad_request(format!("{field}“{v}”不合法")).with_hint("不能为空，不能含空格或引号"));
    }
    Ok(())
}

pub fn validate_single_line(field: &str, v: &str) -> Result<()> {
    if v.chars().any(|c| c == '\n' || c == '\r' || c == '\0') {
        return Err(Error::bad_request(format!("{field} 不能包含换行")));
    }
    Ok(())
}

fn quote_cfg_path(p: &Path) -> String {
    format!("\"{}\"", cfg_path(p))
}

/// 配置文件里的路径：`%` 要转义；Windows 上换成正斜杠，免得反斜杠在引号里被当成转义。
fn cfg_path(p: &Path) -> String {
    let s = p.to_string_lossy().replace('%', "%%");
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s
    }
}

/// 生成 Outpost 专用的 ssh 配置。
pub fn render(servers: &[Server], keys_dir: &Path, known_hosts: &Path, cm_dir: &Path) -> String {
    let mut s = String::from("# 由 Outpost 生成，每次服务器记录变化时重写；不要手改。\n\n");
    for sv in servers {
        s.push_str(&format!("Host {} op-{}\n", sv.alias, sv.id));
        s.push_str(&format!("  HostName {}\n", sv.host));
        s.push_str(&format!("  User {}\n", sv.user));
        s.push_str(&format!("  Port {}\n", sv.port));
        if let Some(k) = &sv.key {
            s.push_str(&format!("  IdentityFile {}\n", quote_cfg_path(&keys_dir.join(k))));
            s.push_str("  IdentitiesOnly yes\n");
        }
        if let Some(j) = &sv.proxy_jump {
            s.push_str(&format!("  ProxyJump {j}\n"));
        }
        if let Some(c) = &sv.proxy_command {
            s.push_str(&format!("  ProxyCommand {c}\n"));
        }
        s.push('\n');
    }
    s.push_str("Host *\n");
    // Windows 自带的 OpenSSH 不支持连接复用，那里每次都新建连接。
    if !cfg!(windows) {
        s.push_str("  ControlMaster auto\n");
        s.push_str(&format!("  ControlPath \"{}/%C\"\n", cfg_path(cm_dir)));
        s.push_str("  ControlPersist 600\n");
    }
    s.push_str("  ServerAliveInterval 15\n");
    s.push_str("  ServerAliveCountMax 3\n");
    s.push_str("  ConnectTimeout 8\n");
    s.push_str("  StrictHostKeyChecking accept-new\n");
    s.push_str(&format!("  UserKnownHostsFile {}\n", quote_cfg_path(known_hosts)));
    s.push_str("  LogLevel ERROR\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
# 全局默认放在最前面
Host *
  User defaultuser
  ServerAliveInterval 30
  IdentityFile ~/.ssh/id_default

Host gpu1 gpu1-alt
  HostName 10.0.0.11
  Port 2200
  IdentityFile "~/.ssh/My Keys/id_gpu"

Host gpu2
  HostName=10.0.0.12
  User = dev
  ProxyJump bastion

Host bastion
  HostName bastion.example.com
  User jump
  Port 22  # 行尾注释

Host legacy
  HostName %h.internal
  ProxyCommand ssh -W %h:%p bastion
  IdentityFile none

Host *.example.com !skip.example.com
  User wild

Match host gpu1
  User fromMatch
"#;

    fn find<'a>(p: &'a ParsedConfig, a: &str) -> &'a HostEntry {
        p.hosts.iter().find(|h| h.alias == a).unwrap()
    }

    #[test]
    fn parses_blocks_and_defaults() {
        let p = parse(SAMPLE);
        let names: Vec<_> = p.hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, ["gpu1", "gpu1-alt", "gpu2", "bastion", "legacy"]);

        let g = find(&p, "gpu1");
        assert_eq!(g.host, "10.0.0.11");
        assert_eq!(g.port, Some(2200));
        // Host * 在前面，先取到的 User 生效（OpenSSH 规则：先到先得）。
        assert_eq!(g.user.as_deref(), Some("defaultuser"));
        assert_eq!(g.identity_files, vec!["~/.ssh/id_default", "~/.ssh/My Keys/id_gpu"]);
        assert_eq!(find(&p, "gpu1-alt").host, "10.0.0.11");

        let g2 = find(&p, "gpu2");
        assert_eq!(g2.host, "10.0.0.12");
        assert_eq!(g2.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(g2.port, None);

        let b = find(&p, "bastion");
        assert_eq!(b.port, Some(22));
        assert_eq!(b.host, "bastion.example.com");

        let l = find(&p, "legacy");
        assert_eq!(l.host, "legacy.internal");
        assert_eq!(l.proxy_command.as_deref(), Some("ssh -W %h:%p bastion"));
        assert!(p.warnings.iter().any(|w| w.contains("Match")));
    }

    #[test]
    fn wildcard_defaults_at_end() {
        let p = parse("Host a\n  HostName 1.2.3.4\nHost b\n  User own\nHost *\n  User fallback\n  Port 2222\n  ProxyJump j\n");
        let a = find(&p, "a");
        assert_eq!(a.user.as_deref(), Some("fallback"));
        assert_eq!(a.port, Some(2222));
        assert_eq!(a.proxy_jump.as_deref(), Some("j"));
        let b = find(&p, "b");
        assert_eq!(b.user.as_deref(), Some("own"));
        assert_eq!(b.host, "b");
    }

    #[test]
    fn negation_and_none() {
        let p = parse("Host x skip\nHost * !skip\n  ProxyJump none\n  User u\n");
        assert_eq!(find(&p, "x").user.as_deref(), Some("u"));
        assert_eq!(find(&p, "x").proxy_jump, None);
        assert_eq!(find(&p, "skip").user, None);
    }

    #[test]
    fn quoted_values_and_equals() {
        let p = parse("Host \"q1\"\n  HostName=\"10.1.1.1\"\n  IdentityFile=\"/a b/c d/key\"\n  User\t\"u\"\n");
        let q = find(&p, "q1");
        assert_eq!(q.host, "10.1.1.1");
        assert_eq!(q.user.as_deref(), Some("u"));
        assert_eq!(q.identity_files, vec!["/a b/c d/key"]);
        assert_eq!(identity_basename(&q.identity_files[0]), "key");
        assert_eq!(identity_basename("id_test"), "id_test");
        assert_eq!(identity_basename("C:\\Users\\me\\.ssh\\id_rsa"), "id_rsa");
    }

    #[test]
    fn detects_config_text() {
        assert!(looks_like_config("Host a\n HostName b"));
        assert!(looks_like_config("  host=a"));
        assert!(!looks_like_config("HostName only"));
        assert!(!looks_like_config("hello"));
    }

    #[test]
    fn glob() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("gpu?", "gpu1"));
        assert!(!glob_match("gpu?", "gpu12"));
        assert!(glob_match("*.example.com", "a.Example.com"));
        assert!(!glob_match("*.example.com", "example.com"));
    }

    #[test]
    fn validation() {
        assert!(validate_alias("gpu-1.lab").is_ok());
        assert!(validate_alias("").is_err());
        assert!(validate_alias("a b").is_err());
        assert!(validate_alias("a*").is_err());
        assert!(validate_alias("-x").is_err());
        assert!(validate_word("主机", "1.2.3.4").is_ok());
        assert!(validate_word("主机", "a b").is_err());
    }

    #[test]
    fn renders_with_quoted_paths() {
        let sv = Server {
            id: "s3k9x2".into(),
            alias: "outpost-test".into(),
            host: "127.0.0.1".into(),
            user: "dev".into(),
            port: 2222,
            key: Some("id_test".into()),
            proxy_jump: Some("bastion".into()),
            proxy_command: None,
            source: crate::model::ServerSource::Upload,
            note: String::new(),
            default_workdir: "~".into(),
            status: crate::model::ServerStatus::Unknown,
            status_detail: None,
            last_checked: None,
            probe: None,
        };
        let out = render(
            &[sv],
            Path::new("/Users/x/Library/Application Support/outpost/keys"),
            Path::new("/Users/x/Library/Application Support/outpost/ssh/known_hosts"),
            Path::new("/Users/x/.cache/outpost/cm"),
        );
        assert!(out.contains("Host outpost-test op-s3k9x2\n"));
        assert!(out.contains("  IdentityFile \"/Users/x/Library/Application Support/outpost/keys/id_test\"\n  IdentitiesOnly yes\n"));
        assert!(out.contains("  ControlPath \"/Users/x/.cache/outpost/cm/%C\"\n"));
        assert!(out.contains("  StrictHostKeyChecking accept-new\n"));
        assert!(out.contains("  ProxyJump bastion\n"));
        // 生成的配置能被自己的解析器读回。
        let back = parse(&out);
        let h = find(&back, "outpost-test");
        assert_eq!(h.port, Some(2222));
        assert_eq!(h.identity_files.len(), 1);
    }
}
