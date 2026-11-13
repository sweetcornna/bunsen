//! 第 3 轮：真实入口与纯假 Docker 回归；不启动服务或操作任何真实容器。
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

#[tokio::test]
async fn clap_real_entry_redacts_parse_errors_and_keeps_exit_2() {
    for cred in ["USER:pa'ss", "USER:pa%40ss", "USER:!$&()*+,;="] {
        let out = tokio::time::timeout(
            Duration::from_secs(10),
            Command::new(env!("CARGO_BIN_EXE_bunsen"))
                .args(["--json", "serve", "--port", &format!("https://{cred}@host/repo")])
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(out.status.code(), Some(2));
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(!text.contains(cred), "{text}");
        assert!(text.contains("https://***@host/repo"), "{text}");
    }
}

#[tokio::test]
async fn test_server_ports_with_fake_docker_only() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dev/test-server/run.sh");
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new("python3").args(["-B", "-c", FAKE_DOCKER_TEST]).arg(script).stdin(Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
}

const FAKE_DOCKER_TEST: &str = r#"
import json,os,pathlib,shutil,subprocess,sys,tempfile
with tempfile.TemporaryDirectory(prefix='bunsen-r3-fake-docker-') as scratch:
 d=pathlib.Path(scratch);here=d/'server';here.mkdir();script=here/'run.sh';shutil.copy2(sys.argv[1],script)
 subprocess.run(['bash','-n',str(script)],check=True,timeout=5)
 bin=d/'bin';bin.mkdir();state=d/'state';log=d/'calls';state.write_text('own');log.write_text('')
 docker='''import os,pathlib,sys
state=pathlib.Path(os.environ['R3_STATE']);log=pathlib.Path(os.environ['R3_LOG']);a=sys.argv[1:]
with log.open('a') as f:f.write(' '.join(a)+'\\n')
s=state.read_text()
if a[0]=='ps':print('bunsen-test-ssh' if s=='own' else ('someone-else' if s=='foreign' else ''))
elif a[0]=='port':print('127.0.0.1:2223')
elif a[0]=='rm':state.write_text('empty')
elif a[0]=='run':state.write_text('own');print('fake-container')
elif a[0]=='build':print('fake-image')
else:raise SystemExit('unexpected docker call '+repr(a))
'''
 nc="import os,pathlib,sys;sys.exit(0 if pathlib.Path(os.environ['R3_STATE']).read_text() in ('own','foreign','tcp') else 1)\n"
 for name,body in [('docker',docker),('nc',nc),('ssh','import sys;sys.exit(0)\n'),('ssh-keygen',"raise SystemExit('unexpected keygen')\n")]:
  f=bin/name;f.write_text('#!'+sys.executable+'\n'+body);f.chmod(0o755)
 env=dict(os.environ,PATH=str(bin)+os.pathsep+os.environ['PATH'],R3_STATE=str(state),R3_LOG=str(log))
 def run(port):return subprocess.run(['bash',str(script),'up'],env=dict(env,BUNSEN_TEST_PORT=port),capture_output=True,timeout=8)
 # Invalid input must be rejected before keys, copy, build, rm, or docker inspection.
 for port in ['', 'not-a-port','0','65536','-1','12.3','1 2','999999999999999999999']:
  state.write_text('own');log.write_text('');r=run(port);assert r.returncode==2,(port,r.stderr);assert state.read_text()=='own';assert not log.read_text();assert not (here/'authorized_keys').exists();assert not (here/'.tmp').exists()
 tmp=here/'.tmp';tmp.mkdir();(tmp/'id_test').write_text('FAKE KEY');(tmp/'id_test.pub').write_text('FAKE PUBLIC KEY')
 state.write_text('empty');log.write_text('')
 for i in range(2):
  r=run('02223');assert r.returncode==0,(i,r.stdout,r.stderr);assert state.read_text()=='own';assert (tmp/'port').read_text()=='2223\n'
 calls=log.read_text().splitlines();assert sum(c.startswith('build ') for c in calls)==2,calls;assert sum(c.startswith('rm -f ') for c in calls)==2,calls;assert sum(c.startswith('run ') for c in calls)==2,calls
 for occupied in ['foreign','tcp']:
  state.write_text(occupied);log.write_text('');before={f.name:f.read_bytes() for f in tmp.iterdir()};r=run('2223');assert r.returncode==1,(occupied,r.stdout,r.stderr);assert state.read_text()==occupied;assert not any(x.startswith(('build ','rm ','run ')) for x in log.read_text().splitlines());assert before=={f.name:f.read_bytes() for f in tmp.iterdir()};assert not (here/'authorized_keys').exists()
 print('invalid ports: 8; same-port rebuilds: 2; foreign Docker/TCP: 2; real Docker calls: 0')
"#;

#[tokio::test]
async fn integration_sync_plugin_removes_excluded_tests_and_bytecode() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dev/sync-plugin.sh");
    let code = r#"
import pathlib,shutil,subprocess,sys,tempfile
with tempfile.TemporaryDirectory(prefix='bunsen-i1-sync-') as d:
 d=pathlib.Path(d);b=d/'bunsen';p=d/'source';(b/'dev').mkdir(parents=True);(p/'.claude-plugin').mkdir(parents=True);(p/'.claude-plugin/plugin.json').write_text('{}');(p/'runtime.md').write_text('KEEP')
 for rel in ['tests/run.sh','__pycache__/rk.pyc','nested/__pycache__/other.pyc','nested/loose.pyc']:
  f=p/rel;f.parent.mkdir(parents=True,exist_ok=True);f.write_text('excluded source')
  f=b/'plugins/research'/rel;f.parent.mkdir(parents=True,exist_ok=True);f.write_text('stale embedded')
 script=b/'dev/sync-plugin.sh';shutil.copy2(sys.argv[1],script)
 r=subprocess.run(['bash',str(script),str(p)],capture_output=True,timeout=5);assert r.returncode==0,(r.stdout,r.stderr)
 target=b/'plugins/research';assert (target/'runtime.md').read_text()=='KEEP'
 assert not any(f.name=='tests' or f.name=='__pycache__' or f.suffix=='.pyc' for f in target.rglob('*')),list(target.rglob('*'))
"#;
    let out = tokio::time::timeout(
        Duration::from_secs(10),
        Command::new("python3").args(["-B", "-c", code]).arg(source).stdin(Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
}

#[path = "support/r5.rs"]
mod r5_support;

#[tokio::test]
async fn r5_real_cli_and_mcp_resolve_alias_but_never_reserved_local() {
    use serde_json::{json, Value};
    use tokio::io::AsyncWriteExt;
    tokio::time::timeout(Duration::from_secs(120), async {
        for hidden in [false, true] {
            let f = r5_support::Fixture::new(hidden);
            let execute = |args: Vec<String>| {
                let mut cmd = Command::new(env!("CARGO_BIN_EXE_bunsen"));
                cmd.args(args).envs(f.env()).stdin(Stdio::null()).kill_on_drop(true);
                cmd
            };
            let out =
                tokio::time::timeout(Duration::from_secs(10), execute(vec!["--json".into(), "notes".into(), "worker".into()]).output())
                    .await
                    .unwrap()
                    .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            assert!(String::from_utf8_lossy(&out.stdout).contains("fixture notes"));
            let deploy = |server: &str| {
                vec![
                    "--json".into(),
                    "deploy".into(),
                    "--server".into(),
                    server.into(),
                    "--agent".into(),
                    "r5agent".into(),
                    "--workdir".into(),
                    f.root.join("cli-work").to_string_lossy().into_owned(),
                    "--no-plugins".into(),
                ]
            };
            let out = tokio::time::timeout(Duration::from_secs(30), execute(deploy("worker")).output()).await.unwrap().unwrap();
            assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            let value: Value = serde_json::from_slice(&out.stdout).unwrap();
            assert_eq!(value["session"]["server_id"], "remote1");
            for args in [vec!["--json".into(), "notes".into(), "local".into()], deploy("local")] {
                let out = tokio::time::timeout(Duration::from_secs(10), execute(args).output()).await.unwrap().unwrap();
                assert!(!out.status.success());
                let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
                assert!(text.contains("not_found"), "{text}");
            }
            let mut child = Command::new(env!("CARGO_BIN_EXE_bunsen"))
                .arg("mcp")
                .envs(f.env())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let calls = [
                ("host_notes_get", json!({"server_id":"worker"})),
                ("host_notes_get", json!({"server_id":"local"})),
                ("session_deploy", json!({"server_id":"worker","agent_id":"r5agent","workdir":f.root.join("mcp-work"),"plugins":[]})),
                ("session_deploy", json!({"server_id":"local","agent_id":"r5agent","workdir":f.root.join("never"),"plugins":[]})),
            ];
            let input = calls
                .iter()
                .enumerate()
                .map(|(i, (name, args))| {
                    json!({"jsonrpc":"2.0","id":i,"method":"tools/call","params":{"name":name,"arguments":args}}).to_string() + "\n"
                })
                .collect::<String>();
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(input.as_bytes()).await.unwrap();
            stdin.shutdown().await.unwrap();
            drop(stdin);
            let out = tokio::time::timeout(Duration::from_secs(40), child.wait_with_output()).await.unwrap().unwrap();
            assert!(out.status.success());
            let replies =
                String::from_utf8(out.stdout).unwrap().lines().map(|line| serde_json::from_str::<Value>(line).unwrap()).collect::<Vec<_>>();
            assert_eq!(replies.len(), 4);
            for value in &replies {
                let id = value["id"].as_u64().unwrap();
                let result = &value["result"];
                let body: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
                if id == 0 {
                    assert_eq!(result["isError"], false);
                    assert!(body["text"].as_str().unwrap().contains("fixture notes"));
                } else if id == 2 {
                    assert_eq!(result["isError"], false, "{value}");
                    assert_eq!(body["session"]["server_id"], "remote1");
                } else {
                    assert_eq!(result["isError"], true);
                    assert_eq!(body["error"]["code"], "not_found");
                }
            }
        }
    })
    .await
    .expect("CLI/MCP alias matrix exceeded 60s");
}
