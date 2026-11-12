//! 私钥：识别、按指纹去重、存到 `keys/`（0600）、列出。私钥内容不出现在任何输出里。

use crate::error::{Error, Result};
use crate::model::{KeyInfo, Server};
use crate::util::{atomic_write, short_id};
use std::path::Path;
use std::process::{Command, Stdio};

/// 首行是 `-----BEGIN … PRIVATE KEY-----`。
pub fn is_private_key(data: &[u8]) -> bool {
    let text = String::from_utf8_lossy(&data[..data.len().min(200)]);
    let first = text.trim_start_matches('\u{feff}').trim_start().lines().next().unwrap_or("").trim();
    first.starts_with("-----BEGIN ") && first.ends_with("PRIVATE KEY-----")
}

/// 一行 OpenSSH 公钥（`ssh-ed25519 AAAA… 注释`）。
pub fn is_public_key(data: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(data) else { return false };
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.len() != 1 {
        return false;
    }
    let mut it = lines[0].split_whitespace();
    let (Some(kind), Some(blob)) = (it.next(), it.next()) else { return false };
    (kind.starts_with("ssh-") || kind.starts_with("ecdsa-sha2-") || kind.starts_with("sk-"))
        && blob.starts_with("AAAA")
}

/// 文件名规整成安全的密钥名。
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut s: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    while s.starts_with('.') {
        s.remove(0);
    }
    if s.is_empty() {
        s = "key".into();
    }
    s.truncate(64);
    s
}

pub fn valid_key_name(name: &str) -> bool {
    !name.is_empty() && name == sanitize_name(name) && !name.ends_with(".pub")
}

/// `ssh-keygen -lf <文件>` → (类型, 指纹)。私钥（OpenSSH 格式）不需要口令也能读出公钥部分。
pub fn fingerprint(path: &Path) -> Option<(String, String)> {
    let out = Command::new("ssh-keygen")
        .arg("-l")
        .arg("-f")
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_keygen_line(&String::from_utf8_lossy(&out.stdout))
}

/// `256 SHA256:xxxx comment (ED25519)` → ("ED25519", "SHA256:xxxx")。
pub fn parse_keygen_line(line: &str) -> Option<(String, String)> {
    let line = line.lines().next()?.trim();
    let mut parts = line.split_whitespace();
    let _bits = parts.next()?;
    let fp = parts.next()?.to_string();
    let kind = line
        .rsplit_once('(')
        .and_then(|(_, k)| k.strip_suffix(')'))
        .unwrap_or("?")
        .to_string();
    Some((kind, fp))
}

/// PEM 头里的类型（ssh-keygen 读不出来时的退路）。
fn kind_from_header(data: &[u8]) -> String {
    let text = String::from_utf8_lossy(&data[..data.len().min(100)]);
    let first = text.trim_start().lines().next().unwrap_or("");
    let inner = first.trim_start_matches("-----BEGIN ").trim_end_matches("PRIVATE KEY-----").trim();
    match inner {
        "OPENSSH" => "OPENSSH".into(),
        "" => "PKCS8".into(),
        other => other.into(),
    }
}

pub struct SavedKey {
    pub name: String,
    pub added: bool,
}

/// 保存一把私钥：按指纹（取不到指纹时按内容）去重；同名不同钥时自动加后缀。
pub fn save_private(keys_dir: &Path, wanted: &str, data: &[u8]) -> Result<SavedKey> {
    std::fs::create_dir_all(keys_dir)?;
    let tmp = keys_dir.join(format!(".incoming-{}", short_id()));
    atomic_write(&tmp, data, Some(0o600))?;
    let fp = fingerprint(&tmp).map(|(_, f)| f);
    let existing = list_names(keys_dir)?;
    for name in &existing {
        let path = keys_dir.join(name);
        let same = match &fp {
            Some(f) => fingerprint(&path).map(|(_, g)| g == *f).unwrap_or(false),
            None => std::fs::read(&path).map(|d| d == data).unwrap_or(false),
        };
        if same {
            let _ = std::fs::remove_file(&tmp);
            return Ok(SavedKey { name: name.clone(), added: false });
        }
    }
    let base = sanitize_name(wanted);
    let base = base.strip_suffix(".pub").map(str::to_string).unwrap_or(base);
    let mut name = base.clone();
    let mut n = 2;
    while existing.contains(&name) || keys_dir.join(format!("{name}.pub")).exists() {
        name = format!("{base}-{n}");
        n += 1;
    }
    std::fs::rename(&tmp, keys_dir.join(&name))?;
    Ok(SavedKey { name, added: true })
}

/// 保存公钥：配到同名或指纹相同的私钥上；配不上返回 None。
pub fn save_public(keys_dir: &Path, wanted: &str, data: &[u8], alias: &[(String, String)]) -> Result<Option<String>> {
    let names = list_names(keys_dir)?;
    let stem = sanitize_name(wanted);
    let stem = stem.strip_suffix(".pub").unwrap_or(&stem).to_string();
    let stem = alias.iter().find(|(from, _)| *from == stem).map(|(_, to)| to.clone()).unwrap_or(stem);
    let tmp = keys_dir.join(format!(".incoming-{}.pub", short_id()));
    atomic_write(&tmp, data, Some(0o644))?;
    let fp = fingerprint(&tmp).map(|(_, f)| f);
    let same_fp = |n: &String| match &fp {
        Some(f) => fingerprint(&keys_dir.join(n)).map(|(_, g)| g == *f).unwrap_or(false),
        None => false,
    };
    let target = if names.contains(&stem) && (fp.is_none() || same_fp(&stem)) {
        Some(stem)
    } else {
        names.iter().find(|n| same_fp(n)).cloned()
    };
    match target {
        Some(t) => {
            std::fs::rename(&tmp, keys_dir.join(format!("{t}.pub")))?;
            Ok(Some(t))
        }
        None => {
            let _ = std::fs::remove_file(&tmp);
            Ok(None)
        }
    }
}

/// `keys/` 里的私钥文件名（不含 `.pub` 与临时文件）。
pub fn list_names(keys_dir: &Path) -> Result<Vec<String>> {
    let mut v = Vec::new();
    let rd = match std::fs::read_dir(keys_dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(v),
        Err(e) => return Err(e.into()),
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.ends_with(".pub") || !e.path().is_file() {
            continue;
        }
        v.push(name);
    }
    v.sort();
    Ok(v)
}

pub fn info(keys_dir: &Path, name: &str, servers: &[Server]) -> KeyInfo {
    let path = keys_dir.join(name);
    let (kind, fp) = fingerprint(&path).unwrap_or_else(|| {
        let data = std::fs::read(&path).unwrap_or_default();
        (kind_from_header(&data), "未知（可能带口令）".into())
    });
    KeyInfo {
        name: name.to_string(),
        kind,
        fingerprint: fp,
        has_pub: keys_dir.join(format!("{name}.pub")).exists(),
        used_by: servers.iter().filter(|s| s.key.as_deref() == Some(name)).map(|s| s.alias.clone()).collect(),
    }
}

pub fn list(keys_dir: &Path, servers: &[Server]) -> Result<Vec<KeyInfo>> {
    Ok(list_names(keys_dir)?.iter().map(|n| info(keys_dir, n, servers)).collect())
}

pub fn delete(keys_dir: &Path, name: &str, servers: &[Server]) -> Result<()> {
    if !valid_key_name(name) || !keys_dir.join(name).is_file() {
        return Err(Error::not_found(format!("没有名为 {name} 的私钥")));
    }
    let users: Vec<String> = servers.iter().filter(|s| s.key.as_deref() == Some(name)).map(|s| s.alias.clone()).collect();
    if !users.is_empty() {
        return Err(Error::conflict(format!("私钥 {name} 仍被服务器 {} 使用", users.join("、")))
            .with_hint("先在这些服务器上换一把密钥或删掉服务器"));
    }
    std::fs::remove_file(keys_dir.join(name))?;
    let _ = std::fs::remove_file(keys_dir.join(format!("{name}.pub")));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection() {
        assert!(is_private_key(b"-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----\n"));
        assert!(is_private_key(b"\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n"));
        assert!(is_private_key(b"-----BEGIN PRIVATE KEY-----\n"));
        assert!(is_private_key(b"-----BEGIN ENCRYPTED PRIVATE KEY-----\n"));
        assert!(!is_private_key(b"-----BEGIN PUBLIC KEY-----\n"));
        assert!(!is_private_key(b"Host a\n"));
        assert!(is_public_key(b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF test\n"));
        assert!(is_public_key(b"ecdsa-sha2-nistp256 AAAAE2VjZHNh x"));
        assert!(!is_public_key(b"ssh-ed25519 AAAA a\nssh-rsa AAAA b\n"));
        assert!(!is_public_key(b"Host a"));
    }

    #[test]
    fn names() {
        assert_eq!(sanitize_name("id_test"), "id_test");
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("my key (1)"), "my_key__1_");
        assert_eq!(sanitize_name(".hidden"), "hidden");
        assert_eq!(sanitize_name(""), "key");
        assert!(valid_key_name("id_test"));
        assert!(!valid_key_name("../x"));
        assert!(!valid_key_name("a.pub"));
    }

    #[test]
    fn keygen_line() {
        assert_eq!(
            parse_keygen_line("256 SHA256:abcDEF+/x outpost-test (ED25519)\n"),
            Some(("ED25519".into(), "SHA256:abcDEF+/x".into()))
        );
        assert_eq!(
            parse_keygen_line("3072 SHA256:zz no comment (RSA)"),
            Some(("RSA".into(), "SHA256:zz".into()))
        );
    }

    #[test]
    fn save_dedupes_by_fingerprint() {
        // 用 ssh-keygen 现场生成一把一次性密钥（不碰 ~/.ssh）。
        let dir = std::env::temp_dir().join(format!("outpost-unit-keys-{}", short_id()));
        let gen = dir.join("gen");
        std::fs::create_dir_all(&gen).unwrap();
        let ok = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "unit", "-f"])
            .arg(gen.join("k"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            eprintln!("本机没有 ssh-keygen，跳过");
            return;
        }
        let data = std::fs::read(gen.join("k")).unwrap();
        let keys = dir.join("keys");
        let a = save_private(&keys, "id_one", &data).unwrap();
        assert!(a.added);
        assert_eq!(a.name, "id_one");
        // 同一把钥换个名字再传：去重。
        let mut crlf = data.clone();
        crlf.extend_from_slice(b"\n");
        let b = save_private(&keys, "other", &crlf).unwrap();
        assert!(!b.added);
        assert_eq!(b.name, "id_one");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(keys.join("id_one")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let pubdata = std::fs::read(gen.join("k.pub")).unwrap();
        assert_eq!(save_public(&keys, "whatever.pub", &pubdata, &[]).unwrap().as_deref(), Some("id_one"));
        let infos = list(&keys, &[]).unwrap();
        assert_eq!(infos.len(), 1);
        assert!(infos[0].has_pub);
        assert_eq!(infos[0].kind, "ED25519");
        assert!(infos[0].fingerprint.starts_with("SHA256:"));
        delete(&keys, "id_one", &[]).unwrap();
        assert!(list(&keys, &[]).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
