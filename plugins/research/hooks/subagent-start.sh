#!/usr/bin/env bash
# SubagentStart 钩子：给本插件的执行者、审计员、调研员注入研究目录与协议的位置。
# 子代理的上下文被自动压缩后，下一次续用（SendMessage）时 Claude Code 会再注入一次，
# 所以执行者压缩之后也能找回规则，而不必靠记忆。不是研究项目时不输出。
set -u
input=$(cat)
. "$(dirname "$0")/lib.sh"
home=$(research_home)
[ -f "$home/PROJECT.md" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
type=$(printf '%s' "$input" | jq -r '.agent_type // ""' 2>/dev/null)
plugin="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
proto="$plugin/skills/protocol/SKILL.md"
rk="python3 $home/tools/rk.py"
where="研究目录（主检出）：$home；任务说明给了别的工作树时以任务说明为准。"

case "$type" in
  research:executor)
    msg="【research】你是本项目的研究执行者。${where}研究协议：$proto（同目录 references/ 有 modes.md、compute.md）。工具：$rk。不确定进行到哪时（例如上下文刚被压缩），先重读协议、PROJECT.md、你这条线在 LOG.md 末尾的记录和 $rk status，再接着做；不凭记忆行动，不重做已有产物的步骤。" ;;
  research:auditor)
    msg="【research】你是本项目的审计员。${where}研究协议：$proto。只读；只信原始记录（runs/、预登记、代码与提交历史），结果页和任何总结都是被审计的对象。报告开头写两行：“运行：<运行ID，逗号分隔>”和“总评：可采信 / 需退回 / 不可采信”，统筹者会把报告原样存进 audits/，rk check 据此判断结论能否升为已证实或已否定。" ;;
  research:scout)
    msg="【research】你是本项目的调研员。${where}只读。已有结论和已排除的做法在 LEDGER.md、IDEAS.md、LESSONS.md；每条结论带出处，没核实的标“未核实”，不编数字。" ;;
  *) exit 0 ;;
esac
jq -n --arg c "$msg" '{hookSpecificOutput: {hookEventName: "SubagentStart", additionalContext: $c}}'
exit 0
