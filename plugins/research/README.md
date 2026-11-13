# research：自主科研循环插件

让 Claude Code 自己把一个研究问题做下去：主会话当统筹者，把实验迭代派给执行者子代理，用便宜的调研员并行查文献和出想法，用独立的审计员核查每批结果。规则针对的是自主研究代理最常见的几种失败：结果是编的或对不上记录、看了分数再定规则、失败被当成成功、等待时空转、做着做着停下来等人。

适用于大多数研究工作：计算与机器学习实验、既有数据的统计分析、理论与证明、文献综述、仿真建模、工程与基准构建、需要人执行的实验（代理只设计与分析）、定性与调查研究。共享实验室显卡是可选的算力后端，不用也能跑。

## 安装

```bash
claude plugin marketplace add /path/to/research_plugin
```

```bash
claude plugin install research@research-plugin --scope user
```

桌面应用里也可以从 **+ → Add plugins** 添加本地市场。只想临时试用：`claude --plugin-dir /path/to/research_plugin`。

钩子需要 `bash` 和 `jq`；工具脚本需要 Python 3.8 以上（只用标准库）。缺 `jq` 时钩子自动放行，不会卡住会话。

## 使用

| 命令 | 作用 |
|---|---|
| `/research:start <研究目标>` | 建研究目录、定项目设定（只在这一步集中提问一次）、接入算力、初始调研与发散，然后持续推进 |
| `/research:resume [线] [补充指示]` | 会话重启、换会话或换机器后，从状态文件接着做 |
| `/research:handoff <线> <机器代号>` | 把一条研究线交给另一台机器（本机 ↔ 服务器）：前置检查、交接摘要、推送、转移推进权 |
| `/research:status` | 几行话报告现状和需要你决定的事（只读） |
| `/research:stop` | 记录现状、关掉循环；在跑的运行默认让它跑完 |
| `/research:ideation` | 单独做一轮发散与收敛 |
| `/research:lab-access` | 单独接入实验室算力 |

启动之后它不再提问：需要你决定的事写在 `research/SUMMARY.md` 的“需要你决定的事”里，并按最稳妥的默认继续；只有不可逆、越权或会影响别人的操作才停下来问。

## 角色

| 角色 | 模型 | 负责 |
|---|---|---|
| 统筹者 | 主会话（用最强的模型） | 方向与优先级、算力分配、每批审核、受阻时诊断、向你汇报 |
| `research:executor` | opus | 一批迭代：设计、预登记、实现、冒烟、运行、核验、记录、合并 |
| `research:scout` | haiku | 并行调研、按角度出想法、查新颖性；只读 |
| `research:auditor` | sonnet | 只看原始记录的独立核查；只读 |

模型在 `agents/*.md` 的 `model:` 一行改。

## 它怎么保证“自己不断做下去，又不瞎忙”

- **循环开关加 Stop 钩子**。循环开着时，结束一轮只有三种正当理由：有后台任务在跑（它结束时会唤醒会话）、在等你的决定、循环已关。都不是，钩子提醒一次（以提示的形式，不显示成钩子错误）：要么做队列里的下一项，要么把等待架好。
- **答复后自动解除等待**。统筹者用 `rk block` 登记“在等你决定”时 Stop 钩子放行；你一回复，UserPromptSubmit 钩子就解除这个登记并提醒统筹者，答复没解决的它会重新登记。任务通知之类机器发来的消息、`/research:status` 不算答复。
- **等待靠唤醒，不靠轮询**。`rk wait` 放后台，运行结束或到状态间隔时退出并唤醒代理。到点的那一拍只做三件事：一句状态、心跳、重新等待。
- **等待纪律**。等的时候只有三种正当用法，按顺序：填满空闲算力、备好下一批、清记录欠账。都不成立就结束这一轮。轮询日志、重读文件、无关的重构与润色、没有问题的调研，都明确不做。
- **每个动作要有归属**。动手前说得出它推进想法池或研究线里的哪一项，说不出的不做。
- **熔断与预算**。连续失败或连续无进展达到阈值就不再派同类实验，先做策略评估；预算用尽或达成判据就收尾。
- **压缩后重新锚定**。上下文被压缩后，SessionStart 钩子把恢复清单和 `STATE.md` 开头重新放进上下文。执行者、审计员、调研员启动时，SubagentStart 钩子注入研究目录和协议的位置；子代理被自动压缩后，下一次续用时会再注入一次。

## 它怎么保证结果可信

- **预登记早于分数是机械保证的**。`rk run --prereg` 拒绝未提交的预登记和未提交的改动，并记下提交号；`rk check` 再核对预登记提交是运行所用提交的祖先。看的是提交先后，不看机器时钟。
- **探索与确认分开**。每次运行要么 `--prereg`，要么 `--explore`；探索性运行的数字进总览表必须标“探索”。
- **数字可追溯**。总览表每行写 `运行ID:指标键`，`rk check` 逐行对照 `runs/<运行ID>/metrics.json`，没有来源或对不上就报错。
- **失败不能当成功**。运行状态只看退出码；进程不在又没有退出码记为 lost，按失败处理；失败的运行进不了总览表，也不能支撑“已证实”或“已否定”。
- **结论账本只追加**。已证实 / 已否定 / 未决 / 撤回四种状态，前两种必须有证据；“死路”要有被否定的精确陈述。`rk check` 对照 git 历史核查，提交过的行被改动或删除就报错。
- **独立审计**。审计员拿不到执行者的叙述，只拿运行 ID、预登记和结果页路径，按十项清单查原始记录。统筹者用 `rk audit record` 登记总评，报告原样存进 `audits/`，登记后改动报告会被查出来；“已证实”“已否定”依赖的运行当前有效的审计总评不是“可采信”，`rk check` 报错。
- **发散有章法**。九个互不相见的角度各自出想法，去重成簇、查新颖性、成对比较，优先做能区分假设的最便宜的检验，并保留探索配额。

## 研究目录

`/research:start` 在项目里建立 `research/`：

| 文件 | 用途 |
|---|---|
| `PROJECT.md` | 项目设定：目标、研究类型、红线、算力、预算与停机条件 |
| `state/<线>.md` | 每条研究线的状态：阶段、在等什么、下一步；只由持有推进权的机器写 |
| `STATE.md` | 各线的总览（`rk line status --write` 生成）；还没有研究线的旧项目里是统筹者手写的状态 |
| `handoffs/` | 交接摘要，每次交接一份 |
| `SUMMARY.md` | 给你的小结，含“需要你决定的事” |
| `OVERVIEW.md` | 总览表，每个数字带来源 |
| `LEDGER.md` | 结论账本（只追加） |
| `IDEAS.md` | 想法池，被否决的也留着 |
| `LOG.md`、`LESSONS.md`、`RUNS.md` | 日志、教训表、运行表（自动生成） |
| `.gitattributes` | 只追加的文件用 union 合并，几台机器各自追加的行合并时都保留 |
| `prereg/`、`results/`、`strategy/` | 预登记、结果页、策略评估 |
| `audits/` | `rk audit record` 写的审计记录（JSON）和审计员报告原文 |
| `runs/<运行ID>/` | 运行记录：meta.json、metrics.json、exit_code、log.txt；远程主机上的用 `rk pull` 拉回 |
| `tools/rk.py`、`tools/collab.py` | 工具，随项目入库，本机和远程主机用同一份 |

## 本机和服务器之间交接

研究项目是一个 git 仓库，本机和服务器各有一份检出，经同一个远端汇合。一条研究线同一时刻只由一台机器推进，这份推进权登记在两台机器都能连上的协调主机上（`collab.py lease`，编号只增不减）；`rk line config --collab "ssh <别名> python3 <目录>/collab.py"` 告诉 rk 去哪里找它。

- `rk line new <线>` 建线并取得推进权；`rk line take <线>` 在这台机器上接手；`rk line status` 查看各线在哪。
- `/research:handoff <线> <机器代号>`（命令是 `rk handoff`）先做前置检查（没提交的改动、没推送、没跑完的运行、目标机器连不上……逐条给出修复办法），再写交接摘要、推送、转移推进权；接手的机器 `git pull`、`rk line take`、`/research:resume`。中途失败可以原样重跑。
- 没有推进权的机器改 `state/<线>.md` 会被钩子拦下。失联的旧推进者在被接管之后还写了、合并进来的，`rk check` 按提交历史查出来，要求持有者核对后重新盖章。

## 共享实验室算力（可选）

实验室的主机表、层级表放在本机的 `~/.config/research-plugin/lab.md`，私钥在 `keys/`，口令在 `secrets/`。插件目录和研究仓库里都不放密钥。

```bash
bash scripts/setup-lab.sh --zip <密钥压缩包>
```

口令用 `--secret <名字>` 从标准输入读入，不出现在命令行里。PreToolUse 钩子会拦下内容里带私钥正文或已登记口令的命令、写文件、子代理任务说明和消息，也拦下读出私钥和口令文件内容的调用（Read、Grep，以及 Bash 里 cat、head、grep、cp 之类的常见写法）。只引用路径的用法放行：`ssh -i`、`ssh-add`、`chmod`、`--password-file`；公钥不受限。这是启发式检查，不是沙箱。

运行 ID 带机器代号（`rk id <简称>` 生成），形如 `20261112-mac-r01-baseline`，几台机器各自编号也不会撞号。代号默认从主机名推出，可用环境变量 `RK_MACHINE_NAME` 指定。

运行跑在远程主机上时，记录先留在那台主机的研究目录里。结束后在本机执行 `rk pull <别名>:<远程研究目录> <运行ID>`，把记录和日志拉回来再核验；它只补缺失的文件，不覆盖本机已有的记录，没结束的运行不拉。

多个会话共用显卡时，通过协调主机上的同一份 `COLLAB.md` 排卡，写入一律走 `collab.py`：拿锁、只改自己署名的行、结果与留言只追加、写后重读确认；`free` 把 `nvidia-smi` 和卡位表合成一张“能不能用”的表。规则见 `skills/protocol/references/compute.md`。

## 目录

```
.claude-plugin/     清单与本地市场
skills/             start resume status stop（入口）；orchestrator protocol ideation lab-access（规则）
agents/             executor scout auditor
hooks/              session-start subagent-start user-reply stop-gate guard-secrets
scripts/            scaffold.sh（建研究目录）、setup-lab.sh（装密钥与档案）
templates/research/ 研究目录模板与工具
tests/run.sh        脚手架、rk、collab、钩子的端到端测试
CHANGELOG.md        变更记录
```

```bash
bash tests/run.sh
```

## 借鉴

设计时参考了这些项目的做法，没有使用它们的代码：

- Anthropic 官方 math-proof 插件：只追加的结论账本、由脚本而不是模型下机械判定、两次独立核查才算证实、搁置不等于否定。
- Anthropic 官方 ralph-loop 插件：用 Stop 钩子维持循环、按会话隔离。这里改成只提醒一次，并且有后台任务时放行。
- [obra/superpowers](https://github.com/obra/superpowers)：SessionStart 钩子重新锚定；执行与审查分开。
- [ARIS](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep)：审查者读原始文件而不是执行者的摘要。
- [continuous-claude](https://github.com/AnandChowdhary/continuous-claude)、[ralph-claude-code](https://github.com/frankbria/ralph-claude-code)：预算上限与无进展熔断。
- [karpathy/autoresearch](https://github.com/karpathy/autoresearch)：固定预算、单一指标、保留或丢弃的快速筛选。
- [AI Scientist v2](https://github.com/SakanaAI/AI-Scientist-v2)、[AIDE](https://github.com/WecoAI/aideml)：把尝试当成树，从验证最好的节点扩展，每个节点有调试上限。
- Google AI co-scientist：成对比较排序假设、按簇保持多样性。
- [data-to-paper](https://github.com/Technion-Kishony-lab/data-to-paper)：报告里的每个数字都能追到产生它的记录。
- 对自主研究代理的独立评测（arXiv:2502.14297、arXiv:2509.08713、arXiv:2505.19955）：代码错误、新颖性误判、泄漏、事后选报、失败被报成成功。上面“结果可信”一节的每一条都对着其中一种。
