//! 上传内容识别：按内容而不是扩展名。ZIP 就地展开；私钥、公钥、ssh 配置；其余忽略并写进警告。

use crate::keys::{is_private_key, is_public_key};
use crate::sshconfig::looks_like_config;
use std::io::{Cursor, Read};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Zip,
    PrivateKey,
    PublicKey,
    Config,
    Other,
}

#[derive(Debug, Clone)]
pub struct Upload {
    pub name: String,
    pub data: Vec<u8>,
}

const MAX_ENTRY: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 500;

pub fn classify(data: &[u8]) -> Kind {
    if data.starts_with(b"PK\x03\x04") || data.starts_with(b"PK\x05\x06") {
        return Kind::Zip;
    }
    if is_private_key(data) {
        return Kind::PrivateKey;
    }
    if is_public_key(data) {
        return Kind::PublicKey;
    }
    if !data.contains(&0) {
        if let Ok(text) = std::str::from_utf8(data) {
            if looks_like_config(text) {
                return Kind::Config;
            }
        }
    }
    Kind::Other
}

fn display_name(name: &str) -> &str {
    if name.is_empty() {
        "（未命名）"
    } else {
        name
    }
}

/// 识别并展开（ZIP 里套 ZIP 最多展开两层）。返回所有非 ZIP 的条目及其类型。
pub fn expand(uploads: Vec<Upload>, warnings: &mut Vec<String>) -> Vec<(Upload, Kind)> {
    let mut out = Vec::new();
    for u in uploads {
        expand_one(u, 0, &mut out, warnings);
    }
    out
}

fn expand_one(u: Upload, depth: usize, out: &mut Vec<(Upload, Kind)>, warnings: &mut Vec<String>) {
    match classify(&u.data) {
        Kind::Zip if depth < 2 => match zip::ZipArchive::new(Cursor::new(&u.data)) {
            Ok(mut ar) => {
                if ar.len() > MAX_ENTRIES {
                    warnings.push(format!("压缩包 {} 里的文件太多（{} 个），只处理前 {MAX_ENTRIES} 个", display_name(&u.name), ar.len()));
                }
                for i in 0..ar.len().min(MAX_ENTRIES) {
                    let mut f = match ar.by_index(i) {
                        Ok(f) => f,
                        Err(e) => {
                            warnings.push(format!("压缩包 {} 的第 {} 项无法读取：{e}", display_name(&u.name), i + 1));
                            continue;
                        }
                    };
                    if f.is_dir() {
                        continue;
                    }
                    let full = f.name().to_string();
                    let base = full.rsplit('/').next().unwrap_or(&full).to_string();
                    if full.starts_with("__MACOSX/") || base.starts_with("._") || base == ".DS_Store" || base.is_empty() {
                        continue;
                    }
                    if f.size() > MAX_ENTRY {
                        warnings.push(format!("{full}（在 {} 里）太大，已忽略", display_name(&u.name)));
                        continue;
                    }
                    let mut data = Vec::new();
                    if let Err(e) = (&mut f).take(MAX_ENTRY + 1).read_to_end(&mut data) {
                        warnings.push(format!("{full}（在 {} 里）读取失败：{e}", display_name(&u.name)));
                        continue;
                    }
                    expand_one(Upload { name: base, data }, depth + 1, out, warnings);
                }
            }
            Err(e) => warnings.push(format!("{} 看起来是 ZIP，但打不开：{e}", display_name(&u.name))),
        },
        Kind::Zip => warnings.push(format!("{} 是嵌套太深的压缩包，已忽略", display_name(&u.name))),
        Kind::Other => warnings.push(format!("{} 不是 ssh 配置、私钥或压缩包，已忽略", display_name(&u.name))),
        k => out.push((u, k)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const PRIV: &[u8] = b"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
    const PUB: &[u8] = b"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA test\n";
    const CFG: &[u8] = b"Host outpost-test\n  HostName 127.0.0.1\n  Port 2222\n";

    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            for (name, data) in entries {
                if name.ends_with('/') {
                    w.add_directory(name.trim_end_matches('/'), opts).unwrap();
                } else {
                    w.start_file(*name, opts).unwrap();
                    w.write_all(data).unwrap();
                }
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn classify_by_content() {
        assert_eq!(classify(PRIV), Kind::PrivateKey);
        assert_eq!(classify(PUB), Kind::PublicKey);
        assert_eq!(classify(CFG), Kind::Config);
        assert_eq!(classify(b"just text"), Kind::Other);
        assert_eq!(classify(b"\x00\x01binary Host x"), Kind::Other);
        assert_eq!(classify(&make_zip(&[("a", b"x")])), Kind::Zip);
        // 扩展名不影响识别：名字叫 .txt 的私钥照样是私钥（classify 只看内容）。
    }

    #[test]
    fn zip_expands_and_skips_junk() {
        let inner = make_zip(&[("deep/config", CFG)]);
        let z = make_zip(&[
            (".ssh/", b""),
            (".ssh/config", CFG),
            (".ssh/id_test", PRIV),
            (".ssh/id_test.pub", PUB),
            (".ssh/known_hosts", b"[127.0.0.1]:2222 ssh-ed25519 AAAA\n"),
            ("__MACOSX/.ssh/._id_test", b"junk"),
            ("nested.zip", &inner),
        ]);
        let mut w = Vec::new();
        let items = expand(vec![Upload { name: "bundle.zip".into(), data: z }], &mut w);
        let got: Vec<(String, Kind)> = items.iter().map(|(u, k)| (u.name.clone(), *k)).collect();
        assert_eq!(
            got,
            vec![
                ("config".to_string(), Kind::Config),
                ("id_test".to_string(), Kind::PrivateKey),
                ("id_test.pub".to_string(), Kind::PublicKey),
                ("config".to_string(), Kind::Config),
            ]
        );
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].contains("known_hosts"));
    }

    #[test]
    fn broken_zip_warns() {
        let mut w = Vec::new();
        let items = expand(vec![Upload { name: "x.zip".into(), data: b"PK\x03\x04garbage".to_vec() }], &mut w);
        assert!(items.is_empty());
        assert_eq!(w.len(), 1);
    }
}
