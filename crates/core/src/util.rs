//! 小工具：随机 id 与令牌、RFC 3339 时间、原子写、权限。

use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("系统随机源不可用");
    buf
}

/// 6 位小写字母数字 id。
pub fn short_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    // 拒绝采样，避免取模偏差。
    let mut out = String::with_capacity(6);
    while out.len() < 6 {
        for b in random_bytes(16) {
            if (b as usize) < 252 && out.len() < 6 {
                out.push(ALPHABET[(b as usize) % 36] as char);
            }
        }
    }
    out
}

pub fn is_short_id(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// 32 字节随机数的十六进制。
pub fn random_token() -> String {
    random_bytes(32).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn now_rfc3339() -> String {
    rfc3339_from_unix(unix_now())
}

/// Unix 秒 → `YYYY-MM-DDTHH:MM:SSZ`（UTC）。
pub fn rfc3339_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

// Howard Hinnant 的 civil_from_days。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 写临时文件再 rename；`mode` 为 Unix 权限位。
pub fn atomic_write(path: &Path, data: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.tmp.{}.{}", std::process::id(), short_id()));
    {
        let mut f = fs::File::create(&tmp)?;
        set_mode(&tmp, mode.unwrap_or(0o600))?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(unix)]
pub fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
pub fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

/// 建目录并设权限（已存在也会收紧权限）。
pub fn ensure_dir(path: &Path, mode: u32) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    set_mode(path, mode)
}

/// 截取前 `n` 个字符。
pub fn take_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// 用常数时间比较两个字符串，防止计时侧信道。
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_tokens() {
        for _ in 0..50 {
            let id = short_id();
            assert!(is_short_id(&id), "{id}");
        }
        let t = random_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(random_token(), t);
    }

    #[test]
    fn rfc3339() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_from_unix(1_794_492_865), "2026-11-12T14:14:25Z");
    }

    #[test]
    fn ct_eq() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }
}
