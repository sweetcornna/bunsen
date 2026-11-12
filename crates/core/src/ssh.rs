//! 调用系统 ssh。所有连接都用 `-F <数据目录>/ssh/config`；连接选项（ControlMaster 等）
//! 写在那个文件的 `Host *` 块里，命令行只加 BatchMode / -T / -tt。

use crate::error::{classify_ssh_error, Error, Result};
use crate::shell::wrap_script;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct Ssh {
    pub config: PathBuf,
}

#[derive(Debug, Clone)]
pub struct RemoteOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub elapsed: Duration,
}

impl RemoteOutput {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    /// 标准错误的最后一行有效内容，用于错误信息。
    pub fn err_line(&self) -> String {
        self.stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").chars().take(300).collect()
    }
}

/// `-i` 之类会做 `%` 展开的路径参数。
pub fn escape_percent(p: &Path) -> String {
    p.to_string_lossy().replace('%', "%%")
}

/// 只用某一把密钥、不复用 ControlMaster 的额外参数（逐把试密钥时用）。
pub fn only_key_args(key: &Path) -> Vec<String> {
    vec![
        "-i".into(),
        escape_percent(key),
        "-o".into(),
        "IdentitiesOnly=yes".into(),
        "-o".into(),
        "ControlMaster=no".into(),
        "-o".into(),
        "ControlPath=none".into(),
    ]
}

impl Ssh {
    pub fn new(config: PathBuf) -> Self {
        Ssh { config }
    }

    /// 非交互调用的公共参数。
    pub fn batch_args(&self) -> Vec<String> {
        vec!["-F".into(), self.config.to_string_lossy().into_owned(), "-o".into(), "BatchMode=yes".into()]
    }

    /// 交互终端（本机伪终端或当前终端）的参数：`-tt`，不用 BatchMode。
    pub fn tty_args(&self) -> Vec<String> {
        vec!["-F".into(), self.config.to_string_lossy().into_owned(), "-tt".into()]
    }

    /// rsync `-e` 用的远程 shell 命令（rsync 支持其中的单引号）。
    pub fn rsync_rsh(&self) -> String {
        format!("ssh -F '{}' -o BatchMode=yes", self.config.to_string_lossy())
    }

    /// 在 `target` 上执行脚本：`ssh … target bash -s`，脚本（含 PATH 前导）从标准输入送入。
    /// ssh 自身失败（退出码 255）时按标准错误识别成对应错误码。
    pub async fn run(&self, target: &str, body: &str, timeout: Duration) -> Result<RemoteOutput> {
        self.run_with(target, body, timeout, &[]).await
    }

    pub async fn run_with(&self, target: &str, body: &str, timeout: Duration, extra: &[String]) -> Result<RemoteOutput> {
        let script = wrap_script(body);
        let mut cmd = Command::new("ssh");
        cmd.args(self.batch_args()).arg("-T").args(extra).arg(target).arg("bash -s");
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let start = Instant::now();
        let mut child = cmd.spawn().map_err(|e| {
            Error::internal(format!("无法启动本机的 ssh：{e}")).with_hint("Outpost 依赖系统自带的 OpenSSH 客户端（ssh 命令）")
        })?;
        if let Some(mut stdin) = child.stdin.take() {
            // ssh 提前失败时写入会遇到断管，忽略即可，错误从退出码与标准错误里取。
            let _ = stdin.write_all(script.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
        let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(r) => r?,
            Err(_) => {
                return Err(Error::timeout(format!("服务器在 {} 秒内没有完成操作", timeout.as_secs()))
                    .with_hint("网络可能不稳定，或服务器负载过高；稍后重试"))
            }
        };
        let code = out.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if code == 255 {
            return Err(classify_ssh_error(&stderr));
        }
        Ok(RemoteOutput { code, stdout: out.stdout, stderr, elapsed: start.elapsed() })
    }

    /// 关掉某个目标的 ControlMaster（换密钥、删服务器时用）。
    pub async fn close_master(&self, target: &str) {
        let _ = Command::new("ssh")
            .args(self.batch_args())
            .args(["-O", "exit", target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status()
            .await;
    }
}

/// 本机有没有某个命令（`<cmd> --version` 能跑起来）。
pub async fn local_has(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}
