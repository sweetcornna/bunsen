//! 纯本机协议夹具：ssh/tmux/agent 都是假程序，只写自己的系统临时目录。
#![allow(dead_code)]
use bunsen_core::{
    model::*,
    ssh::Ssh,
    store::{Paths, Store},
    Core,
};
use serde_json::json;
use std::{ffi::OsString, path::PathBuf, sync::Arc};
pub struct Fixture {
    pub root: PathBuf,
    pub core: Arc<Core>,
}
impl Fixture {
    pub fn new(hidden: bool) -> Self {
        let root = std::env::temp_dir().join(format!("bunsen-r5-entry-{}", bunsen_core::util::short_id()));
        let paths = Paths { data: root.join("data"), cm_dir: root.join("cm") };
        let core = Arc::new(Core { ssh: Ssh::new(paths.ssh_config()), store: Store::open(paths).unwrap() });
        core.store.update_servers(|v|{
   for (id,alias,source) in [("remote1","worker",ServerSource::Manual),("remote2","local",ServerSource::Manual),("remote3","remote1",ServerSource::Manual)] {
    v.push(serde_json::from_value(json!({"id":id,"alias":alias,"host":"fixture.invalid","user":"test","port":22,"key":null,"proxy_jump":null,"proxy_command":null,"source":source,"note":"","default_workdir":root.join("work"),"status":"unknown","status_detail":null,"last_checked":null,"probe":null})).unwrap());
   }
   if hidden {let mut local=v[0].clone();local.id="local".into();local.alias="desktop".into();local.source=ServerSource::Local;v.push(local);}
   Ok(())
  }).unwrap();
        core.put_agent("r5agent", serde_json::from_value(json!({"name":"R5 fixture","detect":"r5-agent","launch":"r5-agent"})).unwrap())
            .unwrap();
        let bin = root.join("home/.local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(root.join("home/.bunsen")).unwrap();
        std::fs::write(root.join("home/.bunsen/HOST.md"), "fixture notes\n").unwrap();
        write_exec(&bin.join("ssh"),"#!/bin/sh\nfor arg do [ \"$arg\" != '-O' ] || exit 0; last=$arg; done\ncase \"$last\" in op-*) exit 0;; esac\nexec /bin/bash -c \"$last\"\n");
        write_exec(&bin.join("r5-agent"), "#!/bin/sh\nexit 0\n");
        write_exec(
            &bin.join("tmux"),
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -L|-f) shift 2;; -u) shift;; *) break;; esac; done
command=${1:-};shift || true
state="$HOME/.bunsen/fake-tmux";mkdir -p "$state"
case "$command" in
 -V) echo 'tmux 3.5';;
 has-session) while [ "$#" -gt 0 ]; do case "$1" in -t) name=$2;break;; esac;shift;done;name=${name#=};name=${name%:};test -f "$state/$name";;
 new-session) while [ "$#" -gt 0 ]; do case "$1" in -s) name=$2;break;; esac;shift;done;: > "$state/$name";;
 list-panes) echo '0||r5-agent';;
 capture-pane) echo fixture-running;;
 *) exit 0;;
esac
"#,
        );
        core.regen_ssh_config().unwrap();
        Self { root, core }
    }
    pub fn env(&self) -> Vec<(OsString, OsString)> {
        vec![
            ("HOME".into(), self.root.join("home").into_os_string()),
            ("PATH".into(), format!("{}:{}", self.root.join("home/.local/bin").display(), std::env::var("PATH").unwrap()).into()),
            ("BUNSEN_NO_LOCAL".into(), "1".into()),
            ("BUNSEN_DATA_DIR".into(), self.root.join("data").into_os_string()),
            ("BUNSEN_CM_DIR".into(), self.root.join("cm").into_os_string()),
            ("BUNSEN_R5_ENTRY_CHILD".into(), self.root.clone().into_os_string()),
        ]
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn write_exec(path: &std::path::Path, text: &str) {
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}
