//! 标准输入输出上的 MCP 服务（JSON-RPC 2.0，一行一条消息）。工具的参数与返回值同对应的 HTTP 接口。

use bunsen_core::model::DeployRequest;
use bunsen_core::{Core, Error};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const DEFAULT_PROTOCOL: &str = "2025-06-18";

fn tool(name: &str, desc: &str, props: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": desc,
        "inputSchema": { "type": "object", "properties": props, "required": required, "additionalProperties": false },
    })
}

pub fn tools() -> Value {
    let sid = json!({ "type": "string", "description": "服务器 id 或别名" });
    let sess = json!({ "type": "string", "description": "会话 id（6 位）" });
    json!([
        tool("server_list", "列出已保存的服务器（GET /api/servers）", json!({}), &[]),
        tool("server_test", "测试连接并更新服务器状态（POST /api/servers/:id/test）",
             json!({ "server_id": sid, "try_all_keys": { "type": "boolean", "description": "逐把尝试已保存的私钥" } }), &["server_id"]),
        tool("server_probe", "探测服务器：系统、tmux、各代理是否安装、GPU（POST /api/servers/:id/probe）",
             json!({ "server_id": sid }), &["server_id"]),
        tool("agent_list", "列出可部署的命令行代理（GET /api/agents）", json!({}), &[]),
        tool("session_list", "列出云端对话（GET /api/sessions）",
             json!({ "refresh": { "type": "boolean", "description": "逐台连服务器刷新状态并发现会话" } }), &[]),
        tool("session_deploy", "在服务器的 tmux 里部署一个代理会话（POST /api/sessions），返回 {session, steps}",
             json!({
                "server_id": sid,
                "agent_id": { "type": "string" },
                "workdir": { "type": "string", "description": "远程工作目录，支持 ~，不存在则创建" },
                "title": { "type": "string" },
                "prompt": { "type": "string", "description": "初始提示" },
                "yolo": { "type": "boolean", "description": "跳过权限确认" },
                "plugins": { "type": "array", "items": { "type": "string" }, "description": "要下发的插件；省略 = 全部可用插件，[] = 不带" },
                "plugin": { "type": ["string", "null"], "description": "旧字段，等价 plugins:[plugin]" },
                "extra_args": { "type": "string" },
                "project_id": { "type": "string", "description": "接入的研究项目 id" }
             }), &["server_id", "agent_id", "workdir"]),
        tool("session_send", "把文字粘贴进代理窗格，可选回车（POST /api/sessions/:id/send）",
             json!({ "session_id": sess, "text": { "type": "string" }, "enter": { "type": "boolean", "default": true } }), &["session_id", "text"]),
        tool("session_capture", "读取代理窗格最近若干行纯文本（GET /api/sessions/:id/capture）",
             json!({ "session_id": sess, "lines": { "type": "integer", "minimum": 1, "default": 200 } }), &["session_id"]),
        tool("session_stop", "结束服务器上的 tmux 会话，记录保留（POST /api/sessions/:id/stop）",
             json!({ "session_id": sess }), &["session_id"]),
        tool("session_artifacts", "列出会话工作目录里的产物：图、PDF、表格、notebook、html、报告（GET /api/sessions/:id/artifacts）",
             json!({ "session_id": sess, "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 300 } }), &["session_id"]),
        tool("research_show", "科研面板（GET /api/sessions/:id/research）；给 run_id 时返回该次运行详情（GET /api/sessions/:id/research/run）",
             json!({ "session_id": sess, "run_id": { "type": "string" }, "lines": { "type": "integer", "minimum": 1, "maximum": 2000 } }), &["session_id"]),
        tool("host_notes_get", "读服务器上的主机笔记 ~/.bunsen/HOST.md（GET /api/servers/:id/notes）",
             json!({ "server_id": sid }), &["server_id"]),
        tool("host_notes_set", "整体覆盖服务器上的主机笔记 ~/.bunsen/HOST.md（PUT /api/servers/:id/notes）。只记验证过的事实",
             json!({ "server_id": sid, "text": { "type": "string" } }), &["server_id", "text"]),
        tool("list_projects", "列出研究项目（GET /api/projects）", json!({}), &[]),
        tool("project_view", "查看研究项目的汇合视图（GET /api/projects/:id/view）",
             json!({ "project": { "type": "string", "description": "项目 id 或名称" }, "refresh": { "type": "boolean" } }), &["project"]),
        tool("project_sync", "同步所有成员会话并刷新汇合视图（POST /api/projects/:id/sync）",
             json!({ "project": { "type": "string", "description": "项目 id 或名称" } }), &["project"]),
        tool("plugin_list", "列出部署时可下发的插件（GET /api/plugins）", json!({}), &[]),
    ])
}

fn arg_str(a: &Value, k: &str) -> Result<String, Error> {
    a.get(k)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::bad_request(format!("缺少参数 {k}")))
}

/// 执行一个工具；Ok 是返回值，Err 是 (错误, 附加数据)。
pub async fn call_tool(core: &Arc<Core>, name: &str, a: &Value) -> Result<Value, (Error, Value)> {
    if name == "session_deploy" {
        let req: DeployRequest =
            serde_json::from_value(a.clone()).map_err(|e| (Error::bad_request(format!("参数不对：{e}")), Value::Null))?;
        // 失败时把 steps 一起带回去（同 HTTP 接口的 422 {error, steps}）。
        return match core.deploy(req, None).await {
            Ok(out) => Ok(json!({ "session": out.session, "steps": out.steps })),
            Err(f) => Err((f.error, json!({ "steps": f.steps }))),
        };
    }
    simple_tool(core, name, a).await.map_err(|e| (e, Value::Null))
}

async fn simple_tool(core: &Arc<Core>, name: &str, a: &Value) -> Result<Value, Error> {
    Ok(match name {
        "server_list" => json!(core.servers()?),
        "server_test" => {
            let id = arg_str(a, "server_id")?;
            json!(core.test_server(&id, a.get("try_all_keys").and_then(Value::as_bool).unwrap_or(false)).await?)
        }
        "server_probe" => json!(core.probe_server(&arg_str(a, "server_id")?).await?),
        "agent_list" => json!(core.agents()?),
        "session_list" => json!(core.sessions(a.get("refresh").and_then(Value::as_bool).unwrap_or(false)).await?),
        "session_send" => {
            let id = arg_str(a, "session_id")?;
            let text = arg_str(a, "text")?;
            core.send(&id, &text, a.get("enter").and_then(Value::as_bool).unwrap_or(true)).await?;
            json!({ "ok": true })
        }
        "session_capture" => {
            let id = arg_str(a, "session_id")?;
            let lines = a.get("lines").and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32);
            json!({ "text": core.capture(&id, lines).await? })
        }
        "session_stop" => json!(core.stop(&arg_str(a, "session_id")?).await?),
        "session_artifacts" => {
            let lim = a.get("limit").and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32);
            json!(core.artifacts(&arg_str(a, "session_id")?, lim).await?)
        }
        "research_show" => {
            let id = arg_str(a, "session_id")?;
            match a.get("run_id").and_then(Value::as_str) {
                Some(r) => {
                    let lines = a.get("lines").and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32);
                    json!(core.research_run(&id, r, lines).await?)
                }
                None => json!(core.research(&id).await?),
            }
        }
        "host_notes_get" => json!(core.host_notes(&arg_str(a, "server_id")?).await?),
        "host_notes_set" => json!(core.set_host_notes(&arg_str(a, "server_id")?, &arg_str(a, "text")?).await?),
        "list_projects" => json!(core.projects()?),
        "project_view" => json!(core.project_view(&arg_str(a, "project")?, a.get("refresh").and_then(Value::as_bool).unwrap_or(false)).await?),
        "project_sync" => json!(core.sync_project(&arg_str(a, "project")?).await?),
        "plugin_list" => json!(core.plugins()?),
        other => return Err(Error::not_found(format!("没有这个工具：{other}"))),
    })
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, msg: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } })
}

async fn handle(core: Arc<Core>, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let id = id?; // 没有 id 的是通知，不回复
    Some(match method {
        "initialize" => {
            let proto = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(DEFAULT_PROTOCOL);
            rpc_result(
                &id,
                json!({
                    "protocolVersion": proto,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "bunsen", "version": bunsen_core::VERSION },
                    "instructions": "Bunsen：在自己的 Linux 服务器上用 tmux 部署并操作命令行编码代理。先 server_list / server_probe，再 session_deploy，之后用 session_send 与 session_capture 交互。",
                }),
            )
        }
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => rpc_result(&id, json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("").to_string();
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let r = call_tool(&core, &name, &args).await;
            let (text, is_err) = match r {
                Ok(v) => (serde_json::to_string_pretty(&v).unwrap_or_default(), false),
                Err((e, extra)) => {
                    let mut v = json!({ "error": e });
                    if let (Some(m), Value::Object(x)) = (v.as_object_mut(), extra) {
                        m.extend(x);
                    }
                    (serde_json::to_string_pretty(&v).unwrap_or_default(), true)
                }
            };
            rpc_result(&id, json!({ "content": [{ "type": "text", "text": text }], "isError": is_err }))
        }
        "resources/list" => rpc_result(&id, json!({ "resources": [] })),
        "prompts/list" => rpc_result(&id, json!({ "prompts": [] })),
        _ => rpc_error(&id, -32601, &format!("不支持的方法：{method}")),
    })
}

pub async fn run(core: Arc<Core>) -> std::io::Result<()> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(v) = rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if out.write_all(line.as_bytes()).await.is_err() || out.flush().await.is_err() {
                break;
            }
        }
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = tx.send(rpc_error(&Value::Null, -32700, &format!("JSON 解析失败：{e}")));
                continue;
            }
        };
        let core = core.clone();
        let tx = tx.clone();
        // 每个请求单独一个任务（部署可能要几秒，不阻塞其他请求）。
        tasks.spawn(async move {
            if let Some(resp) = handle(core, msg).await {
                let _ = tx.send(resp);
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    drop(tx);
    let _ = writer.await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_list_names() {
        let t = tools();
        let names: Vec<&str> = t.as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "server_list",
                "server_test",
                "server_probe",
                "agent_list",
                "session_list",
                "session_deploy",
                "session_send",
                "session_capture",
                "session_stop",
                "session_artifacts",
                "research_show",
                "host_notes_get",
                "host_notes_set",
                "list_projects",
                "project_view",
                "project_sync",
                "plugin_list"
            ]
        );
    }
    #[tokio::test]
    async fn project_tools_schema_and_dispatch() {
        let t = tools();
        let deploy = t.as_array().unwrap().iter().find(|t| t["name"] == "session_deploy").unwrap();
        assert_eq!(deploy["inputSchema"]["properties"]["project_id"]["type"], "string");
        assert!(!deploy["inputSchema"]["required"].as_array().unwrap().contains(&json!("project_id")));
        let root = std::env::temp_dir().join(format!("bunsen-mcp-project-{}", bunsen_core::util::short_id()));
        let core = Core::open_at(bunsen_core::store::Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        assert_eq!(call_tool(&core, "list_projects", &json!({})).await.unwrap(), json!([]));
        assert_eq!(call_tool(&core, "project_view", &json!({})).await.unwrap_err().0.code, bunsen_core::Code::BadRequest);
        assert_eq!(call_tool(&core, "project_sync", &json!({"project":"missing"})).await.unwrap_err().0.code, bunsen_core::Code::NotFound);
        let hub = root.join("hub.git");
        let status = tokio::time::timeout(std::time::Duration::from_secs(120), tokio::process::Command::new("git").args(["init", "--bare", "-q", "--"]).arg(&hub)
            .env("GIT_TERMINAL_PROMPT", "0").stdin(std::process::Stdio::null()).kill_on_drop(true).status()).await.unwrap().unwrap(); assert!(status.success());
        let p = core.add_project(bunsen_core::model::NewProject { name: "示例".into(), hub: hub.to_string_lossy().into_owned(), ..Default::default() }).await.unwrap();
        assert_eq!(call_tool(&core, "list_projects", &json!({})).await.unwrap()[0]["id"], p.id);
        let view = call_tool(&core, "project_view", &json!({"project":"示例", "refresh":true})).await.unwrap(); assert_eq!(view["project"]["id"], p.id);
        let sync = call_tool(&core, "project_sync", &json!({"project":p.id})).await.unwrap(); assert_eq!(sync["members"], json!([]));
        crate::project_cli_tests::sync_members(&core, &p.id);
        let sync = call_tool(&core, "project_sync", &json!({"project":p.id})).await.unwrap();
        assert_eq!(sync["members"][0]["title"], "训练甲");
        assert_eq!(sync["members"][0]["ok"], true);
        assert_eq!(sync["members"][1]["title"], "训练乙");
        assert_eq!(sync["members"][1]["ok"], false);
        let failure = call_tool(&core, "session_deploy", &json!({"server_id":"local", "agent_id":"codex", "workdir":root.join("must-not-create"), "project_id":"missing"})).await.unwrap_err();
        assert_eq!(failure.0.code, bunsen_core::Code::NotFound);
        assert_eq!(failure.1["steps"], json!([]));
        assert!(!root.join("must-not-create").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

}
