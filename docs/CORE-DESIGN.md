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
  src/store.rs             数据目录、JSON/TOML 持久化（进程内一把锁 + 数据目录 .lock 文件锁，每次读盘，写临时文件再 rename）
  src/sshconfig.rs         上传的 ssh 配置解析；生成 <数据目录>/ssh/config
  src/shell.rs             单引号转义、路径转义（保留 ~）、PATH 前导、启动命令拼装
  src/exec.rs              执行器（v1.3）：同一段脚本，远程交给 ssh.rs，本机交给 `bash -s`；超时、取消、报错文案按执行位置区分
  src/ssh.rs               调系统 ssh：`ssh -F cfg -o BatchMode=yes -T op-<服务器id> bash -s`，脚本走标准输入；远端受监督执行（取消标记、进程组）
  src/tmux.rs              远程 tmux 脚本与输出解析
  src/import.rs            上传内容识别（ZIP/私钥/公钥/配置/其他）与导入
  src/keys.rs              私钥存取、指纹（ssh-keygen -lf）
  src/probe.rs             探测脚本与解析、GPU
  src/sessions.rs          部署、状态刷新/发现、send/keys/capture/restart/stop/delete
  src/workspace.rs         文件、git、科研面板、产物、原始字节、运行详情（v1.1）；按路径读文件的校验（v1.4）
  src/scripts/artifacts.py 产物查找与来源匹配（远端 python3 执行；v1.4 从 workspace.rs 挪出并加上来源）
  src/research_quality.rs  可信度（v1.4）：远程脚本、分段解析、rk 对象透传与脱敏
  src/scripts/research_trust.py  远端依次执行四条 rk 命令（限时、限量、独立进程组）
  src/research_quality_tests.rs、src/artifact_quality_tests.rs  可信度、运行详情、产物来源的测试（固定夹具）
  src/plugins.rs           内嵌插件（rust-embed，源在 plugins/）与本机目录插件：过滤、可执行位、展开到 plugins-cache（v1.2）
  build.rs                 plugins/ 与 agents.json 变了就重编
  src/projects.rs          研究项目（v1.3）：汇合点只读镜像、跨机器视图、部署时的接入脚本、立即同步
  src/project_quality.rs   项目视图的可信度计数（v1.4，projects.rs 的子模块）
  src/projects_tests.rs    projects.rs 的测试（真实 git 仓库）
  tests/fixtures/quality/  rk 0.6 输出的固定夹具和一个假 rk.py（v1.4）
  src/term.rs              本机伪终端里跑 ssh -tt，本机服务器直接跑 bash -lc（终端通道与 attach 用）
  src/core.rs              Core：对外的全部能力（服务、命令行、MCP 共用）
crates/cli   (bunsen-cli，可执行文件 bunsen)
  src/main.rs              clap 子命令
  src/http.rs              axum：鉴权/防跨站中间件、/api/*、/ws/term、内嵌 ui/dist
  src/mcp.rs               stdio 上的 MCP（JSON-RPC 2.0，逐行）
  build.rs                 ui/dist 变了就重编
  tests/itest.rs           走真实 HTTP 的集成测试（#[ignore]，dev/itest.sh 一条命令跑；测试服务器端口 BUNSEN_TEST_PORT，缺省 2222）
  tests/r3.rs              真实入口测试：命令行参数错误脱敏、HTTP/WebSocket 的服务器参数解析
  tests/quality.rs         真实入口测试：命令行 research --trust、MCP research_trust（v1.4）
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

### v1.3：本机执行与研究项目

19. **本机是一台服务器，不是特例**：所有操作都拼成同一段 bash 脚本，由执行器决定交给 ssh 还是本机 `bash -s`。本机执行把命令放进独立进程组，超时或取消时先 TERM、等 3 秒再 KILL；远端由受监督的脚本做同样的事，取消用原子写的标记文件区分，正常退出码原样返回。
20. **服务器参数的解析只有一个入口**：用户输入先按 id、再按别名找；保留 id `local` 只匹配本机记录，本机记录不存在或被 `BUNSEN_NO_LOCAL` 隐藏时 `not_found`，不按别名回退。持久化的引用（会话里的 server_id）只按 id。
21. **镜像只读、视图在本机算**：每个项目一个裸镜像 `hubs/<id>.git`，只取 `research/*`、`sync/*`。视图用每分支一次 `ls-tree -r -l -z` 加一次 `cat-file --batch`，边读边筛，按路径数、单对象、合计字节设上限。被跳过的路径要精确去重计数，内存放不下时写成有序分段，最后一次 k 路归并。
22. **跨进程锁**：serve、命令行、MCP 共用数据目录。JSON 读改写锁数据目录的 `.lock`，镜像操作锁 `hubs/<id>.lock`，都用标准库文件锁。同一进程里每个 Store 单独打开锁文件，否则 flock 会把它们当成同一个持锁者。
23. **报错一律先摘要再脱敏**：git/ssh 报错去掉固定提示，取最后 3 行，遮 URL 里的用户信息（RFC 3986 userinfo），截到 300 字符。所有写进 message、warning、detail、fetch_error 的地方共用 `error.rs` 里的同一组函数，命令行参数解析错误也走这里。
24. **git 子进程**：`GIT_TERMINAL_PROMPT=0`，`GIT_ALLOW_PROTOCOL=file:git:http:https:ssh`，标准输入为空（`cat-file --batch` 除外）。研究插件 `rk.py` 用同样的协议白名单。
25. **研究插件里的合并交给 git 保护**（研究插件 0.5.0 的 `rk sync`）：在真实索引上合并，不用临时索引。真正合并前要求暂存区和 HEAD 一致，快进由 git 自己保留暂存内容。HEAD 移动后按仓库状态判断结果，不回滚。git 及其 hook 放在独立进程组，由监护进程经控制管道托管：rk 自己超时、超限、被信号或被 KILL 时都能清掉整组，并回滚登记过的半截合并。

### v1.4：研究质量

26. **可信度只透传，一次远程脚本取完**：`research_quality.rs` 拼一段脚本，沿用科研面板解析研究目录的那段（`RESOLVE_HOME`）。先用 shell 读 `rk.py` 前 1 MiB 里的 `RK_VERSION`：没有研究目录、没有 `rk.py`、版本旧于 0.6.0 或认不出时直接给出原因，不起 Python。版本够新时才把内嵌的 `scripts/research_trust.py` 用 `python3 -c` 送过去，由它依次跑四条 rk 命令：每条在独立进程组里，单条 60 秒、合计 145 秒（外层执行器 150 秒，留出清理时间），标准输出超过 4 MiB 即停；超时或外层取消时先 TERM，2 秒后 KILL 整组。每条的结果包成一行 ASCII JSON（`{value}` 或 `{error}`）放进分段标记。Rust 只看它是不是对象、`ok`/`error` 和必有键，然后对所有字符串（含对象的键，rk 可能把 URL 当键）脱敏。rk 对象在模型里是 `serde_json::Value`：不重新实现插件的 schema，未知字段原样保留。
27. **运行详情的 `env.json`、`outputs.json` 在远端先判大小**：`stat` 超过 256 KiB / 1 MiB 的不传，传回后按分段标记取出，不是 JSON 对象的记 null。`PLAN.md` 和 `repo_prefix`（`git rev-parse --show-prefix`）并进原有的科研面板脚本，不多连一次。
28. **产物来源在远端算，只算返回的那些**：产物脚本挪进 `scripts/artifacts.py`。有 python3 时照旧列出文件，再在 Python 里排序、截断到 `limit`，只为要返回的产物找来源、算哈希。路径身份用 `realpath`：产物和清单条目的真实路径都必须在工作目录内，否则不参与匹配，越界的不可能得到 `verified=true`；在工作目录内的再换算成仓库根相对路径（不在仓库里用绝对路径）作为键。清单最多读 2000 份、每份 4 MiB，格式不对的清单或条目跳过；同一路径取 `(written_at, 运行 ID)` 最大的那次运行。哈希与 rk 的 H 相同（大文件取首尾），一次请求合计 512 MiB；读取前后大小或修改时间变了记 false。结果作为 `__OP_RUN__` 之后的一段 JSON 带回，Rust 按路径并进列表。没有 python3 的 find/stat 退路不找来源，`run` 一律为 null。
29. **按路径读文件不再 trim**：`file`、`raw`（经 `read_remote`）和 `files`、`git/diff` 共用 `validate_read_path`：空路径或含控制字符的拒绝，其余原样当作路径。原先先 trim 再展开 `~`，前端看到的“相对路径”在服务端会变成工作目录外的文件。
30. **项目视图读 git 树和 blob id，不算 sha256**：review 记录同时存 sha256 和 `git_blob`，rk 用前者，Bunsen 用后者；镜像的 `ls-tree` 本来就给出 blob id，比较的是同一份内容，Bunsen 不需要 sha256 依赖。`project_quality.rs` 是 Bunsen 里唯一复现 rk 规则的地方：结论文件列表、空白判定、复核覆盖、fail 关闭、引用计数，只看研究分支。
31. **正文按需读**：`cat-file --batch` 改成交互式（`git_exchange`，仍是同一套 120 秒超时和进程组清理），分三轮请求对象：先读每个研究分支的 `rk.py` 取版本；再读原有视图要的正文，以及版本够新的研究分支上的 `audits/review-*.json`、`audits/resolve-*.json`、`sources/*.json`；最后只请求没核过的结论文件正文（核过的不用判断是否空白）。`sync/*` 分支不读质量文件。所有正文共用 G14 的单对象 1 MiB、合计 64 MiB 上限，在请求之前判断，超限的计入“没有读入”的警告。
32. **镜像端的几处取舍**：空白判定用随 Bunsen 内嵌的插件模板（`plugins::research_template`），不用用户本机覆盖的插件目录，并和插件共用 `docs/blank-cases.json` 逐例夹具测试；记录 id 取文件名，不信正文里的另一份 id；研究线归属只读研究分支上的 `meta.json`，不用视图里可能来自还没并入的 `sync/*` 分支的运行；未关闭的 fail 直接从 review 条目数，结果页删掉之后照样计入。
33. **先用固定夹具测**：`crates/core/tests/fixtures/quality/` 是按契约 JSON 形状写的 rk 0.6 输出和一个假 `rk.py`，插件完成之前后端就能测；`crates/cli/tests/quality.rs` 起真正的 `bunsen` 进程测命令行和 MCP。联调阶段换成真实 rk。

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
11. v1.3：执行器与本机服务器、跨进程锁、研究项目（镜像、视图、部署接入、立即同步）、报错摘要与脱敏、CLI/MCP、两机端到端验证。
12. v1.4：可信度接口与远程脚本、运行详情的环境与输出清单、产物来源、按路径读文件的校验、项目视图的可信度计数、CLI/MCP；先用固定夹具测，联调换真实 rk。
