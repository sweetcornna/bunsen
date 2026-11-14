use super::*;
use crate::model::{Session, SessionRecord};
use crate::store::Paths;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) struct Fixture {
    pub root: PathBuf,
    pub work: PathBuf,
    pub core: Arc<Core>,
}
impl Fixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!("bunsen-quality-{}", short_id()));
        let work = root.join("work");
        std::fs::create_dir_all(work.join("research/tools")).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/quality");
        for entry in std::fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let to = if entry.file_name() == "rk.py" {
                work.join("research/tools/rk.py")
            } else {
                work.join("research").join(entry.file_name())
            };
            std::fs::copy(entry.path(), to).unwrap();
        }
        std::fs::write(work.join("research/PROJECT.md"), "fixture").unwrap();
        let core = Core::open_at(Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        let session: Session = serde_json::from_value(json!({
            "id":"test01", "title":"quality", "server_id":"local", "server_alias":"本机", "agent_id":"codex", "workdir":work,
            "tmux":"unused", "created_at":now_rfc3339(), "last_active_at":null, "state":"stopped", "exit_status":null,
            "attached":0,"pinned":false,"archived":false,"plugin":null,"plugins":[],"yolo":false,
            "preview":null,"attach_cmd":"","origin":"local","project_id":null,"machine":null
        }))
        .unwrap();
        core.store
            .update_sessions(|v| {
                v.push(SessionRecord { session, extra_args: None });
                Ok(())
            })
            .unwrap();
        Self { root, work, core }
    }
    pub fn write(&self, path: &str, data: impl AsRef<[u8]>) {
        let path = self.work.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, data).unwrap();
    }
    async fn trust(&self, per: f64, total: f64) -> ResearchTrust {
        let script = trust_script(self.work.to_str().unwrap(), "__TEST__", per, total);
        let out = crate::exec::run_local(&script, Duration::from_secs(25)).await.unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        parse_trust(&out.text(), "__TEST__", &out.stderr).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn version_gating_is_numeric_and_conservative() {
    for v in ["0.6.0", "0.10.0", "1.0.0"] {
        assert!(quality_version(v));
    }
    for v in ["0.5.99", "", "0.6", "0.6.0rc1", "0.6.0.1"] {
        assert!(!quality_version(v));
    }
    assert_eq!(rk_version("# RK_VERSION = 'wrong'\nRK_VERSION = \"0.6.0\" # comment"), Some("0.6.0".into()));
}

#[tokio::test]
async fn trust_unavailable_reasons_never_execute_rk() {
    let f = Fixture::new();
    std::fs::rename(f.work.join("research"), f.work.join("saved")).unwrap();
    let v = f.core.research_trust("test01").await.unwrap();
    assert_eq!(v.reason.as_deref(), Some("没有研究目录"));
    assert!(!v.available && v.failures.is_empty() && v.rk_version.is_none());
    std::fs::rename(f.work.join("saved"), f.work.join("research")).unwrap();
    std::fs::remove_file(f.work.join("research/tools/rk.py")).unwrap();
    let v = f.trust(5.0, 15.0).await;
    assert_eq!(v.reason.as_deref(), Some("没有 rk.py"));
    assert!(!v.available && v.failures.is_empty());
    f.write("research/tools/rk.py", "RK_VERSION = '0.5.9'\nraise Exception('must not run')");
    let v = f.trust(5.0, 15.0).await;
    assert!(!v.available && v.reason.unwrap().contains("/research:resume"));
    assert!(v.failures.is_empty() && v.check.is_none() && v.review.is_none() && v.cite.is_none() && v.plan.is_none());
    assert!(!f.work.join("research/commands").exists());
}

#[tokio::test]
async fn trust_passthrough_exit_one_redacts_every_string_and_has_no_cache() {
    let f = Fixture::new();
    let v = f.core.research_trust("test01").await.unwrap();
    assert!(v.available && v.failures.is_empty());
    assert_eq!(v.check.as_ref().unwrap()["counts"]["claims"], 3);
    assert_eq!(v.review.as_ref().unwrap()["open_fails"][0]["ref"], "review-1#1");
    assert!(v.cite.is_some() && v.plan.is_some());
    let raw = serde_json::to_string(&v).unwrap();
    assert!(!raw.contains("USER") && raw.contains("https://***@host/key") && raw.contains("ssh://***@host/value"));
    let commands = std::fs::read_to_string(f.work.join("research/commands")).unwrap();
    assert_eq!(commands, "check --json\nreview status --json\ncite check --offline --json\nplan status --json\n");
    f.write("research/check.json", "{\"counts\":{},\"unknown\": [1, true, null]}");
    assert_eq!(f.core.research_trust("test01").await.unwrap().check.unwrap(), json!({"counts":{},"unknown":[1,true,null]}));
    // 契约只把 check/cite 的 1 定义为正常；其他非零退出保守地计入该字段的失败。
    for command in ["review", "plan"] {
        f.write("research/case.json", json!({command:"exit1"}).to_string());
        let v = f.core.research_trust("test01").await.unwrap();
        assert_eq!(v.failures.len(), 1);
        assert_eq!(serde_json::to_value(&v.failures[0].command).unwrap(), command);
        assert!(v.failures[0].message.contains("退出码 1"));
    }
}

#[tokio::test]
async fn trust_each_command_timeout_invalid_and_overflow_are_isolated() {
    let f = Fixture::new();
    for command in ["check", "review", "cite", "plan"] {
        for mode in ["timeout", "invalid", "overflow", "array", "exit2"] {
            f.write("research/case.json", json!({command:mode}).to_string());
            let v = f.trust(if mode == "timeout" { 0.4 } else { 5.0 }, 20.0).await;
            assert!(v.available);
            assert_eq!(v.failures.len(), 1, "{command}/{mode}: {:?}", v.failures);
            assert_eq!(serde_json::to_value(&v.failures[0].command).unwrap(), command);
            for (name, field) in [("check", &v.check), ("review", &v.review), ("cite", &v.cite), ("plan", &v.plan)] {
                assert_eq!(field.is_none(), name == command, "{command}/{mode}: {name}");
            }
            let msg = &v.failures[0].message;
            if mode == "timeout" {
                assert!(msg.contains("超时"));
            }
            if mode == "overflow" {
                assert!(msg.contains("4 MiB"));
            }
            if mode == "invalid" {
                assert!(!msg.contains("USER") && !msg.contains("access rights") && msg.contains("https://***@host/repo"));
                assert!(msg.chars().count() <= 300);
            }
        }
    }
}

#[tokio::test]
async fn trust_total_budget_returns_completed_fields_and_marks_remainder() {
    let f = Fixture::new();
    f.write("research/case.json", r#"{"review":"timeout"}"#);
    let v = f.trust(10.0, 0.8).await;
    assert!(v.check.is_some());
    assert_eq!(v.failures.len(), 3);
    assert!(v.review.is_none() && v.cite.is_none() && v.plan.is_none());
    let commands = std::fs::read_to_string(f.work.join("research/commands")).unwrap();
    assert_eq!(commands, "check --json\nreview status --json\n");
}

#[tokio::test]
async fn trust_cancel_cleans_its_own_command_group() {
    for remote in [false, true] {
        let f = Fixture::new();
        f.write("research/case.json", r#"{"check":"cancel"}"#);
        let script = trust_script(f.work.to_str().unwrap(), "__TEST__", 60.0, 145.0);
        let task = tokio::spawn(async move {
            if remote {
                use std::process::Stdio;
                let (command, input) = crate::ssh::supervised_script(&script, Duration::from_secs(150));
                let mut cmd = tokio::process::Command::new("bash");
                cmd.args(["-c", &command]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
                crate::exec::run_command(cmd, input, Duration::from_secs(150), true, "fixture").await
            } else {
                crate::exec::run_local(&script, Duration::from_secs(150)).await
            }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !f.work.join("research/child.pid").exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        // 让孙进程安装忽略 TERM 的处理器；只在夹具内等待。
        tokio::time::sleep(Duration::from_millis(100)).await;
        task.abort();
        let _ = task.await;
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(!f.work.join("escaped").exists(), "remote={remote}: 忽略 TERM 的孙进程逃过了取消");
    }
}

#[tokio::test]
async fn run_env_outputs_limits_invalid_json_and_plan_md() {
    let f = Fixture::new();
    f.write("research/runs/r1/meta.json", r#"{"run_id":"r1","inputs":[{"path":"input.csv"}]}"#);
    f.write("research/PLAN.md", "# 计划\n具体步骤\n");
    for (name, cap) in [("env", 256 * 1024), ("outputs", 1024 * 1024)] {
        let fixture = std::fs::read(f.work.join(format!("research/{name}.json"))).unwrap();
        let path = format!("research/runs/r1/{name}.json");
        f.write(&path, &fixture);
        let v = f.core.research_run("test01", "r1", None).await.unwrap();
        let value = if name == "env" { v.env } else { v.outputs };
        assert!(value.is_some());
        // 合法对象 + 空格也计算字节；边界恰好允许，不能 trim 后再判断大小。
        for size in [cap, cap + 1] {
            f.write(&path, format!("{{}}{}", " ".repeat(size - 2)));
            let v = f.core.research_run("test01", "r1", None).await.unwrap();
            assert_eq!(if name == "env" { v.env } else { v.outputs }.is_some(), size == cap);
        }
        for bad in ["not json", "[]", "null", "{\"x\":"] {
            f.write(&path, bad);
            let v = f.core.research_run("test01", "r1", None).await.unwrap();
            assert!(if name == "env" { v.env } else { v.outputs }.is_none());
            assert_eq!(v.meta["inputs"][0]["path"], "input.csv");
        }
    }
    assert_eq!(f.core.research("test01").await.unwrap().plan_md.as_deref(), Some("# 计划\n具体步骤\n"));
}

#[tokio::test]
async fn trust_unrecognized_version_is_not_a_credential_leak() {
    let f = Fixture::new();
    f.write("research/tools/rk.py", "RK_VERSION = 'https://USER:password@host/not-a-version'\n");
    let v = f.core.research_trust("test01").await.unwrap();
    assert!(!v.available && v.failures.is_empty());
    assert_eq!(v.rk_version.as_deref(), Some("https://***@host/not-a-version"));
    assert!(!serde_json::to_string(&v).unwrap().contains("USER"));
}

#[test]
fn trust_early_error_with_all_required_keys_is_failure() {
    for (command, key) in [("check", "counts"), ("review", "files"), ("cite", "items"), ("plan", "present")] {
        let value = json!({"ok":false,"error":"one\ntwo\nhttps://user:password@host/repo",key:[]});
        let text = format!("__T__ version\nRK_VERSION = '0.6.0'\n__T__ {command}\n{}\n__T__ end\n", json!({"value":value}));
        let result = parse_trust(&text, "__T__", "").unwrap();
        assert!(result.check.is_none() && result.review.is_none() && result.cite.is_none() && result.plan.is_none());
        let failure = result.failures.iter().find(|f| serde_json::to_value(&f.command).unwrap() == command).unwrap();
        assert!(failure.message.contains("***@host") && !failure.message.contains("password") && !failure.message.contains('\n'));
    }
}

#[test]
fn trust_missing_required_key_without_early_error_is_failure() {
    for (command, key) in [("check", "counts"), ("review", "files"), ("cite", "items"), ("plan", "present")] {
        let text = format!("__T__ version\nRK_VERSION = '0.6.0'\n__T__ {command}\n{{\"value\":{{\"unexpected\":true}}}}\n__T__ end\n");
        let result = parse_trust(&text, "__T__", "").unwrap();
        let failure = result.failures.iter().find(|f| serde_json::to_value(&f.command).unwrap() == command).unwrap();
        assert!(failure.message.contains(key));
        assert!(result.check.is_none() && result.review.is_none() && result.cite.is_none() && result.plan.is_none());
    }
    let text = "__T__ version\nRK_VERSION = '0.6.0'\n__T__ check\n{\"value\":{\"ok\":false,\"counts\":{}}}\n__T__ end\n";
    assert!(parse_trust(text, "__T__", "").unwrap().check.is_some());
}

#[tokio::test]
async fn trust_real_runner_preserves_exit2_json_error() {
    let f = Fixture::new();
    // 真实 research_trust.py -> 假 rk（退出 2）-> Rust；必有键齐全，独立检验 Q7。
    f.write("research/tools/rk.py", r#"RK_VERSION = '0.6.0'
import json,sys
print(json.dumps({'ok':False,'error':'original cause\nhttps://USER:password@host/repo\nPlease make sure you have the correct access rights\nand the repository exists.', 'counts':{},'files':[],'items':[],'present':False}))
sys.exit(2)
"#);
    let v = f.trust(5.0, 20.0).await;
    assert!(v.check.is_none() && v.review.is_none() && v.cite.is_none() && v.plan.is_none());
    assert_eq!(v.failures.len(), 4);
    for failure in v.failures {
        assert!(failure.message.contains("original cause"), "{}", failure.message);
        assert!(failure.message.contains("https://***@host/repo"));
        assert!(!failure.message.contains("password") && !failure.message.contains("access rights") && !failure.message.contains('\n'));
        assert!(failure.message.chars().count() <= 300);
    }
}

#[tokio::test]
async fn trust_disallowed_exit_is_failure_for_every_ok_shape() {
    let f = Fixture::new();
    for code in [1, 2, 7, 255] {
        for ok in [None, Some(true), Some(false)] {
            let mut value = json!({
                "error":"original cause\nhttps://USER:password@host/repo\nPlease make sure you have the correct access rights\nand the repository exists.",
                "counts":{}, "files":[], "items":[], "present":false
            });
            if let Some(ok) = ok {
                value["ok"] = json!(ok);
            }
            f.write(
                "research/tools/rk.py",
                format!("RK_VERSION = '0.6.0'\nimport sys\nprint('stderr noise '*100, file=sys.stderr)\nprint({:?})\nsys.exit({code})\n", value.to_string()),
            );
            let v = f.trust(5.0, 20.0).await;
            // check/cite 的 1 仍允许；Q7 独立拒绝带 error 的 ok:false。
            let allowed_check_cite = code == 1 && ok != Some(false);
            assert_eq!(v.check.is_some(), allowed_check_cite, "code={code}, ok={ok:?}");
            assert_eq!(v.cite.is_some(), allowed_check_cite, "code={code}, ok={ok:?}");
            assert!(v.review.is_none() && v.plan.is_none());
            assert_eq!(v.failures.len(), if allowed_check_cite { 2 } else { 4 });
            for failure in v.failures {
                assert!(failure.message.contains("original cause"), "{}", failure.message);
                assert!(failure.message.contains("https://***@host/repo"));
                assert!(!failure.message.contains("password") && !failure.message.contains("access rights") && !failure.message.contains('\n'));
                assert!(failure.message.chars().count() <= 300);
            }
        }
    }
}

#[tokio::test]
async fn q14_paths_are_literal_and_controls_are_bad_request() {
    let f = Fixture::new();
    for path in [" /etc/passwd", "\u{00a0}~/.ssh/id_rsa"] {
        assert_eq!(f.core.file("test01", path).await.unwrap_err().code, crate::Code::NotFound);
        assert_eq!(f.core.raw("test01", path).await.unwrap_err().code, crate::Code::NotFound);
    }
    // 首尾空格是文件名的一部分；不要以“拒绝空白”代替“不 trim”。
    f.write(" spaced ", "literal");
    assert_eq!(f.core.file("test01", " spaced ").await.unwrap().text.as_deref(), Some("literal"));
    assert_eq!(f.core.raw("test01", " spaced ").await.unwrap(), b"literal");
    for path in ["", "a\nb", "\u{0085}~/x", "x\0y", "x\u{007f}y", "x\u{009f}y"] {
        assert_eq!(f.core.file("test01", path).await.unwrap_err().code, crate::Code::BadRequest, "{path:?}");
        assert_eq!(f.core.raw("test01", path).await.unwrap_err().code, crate::Code::BadRequest, "{path:?}");
        assert_eq!(f.core.files("test01", Some(path)).await.unwrap_err().code, crate::Code::BadRequest, "{path:?}");
        assert_eq!(f.core.git_diff("test01", Some(path)).await.unwrap_err().code, crate::Code::BadRequest, "{path:?}");
    }
}

#[tokio::test]
async fn research_repo_prefix_root_subdirectory_and_nonrepo() {
    let f = Fixture::new();
    assert!(f.core.research("test01").await.unwrap().repo_prefix.is_none());
    let output = std::process::Command::new("git").args(["init", "-q"]).current_dir(&f.work).output().unwrap();
    assert!(output.status.success());
    assert_eq!(f.core.research("test01").await.unwrap().repo_prefix.as_deref(), Some(""));
    f.write("sub/.claude/research-home", "../research\n");
    f.core
        .store
        .update_sessions(|v| {
            v[0].session.workdir = f.work.join("sub").to_string_lossy().into();
            Ok(())
        })
        .unwrap();
    let panel = f.core.research("test01").await.unwrap();
    assert_eq!(panel.repo_prefix.as_deref(), Some("sub/"));
    assert_eq!(serde_json::to_value(panel).unwrap()["repo_prefix"], "sub/");
}
