#!/usr/bin/env bash
# SessionStart 钩子：在研究项目里，会话开始或上下文压缩之后把状态重新锚定到文件上。
# 不是研究项目（没有 PROJECT.md）时不输出任何东西。
set -u
input=$(cat)
. "$(dirname "$0")/lib.sh"
home=$(research_home)
[ -f "$home/PROJECT.md" ] || exit 0

src="startup"
if command -v jq >/dev/null 2>&1; then
  src=$(printf '%s' "$input" | jq -r '.source // "startup"' 2>/dev/null)
else
  case "$input" in *'"compact"'*) src="compact" ;; esac
fi

if [ -f "$home/.loop/active" ]; then
  if [ "$src" = "compact" ]; then
    cat <<EOF
【research】上下文刚被压缩，记忆不可靠。若你是本项目研究循环的统筹者，在做任何别的事之前：
1. 重新加载技能 research:orchestrator（需要细节时再读 research:protocol）。
2. 按恢复清单重读：本机持有的 state/<线>.md（见下）→ $home/STATE.md（总览）→ SUMMARY.md → OVERVIEW.md → LEDGER.md → LOG.md 末尾 → LESSONS.md → IDEAS.md；用了共享算力再读协作文档。
3. 执行 python3 $home/tools/rk.py status 核对在跑的运行；子代理是否还在跑以任务通知为准。
然后从本机持有的研究线（state/<线>.md）的“下一步”继续；还没有研究线的旧项目看 STATE.md。不凭记忆行动，不重做已有产物的步骤。
--- STATE.md 开头 ---
EOF
    [ -f "$home/STATE.md" ] && head -n 60 "$home/STATE.md"
    for c in "$home"/.loop/leases/*.json; do
      [ -f "$c" ] || continue
      l=$(basename "$c" .json)
      [ -f "$home/state/$l.md" ] || continue
      echo "--- state/$l.md（本机持有推进权）---"
      head -n 60 "$home/state/$l.md"
    done
  else
    echo "【research】本项目有一个开着的研究循环（$(sed -n 's/^started: *//p' "$home/.loop/active" | head -n1) 启动）。接着做用 /research:resume；只看进展用 /research:status；停下用 /research:stop。"
  fi
else
  [ "$src" = "compact" ] || echo "【research】本项目是 research 插件管理的研究项目（研究目录 ${home}），循环当前未运行。继续用 /research:resume，只看进展用 /research:status。"
fi
exit 0
