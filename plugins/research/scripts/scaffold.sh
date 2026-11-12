#!/usr/bin/env bash
# 在项目里建立研究目录：只补缺失的文件，从不覆盖已有内容。
#   scaffold.sh <项目目录> [研究目录名，默认 research]
set -eu
proj="${1:?用法：scaffold.sh <项目目录> [研究目录名]}"
rel="${2:-research}"
src="$(cd "$(dirname "$0")/../templates/research" && pwd)"
[ -d "$proj" ] || { echo "项目目录不存在：$proj" >&2; exit 2; }
proj="$(cd "$proj" && pwd)"
home="$proj/$rel"

created=0
while IFS= read -r -d '' f; do
  dst="$home/${f#"$src"/}"
  if [ ! -e "$dst" ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$f" "$dst"
    created=$((created + 1))
  fi
done < <(find "$src" -type f ! -name '.DS_Store' ! -name '*.pyc' -print0)
mkdir -p "$home/runs" "$home/results" "$home/prereg" "$home/strategy"
chmod +x "$home/tools/"*.py 2>/dev/null || true

if [ "$rel" != "research" ]; then
  mkdir -p "$proj/.claude"
  printf '%s\n' "$rel" > "$proj/.claude/research-home"
fi

echo "研究目录：$home（新建 $created 个文件，已有的未动）"
echo "下一步：填写 $home/PROJECT.md；工具入口 python3 $rel/tools/rk.py"
