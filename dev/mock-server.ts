// 界面演示用的假后端：不连任何服务器，数据都是编的。
// 用法：先 cd ui && pnpm run build，再 bun dev/mock-server.ts  →  http://127.0.0.1:7979/#token=dev
// 环境变量：PORT 换端口；BUNSEN_NO_LOCAL=1 时服务器列表里没有本机、按 id 访问本机回 404，本机上的会话保留，按“服务器已删除”处理【G15】。
// 研究项目（契约 v1.3）：lt7k2q 有三台机器（atlas 并入会冲突、titan 久未同步）、四条研究线、二十多条运行；
// 它的“立即同步”里还有一个仓库里 rk.py 是旧版（没有 sync）的对话【G18】。
// pf3m9a 的汇合点在离线的 titan 上，取不到；nb8w4c 的汇合点从来没取成功过（fetched_at 为 null）【G7′】。
// 汇合点里带 unreachable 或 multi 可以试新建项目的两种失败。
// 汇合点写成 <别名>:<路径> 时只有 bareRepos 里的路径存在（atlas:~/hubs/longtail.git、local:~/hubs/scratch.git 等），
// 其余要勾“新建裸仓库”（create）。新建的项目汇合点是空的：部署到一个已有对话用过的目录（算作已有仓库）才接得进去。
// 部署接入项目时，工作目录里带 notempty、hubclash、authfail、timeout 可以试 project 一步的另几种失败【G6】。
// lt7k2q 的视图里有一条“文件过大或过多，没有读入”的警告【G14】，N 按去重后的路径计【G23】；它的研究线里有一条
// rk line new 刚建、字段都是模板占位的 focal，SUMMARY 和研究线里的模板占位按 G21、G21′ 跳过（见 viewOf）。
// q2sk8d 的两个成员会话都在已删除的服务器 gpu-old 上：“立即同步”跳过它们，members 为 []（契约 3.2）；
// BUNSEN_NO_LOCAL=1 时 lt7k2q 的本机会话也被跳过。atlas 上没有全局 git 提交身份：部署接入项目时第一次进某个仓库
// 会设仓库级身份，project 一步的 detail 前面带“已设置仓库级 git 提交身份；”。
// git 的报错按 G22 摘要：去掉固定提示，保留最后最多 3 行，用“；”连接。
// 部署请求带 accept: application/x-ndjson 时逐行流式返回，不带时返回 {session, steps} 或 422 {error, steps}（docs/API.md 部署一节）。
// 只为了在没有 SSH 目标时看界面；真正的实现在 crates/。
import { join, normalize } from "node:path";
// 项目名称、研究分支的规则和前端表单共用一份（照 crates/core/src/projects.rs 写的）。
import { branchProblem, defaultBranch, HOME_ERROR, homeProblem, HUB_ERROR, hubProblem, NAME_ERROR, nameIssue, normalizeHome, trimName } from "../ui/src/lib/projectRules";

const PORT = Number(process.env.PORT ?? 7979);
const DIST = join(import.meta.dir, "..", "ui", "dist");
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, code: string, message: string, hint: string | null = null) => json({ error: { code, message, hint } }, status);

const agents = [
  { id: "claude-code", name: "Claude Code", vendor: "Anthropic", description: "终端里的编程与研究代理", detect: "claude", launch: "claude", launch_with_prompt: "claude {prompt}", resume: "claude --continue", yolo_flag: "--dangerously-skip-permissions", plugin_dir_flag: "--plugin-dir {dir}", install: [{ label: "官方脚本", cmd: "curl -fsSL https://claude.ai/install.sh | bash" }, { label: "npm", cmd: "npm install -g @anthropic-ai/claude-code" }], auth_hint: "在服务器上运行 claude，按提示用浏览器登录；或设置 ANTHROPIC_API_KEY。", docs_url: "https://code.claude.com/docs", builtin: true },
  { id: "codex", name: "Codex CLI", vendor: "OpenAI", description: "OpenAI 的终端代理", detect: "codex", launch: "codex", launch_with_prompt: "codex {prompt}", resume: "codex resume --last", yolo_flag: "--dangerously-bypass-approvals-and-sandbox", plugin_dir_flag: null, install: [{ label: "npm", cmd: "npm install -g @openai/codex" }], auth_hint: "运行 codex login --device-auth，在任意浏览器里输入验证码。", docs_url: "https://developers.openai.com/codex/cli", builtin: true },
  { id: "gemini", name: "Gemini CLI", vendor: "Google", description: "Google 的终端代理", detect: "gemini", launch: "gemini", launch_with_prompt: "gemini -i {prompt}", resume: "gemini --resume latest", yolo_flag: "--yolo", plugin_dir_flag: null, install: [{ label: "npm", cmd: "npm install -g @google/gemini-cli" }], auth_hint: "设置 GEMINI_API_KEY，或运行 gemini 后按提示登录。", docs_url: "https://github.com/google-gemini/gemini-cli", builtin: true },
  { id: "opencode", name: "OpenCode", vendor: "SST", description: "开源终端代理，可接多家模型", detect: "opencode", launch: "opencode", launch_with_prompt: "opencode --prompt {prompt}", resume: "opencode --continue", yolo_flag: null, plugin_dir_flag: null, install: [{ label: "官方脚本", cmd: "curl -fsSL https://opencode.ai/install | bash" }], auth_hint: "运行 opencode auth login。", docs_url: "https://opencode.ai/docs", builtin: true },
];

const gpus = [
  { index: 0, name: "NVIDIA GeForce RTX 3090", mem_used_mb: 21840, mem_total_mb: 24576, util_pct: 97, procs: 1, temp_c: 71, apps: [{ pid: 41233, user: "dev", mem_mb: 21800, name: "python" }] },
  { index: 1, name: "NVIDIA GeForce RTX 3090", mem_used_mb: 310, mem_total_mb: 24576, util_pct: 0, procs: 0, temp_c: 38, apps: [] },
  { index: 2, name: "NVIDIA GeForce RTX 3090", mem_used_mb: 12030, mem_total_mb: 24576, util_pct: 64, procs: 2, temp_c: 66, apps: [{ pid: 5120, user: "wang", mem_mb: 8000, name: "python" }, { pid: 5177, user: "wang", mem_mb: 4000, name: "python" }] },
  { index: 3, name: "NVIDIA GeForce RTX 3090", mem_used_mb: 4, mem_total_mb: 24576, util_pct: 0, procs: 0, temp_c: 35, apps: [] },
];

// 本机（契约 v1.3 第 1 节）：总在最前面，id 固定为 local；BUNSEN_NO_LOCAL=1 时不在服务器列表里（当作不存在）。
const local = {
  id: "local", alias: "local", host: "localhost", user: "me", port: 22, key: null, proxy_jump: null, proxy_command: null, source: "local", note: "本机：会话跑在这台电脑的 tmux 里，不经 ssh", default_workdir: "~",
  status: "online", status_detail: null, last_checked: ago(1),
  probe: { checked_at: ago(1), hostname: "my-mac", user: "me", home: "/Users/me", os: "macOS 15.5", kernel: "Darwin 24.5.0", arch: "arm64", shell: "/bin/zsh", cpus: 12, mem_total_gb: 36, mem_free_gb: 14.2, disk_home: { total_gb: 994, free_gb: 412 }, tmux: { present: true, version: "3.5a" }, tools: { git: "2.50.1", python: "3.12.8", node: "22.11.0", rsync: true }, agents: { "claude-code": { present: true, version: "2.1.4", path: "/Users/me/.local/bin/claude" }, codex: { present: true, version: "0.58.0", path: "/opt/homebrew/bin/codex" }, gemini: { present: false, version: null, path: null }, opencode: { present: false, version: null, path: null } }, gpus: [] },
};
const atlas = {
  id: "s3k9x2", alias: "atlas", host: "atlas.lab.example", user: "dev", port: 22, key: "id_ed25519", proxy_jump: null, proxy_command: null, source: "upload", note: "四卡，跑筛选实验", default_workdir: "~/work",
  status: "online", status_detail: null, last_checked: ago(2),
  probe: { checked_at: ago(2), hostname: "atlas", user: "dev", home: "/home/dev", os: "Ubuntu 22.04.4 LTS", kernel: "5.15.0-119", arch: "x86_64", shell: "/bin/bash", cpus: 64, mem_total_gb: 251.6, mem_free_gb: 180.2, disk_home: { total_gb: 3600, free_gb: 1240 }, tmux: { present: true, version: "3.2a" }, tools: { git: "2.34.1", python: "3.10.12", node: "22.11.0", rsync: true }, agents: { "claude-code": { present: true, version: "2.1.4", path: "/home/dev/.local/bin/claude" }, codex: { present: true, version: "0.58.0", path: "/home/dev/.npm/bin/codex" }, gemini: { present: false, version: null, path: null }, opencode: { present: false, version: null, path: null } }, gpus },
};
const titan = { id: "a81bqz", alias: "titan", host: "titan.lab.example", user: "dev", port: 22, key: "id_ed25519", proxy_jump: null, proxy_command: null, source: "upload", note: "", default_workdir: "~", status: "offline", status_detail: "连接超时：titan.lab.example:22 没有响应", last_checked: ago(2), probe: null };
const cpuBox = { id: "c0ffee", alias: "cpu-box", host: "cpu.example.org", user: "me", port: 22, key: null, proxy_jump: "atlas", proxy_command: null, source: "manual", note: "", default_workdir: "~", status: "unknown", status_detail: null, last_checked: null, probe: null };
const servers: any[] = [...(process.env.BUNSEN_NO_LOCAL === "1" ? [] : [local]), atlas, titan, cpuBox];
// 已经删除的服务器：不在列表里，上面的会话还在（按“服务器已删除”处理，状态 unknown）。
const gpuOld = { id: "e5gone", alias: "gpu-old", host: "gpu-old.lab.example", user: "dev", port: 22, source: "manual" };

const keys = [
  { name: "id_ed25519", kind: "ED25519", fingerprint: "SHA256:u3kE0q7WmZp1Xc9aB2dQyR5tLhN8vG4sJ6fK0oPiMnA", has_pub: true, used_by: ["atlas", "titan"] },
  { name: "id_rsa_old", kind: "RSA 4096", fingerprint: "SHA256:9aXb7Qm2Lk5Zp0Wc3Vn8Hd1Rt6Yg4Uj2Ei7Of5Sa0Dc", has_pub: false, used_by: [] },
];

const mk = (id: string, title: string, server: any, agent_id: string, workdir: string, state: string, min: number, extra: any = {}) => ({
  id, title, server_id: server.id, server_alias: server.alias, agent_id, workdir, tmux: `op-${id}`, created_at: ago(min + 300), last_active_at: ago(min), state, exit_status: state === "exited" ? 0 : null, attached: 0, pinned: false, archived: false, plugin: null, yolo: false,
  preview: "● 已读完 train.py 和 configs/base.yaml\n● 基线 3 个种子跑完，准确率 76.4 ± 0.3\n❯ ",
  attach_cmd: server.source === "local" ? `tmux -L bunsen attach-session -t '=op-${id}'` : `ssh -t -p ${server.port} ${server.user}@${server.host} tmux -L bunsen attach -t op-${id}`,
  origin: "local", project_id: null, machine: null, ...extra,
});
// 接入研究项目 lt7k2q 的会话分在本机、atlas、titan 三台机器上；另有一个接入了已删除项目的会话。
const LT = { project_id: "lt7k2q" };
let sessions: any[] = [
  mk("k7f2qa", "标签平滑对长尾分类的影响", atlas, "claude-code", "~/work/longtail", "running", 1, { plugin: "research", yolo: true, pinned: true, attached: 1, ...LT, machine: "atlas" }),
  mk("lc3n8p", "长尾：本机整理图表和 SUMMARY", local, "claude-code", "~/work/longtail", "running", 6, { plugin: "research", ...LT, machine: "mymac" }),
  mk("m2x8cd", "复现 MAE 在 ImageNet-100 上的结果", atlas, "codex", "~/work/mae-repro", "running", 14),
  mk("w8e2yk", "长尾：读相关论文", local, "codex", "~/papers/longtail", "exited", 300, { ...LT }),
  // 这个仓库里的 rk.py 是没有 sync 的旧版：部署时没拿到机器代号，“立即同步”时报旧版【G18】（见 OLD_RK）。
  mk("v6h3om", "长尾：旧仓库里的补充实验", atlas, "claude-code", "~/work/longtail-old", "running", 45, { plugin: "research", ...LT }),
  mk("q9d4ht", "排查 loss 在 12k 步后变 NaN", atlas, "claude-code", "~/work/nan-hunt", "exited", 190, { preview: "● 定位到混合精度下 log(0)\n● 已加 eps 并验证 20k 步无 NaN\n[进程已退出，状态 0]" }),
  mk("t4r7vb", "长尾：重加权基线", titan, "claude-code", "~/longtail", "unreachable", 1900, { plugin: "research", preview: null, ...LT, machine: "titan" }),
  mk("z1p6vw", "数据清洗脚本", titan, "gemini", "~/data", "unreachable", 1500, { preview: null }),
  mk("d0x1zz", "折叠：早期的消融草稿", atlas, "claude-code", "~/work/fold-old", "stopped", 5200, { preview: null, project_id: "gone01", machine: "atlas" }),
  mk("b5n3re", "整理上周的实验表格", atlas, "claude-code", "~/work/tables", "stopped", 4300, { preview: null, origin: "discovered" }),
  // 项目 q2sk8d 的成员都在已删除的 gpu-old 上：“立即同步”全部跳过。
  mk("g3o1dx", "消融：去掉位置编码", gpuOld, "claude-code", "~/work/ablate", "stopped", 13000, { plugin: "research", preview: null, project_id: "q2sk8d", machine: "gpuold" }),
  mk("g3o2dy", "消融：换数据增强", gpuOld, "codex", "~/work/ablate-aug", "exited", 12900, { preview: null, project_id: "q2sk8d", machine: "gpuold" }),
  // BUNSEN_NO_LOCAL=1 时本机上的会话照样保留，按“服务器已删除”处理：状态 unknown（同 crates/core 的 sessions）【G15】。
].map((s) => (servers.some((x) => x.id === s.server_id) ? s : { ...s, state: "unknown", exit_status: null }));

let settings = { theme: "dark", default_server: null, default_agent: null, research_plugin_path: "/Users/me/project/research_plugin", status_interval_secs: 30 };

const STATE_MD = `# STATE\n\n**课题**：标签平滑对长尾分类尾部类别的影响\n**阶段**：确认实验（第 2 轮）\n\n## 正在做\n\n- [x] 基线 3 个种子（76.4 ± 0.3）\n- [x] 筛选：ε ∈ {0.05, 0.1, 0.2}，单种子\n- [ ] 确认：ε = 0.1，5 个种子 —— 跑到第 3 个\n\n## 下一步\n\n等确认实验跑完后写 \`results/R-004.md\`，交给审计员核对数字出处。\n\n> 等待期间只做三件事：填满空闲显卡、准备下一批、清记录债。\n`;
const SUMMARY_MD = `# 摘要\n\n| 设置 | 头部 | 中部 | 尾部 | 总体 |\n|---|---|---|---|---|\n| 基线 | 91.2 | 78.5 | 41.3 | 76.4 |\n| ε = 0.1（筛选） | 90.8 | 79.1 | 44.9 | 77.2 |\n\n筛选结果提示尾部有 +3.6 的提升，**尚未确认**。数字出处：\`r-0412:acc_tail\`。\n`;
const IDEAS_MD = `# 想法池\n\n| 编号 | 想法（机制一句话） | 可证伪的预测 | 最便宜的判决性检验 | 簇 | 类型 | 新颖性核查 | 状态 | 备注 |\n|---|---|---|---|---|---|---|---|---|\n| I1 | 标签平滑削弱头部类别的过度自信，给尾部留出间隔 | ε=0.1 时尾部准确率 +2 以上，头部下降不超过 1 | 单种子 30 轮 | 正则 | 主线 | 已查，最近的是 logit adjustment | 筛选通过 | |\n| I2 | 只对头部类别做平滑，按类频率设 ε | 比统一 ε 的尾部再 +1 | 复用 I1 的配置改一行 | 正则 | 探索位 | 未查 | 候选 | |\n| I3 | 与 logit adjustment 叠加 | 两者增益可加 | 2×2 小网格 | 重加权 | 主线 | 已查 | 已预登记 | |\n| I4 | 换 focal loss | 尾部提升但总体下降 | 单种子 | 损失 | 探索位 | 已查 | 否决（已有大量负面结果） | |\n`;
const LEDGER_MD = `# 结论账本（只追加）\n\n| 编号 | 状态 | 结论（一句话，精确到条件） | 证据 | 性质 | 日期 |\n|---|---|---|---|---|---|\n| C1 | 已证实 | ImageNet-LT、ResNet-50、90 轮下基线总体准确率 76.4 ± 0.3（3 个种子） | run:20261112-r03-smooth01; results/20261112-r03-smooth01.md | 确认 | 2026-11-11 |\n| C2 | 未决 | ε = 0.1 使尾部准确率提高约 3.6（单种子） | run:20261112-r03-smooth01 | 探索 | 2026-11-12 |\n| C3 | 已否定 | ε = 0.2 在 24G 显存下可用默认批量训练 | run:20261112-r02-smooth02 | 探索 | 2026-11-12 |\n| C4 | 已证实 | logit adjustment 在同设置下尾部 +5.1 | doi:10.48550/arXiv.2007.07314 | 文献 | 2026-11-10 |\n`;
const DIFF = `diff --git a/train.py b/train.py\nindex 3f1c2ab..9d04e77 100644\n--- a/train.py\n+++ b/train.py\n@@ -41,7 +41,9 @@ def build_loss(cfg):\n     if cfg.loss == "ce":\n-        return nn.CrossEntropyLoss()\n+        return nn.CrossEntropyLoss(label_smoothing=cfg.smoothing)\n+    if cfg.loss == "focal":\n+        return FocalLoss(gamma=cfg.gamma)\n     raise ValueError(cfg.loss)\n`;

// 部署步骤（契约 v1.3 第 2 节：workdir 与 plugin 之间多一步 project）。本机不经 ssh，第一步叫“检查本机”。
const stepsFor = (srv: any, agentId: string, workdir: string): [string, string, string | null, number][] => {
  const isLocal = srv.source === "local";
  const home = srv.probe?.home ?? `/home/${srv.user}`;
  return [
    ["connect", isLocal ? "检查本机" : "连接服务器", isLocal ? `本机（${srv.user}）` : `${srv.user}@${srv.host}`, isLocal ? 60 : 420],
    ["tmux", "检查 tmux", `tmux ${srv.probe?.tmux.version ?? "3.2a"}`, 90],
    ["agent", "查找 Agent", srv.probe?.agents[agentId]?.path ?? `${home}/.local/bin/${agentId}`, 120],
    ["workdir", "准备工作目录", String(workdir).replace(/^~/, home), 80],
    ["project", "接入研究项目", null, 900],
    ["plugin", "同步插件", isLocal ? "research · 8 个技能，复制到 ~/.bunsen/plugins/research" : "research · 8 个技能", isLocal ? 150 : 600],
    ["start", "启动对话", null, 180],
    ["verify", "确认运行", "进程在运行", 1000],
  ];
};

// ---------- 研究项目（契约 v1.3 第 3、4 节）----------
// 汇合点上的内容是编的：hubs[项目 id] 相当于本机镜像里读出的东西；视图里的成员、机器对应的会话、警告每次按当前会话现算。

// lines、decisions 是汇合点上的原文（含模板占位），出视图时按 G21、G21′ 处理（见 viewOf）。
// skipped：因过大或过多没有读入视图的文件，按分支记；警告里的 N 按去重后的路径计【G14、G23】。
type Hub = { research_head: string | null; machines: any[]; lines: any[]; runs: any[]; decisions: string | null; skipped?: { branch: string; path: string }[] };
const sha = (s: string) => {
  let h = 2166136261;
  let out = "";
  for (let i = 0; out.length < 40; i++) {
    for (const c of `${s}#${i}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
};
const ymd = (min: number) => new Date(now - min * 60_000).toISOString().slice(0, 10).replace(/-/g, "");
// 警告里的取得时间写成 YYYY-MM-DD HH:MM UTC【G7】；从没取成功过时整句换掉，不做字面替换（见 viewOf）【G7′】。
const fmtUtc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const newId = () => Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");

let projects: any[] = [
  { id: "lt7k2q", name: "长尾分类的标签平滑", hub: "git@github.com:me/longtail-research.git", branch: "research/longtail", home: "research", created_at: ago(60 * 24 * 6), fetched_at: ago(0.3), fetch_error: null },
  { id: "pf3m9a", name: "蛋白折叠消融", hub: "titan:~/hubs/fold.git", branch: "research/fold", home: "research", created_at: ago(60 * 24 * 2), fetched_at: ago(60 * 26), fetch_error: "ssh: connect to host titan.lab.example port 22: Operation timed out；fatal: Could not read from remote repository." },
  // 汇合点从来没取成功过（例如数据目录是从别处拷来的，镜像不在，cpu-box 又一直连不上）：警告整句写“还没有成功取得过汇合点”【G7′】。
  { id: "nb8w4c", name: "读书笔记汇总", hub: "cpu-box:~/hubs/notes.git", branch: "research/notes", home: "research", created_at: ago(60 * 24), fetched_at: null, fetch_error: "ssh: connect to host cpu.example.org port 22: Operation timed out；fatal: Could not read from remote repository." },
  // 成员会话都在已删除的服务器上：“立即同步”没有可同步的会话，members 为 []，视图里照样列着两个成员。
  { id: "q2sk8d", name: "旧显卡机上的消融", hub: "git@github.com:me/old-ablation.git", branch: "research/old-ablation", home: "research", created_at: ago(60 * 24 * 30), fetched_at: ago(0.5), fetch_error: null },
];

// 一条运行：机器、编号、简称、种类、线、几分钟前开始、跑了几分钟（null 为未结束）、退出码、说明、是否已进研究分支。
const BRANCH_LT = "research/longtail";
const run = (machine: string | null, n: number, name: string, kind: string, line: string | null, start: number, dur: number | null, exit: number | null, note: string, integrated: boolean) => ({
  run_id: machine ? `${ymd(start)}-${machine}-r${String(n).padStart(2, "0")}-${name}` : `${ymd(start)}-r${String(n).padStart(2, "0")}-${name}`,
  machine, kind, state: exit === null ? "open" : exit === 0 ? "ok" : "failed", exit_code: exit,
  started_at: ago(start), ended_at: dur === null ? null : ago(start - dur), line, note, has_metrics: exit === 0, integrated,
  source: integrated ? BRANCH_LT : `sync/${machine}`,
});
const H = 60;
const hubs: Record<string, Hub> = {
  lt7k2q: {
    research_head: sha("lt-head-1"),
    machines: [
      { code: "atlas", head: sha("atlas"), committed_at: ago(25), subject: "rk sync：atlas 的研究记录", ahead: 3, behind: 2, conflict: true },
      { code: "mymac", head: sha("mymac"), committed_at: ago(8), subject: "图：尾部类别准确率随 ε 的变化", ahead: 1, behind: 1, conflict: false },
      { code: "titan", head: sha("titan"), committed_at: ago(31 * H), subject: "r04 结束：class-balanced 重加权 acc_tail 43.0", ahead: 2, behind: 5, conflict: false },
    ],
    lines: [
      // 阶段写了、“在等什么”还是模板占位：视图里为 null【G21′】。
      { line: "baseline", holder: "mymac", token: 3, stamped: ago(15 * H), stage: "已完成：3 个种子 76.4 ± 0.3", waiting: "<无 | 运行 ID（等待器已在后台）| 子代理 | 用户的决定>", updated: "2026-11-11 21:40", next: ["- 把基线表格并进 SUMMARY", "- 交给审计员核对 C1 的数字出处"], source: BRANCH_LT },
      { line: "logit-adj", holder: null, token: 1, stamped: ago(40 * H), stage: "想法：与标签平滑叠加（I3）", waiting: "等 smoothing 线的确认结论", updated: "2026-11-10 18:02", next: ["1. 写预登记 P-003", "2. 2×2 小网格：ε × τ", "3. <…>"], source: BRANCH_LT }, // 第 3 项是模板占位，跳过【G21′】
      { line: "reweight", holder: "titan", token: 2, stamped: ago(32 * H), stage: "探索：类频率重加权", waiting: "titan 离线，r04、r05 还没拉回", updated: "2026-11-11 04:10", next: ["- titan 恢复后 rk sync", "- 比较 sqrt 与 class-balanced 两种权重"], source: "sync/titan" },
      // rk line new focal 刚建：正文除了“最后更新”都还是模板占位，阶段、在等什么为 null，下一步为空【G21′】。
      // 编号相同时以推进者自己分支上的那份为准，所以并入研究分支以后也还是“取自 sync/mymac”。
      { line: "focal", holder: "mymac", token: 1, stamped: ago(4), stage: "<调研 | 发散 | 派工 | 运行中 | 审核 | 受阻 | 收尾>", waiting: "<无 | 运行 ID（等待器已在后台）| 子代理 | 用户的决定>", updated: `${ago(4).slice(0, 19)}+00:00`, next: ["1. <…>"], source: "sync/mymac" },
      { line: "smoothing", holder: "atlas", token: 5, stamped: ago(20), stage: "确认实验（第 2 轮）", waiting: "seed 3 跑到第 41 轮，约 38 分钟", updated: "2026-11-12 09:55", next: ["- [ ] seed 3、4、5 跑完", "- [ ] 写 results/…-r07.md", "- [ ] 交审计员核对数字出处"], source: "sync/atlas" },
    ],
    runs: [
      run(null, 1, "pilot", "explore", null, 7 * 24 * H, 35, 0, "旧格式的运行 ID（没有机器代号）", true),
      run("mymac", 1, "base-s1", "prereg", "baseline", 4 * 24 * H, 92, 0, "基线 seed=1", true),
      run("mymac", 2, "base-s2", "prereg", "baseline", 4 * 24 * H - 100, 90, 0, "基线 seed=2", true),
      run("mymac", 3, "base-s3", "prereg", "baseline", 4 * 24 * H - 200, 95, 0, "基线 seed=3", true),
      run("mymac", 4, "plot-base", "analysis", "baseline", 3 * 24 * H, 2, 0, "基线的逐类准确率图", true),
      run("mymac", 5, "tables", "analysis", "baseline", 15 * H, 1, 0, "汇总表格", true),
      run("mymac", 6, "fig-tail", "analysis", "smoothing", 40, 3, 0, "尾部类别准确率随 ε 的变化", false),
      run("atlas", 1, "smooth005", "explore", "smoothing", 3 * 24 * H - 30, 38, 0, "筛选 ε=0.05，单种子", true),
      run("atlas", 2, "smooth01", "explore", "smoothing", 3 * 24 * H - 70, 38, 0, "筛选 ε=0.1，单种子", true),
      run("atlas", 3, "smooth02", "explore", "smoothing", 3 * 24 * H - 110, 2, 1, "ε=0.2，显存不足", true),
      run("atlas", 4, "smooth02-bs128", "explore", "smoothing", 2 * 24 * H, 41, 0, "ε=0.2，批量减半重跑", true),
      run("atlas", 5, "smooth01-s1", "prereg", "smoothing", 30 * H, 41, 0, "确认 ε=0.1 seed=1", true),
      run("atlas", 6, "smooth01-s2", "prereg", "smoothing", 20 * H, 41, 0, "确认 ε=0.1 seed=2", true),
      run("atlas", 7, "smooth01-s3", "prereg", "smoothing", 26, null, null, "确认 ε=0.1 seed=3", false),
      run("atlas", 8, "smooth01-s4", "prereg", "smoothing", 24, 6, 137, "seed=4，被 OOM killer 杀掉", false),
      run("atlas", 9, "smooth01-s4b", "prereg", "smoothing", 15, null, null, "seed=4 换到 3 号卡重跑", false),
      run("atlas", 10, "lr-warmup", "explore", "smoothing", 9 * H, 30, 0, "预热 5 轮对尾部的影响", true),
      run("atlas", 11, "lr-warmup10", "explore", "smoothing", 8 * H, 31, 0, "预热 10 轮", true),
      run("titan", 1, "rw-base", "explore", "reweight", 3 * 24 * H - 400, 60, 0, "不加权的对照", true),
      run("titan", 2, "rw-sqrt", "explore", "reweight", 3 * 24 * H - 300, 62, 0, "按类频率平方根加权", true),
      run("titan", 3, "rw-inv", "explore", "reweight", 2 * 24 * H - 300, 4, 2, "按类频率倒数加权：配置文件写错", true),
      run("titan", 4, "rw-cb", "explore", "reweight", 33 * H, 64, 0, "class-balanced 加权", false),
      run("titan", 5, "rw-cb-s2", "explore", "reweight", 32 * H, null, null, "class-balanced seed=2（titan 掉线时还在跑）", false),
      run("mymac", 7, "notebook", "analysis", null, 6 * 24 * H, 12, 0, "探索用的笔记本", true),
      run("atlas", 12, "eval-tta", "explore", "logit-adj", 5 * 24 * H, 20, 0, "测试时增强对尾部的影响", true),
    ],
    // 第一行是 SUMMARY 模板的占位，不算正文【G21】。
    decisions:
      "- <问题；证据；建议；在得到答复前按哪个最稳妥的默认继续。没有就写“无”>\n- **smoothing 线要不要加到 5 个种子？** 现在 3 个种子的差距是 +3.4 ± 0.6；再加两个种子要 atlas 两张卡约 1.5 小时。\n- **titan 离线两天了**：reweight 线的 r04、r05 只在 titan 上。等它恢复，还是在 atlas 上重跑 r04？\n\n![尾部类别准确率随 ε 的变化](https://example.com/longtail/fig-tail.png)",
  },
  q2sk8d: {
    research_head: sha("old-ablation"),
    machines: [{ code: "gpuold", head: sha("old-ablation"), committed_at: ago(9 * 24 * H), subject: "rk sync：gpuold 并入 research/old-ablation", ahead: 0, behind: 0, conflict: null }],
    lines: [{ line: "ablate", holder: "gpuold", token: 4, stamped: ago(9 * 24 * H), stage: "收尾：消融表格已进 SUMMARY", waiting: "<无 | 运行 ID（等待器已在后台）| 子代理 | 用户的决定>", updated: "2026-11-04 17:20", next: ["1. <…>"], source: "research/old-ablation" }],
    runs: [],
    // 只剩模板占位和“无”：视图里为 null【G21】。
    decisions: "- <问题；证据；建议；在得到答复前按哪个最稳妥的默认继续。没有就写“无”>\n- 无",
  },
};
// lt7k2q 有几份 runs/*/metrics.json 超过 1 MiB（逐步记录的曲线），没有读入【G14】；r05 那份在研究分支和 sync/atlas 上都有，
// 只算 1 个，警告里写 3 个【G23】。
{
  const lt = hubs.lt7k2q;
  const metrics = (suffix: string) => `research/runs/${lt.runs.find((r) => r.run_id.endsWith(suffix))?.run_id}/metrics.json`;
  lt.skipped = [
    { branch: BRANCH_LT, path: metrics("atlas-r05-smooth01-s1") },
    { branch: "sync/atlas", path: metrics("atlas-r05-smooth01-s1") },
    { branch: "sync/atlas", path: metrics("atlas-r06-smooth01-s2") },
    { branch: "sync/titan", path: metrics("titan-r04-rw-cb") },
  ];
}
const emptyHub = (): Hub => ({ research_head: null, machines: [], lines: [], runs: [], decisions: null });

/**
 * 汇合点写成 <别名>:<路径> 时它在哪台服务器上、路径是什么；git 地址返回 null（契约 3.2）。
 * 别名按第一个冒号切，含 / 或 @ 的、对不上服务器的都是 git 地址。local 永远指本机（即使有台远程服务器叫 local、
 * 或 BUNSEN_NO_LOCAL=1 没有本机记录）；本机改了别名时新别名也指本机【G3】。
 */
const hubAt = (hub: string): { srv: any; path: string } | null => {
  const i = hub.indexOf(":");
  if (i <= 0 || hub.includes("://")) return null;
  const alias = hub.slice(0, i);
  const path = hub.slice(i + 1);
  if (/[/@]/.test(alias) || !path) return null;
  const srv = alias === "local" ? local : servers.find((s) => s.alias === alias);
  return srv ? { srv, path } : null;
};
// 各台机器上已有的裸仓库（键是 <服务器 id>:<相对 $HOME 的路径>）和它们上面的 research/* 分支。
const bareRepos = new Map<string, string[]>([
  ["a81bqz:hubs/fold.git", ["research/fold"]],
  ["s3k9x2:hubs/longtail.git", ["research/longtail"]],
  ["local:hubs/scratch.git", []],
]);
const repoKey = (srv: any, path: string) => `${srv.id}:${path.replace(/^~(\/|$)/, "").replace(/\/+$/, "")}`;

// 研究分支名、缺省分支、项目名称的规则见 ui/src/lib/projectRules.ts（和前端共用）。
// :id 和部署的 project_id 可以是 id 或名称：先按 id 找，找不到再按名称【G8】。
const findProject = (key: string) => projects.find((p) => p.id === key) ?? projects.find((p) => p.name === key);
const membersOf = (p: any) =>
  sessions
    .filter((s) => s.project_id === p.id && !s.archived)
    .map((s) => ({ session_id: s.id, title: s.title, server_id: s.server_id, server_alias: s.server_alias, workdir: s.workdir, state: s.state, machine: s.machine ?? null }));

// 同一项目的取镜像同一时刻只做一次；并发的请求等它完成后共用结果。
const fetching = new Map<string, Promise<void>>();
function fetchHub(p: any, force: boolean): Promise<void> {
  const fresh = p.fetched_at && Date.now() - Date.parse(p.fetched_at) < 20_000;
  if (!force && fresh && !p.fetch_error) return Promise.resolve();
  const running = fetching.get(p.id);
  if (running) return running;
  const job = (async () => {
    await sleep(force ? 600 : 200);
    const at = hubAt(p.hub)?.srv;
    if (at && at.status !== "online") p.fetch_error = `ssh: connect to host ${at.host} port 22: Operation timed out；fatal: Could not read from remote repository.`; // G22
    else Object.assign(p, { fetched_at: new Date().toISOString(), fetch_error: null });
  })().finally(() => fetching.delete(p.id));
  fetching.set(p.id, job);
  return job;
}

// 模板占位：去掉列表符号（- * + 或“1.”）后整行以 < 开头、以 > 结尾【G21、G21′】（同 crates/core 的 decisions_text）。
const itemText = (line: string) => line.trim().replace(/^(?:[-*+]|\d+\.)\s+/, "").trim();
const placeholder = (line: string) => {
  const c = itemText(line);
  return c.startsWith("<") && c.endsWith(">");
};
/** “需要你决定”一节：跳过模板占位行，剩下的为空或只有“无”时为 null【G21】。 */
function decisionsOf(raw: string | null): string | null {
  if (raw === null) return null;
  const kept = raw.split("\n").filter((l) => !placeholder(l));
  const text = kept.join("\n").trim();
  return !text || kept.every((l) => !itemText(l) || itemText(l) === "无") ? null : text;
}
/** 研究线：阶段、在等什么是模板占位时为 null；下一步跳过占位项后取前 3 项【G21′】。 */
const lineOf = (l: any) => ({
  ...l,
  stage: l.stage && !placeholder(l.stage) ? l.stage : null,
  waiting: l.waiting && !placeholder(l.waiting) ? l.waiting : null,
  next: l.next.filter((n: string) => !placeholder(n)).slice(0, 3),
});

function viewOf(p: any) {
  const h = hubs[p.id] ?? emptyHub();
  const members = membersOf(p);
  const machines = h.machines
    .map((m) => {
      const mine = members.filter((x) => x.machine === m.code);
      return { ...m, sessions: mine.map((x) => x.session_id), server_alias: mine[0]?.server_alias ?? null };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  const warnings: string[] = [];
  if (p.fetch_error) warnings.push(p.fetched_at ? `取不到汇合点：${p.fetch_error}，显示的是 ${fmtUtc(p.fetched_at)} 的内容` : `取不到汇合点：${p.fetch_error}，还没有成功取得过汇合点`);
  if (!h.research_head) warnings.push(`汇合点上还没有 ${p.branch}：在一台机器上部署接入本项目，或在仓库里执行 rk sync --setup`);
  for (const m of machines) if (m.conflict === true) warnings.push(`${m.code} 的记录并入 ${p.branch} 会冲突，要在那台机器上解决（rk sync 会列出冲突的文件）`);
  for (const m of machines) {
    const hours = m.committed_at ? Math.floor((Date.now() - Date.parse(m.committed_at)) / 3_600_000) : 0;
    if (m.behind > 0 && hours >= 24) warnings.push(`${m.code} 已经 ${hours} 小时没有同步`);
  }
  for (const s of members) if (!s.machine) warnings.push(`会话 ${s.title} 还没有机器代号：仓库里有研究目录后在那里执行 rk sync --setup`);
  const skipped = new Set((h.skipped ?? []).map((x) => x.path)).size; // 同一路径在几个分支上都没读只算 1 个【G23】
  if (skipped) warnings.push(`汇合点里有 ${skipped} 个文件过大或过多，没有读入视图`); // 末尾【G14】
  const t = (r: any) => (r.started_at ? Date.parse(r.started_at) : -Infinity);
  return {
    project: p,
    research_head: h.research_head,
    machines,
    lines: h.lines.map(lineOf).sort((a, b) => a.line.localeCompare(b.line)),
    runs: [...h.runs].sort((a, b) => t(b) - t(a)).slice(0, 500),
    members,
    decisions: decisionsOf(h.decisions),
    warnings,
  };
}

// 仓库里的 rk.py 是没有 sync 的旧版（rk.py sync --help 退出码非 0）的工作目录，键是 <服务器 id>:<工作目录>【G18】。
const OLD_RK = new Set([`${atlas.id}:~/work/longtail-old`]);
const oldRk = (s: { server_id: string; workdir: string }) => OLD_RK.has(`${s.server_id}:${s.workdir}`);

/** 在一个成员会话里“执行” rk sync --json：连不上、rk.py 是旧版、没有 rk.py、冲突、完成几种结果都有。 */
function syncMember(p: any, s: any) {
  const srv = servers.find((x) => x.id === s.server_id);
  const base = { session_id: s.id, server_alias: s.server_alias, title: s.title }; // title：修订 A3
  if (!srv || srv.status !== "online") return { ...base, ok: false, detail: `连不上 ${s.server_alias}：${srv?.status_detail ?? "服务器已删除"}`, result: null };
  if (oldRk(s)) return { ...base, ok: false, detail: "这台机器上仓库里的 rk.py 是旧版，没有 sync：在那里执行 /research:resume 更新研究工具", result: null };
  if (!s.machine) return { ...base, ok: false, detail: `${s.workdir} 里没有 ${p.home}/tools/rk.py：先在这个对话里 /research:start`, result: null };
  const h = hubs[p.id] ?? emptyHub();
  const m = h.machines.find((x) => x.code === s.machine);
  const result = { at: new Date().toISOString(), machine: s.machine, hub: "hub", branch: p.branch, mine: `sync/${s.machine}`, committed: null as string | null, merged: false, pushed: false, integrated: false, conflict: [] as string[], offline: false, error: null, head: m?.head ?? sha(s.id), ahead: 0, behind: 0, ok: true };
  if (m?.conflict) {
    Object.assign(result, { pushed: true, conflict: [`${p.home}/state/smoothing.md`, `${p.home}/SUMMARY.md`], ok: false, ahead: m.ahead, behind: m.behind });
    return { ...base, ok: false, detail: `并入 ${p.branch} 冲突：${result.conflict.join("、")}`, result };
  }
  // 推上 sync 分支并入研究分支：这台机器的提交和运行都进了研究分支，其余机器多落后一个提交。
  if (m && m.ahead > 0) {
    h.research_head = sha(`${h.research_head}+${m.code}`);
    for (const r of h.runs) if (r.machine === m.code && !r.integrated) Object.assign(r, { integrated: true, source: p.branch });
    for (const o of h.machines) if (o !== m) o.behind += 1;
    Object.assign(m, { head: h.research_head, committed_at: result.at, subject: `rk sync：${m.code} 并入 ${p.branch}`, ahead: 0, behind: 0, conflict: null }); // 不再 ahead 且 behind，判断冲突无从谈起
    Object.assign(result, { committed: m.head, merged: true, pushed: true, integrated: true, head: m.head });
    return { ...base, ok: true, detail: `完成：推上 sync/${m.code}，并入 ${p.branch}`, result };
  }
  Object.assign(result, { pushed: true, integrated: true });
  return { ...base, ok: true, detail: "完成：没有新的记录", result };
}

/**
 * 部署里的 project 一步（契约第 2 节）：按第 4 节判断这台服务器能不能访问汇合点，能就接入并给出机器代号。
 * 错误码【G6】：算不出访问地址 → bad_request；取不到汇合点 → host_unreachable；工作目录非空又不是 git 仓库、
 * 汇合点是空的 → bad_request；已有的 hub 远程地址不同 → conflict。目标机器连不上在 connect 一步就失败了。
 * 工作目录算不算已有的 git 仓库：同一台服务器上已有对话用这个目录就算，那个对话装了 research 插件就算有 rk.py。
 */
type Join = { ok: true; detail: string; machine: string | null } | { ok: false; detail: string; code: string; message: string; hint: string | null };
const NO_RK = "仓库里还没有研究目录：/research:start 之后执行 rk sync --setup（研究分支已写进 git config）";
const OLD_RK_SETUP = "仓库里的 rk.py 是旧版，没有 sync：在这台机器上执行 /research:resume（会更新研究工具）后再执行 rk sync --setup（研究分支已写进 git config）"; // 【G18】
// 没有全局 git 提交身份的服务器：仓库里也没有 user.email 时，project 一步写仓库级身份，detail 前面带一句（同 crates/core）。
// 键是 <服务器 id>:<工作目录>，设过一次的仓库之后不再设。
const NO_GIT_IDENTITY = new Set([atlas.id]);
const identityRepos = new Set<string>();
function joinProject(p: any, srv: any, workdir: string): Join {
  const at = hubAt(p.hub)?.srv;
  const isLocal = srv.source === "local";
  if (at && !isLocal && at.id !== srv.id) {
    const where = at.source === "local" ? "本机" : ` ${at.alias} `;
    return { ok: false, detail: `${srv.alias} 访问不到 ${p.hub}`, code: "bad_request", message: `汇合点在${where}上，${srv.alias} 访问不到`, hint: "改用各台机器都能访问的汇合点（例如私有 GitHub 仓库），或部署到汇合点所在的那台机器或本机。" };
  }
  if (at && at.status !== "online") return { ok: false, detail: `取不到 ${p.hub}`, code: "host_unreachable", message: `取不到汇合点 ${p.hub}`, hint: `${at.alias} 连不上：${at.status_detail ?? "确认机器开着"}` };
  const h = hubs[p.id] ?? emptyHub();
  const repo = sessions.find((s) => s.server_id === srv.id && s.workdir === workdir);
  // 目标机器本身在这一步出问题：沿用执行时的错误码【G6】。
  if (/authfail/.test(workdir))
    return { ok: false, detail: `登录 ${srv.alias} 被拒绝`, code: "auth_failed", message: `在 ${srv.alias} 上执行 git 时登录被拒绝：Permission denied (publickey)`, hint: "到“服务器”页测试连接，确认私钥还有效、服务器上的 authorized_keys 没被改过。" };
  if (/timeout/.test(workdir))
    return { ok: false, detail: "120 秒没有完成", code: "timeout", message: `在 ${srv.alias} 上接入研究项目超时：git fetch 120 秒没有完成`, hint: "汇合点或网络可能很慢：过一会儿重试，或先在那台机器上手动 git fetch 一次。" };
  if (/hubclash/.test(workdir))
    return { ok: false, detail: "远程 hub 已存在，地址不同", code: "conflict", message: "仓库里已有名为 hub 的远程，地址不是这个项目的汇合点", hint: "在那个仓库里 git remote remove hub（或改名）后重试，或者换个工作目录。" };
  let how: string;
  let hasRk: boolean;
  if (repo) {
    how = "已有仓库：加远程 hub · git fetch";
    // 这个仓库里有没有 rk.py：用过它的对话里有一个装了 research 插件就算（不只看找到的第一个，它可能是刚部署、没带插件的）。
    hasRk = sessions.some((s) => s.server_id === srv.id && s.workdir === workdir && s.plugin === "research");
  } else if (/notempty/.test(workdir)) {
    return { ok: false, detail: "工作目录不是空的，也不是 git 仓库", code: "bad_request", message: "工作目录不是空的，也不是 git 仓库", hint: "换一个空目录让 Bunsen 克隆汇合点，或者填已有仓库的目录。" };
  } else if (!h.research_head && h.machines.length === 0) {
    return { ok: false, detail: "汇合点是空的", code: "bad_request", message: "汇合点是空的，没有可以克隆的内容", hint: "先在一台已有仓库的机器上部署（工作目录填那个仓库），它会推上研究分支。" };
  } else {
    // 克隆研究分支时研究目录随之而来；汇合点上还没有研究分支时只能克隆默认分支，没有 rk.py。
    how = h.research_head ? `git clone -b ${p.branch}` : "git clone（汇合点上还没有研究分支）";
    hasRk = Boolean(h.research_head);
  }
  const idKey = `${srv.id}:${workdir}`;
  const identity = NO_GIT_IDENTITY.has(srv.id) && !identityRepos.has(idKey) ? "已设置仓库级 git 提交身份；" : "";
  if (identity) identityRepos.add(idKey);
  if (!hasRk) return { ok: true, machine: null, detail: `${identity}${how} · rk.branch=${p.branch}。${NO_RK}` };
  if (repo && oldRk(repo)) return { ok: true, machine: null, detail: `${identity}${how} · rk.branch=${p.branch}。${OLD_RK_SETUP}` };
  const machine = isLocal ? "mymac" : srv.alias.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12) || "m" + srv.id.slice(0, 6);
  // rk sync --setup 推上 sync/<代号>；汇合点上还没有研究分支时一并推上。
  const hub = (hubs[p.id] ??= h);
  if (!hub.research_head) hub.research_head = sha(`${p.id}-init`);
  if (!hub.machines.some((m) => m.code === machine))
    hub.machines.push({ code: machine, head: hub.research_head, committed_at: new Date().toISOString(), subject: `rk sync --setup：${machine} 接入`, ahead: 0, behind: 0, conflict: null });
  return { ok: true, machine, detail: `${identity}${how} · rk sync --setup · 代号 ${machine}` };
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let file = Bun.file(join(DIST, rel === "/" ? "index.html" : rel));
  if (!(await file.exists())) file = Bun.file(join(DIST, "index.html"));
  return new Response(file);
}

const BANNER = (title: string) =>
  `\x1b[2J\x1b[H\x1b[2mbunsen · 演示数据\x1b[0m\r\n\r\n\x1b[38;5;173m❯\x1b[0m \x1b[1m${title}\x1b[0m\r\n\r\n\x1b[32m●\x1b[0m 读完 train.py、configs/base.yaml 和上次的 research/STATE.md\r\n\x1b[32m●\x1b[0m 预登记 r03：标签平滑 ε = 0.1，判据 top-1 提升 ≥ 0.5pt（5 个种子）\r\n\x1b[32m●\x1b[0m 基线 3 个种子：\x1b[1m76.4 ± 0.3\x1b[0m\r\n\x1b[33m●\x1b[0m 确认实验在 GPU 2、3 上跑，第 3/5 个种子\r\n\r\n  \x1b[2mseed 1\x1b[0m  77.1    \x1b[2mseed 2\x1b[0m  76.9    \x1b[2mseed 3\x1b[0m  epoch 41/90 \x1b[2m· 剩余约 38 分钟\x1b[0m\r\n\r\n\x1b[2m  等实验结束后我会核对指标、更新结论账本，再继续下一步。\x1b[0m\r\n\r\n\x1b[38;5;173m❯\x1b[0m `;

Bun.serve<{ title: string }, never>({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    if (p === "/ws/term") {
      const sid = url.searchParams.get("session");
      // 和服务器接口一致：服务器不存在（含 BUNSEN_NO_LOCAL=1 时的本机）、会话不存在或它所在的服务器不存在时都拒绝连接【G15】。
      const termSrv = sid ? sessions.find((s) => s.id === sid)?.server_id : url.searchParams.get("server");
      if (sid && !sessions.some((s) => s.id === sid)) return fail(404, "not_found", "没有这个对话");
      if (!servers.some((x) => x.id === termSrv)) return fail(404, "not_found", sid ? "这个对话所在的服务器已删除" : "没有这台服务器");
      const title = sid ? `${sessions.find((s) => s.id === sid)?.title ?? sid} · ${url.searchParams.get("pane")}` : `服务器 ${url.searchParams.get("server")} · ${url.searchParams.get("pane")}`;
      return server.upgrade(req, { data: { title } }) ? (undefined as any) : fail(400, "bad_request", "需要 WebSocket");
    }
    if (!p.startsWith("/api/")) return serveStatic(p);
    const body = m === "POST" || m === "PUT" || m === "PATCH" ? await req.clone().json().catch(() => ({})) : {};
    const seg = p.split("/").slice(2);

    if (p === "/api/meta") return json({ version: "0.1.0-demo", data_dir: "~/Library/Application Support/bunsen", platform: "macos", dev: true });
    if (p === "/api/settings") {
      if (m === "PUT") settings = body;
      return json(settings);
    }
    if (p === "/api/agents") return json(agents);
    if (p === "/api/plugins") return json([{ name: "research", version: "0.1.0", description: "科研循环", source: "bundled", path: null, skills: ["start", "resume", "status", "stop", "orchestrator", "protocol", "ideation", "lab-access"], agents: ["executor", "scout", "auditor"], hooks: true }]);
    if (p === "/api/keys") return json(keys);
    if (p === "/api/servers" && m === "GET") return json(servers);
    if (p === "/api/servers/import") {
      await sleep(900);
      return json({ servers_added: [], servers_updated: [servers[0]], keys_added: [], warnings: ["演示模式：没有真的导入任何东西"], tests: [{ server_id: servers[0].id, ok: true, key_used: "id_ed25519", detail: null }] });
    }
    if (seg[0] === "servers" && seg[1]) {
      const s = servers.find((x) => x.id === seg[1]);
      if (!s) return fail(404, "not_found", "没有这台服务器");
      if (seg[2] === "test") {
        // 本机不经 ssh：不试密钥（try_all_keys 忽略），key_used 为 null。
        const isLocal = s.source === "local";
        await sleep(isLocal ? 150 : 600);
        s.last_checked = new Date().toISOString();
        return json({ ok: s.status === "online", latency_ms: s.status === "online" ? (isLocal ? 3 : 38) : null, key_used: isLocal ? null : s.key, server: s });
      }
      if (seg[2] === "probe") {
        await sleep(900);
        return s.probe ? json(s) : fail(502, "host_unreachable", `连不上 ${s.alias}`, "确认机器开着、地址和端口没变。");
      }
      if (seg[2] === "gpus") return json(s.probe?.gpus.length ? gpus.map((g) => ({ ...g, util_pct: g.procs ? Math.min(100, g.util_pct + Math.round(Math.random() * 6 - 3)) : 0 })) : []);
      if (seg[2] === "install-agent") return json({ tmux: `op-install-${body.agent_id}` });
      if (seg[2] === "notes") {
        if (m === "PUT") s.notes = body.text;
        return json({ text: s.notes ?? (s.probe ? "## 环境\n\n- `conda activate lt`：torch 2.4 + cu121（已验证，2026-11-10）\n\n## 数据\n\n- ImageNet-LT 在 `/data/imagenet-lt`，只读\n\n## 注意\n\n- 0 号卡长期被占用，先看占用再用\n" : ""), exists: Boolean(s.probe) });
      }
      // 别名唯一：改成另一台服务器已有的别名 → 409（同 crates/core 的 update_server，本机和远程一样）。
      if (m === "PATCH" && typeof body.alias === "string") {
        const alias = body.alias.trim();
        if (servers.some((x) => x.alias === alias && x.id !== s.id)) return fail(409, "conflict", `别名 ${alias} 已存在`);
        body.alias = alias;
      }
      if (m === "PATCH") {
        const before = s.alias;
        if (s.source === "local") {
          const bad = ["host", "user", "port", "key", "proxy_jump", "proxy_command"].filter((k) => k in body && body[k] !== s[k]);
          if (bad.length > 0) return fail(400, "bad_request", `本机不能改 ${bad.join("、")}`, "本机只能改别名、备注和默认工作目录。");
          for (const k of ["alias", "note", "default_workdir"]) if (typeof body[k] === "string") s[k] = body[k];
        } else Object.assign(s, body);
        // 改了别名：这台服务器上的会话的 server_alias 跟着改（同 crates/core 的 update_server）。
        if (s.alias !== before) for (const x of sessions) if (x.server_id === s.id) x.server_alias = s.alias;
        return json(s);
      }
      if (m === "DELETE" && s.source === "local") return fail(400, "bad_request", "本机不能删除", "不想在列表里看到本机，用 BUNSEN_NO_LOCAL=1 启动 bunsen serve。");
      if (m === "DELETE") return fail(409, "conflict", "演示模式下不删除服务器");
    }
    if (p === "/api/servers" && m === "POST") {
      const s = { id: Math.random().toString(36).slice(2, 8), proxy_command: null, source: "manual", note: "", default_workdir: "~", status: "unknown", status_detail: null, last_checked: null, probe: null, ...body };
      servers.push(s);
      return json(s);
    }

    if (p === "/api/projects" && m === "GET") return json([...projects].sort((a, b) => a.created_at.localeCompare(b.created_at)));
    if (p === "/api/projects" && m === "POST") {
      // 名称规则和前端共用（projectRules.ts，照 projects.rs 的 validate_new）；提示文字同服务端。
      const rawName = typeof body.name === "string" ? body.name : "";
      const name = trimName(rawName);
      const issue = nameIssue(rawName); // 含 G19：不能是 . 或 ..
      if (issue) return fail(400, "bad_request", NAME_ERROR[issue]);
      // 汇合点、研究目录和服务端一样不去空白；研究目录存规整后的写法。
      const hub = typeof body.hub === "string" ? body.hub : "";
      if (hubProblem(hub)) return fail(400, "bad_request", HUB_ERROR);
      if (body.branch != null) {
        const why = typeof body.branch === "string" ? branchProblem(body.branch) : "要写成 research/<简称>";
        if (why) return fail(400, "bad_request", `研究分支不合规：${why}`, "写成 research/<简称>：简称以英文字母或数字开头，最多 40 个字符，只用英文字母、数字和 _ . -，不能含 ..，不能以 . 或 .lock 结尾。");
      }
      const rawHome = body.home ?? "research";
      if (typeof rawHome !== "string" || homeProblem(rawHome)) return fail(400, "bad_request", HOME_ERROR);
      const home = normalizeHome(rawHome);
      if (projects.some((x) => x.name === name)) return fail(409, "conflict", `已经有叫 ${name} 的研究项目`, "换个名称，或打开已有的那个项目。");
      await sleep(700); // 建镜像并取一次汇合点
      // git 的报错按 G22 摘要：去掉空行和“Please make sure you have the correct access rights / and the repository exists.”，
      // 保留最后最多 3 行用“；”连接（只取最后一行时 ssh 地址的真正原因会丢）。
      if (/unreachable/.test(hub)) return fail(502, "host_unreachable", "取不到汇合点：Host key verification failed.；fatal: Could not read from remote repository.", "确认地址写对、本机能访问（私有仓库要先配好 ssh 密钥或凭据）。");
      // 汇合点在某台服务器（含本机）上：路径不存在时，带 create 就 git init --bare，否则取不到【G2】。git 地址时 create 忽略。
      const at = hubAt(hub);
      let found: string[] = /multi/.test(hub) ? ["research/fold", "research/fold-v2"] : [];
      if (at) {
        if (at.srv.status !== "online") return fail(502, "host_unreachable", `取不到汇合点：ssh: connect to host ${at.srv.host} port 22: Operation timed out；fatal: Could not read from remote repository.`, `${at.srv.alias} 连不上，先到“服务器”页测试一次。`);
        const key = repoKey(at.srv, at.path);
        if (!bareRepos.has(key)) {
          if (body.create !== true) return fail(502, "host_unreachable", `取不到汇合点：fatal: '${at.path}' does not appear to be a git repository；fatal: Could not read from remote repository.`, `${at.srv.source === "local" ? "本机上" : `${at.srv.alias} 上`}还没有这个仓库：检查路径，或勾选“新建一个空的裸仓库”。`);
          bareRepos.set(key, []);
        }
        found = bareRepos.get(key)!;
      }
      if (!body.branch && found.length > 1) return fail(400, "bad_request", "汇合点上有不止一条研究分支", `在“研究分支”里写明用哪一条：${found.join("、")}`);
      const id = newId();
      const at0 = new Date().toISOString();
      const branch = body.branch || found[0] || defaultBranch(name);
      // 汇合点上已经有这条研究分支：视图里能看到它（内容是空的）。
      if (found.includes(branch)) hubs[id] = { ...emptyHub(), research_head: sha(`${id}-${branch}`) };
      const proj = { id, name, hub, branch, home, created_at: at0, fetched_at: at0, fetch_error: null };
      projects.push(proj);
      return json(proj, 201);
    }
    if (seg[0] === "projects" && seg[1]) {
      let key: string;
      try {
        key = decodeURIComponent(seg[1]);
      } catch {
        return fail(400, "bad_request", "地址里的项目名转义不完整", "名称里的非 ASCII 字符要按 UTF-8 整个转义（encodeURIComponent）。");
      }
      const proj = findProject(key);
      if (!proj) return fail(404, "not_found", "没有这个研究项目", "它可能已经被删除。");
      if (!seg[2] && m === "GET") return json(proj);
      if (!seg[2] && m === "DELETE") {
        // 接入它的会话保留，project_id 不动。
        projects = projects.filter((x) => x !== proj);
        delete hubs[proj.id];
        return new Response(null, { status: 204 });
      }
      if (seg[2] === "view" && m === "GET") {
        await fetchHub(proj, url.searchParams.get("refresh") === "1");
        return json(viewOf(proj));
      }
      if (seg[2] === "sync" && m === "POST") {
        const live = sessions.filter((s) => s.project_id === proj.id && !s.archived && servers.some((x) => x.id === s.server_id));
        const members = await Promise.all(
          live.map(async (s, i) => {
            await sleep(900 + i * 450 + Math.random() * 500);
            return syncMember(proj, s);
          }),
        );
        await fetchHub(proj, true);
        return json({ members, view: viewOf(proj) });
      }
    }

    if (p === "/api/sessions" && m === "GET") return json(sessions);
    if (p === "/api/sessions" && m === "POST") {
      // 服务器、Agent、研究项目不存在：在任何步骤之前拒绝，不留步骤和副作用【G5】。传输方式按 docs/API.md 部署一节：
      // 请求要 NDJSON 时流里只有一行 {"type":"error",…}；否则 422 {error, steps: []}。
      const streamed = (req.headers.get("accept") ?? "").includes("application/x-ndjson");
      const refuse = (code: string, message: string, hint: string | null = null) =>
        streamed
          ? new Response(JSON.stringify({ type: "error", error: { code, message, hint } }) + "\n", { headers: { "content-type": "application/x-ndjson" } })
          : json({ error: { code, message, hint }, steps: [] }, 422);
      const srv = servers.find((x) => x.id === body.server_id);
      if (!srv) return refuse("not_found", "没有这台服务器");
      if (!agents.some((a) => a.id === body.agent_id)) return refuse("not_found", "没有这个 Agent");
      const proj = body.project_id ? findProject(String(body.project_id)) : null;
      if (body.project_id && !proj) return refuse("not_found", `没有研究项目 ${body.project_id}`, "它可能已经被删除：回到研究项目页重新选择，或者不接入项目。");
      const offline = srv.status !== "online";
      let machine: string | null = null;
      // 逐步发出 {type: "step" | "error" | "done"} 事件；流式和非流式共用。
      const deployRun = async (line: (o: any) => void) => {
        for (const [step, label, detail, ms] of stepsFor(srv, body.agent_id, body.workdir)) {
          if (step === "plugin" && body.plugins && body.plugins.length === 0) {
            line({ type: "step", step, label, status: "skipped", detail: "未选择", ms: null });
            continue;
          }
          if (step === "project" && !body.project_id) {
            line({ type: "step", step, label, status: "skipped", detail: "未接入研究项目", ms: null });
            continue;
          }
          line({ type: "step", step, label, status: "running", detail: null, ms: null });
          await sleep(ms);
          if (step === "project") {
            const r = joinProject(proj, srv, String(body.workdir));
            if (!r.ok) {
              line({ type: "step", step, label, status: "failed", detail: r.detail, ms });
              line({ type: "error", error: { code: r.code, message: r.message, hint: r.hint } });
              return;
            }
            machine = r.machine;
            line({ type: "step", step, label, status: "ok", detail: r.detail, ms });
            continue;
          }
          if (offline && step === "connect") {
            line({ type: "step", step, label, status: "failed", detail: srv.status_detail, ms });
            line({ type: "error", error: { code: "host_unreachable", message: `连不上 ${srv.alias}`, hint: "确认机器开着、地址和端口没变，再到“服务器”页测试一次。" } });
            return;
          }
          if (step === "agent" && srv.probe && srv.probe.agents[body.agent_id]?.present === false) {
            line({ type: "step", step, label, status: "failed", detail: "没有找到可执行文件", ms });
            line({ type: "error", error: { code: "agent_missing", message: `${srv.alias} 上没有安装这个 Agent`, hint: "可以直接在这里安装，装完再部署。" } });
            return;
          }
          line({ type: "step", step, label, status: "ok", detail, ms });
        }
        const id = Math.random().toString(36).slice(2, 8);
        const s = mk(id, body.title ?? (body.prompt ? String(body.prompt).slice(0, 40) : `新对话 @ ${srv.alias}`), srv, body.agent_id, body.workdir, "running", 0, { plugins: body.plugins ?? ["research"], plugin: (body.plugins ?? ["research"])[0] ?? null, yolo: Boolean(body.yolo), project_id: proj?.id ?? null, machine });
        sessions = [s, ...sessions];
        line({ type: "done", session: s });
      };
      if (streamed) {
        const stream = new ReadableStream({
          async start(c) {
            const enc = new TextEncoder();
            await deployRun((o) => c.enqueue(enc.encode(JSON.stringify(o) + "\n")));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      }
      // 不要流：部署完一次返回。steps 是每一步的最终状态（不含 running）；失败时 422 {error, steps}。
      const events: any[] = [];
      await deployRun((o) => events.push(o));
      const steps = events.filter((e) => e.type === "step" && e.status !== "running").map((e) => ({ step: e.step, label: e.label, status: e.status, detail: e.detail, ms: e.ms }));
      const end = events[events.length - 1];
      return end?.type === "done" ? json({ session: end.session, steps }) : json({ error: end?.error, steps }, 422);
    }
    if (seg[0] === "sessions" && seg[1]) {
      const s = sessions.find((x) => x.id === seg[1]);
      if (!s) return fail(404, "not_found", "没有这个对话");
      if (!seg[2]) {
        if (m === "PATCH") Object.assign(s, body);
        if (m === "DELETE") sessions = sessions.filter((x) => x !== s);
        return json(s);
      }
      if (seg[2] === "send" || seg[2] === "keys") return json({ ok: true });
      if (seg[2] === "capture") return json({ text: s.preview ?? "" });
      if (seg[2] === "restart") return json(Object.assign(s, { state: "running", exit_status: null, last_active_at: new Date().toISOString() }));
      if (seg[2] === "stop") return json(Object.assign(s, { state: "stopped" }));
      if (seg[2] === "files") {
        const path = url.searchParams.get("path") ?? "";
        return json(
          path
            ? { path, parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", entries: [{ name: "PROJECT.md", kind: "file", size: 1830, mtime: ago(300) }, { name: "STATE.md", kind: "file", size: 912, mtime: ago(3) }, { name: "LEDGER.md", kind: "file", size: 640, mtime: ago(40) }] }
            : { path: "", parent: null, entries: [{ name: "configs", kind: "dir", size: 0, mtime: ago(900) }, { name: "research", kind: "dir", size: 0, mtime: ago(3) }, { name: "README.md", kind: "file", size: 2210, mtime: ago(4000) }, { name: "train.py", kind: "file", size: 8421, mtime: ago(22) }, { name: "data", kind: "link", size: 0, mtime: ago(9000) }] },
        );
      }
      if (seg[2] === "file") {
        const path = url.searchParams.get("path") ?? "";
        const text = path.endsWith(".md") ? STATE_MD : `import torch\nfrom torch import nn\n\n\ndef build_loss(cfg):\n    if cfg.loss == "ce":\n        return nn.CrossEntropyLoss(label_smoothing=cfg.smoothing)\n    if cfg.loss == "focal":\n        return FocalLoss(gamma=cfg.gamma)\n    raise ValueError(cfg.loss)\n`;
        return json({ path, size: text.length, binary: false, truncated: false, text });
      }
      if (seg[2] === "git" && !seg[3]) return json({ is_repo: true, branch: "exp/label-smoothing", changes: [{ path: "train.py", status: " M" }, { path: "configs/smooth.yaml", status: "??" }, { path: "research/STATE.md", status: " M" }] });
      if (seg[2] === "git" && seg[3] === "diff") return json({ diff: url.searchParams.get("path") === "configs/smooth.yaml" ? "" : DIFF });
      if (seg[2] === "artifacts") {
        const mkA = (path: string, kind: string, size: number, min: number) => ({ path, name: path.split("/").pop(), kind, size, mtime: ago(min) });
        return json({ truncated: false, items: [mkA("figures/tail_acc.svg", "image", 5200, 12), mkA("figures/confusion.svg", "image", 9100, 30), mkA("figures/loss_curve.svg", "image", 4100, 96), mkA("outputs/per_class.csv", "table", 18230, 14), mkA("research/results/20261112-r03-smooth01.md", "doc", 2100, 40), mkA("notebooks/explore.ipynb", "notebook", 48200, 400), mkA("paper/draft.pdf", "pdf", 212000, 900), mkA("outputs/report.html", "html", 6400, 60)] });
      }
      if (seg[2] === "raw") {
        const path = url.searchParams.get("path") ?? "";
        const head = { "content-type": "application/octet-stream", "x-content-type-options": "nosniff" };
        if (path.endsWith(".svg")) {
          const n = path.length * 7;
          const bars = Array.from({ length: 9 }, (_, i) => `<rect x="${40 + i * 38}" y="${200 - ((n * (i + 3)) % 150) - 20}" width="24" height="${((n * (i + 3)) % 150) + 20}" rx="3" fill="#5b8cff" opacity="${0.45 + i * 0.06}"/>`).join("");
          return new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 240"><rect width="420" height="240" fill="#fff"/><path d="M32 16v186h372" fill="none" stroke="#999"/>${bars}<text x="210" y="228" font-size="11" text-anchor="middle" fill="#555" font-family="sans-serif">${path}</text></svg>`, { headers: head });
        }
        if (path.endsWith(".ipynb")) return new Response(JSON.stringify({ metadata: { kernelspec: { language: "python" } }, cells: [{ cell_type: "markdown", source: ["# 探索：尾部类别的置信度"] }, { cell_type: "code", execution_count: 1, source: ["import pandas as pd\n", "df = pd.read_csv('outputs/per_class.csv')\n", "df.groupby('split').acc.mean()"], outputs: [{ output_type: "execute_result", data: { "text/plain": ["split\nhead    0.908\nmid     0.791\ntail    0.449\nName: acc, dtype: float64"] } }] }, { cell_type: "code", execution_count: 2, source: ["1/0"], outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["ZeroDivisionError: division by zero"] }] }] }), { headers: head });
        return new Response("%PDF-1.4 demo", { headers: head });
      }
      if (seg[2] === "research" && seg[3] === "run") {
        const rid = url.searchParams.get("run_id") ?? "";
        const live = rid.endsWith("r05-smooth01-s3");
        const log = Array.from({ length: 40 }, (_, i) => `[epoch ${String(i + 1).padStart(3, "0")}] loss=${(2.1 * Math.exp(-i / 14) + 0.42).toFixed(4)} acc=${(0.42 + 0.35 * (1 - Math.exp(-i / 10))).toFixed(4)} acc_tail=${(0.18 + 0.27 * (1 - Math.exp(-i / 12))).toFixed(4)}`).join("\n");
        return json({ run_id: rid, meta: { run_id: rid, kind: "prereg", cmd: ["python", "train.py", "--config", "configs/smooth.yaml", "--seed", "3"], cwd: "/home/dev/work/longtail", host: "atlas", user: "dev", started_at: ago(26), git_commit: "9d04e77a1c", git_dirty: false, prereg: [{ path: "research/prereg/P-002-smoothing.md", commit: "9d04e77a1c" }], note: "ε=0.1 seed=3" }, log_tail: log + (live ? "\n[epoch 041] loss=0.5312 …" : "\n完成。"), metrics: live ? null : { acc: 0.772, acc_head: 0.908, acc_mid: 0.791, acc_tail: 0.449, loss: { final: 0.4312, best: 0.4188 }, epochs: 90 }, result_md: live ? null : "# r03 结果\n\nε = 0.1，单种子筛选。尾部准确率 **44.9**（基线 41.3）。\n\n判定：通过筛选阈值（+2.0），进入确认。" });
      }
      if (seg[2] === "research") {
        const present = s.plugin === "research";
        return json({
          present, home: "research", loop: { on: present, started: present ? ago(240) : null, blocked: null },
          state_md: present ? STATE_MD : null, summary_md: present ? SUMMARY_MD : null, ideas_md: present ? IDEAS_MD : null, ledger_md: present ? LEDGER_MD : null,
          overview_md: present ? SUMMARY_MD : null, lessons_md: present ? "# 经验\n\n- 混合精度下 `log(0)` 会出 NaN，统一加 eps。\n- 0 号卡常被占，默认用 1、3。" : null, log_tail: present ? "- 06:10 启动 r05（确认，seed 3）\n- 05:31 r04 结束，acc_tail 44.6" : null, prereg: present ? [{ name: "P-002-smoothing", title: "标签平滑对尾部类别的影响" }] : [], results: present ? [{ name: "20261112-r03-smooth01", title: "r03 结果" }] : [],
          runs: present
            ? [
                { run_id: "20261112-r02-smooth02", kind: "explore", state: "failed", exit_code: 1, host: "atlas", started_at: ago(460), ended_at: ago(458), elapsed: "2m", note: "ε=0.2，显存不足" },
                { run_id: "20261112-r03-smooth01", kind: "explore", state: "done", exit_code: 0, host: "atlas", started_at: ago(400), ended_at: ago(10), elapsed: "38m", note: "ε=0.1 筛选" },
                { run_id: "20261112-r04-smooth01-s2", kind: "prereg", state: "done", exit_code: 0, host: "atlas", started_at: ago(95), ended_at: ago(54), elapsed: "41m", note: "ε=0.1 seed=2" },
                { run_id: "20261112-r05-smooth01-s3", kind: "prereg", state: "running", exit_code: null, host: "atlas", started_at: ago(26), ended_at: null, elapsed: "26m", note: "ε=0.1 seed=3" },
              ]
            : [],
        });
      }
    }
    return fail(404, "not_found", `演示后端没有实现 ${m} ${p}`);
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "status", state: "connecting", detail: null }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "status", state: "connected", detail: null }));
        ws.send(new TextEncoder().encode(BANNER(ws.data.title)));
      }, 350);
    },
    message(ws, raw) {
      if (typeof raw !== "string") return;
      const msg = JSON.parse(raw);
      if (msg.type !== "input") return;
      const out = String(msg.data).replace(/\r/g, "\r\n\x1b[36m❯\x1b[0m ").replace(/\x7f/g, "\b \b");
      ws.send(new TextEncoder().encode(out));
    },
  },
});

console.log(`演示后端：http://127.0.0.1:${PORT}`);
