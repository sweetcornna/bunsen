// 界面演示用的假后端：不连任何服务器，数据都是编的。
// 用法：bun dev/mock-server.ts  →  http://127.0.0.1:7979
// 只为了在没有 SSH 目标时看界面；真正的实现在 crates/。
import { join, normalize } from "node:path";

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

const servers: any[] = [
  {
    id: "s3k9x2", alias: "atlas", host: "atlas.lab.example", user: "dev", port: 22, key: "id_ed25519", proxy_jump: null, proxy_command: null, source: "upload", note: "四卡，跑筛选实验", default_workdir: "~/work",
    status: "online", status_detail: null, last_checked: ago(2),
    probe: { checked_at: ago(2), hostname: "atlas", user: "dev", home: "/home/dev", os: "Ubuntu 22.04.4 LTS", kernel: "5.15.0-119", arch: "x86_64", shell: "/bin/bash", cpus: 64, mem_total_gb: 251.6, mem_free_gb: 180.2, disk_home: { total_gb: 3600, free_gb: 1240 }, tmux: { present: true, version: "3.2a" }, tools: { git: "2.34.1", python: "3.10.12", node: "22.11.0", rsync: true }, agents: { "claude-code": { present: true, version: "2.1.4", path: "/home/dev/.local/bin/claude" }, codex: { present: true, version: "0.58.0", path: "/home/dev/.npm/bin/codex" }, gemini: { present: false, version: null, path: null }, opencode: { present: false, version: null, path: null } }, gpus },
  },
  { id: "a81bqz", alias: "titan", host: "titan.lab.example", user: "dev", port: 22, key: "id_ed25519", proxy_jump: null, proxy_command: null, source: "upload", note: "", default_workdir: "~", status: "offline", status_detail: "连接超时：titan.lab.example:22 没有响应", last_checked: ago(2), probe: null },
  { id: "c0ffee", alias: "cpu-box", host: "cpu.example.org", user: "me", port: 22, key: null, proxy_jump: "atlas", proxy_command: null, source: "manual", note: "", default_workdir: "~", status: "unknown", status_detail: null, last_checked: null, probe: null },
];

const keys = [
  { name: "id_ed25519", kind: "ED25519", fingerprint: "SHA256:u3kE0q7WmZp1Xc9aB2dQyR5tLhN8vG4sJ6fK0oPiMnA", has_pub: true, used_by: ["atlas", "titan"] },
  { name: "id_rsa_old", kind: "RSA 4096", fingerprint: "SHA256:9aXb7Qm2Lk5Zp0Wc3Vn8Hd1Rt6Yg4Uj2Ei7Of5Sa0Dc", has_pub: false, used_by: [] },
];

const mk = (id: string, title: string, server: any, agent_id: string, workdir: string, state: string, min: number, extra: any = {}) => ({
  id, title, server_id: server.id, server_alias: server.alias, agent_id, workdir, tmux: `op-${id}`, created_at: ago(min + 300), last_active_at: ago(min), state, exit_status: state === "exited" ? 0 : null, attached: 0, pinned: false, archived: false, plugin: null, yolo: false,
  preview: "● 已读完 train.py 和 configs/base.yaml\n● 基线 3 个种子跑完，准确率 76.4 ± 0.3\n❯ ", attach_cmd: `ssh -t -p ${server.port} ${server.user}@${server.host} tmux -L bunsen attach -t op-${id}`, origin: "local", ...extra,
});
let sessions: any[] = [
  mk("k7f2qa", "标签平滑对长尾分类的影响", servers[0], "claude-code", "~/work/longtail", "running", 1, { plugin: "research", yolo: true, pinned: true, attached: 1 }),
  mk("m2x8cd", "复现 MAE 在 ImageNet-100 上的结果", servers[0], "codex", "~/work/mae-repro", "running", 14),
  mk("q9d4ht", "排查 loss 在 12k 步后变 NaN", servers[0], "claude-code", "~/work/nan-hunt", "exited", 190, { preview: "● 定位到混合精度下 log(0)\n● 已加 eps 并验证 20k 步无 NaN\n[进程已退出，状态 0]" }),
  mk("z1p6vw", "数据清洗脚本", servers[1], "gemini", "~/data", "unreachable", 1500, { preview: null }),
  mk("b5n3re", "整理上周的实验表格", servers[0], "claude-code", "~/work/tables", "stopped", 4300, { preview: null, origin: "discovered" }),
];

let settings = { theme: "dark", default_server: null, default_agent: null, research_plugin_path: "/Users/me/project/research_plugin", status_interval_secs: 30 };

const STATE_MD = `# STATE\n\n**课题**：标签平滑对长尾分类尾部类别的影响\n**阶段**：确认实验（第 2 轮）\n\n## 正在做\n\n- [x] 基线 3 个种子（76.4 ± 0.3）\n- [x] 筛选：ε ∈ {0.05, 0.1, 0.2}，单种子\n- [ ] 确认：ε = 0.1，5 个种子 —— 跑到第 3 个\n\n## 下一步\n\n等确认实验跑完后写 \`results/R-004.md\`，交给审计员核对数字出处。\n\n> 等待期间只做三件事：填满空闲显卡、准备下一批、清记录债。\n`;
const SUMMARY_MD = `# 摘要\n\n| 设置 | 头部 | 中部 | 尾部 | 总体 |\n|---|---|---|---|---|\n| 基线 | 91.2 | 78.5 | 41.3 | 76.4 |\n| ε = 0.1（筛选） | 90.8 | 79.1 | 44.9 | 77.2 |\n\n筛选结果提示尾部有 +3.6 的提升，**尚未确认**。数字出处：\`r-0412:acc_tail\`。\n`;
const IDEAS_MD = `# 想法池\n\n| 编号 | 想法（机制一句话） | 可证伪的预测 | 最便宜的判决性检验 | 簇 | 类型 | 新颖性核查 | 状态 | 备注 |\n|---|---|---|---|---|---|---|---|---|\n| I1 | 标签平滑削弱头部类别的过度自信，给尾部留出间隔 | ε=0.1 时尾部准确率 +2 以上，头部下降不超过 1 | 单种子 30 轮 | 正则 | 主线 | 已查，最近的是 logit adjustment | 筛选通过 | |\n| I2 | 只对头部类别做平滑，按类频率设 ε | 比统一 ε 的尾部再 +1 | 复用 I1 的配置改一行 | 正则 | 探索位 | 未查 | 候选 | |\n| I3 | 与 logit adjustment 叠加 | 两者增益可加 | 2×2 小网格 | 重加权 | 主线 | 已查 | 已预登记 | |\n| I4 | 换 focal loss | 尾部提升但总体下降 | 单种子 | 损失 | 探索位 | 已查 | 否决（已有大量负面结果） | |\n`;
const LEDGER_MD = `# 结论账本（只追加）\n\n| 编号 | 状态 | 结论（一句话，精确到条件） | 证据 | 性质 | 日期 |\n|---|---|---|---|---|---|\n| C1 | 已证实 | ImageNet-LT、ResNet-50、90 轮下基线总体准确率 76.4 ± 0.3（3 个种子） | run:20261112-r03-smooth01; results/20261112-r03-smooth01.md | 确认 | 2026-11-11 |\n| C2 | 未决 | ε = 0.1 使尾部准确率提高约 3.6（单种子） | run:20261112-r03-smooth01 | 探索 | 2026-11-12 |\n| C3 | 已否定 | ε = 0.2 在 24G 显存下可用默认批量训练 | run:20261112-r02-smooth02 | 探索 | 2026-11-12 |\n| C4 | 已证实 | logit adjustment 在同设置下尾部 +5.1 | doi:10.48550/arXiv.2007.07314 | 文献 | 2026-11-10 |\n`;
const DIFF = `diff --git a/train.py b/train.py\nindex 3f1c2ab..9d04e77 100644\n--- a/train.py\n+++ b/train.py\n@@ -41,7 +41,9 @@ def build_loss(cfg):\n     if cfg.loss == "ce":\n-        return nn.CrossEntropyLoss()\n+        return nn.CrossEntropyLoss(label_smoothing=cfg.smoothing)\n+    if cfg.loss == "focal":\n+        return FocalLoss(gamma=cfg.gamma)\n     raise ValueError(cfg.loss)\n`;

const STEPS: [string, string, string | null, number][] = [
  ["connect", "连接服务器", "dev@atlas.lab.example", 420],
  ["tmux", "检查 tmux", "tmux 3.2a", 90],
  ["agent", "查找 Agent", "/home/dev/.local/bin/claude", 120],
  ["workdir", "准备工作目录", "/home/dev/work", 80],
  ["plugin", "同步插件", "research · 8 个技能", 600],
  ["start", "启动对话", null, 180],
  ["verify", "确认运行", "进程在运行", 1000],
];

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
        await sleep(600);
        return json({ ok: s.status === "online", latency_ms: s.status === "online" ? 38 : null, key_used: s.key, server: s });
      }
      if (seg[2] === "probe") {
        await sleep(900);
        return s.probe ? json(s) : fail(502, "host_unreachable", `连不上 ${s.alias}`, "确认机器开着、地址和端口没变。");
      }
      if (seg[2] === "gpus") return json(s.probe ? gpus.map((g) => ({ ...g, util_pct: g.procs ? Math.min(100, g.util_pct + Math.round(Math.random() * 6 - 3)) : 0 })) : []);
      if (seg[2] === "install-agent") return json({ tmux: `op-install-${body.agent_id}` });
      if (seg[2] === "notes") {
        if (m === "PUT") s.notes = body.text;
        return json({ text: s.notes ?? (s.probe ? "## 环境\n\n- `conda activate lt`：torch 2.4 + cu121（已验证，2026-11-10）\n\n## 数据\n\n- ImageNet-LT 在 `/data/imagenet-lt`，只读\n\n## 注意\n\n- 0 号卡长期被占用，先看占用再用\n" : ""), exists: Boolean(s.probe) });
      }
      if (m === "PATCH") return json(Object.assign(s, body));
      if (m === "DELETE") return fail(409, "conflict", "演示模式下不删除服务器");
    }
    if (p === "/api/servers" && m === "POST") {
      const s = { id: Math.random().toString(36).slice(2, 8), proxy_command: null, source: "manual", note: "", default_workdir: "~", status: "unknown", status_detail: null, last_checked: null, probe: null, ...body };
      servers.push(s);
      return json(s);
    }

    if (p === "/api/sessions" && m === "GET") return json(sessions);
    if (p === "/api/sessions" && m === "POST") {
      const srv = servers.find((x) => x.id === body.server_id)!;
      const offline = srv.status !== "online";
      const stream = new ReadableStream({
        async start(c) {
          const enc = new TextEncoder();
          const line = (o: unknown) => c.enqueue(enc.encode(JSON.stringify(o) + "\n"));
          for (const [step, label, detail, ms] of STEPS) {
            if (step === "plugin" && body.plugins && body.plugins.length === 0) {
              line({ type: "step", step, label, status: "skipped", detail: "未选择", ms: null });
              continue;
            }
            line({ type: "step", step, label, status: "running", detail: null, ms: null });
            await sleep(ms);
            if (offline && step === "connect") {
              line({ type: "step", step, label, status: "failed", detail: srv.status_detail, ms });
              line({ type: "error", error: { code: "host_unreachable", message: `连不上 ${srv.alias}`, hint: "确认机器开着、地址和端口没变，再到“服务器”页测试一次。" } });
              return c.close();
            }
            if (step === "agent" && srv.probe && srv.probe.agents[body.agent_id]?.present === false) {
              line({ type: "step", step, label, status: "failed", detail: "没有找到可执行文件", ms });
              line({ type: "error", error: { code: "agent_missing", message: `${srv.alias} 上没有安装这个 Agent`, hint: "可以直接在这里安装，装完再部署。" } });
              return c.close();
            }
            line({ type: "step", step, label, status: "ok", detail, ms });
          }
          const id = Math.random().toString(36).slice(2, 8);
          const s = mk(id, body.title ?? (body.prompt ? String(body.prompt).slice(0, 40) : `新对话 @ ${srv.alias}`), srv, body.agent_id, body.workdir, "running", 0, { plugins: body.plugins ?? ["research"], plugin: (body.plugins ?? ["research"])[0] ?? null, yolo: Boolean(body.yolo) });
          sessions = [s, ...sessions];
          line({ type: "done", session: s });
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
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
