//! 插件（API.md §11.6）：内嵌在可执行文件里的插件（源在 `plugins/`）加上 `Settings.plugin_paths`
//! 里的本机目录。部署时先在本机数据目录展开到 `plugins-cache/<name>-<内容哈希>/`（过滤掉密钥类文件、
//! 设好可执行位），再同步到服务器。

use crate::error::{Error, Result};
use crate::model::{Plugin, PluginSourceKind, Settings};
use crate::util::{ensure_dir, set_mode, short_id};
use std::path::{Path, PathBuf};

#[derive(rust_embed::RustEmbed)]
#[folder = "../../plugins"]
struct Bundled;

/// 不下发的目录名。
const EXCLUDED_DIRS: &[&str] = &[".git", ".claude", "tests", "node_modules", "keys", "secrets"];
/// 本机目录插件的上限（防止误选一个巨大的目录）。
const LOCAL_MAX_FILES: usize = 20_000;
const LOCAL_MAX_BYTES: u64 = 200 * 1024 * 1024;

/// 文件名是否不该下发：`id_*` `*.pem` `*.key` `lab.md` `.env*`。
fn excluded_file(name: &str) -> bool {
    name.starts_with("id_") || name.ends_with(".pem") || name.ends_with(".key") || name == "lab.md" || name.starts_with(".env")
}

/// 相对路径（`/` 分隔）里有没有要排除的目录段或文件名。
pub fn excluded(rel: &str) -> bool {
    let segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    let Some((file, dirs)) = segs.split_last() else { return true };
    dirs.iter().any(|d| EXCLUDED_DIRS.contains(d)) || excluded_file(file)
}

/// 内嵌文件没有权限信息：`*.sh`、`tools/*.py`、或以 `#!` 开头的文件设为可执行。
pub fn wants_exec(rel: &str, data: &[u8]) -> bool {
    let segs: Vec<&str> = rel.split('/').collect();
    let name = segs.last().copied().unwrap_or("");
    let parent = if segs.len() >= 2 { segs[segs.len() - 2] } else { "" };
    name.ends_with(".sh") || (parent == "tools" && name.ends_with(".py")) || data.starts_with(b"#!")
}

pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && !n.starts_with('.')
        && n.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    Bundled,
    Local(PathBuf),
}

#[derive(Debug, Clone)]
pub struct PluginFile {
    pub rel: String,
    pub data: Vec<u8>,
    pub exec: bool,
}

/// 一个可用插件：信息 + 来源。
#[derive(Debug, Clone)]
pub struct Available {
    pub info: Plugin,
    pub source: Source,
}

fn bundled_names() -> Vec<String> {
    let mut v: Vec<String> = Bundled::iter()
        .filter_map(|p| p.split_once('/').map(|(top, _)| top.to_string()))
        .filter(|n| valid_name(n))
        .collect();
    v.sort();
    v.dedup();
    v
}

/// 读出插件的全部文件（已过滤）。
pub fn files(name: &str, src: &Source) -> Result<Vec<PluginFile>> {
    match src {
        Source::Bundled => {
            let prefix = format!("{name}/");
            let mut out = Vec::new();
            for p in Bundled::iter() {
                let Some(rel) = p.strip_prefix(&prefix) else { continue };
                if excluded(rel) {
                    continue;
                }
                if let Some(f) = Bundled::get(&p) {
                    let data = f.data.into_owned();
                    out.push(PluginFile { rel: rel.to_string(), exec: wants_exec(rel, &data), data });
                }
            }
            out.sort_by(|a, b| a.rel.cmp(&b.rel));
            Ok(out)
        }
        Source::Local(dir) => {
            let mut out = Vec::new();
            let mut total = 0u64;
            walk_local(dir, "", &mut out, &mut total)?;
            out.sort_by(|a, b| a.rel.cmp(&b.rel));
            Ok(out)
        }
    }
}

fn walk_local(base: &Path, rel: &str, out: &mut Vec<PluginFile>, total: &mut u64) -> Result<()> {
    let dir = if rel.is_empty() { base.to_path_buf() } else { base.join(rel) };
    let rd = std::fs::read_dir(&dir).map_err(|e| Error::bad_request(format!("读不了插件目录 {}：{e}", dir.display())))?;
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // 符号链接一律不跟，免得把目录外的东西带上去。
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if EXCLUDED_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk_local(base, &child, out, total)?;
        } else if ft.is_file() {
            if excluded_file(&name) {
                continue;
            }
            let data = std::fs::read(e.path())?;
            *total += data.len() as u64;
            if out.len() >= LOCAL_MAX_FILES || *total > LOCAL_MAX_BYTES {
                return Err(Error::bad_request(format!("插件目录 {} 太大", base.display()))
                    .with_hint("插件目录最多 2 万个文件、200 MB；检查是不是选错了目录"));
            }
            #[cfg(unix)]
            let exec = {
                use std::os::unix::fs::PermissionsExt;
                e.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
            };
            #[cfg(not(unix))]
            let exec = wants_exec(&child, &data);
            out.push(PluginFile { rel: child, data, exec });
        }
    }
    Ok(())
}

/// 由文件列表得出插件信息。
pub fn describe(name: &str, src: &Source, files: &[PluginFile]) -> Plugin {
    let get = |rel: &str| files.iter().find(|f| f.rel == rel);
    let manifest: serde_json::Value = get(".claude-plugin/plugin.json")
        .and_then(|f| serde_json::from_slice(&f.data).ok())
        .unwrap_or_default();
    let s = |k: &str| manifest.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut skills: Vec<String> = files
        .iter()
        .filter_map(|f| {
            let rest = f.rel.strip_prefix("skills/")?;
            let (dir, file) = rest.split_once('/')?;
            (file == "SKILL.md").then(|| dir.to_string())
        })
        .collect();
    skills.sort();
    skills.dedup();
    let mut agents: Vec<String> = files
        .iter()
        .filter_map(|f| {
            let rest = f.rel.strip_prefix("agents/")?;
            (!rest.contains('/')).then(|| rest.strip_suffix(".md").map(str::to_string)).flatten()
        })
        .collect();
    agents.sort();
    Plugin {
        name: name.to_string(),
        version: s("version"),
        description: s("description"),
        source: match src {
            Source::Bundled => PluginSourceKind::Bundled,
            Source::Local(_) => PluginSourceKind::Local,
        },
        path: match src {
            Source::Bundled => None,
            Source::Local(p) => Some(p.to_string_lossy().into_owned()),
        },
        skills,
        agents,
        hooks: get("hooks/hooks.json").is_some(),
    }
}

/// 本机目录来源：`plugin_paths`（名字取目录名）加上旧字段 `research_plugin_path`（名字固定为 research）。
fn local_sources(settings: &Settings) -> Vec<(String, PathBuf)> {
    let mut v: Vec<(String, PathBuf)> = Vec::new();
    for p in &settings.plugin_paths {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        let path = PathBuf::from(p);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        v.push((name, path));
    }
    if let Some(p) = settings.research_plugin_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        v.push(("research".into(), PathBuf::from(p)));
    }
    v
}

/// 全部可用插件：内嵌的在前，然后是本机目录；同名时本机目录覆盖内嵌的（占内嵌那一项的位置）。
/// 本机目录不存在或不合法时跳过，原因写进 `warnings`。
pub fn available(settings: &Settings, warnings: &mut Vec<String>) -> Vec<Available> {
    let mut out: Vec<Available> = Vec::new();
    for name in bundled_names() {
        match files(&name, &Source::Bundled) {
            Ok(fs) => out.push(Available { info: describe(&name, &Source::Bundled, &fs), source: Source::Bundled }),
            Err(e) => warnings.push(e.message),
        }
    }
    for (name, path) in local_sources(settings) {
        if !valid_name(&name) {
            warnings.push(format!("插件目录 {} 的名字不合法，已跳过", path.display()));
            continue;
        }
        if !path.is_dir() {
            warnings.push(format!("插件目录 {} 不存在或不是目录，已跳过", path.display()));
            continue;
        }
        let src = Source::Local(path.clone());
        let fs = match files(&name, &src) {
            Ok(f) => f,
            Err(e) => {
                warnings.push(e.message);
                continue;
            }
        };
        let item = Available { info: describe(&name, &src, &fs), source: src };
        match out.iter_mut().find(|a| a.info.name == name) {
            Some(slot) => *slot = item,
            None => out.push(item),
        }
    }
    out
}

/// FNV-1a 64：只用来给缓存目录起名，不做安全用途。
fn content_hash(files: &[PluginFile]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for f in files {
        feed(f.rel.as_bytes());
        feed(&[0, f.exec as u8]);
        feed(&(f.data.len() as u64).to_le_bytes());
        feed(&f.data);
    }
    format!("{h:016x}")
}

/// 展开到 `<cache_root>/<name>-<hash>/`（已存在就复用），返回目录与文件数。旧版本的缓存目录顺手删掉。
pub fn materialize(cache_root: &Path, a: &Available) -> Result<(PathBuf, usize)> {
    let name = &a.info.name;
    let fs = files(name, &a.source)?;
    let hash = content_hash(&fs);
    ensure_dir(cache_root, 0o700)?;
    let dir = cache_root.join(format!("{name}-{hash}"));
    if !dir.is_dir() {
        let tmp = cache_root.join(format!(".{name}-{hash}.tmp-{}", short_id()));
        for f in &fs {
            let path = tmp.join(&f.rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, &f.data)?;
            set_mode(&path, if f.exec { 0o755 } else { 0o644 })?;
        }
        std::fs::create_dir_all(&tmp)?;
        set_mode(&tmp, 0o755)?;
        if let Err(e) = std::fs::rename(&tmp, &dir) {
            let _ = std::fs::remove_dir_all(&tmp);
            if !dir.is_dir() {
                return Err(e.into());
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(cache_root) {
        let keep = dir.file_name().map(|n| n.to_owned());
        for e in rd.flatten() {
            let n = e.file_name();
            let s = n.to_string_lossy();
            if Some(&n) != keep.as_ref() && s.starts_with(&format!("{name}-")) && s.len() == name.len() + 17 {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok((dir, fs.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusion_rules() {
        for p in [
            ".git/config",
            "a/.claude/settings.json",
            "tests/run.sh",
            "x/node_modules/y.js",
            "keys/id_x",
            "secrets/token.txt",
            "id_rsa",
            "sub/id_ed25519.pub",
            "cert.pem",
            "a/b.key",
            "lab.md",
            "skills/lab-access/lab.md",
            ".env",
            "conf/.env.local",
        ] {
            assert!(excluded(p), "{p} 应被排除");
        }
        for p in [
            "skills/orchestrator/SKILL.md",
            ".claude-plugin/plugin.json",
            ".gitignore",
            "templates/research/tools/test_records.py",
            "skills/lab-access/lab-profile.example.md",
            "keystore.md",
        ] {
            assert!(!excluded(p), "{p} 不应被排除");
        }
    }

    #[test]
    fn exec_rules() {
        assert!(wants_exec("scripts/a.sh", b"echo"));
        assert!(wants_exec("hooks/lib.sh", b"# lib"));
        assert!(wants_exec("templates/research/tools/test_records.py", b"\"\"\"doc"));
        assert!(wants_exec("bin/run", b"#!/bin/sh\n"));
        assert!(!wants_exec("skills/x/SKILL.md", b"# x"));
        assert!(!wants_exec("lib/util.py", b"import os"));
    }

    #[test]
    fn bundled_research_plugin() {
        let fs = files("research", &Source::Bundled).unwrap();
        assert!(fs.len() >= 30, "内嵌插件文件太少：{}", fs.len());
        assert!(fs.iter().all(|f| !excluded(&f.rel)));
        let p = describe("research", &Source::Bundled, &fs);
        assert_eq!(p.name, "research");
        assert!(!p.version.is_empty());
        assert!(p.skills.contains(&"orchestrator".to_string()));
        assert!(p.skills.contains(&"protocol".to_string()));
        assert!(p.agents.contains(&"executor".to_string()));
        assert!(p.hooks);
        for f in ["scripts/scaffold.sh", "hooks/lib.sh", "templates/research/tools/rk.py", "templates/research/tools/test_records.py"] {
            assert!(fs.iter().find(|x| x.rel == f).unwrap().exec, "{f} 应可执行");
        }
        assert!(!fs.iter().find(|x| x.rel == "skills/orchestrator/SKILL.md").unwrap().exec);
    }

    #[test]
    fn local_override_and_materialize() {
        let base = std::env::temp_dir().join(format!("outpost-unit-plugins-{}", short_id()));
        let src = base.join("mine");
        for d in ["skills/a", "keys", ".git", "scripts"] {
            std::fs::create_dir_all(src.join(d)).unwrap();
        }
        std::fs::write(src.join("skills/a/SKILL.md"), "# a").unwrap();
        std::fs::write(src.join("keys/k"), "secret").unwrap();
        std::fs::write(src.join(".git/HEAD"), "ref").unwrap();
        std::fs::write(src.join("id_rsa"), "secret").unwrap();
        std::fs::write(src.join(".env"), "A=1").unwrap();
        std::fs::write(src.join("scripts/go.sh"), "echo").unwrap();
        set_mode(&src.join("scripts/go.sh"), 0o755).unwrap();
        let settings = Settings {
            plugin_paths: vec![src.to_string_lossy().into_owned(), "/nonexistent/x".into()],
            research_plugin_path: Some(src.to_string_lossy().into_owned()),
            ..Settings::default()
        };
        let mut w = Vec::new();
        let av = available(&settings, &mut w);
        let names: Vec<&str> = av.iter().map(|a| a.info.name.as_str()).collect();
        assert_eq!(names, ["research", "mine"], "research 被本机目录覆盖且保持在前");
        assert_eq!(av[0].info.source, PluginSourceKind::Local);
        assert_eq!(w.len(), 1);
        let mine = &av[1];
        assert_eq!(mine.info.skills, ["a"]);
        let cache = base.join("cache");
        let (dir, n) = materialize(&cache, mine).unwrap();
        assert_eq!(n, 2);
        assert!(dir.join("skills/a/SKILL.md").is_file());
        assert!(!dir.join("keys").exists() && !dir.join(".git").exists() && !dir.join("id_rsa").exists() && !dir.join(".env").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("scripts/go.sh")).unwrap().permissions().mode() & 0o777, 0o755);
            assert_eq!(std::fs::metadata(dir.join("skills/a/SKILL.md")).unwrap().permissions().mode() & 0o777, 0o644);
        }
        // 内容变了换新目录，旧的被清掉。
        std::fs::write(src.join("skills/a/SKILL.md"), "# a2").unwrap();
        let (dir2, _) = materialize(&cache, mine).unwrap();
        assert_ne!(dir, dir2);
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
