//! 服务器探测：一次 ssh 取完 `Probe` 的全部字段。输出是 `键\t值` 行。

use crate::model::{Agent, AgentPresence, DiskInfo, Gpu, GpuApp, Probe, TmuxInfo, ToolsInfo};
use crate::shell::quote;
use crate::util::now_rfc3339;
use std::collections::{BTreeMap, HashMap};

/// 带 5 秒超时执行（没有 `timeout` 命令时用后台看门狗）。
const TIMEOUT_FN: &str = r#"__op_t() {
  if command -v timeout >/dev/null 2>&1; then timeout 5 "$@"; return $?; fi
  "$@" & __op_p=$!
  ( sleep 5; kill -9 $__op_p ) >/dev/null 2>&1 &
  __op_w=$!
  wait $__op_p; __op_r=$?
  kill $__op_w >/dev/null 2>&1
  return $__op_r
}
"#;

const GPU_PART: &str = r#"if command -v nvidia-smi >/dev/null 2>&1; then
  __op_t nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,uuid,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | sed 's/^/gpu	/'
  __op_apps=$(__op_t nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory,process_name --format=csv,noheader,nounits 2>/dev/null)
  if [ -n "$__op_apps" ]; then
    printf '%s\n' "$__op_apps" | sed 's/^/gpuapp	/'
    { ps -eo pid=,user= 2>/dev/null || ps -o pid,user 2>/dev/null; } | sed 's/^/psuser	/'
  fi
fi
"#;

pub fn gpu_script() -> String {
    format!("{TIMEOUT_FN}{GPU_PART}")
}

pub fn probe_script(agents: &[Agent]) -> String {
    let mut s = String::from(TIMEOUT_FN);
    s.push_str(
        r#"P() { printf '%s\t%s\n' "$1" "$(printf '%s' "$2" | tr '\t\r\n' '   ' | cut -c1-300)"; }
P hostname "$(hostname 2>/dev/null || uname -n)"
P user "$(id -un 2>/dev/null || whoami)"
P home "$HOME"
__op_os=""
if [ -r /etc/os-release ]; then __op_os=$(. /etc/os-release >/dev/null 2>&1; printf '%s' "${PRETTY_NAME:-$NAME $VERSION}"); fi
if [ -z "$__op_os" ] && command -v sw_vers >/dev/null 2>&1; then __op_os="macOS $(sw_vers -productVersion)"; fi
[ -n "$__op_os" ] || __op_os=$(uname -s)
P os "$__op_os"
P kernel "$(uname -r)"
P arch "$(uname -m)"
__op_sh=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)
P shell "${__op_sh:-$SHELL}"
P cpus "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 0)"
if [ -r /proc/meminfo ]; then
  P mem_total_kb "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
  __op_av=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
  [ -n "$__op_av" ] || __op_av=$(awk '/^MemFree:/{print $2}' /proc/meminfo)
  P mem_avail_kb "$__op_av"
elif command -v sysctl >/dev/null 2>&1; then
  P mem_total_kb "$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 ))"
fi
P disk_home "$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{print $2" "$4}')"
if command -v tmux >/dev/null 2>&1; then P tmux "$(tmux -V 2>&1 | head -n 1)"; fi
if command -v git >/dev/null 2>&1; then P git "$(git --version 2>/dev/null | head -n 1)"; fi
if command -v python3 >/dev/null 2>&1; then P python "$(python3 --version 2>&1 | head -n 1)"
elif command -v python >/dev/null 2>&1; then P python "$(python --version 2>&1 | head -n 1)"; fi
if command -v node >/dev/null 2>&1; then P node "$(node --version 2>/dev/null | head -n 1)"; fi
if command -v rsync >/dev/null 2>&1; then P rsync 1; fi
A() {
  __op_path=$(command -v "$2" 2>/dev/null) || { printf 'agent\t%s\t\t\n' "$1"; return; }
  __op_v=$(__op_t "$2" --version </dev/null 2>&1 | head -n 1 | tr '\t\r' '  ' | cut -c1-200)
  printf 'agent\t%s\t%s\t%s\n' "$1" "$__op_path" "$__op_v"
}
"#,
    );
    for a in agents {
        s.push_str(&format!("A {} {}\n", quote(&a.id), quote(&a.detect)));
    }
    s.push_str(GPU_PART);
    s
}

fn gb(kb: f64) -> f64 {
    (kb / 1024.0 / 1024.0 * 10.0).round() / 10.0
}

/// `git version 2.45.2` → `2.45.2`；`v20.1.0` → `20.1.0`；`tmux 3.6` → `3.6`；取不到就原样返回。
pub fn version_token(s: &str) -> String {
    for tok in s.split_whitespace() {
        let t = tok.strip_prefix('v').unwrap_or(tok);
        if t.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return t.trim_end_matches([',', ';']).to_string();
        }
    }
    s.trim().to_string()
}

fn num<T: std::str::FromStr + Default>(s: &str) -> T {
    s.trim().parse().unwrap_or_default()
}

/// 解析 nvidia-smi 的输出：`gpu\t…`（每张卡）、`gpuapp\t…`（计算进程）、`psuser\t…`（pid → 用户）。
pub fn parse_gpus(out: &str) -> Vec<Gpu> {
    let mut users: HashMap<u32, String> = HashMap::new();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("psuser\t") {
            let mut it = rest.split_whitespace();
            if let (Some(pid), Some(user)) = (it.next().and_then(|p| p.parse().ok()), it.next()) {
                users.insert(pid, user.to_string());
            }
        }
    }
    let mut apps: HashMap<String, Vec<GpuApp>> = HashMap::new();
    for line in out.lines() {
        let Some(rest) = line.strip_prefix("gpuapp\t") else { continue };
        let f: Vec<&str> = rest.splitn(4, ',').map(str::trim).collect();
        if f.len() < 4 {
            continue;
        }
        let Ok(pid) = f[1].parse::<u32>() else { continue };
        apps.entry(f[0].to_string()).or_default().push(GpuApp {
            pid,
            user: users.get(&pid).cloned().unwrap_or_default(),
            mem_mb: num(f[2]),
            name: f[3].to_string(),
        });
    }
    let mut gpus = Vec::new();
    for line in out.lines() {
        let Some(rest) = line.strip_prefix("gpu\t") else { continue };
        let f: Vec<&str> = rest.split(',').map(str::trim).collect();
        if f.len() < 5 || f[0].parse::<u32>().is_err() {
            continue;
        }
        let uuid = f.get(5).copied().unwrap_or("");
        let my_apps = apps.remove(uuid).unwrap_or_default();
        gpus.push(Gpu {
            index: num(f[0]),
            name: f[1].to_string(),
            mem_used_mb: num(f[2]),
            mem_total_mb: num(f[3]),
            util_pct: num(f[4]),
            procs: my_apps.len() as u32,
            temp_c: f.get(6).and_then(|t| t.parse::<f64>().ok()).map(|t| t.round() as i32),
            apps: my_apps,
        });
    }
    gpus
}

pub fn parse_probe(out: &str, agents: &[Agent]) -> Probe {
    let mut kv: HashMap<&str, &str> = HashMap::new();
    let mut found: BTreeMap<String, AgentPresence> = BTreeMap::new();
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("agent\t") {
            let f: Vec<&str> = rest.splitn(3, '\t').collect();
            let id = f[0].to_string();
            let path = f.get(1).map(|p| p.trim()).filter(|p| !p.is_empty()).map(str::to_string);
            let version = f.get(2).map(|v| v.trim()).filter(|v| !v.is_empty()).map(str::to_string);
            found.insert(id, AgentPresence { present: path.is_some(), version: if path.is_some() { version } else { None }, path });
            continue;
        }
        if line.starts_with("gpu\t") || line.starts_with("gpuapp\t") || line.starts_with("psuser\t") {
            continue;
        }
        if let Some((k, v)) = line.split_once('\t') {
            kv.entry(k).or_insert(v);
        }
    }
    let get = |k: &str| kv.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
    let opt = |k: &str| kv.get(k).map(|v| v.trim()).filter(|v| !v.is_empty()).map(str::to_string);
    let mem_total = get("mem_total_kb").parse::<f64>().unwrap_or(0.0);
    let mem_avail = get("mem_avail_kb").parse::<f64>().unwrap_or(0.0);
    let disk_home = opt("disk_home").and_then(|d| {
        let mut it = d.split_whitespace();
        let total: f64 = it.next()?.parse().ok()?;
        let free: f64 = it.next()?.parse().ok()?;
        Some(DiskInfo { total_gb: gb(total), free_gb: gb(free) })
    });
    let tmux_line = opt("tmux");
    let mut agents_map = BTreeMap::new();
    for a in agents {
        let p = found.remove(&a.id).unwrap_or(AgentPresence { present: false, version: None, path: None });
        agents_map.insert(a.id.clone(), p);
    }
    Probe {
        checked_at: now_rfc3339(),
        hostname: get("hostname"),
        user: get("user"),
        home: get("home"),
        os: get("os"),
        kernel: get("kernel"),
        arch: get("arch"),
        shell: get("shell"),
        cpus: get("cpus").parse().unwrap_or(0),
        mem_total_gb: gb(mem_total),
        mem_free_gb: gb(mem_avail),
        disk_home,
        tmux: TmuxInfo { present: tmux_line.is_some(), version: tmux_line.as_deref().map(version_token) },
        tools: ToolsInfo {
            git: opt("git").as_deref().map(version_token),
            python: opt("python").as_deref().map(version_token),
            node: opt("node").as_deref().map(version_token),
            rsync: opt("rsync").is_some(),
        },
        agents: agents_map,
        gpus: parse_gpus(out),
    }
}

/// 由探测结果生成的主机笔记初稿（`~/.bunsen/HOST.md`）。
pub fn host_notes_draft(p: &Probe, agents: &[Agent]) -> String {
    let mut s = String::new();
    let host = if p.hostname.is_empty() { "这台服务器" } else { &p.hostname };
    s.push_str(&format!("# {host} 主机笔记\n\n"));
    s.push_str(&format!(
        "> 由 Bunsen 在 {} 根据探测结果生成的初稿，之后不会自动覆盖。人和 Agent 都可以改：只记验证过的事实——环境怎么配、数据在哪、踩过的坑。\n\n",
        p.checked_at.get(..10).unwrap_or(&p.checked_at)
    ));
    s.push_str("## 概况\n\n");
    s.push_str(&format!("- 主机名：{}（用户 {}，家目录 {}）\n", p.hostname, p.user, p.home));
    s.push_str(&format!("- 系统：{}；内核 {}；{}；登录 shell {}\n", p.os, p.kernel, p.arch, p.shell));
    s.push_str(&format!("- CPU：{} 核；内存 {} GB（探测时可用 {} GB）\n", p.cpus, p.mem_total_gb, p.mem_free_gb));
    if let Some(d) = &p.disk_home {
        s.push_str(&format!("- 家目录所在磁盘：共 {} GB，探测时可用 {} GB\n", d.total_gb, d.free_gb));
    }
    if p.gpus.is_empty() {
        s.push_str("- 显卡：没有（未找到 nvidia-smi）\n");
    } else {
        s.push_str(&format!("- 显卡：{} 张\n", p.gpus.len()));
        for g in &p.gpus {
            s.push_str(&format!("  - GPU {}：{}，显存 {} MB\n", g.index, g.name, g.mem_total_mb));
        }
    }
    s.push_str(&format!(
        "- tmux：{}\n",
        if p.tmux.present { p.tmux.version.clone().unwrap_or_else(|| "有".into()) } else { "没有".into() }
    ));
    let opt = |v: &Option<String>| v.clone().unwrap_or_else(|| "没有".into());
    s.push_str(&format!(
        "- 工具：git {}；python {}；node {}；rsync {}\n",
        opt(&p.tools.git),
        opt(&p.tools.python),
        opt(&p.tools.node),
        if p.tools.rsync { "有" } else { "没有" }
    ));
    let installed: Vec<String> = agents
        .iter()
        .filter(|a| a.id != "shell")
        .filter_map(|a| {
            let st = p.agents.get(&a.id)?;
            st.present.then(|| match &st.version {
                Some(v) => format!("{}（{}）", a.name, v),
                None => a.name.clone(),
            })
        })
        .collect();
    s.push_str(&format!("- 已装的代理：{}\n", if installed.is_empty() { "没有".to_string() } else { installed.join("、") }));
    s.push_str("\n## 环境\n\n（conda / 模块 / 代理怎么配）\n\n## 数据与模型位置\n\n## 踩过的坑\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_probe_output() {
        let agents = crate::agents::builtins();
        let out = "hostname\tgpu1\nuser\tdev\nhome\t/home/dev\nos\tUbuntu 22.04.4 LTS\nkernel\t5.15.0\narch\tx86_64\nshell\t/bin/bash\ncpus\t64\n\
mem_total_kb\t263856128\nmem_avail_kb\t131928064\ndisk_home\t1000000000 250000000\ntmux\ttmux 3.2a\ngit\tgit version 2.34.1\npython\tPython 3.10.12\nnode\tv20.11.1\nrsync\t1\n\
agent\tclaude-code\t/home/dev/.local/bin/claude\t1.0.30 (Claude Code)\nagent\tcodex\t\t\nagent\tshell\t/bin/bash\tGNU bash, version 5.1.16\n\
gpu\t0, NVIDIA A100-SXM4-80GB, 1234, 81920, 37, GPU-aaa, 61\ngpu\t1, NVIDIA A100-SXM4-80GB, 0, 81920, [N/A], GPU-bbb, [N/A]\n\
gpuapp\tGPU-aaa, 4242, 1000, python train.py\ngpuapp\tGPU-aaa, 4343, 234, /usr/bin/python3\npsuser\t  PID USER\npsuser\t 4242 dev\npsuser\t    1 root\n";
        let p = parse_probe(out, agents);
        assert_eq!(p.hostname, "gpu1");
        assert_eq!(p.os, "Ubuntu 22.04.4 LTS");
        assert_eq!(p.cpus, 64);
        assert_eq!(p.mem_total_gb, 251.6);
        assert_eq!(p.mem_free_gb, 125.8);
        let d = p.disk_home.unwrap();
        assert_eq!(d.total_gb, 953.7);
        assert_eq!(p.tmux, TmuxInfo { present: true, version: Some("3.2a".into()) });
        assert_eq!(p.tools.git.as_deref(), Some("2.34.1"));
        assert_eq!(p.tools.python.as_deref(), Some("3.10.12"));
        assert_eq!(p.tools.node.as_deref(), Some("20.11.1"));
        assert!(p.tools.rsync);
        assert_eq!(p.agents.len(), agents.len());
        let c = &p.agents["claude-code"];
        assert!(c.present);
        assert_eq!(c.version.as_deref(), Some("1.0.30 (Claude Code)"));
        assert!(!p.agents["codex"].present);
        assert!(!p.agents["gemini"].present);
        assert_eq!(p.gpus.len(), 2);
        assert_eq!(p.gpus[0].procs, 2);
        assert_eq!(p.gpus[0].temp_c, Some(61));
        assert_eq!(p.gpus[0].apps[0], GpuApp { pid: 4242, user: "dev".into(), mem_mb: 1000, name: "python train.py".into() });
        assert_eq!(p.gpus[0].apps[1].user, "");
        assert_eq!(p.gpus[1].util_pct, 0);
        assert_eq!(p.gpus[1].procs, 0);
        assert_eq!(p.gpus[1].temp_c, None);
        assert!(p.gpus[1].apps.is_empty());
        assert!(parse_gpus("gpu\tNo devices were found\n").is_empty());
    }

    #[test]
    fn notes_draft() {
        let agents = crate::agents::builtins();
        let out = "hostname\tgpu1\nuser\tdev\nhome\t/home/dev\nos\tUbuntu 22.04\ncpus\t8\ntmux\ttmux 3.2a\n\
agent\tcodex\t/usr/bin/codex\tcodex-cli 0.1\ngpu\t0, NVIDIA A100, 1, 81920, 0, GPU-a, 40\n";
        let p = parse_probe(out, agents);
        let d = host_notes_draft(&p, agents);
        assert!(d.starts_with("# gpu1 主机笔记\n"));
        assert!(d.contains("Ubuntu 22.04"));
        assert!(d.contains("GPU 0：NVIDIA A100"));
        assert!(d.contains("tmux：3.2a"));
        assert!(d.contains("Codex（codex-cli 0.1）"));
        assert!(d.contains("## 踩过的坑"));
    }

    #[test]
    fn no_gpu_no_tmux() {
        let p = parse_probe("hostname\th\nos\tAlpine Linux v3.20\n", &[]);
        assert!(p.gpus.is_empty());
        assert!(!p.tmux.present);
        assert_eq!(p.disk_home, None);
        assert!(!p.tools.rsync);
    }

    #[test]
    fn versions() {
        assert_eq!(version_token("tmux next-3.6"), "tmux next-3.6");
        assert_eq!(version_token("tmux 3.6"), "3.6");
        assert_eq!(version_token("v18.0.0"), "18.0.0");
    }

    #[test]
    fn probe_script_is_valid_bash() {
        let s = crate::shell::wrap_script(&probe_script(crate::agents::builtins()));
        let out = std::process::Command::new("bash").arg("-n").arg("-c").arg(&s).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }
}
