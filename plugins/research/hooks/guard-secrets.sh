#!/usr/bin/env bash
# PreToolUse 钩子：私钥正文和已登记的口令不进命令、文件、子代理任务说明或消息。
# 口令登记在 ~/.config/research-plugin/secrets/ 下，一个文件一条（由 scripts/setup-lab.sh 写入）。
# 没有命中、没有登记、解析不了，一律放行。
set -u
input=$(cat)
payload="$input"
if command -v jq >/dev/null 2>&1; then
  decoded=$(printf '%s' "$input" | jq -r '[.tool_input | .. | strings] | join("\n")' 2>/dev/null) && [ -n "$decoded" ] && payload="$decoded"
fi

hit=""
if printf '%s' "$payload" | grep -Eq -- '-----BEGIN [A-Z0-9 ]*PRIVATE[ ]KEY-----'; then
  hit="私钥正文"
else
  dir="${RESEARCH_PLUGIN_CONFIG:-$HOME/.config/research-plugin}/secrets"
  if [ -d "$dir" ]; then
    pats=$(cat "$dir"/* 2>/dev/null | tr -d '\r' | awk 'length($0) >= 6')
    if [ -n "$pats" ] && printf '%s' "$payload" | grep -Fq -f <(printf '%s\n' "$pats"); then
      hit="已登记的口令"
    fi
  fi
fi
[ -n "$hit" ] || exit 0

echo "【research】已拦截：这次调用的内容里含有${hit}。密钥和口令只用于登录，不写进命令、文件、仓库、协作文档、子代理任务说明或任何消息，也不在回复里复述。改用引用方式：SSH 走 ~/.ssh/config 里的 IdentityFile；需要口令的地方让程序自己从凭据文件读取。" >&2
exit 2
