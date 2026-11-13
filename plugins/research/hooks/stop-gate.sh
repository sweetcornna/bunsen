#!/usr/bin/env bash
# Stop 钩子：研究循环开着时，结束一轮只有三种正当理由——
#   1) 有后台任务在跑（运行的等待器、子代理），它结束时会唤醒会话；
#   2) 在等用户决定（rk block）；
#   3) 循环已关（rk loop off）。
# 都不是，就提醒一次：要么继续队列里的下一项，要么把等待架好。
# 任何解析不了的情况一律放行，绝不把会话卡死。
set -u
input=$(cat)
. "$(dirname "$0")/lib.sh"
home=$(research_home)
active="$home/.loop/active"
[ -f "$active" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
get() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

[ "$(get '.stop_hook_active // false')" = "true" ] && exit 0

# 只管启动循环的那个会话；同一项目里的其他会话不受影响。
sid=$(get '.session_id // ""')
owner=$(sed -n 's/^session: *//p' "$active" | head -n1)
if [ -z "$owner" ]; then
  if [ -n "$sid" ]; then
    tmp="$active.tmp.$$"
    { grep -v '^session:' "$active"; printf 'session: %s\n' "$sid"; } > "$tmp" && mv "$tmp" "$active"
  fi
elif [ -n "$sid" ] && [ "$owner" != "$sid" ]; then
  exit 0
fi

[ -s "$home/.loop/blocked" ] && exit 0

live=$(get '[.background_tasks[]? | select(((.status // "running") | tostring | ascii_downcase | test("^(completed|complete|succeeded|failed|killed|stopped|cancell?ed|done|exited|error|timeout|timed_out)$")) | not)] | length')
crons=$(get '(.session_crons // []) | length')
case "$live" in ''|*[!0-9]*) live=0 ;; esac
case "$crons" in ''|*[!0-9]*) crons=0 ;; esac
[ "$live" -gt 0 ] && exit 0
[ "$crons" -gt 0 ] && exit 0

reason='研究循环还开着，但你要停下，而且没有任何后台任务会来唤醒你。按顺序判断，只做第一条成立的：
1. 队列里有不依赖别人就能做的下一项（本机持有的 state/<线>.md 的“下一步”；旧项目看 STATE.md）→ 现在就做，不要先汇报再等。
2. 在等长任务或子代理 → 用后台的 rk wait（或已在后台运行的子代理）把唤醒架好，再结束这一轮；不要找事做来填时间。
3. 需要用户决定 → 写进 SUMMARY.md 的“需要你决定的事”，执行 rk block "<要决定的事>"，然后明确地问。
4. 达到停机条件或用户叫停 → 更新 state/<线>.md 与 SUMMARY.md，执行 rk loop off，给出收尾汇报。
“我接下来会做 X”不是结束的理由：要么现在做 X，要么说明在等什么。'
# 用 additionalContext 而不是 decision:block：这是按设计给的提醒，不该在界面上显示成钩子错误。
# 两者受同样的防循环保护（下一次 stop_hook_active 为 true，连续续跑有上限）。
jq -n --arg r "$reason" '{hookSpecificOutput: {hookEventName: "Stop", additionalContext: $r}}'
exit 0
