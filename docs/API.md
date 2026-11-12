# Outpost 接口约定（v1）

前端（`ui/`）与核心（`crates/`）之间唯一的约定。两边都只照这份文档写；要改接口先改这里。

## 0. 总则

- 服务只监听 `127.0.0.1:<port>`（默认 7878）。
- **鉴权**：启动时生成随机令牌。所有 `/api/*` 请求带请求头 `x-outpost-token: <token>`；WebSocket 用查询参数 `?token=<token>`。缺失或不符返回 401。
- **防跨站**：`Host` 头不是 `127.0.0.1:<port>` 或 `localhost:<port>` 的请求一律 403。带 `Origin` 头时必须与服务同源；`--dev` 模式下额外放行 `http://localhost:5173` 与 `http://127.0.0.1:5173`。
- 界面入口：`GET /` 返回内嵌的 `ui/dist`（单页应用，未知路径回落到 `index.html`）。服务启动时打印并打开 `http://127.0.0.1:<port>/#token=<token>`；前端从地址片段读令牌，存进 `sessionStorage` 后把片段抹掉。`--dev` 模式令牌固定为 `dev`。
- 请求与响应体都是 JSON（UTF-8），字段名 `snake_case`，时间是 RFC 3339 字符串。
- **错误**：非 2xx 时响应体为 `{"error": {"code": string, "message": string, "hint": string | null}}`。`message` 与 `hint` 用中文，可直接显示。错误码：
  `unauthorized` `forbidden` `not_found` `bad_request` `conflict` `ssh_failed` `auth_failed` `host_unreachable` `tmux_missing` `agent_missing` `timeout` `internal`。
- 私钥内容永远不出现在任何响应里。

## 1. 数据类型

```ts
type Agent = {
  id: string;                    // "claude-code" | "codex" | "gemini" | "opencode" | ... | 自定义
  name: string;
  vendor: string;
  description: string;
  detect: string;                // 可执行文件名，用于在服务器上查找
  launch: string;                // 启动交互界面的命令
  launch_with_prompt: string | null; // 含 {prompt} 占位符；服务端负责 shell 转义
  resume: string | null;         // 在工作目录里接续最近一次对话的命令
  yolo_flag: string | null;      // “跳过权限确认”打开时追加
  plugin_dir_flag: string | null;// 含 {dir} 占位符，如 "--plugin-dir {dir}"
  install: { label: string; cmd: string }[];
  auth_hint: string;             // 在服务器上怎么登录
  docs_url: string;
  builtin: boolean;
};

type Server = {
  id: string;                    // 短 id，如 "s3k9x2"
  alias: string;                 // 唯一，显示名
  host: string;
  user: string;
  port: number;
  key: string | null;            // 已保存的私钥名
  proxy_jump: string | null;
  proxy_command: string | null;
  source: "upload" | "manual";
  note: string;
  default_workdir: string;       // 默认 "~"
  status: "unknown" | "online" | "offline" | "auth_failed";
  status_detail: string | null;  // 最近一次失败的原因
  last_checked: string | null;
  probe: Probe | null;           // 最近一次探测结果
};

type Probe = {
  checked_at: string;
  hostname: string; user: string; home: string;
  os: string;                    // 如 "Ubuntu 22.04.4 LTS"
  kernel: string; arch: string; shell: string;
  cpus: number; mem_total_gb: number; mem_free_gb: number;
  disk_home: { total_gb: number; free_gb: number } | null;
  tmux: { present: boolean; version: string | null };
  tools: { git: string | null; python: string | null; node: string | null; rsync: boolean };
  agents: Record<string, { present: boolean; version: string | null; path: string | null }>; // 键是 Agent.id
  gpus: Gpu[];
};

type Gpu = { index: number; name: string; mem_used_mb: number; mem_total_mb: number; util_pct: number; procs: number };

type KeyInfo = { name: string; kind: string; fingerprint: string; has_pub: boolean; used_by: string[] /* 服务器别名 */ };

type Session = {
  id: string;                    // 短 id，如 "k7f2qa"
  title: string;
  server_id: string;
  server_alias: string;
  agent_id: string;
  workdir: string;
  tmux: string;                  // "op-<id>"
  created_at: string;
  last_active_at: string | null;
  state: "running" | "exited" | "stopped" | "unreachable" | "unknown";
  //  running：tmux 会话在，代理进程活着
  //  exited：tmux 会话在，但代理进程已退出（窗格保留着最后的输出，可重启）
  //  stopped：tmux 会话已不存在
  //  unreachable：这次没连上服务器
  exit_status: number | null;
  attached: number;              // 当前连着的客户端数
  pinned: boolean;
  archived: boolean;
  plugin: string | null;         // "research" | null
  yolo: boolean;
  preview: string | null;        // 窗格最后几行纯文本（列表里用）
  attach_cmd: string;            // 在普通终端里接入的完整命令
  origin: "local" | "discovered";// discovered：在服务器上发现、不是本机创建的
};

type Step = { step: string; label: string; status: "running" | "ok" | "failed" | "skipped"; detail: string | null; ms: number | null };
// 部署步骤固定顺序：connect → tmux → agent → workdir → plugin → start → verify

type Settings = {
  theme: "dark" | "light" | "system";
  default_server: string | null;
  default_agent: string | null;
  research_plugin_path: string | null; // 本机 research 插件目录；部署时同步到服务器
  status_interval_secs: number;        // 会话列表的自动刷新间隔，默认 30
};
```

## 2. 基本信息

| 方法与路径 | 说明 |
|---|---|
| `GET /api/meta` | `{version, data_dir, platform, dev: boolean}` |
| `GET /api/settings` / `PUT /api/settings` | 读 / 整体替换 `Settings` |

## 3. Agent

| 方法与路径 | 说明 |
|---|---|
| `GET /api/agents` | `Agent[]`，内置的在前 |
| `PUT /api/agents/:id` | 新增或覆盖一个 Agent（内置的被覆盖后 `builtin` 仍为 true，可用 DELETE 还原） |
| `DELETE /api/agents/:id` | 删除自定义项，或把内置项还原为默认 |

## 4. 服务器与密钥

| 方法与路径 | 说明 |
|---|---|
| `GET /api/servers` | `Server[]` |
| `POST /api/servers/import` | `multipart/form-data`。字段 `files`（可多个：ssh 配置、私钥、`.pub`、`.zip`）与可选的 `config_text`（粘贴的 ssh 配置）。返回 `ImportResult` |
| `POST /api/servers` | 手工添加：`{alias, host, user, port?, key?, proxy_jump?, note?, default_workdir?}` → `Server` |
| `PATCH /api/servers/:id` | 修改上述字段的任意子集 → `Server` |
| `DELETE /api/servers/:id` | 删除记录（不动服务器上的任何东西）。还有未归档的会话时返回 `conflict` |
| `POST /api/servers/:id/test` | 体 `{try_all_keys?: boolean}`。测试连接并更新 `status`。返回 `{ok, latency_ms, key_used, server: Server}`；失败时 `ok=false` 且 `server.status_detail` 有原因（HTTP 仍为 200） |
| `POST /api/servers/:id/probe` | 探测并保存 → `Server`（含新的 `probe`）。连不上返回对应错误码 |
| `GET /api/servers/:id/gpus` | 只跑 `nvidia-smi` → `Gpu[]`（没有显卡返回 `[]`） |
| `POST /api/servers/:id/install-agent` | 体 `{agent_id, method?: number}`。在服务器的 tmux 里启动安装任务 `op-install-<agent_id>` → `{tmux: string}`；用下面的终端通道观看 |
| `GET /api/keys` | `KeyInfo[]` |
| `DELETE /api/keys/:name` | 删除私钥；仍被服务器引用时返回 `conflict` |

```ts
type ImportResult = {
  servers_added: Server[];
  servers_updated: Server[];
  keys_added: KeyInfo[];
  warnings: string[];            // 例如“Host gpu1 引用的密钥 id_x 没有上传”
  tests: { server_id: string; ok: boolean; key_used: string | null; detail: string | null }[];
};
```

导入规则：

- 按内容识别文件，不看扩展名：ZIP 就地展开；首行是 `-----BEGIN … PRIVATE KEY-----` 的是私钥；含 `Host ` 行的文本是 ssh 配置；其余忽略并写进 `warnings`。
- 私钥按指纹去重，存到数据目录 `keys/`，权限 0600。
- ssh 配置里的通配块（`Host *`）作为其余块的默认值；每个具体别名建一条服务器，别名已存在则更新。`IdentityFile` 按文件名匹配已有私钥。
- 导入后对每台新服务器自动测一次连接；没有指定密钥的，逐把尝试已保存的私钥，把能用的记下来。

## 5. 云端对话（会话）

| 方法与路径 | 说明 |
|---|---|
| `GET /api/sessions?refresh=0\|1` | `Session[]`。`refresh=1` 时逐台连服务器更新状态，并把服务器上发现的、本机没有记录的会话并入（`origin="discovered"`）；`refresh=0` 直接返回本机记录 |
| `POST /api/sessions` | 部署，见下 |
| `GET /api/sessions/:id` | 连服务器取最新状态 → `Session` |
| `PATCH /api/sessions/:id` | `{title?, pinned?, archived?}` → `Session` |
| `POST /api/sessions/:id/send` | `{text, enter?: boolean = true}`：把文字粘贴进代理窗格（多行安全），可选回车 → `{ok: true}` |
| `POST /api/sessions/:id/keys` | `{keys: string[]}`，tmux 键名，如 `["Escape"]`、`["C-c"]`、`["Enter"]` → `{ok: true}` |
| `GET /api/sessions/:id/capture?lines=200` | `{text}`：代理窗格最近若干行的纯文本 |
| `POST /api/sessions/:id/restart` | `{resume?: boolean = true}`：在原 tmux 会话里重新拉起代理（`resume` 为真且 Agent 有 `resume` 命令时用它）→ `Session` |
| `POST /api/sessions/:id/stop` | 结束服务器上的 tmux 会话（代理与 shell 两个），记录保留，`state="stopped"` → `Session` |
| `DELETE /api/sessions/:id?force=0\|1` | 删除记录。会话还在运行且 `force=0` 时返回 `conflict`；`force=1` 先停再删 |

### 部署

`POST /api/sessions`，体：

```ts
{
  server_id: string;
  agent_id: string;
  title?: string;               // 省略时取 prompt 的前 40 个字，或 “<Agent 名> @ <别名>”
  workdir: string;              // 远程路径，支持 ~；不存在则创建
  prompt?: string;              // 初始提示
  yolo?: boolean;
  plugin?: "research" | null;
  extra_args?: string;          // 原样追加到启动命令
}
```

请求头带 `Accept: application/x-ndjson` 时，响应是逐行 JSON 的流：

```
{"type":"step","step":"connect","label":"连接服务器","status":"running","detail":null,"ms":null}
{"type":"step","step":"connect","label":"连接服务器","status":"ok","detail":"dev@gpu1.example.org","ms":412}
...
{"type":"done","session":{...Session}}
```

失败时最后一行是 `{"type":"error","error":{code,message,hint}}`，此前失败的那一步 `status="failed"`。不带该请求头时，成功返回 `{session, steps}`，失败返回 422 `{error, steps}`。

各步含义：`connect` 连接；`tmux` 检查 tmux（缺失 → `tmux_missing`）；`agent` 查找代理可执行文件（缺失 → `agent_missing`）；`workdir` 建工作目录；`plugin` 同步插件（未选择时 `skipped`）；`start` 启动 tmux 会话；`verify` 一秒后确认代理进程还活着。

## 6. 终端通道（WebSocket）

`GET /ws/term?token=…&cols=<n>&rows=<n>` 加下列之一：

| 参数 | 接到哪里 |
|---|---|
| `session=<id>&pane=agent` | 该会话的代理窗格（tmux `op-<id>`） |
| `session=<id>&pane=shell` | 该会话的工作区 shell（tmux `op-<id>-sh`，不存在则在工作目录里创建） |
| `server=<id>&pane=shell` | 该服务器上的一个普通登录 shell（不进 tmux，断开即结束） |
| `server=<id>&pane=install&agent=<agent_id>` | 安装任务的输出（tmux `op-install-<agent_id>`） |

帧：

- 服务端 → 客户端 **二进制帧**：终端输出的原始字节。
- 服务端 → 客户端 **文本帧**：`{"type":"status","state":"connecting"|"connected"|"closed","detail":string|null}`。`closed` 之后服务端关闭连接。
- 客户端 → 服务端 **文本帧**：`{"type":"input","data":string}`、`{"type":"resize","cols":number,"rows":number}`。

断开 WebSocket 只是让本机的 ssh 客户端退出，服务器上的 tmux 会话不受影响。

## 7. 工作区：文件与改动

路径相对会话的 `workdir`；也接受绝对路径和 `~`。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/sessions/:id/files?path=` | `{path, parent: string\|null, entries: {name, kind: "dir"\|"file"\|"link", size, mtime}[]}`，目录在前、按名排序，最多 2000 项 |
| `GET /api/sessions/:id/file?path=` | `{path, size, binary: boolean, truncated: boolean, text: string\|null}`，文本最多 512 KB |
| `GET /api/sessions/:id/git` | `{is_repo, branch, changes: {path, status}[]}`，`status` 是 `git status --porcelain` 的两位状态码 |
| `GET /api/sessions/:id/git/diff?path=` | `{diff}`：该文件（省略则全部）相对 HEAD 的统一差异，最多 512 KB |

## 8. 科研面板

`GET /api/sessions/:id/research` →

```ts
{
  present: boolean;              // workdir 下是否有研究目录（research/PROJECT.md）
  home: string;                  // 研究目录，默认 "research"
  loop: { on: boolean; started: string | null; blocked: string | null };
  state_md: string | null;       // STATE.md
  summary_md: string | null;     // SUMMARY.md
  ideas_md: string | null;
  ledger_md: string | null;
  runs: { run_id: string; kind: string; state: string; exit_code: number | null; host: string;
          started_at: string; elapsed: string; note: string }[];   // rk.py status --json
}
```

研究目录不存在时 `present=false`，其余字段为 `null` / 空。

## 9. 数据目录

本机（macOS `~/Library/Application Support/outpost`，Linux `~/.local/share/outpost`，可用 `OUTPOST_DATA_DIR` 覆盖）：

```
config.toml      设置（不含密钥）
servers.json     服务器
sessions.json    会话
agents.json      自定义与被覆盖的 Agent
keys/            私钥（0600）与公钥
ssh/config       生成的 ssh 配置：每台服务器一个 “Host <别名> op-<id>” 块
ssh/known_hosts
```

ControlMaster 套接字放在 `~/.cache/outpost/cm/`（路径要短）。

服务器上（都在 `~/.outpost/` 下，不碰别处）：

```
tmux.conf            专用配置；所有会话都跑在专用套接字 `tmux -L outpost` 上
sessions/<id>.json   会话元数据（标题、Agent、工作目录、创建时间），供别的机器发现
plugins/<name>/      同步过来的插件
```

## 10. 命令行与 MCP

同一个可执行文件 `outpost`，三种入口共用核心库：

```
outpost serve [--port 7878] [--no-open] [--dev]
outpost servers | import <文件...> | test <别名> | probe <别名>
outpost agents
outpost sessions [--refresh]
outpost deploy --server <别名> --agent <id> --workdir <路径> [--title T] [--prompt P] [--yolo] [--plugin research]
outpost attach <会话id> [--shell]      在当前终端里直接接入
outpost send <会话id> <文字> | capture <会话id> [--lines N] | stop <会话id>
outpost mcp                            标准输入输出上的 MCP 服务
```

所有子命令支持 `--json`。MCP 工具：`server_list` `server_test` `server_probe` `agent_list` `session_list` `session_deploy` `session_send` `session_capture` `session_stop`，参数与返回值同对应的 HTTP 接口。

## 11. 科研增强（v1.1）

在 v1 之上新增，旧接口不变。

### 11.1 原始文件

`GET /api/sessions/:id/raw?path=` → 文件原始字节。响应头固定为 `Content-Type: application/octet-stream`、`X-Content-Type-Options: nosniff`、`Content-Disposition: attachment`（服务器上的文件不可信，不能让它在本服务的源里被当成页面解析；前端自己按扩展名决定怎么显示）。上限 32 MB，超出返回 `bad_request`。

### 11.2 产物

`GET /api/sessions/:id/artifacts?limit=300` →

```ts
{ items: Artifact[]; truncated: boolean }
type Artifact = {
  path: string;      // 相对 workdir
  name: string;
  kind: "image" | "pdf" | "table" | "notebook" | "html" | "doc";
  size: number;
  mtime: string;     // RFC 3339
};
```

在 workdir 下递归查找（深度 ≤ 8），按修改时间倒序，最多 `limit` 条（上限 1000）。
- 跳过目录：以 `.` 开头的、`node_modules` `__pycache__` `venv` `env` `site-packages` `wandb` `checkpoints`。
- 按扩展名归类：image = png jpg jpeg gif webp svg；pdf = pdf；table = csv tsv xlsx parquet；notebook = ipynb；html = html htm；doc = md tex docx，但 doc 只收路径里含 `results` `reports` `report` `paper` `papers` `figures` `outputs` `output` 目录段的文件。
- 不依赖 GNU 专有选项（Alpine/BusyBox 也要能跑）；服务器有 python3 时可以用 python3 实现，没有则退回 find + stat。

### 11.3 研究记录

`GET /api/sessions/:id/research` 的返回值增加字段：

```ts
{
  overview_md: string | null;   // OVERVIEW.md
  lessons_md: string | null;    // LESSONS.md
  log_tail: string | null;      // LOG.md 最后 120 行
  prereg: { name: string; title: string }[];   // prereg/*.md（不含 TEMPLATE.md），title 取第一个标题行
  results: { name: string; title: string }[];  // results/*.md（不含 TEMPLATE.md）
}
// runs[] 的每一项增加（取自 runs/<run_id>/meta.json，缺失为 null）：
{ cmd: string | null; cwd: string | null; ended_at: string | null; prereg: string[];
  commit: string | null; dirty: boolean | null; has_metrics: boolean; has_result: boolean }
```

`GET /api/sessions/:id/research/run?run_id=&lines=200` →

```ts
{ run_id: string; meta: object;            // meta.json 原样
  log_tail: string;                        // runs/<id>/log.txt 最后 lines 行（≤ 2000）
  metrics: object | null;                  // metrics.json（≤ 64 KB）
  result_md: string | null }               // results/<id>.md
```

`run_id` 只接受 `[A-Za-z0-9._-]{1,64}`，其余返回 `bad_request`。

### 11.4 显卡进程

`Gpu` 增加：

```ts
{ temp_c: number | null;
  apps: { pid: number; user: string; mem_mb: number; name: string }[] }  // 该卡上的计算进程，没有则 []
```

`GET /api/servers/:id/gpus` 与探测结果里的 `gpus` 都带这两个字段。`procs` 仍是 `apps.length`。

### 11.5 主机笔记

每台服务器一份 Markdown：`~/.outpost/HOST.md`。人和 Agent 都可以读写，用来积累“这台机器怎么用”的已验证事实（环境、数据位置、踩过的坑）。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/servers/:id/notes` | `{text: string, exists: boolean}`；文件不存在时 `text=""` |
| `PUT /api/servers/:id/notes` | 体 `{text}`（≤ 256 KB）→ `{text, exists: true}` |

探测成功且该文件不存在时，写入一份由探测结果生成的初稿（主机名、系统、CPU/内存、显卡、tmux、已装 Agent、日期），之后不再自动覆盖。

MCP 增加工具：`session_artifacts`、`research_show`、`host_notes_get`、`host_notes_set`。

### 11.6 插件随部署下发（v1.2）

科研插件内嵌在可执行文件里（源在 `plugins/research/`），部署时默认整套同步到服务器，不需要先配置路径。

```ts
type Plugin = {
  name: string;                 // 目录名，如 "research"
  version: string;              // 取自 .claude-plugin/plugin.json，没有则 ""
  description: string;
  source: "bundled" | "local";  // local：来自 Settings.plugin_paths
  path: string | null;          // local 的本机路径
  skills: string[];             // skills/*/SKILL.md 的目录名
  agents: string[];             // agents/*.md 的文件名（不含扩展名）
  hooks: boolean;               // 有 hooks/hooks.json
};
```

| 方法与路径 | 说明 |
|---|---|
| `GET /api/plugins` | `Plugin[]`：内嵌的在前，然后是 `Settings.plugin_paths` 里的目录；同名时本机目录覆盖内嵌的 |

- `Settings` 增加 `plugin_paths: string[]`（默认 `[]`）。原有的 `research_plugin_path` 保留：非空时等价于把它加进 `plugin_paths`（覆盖内嵌的 research）。
- `Agent` 增加 `plugin_prompt: string | null`：Agent 没有 `plugin_dir_flag` 时用它；含 `{dirs}` 占位符（逗号分隔的远程插件目录）。内置 Agent 里除 Claude Code 外都给一个默认值，大意是“科研流程文档在 {dirs}，开始前先读其中的 skills/orchestrator/SKILL.md 与 skills/protocol/SKILL.md 并照做”。
- `POST /api/sessions` 体增加 `plugins?: string[]`。**省略时 = 全部可用插件**；`[]` 表示不带。旧字段 `plugin` 仍接受：`"research"` 等价 `plugins:["research"]`，`null` 等价 `[]`；两者都给时以 `plugins` 为准。
- `Session` 增加 `plugins: string[]`；`plugin` 保留，值为 `plugins[0] ?? null`。
- 部署的 `plugin` 步：把选中的每个插件同步到 `~/.outpost/plugins/<name>/`（先同步到临时目录再原子替换）。**不下发**：`.git` `.claude` `tests` `node_modules` `keys` `secrets` 目录，以及 `id_*` `*.pem` `*.key` `lab.md` `.env*` 文件。`detail` 形如 `research · 8 个技能`。一个都没选时 `skipped`。
- 启动命令：Agent 有 `plugin_dir_flag` 时每个插件各追加一次；没有而 `plugin_prompt` 非空时，把它放在初始提示前面（没有初始提示就单独作为初始提示）。`restart` 用同样的参数（接续时不重复加提示）。
- 命令行：`outpost deploy` 默认带全部插件，`--no-plugins` 关闭，`--plugin <名>` 可多次指定。MCP `session_deploy` 同理（`plugins` 参数）。新增 `outpost plugins`、MCP `plugin_list`。
