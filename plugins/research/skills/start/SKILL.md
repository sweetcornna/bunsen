---
name: start
description: 启动一个自主科研项目。建立研究目录，写定项目设定，接入算力，做初始调研与发散，然后以统筹者身份把迭代派给执行者并持续推进，直到达成目标或预算用尽。用法：/research:start <研究目标>
argument-hint: "<研究目标，一两句>"
disable-model-invocation: true
---

# 启动研究循环

用户给的研究目标：

$ARGUMENTS

你将担任这个项目的统筹者。按下面的顺序做。除第 2 步外不向用户提问。

## 1. 读规则

读统筹者手册 `${CLAUDE_PLUGIN_ROOT}/skills/orchestrator/SKILL.md` 和研究协议 `${CLAUDE_PLUGIN_ROOT}/skills/protocol/SKILL.md`（也可以用技能 `research:orchestrator`、`research:protocol` 加载）。

## 2. 定项目设定

- 上面的研究目标为空时：请用户用一两句话给出研究目标，然后停下。
- 研究目录（默认 `research/`）里已经有填好的 `PROJECT.md` 时：这不是新项目，告诉用户并改走 `/research:resume`。
- 能从环境推出来的自己定：仓库（当前项目目录）、开发分支（`research/<简称>`）、本会话名称（`A-主线`）、状态间隔（30 分钟）、研究类型（从目标判断，可多选）。
- 推不出来、而且会改变做法的，**一次问完**。只问确实不清楚的，通常不超过这几项：
  - 什么算“回答了”（目标含糊时）；
  - 算力后端（无 / 本机 / 共享实验室）；
  - 预算与截止（批数、算力小时或日期）；
  - 提交署名行，以及测试通过后能否直接合并 PR；
  - 有没有已经看过结果、不能再用来挑方法的目标；
  - 有没有必须由人来做的步骤。
- 用户没回答的项按最稳妥的默认填，并在 `PROJECT.md` 里写明“默认”。此后不再提问。

## 3. 建研究目录

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.sh" "<项目目录>"
```

- 项目不是 git 仓库时先 `git init`：预登记靠提交来证明时间先后。
- 创建或切换到开发分支，填好 `PROJECT.md`，提交。
- 下文的 `rk` 指 `python3 research/tools/rk.py`。
- 按要回答的问题划分研究线（先一条也行，以后再加），每条执行 `rk line new <线> --question "<要回答的问题>"`：它建 `state/<线>.md`，取得这条线的推进权，生成总览 `STATE.md` 并提交。线名用短的英文或拼音，例如 `baseline`、`ablation`。
- 用共享算力、或以后可能换机器推进时，配好协调主机：`rk line config --collab "ssh <协调主机别名> python3 <共享目录>/collab.py"`。没有协调主机时推进权只登记在本机，单机够用。

## 4. 打开循环

```
python3 research/tools/rk.py loop on
```

循环开着时，没有后台任务在跑、也不在等用户，就不该结束一轮；钩子会提醒。

## 5. 开始研究

按统筹者手册的“启动”一节继续：接入算力（需要时）→ 初始调研并写策略评估 → 发散并登记想法 → 派出第一批。每完成一步重写对应的 `state/<线>.md`。

第一条给用户的汇报放在算力就绪或第一份策略评估完成之后：几句话说明项目设定里你替用户定了哪些默认、第一批打算回答什么。
