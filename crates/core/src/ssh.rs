//! 调用系统 ssh。所有连接都用 `-F <数据目录>/ssh/config`；连接选项（ControlMaster 等）
//! 写在那个文件的 `Host *` 块里，命令行只加 BatchMode / -T / -tt。

use crate::error::{classify_ssh_error, Result};
use crate::shell::{quote, wrap_script};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
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
        let text = crate::error::redact(&self.stderr);
        text.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("").chars().take(300).collect()
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

/// 无 python/setsid 依赖的远端监督器：job control 为脚本建立进程组，
/// SSH 输入 EOF 和远端自身超时都会先 TERM，给 rk 三秒清理，再 KILL。
pub(crate) fn supervised_script(body: &str, timeout: Duration) -> (String, Vec<u8>) {
    let supervisor = format!(
        r#"exec 3>&2
exec 2>/dev/null
set -m
d=$(mktemp -d) || exit 2
f="$d/script"
child=; watcher=; timer=
cleanup() {{
    trap - EXIT
    [ -z "$watcher" ] || {{ kill -KILL -- "-$watcher" 2>/dev/null || kill -KILL "$watcher" 2>/dev/null || true; }}
    [ -z "$timer" ] || {{ kill -KILL -- "-$timer" 2>/dev/null || kill -KILL "$timer" 2>/dev/null || true; }}
    [ -z "$watcher" ] || wait "$watcher" 2>/dev/null || true
    [ -z "$timer" ] || wait "$timer" 2>/dev/null || true
    rm -rf -- "$d"
}}
cancel_group() {{
    trap '' TERM HUP INT
    # mkdir 是正常结束与取消之间的仲裁点，不能从退出码猜测原因。
    if mkdir "$d/claimed" 2>/dev/null; then
        printf '%s\n' "$1" > "$d/reason"
        kill -TERM -- "-$child" 2>/dev/null || true
        sleep 3
        kill -KILL -- "-$child" 2>/dev/null || true
        : > "$d/killed"
    fi
}}
await_cancel() {{
    for n in $(seq 1 60); do
        [ ! -f "$d/killed" ] || break
        sleep .1
    done
    [ -f "$d/killed" ] || kill -KILL -- "-$child" 2>/dev/null || true
}}
stop() {{
    trap '' TERM HUP INT
    # 独立 job 负责 KILL，即使监督 shell 随后被 KILL 也不能撤销它。
    (cancel_group 143) </dev/null >/dev/null 2>&1 3>&- &
    wait "$!" 2>/dev/null || true
    await_cancel
    exit 143
}}
trap cleanup EXIT
trap stop TERM HUP INT
IFS= read -r size || exit 2
case "$size" in ''|*[!0-9]*) exit 2 ;; esac
head -c "$size" > "$f"
[ "$(wc -c < "$f" | tr -d ' ')" = "$size" ] || exit 2
bash "$f" </dev/null 2>&3 3>&- &
child=$!
(trap '' HUP TERM; sleep {seconds}; cancel_group 124) >/dev/null 2>&1 3>&- &
timer=$!
(trap '' HUP TERM; cat >/dev/null; cancel_group 143; kill -KILL -- "-$timer" 2>/dev/null || true) <&0 >/dev/null 2>&1 3>&- &
watcher=$!
wait "$child"
rc=$?
if mkdir "$d/claimed" 2>/dev/null; then
    # 正常完成：包括 exit 200；原样返回，不把 >128 当作取消。
    exit "$rc"
fi
# 取消方已取得仲裁权。组长 exit 0 也必须等到整组 KILL 已执行。
await_cancel
reason=$(cat "$d/reason" 2>/dev/null || echo 143)
exit "$reason"
"#,
        seconds = timeout.as_secs_f64()
    );
    let script = wrap_script(body);
    let input = format!("{}\n{}", script.len(), script).into_bytes();
    (format!("bash -c {}", quote(&supervisor)), input)
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

    /// 在 `target` 上执行受监督的 bash 脚本；长度前缀帧从标准输入送入，通道 EOF 用于取消。
    /// ssh 自身失败（退出码 255）时按标准错误识别成对应错误码。
    pub async fn run(&self, target: &str, body: &str, timeout: Duration) -> Result<RemoteOutput> {
        self.run_with(target, body, timeout, &[]).await
    }

    pub async fn run_with(&self, target: &str, body: &str, timeout: Duration, extra: &[String]) -> Result<RemoteOutput> {
        self.run_named(target, target, body, timeout, extra).await
    }

    /// SSH 连接目标和用户可见别名分开；诊断不能把 op-<id> 当成服务器名称。
    pub(crate) async fn run_named(
        &self,
        target: &str,
        alias: &str,
        body: &str,
        timeout: Duration,
        extra: &[String],
    ) -> Result<RemoteOutput> {
        let (remote, input) = supervised_script(body, timeout);
        let mut cmd = Command::new("ssh");
        cmd.args(self.batch_args()).arg("-T").args(extra).arg(target).arg(remote);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let out = crate::exec::run_command(cmd, input, timeout, true, alias).await?;
        let code = out.code;
        let stderr = out.stderr;
        if code == 255 {
            return Err(classify_ssh_error(&stderr));
        }
        Ok(RemoteOutput { code, stdout: out.stdout, stderr, elapsed: out.elapsed })
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

#[cfg(all(test, unix))]
mod r3_tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    fn command(body: &str, timeout: Duration) -> (String, Vec<u8>) {
        let (current, input) = supervised_script(body, timeout);
        // 仅撤回验证显式提供冻结的旧监督器；正常测试始终走产品函数。
        let command = std::env::var_os("BUNSEN_R3_SUPERVISOR_FIXTURE").map(|p| std::fs::read_to_string(p).unwrap()).unwrap_or(current);
        (command, input)
    }
    #[tokio::test]
    async fn normal_exit_200_is_not_cancellation() {
        let (command, input) = command("printf normal-output; exit 200\n", Duration::from_secs(2));
        let mut child = Command::new("bash")
            .args(["-c", &command])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(&input).await.unwrap();
        // Keep control channel open: this is normal completion, not EOF cancellation.
        let out = tokio::time::timeout(Duration::from_secs(6), child.wait_with_output()).await.unwrap().unwrap();
        drop(stdin);
        assert_eq!(out.status.code(), Some(200), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(out.stdout, b"normal-output");
    }
    #[tokio::test]
    async fn cancelled_group_killed_even_when_leader_exits_zero() {
        tokio::time::timeout(Duration::from_secs(24), async {
            for eof in [false, true] {
                let root = std::env::temp_dir().join(format!("bunsen-r3-ssh-{}", crate::util::short_id()));
                std::fs::create_dir_all(&root).unwrap();
                let pidfile = root.join("descendant.pid");
                let body = format!(
                    "trap 'exit 0' TERM\nsh -c {} >/dev/null 2>&1 &\nwait\n",
                    quote(&format!(
                        "trap '' TERM HUP INT; printf '%s\\n' \"$$\" > {0}.tmp; mv -- {0}.tmp {0}; exec sleep 30",
                        quote(pidfile.to_str().unwrap())
                    ))
                );
                let (command, input) = command(&body, Duration::from_secs(1));
                let mut child = Command::new("bash")
                    .args(["-c", &command])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true)
                    .process_group(0)
                    .spawn()
                    .unwrap();
                let mut group = crate::exec::ProcessGroup::new(&child);
                let mut stdin = child.stdin.take().unwrap();
                stdin.write_all(&input).await.unwrap();
                tokio::time::timeout(Duration::from_secs(3), async {
                    while !pidfile.exists() {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("descendant did not start");
                let pid = std::fs::read_to_string(&pidfile).unwrap();
                if eof {
                    drop(stdin);
                } // EOF must be distinguished from a normal exit 0.
                let out = tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await.expect("supervisor hung").unwrap();
                group.disarm();
                let probe = Command::new("/bin/kill").args(["-0", "--", pid.trim()]).output().await.unwrap();
                if probe.status.success() {
                    let _ = Command::new("/bin/kill").args(["-KILL", "--", pid.trim()]).status().await;
                }
                std::fs::remove_dir_all(root).unwrap();
                assert!(
                    !probe.status.success(),
                    "eof={eof}: TERM-ignoring descendant {pid} survived; supervisor exit={:?}",
                    out.status.code()
                );
                assert_eq!(out.status.code(), Some(if eof { 143 } else { 124 }));
            }
        })
        .await
        .expect("supervisor group regression exceeded 24s");
    }
}
