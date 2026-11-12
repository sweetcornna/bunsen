//! 数据目录与持久化。每次读写都在进程内的锁里重新读文件，
//! 这样 serve、命令行、MCP 三个进程共用同一个数据目录时不会拿着旧数据覆盖别人的修改。

use crate::error::{Error, Result};
use crate::model::{Agent, Server, SessionRecord, Settings};
use crate::util::{atomic_write, ensure_dir};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone)]
pub struct Paths {
    pub data: PathBuf,
    pub cm_dir: PathBuf,
}

impl Paths {
    /// `OUTPOST_DATA_DIR` 优先；否则 macOS `~/Library/Application Support/outpost`，
    /// 其他系统 `$XDG_DATA_HOME/outpost` 或 `~/.local/share/outpost`。
    pub fn from_env() -> Result<Paths> {
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let data = match std::env::var_os("OUTPOST_DATA_DIR").filter(|v| !v.is_empty()) {
            Some(d) => PathBuf::from(d),
            None => {
                let home = home.clone().ok_or_else(|| Error::internal("找不到 HOME 目录"))?;
                if cfg!(target_os = "macos") {
                    home.join("Library/Application Support/outpost")
                } else if cfg!(windows) {
                    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or(home).join("outpost")
                } else {
                    std::env::var_os("XDG_DATA_HOME")
                        .filter(|v| !v.is_empty())
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".local/share"))
                        .join("outpost")
                }
            }
        };
        let cm_dir = match std::env::var_os("OUTPOST_CM_DIR").filter(|v| !v.is_empty()) {
            Some(d) => PathBuf::from(d),
            None => {
                let d = home.ok_or_else(|| Error::internal("找不到 HOME 目录"))?.join(".cache/outpost/cm");
                // 套接字路径上限约 104 字节，ssh 还要加 40 位的 %C 和临时后缀；主目录太长时改用 /tmp。
                if cfg!(unix) && d.as_os_str().len() > 44 {
                    let user = std::env::var("USER").unwrap_or_else(|_| "user".into());
                    let safe: String = user.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(16).collect();
                    PathBuf::from(format!("/tmp/outpost-cm-{safe}"))
                } else {
                    d
                }
            }
        };
        Ok(Paths { data, cm_dir })
    }

    pub fn keys_dir(&self) -> PathBuf {
        self.data.join("keys")
    }
    pub fn ssh_dir(&self) -> PathBuf {
        self.data.join("ssh")
    }
    pub fn ssh_config(&self) -> PathBuf {
        self.data.join("ssh/config")
    }
    pub fn known_hosts(&self) -> PathBuf {
        self.data.join("ssh/known_hosts")
    }
    fn file(&self, name: &str) -> PathBuf {
        self.data.join(name)
    }

    pub fn ensure(&self) -> Result<()> {
        ensure_dir(&self.data, 0o700)?;
        ensure_dir(&self.keys_dir(), 0o700)?;
        ensure_dir(&self.ssh_dir(), 0o700)?;
        ensure_dir(&self.cm_dir, 0o700)?;
        Ok(())
    }
}

pub struct Store {
    pub paths: Paths,
    lock: Mutex<()>,
}

const SERVERS: &str = "servers.json";
const SESSIONS: &str = "sessions.json";
const AGENTS: &str = "agents.json";
const SETTINGS: &str = "config.toml";

fn read_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match std::fs::read(path) {
        Ok(b) if b.iter().all(u8::is_ascii_whitespace) => Ok(T::default()),
        Ok(b) => serde_json::from_slice(&b)
            .map_err(|e| Error::internal(format!("{} 格式不对：{e}", path.display())).with_hint("可以先备份再删掉这个文件，Outpost 会重新生成")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(e.into()),
    }
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<()> {
    let mut data = serde_json::to_vec_pretty(v)?;
    data.push(b'\n');
    atomic_write(path, &data, Some(0o600))?;
    Ok(())
}

impl Store {
    pub fn open(paths: Paths) -> Result<Store> {
        paths.ensure()?;
        Ok(Store { paths, lock: Mutex::new(()) })
    }

    fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn servers(&self) -> Result<Vec<Server>> {
        let _g = self.guard();
        read_json(&self.paths.file(SERVERS))
    }

    /// 读改写服务器列表；闭包返回 Err 时不写盘。
    pub fn update_servers<R>(&self, f: impl FnOnce(&mut Vec<Server>) -> Result<R>) -> Result<R> {
        let _g = self.guard();
        let path = self.paths.file(SERVERS);
        let mut v: Vec<Server> = read_json(&path)?;
        let r = f(&mut v)?;
        write_json(&path, &v)?;
        Ok(r)
    }

    pub fn sessions(&self) -> Result<Vec<SessionRecord>> {
        let _g = self.guard();
        read_json(&self.paths.file(SESSIONS))
    }

    pub fn update_sessions<R>(&self, f: impl FnOnce(&mut Vec<SessionRecord>) -> Result<R>) -> Result<R> {
        let _g = self.guard();
        let path = self.paths.file(SESSIONS);
        let mut v: Vec<SessionRecord> = read_json(&path)?;
        let r = f(&mut v)?;
        write_json(&path, &v)?;
        Ok(r)
    }

    /// 自定义与被覆盖的 Agent（不含未改动的内置项）。
    pub fn custom_agents(&self) -> Result<Vec<Agent>> {
        let _g = self.guard();
        read_json(&self.paths.file(AGENTS))
    }

    pub fn update_agents<R>(&self, f: impl FnOnce(&mut Vec<Agent>) -> Result<R>) -> Result<R> {
        let _g = self.guard();
        let path = self.paths.file(AGENTS);
        let mut v: Vec<Agent> = read_json(&path)?;
        let r = f(&mut v)?;
        write_json(&path, &v)?;
        Ok(r)
    }

    pub fn settings(&self) -> Result<Settings> {
        let _g = self.guard();
        let path = self.paths.file(SETTINGS);
        match std::fs::read_to_string(&path) {
            Ok(s) => toml::from_str(&s).map_err(|e| {
                Error::internal(format!("{} 格式不对：{e}", path.display())).with_hint("可以删掉这个文件恢复默认设置")
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn put_settings(&self, s: &Settings) -> Result<()> {
        let _g = self.guard();
        // TOML 没有 null：先转成 JSON 去掉空值再写。
        let mut v = serde_json::to_value(s)?;
        if let Some(m) = v.as_object_mut() {
            m.retain(|_, x| !x.is_null());
        }
        let text = toml::to_string(&v).map_err(|e| Error::internal(format!("设置序列化失败：{e}")))?;
        let body = format!("# Outpost 设置（不含密钥）\n{text}");
        atomic_write(&self.paths.file(SETTINGS), body.as_bytes(), Some(0o600))?;
        Ok(())
    }

    /// 写生成的 ssh 配置。
    pub fn write_ssh_config(&self, text: &str) -> Result<()> {
        let _g = self.guard();
        atomic_write(&self.paths.ssh_config(), text.as_bytes(), Some(0o600))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Theme;

    pub fn temp_paths(tag: &str) -> Paths {
        let base = std::env::temp_dir().join(format!("outpost-unit-{tag}-{}", crate::util::short_id()));
        Paths { data: base.join("data"), cm_dir: base.join("cm") }
    }

    #[test]
    fn settings_roundtrip_with_nulls() {
        let p = temp_paths("settings");
        let st = Store::open(p.clone()).unwrap();
        assert_eq!(st.settings().unwrap(), Settings::default());
        let s = Settings {
            theme: Theme::Dark,
            default_server: Some("s1".into()),
            default_agent: None,
            research_plugin_path: Some("/a b/research".into()),
            status_interval_secs: 15,
            plugin_paths: vec!["/x/lab kit".into()],
        };
        st.put_settings(&s).unwrap();
        assert_eq!(st.settings().unwrap(), s);
        let _ = std::fs::remove_dir_all(p.data.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn data_dir_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let p = temp_paths("perm");
        let st = Store::open(p.clone()).unwrap();
        st.update_servers(|_| Ok(())).unwrap();
        let mode = std::fs::metadata(&p.data).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let mode = std::fs::metadata(p.data.join("servers.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(p.data.parent().unwrap());
    }
}
