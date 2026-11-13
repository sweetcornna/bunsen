#!/usr/bin/env bash
# 把科研插件的源目录同步进 plugins/research（内嵌进可执行文件的那一份）。
# 用法：dev/sync-plugin.sh <插件源目录>    或设置 RESEARCH_PLUGIN_SRC
set -euo pipefail
cd "$(dirname "$0")/.."
src="${1:-${RESEARCH_PLUGIN_SRC:-}}"
[ -n "$src" ] && [ -f "$src/.claude-plugin/plugin.json" ] || { echo "用法：dev/sync-plugin.sh <插件源目录>" >&2; exit 2; }
mkdir -p plugins/research
rsync -a --delete --delete-excluded --exclude __pycache__ --exclude '*.pyc' --exclude .git --exclude .claude --exclude tests --exclude keys --exclude secrets \
  --exclude 'id_*' --exclude '*.pem' --exclude '*.key' --exclude lab.md --exclude '.env*' --exclude .DS_Store \
  "$src"/ plugins/research/
echo "已同步：$(find plugins/research -type f | wc -l | tr -d ' ') 个文件"
