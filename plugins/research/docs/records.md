# 研究记录与质量规则（0.6.0）

研究插件 0.6.0（研究工作台 v2 第四期“研究质量”）里 `rk.py`、审计员、钩子和模板对研究记录的约定，是这些规则的权威说明。Bunsen 只透传和展示 `rk` 的结果，接口见 Bunsen `docs/API.md` 第 13 节。

正文里的【Q1】【Q15a】等标记对应文末的修订记录。

## 0. 约定

- 研究插件只用 Python 标准库，兼容 Python 3.9；不加任何依赖。Bunsen 不加新的直接依赖。
- 文中“研究目录”即 `rk.py` 里的 `HOME`（默认 `<仓库>/research`）。凡是写进记录、出现在 JSON 里的研究目录内路径，一律相对研究目录、用 `/` 分隔，例如 `results/20261113-mac-r01-x.md`、`LEDGER.md`。
- 时间一律 RFC 3339 字符串。JSON 文件统一 `ensure_ascii=False`、缩进 2、UTF-8、末尾换行，原子写入（先写临时文件再 rename）。
- 本期新增的命令和 `rk check` 加 `--json` 时，只在标准输出打印一个 JSON 对象，不夹杂其他文字；参数错误等提前退出时沿用现有的 `{"ok": false, "error": "…"}`。`rk status --json` 保持原有的数组格式【Q4】。
- 文案一律中文，可直接显示。报错里的 URL 用户信息按第三期 G20 遮掉。
- **不照搬 Claude Science**：只吸收能力，代码、提示词、技能正文、界面文案全部自己写。

## 1. 共同规则

### 1.1 文件哈希 H(path)

- 文件 ≤ 256 MiB：整个文件的 sha256（十六进制小写）。
- 文件 > 256 MiB：`sha256(str(size) + "\n" + 前 1 MiB + 后 1 MiB)`，记 `partial: true`。
- 输入清单、输出清单、结果页引用的图表、Bunsen 核对产物，全部用这同一个函数。读取预算和读取期间文件变动的处理见 3.1。

### 1.2 结论文件

被复核的文件（都是研究目录的直接成员，不递归）：

| 文件 | 对应模板 |
| --- | --- |
| `SUMMARY.md` | 模板 `SUMMARY.md` |
| `OVERVIEW.md` | 模板 `OVERVIEW.md` |
| `LEDGER.md` | 模板 `LEDGER.md` |
| `results/*.md`（不含 `TEMPLATE.md`） | `results/TEMPLATE.md` |
| `strategy/*.md`（不含 `TEMPLATE.md`） | `strategy/TEMPLATE.md` |

### 1.3 空白文件

只有模板内容、还没写进任何东西的结论文件算“空白”，不需要核对。逐行看（去掉行尾空白）：下面这些行不算内容，其余都算。一行内容都没有的就是空白。

- 空行；
- 标题行（以 `#` 开头）；
- 表格分隔行（`|---|…`），以及每张表的第一行（表头），只有一行的孤立表格行也算表头；
- HTML 注释行（`<!--` 开头）；
- 占位行：去掉行首空白和列表符号（`-`、`*`、`+`、`1.`、`1)` 这类）后，整行以 `<` 开头、以 `>` 结尾（与第三期 G21 同一条规则）；
- 表格行：每个单元格要么为空，要么是 `<…>` 形式的占位；
- 与对应模板里某一行完全相同（都去掉行尾空白后比较）。

`rk.py` 把上表五份模板的原文内嵌成常量；插件测试要断言这些常量与 `templates/research/` 下的文件逐字一致。Bunsen 用它内嵌的插件副本里的同名模板。插件测试和 Bunsen 共用逐例夹具 `docs/blank-cases.json`，两边对每个例子的判断必须相同。旧版本模板留下的说明文字会被当成内容，这样的文件需要核对一次，这是接受的代价。

### 1.4 记录文件（`audits/` 下，只追加）

| 前缀 | `kind` | 写入者 |
| --- | --- | --- |
| 无前缀（`<时间>-<代号>.json`） | 无此字段 | `rk audit record`（推断审计，已有） |
| `review-<时间>-<代号>[-k].json` | `"review"` | `rk review record` |
| `resolve-<时间>-<代号>[-k].json` | `"resolve"` | `rk review resolve` |
| `plan-<时间>-<代号>[-k].json` | `"plan"` | `rk plan approve` |

- `<时间>` 是 `YYYYMMDD-HHMMSS`，`<代号>` 是本机代号，同名时加 `-2`、`-3`……；记录的 id 就是文件名去掉 `.json`。
- 现有 `audit_records()` 只读没有 `kind` 字段的记录，跳过其他三种。
- “没有登记的 `audits/*.md`”这条现有检查，要把所有记录（任何 `kind`）的 `report` 字段都算作已引用。
- 这四种记录都由 rk 生成，登记后不改写。

### 1.5 版本

- 插件 `0.6.0`，`RK_VERSION = "0.6.0"`；Bunsen `0.4.0`。
- 新运行的 `meta.json` 增加 `rk_version` 字段。下文“新运行”指 `meta.rk_version` 存在且 ≥ `0.6.0` 的运行；旧运行不受第 3 节新增检查约束。

### 1.6 自动同步

`rk review record`、`rk review resolve`、`rk plan approve`、`rk cite check`（写了缓存时）之后，和 `rk audit record` 一样，在后台提交研究目录并同步。

## 2. P1 复核

### 2.1 文件状态

每个存在的结论文件有三种状态：

- `blank`：空白（1.3）；
- `reviewed`：某条 review 记录的 `files` 里有 `{path 等于该文件的规范名, sha256 == 当前 H(path)}`【Q16a】；
- `unreviewed`：其余。

结论文件经 7.2 的解析函数读取【Q15】：

- 槽位越界或无法确认安全时记 `unreviewed`，不读正文，不能是 `reviewed` 或 `blank`；`rk check` 报错误 `review.reference_outside`【Q15d】。
- `results/`、`strategy/` 本身越界（是越界链接，或者存在但不是目录）时，报错误 `review.reference_outside`（`file` 为该目录），`rk review status` 里放一个未核的占位槽位，使闸门拦截【Q16b】。
- 已写下的复核记录里的名字现在解析成别名时（例如不区分大小写的盘上只改了大小写），记录不作废：其中的 fail 照常保留在 `rk review status`、闸门和结论关联里，不报 `review.record_invalid`；正面覆盖仍只按规范名计，槽位只列规范名，不出现重复槽位。同一仓库在区分与不区分大小写的盘上，fail 的保留结果一致【Q16a′】。

### 2.2 `rk review status [--json]`

只读，不联网。文字输出逐个列出未核文件和未关闭的 fail。

```ts
type RkReviewStatus = {
  rk_version: string;
  files: {
    path: string;                       // 研究目录相对路径（规范名）
    sha256: string | null;              // 槽位越界或读不到时为 null（2.1）
    state: "reviewed" | "unreviewed" | "blank";
    open_fails: number;                 // 这个文件上未关闭的 fail 数
    last_review: string | null;         // 最近一次核过它的 review id（按 recorded_at）
    last_reviewed_sha256: string | null;
  }[];                                  // 按 path 排序
  open_fails: OpenFail[];               // 按 recorded_at、再按 ref 排序
  problems: number;                     // unreviewed 文件数 + open_fails 条数
};
type OpenFail = {
  ref: string;                          // "<review id>#<条目 id>"
  review_id: string; file: string; line: number | null;
  row: string | null;                   // 账本行的编号（如 "C3"），其他文件为 null
  type: ReviewItemType; claim: string; evidence: string[]; note: string;
  recorded_at: string;
};
```

### 2.3 `rk review diff <路径>`

只读。打印这个文件从上次核过的内容到现在的统一 diff。上次的内容按记录里的 `git_blob` 取（`git cat-file -p`）。没核过、或者取不到那个对象时，打印整份文件，第一行写明“没有可比较的上次核对内容，下面是全文”。审计员用它把核对范围限制在改动部分。

路径必须是结论文件，并且按 7.2 解析为找到；越界、不存在或读不到时拒绝，不读正文【Q15】。

### 2.4 审计员的核对报告与 `rk review record`

审计员（`agents/auditor.md`，仍是只读）增加“核对模式”，与原有的推断审计十项清单并列。核对模式只对照磁盘上的原始记录，逐条检查结论文件里的：

- 动作声明（“跑了 X”“做了 Y”）；
- 数字；
- 外部引用（查 `sources/` 缓存，抽查摘录与原文）；
- 图题和图上的标注（与数据文件、`outputs.json` 一致）；
- 计划里标为“完成”的步骤的交付物（P4）。

报告最后一个 fenced 代码块的语言标记写 `json rk-review`，内容：

```json
{
  "files": [{ "path": "results/20261113-mac-r01-x.md", "sha256": "<取自 rk review status 的当前值>" }],
  "items": [
    { "id": "1", "file": "results/20261113-mac-r01-x.md", "line": 18, "ref": null,
      "type": "number", "verdict": "fail",
      "claim": "表里写准确率 0.842",
      "evidence": ["runs/20261113-mac-r01-x/metrics.json:acc"],
      "note": "metrics.json 里是 0.824", "resolves": null }
  ]
}
```

```ts
type ReviewItemType = "action" | "number" | "citation" | "figure" | "deliverable" | "excerpt" | "other";
type ReviewVerdict = "pass" | "warn" | "fail" | "inconclusive";
```

`rk review record (--report <md> | --file <json>) [--by <名>] [--note <说明>]` 的校验，不通过就拒绝、什么都不写：

- `files` 至少一个，路径不重复，每个都是存在的结论文件，并且 `sha256` 等于当前 H(path)。不一致时报“<路径> 在核对之后又改过：重新核对”。
- `files[].path` 只接受目录项的真实名字，并且按 7.2 解析为找到、解析结果就是这个名字；别名一律拒绝【Q16a】。别名判定只用于新登记，不追溯已写下的记录（2.1）【Q16a′】。
- 条目：
  - `id` 匹配 `[A-Za-z0-9_-]{1,16}`，在本条记录里唯一；
  - `file` 必须在 `files` 里；
  - `type`、`verdict` 取上面的值；
  - `line` 是正整数或 null；
  - `ref` 是字符串（账本行的编号）或 null；
  - `claim` ≤ 500 字符，`note` ≤ 1000 字符，`evidence` 最多 20 个字符串；
  - `resolves` 为 null，或者是一个现存的、`verdict == "fail"` 的条目的 ref。
- `items` 可以为空，表示看过、没有需要核对的内容。
- `--report` 时从报告里取最后一个 `json rk-review` 块；取不到就拒绝。报告复制进 `audits/<review id>.md`，已经在 `audits/` 里的原地登记。
- `git_blob`、`ledger_rows` 等派生字段都生成之后、写入报告和记录之前，再核一次当前 H(path)，对不上同样拒绝。

写入 `audits/<review id>.json`：

```ts
type ReviewRecord = {
  kind: "review"; review_id: string;
  files: { path: string; sha256: string; git_blob: string | null }[];  // git_blob：对算 sha256 的同一份字节按入库路径执行 git hash-object --stdin --path=<路径>（与 git hash-object -- <文件> 结果相同，不写对象）；不在 git 仓库里为 null
  items: ReviewItem[];                 // 原样（补齐缺省字段为 null）
  ledger_rows: string[];               // files 含 LEDGER.md 时：账本每个数据行的行哈希（2.6）；否则 []
  report: string | null; report_sha256: string | null;
  by: string;                          // 缺省 "research:auditor"
  note: string; recorded_at: string;
  machine: string; machine_name: string; git_head: string | null;
};
```

报告登记后被改动，`rk check` 报错（同现有审计报告的规则）。

### 2.5 关闭 fail：`rk review resolve <ref> --note <说明> [--by <名>]`

- `--note` 必填。`ref` 必须指向现存的 fail 条目，而且该条目还没关闭。
- 写 `audits/<resolve id>.json`：`{kind: "resolve", resolve_id, item: ref, note, by, recorded_at, machine, machine_name}`，`by` 缺省“用户”。
- **未关闭的 fail**：`verdict == "fail"` 的条目，既没有 resolve 记录指向它，也没有任何 review 条目同时满足 `resolves == 它的 ref` 和 `verdict == "pass"`。修好之后重新核对、在新条目里写 `resolves` 是正常途径；`resolve` 用于误报或用户已经接受的情形。
- 只有这两种途径能关闭 fail。把文件清空、删掉、换成链接，或者文件读不到，fail 都不会消失，照常关联到引用这一页的结论【Q5】【Q15】。

### 2.6 账本行

- 账本里每张带“状态”列的表，每个数据行把各单元格去首尾空白后，用 `\x1f` 连接，取 sha256，就是行哈希。
- “决定性结论”：状态含“已证实”或“已否定”的行（与现有规则相同）。
- 一行算核过：它的行哈希出现在某条 review 记录的 `ledger_rows` 里。
- 结论引用的结果页（证据的分词见 7.3，路径解析见 7.2）：
  - 显式证据解析到研究目录 `results/*.md` 的那一页。候选先相对研究目录、再相对仓库根，所以 `research/results/x.md` 和 `results/x.md` 是同一页。
  - 每个 `run:<运行ID>` 对应的 `results/<运行ID>.md`，只在研究目录里找，不回退到仓库根【Q16】。这一页不存在不是错误：不报 `ledger.file_missing`，也不在结论的 `results` 里加行。例外：有复核记录（`files[].path` 或 fail 的 `file`）提到这一页时保留该行，`review` 为 `missing`，未关闭的 fail 照常关联【Q15a】。
  - 显式证据里形如结果页（研究目录作用域的 `results/*.md`）的候选，不论最终命中哪个候选，其研究目录字面名都保留负面关联，规则同上一条【Q16】。
  - 结果页越界或不存在时，仍在结论的 `results` 里保留它的规范化字面名，`review` 为 `missing`；页上已有的未关闭 fail 继续关联【Q15】。
- 结果页的名字集合（证据里的字面名和规范名）里，每个名字的 stem 都按运行 ID 查一遍；是运行的，算作这条结论的证据运行，决定性结论同样要求它运行成功、推断审计为“可采信”，不因规范化后大小写不同而漏查【Q16h】。

### 2.7 复核闸门：`rk review gate --json`（钩子专用）

`hooks/stop-gate.sh` 现有的判断顺序不变：循环关、不是本会话、`stop_hook_active`、已 block、有后台任务或定时任务，都照旧直接放行。Stop 钩子的输入不是 JSON 对象、确认不了会话（`session_id` 不是非空字符串）或后台任务、定时任务的结构，或者任何一步 jq 失败，都直接放行，不调用闸门。这些都没有放行时，先调用：

```
python3 <研究目录>/tools/rk.py review gate --json
```

再按结果走：

| `action` | 钩子输出 | 说明 |
| --- | --- | --- |
| `"pass"` | 沿用现有的提醒 | 没有问题 |
| `"block"` | `{"decision": "block", "reason": <message>}` | 硬闸门：这次不让停 |
| `"escalate"` | `{"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": <message>}}` | 已经拦了 3 次，改为交给用户 |

- 调用失败（没有 python3、rk 太旧没有 `review`、退出码非 0、输出不是 JSON 或超过 1 MiB、`action` 不是上面三种、`message` 不是字符串、超时）一律当 `pass`，绝不把会话卡死。`rk review gate` 自己必须在 5 秒内返回（Stop 钩子总限时 10 秒）。
- 问题集合：每个 `unreviewed` 文件记 `unreviewed:<path>`，每条未关闭的 fail 记 `fail:<ref>`；排序后用 `\n` 连接（末尾不加换行），取 sha256 的前 16 位作为 `key`。同一组问题下文件内容变了，不重置计数【Q3】。
- 计数存在 `.loop/review-gate.json`（`{key, count, updated_at}`，不进 git）：
  - 没有问题：删掉计数文件，返回 `pass`；
  - `key` 与上次相同时 `count + 1`，否则 `count = 1`；
  - `count ≤ 3`：返回 `block`；
  - `count == 4`：返回 `escalate`。同时像 `rk block` 一样写下“在等用户决定”（内容是问题清单的一行摘要），并删掉计数文件。之后会话按现有规则因为 block 放行；用户回复、解除 block 之后，从 1 重新计数。
- 钩子不改任何研究文件。写 SUMMARY 是会话自己的事：如果由钩子写 SUMMARY，SUMMARY 会变成未核文件，问题集合随之变化，计数永远到不了 3。

```ts
type RkGate = {
  action: "pass" | "block" | "escalate";
  count: number; key: string | null;
  problems: { kind: "unreviewed" | "open_fail"; path: string; ref: string | null }[];
  message: string;   // block、escalate 时给模型看的中文说明；pass 时为 ""
};
```

`message` 的要点（措辞自己写）：

- 命令一律写完整形式 `python3 <研究目录相对项目目录>/tools/rk.py …`；问题按“未核：<路径>”“未关闭：<文件:行>（<ref>）”列出，不暴露内部键【Q12】。
- `block`：
  - 列出问题，最多 10 条，超出的写“另有 N 条”；
  - 写明第几次（n/3）；
  - 做法：先 `rk cite check`，派审计员用核对模式核对这些文件（用 `rk review diff` 限定范围），再用 `rk review record --report` 登记；误报用 `rk review resolve <ref> --note` 关闭；
  - 要对用户说的结论必须先写进 SUMMARY 或结果页。
- `escalate`：已经连续拦了 3 次，问题没有变化，不再拦。已经登记了“在等用户决定”。把问题写进 SUMMARY.md 的“需要你决定的事”，然后明确地问用户。

### 2.8 `rk check` 的新增规则（P1）

| code | 级别 | 条件 | `file` / `ref` |
| --- | --- | --- | --- |
| `review.unreviewed` | 警告 | 非空白的结论文件未核（含越界槽位） | 该文件 / null |
| `review.open_fail` | 警告 | 未关闭的 fail（不属于下面两条的） | 所在文件 / 条目 ref |
| `review.claim_unreviewed` | 错误 | 决定性结论的账本行没核过 | `LEDGER.md` / 编号 |
| `review.result_unreviewed` | 错误 | 决定性结论引用的结果页存在、不是空白，而且未核（当前哈希）【Q5】 | 结果页 / 编号 |
| `review.claim_open_fail` | 错误或警告 | 账本上 `ref == 编号` 的未关闭 fail，或它引用的结果页（含 2.6 保留的字面名）上的任何未关闭 fail；决定性结论为错误、非决定性为警告【Q17】 | 所在文件 / 编号 |
| `review.record_invalid` | 错误 | review、resolve 记录格式不对，引用了不存在的条目，或报告登记后被改 | 记录文件 / null |
| `review.reference_outside` | 错误或警告 | 质量引用越界或无法确认安全（7.2）：结论文件槽位和结论目录越界为错误【Q15d】【Q16b】；账本证据、结论引用的结果页、图表越界时，决定性结论为错误、非决定性为警告【Q15】 | 槽位或目录 / null；其余为 `LEDGER.md` 或相应的结果页 / 结论编号 |

- 引用的结果页是空白时不需核对，不报 `review.result_unreviewed`；该页上的 fail 仍按 `review.claim_open_fail` 阻塞【Q5】。
- 升级到 0.6.0 的已有项目，现有的决定性结论会立刻因为没核过而报错，核对一遍即可消除。这一点写进 CHANGELOG。
- 账本证据或图表若引用指向仓库外的链接（如 `data/ -> /mnt/...`、兄弟仓库里的文件），决定性结论现在报 `review.reference_outside` 错误；改用 `run:` 引用，或把文件复制进研究目录。这条升级提示同样写进 CHANGELOG。

## 3. P2 溯源

### 3.1 `rk run` 新参数

- `--in <路径>`（可多次）：声明输入，文件或目录都可以。在启动命令之前计算：
  - 文件：H(path)；
  - 目录：递归、按相对路径排序、不跟随符号链接、跳过 `.git` 和 `__pycache__`。目录摘要 = sha256(每个文件一行 `相对路径\0H\n` 拼接)。超过 10000 个文件时只算前 10000 个，记 `partial: true`。目录里有文件记了 `unhashed` 时，整个目录 `sha256: null`、`unhashed: true`。
  - 所有输入和输出（3.2）合计最多读入 8 GiB，按实际读取的字节累计（大于 256 MiB 的文件计首尾 2 MiB）；不够之后的文件一律不再计算，`sha256: null`、`unhashed: true`【Q6】。
  - 读取不超过开始时的文件大小；读取前后文件的大小、修改时间或身份（设备号、inode）变了，同样记 `unhashed: true`。
  - 路径不存在：拒绝启动。
- `--out <目录>`（可多次）：声明输出目录。启动前给每个目录拍快照（相对路径 → `(size, mtime_ns)`，最多 20000 项），存在 `runs/<ID>/.rk-out-snapshot.json`。

`meta.json` 新增字段（旧运行没有这些字段）：

```ts
{
  rk_version: string;
  inputs: { path: string; type: "file" | "dir"; sha256: string | null; size: number;
            files: number | null; partial: boolean; unhashed: boolean }[];
  outs: string[];
  env_sha256: string | null;       // env.json 的 sha256
  outputs_sha256: string | null;   // outputs.json 的 sha256
}
```

`inputs[].path`、`outs[]` 在仓库内时相对**仓库根**（用 `/`），否则是绝对路径。

### 3.2 `runs/<ID>/outputs.json`

运行结束时由监督进程写（手工批次由 `rk done` 写），然后删掉快照文件。收录：

- 运行目录里的文件，不含 `meta.json`、`log.txt`、`exit_code`、`pid`、`sup.pid`、`env.json`、`outputs.json` 和以 `.rk-` 开头的文件；`metrics.json` 收录；
- 每个 `--out` 目录里，相对快照新增或 `(size, mtime_ns)` 变化的文件。

最多 5000 个文件，超出记 `truncated: true`。

```ts
type RkOutputs = {
  version: 1; run_id: string; written_at: string;
  files: { path: string; sha256: string | null; size: number; partial: boolean; unhashed: boolean }[];  // 按 path 排序
  truncated: boolean;
};
```

`path`：在仓库内相对仓库根，否则绝对路径。写完后把它的 sha256 写进 `meta.outputs_sha256`。

`rk pull` 照常拉回 `outputs.json`、`env.json`，不拉 `.rk-*`。快照这类 `runs/*/.rk-*` 文件不进 git：模板 `.gitignore` 带这条规则，scaffold 升级旧项目时补上，保留用户已有的规则，重复执行不重复追加。

### 3.3 `runs/<ID>/env.json`

- 监督进程启动命令后，在一个线程里并行采集，不推迟命令启动。命令结束后最多再等 60 秒；采集完成就写 `env.json` 和 `meta.env_sha256`，没完成就把 `env_sha256` 记为 null，并在 `log.txt` 末尾写一行说明。
- 手工批次在 `rk run --manual` 时同步采集，最多 30 秒。
- 每个外部命令限时 20 秒。采集命令放在单独的进程组里，由监护进程经控制管道看守：监督进程收到 TERM、采集超时、监督进程被 KILL 时，都清掉整个采集进程组。

选解释器的顺序：

1. 命令的第一个词形如 `python`、`python3`、`python3.11`：用它；
2. 设了 `VIRTUAL_ENV`：用 `$VIRTUAL_ENV/bin/python`；
3. 运行环境 PATH 上的 `python3`。

`python.executable` 记解析后的绝对路径（`shutil.which`，相对路径按运行的工作目录解析），解析不到时记原样【Q13】。

包清单：依次试 `<解释器> -m pip freeze --all`、`uv pip freeze --python <解释器>`、`conda list --export`（仅在设了 `CONDA_PREFIX` 时），用第一个成功的；最多 2000 行、256 KiB，超出记 `truncated`。

显卡：`nvidia-smi --query-gpu=name,driver_version --format=csv,noheader`，CUDA 版本取 `nvidia-smi` 输出里的 `CUDA Version`；没有 `nvidia-smi` 时 `gpu` 为 null。

```ts
type RkEnv = {
  version: 1; captured_at: string;
  python: { executable: string | null; version: string | null };
  packages: { tool: "pip" | "uv" | "conda" | null; lines: string[]; truncated: boolean };
  gpu: { driver: string | null; cuda: string | null; names: string[] } | null;
  os: { system: string; release: string; machine: string; platform: string };
  host: string;
  fingerprint: string;
};
```

`fingerprint` = sha256( `json.dumps({"python": python.version, "packages": packages.lines, "gpu_driver": gpu?.driver, "cuda": gpu?.cuda, "system": os.system, "release": os.release, "machine": os.machine}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` 的 UTF-8 )。同一指纹表示环境没变，用来发现环境漂移。

### 3.4 `rk check` 的新增规则（P2）

结果页里引用的图表：Markdown 图片 `![…](路径)` 和链接 `[…](路径)`，扩展名属于 png、jpg、jpeg、gif、webp、svg、pdf、csv、tsv、xlsx、parquet。外链（`http://`、`https://`）不算。路径按 7.2 解析，候选依次是结果页所在目录、研究目录、仓库根【Q15】。

- 图表来源按运行结束时记录的内容哈希认定：运行的 `outputs.json` 按 7.2 解析为找到，并通过完整性校验（sha256 等于 `meta.outputs_sha256`）时，其中格式正确的条目（`sha256` 是 64 位十六进制、`size` 是非负整数、`partial` 是布尔值、`unhashed` 为 false）都计入可信来源，与条目路径现在是否存在、是否被移动无关；清单本身越界或完整性不符时，整份不计入【Q15】【Q15c】。
- 图表的哈希在同一个文件描述符上分块计算，读完后照旧核对文件身份【Q16g】；读取期间文件变了，按无法确认安全处理。
- 图表越界或无法确认安全时报 `review.reference_outside`，不读内容；图表的越界、缺失问题传播到每个引用该结果页的结论（`ref` 为结论编号；越界时决定性结论为错误、非决定性为警告）【Q15】。没有结论引用这一页时，越界报警告，`ref` 为引用的路径。
- 新运行的 `outputs.json` 越界时报警告 `review.reference_outside`（`file` 为 `runs/<ID>`，`ref` 为运行 ID）。
- 旧运行（没有 `rk_version`），以及以旧运行 ID 命名的结果页，免本节新增检查【Q6】。

| code | 级别 | 条件 | `file` / `ref` |
| --- | --- | --- | --- |
| `prov.figure_missing` | 错误 | 引用的图表文件不存在 | 结果页 / 每条引用该页的结论的编号；没有结论引用时为引用的路径【Q15】 |
| `prov.unknown` | 警告 | 图表的 H 不在任何可信来源里（`sha256` 为 null 的条目不匹配任何文件） | 结果页 / 每条引用该页的非决定性结论的编号（各报一次）；没有结论引用时为引用的路径【Q17b】 |
| `prov.unknown_decisive` | 错误 | 同上，而且这张结果页被决定性结论引用 | 结果页 / 编号 |
| `prov.no_inputs` | 警告 | 新运行、`kind == "prereg"`、没有声明输入 | `runs/<ID>` / 运行 ID |
| `prov.no_outputs` | 警告 | 新运行、已正常结束、没有可读取的 `outputs.json` | `runs/<ID>` / 运行 ID |
| `prov.record_changed` | 错误 | `env.json` 或 `outputs.json` 的 sha256 与 meta 里记的不一致 | `runs/<ID>` / 运行 ID |

不做文件读写的动态追踪。

## 4. P3 引用

### 4.1 标识符

从全部结论文件和 `sources/excerpts.md` 里抽取，忽略大小写：

- DOI：`(?:doi:\s*|https?://(?:dx\.)?doi\.org/)(10\.\d{4,9}/[^\s"'<>|]+)`，去掉末尾的 `.,;:)]}>` 和 `）。，；：`，URL 解码。规范形式为 `doi:` + 小写 DOI。
- arXiv：`(?:arxiv:\s*|https?://arxiv\.org/(?:abs|pdf)/)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(v\d+)?`（`.pdf` 后缀去掉）。规范形式为 `arXiv:` + 编号，不带版本。

### 4.2 `rk cite check [--offline] [--refresh] [--json]`

- 对每个标识符，先看缓存（4.3）：有 `status` 为 `ok` 或 `not_found` 的缓存就用它，`--refresh` 时除外。
- 其余的联网查：
  - 两次请求至少相隔 1 秒，连接加读取的整次请求绝对限时 15 秒、响应体最多 2 MiB，一次最多查 200 个，超出的算 `unchecked`（`skipped` 计数）；
  - 用 `urllib`，自然遵循 `HTTPS_PROXY` 等环境变量；
  - User-Agent 为 `rk/<版本> (research plugin)`，不带任何个人信息。
- **Crossref**：`GET <RK_CROSSREF_URL 缺省 https://api.crossref.org/works/><URL 编码的 DOI>`。404 → `not_found`；200 → `ok`。
  - 取 `title[0]`、`author[].given + family`（最多 20 个）、`issued.date-parts[0][0]`、`container-title[0]`；
  - `retracted`：`updated-by` 里有 `type` 或 `update-type` 为 `retraction`、`relation.is-retracted-by` 非空、或标题以 `RETRACTED` 开头，为 true；否则，响应里有 `updated-by` 时为 false，没有时为 null。
- **arXiv**：`GET <RK_ARXIV_URL 缺省 https://export.arxiv.org/api/query>?id_list=<编号>`，解析 Atom。没有 entry、或 entry 的 id 含 `/api/errors` → `not_found`；否则 `ok`。
  - 取 title、authors、published 的年份，`venue` 为 `"arXiv"`；
  - `retracted`：`arxiv:comment` 含 `withdrawn`（不分大小写）为 true，否则为 null。
- 网络错误、其他 HTTP 错误（含 5xx）、超时、响应超过 2 MiB 或格式不对（Crossref 字段类型不对；arXiv 不是 Atom feed，或含 DTD、实体声明）：不写缓存，条目状态记 `error`。
- `--offline`：完全不联网，没缓存的记 `unchecked`。
- 退出码：有 `not_found`、`retracted` 或 `error` 时为 1，否则为 0。
- `RK_CROSSREF_URL`、`RK_ARXIV_URL`、`RK_CITE_INTERVAL`（请求间隔秒数，缺省 1）只供测试使用；测试一律指向本机的假服务器，不连真实网络。

```ts
type RkCiteReport = {
  ok: boolean; rk_version: string;
  checked: number;      // 本次联网查询的个数
  skipped: number;
  items: {
    id: string;                        // 规范形式
    status: "ok" | "not_found" | "retracted" | "unchecked" | "error";
    files: string[];                   // "results/x.md:12" 这样的出处，最多 10 个
    cache: string | null;              // 用到的缓存文件
    title: string | null;
    error: string | null;
  }[];                                 // 按 id 排序
};
```

`retracted` 的条目：缓存里 `status == "ok"` 且 `retracted == true`。

### 4.3 缓存 `sources/<key>@<本机代号>.json`

- 每台机器写自己的文件，避免 `rk sync` 时冲突；读的时候同一个 `id` 取 `checked_at` 最新的一份。
- `key`：
  - DOI：`doi-` + 把 DOI 中 `[^a-z0-9._-]` 换成 `_` 后的前 80 个字符 + `-` + sha256(规范形式) 的前 8 位；
  - arXiv：`arxiv-` + 编号（`/` 换成 `_`）。

```ts
type SourceRecord = {
  id: string; status: "ok" | "not_found";
  title: string | null; authors: string[]; year: number | null; venue: string | null;
  retracted: boolean | null;
  source: "crossref" | "arxiv"; url: string;
  checked_at: string; checked_by: string;   // 本机代号
};
```

### 4.4 摘录 `sources/excerpts.md`

新模板，`.gitattributes` 设 `merge=union`，只追加。表头：

```
| 结论 | 标识符 | 位置 | 原文摘录 |
```

账本里用外部文献作证据的决定性结论，每个标识符至少要有一行摘录（“结论”填编号）。审计员在核对模式里抽查摘录与原文是否一致（`type: "excerpt"`）。scaffold 给旧项目补这份模板和 union 规则，`.gitattributes` 里已经显式写了 `sources/excerpts.md` 的不动。

### 4.5 `rk check` 的新增规则（P3，只读缓存，不联网）

| code | 级别 | 条件 | `file` / `ref` |
| --- | --- | --- | --- |
| `cite.not_found` | 错误 | 缓存里状态是 `not_found` | 第一个出处的文件 / 标识符 |
| `cite.unchecked` | 警告 | 没有缓存 | 同上 |
| `cite.retracted_decisive` | 错误 | 已撤稿的文献作为决定性结论的证据 | `LEDGER.md` / 编号 |
| `cite.retracted` | 警告 | 已撤稿的文献在别处被引用 | 第一个出处的文件 / 标识符 |
| `cite.no_excerpt` | 警告 | 决定性结论用了外部标识符作证据，`excerpts.md` 里没有对应摘录 | `LEDGER.md` / 编号 |

## 5. P4 研究计划

### 5.1 模板 `PLAN.md`

```
# 研究计划

`/research:start` 集中提问之后起草，用户批准后执行 `rk plan approve`。批准之后不再为计划停下：有偏离照常推进，但每次偏离都在“偏离记录”里追加一行；增删阶段这类大改，写进 SUMMARY 的“需要你决定的事”。

- **目标**：<…>
- **可行性与置信度**：<…>

## 阶段 1：<名称>

| 编号 | 步骤 | 交付物 | 预登记 | 状态 |
|---|---|---|---|---|
| 1.1 | <…> | <路径；多个用分号隔开> | <prereg/…；没有写 -> | 待办 |

## 偏离记录

| 日期 | 步骤 | 偏离 | 原因 |
|---|---|---|---|
```

- 阶段：标题以 `## 阶段` 开头的节。节里表头含“编号”“交付物”“状态”的表格行就是步骤。
- 状态取值：待办、进行中、完成、放弃。
- 交付物：先看整个单元格是不是占位，再按 `;`、`；` 拆分；`-` 和占位表示没有交付物。路径按 7.2 解析，候选依次是研究目录、仓库根，文件或目录都算【Q15】。
- “有计划”：至少一个步骤行的“步骤”单元格不为空、也不是占位。原样模板的示例行编号 `1.1` 是实数、步骤是 `<…>`，不算计划，不报 `plan.unapproved`。没有计划时，第 5 节的检查全部跳过【Q1】。

### 5.2 计划摘要

计划摘要 `plan_digest` = sha256(PLAN.md 原文做两处处理之后的结果)：

- 每个步骤行的“状态”单元格换成空；
- 删掉整个“偏离记录”节。

这样更新步骤状态、追加偏离都不会改变摘要。

### 5.3 命令

`rk plan approve [--by <名>]`：没有计划时拒绝。写 `audits/<plan id>.json`：

```ts
type PlanRecord = {
  kind: "plan"; plan_id: string;
  plan_sha256: string; plan_digest: string; git_blob: string | null;
  phases: string[];       // 阶段标题
  steps: string[];        // 步骤编号
  deviations: number;     // 偏离记录的行数
  by: string;             // 缺省 "用户"
  approved_at: string; machine: string; machine_name: string; git_head: string | null;
};
```

`rk plan status [--json]`：

```ts
type RkPlanStatus = {
  present: boolean;                       // 有计划（5.1 最后一条）
  approved: boolean;                      // 有有效的 plan 记录
  approved_at: string | null;             // 最近一次批准（按 approved_at）
  changed_since_approval: boolean;        // 当前 plan_digest ≠ 最近一次批准时的
  deviations_since_approval: number;
  phases: {
    title: string;
    steps: { id: string; step: string; status: string; prereg: string | null;
             deliverables: { path: string; exists: boolean;
                             resolved: string | null }[] }[];  // resolved：找到时的路径，相对仓库根（不在仓库里时为绝对路径）；没找到或越界为 null【Q9】
  }[];
};
```

### 5.4 `rk check` 的新增规则（P4）

| code | 级别 | 条件 | `file` / `ref` |
| --- | --- | --- | --- |
| `plan.deliverable_missing` | 错误 | 状态为“完成”的步骤，有交付物不存在（越界的交付物 `exists` 为 false，同样算） | `PLAN.md` / 步骤编号 |
| `plan.record_invalid` | 错误 | plan 记录格式不对；这条记录不算批准，不借用 `review.record_invalid`【Q2】 | 记录文件 / null |
| `plan.deliverable_outside` | 警告 | 交付物路径越界或无法确认安全（7.2）【Q15】 | `PLAN.md` / 步骤编号 |
| `plan.unapproved` | 警告 | 有计划但没有批准记录 | `PLAN.md` / null |
| `plan.changed_unlogged` | 警告 | 批准后摘要变了，偏离记录却没有新增行 | `PLAN.md` / null |
| `plan.phases_changed` | 警告 | 阶段标题与最近一次批准时不同（提示写进“需要你决定的事”） | `PLAN.md` / null |

计划偏离只记录，不阻塞。

## 6. P6 作图与报告规范

- 新增 `skills/protocol/references/figures.md`，内容自己写，覆盖：
  - 数据忠实：不截断坐标轴来夸大差异，不平滑掉异常点而不说明；
  - 坐标轴、单位、样本量和区间（以及区间的算法）写全；
  - 同一变量在各图里颜色一致；
  - 作图脚本放进 `rk run --in <数据> --out <图目录>`，让图有来源；
  - 出图后打开图片自检。
- 协议技能、执行者简报、统筹者手册引用这份文件。
- 审计员核对模式的 `figure` 条目：图题、图上标注的数字与数据文件一致，图在 `outputs.json` 里有来源。

## 7. `rk check --json` 与问题编码

### 7.1 输出

文字输出保持现有格式（`[错误] …` 等），新增的问题一并输出。`--json` 时：

```ts
type RkCheck = {
  ok: boolean;                  // 没有错误
  rk_version: string;
  counts: { runs: number; overview_rows: number; claims: number; errors: number; warnings: number; notes: number };
  errors: Issue[]; warnings: Issue[]; notes: Issue[];
  claims: Claim[];              // 账本的每个数据行，按出现顺序
};
type Issue = { code: string; message: string; file: string | null; ref: string | null };
type Claim = {
  id: string;                   // 编号
  status: string; text: string; kind: string; date: string;
  decisive: boolean;
  evidence: string[];
  runs: { run_id: string; state: string; audit: "可采信" | "需退回" | "不可采信" | null; audit_id: string | null }[];
  results: { path: string; review: "reviewed" | "unreviewed" | "blank" | "missing"; open_fails: number }[];  // 2.6；越界或不存在为 missing，path 是规范化字面名
  citations: { id: string; status: "ok" | "not_found" | "retracted" | "unchecked" }[];
  review: "reviewed" | "unreviewed";      // 这一行的行哈希有没有核过（2.6）
  trust: "ok" | "warn" | "fail";
};
```

- `trust`：有 `ref == id` 的错误为 `fail`；否则，有 `ref == id` 的警告、或 `review == "unreviewed"`、或某个结果页不是 `reviewed`/`blank`，为 `warn`；其余为 `ok`。聚合规则不变，所有关联和问题传播都在聚合之前完成【Q15】。
- 退出码不变：有错误为 1。

### 7.2 质量引用的解析

下面这些引用都经 rk 里同一个解析函数，得到“找到 / 越界 / 不存在”三态之一，并带规范化字面名【Q15】：

| 引用 | 候选的基准，按顺序 |
| --- | --- |
| 账本显式证据 | 研究目录、仓库根 |
| `run:<运行ID>` 的隐式结果页 | 只有研究目录【Q16】 |
| 结果页里的图表 | 结果页所在目录、研究目录、仓库根 |
| 计划交付物 | 研究目录、仓库根 |
| 结论文件的复核读取 | 研究目录 |
| 图表溯源用到的 `runs/<ID>/outputs.json` | 研究目录 |

- 允许范围是研究目录和仓库根。研究目录在入口处解析一次，它的子目录后来变成链接，也不扩大允许范围。
- 候选逐个检查：安全但不存在或类型不符，继续看下一个；遇到越界（含链接最终越界、链接循环、无法确认边界）立即判越界，后面的候选不得覆盖；全部安全且不存在，才是不存在。
- 链接按最终落点判定：沿链接逐跳只读元数据（`lstat`、`readlink`），中途经过允许范围以外的路径不算越界，最终物理位置在允许范围内即为找到；超过 40 跳按链接循环处理【Q16d】。越界目标的内容始终不读。
- 文件身份用目录项的真实名字：找到之后逐级按目录列表精确匹配，把引用里的写法规范成磁盘上的真实名字（大小写、Unicode NFC/NFD）；匹配不上（例如只差大小写却有两个候选）按越界处理【Q16a】。
- 读取时先打开入口处固定的研究目录或仓库根，核对它与启动时记录的 `(st_dev, st_ino)` 一致，只对其下的部分逐级不跟随链接；读完重走父目录、核对文件身份。祖先目录只需可进入（执行权限），不要求可读【Q16c】。
- 入口记录锚点时取不到当前工作目录（已被删除等），就跳过工作目录这一组锚点，不在导入阶段崩溃【Q16i】。
- 规范化只建立完整路径身份，不用 basename、子串或正则截取借用其他文件的复核状态。字面名可以保留负面关联（未关闭的 fail、`missing`），不能单独授予正面复核状态【Q15】。
- 越界一律按失败处理：结论文件槽位见 2.1，结果页见 2.6，图表见 3.4，交付物见 5.4，账本证据见 7.3。

### 7.3 账本证据

- 分词：在引号、反引号之外按 `;；,，` 和空白切分【Q15b】。引号（`'`、`"`、`` ` ``）只在词元开头才算引号，而且结束引号后必须紧跟分隔符或文本结尾，否则按普通字符；英文所有格（`Smith's`）不影响切分【Q16e】。引号不配对时退回 0.5.0 的切分【Q15b】。
- 普通词元按 0.5.0 去掉两端反引号，空词元丢弃【Q16e′】。
- 只有含 `/` 的词元当作文件引用（与 0.5.0 相同）；不含 `/` 的词元（说明文字、编号等）不核对是否存在【Q15b】。外链和占位也不当作文件。
- 去掉两端反引号和引号后以 `run:` 开头、但解析不出合法运行 ID 的词元，一律报错误 `ledger.run_invalid`，不得静默忽略【Q15】【Q16e′】。
- 决定性结论没有证据，报 `ledger.evidence_missing`；证据只有空引号或空反引号时同样报这一条【Q16e′】。
- 显式证据越界时报 `review.reference_outside`（2.8）；不存在时报错误 `ledger.file_missing`。前面的候选“安全但不存在”、后面的候选越界时，越界候选的最终目标也不存在（只读元数据判断，不读内容）才另报 `ledger.file_missing`，保持 0.5.0 的严重级别；目标存在时只按越界规则处理【Q16f】【Q16f′】。
- `run:` 的隐式结果页见 2.6。

### 7.4 问题编码

现有各条检查也带上 code，按类别取前缀：

| 前缀 | 类别 |
| --- | --- |
| `run.` | 运行记录 |
| `prereg.` | 预登记 |
| `audit.` | 推断审计 |
| `line.` | 研究线 |
| `overview.` | 总览表 |
| `ledger.` | 账本 |
| `sync.` | 同步 |
| `index.` | RUNS.md、STATE.md 总览 |
| `review.` | 复核（第 2 节） |
| `prov.` | 溯源（第 3 节） |
| `cite.` | 引用（第 4 节） |
| `plan.` | 研究计划（第 5 节） |

所有 code 集中登记在 `rk.py` 的 `CHECK_CODES` 表里，未登记的 code 不能输出；CHANGELOG 列出现有检查的 code。前端按 code 前缀分组显示。下表是 0.6.0 的全部 code，新增的条件和 `file`/`ref` 以各节的表为准：

| code | 级别 | 含义 |
| --- | --- | --- |
| `run.id_mismatch` | 错误 | 运行 ID 与目录不同 |
| `run.machine_mismatch` | 错误 | 机器代号与 ID 不同 |
| `run.machine_collision` | 警告 | 多机共用同一代号 |
| `run.lost` | 错误 | 运行丢失 |
| `run.remote` | 警告 | 远程运行未拉回 |
| `run.dirty` | 警告 | 运行时工作区有改动 |
| `run.result_missing` | 警告 | 确认性运行缺结果页 |
| `run.deviations` | 说明 | 运行有偏离 |
| `prereg.run_commit_missing` | 错误 | 运行提交不在历史中 |
| `prereg.uncommitted` | 错误 | 预登记未提交 |
| `prereg.no_repo` | 警告 | 无法在仓库核对预登记 |
| `prereg.commit_missing` | 错误 | 预登记提交不在历史中 |
| `prereg.content_changed` | 错误 | 预登记内容与启动时不符 |
| `prereg.not_ancestor` | 错误 | 预登记不是运行提交的祖先 |
| `prereg.order_unknown` | 警告 | 无法确定提交先后 |
| `prereg.late` | 错误 | 旧运行预登记晚于启动 |
| `prereg.time_only` | 说明 | 旧运行仅按时间核对 |
| `prereg.time_unknown` | 警告 | 无法比较旧运行时间 |
| `prereg.edited_after` | 说明 | 预登记启动后改动 |
| `audit.run_missing` | 警告 | 审计的运行不存在 |
| `audit.missing` | 警告 | 运行缺独立审计 |
| `audit.unregistered` | 错误 | 未登记的报告 |
| `audit.record_invalid` | 错误 | 审计记录无效或报告改动 |
| `audit.concurrent` | 警告 | 并存审计总评不一致 |
| `line.owner_missing` | 错误 | 研究线缺推进权 |
| `line.base_missing` | 警告 | 研究线接手提交缺失 |
| `line.token_regressed` | 错误 | 推进权编号回退 |
| `line.stale_write` | 错误 | 旧推进权写入未核对 |
| `overview.source_missing` | 错误 | 总览缺来源 |
| `overview.run_missing` | 错误 | 总览运行不存在 |
| `overview.run_not_ok` | 错误 | 总览运行未成功 |
| `overview.explore_unmarked` | 错误 | 探索未标明 |
| `overview.source_invalid` | 错误 | 来源格式不对 |
| `overview.metrics_invalid` | 错误 | metrics 缺失或无效 |
| `overview.metric_missing` | 错误 | 指标键不存在 |
| `overview.number_mismatch` | 错误 | 总览数字不符 |
| `ledger.history_changed` | 错误 | 账本历史行改动 |
| `ledger.evidence_missing` | 错误 | 决定性结论缺证据；证据只有空引号也算（7.3） |
| `ledger.run_missing` | 错误 | 证据运行不存在 |
| `ledger.run_invalid` | 错误 | `run:` 后不是合法的完整运行 ID（7.3）【Q15】 |
| `ledger.file_missing` | 错误 | 显式证据文件不存在（7.3）【Q16f】 |
| `ledger.run_not_ok` | 错误 | 决定性证据运行未成功 |
| `ledger.audit_not_ok` | 错误 | 决定性证据未通过审计 |
| `sync.incomplete` | 警告 | 上次同步未完成 |
| `index.state_stale` | 警告 | STATE 总览过时 |
| `index.runs_stale` | 警告 | RUNS 总览过时 |
| `review.unreviewed` | 警告 | 结论文件未核（2.8） |
| `review.open_fail` | 警告 | 未关闭的 fail（2.8） |
| `review.claim_unreviewed` | 错误 | 决定性结论的账本行没核过（2.8） |
| `review.result_unreviewed` | 错误 | 决定性结论引用的结果页未核（2.8） |
| `review.claim_open_fail` | 错误或警告 | 结论关联未关闭的 fail；决定性为错误、非决定性为警告（2.8）【Q17】 |
| `review.record_invalid` | 错误 | review、resolve 记录无效（2.8） |
| `review.reference_outside` | 错误或警告 | 质量引用越界或无法确认安全（2.8、3.4）【Q15】 |
| `prov.figure_missing` | 错误 | 图表文件不存在（3.4） |
| `prov.unknown` | 警告 | 图表来源不明（3.4） |
| `prov.unknown_decisive` | 错误 | 决定性结论引用的图表来源不明（3.4） |
| `prov.no_inputs` | 警告 | 确认性新运行没有声明输入（3.4） |
| `prov.no_outputs` | 警告 | 已结束的新运行没有输出清单（3.4） |
| `prov.record_changed` | 错误 | `env.json` 或 `outputs.json` 与 meta 不符（3.4） |
| `cite.not_found` | 错误 | 引用解析不到（4.5） |
| `cite.unchecked` | 警告 | 引用没有缓存（4.5） |
| `cite.retracted_decisive` | 错误 | 决定性结论的证据已撤稿（4.5） |
| `cite.retracted` | 警告 | 别处引用了已撤稿的文献（4.5） |
| `cite.no_excerpt` | 警告 | 决定性结论的外部证据缺摘录（4.5） |
| `plan.deliverable_missing` | 错误 | 已完成步骤缺交付物（5.4） |
| `plan.record_invalid` | 错误 | plan 记录无效（5.4）【Q2】 |
| `plan.deliverable_outside` | 警告 | 交付物路径越界（5.4）【Q15】 |
| `plan.unapproved` | 警告 | 计划未批准（5.4） |
| `plan.changed_unlogged` | 警告 | 批准后改了计划却没记偏离（5.4） |
| `plan.phases_changed` | 警告 | 阶段与批准时不同（5.4） |

## 修订记录

第四期开发中对已确认契约（2026-11-13）的修订，2026-11-13 至 2026-11-14，来源是插件交付报告、前后端审查、联调和各轮审查，均由主编排裁定。这里只列影响本文的条目；Q7、Q8、Q10、Q11、Q14 只涉及 Bunsen，见 Bunsen `docs/API.md` 13.8。

| 编号 | 内容 | 位置 |
| --- | --- | --- |
| Q1 | “有计划”改为至少一个步骤行的“步骤”单元格不是占位；原样模板不算计划，不报 `plan.unapproved` | 5.1 |
| Q2 | 坏的 plan 记录报 `plan.record_invalid`（错误），不借用 `review.record_invalid`；该记录不算批准 | 5.4 |
| Q3 | 闸门 `key`：问题键排序后用 `\n` 连接再取哈希；同一组问题下文件内容变化不重置计数 | 2.7 |
| Q4 | “`--json` 只输出一个对象”只约束本期新增的命令和 `rk check --json`；`rk status --json` 仍是数组 | 0 |
| Q5 | 空白的结果页不报 `review.result_unreviewed`；页上的 fail 仍按 `review.claim_open_fail` 阻塞，清空文件不能关闭 fail | 2.5、2.8 |
| Q6 | 哈希预算按实际读取的字节累计，不够之后一律 `unhashed`；旧运行和以旧运行 ID 命名的结果页免第 3 节新增检查 | 3.1、3.4 |
| Q9 | `rk plan status` 的交付物增加 `resolved` | 5.3 |
| Q12 | 闸门 `message` 写完整的 `python3 …/tools/rk.py` 命令，问题按可读的位置列出 | 2.7 |
| Q13 | `env.json` 的 `python.executable` 记 `shutil.which` 解析后的绝对路径 | 3.3 |
| Q15 | 质量引用统一三态解析；越界一律按失败处理，负面关联不因文件删除或越界消失；新增 `review.reference_outside`、`ledger.run_invalid`，补入 `plan.deliverable_outside` | 2.1、2.3、2.5、2.6、2.8、3.4、5.1、5.4、7.1–7.4 |
| Q15a | `run:` 隐式结果页不存在不是错误；有复核记录提到时保留 `missing` 行和 fail | 2.6 |
| Q15b | 只有含 `/` 的显式证据词元当作文件；引号外切分，引号不配对时退回 0.5.0 | 7.3 |
| Q15c | 图表来源按完整性合格的 `outputs.json` 里的内容哈希认定，与输出路径现在是否存在无关 | 3.4 |
| Q15d | 结论文件槽位越界报错误，不是警告 | 2.1、2.8 |
| Q16 | `run:` 隐式结果页只在研究目录里找；形如结果页的显式候选保留研究目录字面名的负面关联 | 2.6、7.2 |
| Q16a | 文件身份用目录项的真实名字；复核登记拒绝别名 | 2.1、2.4、7.2 |
| Q16b | `results/`、`strategy/` 本身越界报错误，并放未核的占位槽位 | 2.1、2.8 |
| Q16c | 祖先目录只需执行权限；读取从入口固定的目录开始并核对身份 | 7.2 |
| Q16d | 链接按最终落点判定，越界目标的内容不读 | 7.2 |
| Q16e | 引号只在词元开头才算；英文所有格不影响切分 | 7.3 |
| Q16f | 前面的候选不存在、后面的候选越界时另报 `ledger.file_missing` | 7.3、7.4 |
| Q16g | 图表哈希在同一个文件描述符上分块计算 | 3.4 |
| — | 升级提示：引用指向仓库外链接的决定性结论报 `review.reference_outside` | 2.8 |
| Q16a′ | 别名判定只用于新登记；已写下的记录里的 fail 照常保留，槽位不重复 | 2.1、2.4 |
| Q16e′ | 普通词元去两端反引号；非法的 `run:` 引用一律报 `ledger.run_invalid`；只有空引号算没有证据 | 7.3 |
| Q16f′ | Q16f 只在越界候选的最终目标也不存在时另报 | 7.3 |
| Q16h | 运行审计对结果页名字集合里每个名字的 stem 都查 | 2.6 |
| Q16i | 取不到当前工作目录时跳过这一组锚点 | 7.2 |
| Q17 | `review.claim_open_fail` 决定性结论为错误、非决定性为警告 | 2.8、7.4 |
| Q17a | `review status` 的 `files[].sha256` 为 `string \| null`：越界槽位和目录占位不读取，为 null | 2.2 |
| Q17b | `prov.unknown` 被非决定性结论引用时，`ref` 为每条结论的编号、各报一次；没有结论引用时为引用的路径 | 3.4、7.4 |
| Q17c | 越界的 `outputs.json` 报 `review.reference_outside` 警告（`ref` 为运行 ID）；没有结论引用的越界图表报警告（`ref` 为引用的路径） | 3.4、7.2 |
