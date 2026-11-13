#!/usr/bin/env bash
# PreToolUse 钩子：研究线的状态文件 state/<线>.md 只由持有推进权的机器写。
# 本机持有哪些线，看 .loop/leases/<线>.json（rk line new / take 写入，rk handoff / release 删除）。
# 没有持有、或本机记录的租期已过，就拦下 Write / Edit。Bash 里的写法不在此列：rk check 按提交历史兜底。
# 不是研究项目、没有 state/、解析不了，一律放行。
set -u
input=$(cat)
. "$(dirname "$0")/lib.sh"
home=$(research_home)
[ -d "$home/state" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null)
[ -n "$path" ] || exit 0
case "$path" in /*) ;; *) path="${CLAUDE_PROJECT_DIR:-$PWD}/$path" ;; esac
dir=$(cd "$(dirname "$path")" 2>/dev/null && pwd -P) || exit 0
sd=$(cd "$home/state" && pwd -P) || exit 0
[ "$dir" = "$sd" ] || exit 0
name=$(basename "$path")
case "$name" in TEMPLATE.md) exit 0 ;; *.md) ;; *) exit 0 ;; esac
line=${name%.md}
c="$home/.loop/leases/$line.json"
if [ ! -f "$c" ]; then
  echo "【research】已拦截：这台机器没有研究线 $line 的推进权，不能改 state/$line.md。要在这里推进先 python3 $home/tools/rk.py line take $line（别的机器持有时，请它用 rk handoff 交接过来）；新线用 rk line new。" >&2
  exit 2
fi
deadline=$(jq -r '.deadline // 0 | floor' "$c" 2>/dev/null)
case "$deadline" in ''|*[!0-9]*) exit 0 ;; esac
if [ "$deadline" -lt "$(date +%s)" ]; then
  echo "【research】已拦截：本机记录的 $line 推进权已到期。先 python3 $home/tools/rk.py line beat 续租；被别的机器接管了会续不上，那就停下这条线，git pull 看现状。" >&2
  exit 2
fi
exit 0
