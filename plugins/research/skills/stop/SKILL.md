---
name: stop
description: 停下研究循环：记录现状，关掉循环开关，并说明还在跑的运行和已认领的算力怎么处理。用法：/research:stop
disable-model-invocation: true
---

# 停下研究循环

1. **记录**：重写本机持有的 `state/<线>.md`（阶段、在等什么、下一步）并 `rk line status --write`，更新 `SUMMARY.md`，在 `LOG.md` 记一条“用户叫停”及当时的状态。
2. **在跑的运行**：默认让它们跑完，不结束进程。列出运行 ID、所在主机和预计结束时间。用户明确要求中止时才中止；中止不可恢复，动手前再确认一次。
3. **执行者**：还在工作的执行者，用 `SendMessage` 请它在安全点停下并在 `LOG.md` 写交接；不启动新的运行。
4. **算力**：没有进程的认领立即释放；有进程在跑的保留，补一次心跳并确认预计结束时间准确。
5. **推进权**：默认保留，接着做的还是这台机器。用户要换一台机器接着做，用 `/research:handoff`；要放手不再推进某条线，`rk line release <线>`。
6. **关循环**：`python3 research/tools/rk.py loop off`。
7. **告诉用户**：停在哪一步、还有什么在跑、占着哪些卡到什么时候、用 `/research:resume` 可以接着做。
