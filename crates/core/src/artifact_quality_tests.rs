use super::*;
use crate::research_quality::tests::Fixture;
use serde_json::{json, Value};
use std::process::Command;

const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
fn manifest(f: &Fixture, run: &str, time: &str, paths: &[(&str, u64, Option<&str>, bool)]) {
    let files: Vec<_> = paths
        .iter()
        .map(|(path, size, hash, unhashed)| json!({"path":path,"size":size,"sha256":hash,"partial":false,"unhashed":unhashed}))
        .collect();
    f.write(
        &format!("research/runs/{run}/outputs.json"),
        json!({"version":1,"run_id":run,"written_at":time,"files":files,"truncated":false}).to_string(),
    );
}
fn git(f: &Fixture, args: &[&str]) {
    let output = Command::new("git").args(args).current_dir(&f.work).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[tokio::test]
async fn artifact_exact_latest_size_hash_unhashed_and_subdir() {
    let f = Fixture::new();
    git(&f, &["init", "-q"]);
    for name in ["a", "size", "hash", "unknown", "unhashed", "nullhash"] {
        f.write(&format!("sub/figs/{name}.png"), "abc");
    }
    manifest(&f, "r1", "2026-11-13T10:00:00+08:00", &[("sub/figs/a.png", 3, Some(ABC), false)]);
    manifest(
        &f,
        "r2",
        "2026-11-13T03:00:00Z",
        &[
            ("sub/figs/a.png", 3, Some(ABC), false),
            ("sub/figs/size.png", 4, Some(ABC), false),
            ("sub/figs/hash.png", 3, Some("not-the-hash"), false),
            ("sub/figs/unhashed.png", 3, Some(ABC), true),
            ("sub/figs/nullhash.png", 3, None, false),
        ],
    );
    let artifacts = f.core.artifacts("test01", None).await.unwrap();
    let get = |name: &str| artifacts.items.iter().find(|a| a.path == format!("sub/figs/{name}.png")).unwrap().run.clone();
    assert_eq!(get("a"), Some(ArtifactRun { run_id: "r2".into(), verified: Some(true) }));
    assert_eq!(get("size").unwrap().verified, Some(false));
    assert_eq!(get("hash").unwrap().verified, Some(false));
    assert_eq!(get("unhashed").unwrap().verified, None);
    assert_eq!(get("nullhash").unwrap().verified, None);
    assert!(get("unknown").is_none());
    // workdir 在仓库子目录；研究目录指针仍可定位根下的研究记录。
    // 指针相对 workdir，而不是 .claude 所在目录。
    f.write("sub/.claude/research-home", "../research\n");
    f.core
        .store
        .update_sessions(|v| {
            v[0].session.workdir = f.work.join("sub").to_string_lossy().into();
            Ok(())
        })
        .unwrap();
    let artifacts = f.core.artifacts("test01", None).await.unwrap();
    let item = artifacts.items.iter().find(|a| a.path == "figs/a.png").unwrap();
    assert_eq!(item.run.as_ref().unwrap().run_id, "r2");
    assert_eq!(item.run.as_ref().unwrap().verified, Some(true));
}

#[tokio::test]
async fn artifact_without_git_uses_absolute_paths_and_bounded_manifests() {
    let f = Fixture::new();
    f.write("a.png", "abc");
    let absolute = f.work.join("a.png").to_string_lossy().into_owned();
    manifest(&f, "r1", "2026-11-13T00:00:00Z", &[(&absolute, 3, Some(ABC), false)]);
    assert_eq!(f.core.artifacts("test01", None).await.unwrap().items[0].run.as_ref().unwrap().verified, Some(true));
    for data in ["[]".to_string(), "broken".into(), format!("{{}}{}", " ".repeat(4 * 1024 * 1024))] {
        f.write("research/runs/r1/outputs.json", data);
        assert!(f.core.artifacts("test01", None).await.unwrap().items[0].run.is_none());
    }
}

#[test]
fn artifact_hash_budget_and_partial_hash_follow_contract() {
    let f = Fixture::new();
    git(&f, &["init", "-q"]);
    f.write("a.png", "abc");
    f.write("b.png", "abc");
    manifest(&f, "r1", "2026-11-13T00:00:00Z", &[("a.png", 3, Some(ABC), false), ("b.png", 3, Some(ABC), false)]);
    let run = |code: String| -> Value {
        let out = Command::new("python3").args(["-c", &code, "research", "300"]).current_dir(&f.work).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8(out.stdout).unwrap();
        serde_json::from_str(text.split_once("__OP_RUN__\n").unwrap().1).unwrap()
    };
    // 走生产脚本，只缩小预算，验证累计读取且不降级成另一种抽样哈希。
    let values = run(artifact_py().replace("budget = 536870912", "budget = 3"));
    let verified: Vec<_> = ["a.png", "b.png"].iter().map(|p| &values[p]["verified"]).collect();
    assert_eq!(verified.iter().filter(|v| ***v == true).count(), 1);
    assert_eq!(verified.iter().filter(|v| v.is_null()).count(), 1);
    // 稀疏文件 >256 MiB，按大小 + 首尾 1 MiB 计算，不读中间区域。
    let code = r#"import pathlib,hashlib,json
p=pathlib.Path('big.png')
with p.open('wb') as f:f.truncate(256*1024*1024+1)
s=p.stat().st_size
h=hashlib.sha256((str(s)+'\n').encode()+b'\0'*(2*1024*1024)).hexdigest()
p=pathlib.Path('research/runs/r1/outputs.json');v=json.loads(p.read_text());v['files'].append({'path':'big.png','size':s,'sha256':h,'partial':True,'unhashed':False});p.write_text(json.dumps(v))
"#;
    assert!(Command::new("python3").args(["-c", code]).current_dir(&f.work).status().unwrap().success());
    assert_eq!(run(artifact_py())["big.png"]["verified"], true);
    assert!(run(artifact_py().replace("budget = 536870912", "budget = 1"))["big.png"]["verified"].is_null());
}

#[test]
fn artifact_manifest_count_is_bounded_and_json_objects_are_strict() {
    let f = Fixture::new();
    git(&f, &["init", "-q"]);
    f.write("a.png", "abc");
    for i in 0..2002 {
        manifest(&f, &format!("r{i:04}"), "2026-11-13T00:00:00Z", &[("a.png", 3, Some(ABC), false)]);
    }
    // 确认只有 2000 份：包装 open 计数，同时执行未修改的生产算法。
    let code = format!("import builtins\nreal_open=builtins.open\nopened=[]\ndef tracked(p,*a,**k):\n if str(p).endswith('/outputs.json'):opened.append(p)\n return real_open(p,*a,**k)\nbuiltins.open=tracked\n{}\nassert len(opened)==2000,len(opened)\n", artifact_py());
    let out = Command::new("python3").args(["-c", &code, "research", "300"]).current_dir(&f.work).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let marker = "__M__";
    let raw = b"__M__ env\n{\"x\":\"\xff\"}\n__M__ end\n";
    assert!(bounded_remote_object(raw, marker, "env", 100).is_none());
    let raw = b"__M__ env\n{}\r\n__M__ end\n";
    assert!(bounded_remote_object(raw, marker, "env", 2).is_none(), "不能规范化 CR 来绕过字节上限");
}

// 每种坏类型是独立 test，不能被后写入的同名运行覆盖。
async fn bad_manifest_case(key: &str, value: Value, entry: bool) {
    let f = Fixture::new();
    git(&f, &["init", "-q"]);
    f.write("a.png", "abc");
    manifest(&f, "good", "2026-11-13T00:00:00Z", &[("a.png", 3, Some(ABC), false)]);
    let mut file = json!({"path":"a.png","size":3,"sha256":ABC,"partial":false,"unhashed":false});
    if entry { file[key] = value.clone(); }
    let mut record = json!({"version":1,"truncated":false,"run_id":"bad","written_at":"2099-01-01T00:00:00Z","files":[file]});
    if !entry { record[key] = value; }
    f.write("research/runs/bad/outputs.json", record.to_string());
    let artifacts = f.core.artifacts("test01", None).await.unwrap();
    assert_eq!(artifacts.items.iter().find(|a| a.path == "a.png").unwrap().run.as_ref().unwrap().run_id, "good");
}
macro_rules! bad_manifest_test {
    ($name:ident, $key:literal, $value:expr, $entry:literal) => {
        #[tokio::test]
        async fn $name() { bad_manifest_case($key, $value, $entry).await; }
    };
}
bad_manifest_test!(artifact_bad_time_null, "written_at", Value::Null, false);
bad_manifest_test!(artifact_bad_time_number, "written_at", json!(42), false);
bad_manifest_test!(artifact_bad_time_bool, "written_at", json!(true), false);
bad_manifest_test!(artifact_bad_time_array, "written_at", json!([]), false);
bad_manifest_test!(artifact_bad_time_object, "written_at", json!({}), false);
bad_manifest_test!(artifact_bad_time_invalid, "written_at", json!("not-a-date"), false);
bad_manifest_test!(artifact_bad_files_null, "files", Value::Null, false);
bad_manifest_test!(artifact_bad_files_object, "files", json!({}), false);
bad_manifest_test!(artifact_bad_files_string, "files", json!("bad"), false);
bad_manifest_test!(artifact_bad_files_entries, "files", json!([null,1,"bad",{"path":42}]), false);
bad_manifest_test!(artifact_bad_size_string, "size", json!("3"), true);
bad_manifest_test!(artifact_bad_size_bool, "size", json!(true), true);
bad_manifest_test!(artifact_bad_hash_bool, "sha256", json!(true), true);
bad_manifest_test!(artifact_bad_partial_string, "partial", json!("false"), true);
bad_manifest_test!(artifact_bad_unhashed_number, "unhashed", json!(0), true);
bad_manifest_test!(artifact_bad_version_bool, "version", json!(true), false);
bad_manifest_test!(artifact_bad_version_string, "version", json!("1"), false);
bad_manifest_test!(artifact_bad_truncated_null, "truncated", Value::Null, false);
bad_manifest_test!(artifact_bad_truncated_number, "truncated", json!(0), false);

#[tokio::test]
async fn artifact_bad_entries_preserve_valid_entry_in_same_manifest() {
    let f = Fixture::new();
    git(&f, &["init", "-q"]);
    f.write("a.png", "abc");
    f.write("research/runs/later/outputs.json", json!({"version":1,"truncated":false,"run_id":"later",
        "written_at":"2026-11-14T00:00:00Z","files":[null,{"path":[]},{"path":"a.png","size":3,"sha256":ABC,"partial":false,"unhashed":false}]}).to_string());
    let artifacts = f.core.artifacts("test01", None).await.unwrap();
    assert_eq!(artifacts.items.iter().find(|a| a.path == "a.png").unwrap().run.as_ref().unwrap().run_id, "later");
}

#[cfg(unix)]
#[tokio::test]
async fn artifact_q15_outside_links_never_borrow_verified_source() {
    let f = Fixture::new();
    git(&f, &["init", "-q"]);
    let outside = f.root.join("outside.png");
    std::fs::write(&outside, "abc").unwrap();
    std::os::unix::fs::symlink(&outside, f.work.join("escape.png")).unwrap();
    std::os::unix::fs::symlink("escape.png", f.work.join("chain.png")).unwrap();
    f.write("safe.png", "abc");
    let external = outside.to_string_lossy().into_owned();
    manifest(
        &f,
        "r1",
        "2026-11-13T00:00:00Z",
        &[
            ("escape.png", 3, Some(ABC), false),
            (&external, 3, Some(ABC), false),
            ("safe.png", 3, Some(ABC), false),
        ],
    );
    let artifacts = f.core.artifacts("test01", None).await.unwrap();
    for path in ["escape.png", "chain.png"] {
        let item = artifacts.items.iter().find(|a| a.path == path).unwrap();
        assert!(item.run.is_none(), "越界文件不得借用来源：{path}");
    }
    let safe = artifacts
        .items
        .iter()
        .find(|a| a.path == "safe.png")
        .unwrap();
    assert_eq!(safe.run.as_ref().unwrap().verified, Some(true));
}
