---
name: resume
description: 接续一个已有的研究循环。从研究目录的状态文件恢复上下文，核对在跑的运行与已认领的算力，然后从“下一步”继续。会话重启、换了会话或上下文被压缩之后使用。用法：/research:resume [补充指示]
argument-hint: "[给统筹者的补充指示]"
disable-model-invocation: true
---

# 接续研究循环

用户的补充指示（可能为空）：

$ARGUMENTS

你是这个项目的统筹者。不凭记忆行动，一切以文件为准。

## 1. 读规则

读统筹者手册 `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md`。研究协议 `${CLAUDE_PLUGIN_ROOT}/skills/protocol/SKILL.md` 在需要细节时再读。

## 2. 读状态

研究目录默认是 `research/`（项目里有 `.claude/research-home` 时以它为准）。没有 `PROJECT.md` 就说明这里还没有研究项目，告诉用户用 `/research:start`，然后停下。

按顺序读：`PROJECT.md` → `STATE.md` → `SUMMARY.md` → `OVERVIEW.md` → `LEDGER.md` → `LOG.md` 末尾 → `LESSONS.md` → `IDEAS.md`；用共享算力时再读协作文档。

## 3. 对账

- **运行**：`python3 research/tools/rk.py status`（跑在远程主机上的运行，到那台主机上执行同一条命令）。状态是 `lost` 的按失败归档（`rk done <ID> --fail --note <原因>`），原因记进 `LOG.md`。还在跑的重新架一个后台等待器。远程主机上已经结束的，用 `rk pull <别名>:<远程研究目录> <运行ID>` 拉回记录和日志。
- **算力**：协作文档里自己名下的认领与实际进程是否一致；没有进程的认领释放掉，有进程的补一次心跳。
- **执行者**：本会话里启动过的执行者可以用 `SendMessage` 续用；上一个会话的执行者接不上了，为那条研究线新开一个，让它从文件恢复。
- **待决事项**：用户这次的指示如果回答了 `SUMMARY.md` 里“需要你决定的事”，记进 `LOG.md` 并执行 `rk unblock`。

## 4. 打开循环并继续

```
python3 research/tools/rk.py loop on
```

用一两句话告诉用户恢复到了哪里（阶段、在跑什么、接下来做什么），然后直接从 `STATE.md` 的“下一步”继续，不等确认。用户的补充指示优先于文件里原定的下一步；与协议红线冲突时说明冲突并给出不越线的做法。
