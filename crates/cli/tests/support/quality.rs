use bunsen_core::{model::SessionRecord, store::Paths, Core};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

pub struct Fixture {
    pub root: PathBuf,
    pub core: Arc<Core>,
}
impl Fixture {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!("bunsen-quality-entry-{}", bunsen_core::util::short_id()));
        let work = root.join("work");
        std::fs::create_dir_all(work.join("research/tools")).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../core/tests/fixtures/quality");
        for entry in std::fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            std::fs::copy(
                entry.path(),
                if entry.file_name() == "rk.py" {
                    work.join("research/tools/rk.py")
                } else {
                    work.join("research").join(entry.file_name())
                },
            )
            .unwrap();
        }
        std::fs::write(work.join("research/PROJECT.md"), "fixture").unwrap();
        std::fs::write(work.join("research/PLAN.md"), "# 计划\n具体内容\n").unwrap();
        std::fs::create_dir_all(work.join("research/runs/r1")).unwrap();
        std::fs::write(work.join("research/runs/r1/meta.json"), r#"{"run_id":"r1","inputs":[]}"#).unwrap();
        for name in ["env", "outputs"] {
            std::fs::copy(work.join(format!("research/{name}.json")), work.join(format!("research/runs/r1/{name}.json"))).unwrap();
        }
        std::fs::write(work.join("test.png"), "abc").unwrap();
        let core = Core::open_at(Paths { data: root.join("data"), cm_dir: root.join("cm") }).unwrap();
        let record: SessionRecord = serde_json::from_value(json!({
            "id":"test01", "title":"quality", "server_id":"local", "server_alias":"本机", "agent_id":"codex", "workdir":work,
            "tmux":"unused", "created_at":"2026-11-13T00:00:00Z", "last_active_at":null, "state":"stopped", "exit_status":null,
            "attached":0,"pinned":false,"archived":false,"plugin":null,"plugins":[],"yolo":false,
            "preview":null,"attach_cmd":"","origin":"local","project_id":null,"machine":null,"extra_args":null
        }))
        .unwrap();
        core.store
            .update_sessions(|v| {
                v.push(record);
                Ok(())
            })
            .unwrap();
        Self { root, core }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
