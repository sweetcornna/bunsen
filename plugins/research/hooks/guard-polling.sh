#!/usr/bin/env bash
# PreToolUse 钩子（Bash）：等待靠唤醒，不靠轮询。研究项目里，前台的长等待和反复查看进度，
# 每一次都要把整段上下文重新送一遍模型，白白消耗 token。拦下三类写法：
#   1) 前台的 watch、tail -f / -F / --follow：不会自己结束；
#   2) 前台 sleep 30 秒及以上（含 sleep 2m 这类写法，也含 while …; do sleep 60; done）；
#   3) 同一会话一小时内第 6 次查看进度（nvidia-smi、gpustat、nvitop、squeue、rk status）。
# 放到后台（run_in_background）的命令不管：那正是等待器的做法。命令里带 research:allow-wait 标记时放行。
# 非研究项目、没有 jq、解析不了，一律放行。
set -u
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
. "$(dirname "$0")/lib.sh"
[ -d "$(research_home)" ] || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
[ "$tool" = Bash ] || exit 0
bg=$(printf '%s' "$input" | jq -r '.tool_input.run_in_background // false' 2>/dev/null)
[ "$bg" = true ] && exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
[ -n "$cmd" ] || exit 0
case "$cmd" in *research:allow-wait*) exit 0 ;; esac
sid=$(printf '%s' "$input" | jq -r '.session_id // "nosession"' 2>/dev/null)

block() {
  echo "【research】已拦截：${1}。等长任务的做法：用 Bash 的 run_in_background 跑一个结束才退出的等待器（rk wait <运行ID>；或 while kill -0 <pid>; do sleep 60; done，失败时也要退出），然后结束这一轮，等它退出时的通知。等待期间不看日志、不查显卡、不问进度。确实需要短暂的前台等待，在命令里加注释 # research:allow-wait。" >&2
  exit 2
}

# 1) watch、tail -f
if printf '%s\n' "$cmd" | grep -Eq '(^|[;&|(]|\$\()[[:space:]]*(sudo[[:space:]]+)?watch[[:space:]]'; then
  block "前台的 watch 会一直占着这一轮"
fi
if printf '%s\n' "$cmd" | grep -Eq '(^|[;&|([:space:]])tail[[:space:]]+([^;&|]*[[:space:]])?(-[a-zA-Z0-9]*[fF][a-zA-Z0-9]*|--follow)'; then
  block "前台的 tail -f 不会自己结束"
fi

# 2) 前台长 sleep
secs=$(printf '%s\n' "$cmd" | grep -oE '(^|[^[:alnum:]_.-])sleep[[:space:]]+[0-9.]+[smhd]?' | awk '
  { v = $NF; u = substr(v, length(v)); n = v + 0
    if (u == "m") n *= 60; else if (u == "h") n *= 3600; else if (u == "d") n *= 86400
    if (n > m) m = n }
  END { print int(m + 0) }')
if [ "${secs:-0}" -ge 30 ]; then
  block "前台 sleep ${secs} 秒"
fi

# 3) 反复查看进度
if printf '%s\n' "$cmd" | grep -Eq '(^|[^[:alnum:]_-])(nvidia-smi|gpustat|nvitop|squeue)([^[:alnum:]_-]|$)|rk(\.py)?[[:space:]]+status([^[:alnum:]_-]|$)'; then
  dir="${TMPDIR:-/tmp}/research-plugin-poll"
  mkdir -p "$dir" 2>/dev/null || exit 0
  f="$dir/$(printf '%s' "$sid" | tr -c 'A-Za-z0-9_-' '_')"
  now=$(date +%s)
  recent=$(awk -v t=$((now - 3600)) '$1 >= t' "$f" 2>/dev/null)
  n=$(printf '%s\n' "$recent" | grep -c '[0-9]')
  if [ "$n" -ge 5 ]; then
    block "一小时内第 $((n + 1)) 次查看进度（nvidia-smi、rk status 之类）"
  fi
  { [ -n "$recent" ] && printf '%s\n' "$recent"; echo "$now"; } > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f"
fi
exit 0
