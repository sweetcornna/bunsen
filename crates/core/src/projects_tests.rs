use super::*;
use crate::store::Paths;
use serde_json::json;

struct Fixture {
    root: PathBuf,
    core: Arc<Core>,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("bunsen-project-test-{}", short_id()));
        let core = Core::open_at(Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        Self { root, core }
    }
    fn dir(&self, name: &str) -> PathBuf {
        let p = self.root.join(name);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
    async fn hub(&self) -> PathBuf {
        let hub = self.dir("hub.git");
        g(&hub, &["init", "--bare", "-q"]).await;
        hub
    }
    async fn seed(&self, hub: &Path) -> PathBuf {
        let repo = self.dir("seed");
        g(&repo, &["init", "-q", "-b", "research/demo"]).await;
        write(&repo, "README", "开始\n");
        commit(&repo, "初始记录", false).await;
        g(&repo, &["remote", "add", "origin", hub.to_str().unwrap()]).await;
        g(&repo, &["push", "-q", "origin", "HEAD"]).await;
        g(hub, &["symbolic-ref", "HEAD", "refs/heads/research/demo"]).await;
        repo
    }
    async fn clone_repo(&self, hub: &Path, name: &str) -> PathBuf {
        let dir = self.dir(name);
        g(&dir, &["clone", "-q", "--", hub.to_str().unwrap(), "."]).await;
        dir
    }
    async fn project(&self, hub: &Path) -> Project {
        self.core
            .add_project(NewProject { name: "项目".into(), hub: hub.to_string_lossy().into_owned(), ..Default::default() })
            .await
            .unwrap()
    }
    fn member(&self, project: &Project, id: &str, workdir: &Path, machine: Option<&str>, archived: bool, server: &str) {
        let session: Session = serde_json::from_value(json!({
            "id": id, "title": id, "server_id": server, "server_alias": "旧别名", "agent_id": "codex", "workdir": workdir,
            "tmux": format!("op-{id}"), "created_at": now_rfc3339(), "last_active_at": null, "state": "stopped", "exit_status": null,
            "attached": 0, "pinned": false, "archived": archived, "plugin": null, "plugins": [], "yolo": false,
            "preview": null, "attach_cmd": "", "origin": "local", "project_id": project.id, "machine": machine
        }))
        .unwrap();
        self.core
            .store
            .update_sessions(|v| {
                v.push(SessionRecord { session, extra_args: None });
                Ok(())
            })
            .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
async fn g(dir: &Path, args: &[&str]) -> String {
    git_ok(dir, args, None).await.unwrap()
}
fn write(dir: &Path, name: &str, text: &str) {
    let path = dir.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}
async fn commit(dir: &Path, msg: &str, old: bool) {
    g(dir, &["add", "-A"]).await;
    // 只影响临时仓库；不依赖用户的提交身份、签名和 hooks。
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .args([
            "-c",
            "user.name=测试",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-q",
            "-m",
            msg,
        ])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if old {
        cmd.env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z").env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z");
    }
    let out = tokio::time::timeout(GIT_TIMEOUT, cmd.output()).await.unwrap().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}
fn project() -> Project {
    Project {
        id: "abc123".into(),
        name: "示例".into(),
        hub: "git@example.test:repo.git".into(),
        branch: "research/demo".into(),
        home: "research".into(),
        created_at: now_rfc3339(),
        fetched_at: None,
        fetch_error: None,
    }
}
fn line(token: u32, holder: &str, stamped: &str, stage: &str) -> String {
    format!("---\nholder: {holder}\ntoken: {token}\nstamped: {stamped}\n---\n- **阶段**：{stage}\n- **在等什么**：审核\n- **最后更新**：刚刚\n\n## 下一步\n说明\n  1. 第一项\n - 第二项\n* 第三项\n4. 不取\n## 已认领\n- 不取\n")
}

#[test]
fn new_project_validation() {
    let base = NewProject { name: "  中文项目  ".into(), hub: "git@github.com:a/b".into(), ..Default::default() };
    assert_eq!(validate_new(&base).unwrap(), ("中文项目".into(), "research".into()));
    for name in ["", "   ", "a\nb", "a\rb", "\n项目", "a\0b", "a/b", &"中".repeat(41)] {
        assert_eq!(validate_new(&NewProject { name: name.into(), ..base.clone() }).unwrap_err().code, Code::BadRequest);
    }
    for hub in ["", "x y", " x", "x\ty", "x\ny", "x\0y"] {
        assert!(validate_new(&NewProject { hub: hub.into(), ..base.clone() }).is_err(), "{hub:?}");
    }
    for home in ["", "/research", "../research", "a/../b", "research\n"] {
        assert!(validate_new(&NewProject { home: Some(home.into()), ..base.clone() }).is_err(), "{home:?}");
    }
    for branch in [
        "main",
        "research/",
        "research/-bad",
        "research/a/b",
        "research/a..b",
        "research/a.lock",
        "research/a.",
        "research/中文",
        "research/a中文",
        "research/é",
        "research/a\n",
        &format!("research/{}", "a".repeat(41)),
    ] {
        assert!(validate_branch(branch).is_err(), "{branch}");
    }
    for branch in ["research/a", "research/A_b.9-", "research/a.locked", &format!("research/{}", "a".repeat(40))] {
        validate_branch(branch).unwrap();
    }
    assert_eq!(default_branch("实验"), "research/main");
    assert_eq!(default_branch("  Demo a... "), "research/Demo-a");
}

#[test]
fn hub_address_table_and_quoting() {
    let f = Fixture::new();
    let local = f.core.server("local").unwrap();
    let remote = Server { id: "remote".into(), alias: "gpu".into(), source: ServerSource::Manual, ..local.clone() };
    let other = Server { id: "other1".into(), alias: "other".into(), ..remote.clone() };
    let servers = vec![local.clone(), remote.clone(), other.clone()];
    let ssh = "ssh -F '/a b/config' -o BatchMode=yes";
    for hub in ["git@github.com:a/b", "https://example.test/a", "ssh://gpu/a", "unknown:/repo", "/tmp/repo"] {
        for destination in [None, Some(&local), Some(&remote), Some(&other)] {
            let a = resolve_hub(hub, &servers, destination, ssh).unwrap();
            assert_eq!(a.url, hub);
            assert!(a.ssh.is_none());
            assert!(!a.home_relative);
        }
    }
    for destination in [None, Some(&local)] {
        let a = resolve_hub("gpu:~/repo.git", &servers, destination, ssh).unwrap();
        assert_eq!(a.url, "op-remote:~/repo.git");
        assert_eq!(a.ssh.as_deref(), Some(ssh));
    }
    let a = resolve_hub("gpu:repos/hub.git", &servers, Some(&remote), ssh).unwrap();
    assert_eq!(a.shell_url(), "\"$HOME\"/repos/hub.git");
    assert!(resolve_hub("gpu:/repo", &servers, Some(&other), ssh).unwrap_err().hint.unwrap().contains("GitHub"));
    for destination in [None, Some(&local)] {
        assert_eq!(resolve_hub("local:/tmp/repo", &servers, destination, ssh).unwrap().url, "/tmp/repo");
        assert_eq!(
            resolve_hub("local:~/repo", &servers, destination, ssh).unwrap().url,
            format!("{}/repo", std::env::var("HOME").unwrap())
        );
    }
    assert!(resolve_hub("local:/repo", &servers, Some(&remote), ssh).is_err());
    assert!(resolve_hub("gpu:", &servers, None, ssh).is_err());
    let a = HubAddress { url: "repo'$(echo bad)".into(), home_relative: true, ssh: None };
    assert_eq!(a.shell_url(), "\"$HOME\"/'repo'\\''$(echo bad)'");
}

#[test]
fn sections_lines_and_times() {
    let l = parse_line("a", "sync/mac", &line(5, "mac", "2026-11-01T01:00:00Z", "运行中"));
    assert_eq!(l.next, ["1. 第一项", "- 第二项", "* 第三项"]);
    assert_eq!(l.stage.as_deref(), Some("运行中"));
    assert_eq!(l.waiting.as_deref(), Some("审核"));
    assert_eq!(l.updated.as_deref(), Some("刚刚"));
    let no_front = parse_line("a", "research/demo", "holder: 假的\n正文");
    assert_eq!((no_front.holder, no_front.token), (None, 0));
    assert_eq!(parse_line("a", "sync/mac", "---\nholder: -\ntoken: 坏的\n---\n").holder, None);
    let s = "# 总结\n```md\n## 需要你决定\n假的\n```\n## 需要你决定（两项）\n\n选 A\n### 子节\n选 B\n## 结论\n不取";
    assert_eq!(section(s, "需要你决定").unwrap().trim(), "选 A\n### 子节\n选 B");
    for seconds in [0, 951_782_400, 1_794_492_865, -1] {
        assert_eq!(timestamp(&rfc3339_from_unix(seconds)), Some(seconds));
    }
    assert_eq!(timestamp("2026-11-01T08:00:00+08:00"), timestamp("2026-11-01T00:00:00Z"));
    assert!(timestamp("2026-02-30T00:00:00Z").is_none());
    assert!(timestamp("中中中中中中中中中").is_none());
}

#[test]
fn record_ranking_and_run_limit() {
    let p = project();
    let mut trees: BTreeMap<String, Tree> = BTreeMap::new();
    let mut blobs = BTreeMap::new();
    let mut add = |source: &str, file: &str, text: String| {
        let oid = format!("{}", blobs.len());
        blobs.insert(oid.clone(), text.into_bytes());
        trees.entry(source.into()).or_default().insert(format!("research/{file}"), oid);
    };
    for (source, token, holder, stamp) in [
        ("research/demo", 4, "mac", "2026-11-03T00:00:00Z"),
        ("sync/mac", 4, "mac", "2026-11-01T00:00:00Z"),
        ("sync/gpu", 3, "gpu", "2026-11-05T00:00:00Z"),
    ] {
        add(source, "state/owner.md", line(token, holder, stamp, source));
    }
    add("research/demo", "state/token.md", line(2, "mac", "2026-11-03T00:00:00Z", "旧"));
    add("sync/gpu", "state/token.md", line(3, "mac", "2026-11-01T00:00:00Z", "新"));
    add("sync/mac", "state/stamp.md", line(1, "none", "2026-11-01T08:00:00+08:00", "旧"));
    add("sync/gpu", "state/stamp.md", line(1, "none", "2026-11-01T01:00:00Z", "新"));
    add("sync/mac", "state/TEMPLATE.md", line(99, "mac", "", "不取"));
    add("sync/mac", "state/nested/no.md", line(99, "mac", "", "不取"));
    add("research/demo", "runs/r1/meta.json", json!({"kind":"test", "exit_code":null}).to_string());
    add("research/demo", "runs/r1/metrics.json", "{}".into());
    add("sync/mac", "runs/r1/meta.json", json!({"kind":"test", "machine_name":"mac", "ended_at":"2026-11-01T00:00:00Z"}).to_string());
    add("sync/mac", "runs/r1/exit_code", "7\n".into());
    add("research/demo", "runs/r2/meta.json", json!({"exit_code":0}).to_string());
    add("sync/mac", "runs/r2/meta.json", json!({"exit_code":1}).to_string());
    add("research/demo", "runs/r3/log.txt", "只有目录，没有元数据".into());
    add("sync/gpu", "runs/r3/meta.json", "{}".into());
    add("sync/gpu", "runs/r4/meta.json", "{}".into());
    add("sync/gpu", "runs/bad/meta.json", "不是 JSON".into());
    add("research/demo", "SUMMARY.md", "# 总结\n## 需要你决定\n\n批准预算\n## 其他\n不取".into());
    add("sync/mac", "SUMMARY.md", "## 需要你决定\n不能取机器分支".into());
    let (lines, runs, decisions) = derive_records(&p, &trees, &blobs);
    assert_eq!(lines.len(), 3);
    assert_eq!(lines.iter().find(|l| l.line == "owner").unwrap().source, "sync/mac");
    assert_eq!(lines.iter().find(|l| l.line == "token").unwrap().source, "sync/gpu");
    assert_eq!(lines.iter().find(|l| l.line == "stamp").unwrap().stage.as_deref(), Some("新"));
    let r1 = runs.iter().find(|r| r.run_id == "r1").unwrap();
    assert_eq!((r1.source.as_str(), r1.state.as_str(), r1.exit_code), ("sync/mac", "failed", Some(7)));
    assert!(r1.integrated);
    assert!(!r1.has_metrics);
    assert_eq!(r1.machine.as_deref(), Some("mac"));
    let r2 = runs.iter().find(|r| r.run_id == "r2").unwrap();
    assert_eq!((r2.source.as_str(), r2.state.as_str()), ("research/demo", "ok"));
    assert!(runs.iter().find(|r| r.run_id == "r3").unwrap().integrated);
    assert!(!runs.iter().find(|r| r.run_id == "r4").unwrap().integrated);
    assert_eq!(decisions.as_deref(), Some("批准预算"));
    // G21：该节没有正文或只有“无”时也返回 null。
    let summary_oid = trees[&p.branch]["research/SUMMARY.md"].clone();
    blobs.insert(summary_oid, "## 需要你决定\n\n## 其他\n".as_bytes().to_vec());
    assert_eq!(derive_records(&p, &trees, &blobs).2, None);
    for i in 0..505 {
        let file = format!("research/runs/limit{i:03}/meta.json");
        let oid = format!("limit{i}");
        trees.entry(p.branch.clone()).or_default().insert(file, oid.clone());
        blobs.insert(oid, json!({"started_at":rfc3339_from_unix(1700000000 + i)}).to_string().into_bytes());
    }
    let (_, runs, _) = derive_records(&p, &trees, &blobs);
    assert_eq!(runs.len(), 500);
    assert_eq!(runs[0].run_id, "limit504");
    assert_eq!(runs[499].run_id, "limit005");
}

#[tokio::test]
async fn bare_hub_view_from_three_clones() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let research = f.seed(&hub).await;
    write(&research, "conflict", "共同基线\n");
    write(&research, "research/state/owner.md", &line(2, "mac", "2026-11-01T00:00:00Z", "基线"));
    write(&research, "research/state/token.md", &line(1, "gpu", "2026-11-01T00:00:00Z", "旧编号"));
    write(&research, "research/runs/r1/meta.json", "{\"kind\":\"test\"}");
    write(&research, "research/runs/r2/meta.json", "{\"kind\":\"test\",\"exit_code\":0}");
    write(&research, "research/SUMMARY.md", "## 需要你决定\n\n继续实验？\n## 结论\n不取");
    commit(&research, "研究基线", false).await;
    g(&research, &["push", "-q", "origin", "HEAD"]).await;
    let mac = f.clone_repo(&hub, "mac").await;
    let gpu = f.clone_repo(&hub, "gpu").await;
    write(&research, "conflict", "研究分支推进\n");
    write(&research, "research/state/owner.md", &line(2, "mac", "2026-11-05T00:00:00Z", "已汇合旧记录"));
    commit(&research, "研究推进", false).await;
    g(&research, &["push", "-q", "origin", "HEAD", "HEAD:sync/same"]).await;
    g(&mac, &["checkout", "-q", "-b", "sync/mac"]).await;
    write(&mac, "conflict", "mac 推进\n");
    write(&mac, "research/state/owner.md", &line(2, "mac", "2026-11-02T00:00:00Z", "推进者最新"));
    write(&mac, "research/runs/r1/exit_code", "0\n");
    write(&mac, "research/runs/r1/metrics.json", "{}");
    write(&mac, "research/runs/r2/meta.json", "{\"kind\":\"test\",\"exit_code\":7}");
    commit(&mac, "mac 记录", true).await;
    g(&mac, &["push", "-q", "origin", "HEAD"]).await;
    g(&gpu, &["checkout", "-q", "-b", "sync/gpu"]).await;
    write(&gpu, "research/state/token.md", &line(8, "gpu", "2026-11-01T00:00:00Z", "新线"));
    write(&gpu, "research/runs/r3/meta.json", "{\"machine_name\":\"gpu\",\"kind\":\"explore\",\"started_at\":\"2026-11-01T00:00:00Z\"}");
    commit(&gpu, "gpu 记录", true).await;
    g(&gpu, &["push", "-q", "origin", "HEAD"]).await;
    let p = f.project(&hub).await;
    f.member(&p, "mac001", &mac, Some("mac"), false, "local");
    f.member(&p, "noname", &gpu, None, false, "local");
    f.member(&p, "archiv", &gpu, None, true, "local");
    let view = f.core.project_view(&p.id, false).await.unwrap();
    assert_eq!(view.machines.iter().map(|m| m.code.as_str()).collect::<Vec<_>>(), ["gpu", "mac", "same"]);
    assert_eq!((view.machines[0].ahead, view.machines[0].behind, view.machines[0].conflict), (1, 1, Some(false)));
    assert_eq!((view.machines[1].ahead, view.machines[1].behind, view.machines[1].conflict), (1, 1, Some(true)));
    assert_eq!((view.machines[2].ahead, view.machines[2].behind, view.machines[2].conflict), (0, 0, None));
    assert_eq!(view.machines[1].sessions, ["mac001"]);
    assert_eq!(view.machines[1].server_alias.as_deref(), Some("local"));
    assert_eq!(view.members.len(), 2);
    assert_eq!(view.lines[0].source, "sync/mac");
    assert_eq!(view.lines[0].stage.as_deref(), Some("推进者最新"));
    assert_eq!(view.lines[1].token, 8);
    let r1 = view.runs.iter().find(|r| r.run_id == "r1").unwrap();
    assert_eq!(r1.state, "ok");
    assert!(r1.has_metrics && r1.integrated);
    assert_eq!(r1.source, "sync/mac");
    assert_eq!(view.runs[0].run_id, "r3");
    assert!(!view.runs[0].integrated);
    assert_eq!(view.runs.iter().find(|r| r.run_id == "r2").unwrap().source, "research/demo");
    assert_eq!(view.decisions.as_deref(), Some("继续实验？"));
    assert_eq!(view.warnings.len(), 4);
    assert!(view.warnings[0].starts_with("mac 的记录并入"));
    assert!(view.warnings[1].starts_with("gpu 已经"));
    assert!(view.warnings[2].starts_with("mac 已经"));
    assert!(view.warnings[3].starts_with("会话 noname 还没有"));
    // 缓存 20 秒内不取；强制刷新会剪掉已删除的 sync ref，不往汇合点写任何内容。
    g(&hub, &["update-ref", "-d", "refs/heads/sync/same"]).await;
    assert_eq!(f.core.project_view(&p.id, false).await.unwrap().machines.len(), 3);
    assert_eq!(f.core.project_view(&p.id, true).await.unwrap().machines.len(), 2);
    let refs_before = g(&hub, &["show-ref"]).await;
    f.core.project_view(&p.id, true).await.unwrap();
    assert_eq!(g(&hub, &["show-ref"]).await, refs_before);
    // 离线保留旧镜像，警告排第一；再次成功清空 fetch_error。
    let moved = f.root.join("offline.git");
    std::fs::rename(&hub, &moved).unwrap();
    let stale = f.core.project_view(&p.id, true).await.unwrap();
    assert_eq!(stale.research_head, view.research_head);
    assert!(stale.project.fetch_error.is_some());
    assert!(stale.warnings[0].starts_with("取不到汇合点："));
    assert!(stale.warnings[0].contains(&fetched_time(stale.project.fetched_at.as_deref())));
    std::fs::rename(&moved, &hub).unwrap();
    assert!(f.core.project_view(&p.id, true).await.unwrap().project.fetch_error.is_none());
    // 到期刷新与镜像丢失重建。
    f.core
        .store
        .update_projects(|v| {
            v[0].fetched_at = Some("2000-01-01T00:00:00Z".into());
            Ok(())
        })
        .unwrap();
    assert_ne!(f.core.project_view(&p.id, false).await.unwrap().project.fetched_at.as_deref(), Some("2000-01-01T00:00:00Z"));
    std::fs::remove_dir_all(f.core.mirror_path(&p.id)).unwrap();
    assert_eq!(f.core.project_view(&p.id, false).await.unwrap().research_head, view.research_head);
}

#[tokio::test]
async fn project_lifecycle_empty_multiple_and_missing_branches() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let p = f.project(&hub).await;
    assert_eq!(p.branch, "research/main");
    assert!(p.fetched_at.is_some());
    assert_eq!(f.core.project("项目").unwrap(), p);
    assert_eq!(f.project_duplicate(&hub).await.code, Code::Conflict);
    let view = f.core.project_view(&p.id, false).await.unwrap();
    assert!(view.research_head.is_none());
    assert!(view.machines.is_empty());
    assert_eq!(view.warnings.len(), 1);
    let synced = f.core.sync_project(&p.id).await.unwrap();
    assert!(synced.members.is_empty());
    f.member(&p, "saved1", &f.root, None, false, "local");
    f.core.delete_project(&p.id).await.unwrap();
    assert!(!f.core.mirror_path(&p.id).exists());
    assert_eq!(f.core.project(&p.id).unwrap_err().code, Code::NotFound);
    assert_eq!(f.core.store.sessions().unwrap()[0].session.project_id.as_deref(), Some(p.id.as_str()));
    let repo = f.seed(&hub).await;
    g(&repo, &["push", "-q", "origin", "HEAD:research/second", "HEAD:sync/mac"]).await;
    let e = f
        .core
        .add_project(NewProject { name: "多分支".into(), hub: hub.to_string_lossy().into_owned(), ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(e.code, Code::BadRequest);
    let hint = e.hint.unwrap();
    assert!(hint.contains("research/demo") && hint.contains("research/second"));
    assert!(f.core.projects().unwrap().is_empty());
    let p = f
        .core
        .add_project(NewProject {
            name: "未推研究分支".into(),
            hub: hub.to_string_lossy().into_owned(),
            branch: Some("research/absent".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let view = f.core.project_view(&p.id, false).await.unwrap();
    assert_eq!((view.machines[0].ahead, view.machines[0].behind, view.machines[0].conflict), (1, 0, None));
    assert!(view.research_head.is_none());
    let before = f.core.projects().unwrap().len();
    let e = f
        .core
        .add_project(NewProject {
            name: "取不到".into(), hub: f.root.join("missing").to_string_lossy().into_owned(), ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(e.code, Code::HostUnreachable);
    assert_eq!(f.core.projects().unwrap().len(), before);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(f.core.paths().data.join("projects.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
impl Fixture {
    async fn project_duplicate(&self, hub: &Path) -> Error {
        self.core
            .add_project(NewProject { name: " 项目 ".into(), hub: hub.to_string_lossy().into_owned(), ..Default::default() })
            .await
            .unwrap_err()
    }
}

#[tokio::test]
async fn concurrent_refresh_shares_success_and_failure() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let p = f.project(&hub).await;
    // 当前线程运行时让两次请求都在第一个 git 进程等待期间进入，完成后第二个不能再取。
    let lock = project_lock(&f.core.mirror_path(&p.id));
    let initial = lock.lock().await.attempts;
    let (a, b) = tokio::join!(f.core.project_view(&p.id, true), f.core.project_view(&p.id, true));
    a.unwrap();
    b.unwrap();
    assert_eq!(lock.lock().await.attempts, initial + 1);
    // 预先排队，再在第一个返回时记录完成代次；第二个应共用它。
    let guard = lock.lock().await;
    let a_core = f.core.clone();
    let a_id = p.id.clone();
    let a = tokio::spawn(async move { a_core.project_view(&a_id, true).await });
    let b_core = f.core.clone();
    let b_id = p.id.clone();
    let b = tokio::spawn(async move { b_core.project_view(&b_id, true).await });
    tokio::task::yield_now().await;
    std::fs::rename(&hub, f.root.join("offline.git")).unwrap();
    drop(guard);
    let first = a.await.unwrap().unwrap();
    let at = lock.lock().await.completed;
    let second = b.await.unwrap().unwrap();
    assert_eq!(at, lock.lock().await.completed);
    assert_eq!(lock.lock().await.attempts, initial + 2);
    assert!(first.project.fetch_error.is_some());
    assert_eq!(first.project.fetch_error, second.project.fetch_error);
}

#[tokio::test]
async fn setup_script_escapes_and_handles_existing_repositories() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    let p = f.project(&hub).await;
    let local = f.core.server("local").unwrap();
    let marker = f.root.join("SHOULD_NOT_EXIST");
    let wd = f.dir(&format!("work ' $(touch {})", marker.display()));
    let (machine, detail) = f.core.setup_project(&p, &local, wd.to_str().unwrap()).await.unwrap();
    assert!(machine.is_none());
    assert!(detail.contains("/research:start"));
    assert_eq!(g(&wd, &["config", "--local", "rk.branch"]).await.trim(), "research/demo");
    assert_eq!(g(&wd, &["config", "--local", "rk.hub"]).await.trim(), "origin");
    assert!(!marker.exists());
    // 复用已有相同地址的任意远程；不替换不相关的 hub。
    g(&wd, &["remote", "rename", "origin", "same"]).await;
    g(&wd, &["remote", "add", "hub", "/unrelated"]).await;
    f.core.setup_project(&p, &local, wd.to_str().unwrap()).await.unwrap();
    assert_eq!(g(&wd, &["config", "--local", "rk.hub"]).await.trim(), "same");
    g(&wd, &["remote", "remove", "same"]).await;
    assert_eq!(f.core.setup_project(&p, &local, wd.to_str().unwrap()).await.unwrap_err().code, Code::Conflict);
    let busy = f.dir("busy");
    write(&busy, "user.txt", "不能覆盖");
    assert_eq!(f.core.setup_project(&p, &local, busy.to_str().unwrap()).await.unwrap_err().message, "工作目录不是空的，也不是 git 仓库");
    assert_eq!(std::fs::read_to_string(busy.join("user.txt")).unwrap(), "不能覆盖");
    // 没有提交身份时只写仓库级配置。
    g(&repo, &["config", "--local", "user.email", ""]).await;
    let (_, detail) = f.core.setup_project(&p, &local, repo.to_str().unwrap()).await.unwrap();
    assert!(detail.contains("仓库级 git 提交身份"));
    assert!(g(&repo, &["config", "--local", "user.email"]).await.trim().ends_with(".invalid"));
    // 恶意路径与 ssh 配置只作为字面量，不变成 shell 命令。
    let address = HubAddress {
        url: "op-test:repo';echo BAD".into(),
        home_relative: false,
        ssh: Some("ssh -F '/a b/config' -o BatchMode=yes".into()),
    };
    let mut p = p;
    p.home = "lab ' $(touch BAD)".into();
    let script = setup_script(&p, wd.to_str().unwrap(), &address);
    assert!(script.contains(&format!("url={}", quote(&address.url))));
    assert!(script.contains(&format!("python3 {} sync --setup --json", quote("./lab ' $(touch BAD)/tools/rk.py"))));
    assert!(script.contains(&format!("git config --local core.sshCommand {}", quote(address.ssh.as_deref().unwrap()))));
}

#[tokio::test]
async fn create_local_hub_and_deploy_to_empty_or_default_branch() {
    let f = Fixture::new();
    let hub = f.root.join("created.git");
    let p = f
        .core
        .add_project(NewProject {
            name: "创建".into(),
            hub: format!("local:{}", hub.display()),
            branch: Some("research/new".into()),
            create: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(hub.join("HEAD").exists());
    let local = f.core.server("local").unwrap();
    let wd = f.dir("empty");
    let e = f.core.setup_project(&p, &local, wd.to_str().unwrap()).await.unwrap_err();
    assert_eq!(e.code, Code::BadRequest);
    assert!(e.hint.unwrap().contains("已有仓库"));
    let seed = f.seed(&hub).await;
    // 研究分支还没推上时克隆默认分支；rk.branch 仍是项目指定的分支。
    f.core.setup_project(&p, &local, wd.to_str().unwrap()).await.unwrap();
    assert_eq!(g(&wd, &["config", "--local", "rk.branch"]).await.trim(), "research/new");
    assert_eq!(g(&wd, &["rev-parse", "HEAD"]).await, g(&seed, &["rev-parse", "HEAD"]).await);
    // 裸仓库默认 HEAD 未更新时也应取到已有内容。
    g(&hub, &["symbolic-ref", "HEAD", "refs/heads/missing"]).await;
    let wd = f.dir("empty2");
    f.core.setup_project(&p, &local, wd.to_str().unwrap()).await.unwrap();
    assert!(wd.join("README").exists());
}

#[tokio::test]
async fn real_rk_setup_and_member_sync() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    let rk = std::fs::read_to_string(embedded_rk()).expect("内嵌研究插件 rk.py");
    write(&repo, "research/tools/rk.py", &rk);
    write(&repo, "research/PROJECT.md", "# 本机真实接入测试\n");
    g(&repo, &["config", "--local", "user.email", ""]).await;
    g(&repo, &["config", "--local", "commit.gpgSign", "false"]).await;
    g(&repo, &["config", "--local", "core.hooksPath", "/dev/null"]).await;
    // 初始已有仓库，研究目录未提交，由 setup 真正提交并推送。
    let p = f.project(&hub).await;
    let local = f.core.server("local").unwrap();
    let (machine, detail) = f.core.setup_project(&p, &local, repo.to_str().unwrap()).await.unwrap();
    assert!(detail.contains("已接入研究项目"), "{detail}");
    assert!(!detail.contains("同步没完成"), "{detail}");
    let machine = machine.unwrap();
    assert_eq!(g(&repo, &["branch", "--show-current"]).await.trim(), format!("sync/{machine}"));
    f.member(&p, "real01", &repo, Some(&machine), false, "local");
    write(&repo, "research/record.md", "同步一次\n");
    let sync = f.core.sync_project(&p.id).await.unwrap();
    assert_eq!(sync.members.len(), 1);
    assert!(sync.members[0].ok, "{}", sync.members[0].detail);
    assert_eq!(sync.members[0].result.as_ref().unwrap()["machine"], machine);
    assert_eq!(sync.members[0].title, "real01");
    assert_eq!(serde_json::to_value(&sync).unwrap()["members"][0]["title"], "real01");
    assert_eq!(sync.view.machines[0].code, machine);
    assert_eq!(sync.view.machines[0].ahead, 0);
    assert_eq!(sync.view.machines[0].behind, 0);
    assert!(g(&hub, &["show", "research/demo:research/record.md"]).await.contains("同步一次"));
    // rk 退出 1 时保留 JSON 和冲突文件；缺文件 result 为空，参数错误的 JSON 也保留。
    let stub = f.dir("stub");
    write(
        &stub,
        "research/tools/rk.py",
        "import json,sys\nif '--help' in sys.argv: sys.exit(0)\nprint('前导日志')\nprint(json.dumps({'machine':'test','ok':False,'conflict':['a.md','b.md']}))\nsys.exit(1)\n",
    );
    f.member(&p, "fail01", &stub, Some("test"), false, "local");
    let missing = f.dir("missing-rk");
    f.member(&p, "miss01", &missing, None, false, "local");
    f.member(&p, "archiv", &stub, None, true, "local");
    f.member(&p, "gone01", &stub, None, false, "deleted-server");
    let unconfigured = f.dir("unconfigured");
    g(&unconfigured, &["init", "-q"]).await;
    write(&unconfigured, "research/tools/rk.py", &rk);
    f.member(&p, "unset1", &unconfigured, None, false, "local");
    let sync = f.core.sync_project(&p.id).await.unwrap();
    assert_eq!(sync.members.len(), 4);
    assert_eq!(sync.members.iter().map(|m| m.title.as_str()).collect::<Vec<_>>(), ["real01", "fail01", "miss01", "unset1"]);
    assert!(!sync.members[1].ok);
    assert!(sync.members[1].detail.contains("a.md、b.md"));
    assert!(sync.members[1].result.is_some());
    assert!(!sync.members[2].ok);
    assert!(sync.members[2].detail.contains("rk.py"));
    assert!(sync.members[2].result.is_none());
    assert!(!sync.members[3].ok);
    assert!(sync.members[3].detail.contains("研究分支"));
    assert_eq!(sync.members[3].result.as_ref().unwrap()["ok"], false);
    assert!(sync.members[3].result.as_ref().unwrap()["error"].as_str().unwrap().contains("研究分支"));
    // 部署时 JSON ok=false 仍是成功接入，并记机器代号。
    write(
        &repo,
        "research/tools/rk.py",
        "import json,sys\nif '--help' in sys.argv: sys.exit(0)\nprint(json.dumps({'machine':'test','ok':False,'error':'离线，请重试'}))\nsys.exit(1)\n",
    );
    let (machine, detail) = f.core.setup_project(&p, &local, repo.to_str().unwrap()).await.unwrap();
    assert_eq!(machine.as_deref(), Some("test"));
    assert!(detail.contains("离线，请重试"));

    // 空汇合点可由已有仓库 bootstrap，而不是在空目录里克隆。
    let empty_hub = f.dir("bootstrap.git");
    g(&empty_hub, &["init", "--bare", "-q"]).await;
    let bootstrap = f.dir("bootstrap");
    g(&bootstrap, &["init", "-q", "-b", "main"]).await;
    write(&bootstrap, "README", "已有仓库");
    commit(&bootstrap, "已有提交", false).await;
    write(&bootstrap, "research/tools/rk.py", &rk);
    write(&bootstrap, "research/PROJECT.md", "# 空汇合点接入");
    g(&bootstrap, &["config", "--local", "user.email", ""]).await;
    g(&bootstrap, &["config", "--local", "commit.gpgSign", "false"]).await;
    g(&bootstrap, &["config", "--local", "core.hooksPath", "/dev/null"]).await;
    let empty = f
        .core
        .add_project(NewProject {
            name: "空汇合点".into(),
            hub: empty_hub.to_string_lossy().into_owned(),
            branch: Some("research/empty".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let (machine, detail) = f.core.setup_project(&empty, &local, bootstrap.to_str().unwrap()).await.unwrap();
    assert!(machine.is_some());
    assert!(!detail.contains("同步没完成"), "{detail}");
    assert!(g(&empty_hub, &["show", "research/empty:research/PROJECT.md"]).await.contains("空汇合点接入"));
}

#[test]
fn sync_last_line_and_errors() {
    assert_eq!(last_json("前导\n{\"machine\":\"mac\"}\n").unwrap()["machine"], "mac");
    assert!(last_json("{}\n不是 JSON\n").is_none());
    assert!(last_json("[]").is_none());
    assert_eq!(sync_detail(Some(&json!({"error":"离线\n再试"})), ""), "离线；再试");
    assert_eq!(sync_detail(Some(&json!({"error":"错", "conflict":["a", "b"]})), ""), "冲突的文件：a、b");
}

#[tokio::test]
async fn root_home_paths_and_fractional_ordering() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    write(&repo, "state/root.md", &line(1, "-", "2026-01-01T00:00:00Z", "根目录"));
    write(&repo, "runs/a/meta.json", "{\"started_at\":\"2026-01-01T00:00:00.1Z\"}");
    write(&repo, "runs/z/meta.json", "{\"started_at\":\"2026-01-01T00:00:00.2Z\"}");
    write(&repo, "SUMMARY.md", "## 需要你决定\n根目录决定");
    commit(&repo, "根目录研究", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    let p = f
        .core
        .add_project(NewProject {
            name: "根目录".into(),
            hub: hub.to_string_lossy().into_owned(),
            home: Some("./".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let view = f.core.project_view(&p.id, false).await.unwrap();
    assert_eq!(view.lines[0].line, "root");
    assert!(view.lines[0].holder.is_none());
    assert_eq!(view.runs[0].run_id, "z");
    assert_eq!(view.decisions.as_deref(), Some("根目录决定"));
    assert_eq!(time_key("2026-01-01T00:00:00.100Z"), time_key("2026-01-01T00:00:00.1Z"));
}

#[test]
fn default_branch_ascii_truncation_and_python_parity() {
    let cases = vec![
        ("中文项目".to_string(), "research/main".to_string()),
        ("a".repeat(80), format!("research/{}", "a".repeat(40))),
        ("_-.！.._-".to_string(), "research/main".to_string()),
        (format!("{}-z", "a".repeat(39)), format!("research/{}", "a".repeat(39))),
        (format!("{}___z", "a".repeat(38)), format!("research/{}", "a".repeat(38))),
        ("--A-中文！B__C-é--".to_string(), "research/A--B__C".to_string()),
        ("  Demo a... ".to_string(), "research/Demo-a".to_string()),
        ("éA中文...B_9- ".to_string(), "research/A-B_9".to_string()),
        ("a--b__c".to_string(), "research/a--b__c".to_string()),
        ("".to_string(), "research/main".to_string()),
    ];
    for (name, want) in &cases {
        assert_eq!(&default_branch(name), want, "{name}");
        validate_branch(want).unwrap();
    }
    // 与实际参考插件逐字对比，而不只对比两套手写期望值。
    let reference = embedded_rk();
    let out = std::process::Command::new("python3")
        .args([
            "-B",
            "-c",
            r#"
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('rk', sys.argv[1])
rk = importlib.util.module_from_spec(spec); spec.loader.exec_module(rk)
print(json.dumps([rk.default_research_branch(name) for name in json.loads(sys.argv[2])]))
"#,
        ])
        .arg(reference)
        .arg(serde_json::to_string(&cases.iter().map(|c| &c.0).collect::<Vec<_>>()).unwrap())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(serde_json::from_slice::<Vec<String>>(&out.stdout).unwrap(), cases.into_iter().map(|c| c.1).collect::<Vec<_>>());
}

#[tokio::test]
async fn invalid_project_names_and_branches_have_no_side_effects() {
    let f = Fixture::new();
    let hub = f.root.join("must-not-create.git");
    let req = NewProject { name: "a/b".into(), hub: format!("local:{}", hub.display()), create: true, ..Default::default() };
    let err = f.core.add_project(req.clone()).await.unwrap_err();
    assert_eq!(err.code, Code::BadRequest);
    assert!(err.message.contains("/") && err.message.contains("路径"));
    for branch in ["research/a中文".to_string(), format!("research/{}", "x".repeat(41))] {
        let err = f.core.add_project(NewProject { name: "合法项目".into(), branch: Some(branch), ..req.clone() }).await.unwrap_err();
        assert_eq!(err.code, Code::BadRequest);
        assert!(err.message.contains("ASCII") && err.message.contains("40"));
    }
    assert!(!hub.exists());
    assert!(!f.core.paths().data.join("hubs").exists());
    assert!(f.core.projects().unwrap().is_empty());
}

#[tokio::test]
async fn create_flag_git_urls_and_local_aliases() {
    let f = Fixture::new();
    // 普通 git 地址即使 create=true 也不能帮它建仓库。
    let missing = f.root.join("git-address.git");
    let err = f
        .core
        .add_project(NewProject {
            name: "git地址".into(), hub: missing.to_string_lossy().into_owned(), create: true, ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::HostUnreachable);
    assert!(!missing.exists());
    f.core.patch_server("local", ServerPatch { alias: Some("desktop".into()), ..Default::default() }).await.unwrap();
    // 模拟远端恰好占了 local 别名，保留标记仍指本机。
    let local = f.core.server("local").unwrap();
    f.core
        .store
        .update_servers(|v| {
            v.push(Server { id: "remote".into(), alias: "local".into(), source: ServerSource::Manual, ..local });
            Ok(())
        })
        .unwrap();
    for alias in ["local", "desktop"] {
        let hub = f.root.join(format!("{alias}.git"));
        let p = f
            .core
            .add_project(NewProject { name: alias.into(), hub: format!("{alias}:{}", hub.display()), create: true, ..Default::default() })
            .await
            .unwrap();
        assert!(p.fetched_at.is_some());
        assert_eq!(g(&hub, &["rev-parse", "--is-bare-repository"]).await.trim(), "true");
    }
    // 即使不显示本机服务器记录，local: 也不降级为 ssh 地址。
    f.core
        .store
        .update_servers(|v| {
            v.retain(|s| !s.is_local());
            Ok(())
        })
        .unwrap();
    let hub = f.root.join("hidden-local.git");
    f.core
        .add_project(NewProject { name: "hidden".into(), hub: format!("local:{}", hub.display()), create: true, ..Default::default() })
        .await
        .unwrap();
    assert!(hub.join("HEAD").exists());
}

#[tokio::test]
async fn local_patch_all_equal_connection_fields_is_allowed() {
    let f = Fixture::new();
    let cur = f.core.server("local").unwrap();
    let same: ServerPatch = serde_json::from_value(json!({"host":cur.host,"user":cur.user,"port":cur.port,
        "key":cur.key,"proxy_jump":cur.proxy_jump,"proxy_command":cur.proxy_command,
        "alias":"desktop","note":"本机备注","default_workdir":"~/work"}))
    .unwrap();
    let updated = f.core.patch_server("local", same).await.unwrap();
    assert_eq!((updated.alias.as_str(), updated.note.as_str(), updated.default_workdir.as_str()), ("desktop", "本机备注", "~/work"));
    for patch in [
        json!({"host":"other"}),
        json!({"user":"other"}),
        json!({"port":2222}),
        json!({"key":"missing"}),
        json!({"proxy_jump":"gpu"}),
        json!({"proxy_command":"ssh gpu"}),
    ] {
        assert_eq!(f.core.patch_server("local", serde_json::from_value(patch).unwrap()).await.unwrap_err().code, Code::BadRequest);
    }
    assert_eq!(serde_json::to_value(f.core.server("local").unwrap()).unwrap(), serde_json::to_value(updated).unwrap());
}

#[tokio::test]
async fn missing_deploy_project_precedes_all_steps_and_side_effects() {
    let f = Fixture::new();
    let workdir = f.root.join("must-not-create");
    let servers = std::fs::read(f.core.paths().data.join("servers.json")).unwrap();
    let req: DeployRequest = serde_json::from_value(json!({"server_id":"local", "agent_id":"codex", "workdir":workdir,
        "project_id":"missing", "plugins":[]}))
    .unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let failure = f.core.deploy(req, Some(tx)).await.unwrap_err();
    assert_eq!(failure.error.code, Code::NotFound);
    assert!(failure.error.message.contains("missing"));
    assert!(failure.steps.is_empty());
    assert!(rx.recv().await.is_none());
    assert!(!workdir.exists());
    assert_eq!(std::fs::read(f.core.paths().data.join("servers.json")).unwrap(), servers);
    assert!(f.core.store.sessions().unwrap().is_empty());
}

#[test]
fn project_setup_error_codes_preserve_transport_errors() {
    for code in [Code::HostUnreachable, Code::SshFailed, Code::AuthFailed, Code::Timeout] {
        let err = setup_result(Err(Error::new(code, "目标机器连接失败").with_hint("原始建议"))).unwrap_err();
        assert_eq!(err.code, code);
        assert_eq!(err.message, "目标机器连接失败");
        assert_eq!(err.hint.as_deref(), Some("原始建议"));
    }
    for (exit, code) in [(41, Code::BadRequest), (42, Code::Conflict), (43, Code::BadRequest), (44, Code::HostUnreachable)] {
        let err = setup_result(Ok(crate::ssh::RemoteOutput {
            code: exit,
            stdout: vec![],
            stderr: "git 最后一行错误".into(),
            elapsed: Duration::ZERO,
        }))
        .unwrap_err();
        assert_eq!(err.code, code);
        if exit == 44 {
            assert!(err.message.contains("git 最后一行错误"));
        }
    }
}

#[tokio::test]
async fn failed_fetch_warning_formats_utc_and_never_fetched() {
    let f = Fixture::new();
    for (fetched, expected) in [
        (Some("2026-11-13T08:07:59.123+08:00"), "2026-11-13 00:07 UTC"),
        (Some("2024-03-01T00:20:00+01:00"), "2024-02-29 23:20 UTC"),
        (Some("2026-12-31T23:59:59-01:00"), "2027-01-01 00:59 UTC"),
        (Some("2026-11-13T03:04:05Z"), "2026-11-13 03:04 UTC"),
        (None, "还没有成功取得过汇合点"),
    ] {
        let p = Project { fetched_at: fetched.map(str::to_string), fetch_error: Some("离线".into()), ..project() };
        let view = derive_view(&f.root.join("absent.git"), p, vec![]).await.unwrap();
        assert_eq!(
            view.warnings[0],
            if fetched.is_none() {
                "取不到汇合点：离线，还没有成功取得过汇合点".to_string()
            } else {
                format!("取不到汇合点：离线，显示的是 {expected} 的内容")
            }
        );
        assert_eq!(view.project.fetched_at.as_deref(), fetched);
    }
}

#[test]
fn project_lookup_prefers_id_over_name() {
    let f = Fixture::new();
    let by_name = Project { id: "name01".into(), name: "abc123".into(), ..project() };
    let by_id = project();
    f.core
        .store
        .update_projects(|v| {
            v.extend([by_name.clone(), by_id.clone()]);
            Ok(())
        })
        .unwrap();
    assert_eq!(f.core.project("abc123").unwrap(), by_id);
    assert_eq!(f.core.project("示例").unwrap(), by_id);
    assert_eq!(f.core.project("name01").unwrap(), by_name);
}

#[tokio::test]
async fn git_stdin_is_empty_except_hash_batch() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    let alias = "alias.stdin-probe=!printf 'prompt=%s\\n' \"$GIT_TERMINAL_PROMPT\"; if IFS= read -r line; then echo unexpected-input; exit 9; else echo EOF; fi";
    let out = git(&repo, &["-c", alias, "stdin-probe"], None, None).await.unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "prompt=0\nEOF\n");
    // shell 执行入口也必须让 git 看见 EOF，而不是吞掉余下脚本。
    let local = f.core.server("local").unwrap();
    let out = f
        .core
        .exec(&local, &format!("export GIT_TERMINAL_PROMPT=0\ngit -c {} stdin-probe\necho after-git\n", quote(alias)), GIT_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(out.code, 0);
    assert_eq!(out.text(), "prompt=0\nEOF\nafter-git\n");
    write(&repo, "research/state/a.md", "same blob\n");
    write(&repo, "research/state/b.md", "same blob\n");
    commit(&repo, "重复对象", false).await;
    let head = g(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
    let branches =
        ["research/demo", "sync/mac"].map(|name| Branch { name: name.into(), head: head.clone(), committed: None, subject: String::new() });
    let (trees, blobs, skipped) = read_objects(&repo, "research", &branches).await.unwrap();
    assert_eq!(skipped, 0);
    assert_eq!(trees.len(), 2);
    assert_eq!(trees["research/demo"].len(), 2);
    assert_eq!(blobs.len(), 1);
    assert_eq!(blobs.values().next().unwrap(), b"same blob\n");
}

fn embedded_rk() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/research/templates/research/tools/rk.py")
}

#[test]
fn embedded_rk_has_sync_and_matching_version() {
    let rk = embedded_rk();
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(rk.ancestors().nth(4).unwrap().join(".claude-plugin/plugin.json")).unwrap()).unwrap();
    let out = std::process::Command::new("python3").args(["-B", "-c",
        "import importlib.util,sys; s=importlib.util.spec_from_file_location('rk',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.RK_VERSION)"])
        .arg(&rk).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), manifest["version"].as_str().unwrap());
    let out = std::process::Command::new("python3").arg(&rk).args(["sync", "--help"]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains("--setup"));
}

#[tokio::test]
async fn large_objects_and_literal_home_are_bounded() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    let home = ":(glob)**";
    write(&repo, &format!("{home}/state/normal.md"), &line(1, "-", "2026-01-01T00:00:00Z", "正常"));
    write(&repo, &format!("{home}/state/large.md"), &"x".repeat(MAX_BLOB + 1));
    write(&repo, "elsewhere/state/outside.md", &line(1, "-", "2026-01-01T00:00:00Z", "不该读取"));
    commit(&repo, "有界读取", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    let p = f
        .core
        .add_project(NewProject {
            name: "字面目录".into(),
            hub: hub.to_string_lossy().into_owned(),
            home: Some(home.into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let view = f.core.project_view(&p.id, false).await.unwrap();
    assert_eq!(view.lines.len(), 1);
    assert_eq!(view.lines[0].line, "normal");
    assert_eq!(view.warnings.last().unwrap(), "汇合点里有 1 个文件过大或过多，没有读入视图");
    let head = g(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
    let branches = [Branch { name: p.branch.clone(), head, committed: None, subject: String::new() }];
    let (_, blobs, skipped) = read_objects(&repo, home, &branches).await.unwrap();
    assert_eq!(skipped, 1);
    assert_eq!(blobs.len(), 1);
    assert!(blobs.values().all(|v| v.len() <= MAX_BLOB));
}

#[tokio::test]
async fn ext_transport_never_executes_helper() {
    if std::env::var_os("BUNSEN_R1_EXT_CHILD").is_none() {
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "projects::tests::ext_transport_never_executes_helper", "--nocapture"])
            .env("BUNSEN_R1_EXT_CHILD", "1")
            .env("GIT_ALLOW_PROTOCOL", "ext")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "protocol.ext.allow")
            .env("GIT_CONFIG_VALUE_0", "always")
            .output()
            .unwrap();
        assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
        return;
    }
    let f = Fixture::new();
    let helper = f.root.join("helper");
    let marker = f.root.join("EXECUTED");
    write(&f.root, "helper", &format!("#!/bin/sh\ntouch {}\n", quote(marker.to_str().unwrap())));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let hub = format!("ext::{}", helper.display());
    let err = f.core.add_project(NewProject { name: "禁止 helper".into(), hub: hub.clone(), ..Default::default() }).await.unwrap_err();
    assert_eq!(err.code, Code::HostUnreachable);
    assert!(err.message.contains("transport 'ext' not allowed"), "{}", err.message);
    assert!(!marker.exists());
    let wd = f.dir("deploy-ext");
    let err =
        f.core.setup_project(&Project { hub, ..project() }, &f.core.server("local").unwrap(), wd.to_str().unwrap()).await.unwrap_err();
    assert_eq!(err.code, Code::HostUnreachable);
    assert!(err.message.contains("transport 'ext' not allowed"));
    assert!(!marker.exists());
}

#[tokio::test]
async fn unsafe_remote_is_not_reused_and_old_rk_is_not_run() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    g(&repo, &["remote", "rename", "--", "origin", "-v"]).await;
    // 不支持 sync 的旧工具；若错误地执行 --setup，会留下证据。
    write(&repo, "research/tools/rk.py", "import sys,pathlib\nif '--setup' in sys.argv: pathlib.Path('BAD_SETUP').touch()\nsys.exit(2)\n");
    g(&repo, &["config", "--local", "user.email", ""]).await; // 不依赖开发机的全局身份
    let p = f.project(&hub).await;
    let (machine, detail) = f.core.setup_project(&p, &f.core.server("local").unwrap(), repo.to_str().unwrap()).await.unwrap();
    assert!(machine.is_none());
    assert_eq!(detail, "已设置仓库级 git 提交身份；仓库里的 rk.py 是旧版，没有 sync：在这台机器上执行 /research:resume（会更新研究工具）后再执行 rk sync --setup（研究分支已写进 git config）");
    assert_eq!(g(&repo, &["config", "rk.hub"]).await.trim(), "hub");
    f.member(&p, "oldrk1", &repo, None, false, "local");
    let sync = f.core.sync_project(&p.id).await.unwrap();
    assert!(!sync.members[0].ok);
    assert!(sync.members[0].result.is_none());
    assert_eq!(sync.members[0].detail, "这台机器上仓库里的 rk.py 是旧版，没有 sync：在那里执行 /research:resume 更新研究工具");
    assert!(!repo.join("BAD_SETUP").exists());
}

#[tokio::test]
async fn mirror_file_lock_excludes_fetch_and_delete() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let p = f.project(&hub).await;
    let path = f.core.mirror_path(&p.id);
    for delete in [false, true] {
        // 独立 open，不依靠进程内 project_lock。
        let file = crate::store::lock_file(&path.with_extension("lock")).unwrap();
        let core = Core::open_at(f.core.paths().clone()).unwrap();
        let id = p.id.clone();
        let task = tokio::spawn(async move {
            if delete {
                core.delete_project(&id).await
            } else {
                core.project_view(&id, true).await.map(|_| ())
            }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!task.is_finished());
        assert!(path.join("HEAD").exists());
        drop(file);
        task.await.unwrap().unwrap();
    }
    assert!(!path.exists());
}

#[tokio::test]
async fn disabled_existing_local_and_local_hub() {
    // 子测试进程隔离环境变量，避免与其他本机测试争用全局 env。
    if let Ok(root) = std::env::var("BUNSEN_R1_DISABLED_CHILD") {
        let root = PathBuf::from(root);
        let core = Core::open_at(Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        assert!(!core.servers().unwrap().iter().any(Server::is_local));
        assert_eq!(core.server("local").unwrap_err().code, Code::NotFound);
        let stored = core.store.servers().unwrap().into_iter().find(Server::is_local).unwrap();
        assert_eq!(core.exec(&stored, "touch BAD", Duration::from_secs(1)).await.unwrap_err().code, Code::NotFound);
        let request =
            serde_json::from_value(json!({"server_id":"local","agent_id":"codex","workdir":root.join("must-not-create")})).unwrap();
        assert_eq!(core.deploy(request, None).await.unwrap_err().error.code, Code::NotFound);
        assert!(!root.join("must-not-create").exists());
        assert_eq!(core.session("local1").await.unwrap().state, SessionState::Unknown);
        assert_eq!(core.sessions(true).await.unwrap()[0].state, SessionState::Unknown);
        let p = core
            .add_project(NewProject {
                name: "禁用时本地汇合点".into(),
                hub: format!("local:{}", root.join("hidden.git").display()),
                create: true,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(core.project_view(&p.id, true).await.unwrap().research_head.is_none());
        let seed = root.join("hidden-seed");
        std::fs::create_dir_all(&seed).unwrap();
        g(&seed, &["init", "-q", "-b", "research/hidden"]).await;
        write(&seed, "research/state/visible.md", &line(1, "-", "2026-01-01T00:00:00Z", "本机路径仍可读"));
        commit(&seed, "本地汇合内容", false).await;
        g(&seed, &["push", "-q", root.join("hidden.git").to_str().unwrap(), &format!("HEAD:{}", p.branch)]).await;
        let view = core.project_view(&p.id, true).await.unwrap();
        assert_eq!(view.lines[0].stage.as_deref(), Some("本机路径仍可读"));
        let absent = Core::open_at(Paths { data: root.join("absent-data"), cm_dir: root.join("absent-cm") }).unwrap();
        assert!(absent.store.servers().unwrap().is_empty());
        let p = absent
            .add_project(NewProject {
                name: "没有本机记录".into(),
                hub: format!("local:{}", root.join("hidden.git").display()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(absent.project_view(&p.id, true).await.unwrap().lines[0].line, "visible");
        let remote = Server { source: ServerSource::Manual, id: "remote".into(), ..stored };
        assert_eq!(resolve_hub(&p.hub, &[], Some(&remote), "ssh").unwrap_err().code, Code::BadRequest);
        return;
    }
    let f = Fixture::new();
    let workdir = f.dir("local-work");
    f.member(&project(), "local1", &workdir, None, false, "local");
    let before = std::fs::read(f.core.paths().data.join("servers.json")).unwrap();
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "projects::tests::disabled_existing_local_and_local_hub", "--nocapture"])
        .env("BUNSEN_R1_DISABLED_CHILD", &f.root)
        .env("BUNSEN_NO_LOCAL", "1")
        .output()
        .unwrap();
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
    assert_eq!(std::fs::read(f.core.paths().data.join("servers.json")).unwrap(), before);
    assert!(Core::open_at(f.core.paths().clone()).unwrap().server("local").is_ok());
}

#[tokio::test]
async fn path_and_total_object_budgets() {
    let f = Fixture::new();
    let repo = f.dir("budget-repo");
    g(&repo, &["init", "-q", "-b", "research/budget"]).await;
    for n in 0..65 {
        let text = format!("{n:08}{}", "x".repeat(MAX_BLOB - 8));
        write(&repo, &format!("research/state/b{n:03}.md"), &text);
    }
    commit(&repo, "总字节预算", false).await;
    let mut branches = [Branch {
        name: "research/budget".into(),
        head: g(&repo, &["rev-parse", "HEAD"]).await.trim().into(),
        committed: None,
        subject: String::new(),
    }];
    let (trees, blobs, skipped) = read_objects(&repo, "research", &branches).await.unwrap();
    assert_eq!(skipped, 1);
    assert_eq!(trees["research/budget"].len(), 64);
    assert_eq!(blobs.values().map(Vec::len).sum::<usize>(), MAX_TOTAL);
    drop(blobs);
    // 单个 blob 去重后很小，也不能越过每分支路径数上限。
    std::fs::remove_dir_all(repo.join("research")).unwrap();
    for n in 0..=MAX_PATHS {
        write(&repo, &format!("research/state/p{n:05}.md"), "small blob");
    }
    commit(&repo, "路径预算", false).await;
    branches[0].head = g(&repo, &["rev-parse", "HEAD"]).await.trim().into();
    let (trees, blobs, skipped) = read_objects(&repo, "research", &branches).await.unwrap();
    assert_eq!(skipped, 1);
    assert_eq!(trees["research/budget"].len(), MAX_PATHS);
    assert_eq!(blobs.len(), 1);
}

async fn r2_process(name: &str, root: &Path, env: &[(&str, &str)]) -> Output {
    let mut cmd = Command::new(std::env::current_exe().unwrap());
    cmd.args(["--exact", name, "--nocapture"])
        .env("BUNSEN_R2_CHILD", root)
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(40), cmd.output()).await.expect("R2 child exceeded 40s").unwrap()
}
fn assert_child(out: &Output) {
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
}

#[tokio::test]
async fn hidden_local_id_never_falls_back_to_remote_alias() {
    if let Ok(root) = std::env::var("BUNSEN_R2_CHILD") {
        let root = PathBuf::from(root);
        let core = Core::open_at(Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        assert_eq!(core.server("local").unwrap_err().code, Code::NotFound);
        assert_eq!(core.server("desktop").unwrap_err().code, Code::NotFound);
        assert_eq!(core.server("remote1").unwrap().alias, "local");
        assert_eq!(core.session("local1").await.unwrap().state, SessionState::Unknown);
        assert!(core.term_command(&crate::term::TermTarget::Agent { session: "local1".into() }).is_err());
        core.store
            .update_servers(|v| {
                v.retain(|s| !s.is_local());
                Ok(())
            })
            .unwrap();
        assert_eq!(core.server("local").unwrap_err().code, Code::NotFound); // G24 保留 id 不回退
        assert_eq!(core.server_by_id("local").unwrap_err().code, Code::NotFound);
        assert_eq!(core.session("local1").await.unwrap().state, SessionState::Unknown);
        return;
    }
    let f = Fixture::new();
    f.core
        .store
        .update_servers(|v| {
            let local = v.iter_mut().find(|s| s.is_local()).unwrap();
            local.alias = "desktop".into();
            let remote = Server { id: "remote1".into(), alias: "local".into(), source: ServerSource::Manual, ..local.clone() };
            v.push(remote);
            Ok(())
        })
        .unwrap();
    f.member(&project(), "local1", &f.root, None, false, "local");
    assert_child(
        &r2_process("projects::tests::hidden_local_id_never_falls_back_to_remote_alias", &f.root, &[("BUNSEN_NO_LOCAL", "1")]).await,
    );
}

#[tokio::test]
async fn integrated_run_directory_survives_object_filtering() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    write(&repo, "research/runs/r3/logs/output.txt", "log only on research branch");
    write(&repo, "research/runs/r4/meta.json", &"x".repeat(MAX_BLOB + 1));
    commit(&repo, "研究分支只有日志", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    g(&repo, &["checkout", "-q", "-b", "sync/mac"]).await;
    write(&repo, "research/runs/r3/meta.json", "{\"kind\":\"explore\"}");
    write(&repo, "research/runs/r4/meta.json", "{\"kind\":\"explore\"}");
    commit(&repo, "机器上有运行元数据", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    let p = f.project(&hub).await;
    let view = f.core.project_view(&p.id, false).await.unwrap();
    assert_eq!(view.runs.len(), 2);
    assert!(view.runs.iter().all(|r| r.integrated));
    assert_eq!(view.runs[0].source, "sync/mac");
    let branches = [Branch { name: p.branch, head: view.research_head.unwrap(), committed: None, subject: String::new() }];
    let (trees, blobs, _) = read_objects(&f.core.mirror_path(&p.id), "research", &branches).await.unwrap();
    assert!(trees["research/demo"].contains_key("research/runs/r3/"));
    assert!(blobs.is_empty());
}

#[tokio::test]
async fn refresh_result_is_shared_between_processes_success_and_failure() {
    if let Ok(root) = std::env::var("BUNSEN_R2_CHILD") {
        let root = PathBuf::from(root);
        let core = Core::open_at(Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        let p = core.projects().unwrap().pop().unwrap();
        std::fs::write(root.join(format!("ready-{}", std::process::id())), "").unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            while std::fs::read_dir(&root)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with("ready-"))
                .count()
                < 2
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("refresh overlap barrier exceeded 15s");
        let view = core.project_view(&p.id, true).await.unwrap();
        assert_eq!(view.project.fetch_error.is_some(), std::env::var("R2_FETCH_FAIL").unwrap() == "1");
        return;
    }
    let f = Fixture::new();
    let hub = f.hub().await;
    let p = f.project(&hub).await;
    f.core
        .store
        .update_projects(|v| {
            v[0].hub = "ssh://fixture/repo".into();
            Ok(())
        })
        .unwrap();
    let counter = f.root.join("fetch-count");
    let wrapper = f.root.join("ssh-wrapper");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for fail in ["0", "1"] {
            for e in
                std::fs::read_dir(&f.root).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("ready-"))
            {
                std::fs::remove_file(e.path()).unwrap();
            }
            std::fs::write(&counter, "").unwrap();
            write(&f.root,"ssh-wrapper",&format!("#!/bin/sh\necho fetch >> {}\nsleep 1\nif [ \"$R2_FETCH_FAIL\" = 1 ]; then echo unavailable >&2; exit 1; fi\nexec /usr/bin/git-upload-pack {}\n",quote(counter.to_str().unwrap()),quote(hub.to_str().unwrap())));
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
            let env = [("GIT_SSH_COMMAND", wrapper.to_str().unwrap()), ("GIT_SSH_VARIANT", "ssh"), ("R2_FETCH_FAIL", fail)];
            let (a, b) = tokio::join!(
                r2_process("projects::tests::refresh_result_is_shared_between_processes_success_and_failure", &f.root, &env),
                r2_process("projects::tests::refresh_result_is_shared_between_processes_success_and_failure", &f.root, &env)
            );
            assert_child(&a);
            assert_child(&b);
            assert_eq!(std::fs::read_to_string(&counter).unwrap().lines().count(), 1, "重复 fetch: {fail}");
            assert!(f.core.mirror_path(&p.id).with_extension("fetch.json").exists());
        }
    }
}

#[tokio::test]
async fn credentials_are_redacted_at_every_diagnostic_exit() {
    const SECRET: &str = "https://USER:REVIEW_FAKE_TOKEN@host/path";
    if let Ok(root) = std::env::var("BUNSEN_R2_CHILD") {
        let root = PathBuf::from(root);
        let core = Core::open_at(Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        let e = core.add_project(NewProject { name: "credentials".into(), hub: SECRET.into(), ..Default::default() }).await.unwrap_err();
        assert_eq!(e.code, Code::HostUnreachable);
        assert_eq!(e.code.http_status(), 502);
        assert!(!e.message.contains("REVIEW_FAKE_TOKEN"));
        assert!(e.message.contains("https://***@host/path"));
        let p = core.projects().unwrap().pop().unwrap();
        let view = core.project_view(&p.id, true).await.unwrap();
        assert!(!view.project.fetch_error.as_ref().unwrap().contains("REVIEW_FAKE_TOKEN"));
        assert!(!view.warnings[0].contains("REVIEW_FAKE_TOKEN"));
        assert!(view.warnings[0].contains("https://***@host/path"));
        assert!(!std::fs::read_to_string(core.paths().data.join("projects.json")).unwrap().contains("REVIEW_FAKE_TOKEN"));
        let (_, detail) = setup_result(Ok(crate::ssh::RemoteOutput {
            code: 0,
            stdout: format!("{{\"ok\":false,\"error\":\"{SECRET}\"}}\n").into_bytes(),
            stderr: String::new(),
            elapsed: Duration::ZERO,
        }))
        .unwrap();
        assert!(!detail.contains("REVIEW_FAKE_TOKEN"));
        assert!(detail.contains("***@host"));
        let synced = core.sync_project(&p.id).await.unwrap();
        assert!(!synced.members[0].ok);
        assert!(!synced.members[0].detail.contains("REVIEW_FAKE_TOKEN"));
        assert!(!synced.members[0].result.as_ref().unwrap()["error"].as_str().unwrap().contains("REVIEW_FAKE_TOKEN"));
        assert!(!serde_json::to_string(&synced.members[0].result).unwrap().contains("REVIEW_FAKE_TOKEN"));
        // 序列化兜底也覆盖公共结构体直接赋值和旧记录。
        let raw = crate::error::Error { code: Code::Internal, message: SECRET.into(), hint: Some(SECRET.into()) };
        assert!(!serde_json::to_string(&raw).unwrap().contains("REVIEW_FAKE_TOKEN"));
        assert!(!raw.to_string().contains("REVIEW_FAKE_TOKEN"));
        return;
    }
    let f = Fixture::new();
    let hub = f.hub().await;
    let p = f.project(&hub).await;
    let stub = f.dir("stub");
    write(
        &stub,
        "research/tools/rk.py",
        &format!(
            "import sys,json\nif '--help' in sys.argv: sys.exit(0)\nprint(json.dumps({{'ok':False,'error':'{SECRET}','hub_url':'{SECRET}'}}))\nsys.exit(1)\n"
        ),
    );
    f.member(&p, "member1", &stub, None, false, "local");
    let bin = f.dir("bin");
    write(&bin,"git",&format!("#!/bin/sh\nif [ \"$1\" = fetch ]; then printf '%s\\n' 'fatal: asked for {SECRET}' >&2; exit 128; fi\nexec /usr/bin/git \"$@\"\n"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(bin.join("git"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
    assert_child(&r2_process("projects::tests::credentials_are_redacted_at_every_diagnostic_exit", &f.root, &[("PATH", &path)]).await);
}

#[tokio::test]
async fn dot_project_names_are_rejected_without_side_effects() {
    let f = Fixture::new();
    let hub = f.root.join("must-not-create.git");
    for name in [".", "..", " . ", " .. "] {
        let e = f
            .core
            .add_project(NewProject { name: name.into(), hub: format!("local:{}", hub.display()), create: true, ..Default::default() })
            .await
            .unwrap_err();
        assert_eq!(e.code, Code::BadRequest);
        assert!(!hub.exists());
        assert!(f.core.projects().unwrap().is_empty());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn real_rk_outer_timeout_and_cancel_clean_git_and_merge() {
    tokio::time::timeout(Duration::from_secs(240), async {
        for mode in ["timeout", "cancel", "remote-timeout", "remote-cancel"] {
            let f = Fixture::new();
            let hub = f.hub().await;
            let repo = f.seed(&hub).await;
            write(&repo, "research/existing.md", "original tracked content\n");
            write(&repo, "research/deleted.md", "must be restored\n");
            commit(&repo, "merge fixture base", false).await;
            let pre = g(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
            write(&repo, "research/existing.md", "incoming modification\n");
            std::fs::remove_file(repo.join("research/deleted.md")).unwrap();
            write(&repo, "research/incoming.md", "incoming\n");
            commit(&repo, "incoming", false).await;
            g(&repo, &["push", "-q", "origin", "HEAD"]).await;
            g(&repo, &["checkout", "-q", "-b", "sync/mac", &pre]).await;
            write(&repo, "research/local.md", "local\n");
            commit(&repo, "local", false).await;
            let source = std::env::var_os("BUNSEN_R2_MUTANT_RK").map(PathBuf::from).unwrap_or_else(embedded_rk);
            write(&repo, "research/tools/rk.py", &std::fs::read_to_string(source).unwrap());
            g(&repo, &["config", "rk.branch", "research/demo"]).await;
            g(&repo, &["config", "rk.hub", "origin"]).await;
            write(&repo, "research/.gitignore", ".loop/\n");
            // 入口工具先提交，避免同步自身的提交改变断言基线。
            commit(&repo, "tools", false).await;
            let before = g(&repo, &["rev-parse", "HEAD"]).await;
            write(&repo, "README", "user dirty work must survive\n");
            write(
                &repo,
                ".git/hooks/pre-commit",
                &format!("#!/bin/sh\ntrap '' TERM HUP INT\nsleep 120 &\nprintf '%s\\n' \"$PPID\" \"$$\" \"$!\" > {0}.tmp\nmv -- {0}.tmp {0}\nwait\n", quote(repo.join("git.pid").to_str().unwrap())),
            );
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(repo.join(".git/hooks/pre-commit"), std::fs::Permissions::from_mode(0o755)).unwrap();
            g(&repo, &["config", "user.name", "test"]).await;
            g(&repo, &["config", "user.email", "test@example.invalid"]).await;
            g(&repo, &["config", "commit.gpgSign", "false"]).await;
            let body = format!(
                "cd -- {}\nmkdir -p research/.loop/git-temps\nTMPDIR=\"$PWD/research/.loop/git-temps\" RK_MACHINE_NAME=mac RK_NO_AUTOSYNC=1 python3 research/tools/rk.py sync --json > research/.loop/test.stdout 2> research/.loop/test.stderr\n",
                quote(repo.to_str().unwrap())
            );
            let cancel = mode.ends_with("cancel");
            // 启动就绪窗口 15s 严格短于 timeout 的 20s；hook 阻塞 120s。
            // 不再要求 rk 在原来的 5s 操作预算内完成全部启动/取仓库工作。
            let budget = if cancel { Duration::from_secs(60) } else { Duration::from_secs(20) };
            let remote = mode.starts_with("remote");
            let task = tokio::spawn(async move {
                if remote {
                    let (command, input) = crate::ssh::supervised_script(&body, budget);
                    let mut cmd = Command::new("bash");
                    cmd.args(["-c", &command]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
                    crate::exec::run_command(cmd, input, budget, true, "test").await
                } else {
                    crate::exec::run_local(&body, budget).await
                }
            });
            let ready = tokio::time::timeout(Duration::from_secs(15), async {
                while !repo.join("git.pid").exists() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await;
            if ready.is_err() {
                let detail = if task.is_finished() {
                    match task.await.unwrap() {
                        Ok(out) => format!("exit={} stdout={} stderr={}", out.code, out.text(), out.stderr),
                        Err(error) => format!("execution error: {error}"),
                    }
                } else {
                    task.abort();
                    let _ = task.await;
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    "rk was still running".into()
                };
                let debug = std::env::temp_dir().join(format!("bunsen-r6-startup-{}", short_id()));
                crate::exec::copy_dir(&repo, &debug).unwrap();
                panic!("{mode}: git did not reach merge hook in 15s (outer timeout is 20s); {detail}; fixture={}", debug.display());
            }
            if cancel {
                task.abort();
                let _ = task.await;
            } else {
                assert!(task.await.unwrap().is_err());
            }
            let pid = std::fs::read_to_string(repo.join("git.pid")).unwrap();
            // TERM 后有 3s 宽限；以真实进程/仓库状态等待清理，不赌固定 4s 调度。
            let _ = tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    let mut alive = false;
                    for child in pid.lines() {
                        alive |= Command::new("/bin/kill").args(["-0", "--", child]).output().await.unwrap().status.success();
                    }
                    if !alive && !repo.join(".git/MERGE_HEAD").exists() && !repo.join(".git/index.lock").exists() { break; }
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            }).await;
            let mut survivors = Vec::new();
            for child in pid.lines() {
                let probe = Command::new("/bin/kill").args(["-0", "--", child]).output().await.unwrap();
                if probe.status.success() { survivors.push(child); }
            }
            let gone = survivors.is_empty();
            let clean = !repo.join(".git/MERGE_HEAD").exists() && !repo.join(".git/index.lock").exists();
            // 撤回验证也只清理本夹具记录的 PID/组，绝不扫描或结束其他进程。
            if !gone {
                let _ = Command::new("/bin/kill").args(["-KILL", "--", &format!("-{}", pid.lines().next().unwrap())]).status().await;
                for child in &survivors { let _ = Command::new("/bin/kill").args(["-KILL", "--", child]).status().await; }
            }
            let head = g(&repo, &["rev-parse", "HEAD"]).await;
            if !clean || repo.join("research/incoming.md").exists() {
                let debug = std::env::temp_dir().join(format!("bunsen-r2-failure-{}", short_id()));
                crate::exec::copy_dir(&repo, &debug).unwrap();
                println!(
                    "R2 FAILED FIXTURE {mode}: {} cancellation={:?}",
                    debug.display(),
                    std::fs::read_to_string(repo.join("research/.loop/sync.json"))
                );
                println!("rk stderr: {:?}", std::fs::read_to_string(repo.join("research/.loop/test.stderr")));
                println!("rk stdout: {:?}", std::fs::read_to_string(repo.join("research/.loop/test.stdout")));
            }
            assert!(gone, "{mode}: git {pid} survived outer timeout/cancel");
            assert!(clean, "{mode}: merge state survived");
            assert_eq!(head, before, "{mode}");
            assert!(!repo.join("research/incoming.md").exists(), "half merge worktree left: {mode}");
            assert_eq!(
                std::fs::read_to_string(repo.join("research/existing.md")).unwrap(),
                "original tracked content\n",
                "half tracked modification left: {mode}"
            );
            assert_eq!(
                std::fs::read_to_string(repo.join("research/deleted.md")).unwrap(),
                "must be restored\n",
                "half tracked deletion left: {mode}"
            );
            assert_eq!(std::fs::read_to_string(repo.join("README")).unwrap(), "user dirty work must survive\n");
        }
    })
    .await
    .expect("real rk timeout/cancel test exceeded 240s");
}

#[tokio::test]
async fn decisions_skip_real_summary_template_and_mixed_placeholders() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let f = Fixture::new();
        let hub = f.hub().await;
        let repo = f.seed(&hub).await;
        let template =
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/research/templates/research/SUMMARY.md"))
                .unwrap();
        write(&repo, "research/SUMMARY.md", &template);
        commit(&repo, "原样模板", false).await;
        g(&repo, &["push", "-q", "origin", "HEAD"]).await;
        let p = f.project(&hub).await;
        assert_eq!(f.core.project_view(&p.id, false).await.unwrap().decisions, None);
        for (text, expected) in [
            ("## 需要你决定\n- 无\n", None),
            ("## 需要你决定\n批准预算；证据 #7\n", Some("批准预算；证据 #7")),
            ("## 需要你决定\n- <模板>\n批准预算；证据 #7\n1. <另一占位>\n* <占位>\n+ <占位>\n", Some("批准预算；证据 #7")),
        ] {
            write(&repo, "research/SUMMARY.md", text);
            commit(&repo, "决定", false).await;
            g(&repo, &["push", "-q", "origin", "HEAD"]).await;
            assert_eq!(f.core.project_view(&p.id, true).await.unwrap().decisions.as_deref(), expected);
        }
    })
    .await
    .expect("G21 real view exceeded 30s");
}

#[tokio::test]
async fn integration_git_summary_reaches_all_project_diagnostics() {
    if let Ok(root) = std::env::var("BUNSEN_R2_CHILD") {
        let root = PathBuf::from(root);
        let core = Core::open_at(Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        let reason = std::env::var("I1_REASON").unwrap();
        let hub = std::env::var("I1_HUB").unwrap();
        let check = |text: &str| {
            assert!(text.contains(&reason), "{text}");
            assert!(!text.contains("access rights") && !text.contains("repository exists") && !text.contains("I1_FAKE_TOKEN"), "{text}");
        };
        let err = core.add_project(NewProject { name: "must fail".into(), hub, ..Default::default() }).await.unwrap_err();
        assert_eq!(err.code.http_status(), 502);
        check(&err.message);
        let p = core.projects().unwrap().pop().unwrap();
        let view = core.project_view(&p.id, true).await.unwrap();
        check(view.project.fetch_error.as_ref().unwrap());
        check(&view.warnings[0]);
        let stored = core.store.projects().unwrap();
        check(stored[0].fetch_error.as_ref().unwrap());
        assert!(!std::fs::read_to_string(core.paths().data.join("projects.json")).unwrap().contains("I1_FAKE_TOKEN"));
        let address = HubAddress { url: "ssh://fixture.invalid/repo".into(), home_relative: false, ssh: None };
        let script = setup_script(&p, root.join("deploy").to_str().unwrap(), &address);
        let mut cmd = Command::new("bash");
        cmd.args(["-c", &script]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let out = crate::exec::run_command(cmd, vec![], Duration::from_secs(5), false, "").await.unwrap();
        let error = setup_result(Ok(out)).unwrap_err();
        assert_eq!(error.code, Code::HostUnreachable);
        check(&error.message);
        let sync = core.sync_project(&p.id).await.unwrap();
        assert!(!sync.members[0].ok);
        check(&sync.members[0].detail);
        return;
    }
    tokio::time::timeout(Duration::from_secs(120),async {
        for (hub,raw,reason) in [
            ("ssh://fixture.invalid/repo","Host key verification failed.\nfatal: Could not read from remote repository.","Host key verification failed"),
            ("https://USER:I1_FAKE_TOKEN@host/repo","remote: Invalid username or token.\nfatal: unable to access 'https://USER:I1_FAKE_TOKEN@host/repo': The requested URL returned error: 401","401"),
            ("/missing-i1-local-path","fatal: '/missing-i1-local-path' does not appear to be a git repository\nfatal: Could not read from remote repository.","does not appear to be a git repository"),
        ] {
            let f=Fixture::new();let good=f.hub().await;f.seed(&good).await;let p=f.project(&good).await;
            let raw=format!("{raw}\n\nPlease make sure you have the correct access rights\nand the repository exists.\n");
            write(&f.root,"git.stderr",&raw);
            let stub=f.dir("stub");write(&stub,"research/tools/rk.py",&format!("import json,sys\nif '--help' in sys.argv:sys.exit(0)\nprint(json.dumps({{'ok':False,'error':{}}}))\nsys.exit(1)\n",serde_json::to_string(&raw).unwrap()));
            f.member(&p,"fixture1",&stub,None,false,"local");f.dir("deploy");let bin=f.dir("bin");
            write(&bin,"git",&format!("#!/bin/sh\ncase \"$1\" in fetch|ls-remote|clone) cat {} >&2;exit 128;; esac\nexec /usr/bin/git \"$@\"\n",quote(f.root.join("git.stderr").to_str().unwrap())));
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(bin.join("git"),std::fs::Permissions::from_mode(0o755)).unwrap();
            let path=format!("{}:{}",bin.display(),std::env::var("PATH").unwrap());
            assert_child(&r2_process("projects::tests::integration_git_summary_reaches_all_project_diagnostics",&f.root,&[("PATH",&path),("I1_REASON",reason),("I1_HUB",hub)]).await);
        }
    }).await.expect("G22 diagnostics matrix exceeded 120s");
}

#[tokio::test]
async fn integration_git_summary_with_real_ssh_and_missing_path() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new();
        let repo = f.dir("repo");
        g(&repo, &["init", "--bare", "-q"]).await;
        write(&f.root, "fake-ssh", "#!/bin/sh\necho 'Host key verification failed.' >&2\nexit 255\n");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(f.root.join("fake-ssh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let ssh = quote(f.root.join("fake-ssh").to_str().unwrap());
        let error = git_ok(&repo, &["ls-remote", "--", "ssh://fixture.invalid/repo"], Some(&ssh)).await.unwrap_err();
        assert!(error.message.contains("Host key verification failed"), "{}", error.message);
        assert!(!error.message.contains("repository exists"));
        let error = git_ok(&repo, &["ls-remote", "--", f.root.join("missing").to_str().unwrap()], None).await.unwrap_err();
        assert!(error.message.contains("does not appear to be a git repository"), "{}", error.message);
    })
    .await
    .expect("real git error summary exceeded 15s");
}

#[tokio::test]
async fn integration_g14_warning_deduplicates_paths_across_branches() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let f = Fixture::new();
        let hub = f.hub().await;
        let repo = f.seed(&hub).await;
        write(&repo, "research/state/large.md", &"x".repeat(MAX_BLOB + 1));
        commit(&repo, "oversize", false).await;
        g(&repo, &["push", "-q", "origin", "HEAD", "HEAD:refs/heads/sync/mac"]).await;
        let p = f.project(&hub).await;
        let view = f.core.project_view(&p.id, false).await.unwrap();
        assert_eq!(view.warnings.last().map(String::as_str), Some("汇合点里有 1 个文件过大或过多，没有读入视图"));
    })
    .await
    .expect("deduplicated warning exceeded 20s");
}

#[tokio::test]
async fn integration_setup_identity_prefix_all_rk_branches() {
    tokio::time::timeout(Duration::from_secs(20), async {
        for rk in [None, Some("import sys\nsys.exit(2)\n"), Some("print('{\"ok\":true,\"machine\":\"test\"}')\n")] {
            let f = Fixture::new();
            let hub = f.hub().await;
            let repo = f.seed(&hub).await;
            let p = f.project(&hub).await;
            if let Some(text) = rk {
                write(&repo, "research/tools/rk.py", text);
            }
            g(&repo, &["config", "--local", "user.email", ""]).await;
            let (_, detail) = f.core.setup_project(&p, &f.core.server("local").unwrap(), repo.to_str().unwrap()).await.unwrap();
            assert!(detail.starts_with("已设置仓库级 git 提交身份；"), "{detail}");
            assert_eq!(detail.matches("已设置仓库级 git 提交身份；").count(), 1);
            assert!(g(&repo, &["config", "--local", "user.email"]).await.trim().ends_with(".invalid"));
        }
    })
    .await
    .expect("identity prefix matrix exceeded 20s");
}

#[tokio::test]
async fn integration_real_rk_line_new_template_fields_are_empty() {
    tokio::time::timeout(Duration::from_secs(25), async {
        let f = Fixture::new();
        let hub = f.hub().await;
        let repo = f.seed(&hub).await;
        let plugin = embedded_rk().ancestors().nth(4).unwrap().to_path_buf();
        crate::exec::copy_dir(&plugin.join("templates/research"), &repo.join("research")).unwrap();
        g(&repo, &["config", "--local", "user.name", "fixture"]).await;
        g(&repo, &["config", "--local", "user.email", "fixture@example.invalid"]).await;
        g(&repo, &["config", "--local", "commit.gpgSign", "false"]).await;
        g(&repo, &["config", "--local", "core.hooksPath", "/dev/null"]).await;
        let out = tokio::time::timeout(
            Duration::from_secs(15),
            Command::new("python3")
                .arg("-B")
                .arg(repo.join("research/tools/rk.py"))
                .args(["line", "new", "fresh", "--question", "真实问题"])
                .current_dir(&repo)
                .env("RK_MACHINE_NAME", "mac")
                .env("RK_MACHINE_ID", "i1-test")
                .env("RK_NO_AUTOSYNC", "1")
                .env("RK_COLLAB", "")
                .env("RESEARCH_PLUGIN_CONFIG", f.root.join("config"))
                .env("RESEARCH_HOME", repo.join("research"))
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let state = std::fs::read_to_string(repo.join("research/state/fresh.md")).unwrap();
        assert!(state.contains("<调研 | 发散"));
        assert!(state.contains("1. <…>"));
        commit(&repo, "生成的研究线", false).await;
        g(&repo, &["push", "-q", "origin", "HEAD"]).await;
        let p = f.project(&hub).await;
        let view = f.core.project_view(&p.id, false).await.unwrap();
        let line = view.lines.iter().find(|l| l.line == "fresh").unwrap();
        assert_eq!(line.stage, None);
        assert_eq!(line.waiting, None);
        assert!(line.next.is_empty());
        let filled = state
            .replace("<调研 | 发散 | 派工 | 运行中 | 审核 | 受阻 | 收尾>", "运行中")
            .replace("<无 | 运行 ID（等待器已在后台）| 子代理 | 用户的决定>", "运行 r1")
            .replace("1. <…>", "1. <…>\n2. 验证真实结果\n3. <占位>\n4. 汇报真实证据\n5. 下一批\n6. 不取");
        let line = parse_line("fresh", "research/demo", &filled);
        assert_eq!(line.stage.as_deref(), Some("运行中"));
        assert_eq!(line.waiting.as_deref(), Some("运行 r1"));
        assert_eq!(line.next, vec!["2. 验证真实结果", "4. 汇报真实证据", "5. 下一批"]);
    })
    .await
    .expect("real rk line new template exceeded 25s");
}

#[tokio::test]
async fn integration_delete_project_removes_fetch_record_but_keeps_lock() {
    tokio::time::timeout(Duration::from_secs(15), async {
        let f = Fixture::new();
        let hub = f.hub().await;
        f.seed(&hub).await;
        let p = f.project(&hub).await;
        f.core.project_view(&p.id, true).await.unwrap();
        let mirror = f.core.mirror_path(&p.id);
        let fetch = mirror.with_extension("fetch.json");
        let lock = mirror.with_extension("lock");
        assert!(mirror.exists() && fetch.exists() && lock.exists());
        f.core.delete_project(&p.id).await.unwrap();
        assert!(!mirror.exists());
        assert!(!fetch.exists());
        assert!(lock.exists());
        assert!(f.core.projects().unwrap().is_empty());
    })
    .await
    .expect("delete fetch record exceeded 15s");
}

#[tokio::test]
async fn r5_skip_path_threshold_automatically_spills_without_rewriting() {
    let mut skipped = SkippedPaths::limits(3, 1000);
    for n in 0..7 {
        skipped.insert(&format!("path-{n}")).await.unwrap();
        assert!(skipped.pending.len() <= 3 && skipped.bytes <= 1000);
        assert_eq!(skipped.read, 0, "insert must not read any older run");
        assert!(skipped.written <= n + 1, "insert must only write its new run");
        if n >= 2 {
            assert!(!skipped.runs.is_empty(), "path threshold did not automatically spill");
        }
    }
    let dir = skipped.dir.clone().unwrap();
    assert_eq!(skipped.finish().await.unwrap(), 7);
    assert!(!dir.exists());
}

#[tokio::test]
async fn r5_skip_byte_threshold_automatically_spills_with_bounded_memory() {
    let mut skipped = SkippedPaths::limits(1000, 5);
    for (n, p) in ["a", "bb", "cc", "dddd", "eeee"].iter().enumerate() {
        skipped.insert(p).await.unwrap();
        assert!(skipped.pending.len() < 1000 && skipped.bytes <= 5);
        if n >= 2 {
            assert!(!skipped.runs.is_empty(), "byte threshold did not automatically spill");
        }
        assert_eq!(skipped.read, 0);
    }
    let dir = skipped.dir.clone().unwrap();
    assert_eq!(skipped.finish().await.unwrap(), 5);
    assert!(!dir.exists());
    let mut single = SkippedPaths::limits(2, 2);
    single.insert("longer than cache").await.unwrap();
    assert_eq!(single.bytes, 0);
    assert!(single.pending.is_empty());
    assert_eq!(single.finish().await.unwrap(), 1);
}

#[tokio::test]
async fn r5_skip_k_way_merge_deduplicates_many_runs_with_linear_level_io() {
    let mut skipped = SkippedPaths::limits(1, 1000);
    for n in 0..130 {
        skipped.insert(&format!("branch-shared/{:03}", n % 67)).await.unwrap();
    }
    assert_eq!(skipped.runs.len(), 130);
    assert_eq!(skipped.read, 0);
    assert_eq!(skipped.written, 130);
    let dir = skipped.dir.clone().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }
    assert_eq!(skipped.finish_count().unwrap(), 67);
    assert!(skipped.read <= 130 * 3 && skipped.written <= 130 * 3);
    drop(skipped);
    assert!(!dir.exists());
}

#[tokio::test]
async fn r5_skip_sorted_runs_handle_git_directory_order_names() {
    let mut skipped = SkippedPaths::limits(2, 1000);
    for p in ["a0", "a/b", "a.b", "a-b", "a/b", "a.b"] {
        skipped.insert(p).await.unwrap();
    }
    assert_eq!(skipped.finish().await.unwrap(), 4); // 每段自己排序，不依赖 ls-tree 的遍历顺序。
}

#[tokio::test]
async fn r5_skip_error_and_midway_drop_remove_private_directory() {
    let mut skipped = SkippedPaths::limits(1, 100);
    skipped.insert("first").await.unwrap();
    let dir = skipped.dir.clone().unwrap();
    std::fs::remove_file(&skipped.runs[0]).unwrap();
    assert!(skipped.finish().await.is_err());
    assert!(!dir.exists());
    let mut skipped = SkippedPaths::limits(1, 100);
    skipped.insert("first").await.unwrap();
    let dir = skipped.dir.clone().unwrap();
    drop(skipped);
    assert!(!dir.exists());
}

#[tokio::test]
async fn r5_skip_cancel_during_spill_eventually_cleans_directory() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (entered, receive) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let mut skipped = SkippedPaths::limits(1, 100);
        skipped.io_gate = Some((entered, wait));
        let task = tokio::spawn(async move { skipped.insert("first").await });
        let dir = tokio::time::timeout(Duration::from_secs(3), receive).await.unwrap().unwrap();
        task.abort();
        let _ = task.await;
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while dir.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    })
    .await
    .expect("spill cancellation cleanup exceeded 10s");
}

#[test]
fn r5_hook_warning_survives_member_and_setup_details() {
    let result = json!({"ok":true,"machine":"mac","hook_warning":"仓库的 git hook 没有在时限内正常结束（已结束它）"});
    assert!(hook_detail("完成", Some(&result)).contains("hook"));
    let (_, detail) = setup_result(Ok(crate::ssh::RemoteOutput {
        code: 0,
        stdout: format!("{result}\n").into_bytes(),
        stderr: String::new(),
        elapsed: Duration::ZERO,
    }))
    .unwrap();
    assert!(detail.starts_with("已接入研究项目；") && detail.contains("hook"));
}

#[tokio::test]
async fn quality_mirror_reviews_closures_lines_citations_and_old_rk() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    write(&repo, "research/tools/rk.py", "RK_VERSION = '0.6.0'\n");
    for name in ["SUMMARY.md", "OVERVIEW.md", "LEDGER.md", "results/TEMPLATE.md", "strategy/TEMPLATE.md"] {
        write(&repo, &format!("research/{name}"), &crate::plugins::research_template(name).unwrap());
    }
    write(&repo, "research/results/blank.md", &crate::plugins::research_template("results/TEMPLATE.md").unwrap());
    write(&repo, "research/strategy/blank.md", "# 标题\n<!-- 注释 -->\n- <占位>\n1. <占位>\n| 列一 | 列二 |\n|---|---|\n| <占位> | |\n");
    write(&repo, "research/strategy/real.md", "# 策略\n这是实际内容\n");
    write(&repo, "research/LEDGER.md", "# 账本\n已写结论\n");
    for (id, line) in [("r1", "alpha"), ("r2", "beta"), ("r3", "alpha")] {
        write(&repo, &format!("research/results/{id}.md"), &format!("# {id}\n精确数值 42\n"));
        write(&repo, &format!("research/runs/{id}/meta.json"), &json!({"run_id":id,"line":line,"exit_code":0}).to_string());
        write(&repo, &format!("research/state/{line}.md"), "---\ntoken: 1\nholder: mac\n---\n**阶段**：验证\n");
    }
    let r1_hash = g(&repo, &["hash-object", "research/results/r1.md"]).await.trim().to_string();
    let ledger_hash = g(&repo, &["hash-object", "research/LEDGER.md"]).await.trim().to_string();
    let record = json!({"kind":"review","review_id":"review-1","files":[
        {"path":"results/r1.md","sha256":"deliberately-not-used","git_blob":r1_hash},
        {"path":"LEDGER.md","sha256":"ignored","git_blob":ledger_hash}],"items":[
        {"id":"1","file":"results/r1.md","verdict":"fail"},
        {"id":"2","file":"results/r1.md","verdict":"fail"},
        {"id":"3","file":"results/r1.md","verdict":"fail"},
        {"id":"4","file":"results/r2.md","verdict":"fail"},
        {"id":"5","file":"SUMMARY.md","verdict":"fail"}],"recorded_at":"2026-11-13T00:00:00Z"});
    write(&repo, "research/audits/review-1.json", &record.to_string());
    write(&repo, "research/audits/resolve-1.json", r#"{"kind":"resolve","item":"review-1#1"}"#);
    write(
        &repo,
        "research/audits/review-2.json",
        r#"{"kind":"review","files":[],"items":[{"id":"1","file":"results/r1.md","verdict":"pass","resolves":"review-1#2"},{"id":"2","verdict":"warn","resolves":"review-1#3"}]}"#,
    );
    // 旧推断审计、plan 记录、嵌套文件不能参与 fail/核对计数。
    write(&repo, "research/audits/old.json", &record.to_string());
    write(&repo, "research/audits/review-wrong-kind.json", r#"{"kind":"plan","items":[{"id":"1","file":"SUMMARY.md","verdict":"fail"}]}"#);
    write(&repo, "research/results/nested/ignored.md", "不能计入\n");
    let source = |id: &str, status: &str, retracted: bool, at: &str| {
        json!({"id":id,"status":status,"retracted":retracted,"checked_at":at}).to_string()
    };
    for (file, id, status, retracted, at) in [
        ("found@a", "doi:found", "not_found", false, "2026-11-13T10:00:00+08:00"),
        ("found@b", "doi:found", "ok", false, "2026-11-13T03:00:00Z"),
        ("missing@a", "doi:missing", "not_found", false, "2026-11-13T03:00:00.1Z"),
        ("missing@b", "doi:missing", "not_found", false, "2026-11-13T03:00:00.2Z"),
        ("retracted@a", "doi:retracted", "ok", true, "2026-11-13T03:00:00Z"),
        ("retracted@b", "doi:retracted", "ok", true, "2026-11-13T03:00:00Z"),
    ] {
        write(&repo, &format!("research/sources/{file}.json"), &source(id, status, retracted, at));
    }
    write(&repo, "research/sources/too-big.json", &" ".repeat(MAX_BLOB + 1));
    write(&repo, "research/audits/review-too-big.json", &" ".repeat(MAX_BLOB + 1));
    write(&repo, "research/results/too-big.md", &"x".repeat(MAX_BLOB + 1));
    commit(&repo, "质量记录", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    g(&repo, &["checkout", "-q", "-b", "sync/new"]).await;
    write(&repo, "research/results/pending.md", "还未并入\n");
    write(&repo, "research/audits/resolve-unmerged.json", r#"{"kind":"resolve","item":"review-1#3"}"#);
    write(&repo, "research/runs/r3/meta.json", r#"{"run_id":"r3","line":"beta","exit_code":0}"#);
    write(&repo, "research/sources/missing@c.json", &source("doi:missing", "ok", false, "2026-11-14T00:00:00Z"));
    commit(&repo, "未并入的记录", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    let p = f.project(&hub).await;
    let v = f.core.project_view(&p.id, false).await.unwrap();
    assert_eq!(v.trust, Some(ProjectTrust { open_fails: 3, unreviewed: 3, unresolved_citations: 1, retracted_citations: 1 }));
    let alpha = v.lines.iter().find(|l| l.line == "alpha").unwrap();
    let beta = v.lines.iter().find(|l| l.line == "beta").unwrap();
    assert_eq!((alpha.open_fails, alpha.unreviewed), (Some(1), Some(1)));
    assert_eq!((beta.open_fails, beta.unreviewed), (Some(1), Some(1)));
    assert_eq!(
        v.warnings,
        [
            "研究分支上有 3 个未关闭的核对问题、3 个结论文件还没核过",
            "研究分支上有 1 条引用解析不到",
            "研究分支上有 1 篇被引文献已撤稿",
            "汇合点里有 3 个文件过大或过多，没有读入视图"
        ]
    );
    g(&repo, &["checkout", "-q", "research/demo"]).await;
    write(&repo, "research/results/r1.md", "# r1\n精确数值 43\n");
    commit(&repo, "核过之后又改了数字", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    let v = f.core.project_view(&p.id, true).await.unwrap();
    assert_eq!(v.trust.unwrap().unreviewed, 4, "必须比较当前 blob，不能只看曾经有 review");
    write(&repo, "research/tools/rk.py", "RK_VERSION = '0.5.9'\n");
    commit(&repo, "旧版工具", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    let v = f.core.project_view(&p.id, true).await.unwrap();
    assert!(v.trust.is_none());
    assert!(!v.lines.is_empty(), "旧版 rk 仍须保留研究线，避免 all() 空真");
    assert!(v.lines.iter().all(|l| l.open_fails.is_none() && l.unreviewed.is_none()));
    let value = serde_json::to_value(&v.lines).unwrap();
    assert!(value.as_array().unwrap().iter().all(|l|l["open_fails"].is_null() && l["unreviewed"].is_null()));
}

#[tokio::test]
async fn quality_mirror_new_paths_share_g14_total_and_ignore_sync_json() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    write(&repo, "research/tools/rk.py", "RK_VERSION = '0.6.0'\n");
    // JSON 每份合法且恰好 1 MiB，各自 blob 不同，合计超过 64 MiB。
    for i in 0..65 {
        let prefix = format!("{{\"kind\":\"review\",\"n\":{i},\"padding\":\"");
        let text = format!("{prefix}{}\"}}", "x".repeat(MAX_BLOB - prefix.len() - 2));
        write(&repo, &format!("research/audits/review-{i:02}.json"), &text);
    }
    write(&repo, "research/sources/unused/nested.json", &"x".repeat(MAX_BLOB + 1));
    write(&repo, "research/audits/plan-unused.json", &"x".repeat(MAX_BLOB + 1));
    commit(&repo, "超过总读取预算", false).await;
    let head = g(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
    let branches = vec![Branch { name: "research/demo".into(), head: head.clone(), committed: None, subject: String::new() }];
    let (_, blobs, skipped) = read_objects(&repo, "research", &branches).await.unwrap();
    assert!(blobs.values().map(Vec::len).sum::<usize>() <= MAX_TOTAL);
    assert_eq!(skipped, 2, "第 64、65 份记录超出总预算；无关路径不计");
    let sync = vec![Branch { name: "sync/test".into(), head, committed: None, subject: String::new() }];
    let (_, blobs, skipped) = read_objects(&repo, "research", &sync).await.unwrap();
    assert!(blobs.is_empty());
    assert_eq!(skipped, 0, "未并入机器的质量 JSON 不应抢占预算");
}

#[tokio::test]
async fn quality_mirror_skips_reviewed_bodies_and_old_version_records() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    write(&repo, "research/tools/rk.py", "RK_VERSION = '0.6.0'\n");
    write(&repo, "research/results/reviewed.md", &"x".repeat(MAX_BLOB + 1));
    let hash = g(&repo, &["hash-object", "research/results/reviewed.md"]).await.trim().to_string();
    write(
        &repo,
        "research/audits/review-1.json",
        &json!({"kind":"review","files":[{"path":"results/reviewed.md","git_blob":hash}],"items":[]}).to_string(),
    );
    commit(&repo, "核过的正文不需要读取", false).await;
    let mut branches = vec![Branch {
        name: "research/demo".into(),
        head: g(&repo, &["rev-parse", "HEAD"]).await.trim().to_string(),
        committed: None,
        subject: String::new(),
    }];
    let (trees, blobs, skipped) = read_objects(&repo, "research", &branches).await.unwrap();
    assert_eq!(skipped, 0);
    assert!(!blobs.contains_key(&hash));
    assert_eq!(quality::derive(&project(), &trees, &blobs, &mut []), Some(ProjectTrust::default()));
    write(&repo, "research/tools/rk.py", "RK_VERSION = '0.5.9'\n");
    write(&repo, "research/sources/unused.json", &"x".repeat(MAX_BLOB + 1));
    // metrics 只需存在性，不能因与未读取的 review 同 blob 而偷偷消耗正文预算。
    write(&repo, "research/runs/r1/metrics.json", &std::fs::read_to_string(repo.join("research/audits/review-1.json")).unwrap());
    commit(&repo, "旧版不读取新记录", false).await;
    branches[0].head = g(&repo, &["rev-parse", "HEAD"]).await.trim().to_string();
    let (trees, blobs, skipped) = read_objects(&repo, "research", &branches).await.unwrap();
    assert_eq!(skipped, 0);
    assert_eq!(blobs.len(), 1);
    assert!(quality::derive(&project(), &trees, &blobs, &mut []).is_none());
}

#[tokio::test]
async fn quality_mirror_q15_deleted_result_keeps_line_fail() {
    let f = Fixture::new();
    let hub = f.hub().await;
    let repo = f.seed(&hub).await;
    write(&repo, "research/tools/rk.py", "RK_VERSION = '0.6.0'\n");
    write(&repo, "research/results/r1.md", "结果 42\n");
    write(
        &repo,
        "research/runs/r1/meta.json",
        r#"{"run_id":"r1","line":"alpha","exit_code":0}"#,
    );
    write(
        &repo,
        "research/state/alpha.md",
        "---\ntoken: 1\nholder: mac\n---\n**阶段**：验证\n",
    );
    write(
        &repo,
        "research/audits/review-q15.json",
        r#"{"kind":"review","files":[],"items":[{"id":"1","file":"results/r1.md","verdict":"fail"}]}"#,
    );
    commit(&repo, "Q15 未关闭问题", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    let p = f.project(&hub).await;
    let before = f.core.project_view(&p.id, false).await.unwrap();
    assert_eq!(before.trust.as_ref().unwrap().open_fails, 1);
    assert_eq!(
        before
            .lines
            .iter()
            .find(|l| l.line == "alpha")
            .unwrap()
            .open_fails,
        Some(1)
    );
    std::fs::remove_file(repo.join("research/results/r1.md")).unwrap();
    commit(&repo, "删除结果页不能关闭问题", false).await;
    g(&repo, &["push", "-q", "origin", "HEAD"]).await;
    let after = f.core.project_view(&p.id, true).await.unwrap();
    assert_eq!(
        after.trust.as_ref().unwrap().open_fails,
        1,
        "删除页不得丢失项目 fail"
    );
    assert_eq!(
        after
            .lines
            .iter()
            .find(|l| l.line == "alpha")
            .unwrap()
            .open_fails,
        Some(1),
        "删除页不得丢失研究线 fail"
    );
}
