//! 终端通道：在本机伪终端里跑 `ssh -tt … <别名> <接入命令>`。
//! 读伪终端是阻塞 IO，用专门的线程桥接到 tokio 通道；写也走专门的线程。
//! 注意：不用 portable-pty 的 `take_writer()`——它在析构时会往终端写“换行 + EOF”，
//! 断开时那两个字节可能被转发进 tmux，让代理或 shell 收到 Ctrl-D。这里改为复制主端 fd 自己写。

use crate::core::{target, Core};
use crate::error::{Error, Result};
use crate::shell::{quote, quote_path, PATH_PRELUDE, TMUX};
use crate::tmux;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

/// 接到哪里（API.md 第 6 节）。
#[derive(Debug, Clone, PartialEq)]
pub enum TermTarget {
    /// 会话的代理窗格（tmux `op-<id>`）
    Agent { session: String },
    /// 会话的工作区 shell（tmux `op-<id>-sh`，不存在则在工作目录里创建）
    Shell { session: String },
    /// 服务器上的普通登录 shell（不进 tmux）
    ServerShell { server: String },
    /// 安装任务（tmux `op-install-<agent_id>`）
    Install { server: String, agent_id: String },
}

/// 远程要执行的接入命令（`None` 表示普通登录 shell）。
pub fn remote_command(t: &TermTarget, workdir: Option<&str>) -> Option<String> {
    inner_command(t, workdir).map(|inner| format!("bash -lc {}", quote(&inner)))
}

/// 接入命令本身（交给 `bash -lc`）。
pub fn inner_command(t: &TermTarget, workdir: Option<&str>) -> Option<String> {
    Some(match t {
        TermTarget::Agent { session } => {
            format!("{PATH_PRELUDE}; exec {TMUX} attach-session -t {}", quote(&tmux::exact(&tmux::agent_session(session))))
        }
        TermTarget::Shell { session } => format!(
            "{PATH_PRELUDE}; mkdir -p {wd} 2>/dev/null; exec {TMUX} new-session -A -s {s} -c {wd}",
            s = quote(&tmux::shell_session(session)),
            wd = quote_path(workdir.unwrap_or("~")),
        ),
        TermTarget::ServerShell { .. } => return None,
        TermTarget::Install { agent_id, .. } => format!(
            "{PATH_PRELUDE}; if ! tmux -L bunsen has-session -t {ex} 2>/dev/null; then echo '没有正在进行或保留着的安装任务 {s}'; exit 1; fi; exec {TMUX} attach-session -t {ex}",
            ex = quote(&tmux::exact(&tmux::install_session(agent_id))),
            s = tmux::install_session(agent_id),
        ),
    })
}

/// 终端里要跑的程序：远程是 `ssh -tt …`，本机直接是 `bash -lc …`（或登录 shell）。
#[derive(Debug, Clone, PartialEq)]
pub struct TermCommand {
    pub program: String,
    pub args: Vec<String>,
    /// 本机：在 `$HOME` 下启动，并去掉会让代理误以为嵌套的环境变量
    pub local: bool,
}

impl Core {
    /// 组出终端要跑的命令：远程是 ssh 加参数，本机是 bash。
    pub fn term_command(&self, t: &TermTarget) -> Result<TermCommand> {
        let (server_key, workdir) = match t {
            TermTarget::Agent { session } | TermTarget::Shell { session } => {
                let rec = self
                    .store
                    .sessions()?
                    .into_iter()
                    .find(|r| r.session.id == *session)
                    .ok_or_else(|| Error::not_found(format!("没有 id 为 {session} 的会话")))?;
                (rec.session.server_id, Some(rec.session.workdir))
            }
            TermTarget::ServerShell { server } | TermTarget::Install { server, .. } => (server.clone(), None),
        };
        if let TermTarget::Install { agent_id, .. } = t {
            if !agent_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b)) || agent_id.is_empty() {
                return Err(Error::bad_request("agent 参数不合法"));
            }
        }
        let sv = if matches!(t, TermTarget::Agent { .. } | TermTarget::Shell { .. }) {
            self.server_by_id(&server_key)?
        } else {
            self.server(&server_key)?
        };
        if sv.is_local() {
            return Ok(match inner_command(t, workdir.as_deref()) {
                Some(inner) => TermCommand { program: "bash".into(), args: vec!["-lc".into(), inner], local: true },
                None => TermCommand {
                    program: std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "bash".into()),
                    args: vec!["-l".into()],
                    local: true,
                },
            });
        }
        let mut args = self.ssh.tty_args();
        args.push(target(&sv));
        if let Some(cmd) = remote_command(t, workdir.as_deref()) {
            args.push(cmd);
        }
        Ok(TermCommand { program: "ssh".into(), args, local: false })
    }
}

/// 一个跑在本机伪终端里的进程。
pub struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    input: Mutex<Option<std::sync::mpsc::Sender<Vec<u8>>>>,
    pid: Option<u32>,
}

/// 启动结果：句柄、输出流（伪终端关闭时结束）、退出码。
pub struct PtySpawn {
    pub pty: Arc<Pty>,
    pub output: mpsc::Receiver<Vec<u8>>,
    pub exit: oneshot::Receiver<Option<u32>>,
}

pub fn spawn(program: &str, args: &[String], cols: u16, rows: u16) -> Result<PtySpawn> {
    spawn_command(&TermCommand { program: program.into(), args: args.to_vec(), local: false }, cols, rows)
}

pub fn spawn_command(tc: &TermCommand, cols: u16, rows: u16) -> Result<PtySpawn> {
    let (program, args) = (tc.program.as_str(), &tc.args);
    let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| Error::internal(format!("无法创建本机伪终端：{e}")))?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.env("TERM", "xterm-256color");
    if tc.local {
        if let Some(h) = std::env::var_os("HOME") {
            cmd.cwd(h);
        }
        for (k, _) in std::env::vars_os() {
            if k.to_str().is_some_and(crate::exec::scrub_var) {
                cmd.env_remove(k);
            }
        }
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| Error::internal(format!("无法启动 {program}：{e}")))?;
    drop(pair.slave);
    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| Error::internal(format!("伪终端读端打不开：{e}")))?;
    let mut writer = master_writer(&*pair.master)?;

    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::Builder::new()
        .name("bunsen-pty-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| Error::internal(format!("无法启动读线程：{e}")))?;

    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name("bunsen-pty-write".into())
        .spawn(move || {
            while let Ok(data) = in_rx.recv() {
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        })
        .map_err(|e| Error::internal(format!("无法启动写线程：{e}")))?;

    let (exit_tx, exit_rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("bunsen-pty-wait".into())
        .spawn(move || {
            let code = child.wait().ok().map(|s| s.exit_code());
            let _ = exit_tx.send(code);
        })
        .map_err(|e| Error::internal(format!("无法启动等待线程：{e}")))?;

    Ok(PtySpawn {
        pty: Arc::new(Pty { master: Mutex::new(pair.master), killer: Mutex::new(killer), input: Mutex::new(Some(in_tx)), pid }),
        output: out_rx,
        exit: exit_rx,
    })
}

#[cfg(unix)]
fn master_writer(master: &dyn MasterPty) -> Result<Box<dyn Write + Send>> {
    use std::os::fd::{BorrowedFd, FromRawFd, IntoRawFd};
    let fd = master.as_raw_fd().ok_or_else(|| Error::internal("伪终端没有文件描述符"))?;
    // SAFETY: fd 在 master 存活期间有效；这里立即复制成独立拥有的 fd。
    let owned = unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
    let file = unsafe { std::fs::File::from_raw_fd(owned.into_raw_fd()) };
    Ok(Box::new(file))
}

#[cfg(not(unix))]
fn master_writer(master: &dyn MasterPty) -> Result<Box<dyn Write + Send>> {
    master.take_writer().map_err(|e| Error::internal(format!("伪终端写端打不开：{e}")))
}

impl Pty {
    pub fn write(&self, data: &[u8]) {
        if let Some(tx) = self.input.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            let _ = tx.send(data.to_vec());
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let size = PtySize { rows: rows.clamp(2, 1000), cols: cols.clamp(10, 1000), pixel_width: 0, pixel_height: 0 };
        self.master.lock().unwrap_or_else(|p| p.into_inner()).resize(size).map_err(|e| Error::internal(format!("调整终端大小失败：{e}")))
    }

    /// 结束本机进程（先 SIGHUP，2 秒后还在就 SIGKILL）。不再接受输入。
    pub fn kill(&self) {
        self.input.lock().unwrap_or_else(|p| p.into_inner()).take();
        let _ = self.killer.lock().unwrap_or_else(|p| p.into_inner()).kill();
        if let Some(pid) = self.pid {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_commands() {
        let a = remote_command(&TermTarget::Agent { session: "abc123".into() }, None).unwrap();
        assert!(a.starts_with("bash -lc '"));
        assert!(a.contains("attach-session -t =op-abc123'"));
        let s = remote_command(&TermTarget::Shell { session: "abc123".into() }, Some("~/w x")).unwrap();
        assert!(s.contains("new-session -A -s op-abc123-sh -c \"$HOME\"/'\\''w x'\\''"), "{s}");
        assert!(remote_command(&TermTarget::ServerShell { server: "x".into() }, None).is_none());
        let i = remote_command(&TermTarget::Install { server: "x".into(), agent_id: "codex".into() }, None).unwrap();
        assert!(i.contains("=op-install-codex"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_echo_roundtrip() {
        // 本机伪终端里跑 cat：写进去的内容会被回显。
        let mut sp = spawn("cat", &[], 80, 24).unwrap();
        sp.pty.write(b"hello-pty\n");
        let mut got = Vec::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !String::from_utf8_lossy(&got).contains("hello-pty") {
            match tokio::time::timeout_at(deadline, sp.output.recv()).await {
                Ok(Some(b)) => got.extend(b),
                _ => break,
            }
        }
        assert!(String::from_utf8_lossy(&got).contains("hello-pty"));
        sp.pty.resize(100, 30).unwrap();
        sp.pty.kill();
        let code = tokio::time::timeout(std::time::Duration::from_secs(5), sp.exit).await.unwrap().unwrap();
        assert!(code.is_some());
    }
}
