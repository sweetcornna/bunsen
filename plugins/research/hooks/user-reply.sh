#!/usr/bin/env bash
# UserPromptSubmit 钩子：循环在等用户决定（rk block）时，用户发来新消息就解除等待，
# 让 Stop 钩子重新生效，并告诉统筹者解除了什么；答复没解决那件事就重新 rk block。
# 不算答复、不解除的：机器发来的消息（任务通知等，以“<”开头）、只读的 /research:status、
# 别的会话。解析不了的情况一律不动、不输出。
set -u
input=$(cat)
. "$(dirname "$0")/lib.sh"
home=$(research_home)
blocked="$home/.loop/blocked"
active="$home/.loop/active"
[ -s "$blocked" ] && [ -f "$active" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
get() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

sid=$(get '.session_id // ""')
owner=$(sed -n 's/^session: *//p' "$active" | head -n1)
[ -n "$owner" ] && [ -n "$sid" ] && [ "$owner" != "$sid" ] && exit 0

prompt=$(get '.prompt // ""')
lead=$(printf '%s' "$prompt" | tr -d '\r' | sed -e 's/^[[:space:]]*//' | head -n1)
[ -n "$lead" ] || exit 0
case "$lead" in
  '<'* | /research:status*) exit 0 ;;
esac

what=$(sed -e 's/^[^ ]* //' "$blocked" | head -n 5)
rm -f "$blocked"
msg="【research】已解除“在等用户决定”：${what}。若这条消息答复了它：照办，在 LOG.md 记一条，并从 SUMMARY.md 的“需要你决定的事”里划掉；若没有答复、仍然只能等用户，重新执行 python3 $home/tools/rk.py block \"<要决定的事>\"。"
jq -n --arg c "$msg" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $c}}'
exit 0
