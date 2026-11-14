//! 固定 rk 0.6 契约夹具；启动真正的 CLI/MCP 进程，不部署会话，不访问远端。
#[path = "support/quality.rs"]
mod support;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};

fn command(f: &support::Fixture) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bunsen"));
    cmd.env("BUNSEN_DATA_DIR", f.core.paths().data.clone())
        .env("BUNSEN_CM_DIR", f.root.join("cm"))
        .env_remove("BUNSEN_NO_LOCAL")
        .env_remove("BUNSEN_REMOTE_NO_PYTHON")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

#[tokio::test]
async fn quality_real_cli_trust_json_text_conflicts_and_no_python() {
    let f = support::Fixture::new();
    let out = tokio::time::timeout(Duration::from_secs(20), command(&f).args(["research", "test01", "--trust", "--json"]).output())
        .await
        .unwrap()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["available"], true);
    assert_eq!(v["check"]["counts"]["claims"], 3);
    assert_eq!(v["failures"], json!([]));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("USER"));
    let out =
        tokio::time::timeout(Duration::from_secs(20), command(&f).args(["research", "test01", "--trust"]).output()).await.unwrap().unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    for expected in ["结论数 3", "可信 1", "需留意 1", "有问题 1", "未关闭的 fail：1", "错误：1", "警告：1"] {
        assert!(text.contains(expected), "{text}");
    }
    for extra in [vec!["--run", "r1"], vec!["--lines", "5"]] {
        let out = command(&f).args(["research", "test01", "--trust"]).args(extra).output().await.unwrap();
        assert_eq!(out.status.code(), Some(2));
    }
    for args in [vec!["research", "test01", "--trust", "--json"], vec!["artifacts", "test01", "--json"]] {
        let out = command(&f).env("BUNSEN_REMOTE_NO_PYTHON", "1").args(&args).output().await.unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        if args[0] == "research" {
            assert_eq!(v["available"], true);
            assert_eq!(v["failures"].as_array().unwrap().len(), 4);
            for name in ["check", "review", "cite", "plan"] {
                assert!(v[name].is_null());
            }
        } else {
            assert!(!v["items"].as_array().unwrap().is_empty());
            assert!(v["items"].as_array().unwrap().iter().all(|a| a["run"].is_null()));
        }
    }
    let out = command(&f).args(["research", "test01", "--run", "r1", "--json"]).output().await.unwrap();
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(v["env"].is_object() && v["outputs"].is_object());
    let out = command(&f).args(["research", "test01", "--json"]).output().await.unwrap();
    assert!(out.status.success());
    let panel: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(panel.get("repo_prefix"), Some(&Value::Null));
}

#[tokio::test]
async fn quality_real_mcp_tool_schema_and_trust_call() {
    let f = support::Fixture::new();
    let mut child = command(&f).arg("mcp").stdin(Stdio::piped()).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    for msg in [
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"research_trust","arguments":{"session":"test01"}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"research_show","arguments":{"session_id":"test01"}}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"research_trust","arguments":{"session_id":"test01"}}}),
    ] {
        input.write_all(format!("{msg}\n").as_bytes()).await.unwrap();
    }
    drop(input);
    let out = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output()).await.unwrap().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let replies: Vec<Value> = String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let reply = |id: u64| replies.iter().find(|v| v["id"] == id).unwrap();
    let tool = reply(1)["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "research_trust").unwrap();
    assert_eq!(tool["inputSchema"]["required"], json!(["session"]));
    assert_eq!(reply(2)["result"]["isError"], false);
    let text = reply(2)["result"]["content"][0]["text"].as_str().unwrap();
    let v: Value = serde_json::from_str(text).unwrap();
    assert_eq!(v["check"]["claims"][0]["trust"], "ok");
    assert!(v["plan"]["phases"].is_array() && !text.contains("USER"));
    assert_eq!(reply(3)["result"]["isError"], true);
    assert_eq!(reply(4)["result"]["isError"], false);
    let panel: Value = serde_json::from_str(reply(4)["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(panel.get("repo_prefix"), Some(&Value::Null));
}
