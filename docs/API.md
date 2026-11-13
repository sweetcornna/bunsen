# Bunsen 接口约定（v1）

前端（`ui/`）与核心（`crates/`）之间唯一的约定。两边都只照这份文档写；要改接口先改这里。

## 0. 总则

- 服务只监听 `127.0.0.1:<port>`（默认 7878）。
- **鉴权**：启动时生成随机令牌。所有 `/api/*` 请求带请求头 `x-bunsen-token: <token>`；WebSocket 用查询参数 `?token=<token>`。缺失或不符返回 401。
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
// 部署步骤固定顺序：connect → tmux → agent → workdir → project → plugin → start → verify（project 见 12.2）

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

本机（macOS `~/Library/Application Support/bunsen`，Linux `~/.local/share/bunsen`，可用 `BUNSEN_DATA_DIR` 覆盖）：

```
config.toml      设置（不含密钥）
servers.json     服务器
sessions.json    会话
agents.json      自定义与被覆盖的 Agent
keys/            私钥（0600）与公钥
ssh/config       生成的 ssh 配置：每台服务器一个 “Host <别名> op-<id>” 块
ssh/known_hosts
```

ControlMaster 套接字放在 `~/.cache/bunsen/cm/`（路径要短）。

服务器上（都在 `~/.bunsen/` 下，不碰别处）：

```
tmux.conf            专用配置；所有会话都跑在专用套接字 `tmux -L bunsen` 上
sessions/<id>.json   会话元数据（标题、Agent、工作目录、创建时间），供别的机器发现
plugins/<name>/      同步过来的插件
```

## 10. 命令行与 MCP

同一个可执行文件 `bunsen`，三种入口共用核心库：

```
bunsen serve [--port 7878] [--no-open] [--dev]
bunsen servers | import <文件...> | test <别名> | probe <别名>
bunsen agents
bunsen sessions [--refresh]
bunsen deploy --server <别名> --agent <id> --workdir <路径> [--title T] [--prompt P] [--yolo] [--plugin research]
bunsen attach <会话id> [--shell]      在当前终端里直接接入
bunsen send <会话id> <文字> | capture <会话id> [--lines N] | stop <会话id>
bunsen mcp                            标准输入输出上的 MCP 服务
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

每台服务器一份 Markdown：`~/.bunsen/HOST.md`。人和 Agent 都可以读写，用来积累“这台机器怎么用”的已验证事实（环境、数据位置、踩过的坑）。

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
- 部署的 `plugin` 步：把选中的每个插件同步到 `~/.bunsen/plugins/<name>/`（先同步到临时目录再原子替换）。**不下发**：`.git` `.claude` `tests` `node_modules` `keys` `secrets` 目录，以及 `id_*` `*.pem` `*.key` `lab.md` `.env*` 文件。`detail` 形如 `research · 8 个技能`。一个都没选时 `skipped`。
- 启动命令：Agent 有 `plugin_dir_flag` 时每个插件各追加一次；没有而 `plugin_prompt` 非空时，把它放在初始提示前面（没有初始提示就单独作为初始提示）。`restart` 用同样的参数（接续时不重复加提示）。
- 命令行：`bunsen deploy` 默认带全部插件，`--no-plugins` 关闭，`--plugin <名>` 可多次指定。MCP `session_deploy` 同理（`plugins` 参数）。新增 `bunsen plugins`、MCP `plugin_list`。

## 12. 本机执行与研究项目（v1.3）

研究工作台 v2 第三期新增，旧接口不变；总则沿用第 0 节。正文里的【A1】【G1】等标记对应 12.8 的修订表。

### 12.0 约定

- 鉴权：所有 `/api/*` 带 `x-bunsen-token`，缺失或不符 401；同第 0 节。
- 错误体：`{"error": {"code", "message", "hint"}}`，`message`、`hint` 是可直接显示的中文。本轮不新增错误码，只用：`not_found` 404、`bad_request` 400、`conflict` 409、`host_unreachable` 502、`ssh_failed` 502、`auth_failed` 502、`timeout` 504、`internal` 500（`auth_failed` 只在沿用执行出错时出现，见 G6）【G10】。
- 长度一律按 Unicode 字符计，不按字节或 UTF-16 计【G11】。
- 凡是返回或保存的报错、警告、`detail`、`fetch_error` 文本（含其中转述的 git、ssh、rk 输出），URL 里的用户信息一律遮成 `***`（`https://***@host/…`），在写入或返回之前统一处理，不依赖 git 自己遮【G20】。
- 时间一律 RFC 3339 字符串；可空字段返回 `null`，不省略。

### 12.1 本机作为一台服务器

类 Unix 系统上，`GET /api/servers` 总有一条本机记录：

```json
{ "id": "local", "alias": "local", "host": "localhost", "user": "<本机用户>", "port": 22,
  "key": null, "proxy_jump": null, "proxy_command": null, "source": "local",
  "note": "本机：会话跑在这台电脑的 tmux 里，不经 ssh", "default_workdir": "~", ... }
```

- `Server.source` 取值新增 `"local"`（原有 `"upload" | "manual"`）。`id` 固定为 `"local"`，别名已被占用时依次用 `local2`、`local3`…
- 数据目录第一次打开时插到列表最前面；环境变量 `BUNSEN_NO_LOCAL=1` 时不建。已经建过的本机记录在设了这个变量时保留在 `servers.json` 里，但一律当作不存在：服务器列表（HTTP、命令行、MCP）不列出，按 id 访问返回 `not_found`，不能部署到本机，本机上已有的会话按“服务器已删除”处理；去掉变量后照常出现【G15】。所有接口（HTTP、WebSocket、命令行、MCP）里指定服务器的参数仍然接受 id 或别名，和原来一样；只有保留 id `local` 例外：它永远指本机，本机记录被隐藏或不存在时返回 `not_found`，不会按别名匹配到一台别名叫 local 的远程服务器【G24】。Windows 上没有。
- 本机上的所有操作（测试、探测、显卡、主机笔记、部署、send/keys/capture/restart/stop/delete、文件、git、科研面板、产物、终端）与远程服务器同一套接口、同一套行为；差别只在执行方式（本机 `bash -s`，不经 ssh）。
- 规则：
  - `DELETE /api/servers/local` → 400 `bad_request`，`hint` 说明可以用 `BUNSEN_NO_LOCAL=1`。
  - `PATCH /api/servers/local` 只接受 `alias`、`note`、`default_workdir`；改 `host`、`user`、`port`、`key`、`proxy_jump`、`proxy_command` 任一项 → 400。带了这些字段但值与现值相同不算改动【G4】。
  - `POST /api/servers/local/test` 不尝试密钥（`try_all_keys` 忽略），`key_used` 为 `null`。
  - 导入的 ssh 配置里有与本机同名的 `Host` → 跳过并在 `warnings` 里说明，不改本机记录。
  - 本机不写进生成的 `ssh/config`。
- 本机上的会话：`attach_cmd` 为 `tmux -L bunsen attach-session -t '=op-<id>'`；部署步骤 `connect` 的 `label` 为“检查本机”，`detail` 为“本机（<用户>）”；插件直接复制到 `~/.bunsen/plugins/<名>`，`detail` 不带 rsync/tar 说明。
- 终端（`/ws/term?server=local&pane=shell` 等）在本机伪终端里直接跑 `bash -lc …`；`pane=shell` 不带会话时开用户的登录 shell。
- 本机执行时去掉环境变量 `CLAUDECODE`、`CLAUDE_CODE_*`、`TMUX`、`TMUX_PANE`，免得本机 tmux 里的代理以为自己是嵌套会话。

### 12.2 会话与部署的变化

`Session` 新增两个字段（旧记录读出为 `null`）：

```ts
type Session = { /* 原有字段 */
  project_id: string | null;   // 部署时接入的研究项目
  machine: string | null;      // 这台机器在项目里的代号（rk id），对应汇合点上的 sync/<代号>
};
```

`POST /api/sessions`（部署）请求体新增 `project_id?: string`（id 或 name）。找不到这个项目时，在任何步骤开始之前就拒绝，`error.code` 为 `not_found`，和服务器、Agent 不存在一样，不留下任何步骤和副作用；传输方式按第 5 节“部署”：流式时只有一行 `{"type":"error",…}`，非流式时 422 `{error, steps: []}`【G5】。带上时，在 `workdir` 与 `plugin` 两步之间多一步：

| step | label | 说明 |
| --- | --- | --- |
| `project` | 接入研究项目 | 没带 `project_id` 时为 `skipped`，`detail` “未接入研究项目” |

`project` 这一步在目标服务器的工作目录里依次：

1. 按 12.4 算出这台服务器访问汇合点用的地址；算不出（汇合点在另一台 Bunsen 服务器上、这台连不过去）→ 步骤失败，`bad_request`，`hint` 建议改用各台机器都能访问的汇合点（例如私有 GitHub 仓库）。
2. 工作目录不是 git 仓库：目录非空 → 失败（`bad_request`，“工作目录不是空的，也不是 git 仓库”）；否则 `git clone -b <研究分支> <地址> .`；汇合点上还没有研究分支时 `git clone <地址> .`；汇合点是空的 → 失败（`bad_request`，`hint`：先在一台已有仓库的机器上部署，它会推上研究分支）。
3. 工作目录已是 git 仓库：已有某个远程的地址等于汇合点地址就用它；否则加名为 `hub` 的远程（`hub` 已存在且地址不同 → 失败 `conflict`）。然后 `git fetch`。
4. 仓库里没有 `user.email` 时设仓库级的 `user.name = "<机器代号或主机名> (bunsen)"`、`user.email = "bunsen@<主机名>.invalid"`，`detail` 里说明。
5. 设仓库级 git config：`rk.branch = <研究分支>`、`rk.hub = <远程名>`。
6. 有 `<研究目录>/tools/rk.py` 时执行 `python3 <研究目录>/tools/rk.py sync --setup --json`，取输出最后一行 JSON 的 `machine` 记到会话的 `machine`；`ok` 为假时步骤仍记 `ok`，`detail` 写同步没完成的原因（`error` 或冲突文件）。没有 `rk.py` 时 `machine` 为 `null`，`detail` 写“仓库里还没有研究目录：/research:start 之后执行 rk sync --setup（研究分支已写进 git config）”。`rk.py` 是没有 `sync` 的旧版（`python3 <研究目录>/tools/rk.py sync --help` 退出码非 0）时不执行 `--setup`，`machine` 为 `null`，步骤记 `ok`，`detail` 写“仓库里的 rk.py 是旧版，没有 sync：在这台机器上执行 /research:resume（会更新研究工具）后再执行 rk sync --setup（研究分支已写进 git config）”【G18】。
7. 本机克隆、访问 Bunsen 服务器上的汇合点时，在本机仓库里设 `core.sshCommand = ssh -F '<Bunsen 的 ssh/config>' -o BatchMode=yes`。

`project` 一步的错误码【G6】：取不到汇合点 → `host_unreachable`；目标机器本身连不上 → 沿用执行时的错误（`host_unreachable`、`ssh_failed`、`auth_failed`、`timeout`）；其余见上面各条。部署失败的传输方式不变（NDJSON 流里的 `error` 行；非流式时沿用原有状态码），`error.code` 按本条。

远端元数据 `~/.bunsen/sessions/<id>.json` 同样带 `project_id`、`machine`，发现来的会话据此恢复。

### 12.3 研究项目

#### 12.3.1 数据类型

```ts
type Project = {
  id: string;              // 短 id，6 位小写字母数字
  name: string;            // 唯一，去首尾空白后 1 到 40 个字符，单行，不含 "/"【A2】
  hub: string;             // 汇合点：git 地址，或 "<Bunsen 服务器别名>:<路径>"
  branch: string;          // 研究分支，见 12.3.3【A1】
  home: string;            // 仓库里的研究目录，默认 "research"；相对路径，整串不含 ".."，不以 "/" 开头【G12】
  created_at: string;
  fetched_at: string | null;   // 上次成功取汇合点的时间
  fetch_error: string | null;  // 上次取汇合点失败的原因；成功后清空
};

type ProjectMember = {     // 接入这个项目的会话（session.project_id == project.id，未归档）
  session_id: string; title: string; server_id: string; server_alias: string;
  workdir: string; state: SessionState; machine: string | null;
};

type ProjectMachine = {    // 汇合点上的一个 sync/<代号> 分支
  code: string;            // 代号
  head: string;            // 分支最新提交（40 位）
  committed_at: string | null;
  subject: string;         // 最新提交的说明（首行）
  ahead: number;           // 研究分支还没有的提交数
  behind: number;          // 这台机器还没并入的研究分支提交数
  conflict: boolean | null;// ahead>0 且 behind>0 时：并入研究分支会不会冲突；其余情况或判断不了时为 null
  sessions: string[];      // machine == code 的成员会话 id
  server_alias: string | null; // 这些会话所在服务器的别名（多台时取第一个）
};

type ProjectLine = {       // 一条研究线：<home>/state/<线>.md（不含 TEMPLATE.md）
  line: string;
  holder: string | null;   // 开头的 holder；"-" 或缺省为 null
  token: number;           // 开头的 token；缺省为 0
  stamped: string | null;
  stage: string | null;    // 正文 **阶段**：…；值是模板占位（以 `<` 开头、以 `>` 结尾）时为 null【G21′】
  waiting: string | null;  // 正文 **在等什么**：…；同上【G21′】
  updated: string | null;  // 正文 **最后更新**：…
  next: string[];          // “## 下一步”一节的前 3 个列表项（原文，去掉行首空白；跳过模板占位项【G21′】）
  source: string;          // 取自哪个分支，如 "research/demo" 或 "sync/mac"
};

type ProjectRun = {        // 一条运行：<home>/runs/<运行ID>/meta.json
  run_id: string;
  machine: string | null;  // meta.machine_name；旧记录为 null
  kind: string;            // meta.kind
  state: "ok" | "failed" | "open";
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  line: string | null;     // meta.line
  note: string;
  has_metrics: boolean;    // 同一份里有 metrics.json
  integrated: boolean;     // 研究分支里有这条运行
  source: string;          // 取自哪个分支
};

type ProjectView = {
  project: Project;
  research_head: string | null;   // 研究分支最新提交；汇合点上还没有研究分支时为 null
  machines: ProjectMachine[];     // 按 code 排序
  lines: ProjectLine[];           // 按 line 排序
  runs: ProjectRun[];             // 按 started_at 倒序，缺 started_at 的排最后；最多 500 条
  members: ProjectMember[];
  decisions: string | null;       // 研究分支上 <home>/SUMMARY.md 里标题含“需要你决定”的那一节正文（去首尾空白），没有为 null；整行是模板占位（去掉列表符号后以 `<` 开头、以 `>` 结尾）的行不算正文，剩下的为空或只有“无”时也为 null【G21】
  warnings: string[];             // 可直接显示的中文提示
};

type MemberSync = {
  session_id: string; server_alias: string;
  title: string;                  // 会话标题【A3】
  ok: boolean;
  detail: string;                 // 一行中文：完成 / 冲突的文件 / 失败原因
  result: object | null;          // rk sync --json 的原始输出（最后一行 JSON）
};

type ProjectSync = { members: MemberSync[]; view: ProjectView };
```

成员仓库里有未提交内容时，`rk sync` 的合并和 git 本身的规则一致【G25】：
- 能快进时照常快进；已暂存、未暂存的内容原样保留，快进会改到的路径有本地改动时 git 拒绝，什么都不动。
- 需要真正合并时，暂存区必须和 HEAD 一致；有任何暂存内容（含部分暂存）就不合并：研究分支不动，本机的 sync 分支照样推上去，`ok` 为假，`detail` 写“暂存区有未提交的内容，这次没有并入 <分支>：提交或取消暂存后再执行 rk sync”。不算冲突。
- `rk sync` 不另建临时索引；HEAD 一旦移动就不再回滚。合并已完成而仓库的 git hook 超时或失败时，按合并完成报告，`detail` 另写 hook 没有正常结束。

#### 12.3.2 接口

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/projects` | | `Project[]`，按 `created_at` 升序 |
| POST | `/api/projects` | `NewProject` | 201 `Project` |
| GET | `/api/projects/:id` | | `Project`（`:id` 可以是 id 或 name，下同；先按 id 找，找不到再按 name） |
| DELETE | `/api/projects/:id` | | 204 |
| GET | `/api/projects/:id/view` | 查询参数 `refresh=1` 可选 | `ProjectView` |
| POST | `/api/projects/:id/sync` | 无请求体 | `ProjectSync` |

```ts
type NewProject = {
  name: string;
  hub: string;
  branch?: string;     // 缺省：汇合点上恰好一个 research/* 时取它；没有时按 12.3.3 由 name 规整出简称
  home?: string;       // 缺省 "research"
  create?: boolean;    // 汇合点是 "<服务器别名>:<路径>"（含本机）且路径不存在时，在那里 git init --bare；git 地址时忽略；默认 false
};
```

#### 12.3.3 研究分支名【A1、G1】

- 合规：`^research/[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$`（只认 ASCII，简称最多 40 个字符），并且简称里没有 `..`、不以 `.` 或 `.lock` 结尾。后端、前端、研究插件 `rk.py`（`rk sync --setup --branch`）用同一条规则。
- 缺省简称：取名称里的 ASCII 字母、数字、`_`、`-`，其余每一段连续字符换成一个 `-`；去掉首尾的非字母数字；截到 40 个字符后再去一次尾部的非字母数字；结果为空时用 `main`。`rk sync --setup` 从仓库目录名推研究分支时用同一规则。

**POST /api/projects**

- 校验：`name` 去首尾空白后非空、≤ 40 字符、单行、不含 `/`、不能是 `.` 或 `..`（浏览器会把路径里的这两段规整掉）【G19】；`hub` 非空、单行、不含空白；`branch`、`home` 合规。不合规 → 400。`name` 已存在 → 409。
- `hub` 写成 `<别名>:<路径>` 且别名是 Bunsen 里的远程服务器 → 指那台服务器上的裸仓库；`create: true` 且路径不存在时在那里 `git init --bare -q`。`local:<路径>` 永远指本机，没有本机记录时（`BUNSEN_NO_LOCAL=1`、Windows）也一样：镜像照样从本机路径取，只是没有本机会话可以接入【G13】；本机改过别名时，`<本机的别名>:<路径>` 也指本机。`create` 对本机同样生效。其余一律当作 git 地址原样使用（含 `git@github.com:…`）。
- 在数据目录 `hubs/<id>.git` 建只读镜像并取一次（12.4）。取不到 → 502 `host_unreachable`，不保存项目，`message` 带 git 报错的要点（见 12.4“git 报错摘要”）【G22】。
- 没给 `branch` 且汇合点上有不止一个 `research/*` → 400，`hint` 列出这些分支。
- 汇合点可以是空的（还没有任何分支），此时保存项目，`fetched_at` 有值。

**DELETE /api/projects/:id**：删除记录和镜像目录。接入它的会话保留，`project_id` 不动；前端把找不到的项目显示为“（已删除的项目）”。

**GET /api/projects/:id/view**

- 镜像上次成功取得超过 20 秒、或带 `refresh=1` 时，先取一次。取失败不报错：用镜像里已有的内容出视图，`project.fetch_error` 写原因，`warnings` 加一条“取不到汇合点：…，显示的是 <fetched_at> 的内容”，`<fetched_at>` 写成 `YYYY-MM-DD HH:MM UTC`；从没取成功过时整句写成“取不到汇合点：…，还没有成功取得过汇合点”【G7】。
- 同一项目的取镜像同一时刻只做一次（并发请求等它完成后共用结果）。

**POST /api/projects/:id/sync**

- 对每个成员会话（未归档；服务器存在）在其服务器上执行 `cd <workdir> && python3 <home>/tools/rk.py sync --json`，各会话并发，每个限时 200 秒。
- 退出码 0 → `ok: true`；1 → `ok: false`，`detail` 取 JSON 里的冲突文件或 `error`；找不到 `rk.py`、连不上 → `ok: false`，`detail` 写原因，`result: null`。`rk.py` 是没有 `sync` 的旧版（判断同 12.2 第 6 条，在同一个脚本里探测）→ `ok: false`，`result: null`，`detail` 写“这台机器上仓库里的 rk.py 是旧版，没有 sync：在那里执行 /research:resume 更新研究工具”【G18】。
- 都完成后带 `refresh=1` 的语义重新出视图，放进 `view`。没有成员时 `members: []`，照样返回视图。

### 12.4 汇合点与视图的推导规则

**访问地址**

| 汇合点写法 | 镜像（本机）用的地址 | 本机会话 | 汇合点所在的服务器 S 上的会话 | 其他服务器上的会话 |
| --- | --- | --- | --- | --- |
| git 地址 | 原样 | 原样 | 原样 | 原样 |
| `<S 的别名>:<路径>` | `op-<S.id>:<路径>`，经 Bunsen 的 ssh 配置 | 同左，仓库里设 `core.sshCommand` | 本地路径（相对路径相对 `$HOME`，`~/` 展开） | 不支持，部署失败 |
| `local:<路径>` | 本地路径 | 本地路径 | — | 不支持，部署失败 |

所有 git 子进程：`GIT_TERMINAL_PROMPT=0`，标准输入为空（唯一例外：`git cat-file --batch` 的标准输入是去重后的对象哈希），取汇合点限时 120 秒。

传输限制【G16】：Bunsen 起的 git 子进程（镜像，以及部署 `project` 一步在目标机器上执行的 git）和研究插件 `rk.py` 的 git 子进程，只允许 `file`、`git`、`http`、`https`、`ssh` 几种传输，用环境变量 `GIT_ALLOW_PROTOCOL=file:git:http:https:ssh`，不受用户 git 配置影响。`ext::` 等其他写法的地址在取汇合点时失败（建项目时 502 `host_unreachable`，`message` 带 git 的报错），校验规则不变。

**镜像**：`<数据目录>/hubs/<项目 id>.git`，裸仓库；取 `+refs/heads/research/*:refs/heads/research/*` 和 `+refs/heads/sync/*:refs/heads/sync/*`，带 `--prune`。只读，不往汇合点推任何东西。

**机器**：每个 `sync/<代号>` 一条。`ahead`/`behind` 用 `git rev-list --left-right --count <研究分支>...sync/<代号>`；研究分支不存在时 `ahead` 为该分支的提交总数、`behind` 为 0。`conflict` 用 `git merge-tree --write-tree --quiet`：退出码 1 为冲突，0 为不冲突，其他（含 git 太旧）为 `null`。

**研究线**：在研究分支和所有 `sync/*` 分支里收集 `<home>/state/*.md` 的每一份，按 `(token, 是否取自 sync/<该份的 holder>, stamped)` 取最大的一份。即：编号大的为准；编号相同时以推进者自己分支上的那份为准（它最新）。

**运行**：在研究分支和所有 `sync/*` 分支里收集 `<home>/runs/<ID>/meta.json`。同一个 ID 有几份时，有结束记录（目录里有 `exit_code` 文件，或 meta 里有 `exit_code`）的优先，其次研究分支上的那份。`state`：退出码 0 为 `ok`，非 0 为 `failed`，没有退出码为 `open`。`integrated`：研究分支里有这个运行目录。

**警告**（`warnings`，按出现顺序）：

- 取不到汇合点（见上）。
- 汇合点上还没有研究分支：“汇合点上还没有 <分支>：在一台机器上部署接入本项目，或在仓库里执行 rk sync --setup”。
- 某台机器 `conflict == true`：“<代号> 的记录并入 <分支> 会冲突，要在那台机器上解决（rk sync 会列出冲突的文件）”。
- 某台机器 `behind > 0` 且最新提交早于 24 小时：“<代号> 已经 N 小时没有同步”。
- 成员会话 `machine` 为空：“会话 <标题> 还没有机器代号：仓库里有研究目录后在那里执行 rk sync --setup”。
- 有文件因过大或过多没有读入（见下面的读取上限）：“汇合点里有 N 个文件过大或过多，没有读入视图”【G14】；N 按去重后的路径计，同一路径在几个分支上都没读只算 1 个【G23】。

读 git 对象用一次 `git ls-tree -r` 每分支、一次 `git cat-file --batch`（按对象哈希去重），不要逐文件起进程。

git 报错摘要【G22】：凡是要把 git（及其底下的 ssh）的报错写进 `message`、`fetch_error`、警告或步骤 `detail` 的地方，去掉空行和 git 的固定提示（`Please make sure you have the correct access rights`、`and the repository exists.`），保留最后最多 3 行，用“；”连接，再按 G20 脱敏，截到 300 个字符。

读取上限【G14】：`ls-tree` 只列 `<home>` 下（按字面路径，不做 pathspec 匹配），边读边筛，只留下视图用得到的路径，每个分支最多留 20000 条，超出的不读。读正文前按 `ls-tree -l` 给出的大小判断：单个对象超过 1 MiB 不读，当作没有这份；一次出视图读入的正文合计最多 64 MiB，之后的不读。有没读的文件时，`warnings` 末尾加一条“汇合点里有 N 个文件过大或过多，没有读入视图”。

### 12.5 命令行与 MCP

命令行（输出风格同现有子命令，`--json` 输出与 HTTP 相同的 JSON）：

```
bunsen projects [--json]
bunsen project add <名称> <汇合点> [--branch research/<简称>] [--home research] [--create] [--json]
bunsen project view <项目> [--refresh] [--json]
bunsen project sync <项目> [--json]
bunsen project rm <项目>
bunsen deploy … [--project <项目>]
```

MCP 新增工具 `list_projects`、`project_view`（参数 `project`、`refresh?`）、`project_sync`（参数 `project`）；部署工具新增可选参数 `project_id`。

### 12.6 数据目录

新增 `projects.json`（项目列表，权限 600，与 `servers.json` 同样的读改写方式）和 `hubs/<项目 id>.git/`（镜像，可随时删掉重建）。`sessions.json` 里的会话记录多两个可空字段。旧数据目录无需迁移。

跨进程互斥【G17】：serve、命令行、MCP 三个进程共用数据目录。所有 JSON 文件的读改写在数据目录的 `.lock` 上加文件锁；每个镜像的取、读视图、删除在 `hubs/<项目 id>.lock` 上加文件锁，删除项目时锁文件可以留下。用 Rust 标准库的文件锁，不引入新依赖。

### 12.7 前端

- 新页面“研究项目”：项目列表；新建项目表单（名称、汇合点、研究分支、研究目录、“在服务器上新建裸仓库”）；项目视图（机器表、研究线表、运行表、成员会话、需要你决定的事、警告），“刷新”按钮（`refresh=1`）和“立即同步”按钮（`POST …/sync`，逐会话显示结果）。
- 部署对话框：可选“接入研究项目”下拉框（`project_id`）；部署步骤里显示 `project` 一步。
- 服务器列表：`source == "local"` 显示“本机”标签，不显示删除按钮，编辑表单只给别名、备注、默认工作目录。
- 会话：有 `project_id` 时显示项目名（项目已删除时显示“（已删除的项目）”）和机器代号。

### 12.8 修订记录

第三期开发中对已确认契约（2026-11-12）的修订，均在 2026-11-13。A 类经用户确认；G 类是主编排对没写清之处的裁定，来源是前后端审查、联调和端到端验证。

| 编号 | 内容 | 位置 |
| --- | --- | --- |
| A1 | 研究分支名只认 ASCII，简称最多 40 个字符，且必须是有效 git 分支名；`rk.py` 同步改 | 12.3.1、12.3.3 |
| A2 | 项目名称不能含 `/`（`:id` 可以写名称，`/` 会破坏路径） | 12.3.1、12.3.2 |
| A3 | `MemberSync` 加 `title`（会话标题），同一台服务器上有几个会话时分得清 | 12.3.1 |
| G1 | 缺省研究分支的规整规则；规整不出时用 `research/main` | 12.3.3 |
| G2 | `create` 对本机同样生效；git 地址时忽略 | 12.3.2 |
| G3 | `local:` 永远指本机；本机改名后新别名也指本机 | 12.3.2 |
| G4 | PATCH 本机带了与现值相同的连接字段不算改动 | 12.1 |
| G5 | 部署时找不到 `project_id`：任何步骤之前 `not_found` | 12.2 |
| G6 | `project` 一步各种失败的错误码 | 12.2 |
| G7 | 警告里取得时间的写法 `YYYY-MM-DD HH:MM UTC` | 12.3.2 |
| G8 | `:id` 先按 id 找，再按 name | 12.3.2 |
| G9 | git 子进程标准输入为空的唯一例外是 `cat-file --batch` | 12.4 |
| G7′ | 从没取成功过时的警告写成整句，不做字面替换 | 12.3.2 |
| G10 | 错误码列表补上 `auth_failed`（沿用执行出错时） | 12.0 |
| G11 | 长度按 Unicode 字符计 | 12.0 |
| G12 | 研究目录“整串不含 `..`” | 12.3.1 |
| G13 | 没有本机记录时 `local:<路径>` 仍指本机路径 | 12.3.2 |
| G14 | 读汇合点对象的上限（路径数、单个对象、合计字节），超限时加一条警告 | 12.4 |
| G15 | `BUNSEN_NO_LOCAL=1` 时已建的本机记录也当作不存在（与删除提示的说法一致） | 12.1 |
| G16 | git 子进程只允许 file、git、http、https、ssh 传输 | 12.4 |
| G17 | JSON 读改写和镜像操作用跨进程文件锁 | 12.6 |
| G18 | 仓库里的 `rk.py` 是没有 `sync` 的旧版时，部署 `project` 一步和“立即同步”的处理（研究插件同时补上研究工具的升级） | 12.2、12.3.2 |
| G19 | 项目名称不能是 `.` 或 `..` | 12.3.2 |
| G20 | 报错、警告、detail、fetch_error 里的 URL 用户信息统一遮掉 | 12.0 |
| G21 | `decisions` 跳过 SUMMARY 模板占位行；只剩“无”或为空时为 null | 12.3.1 |
| G21′ | 研究线的 `stage`、`waiting`、`next` 同样跳过模板占位 | 12.3.1 |
| G22 | git 报错摘要：去掉固定提示，保留最后最多 3 行（原来只取最后一行，ssh 地址时真正原因会丢） | 12.3.2、12.4 |
| G23 | G14 警告里的 N 按去重后的路径计 | 12.4 |
| G24 | 指定服务器的参数接受 id 或别名；保留 id `local` 只指本机，不按别名回退 | 12.1 |
| G25 | rk sync 合并遵循 git 的规则：快进保留暂存内容；真正合并要求暂存区干净，否则不合并、不算冲突；HEAD 移动后不回滚 | 12.3.1 |
