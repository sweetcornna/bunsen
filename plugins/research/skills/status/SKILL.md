---
name: status
description: 用几行话报告研究循环的现状：阶段、在跑的运行、最近一批的结果、下一步、需要用户决定的事。只读，不推进研究。用户问“研究进展如何、现在跑到哪了、有什么要我决定的”时使用。
---

# 研究现状

只读。不启动运行，不改文件，不派子代理。

1. 研究目录默认是 `research/`（项目里有 `.claude/research-home` 时以它为准）。没有 `PROJECT.md` 就告诉用户这里还没有研究项目。
2. 读 `STATE.md`（有研究线时是各线的总览）和 `SUMMARY.md`，执行 `python3 research/tools/rk.py line status`、`python3 research/tools/rk.py status` 与 `python3 research/tools/rk.py loop status`。
3. 用不超过十行的中文回答：
   - 目标与当前阶段；各条研究线在哪台机器上推进；循环开着还是关着，在等什么；
   - 在跑的运行（运行 ID、已用时间）与已认领的算力；
   - 最近一批的结论和关键数字（带运行 ID；数字以 `runs/<运行ID>/metrics.json` 为准，和 `SUMMARY.md` 不一致时说明）；
   - 下一步；
   - 需要用户决定的事，逐条列出。
4. 状态是 `lost` 或失败的运行要明说，不省略。
