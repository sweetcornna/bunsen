# Bunsen 核心设计（crates/）

接口约定以 `docs/API.md` 为准；本文只记核心内部怎么实现、为什么这样做，以及任务拆解。

## 结构

```
Cargo.toml                 工作区
rust-toolchain.toml        channel = "stable"
crates/core  (bunsen-core)
  agents.json              内置 Agent 数据表（include_str! 编进库，改数据只改这个文件）
  src/error.rs             错误码、ssh 失败识别
  src/model.rs             API 数据类型
  src/util.rs              id、令牌、时间、原子写
  src/store.rs             数据目录、JSON/TOML 持久化（进程内一把锁，每次读盘，写临时文件再 rename）
  src/sshconfig.rs         上传的 ssh 配置解析；生成 <数据目录>/ssh/config
  src/shell.rs             单引号转义、路径转义（保留 ~）、PATH 前导、启动命令拼装
  src/ssh.rs               调系统 ssh：`ssh -F cfg -o BatchMode=yes -T op-<服务器id> bash -s`，脚本走标准输入
  src/tmux.rs              远程 tmux 脚本与输出解析
  src/import.rs            上传内容识别（ZIP/私钥/公钥/配置/其他）与导入
  src/keys.rs              私钥存取、指纹（ssh-keygen -lf）
  src/probe.rs             探测脚本与解析、GPU
  src/sessions.rs          部署、状态刷新/发现、send/keys/capture/restart/stop/delete
  src/workspace.rs         文件、git、科研面板、产物、原始字节、运行详情（v1.1）
  src/plugins.rs           内嵌插件（rust-embed，源在 plugins/）与本机目录插件：过滤、可执行位、展开到 plugins-cache（v1.2）
  build.rs                 plugins/ 与 agents.json 变了就重编
  src/term.rs              本机伪终端里跑 ssh -tt（终端通道与 attach 用）
  src/core.rs              Core：对外的全部能力（服务、命令行、MCP 共用）
crates/cli   (bunsen-cli，可执行文件 bunsen)
  src/main.rs              clap 子命令
  src/http.rs              axum：鉴权/防跨站中间件、/api/*、/ws/term、内嵌 ui/dist
  src/mcp.rs               stdio 上的 MCP（JSON-RPC 2.0，逐行）
  build.rs                 ui/dist 变了就重编
  tests/itest.rs           走真实 HTTP 的集成测试（#[ignore]，dev/itest.sh 一条命令跑）
```

## 关键决定

1. **ssh 选项写进生成的配置文件**。`ssh/config` 末尾放一个 `Host *` 块（ControlMaster/ControlPath/ControlPersist/ServerAlive*/ConnectTimeout/StrictHostKeyChecking/UserKnownHostsFile/LogLevel），每台服务器一个 `Host <别名> op-<id>` 块。理由：
   数据目录默认在 `Application Support` 下，路径带空格，放进配置文件可以加双引号；ProxyJump 派生的 ssh 只继承 `-F`，不继承命令行 `-o`；`attach_cmd` 只要 `ssh -F <cfg> -t <别名> …` 就能在普通终端复用全部设置。命令行只额外加 `BatchMode=yes`（非交互）或 `-tt`（终端）。
2. **内部连接一律用 `op-<服务器id>` 这个名字**，改别名不影响连接与 ControlMaster。
3. **远程脚本**：`{ <PATH 前导>; <脚本>; } </dev/null` 整块送进 `bash -s`。外层花括号让 bash 先读完整个脚本再执行，`</dev/null` 防止脚本里的命令（例如某个代理的 `--version`）吃掉剩余脚本。需要传给远端的数据（send 的文字、元数据 JSON）用单引号转义嵌进脚本，不占用标准输入。插件 tar 回退是唯一例外（标准输入是 tar 流，远端命令是固定字符串）。
4. **tmux 输出分隔符用 `|`，不用制表符**：实测 tmux 3.6 会把 `-F` 格式里的制表符输出成 `_`。会话名、数字字段都不含 `|`，最后一个字段（命令名）用 splitn 保留余下内容。
5. **tmux 目标一律写成 `=op-<id>:`**（精确匹配会话），避免 `op-abc123` 前缀匹配到 `op-abc123-sh`。
6. **tmux.conf 用 `set -gq`**：老版本不认的选项静默忽略，不会因为配置错误让会话起不来或进入查看模式。新建会话时链式 `source-file` 一次，保证在 bunsen 套接字的 tmux 服务早于配置文件启动时 `remain-on-exit` 也生效。
7. **部署每步一次 ssh**（复用 ControlMaster，后续每步几十毫秒）：步骤状态与耗时是真实的；探测、状态刷新这类“取多项信息”的操作一次 ssh 取完。
8. **没有 `launch_with_prompt` 的 Agent 带初始提示部署**：先用 `launch` 启动，verify 通过后把提示粘贴进去并回车。
9. **restart**：tmux 会话在 → `respawn-pane -k`；不在 → 按原参数重建。本机找不到该 Agent（例如发现来的会话）→ `respawn-pane -k` 不带命令，重跑创建时的命令。
10. **持久化**：每次读写都在锁内重新读文件，允许 `serve`、命令行、MCP 三个进程共用一个数据目录而不互相覆盖（进程间仍可能有极短的竞争窗口，接受）。
11. **HTTP 状态码**：unauthorized 401、forbidden 403、not_found 404、bad_request 400、conflict 409、tmux_missing/agent_missing 422、ssh_failed/auth_failed/host_unreachable 502、timeout 504、internal 500。`auth_failed` 不用 401，免得界面误以为令牌失效。
12. **`--dev` 的跨域**：界面在 5173 直接请求 7878 会触发 CORS 预检，所以 dev 模式对放行的两个 Origin 回 CORS 头，预检 OPTIONS 不要求令牌。

13. **安装任务结束后留一个 shell**：tmux 3.6 把 “Pane is dead” 写在窗格最底行，客户端比 50 行矮时前面的输出被推进历史，看起来一片空白。
14. **v1.1 远程脚本仍是一次 ssh 取完**：研究面板把 STATE/…/LESSONS、LOG 末尾、prereg/results 标题、runs/*/meta.json 与 `rk.py status --json` 用分段标记一次带回；`rk.py` 不可用时只用 meta.json（state 为 ok/failed/unknown）。
15. **产物查找**：有 python3 用 os.walk，没有就 `find -mindepth 1 -maxdepth 8 … -prune … -exec stat {} +`（GNU/BusyBox 用 `stat -c`，BSD 用 `stat -f`）；两边都只吐 `大小|修改时间|路径`，归类、报告类目录过滤、排序、截断都在 Rust 里做，结果一致。`BUNSEN_REMOTE_NO_PYTHON=1` 强制走退路（测试用）。
16. **原始字节**：先 `stat` 判大小，超过 32 MB 直接拒绝，不传数据；`head -c` 读，整份进内存后返回。
17. **插件内嵌放在 core**（不是 cli）：部署逻辑在 core，三个入口共用；最终同样编进 `bunsen` 一个可执行文件。rust-embed 不保存权限位，内嵌文件按规则设可执行：`*.sh`、`tools/*.py`、`#!` 开头。本机目录插件保留原权限位。
18. **插件下发**：本机先展开到 `<数据目录>/plugins-cache/<name>-<FNV64 内容哈希>/`（过滤后的副本，已存在则复用，同名旧版本删掉），再 rsync/tar 到服务器 `~/.bunsen/plugins/.<name>.tmp`，最后一次 ssh 依次 `mv` 换上（两次 rename，非严格原子）。`BUNSEN_SYNC_METHOD=tar` 强制走 tar（测试用）。

## 任务拆解（实现顺序）

1. 工作区骨架、错误/模型/工具函数、存储；
2. ssh 配置解析与生成、转义与启动命令（带单元测试）；
3. ssh 执行与错误识别、导入与密钥、连接测试、探测；
4. 会话：部署、刷新与发现、send/keys/capture/restart/stop/delete；
5. 工作区文件、git、科研面板；
6. HTTP 服务（鉴权、ndjson、WebSocket 终端、静态界面）；
7. 命令行与 MCP；
8. 集成测试（`dev/itest.sh`）；
9. v1.1：raw、artifacts、研究记录增强、运行详情、GPU 进程、主机笔记、MCP 新工具；
10. v1.2：插件内嵌与下发、Settings.plugin_paths、Agent.plugin_prompt、plugins 字段与兼容规则、CLI/MCP。
