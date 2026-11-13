//! 执行器：服务器上的操作都是“把一段 bash 脚本交给某台机器执行”。远程走 ssh 的受监督脚本（见 ssh.rs），
//! 本机（`ServerSource::Local`）把同一段脚本直接交给本机的 `bash -s`，在 `$HOME` 下执行。
//! 两边用同一套脚本、同一个 PATH 前导，所以部署、状态、工作区、科研面板不用分两套写。

use crate::error::{Error, Result};
use crate::shell::wrap_script;
use crate::ssh::RemoteOutput;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

/// 本机服务器记录的固定 id。
pub const LOCAL_ID: &str = "local";

/// 不带进本机会话的环境变量：Bunsen 自己若是从某个编码代理里启动的，
/// 这些变量会让本机 tmux 里的代理以为自己是嵌套会话。
pub fn scrub_var(name: &str) -> bool {
    name == "CLAUDECODE" || name.starts_with("CLAUDE_CODE_") || name == "TMUX" || name == "TMUX_PANE"
}

fn home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(Into::into).filter(|p: &std::path::PathBuf| p.is_dir())
}

/// 超时或 future 被取消时也杀掉子孙进程，不能只依赖 Child::kill_on_drop。
pub(crate) struct ProcessGroup(Option<u32>);
impl ProcessGroup {
    pub(crate) fn new(child: &tokio::process::Child) -> Self {
        Self(child.id())
    }
    pub(crate) fn disarm(&mut self) {
        self.0 = None;
    }
    fn signal(id: u32, signal: &str) {
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("/bin/kill")
                .args([signal, "--", &format!("-{id}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(not(unix))]
        let _ = (id, signal);
    }
    pub(crate) fn kill(&mut self) {
        if let Some(id) = self.0.take() {
            Self::signal(id, "-KILL");
        }
    }
    pub(crate) async fn terminate(&mut self) {
        if let Some(id) = self.0 {
            Self::signal(id, "-TERM");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
        self.kill();
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // 取消 future 也先通知 rk；不能在 Drop 中阻塞异步运行时。
        if let Some(id) = self.0.take() {
            Self::signal(id, "-TERM");
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                Self::signal(id, "-KILL");
            });
        }
    }
}

// 原始文件下载上限为 32 MiB；执行器留足协议头余量，但不能无限积累输出。
const LOCAL_OUTPUT_LIMIT: usize = 64 * 1024 * 1024;
async fn local_output(reader: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut data = Vec::new();
    reader.take(LOCAL_OUTPUT_LIMIT as u64 + 1).read_to_end(&mut data).await?;
    if data.len() > LOCAL_OUTPUT_LIMIT {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "本机输出超过 64 MiB 上限"));
    }
    Ok(data)
}

/// 在本机执行脚本（`bash -s`，脚本从标准输入送入），输出格式与远程一致。
pub async fn run_local(body: &str, timeout: Duration) -> Result<RemoteOutput> {
    let script = wrap_script(body);
    let mut cmd = Command::new("bash");
    cmd.arg("-s");
    if let Some(h) = home() {
        cmd.current_dir(h);
    }
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_some_and(scrub_var) {
            cmd.env_remove(&k);
        }
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    run_command(cmd, script.into_bytes(), timeout, false, "").await
}

/// SSH 的输入通道在完成之前保持打开；关闭通道就是远端监督器的取消通知。
pub(crate) async fn run_command(
    mut cmd: Command,
    script: Vec<u8>,
    timeout: Duration,
    control_channel: bool,
    server_alias: &str,
) -> Result<RemoteOutput> {
    #[cfg(unix)]
    cmd.process_group(0);
    let start = Instant::now();
    let mut child =
        cmd.spawn().map_err(|e| Error::internal(format!("无法启动命令 {}：{e}", cmd.as_std().get_program().to_string_lossy())))?;
    let mut group = ProcessGroup::new(&child);
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    // 同时送输入、读两路输出并等待：管道写满也在同一个超时预算内。
    let result = tokio::time::timeout(timeout, async {
        tokio::try_join!(
            async move {
                match stdin.write_all(&script).await {
                    Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(None),
                    Err(e) => Err(e),
                    Ok(()) if control_channel => Ok(Some(stdin)),
                    Ok(()) => {
                        stdin.shutdown().await?;
                        Ok(None)
                    }
                }
            },
            local_output(stdout),
            local_output(stderr),
            child.wait()
        )
    })
    .await;
    let (status, out, err) = match result {
        Ok(Ok((_, out, err, status))) => {
            group.disarm();
            (status, out, err)
        }
        other => {
            // 控制通道已随 timeout future 关闭；先让远端完成 TERM/清理/KILL。
            if control_channel && tokio::time::timeout(Duration::from_secs(4), child.wait()).await.is_ok() {
                group.disarm();
            } else {
                group.terminate().await;
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            return match other {
                Err(_) => {
                    let location = if control_channel { format!("服务器 {server_alias} 在") } else { "本机在".into() };
                    Err(Error::timeout(format!("{location} {} 秒内没有完成操作", timeout.as_secs())))
                }
                Ok(Err(e)) => Err(e.into()),
                _ => unreachable!(),
            };
        }
    };
    Ok(RemoteOutput {
        code: status.code().unwrap_or(-1),
        stdout: out,
        stderr: String::from_utf8_lossy(&err).into_owned(),
        elapsed: start.elapsed(),
    })
}

/// 把本机目录整份复制到 `dst`（先删掉旧的）；保留文件权限，不跟随符号链接。
pub fn copy_dir(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if dst.exists() {
        std::fs::remove_dir_all(dst)?;
    }
    std::fs::create_dir_all(dst)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let t = e.file_type()?;
        let to = dst.join(e.file_name());
        if t.is_dir() {
            copy_dir(&e.path(), &to)?;
        } else if t.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(std::fs::read_link(e.path())?, &to)?;
        } else {
            std::fs::copy(e.path(), &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_runs_script_in_home() {
        let out = run_local("echo \"$PWD\"; echo err >&2; exit 3", Duration::from_secs(10)).await.unwrap();
        assert_eq!(out.code, 3);
        assert_eq!(out.text().trim(), std::env::var("HOME").unwrap());
        assert_eq!(out.err_line(), "err");
    }

    #[tokio::test]
    async fn local_scrubs_agent_env() {
        std::env::set_var("CLAUDE_CODE_TEST_SCRUB", "1");
        let out = run_local("echo \"[${CLAUDE_CODE_TEST_SCRUB:-}]\"", Duration::from_secs(10)).await.unwrap();
        assert_eq!(out.text().trim(), "[]");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_timeout_kills_grandchild_and_covers_pipes() {
        let root = std::env::temp_dir().join(format!("bunsen-timeout-{}", crate::util::short_id()));
        std::fs::create_dir_all(&root).unwrap();
        let pid = root.join("pid");
        let script = format!(
            "bash -c 'echo $$ > {}; sleep 1; echo survived > {}; sleep 60' & wait",
            crate::shell::quote(pid.to_str().unwrap()),
            crate::shell::quote(root.join("survived").to_str().unwrap())
        );
        let err = run_local(&script, Duration::from_millis(500)).await.unwrap_err();
        assert_eq!(err.code, crate::error::Code::Timeout);
        let pid = std::fs::read_to_string(pid).unwrap();
        // 不依赖受沙箱限制的 ps/proc：活着的孙进程会在截止时间后写出 survived。
        assert!(!pid.trim().is_empty());
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert!(!root.join("survived").exists(), "孙进程超时后仍在执行");
        let probe = std::process::Command::new("kill").args(["-0", "--", pid.trim()]).output().unwrap();
        assert!(
            !probe.status.success() && String::from_utf8_lossy(&probe.stderr).to_lowercase().contains("no such process"),
            "孙进程未回收：{}",
            String::from_utf8_lossy(&probe.stderr)
        );
        let huge = format!("sleep 60\n#{}", "x".repeat(2 * 1024 * 1024));
        let start = Instant::now();
        assert_eq!(run_local(&huge, Duration::from_millis(200)).await.unwrap_err().code, crate::error::Code::Timeout);
        assert!(start.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn local_output_is_bounded() {
        let script = format!("head -c {} /dev/zero", LOCAL_OUTPUT_LIMIT + 1);
        let err = run_local(&script, Duration::from_secs(10)).await.unwrap_err();
        assert!(err.message.contains("64 MiB"), "{}", err.message);
    }

    #[tokio::test]
    async fn early_ssh_failure_preserves_status_instead_of_broken_pipe() {
        let mut cmd = Command::new("bash");
        cmd.args(["-c", "echo 'Permission denied (publickey).' >&2; exit 255"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let out = run_command(cmd, vec![b'x'; 2 * 1024 * 1024], Duration::from_secs(3), true, "test").await.unwrap();
        assert_eq!(out.code, 255);
        assert_eq!(crate::error::classify_ssh_error(&out.stderr).code, crate::error::Code::AuthFailed);
    }

    #[tokio::test]
    async fn ssh_envelope_preserves_normal_output_and_status() {
        let (command, input) = crate::ssh::supervised_script("printf hello; echo err >&2; exit 3", Duration::from_secs(10));
        let mut cmd = Command::new("bash");
        cmd.args(["-c", &command]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let out = run_command(cmd, input, Duration::from_secs(10), true, "test").await.unwrap();
        assert_eq!(out.code, 3);
        assert_eq!(out.text(), "hello");
        assert_eq!(out.stderr, "err\n");
    }

    #[tokio::test]
    async fn remote_cancel_hard_kills_uncooperative_group() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let root = std::env::temp_dir().join(format!("bunsen-remote-cancel-{}", crate::util::short_id()));
            std::fs::create_dir_all(&root).unwrap();
            let pid = root.join("pid");
            let body = format!(
                "trap '' TERM HUP; printf '%s\\n' \"$$\" > {0}.tmp; mv -- {0}.tmp {0}; sleep 60",
                crate::shell::quote(pid.to_str().unwrap())
            );
            let (command, input) = crate::ssh::supervised_script(&body, Duration::from_secs(30));
            let task = tokio::spawn(async move {
                let mut cmd = Command::new("bash");
                cmd.args(["-c", &command]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
                run_command(cmd, input, Duration::from_secs(30), true, "test").await
            });
            while !pid.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let pid = std::fs::read_to_string(&pid).unwrap();
            assert!(pid.trim().parse::<u32>().is_ok_and(|pid| pid > 1), "invalid fixture PID: {pid:?}");
            task.abort();
            let _ = task.await;
            // 监督器异步执行三秒宽限，不以单一固定采样时刻判断；仍设置严格上限。
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                let probe = Command::new("/bin/kill").args(["-0", "--", pid.trim()]).kill_on_drop(true).output().await.unwrap();
                if !probe.status.success() && String::from_utf8_lossy(&probe.stderr).to_lowercase().contains("no such process") {
                    break;
                }
                if Instant::now() >= deadline {
                    // 仅清理本夹具记录的进程组；清理后仍然让测试失败，不能掩盖泄漏。
                    let _ = Command::new("/bin/kill").args(["-KILL", "--", &format!("-{}", pid.trim())]).status().await;
                    panic!(
                        "remote group {pid} survived cancellation: status={:?}, stderr={}",
                        probe.status.code(),
                        String::from_utf8_lossy(&probe.stderr)
                    );
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            std::fs::remove_dir_all(root).unwrap();
        })
        .await
        .expect("uncooperative remote cancellation exceeded 20s");
    }

    #[tokio::test]
    async fn integration_local_timeout_names_local() {
        let err = tokio::time::timeout(Duration::from_secs(8), run_local("sleep 30", Duration::from_secs(1)))
            .await
            .expect("local timeout regression exceeded 8s")
            .unwrap_err();
        assert_eq!(err.code, crate::error::Code::Timeout);
        assert_eq!(err.message, "本机在 1 秒内没有完成操作");
    }

    #[tokio::test]
    async fn integration_remote_timeout_names_server_alias() {
        tokio::time::timeout(Duration::from_secs(15), async {
            let root = std::env::temp_dir().join(format!("bunsen-i1-timeout-{}", crate::util::short_id()));
            let core = crate::Core::open_at(crate::store::Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
            let local = core.server("local").unwrap();
            let remote =
                crate::model::Server { id: "remote1".into(), alias: "srva".into(), source: crate::model::ServerSource::Manual, ..local };
            // 真实 ssh，但只运行本测试的 ProxyCommand；不连接网络或容器。
            std::fs::write(core.paths().ssh_config(), "Host op-remote1\n  ProxyCommand exec sleep 30\n  ControlMaster no\n").unwrap();
            let err = core.exec(&remote, "echo never", Duration::from_secs(1)).await.unwrap_err();
            assert_eq!(err.code, crate::error::Code::Timeout);
            assert_eq!(err.message, "服务器 srva 在 1 秒内没有完成操作");
            std::fs::remove_dir_all(root).unwrap();
        })
        .await
        .expect("remote alias timeout regression exceeded 15s");
    }

    #[test]
    fn copy_keeps_modes() {
        let base = std::env::temp_dir().join(format!("bunsen-copy-{}", std::process::id()));
        let src = base.join("src");
        std::fs::create_dir_all(src.join("d")).unwrap();
        std::fs::write(src.join("d/x.sh"), "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(src.join("d/x.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dst = base.join("dst");
        std::fs::create_dir_all(dst.join("stale")).unwrap();
        copy_dir(&src, &dst).unwrap();
        assert!(dst.join("d/x.sh").is_file());
        assert!(!dst.join("stale").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dst.join("d/x.sh")).unwrap().permissions().mode() & 0o777, 0o755);
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
