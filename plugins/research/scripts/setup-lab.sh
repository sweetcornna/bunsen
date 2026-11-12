#!/usr/bin/env bash
# 把实验室的密钥、口令和档案装到本机的私有配置目录。插件目录里不放任何密钥。
#
#   setup-lab.sh [--zip <密钥压缩包>] [--secret <名字>] [--profile <档案文件>]
#
#   --zip      解包后只取私钥和 .pub 公钥，放进 keys/（私钥 600）
#   --secret   从标准输入读一行口令，存为 secrets/<名字>（600）；口令不出现在命令行里
#   --profile  用给定文件作为实验室档案 lab.md（已有档案时不覆盖）
#
# 配置目录默认 ~/.config/research-plugin，可用 RESEARCH_PLUGIN_CONFIG 覆盖。
# 本脚本只打印文件名，从不打印密钥或口令的内容。
set -eu
umask 077
cfg="${RESEARCH_PLUGIN_CONFIG:-$HOME/.config/research-plugin}"
plugin="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$cfg/keys" "$cfg/secrets"
chmod 700 "$cfg" "$cfg/keys" "$cfg/secrets"

profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --zip)
      zip="${2:?--zip 需要一个路径}"
      shift 2
      [ -f "$zip" ] || { echo "找不到压缩包：$zip" >&2; exit 2; }
      tmp=$(mktemp -d)
      unzip -q -o "$zip" -d "$tmp"
      while IFS= read -r -d '' f; do
        base=$(basename "$f")
        case "$base" in .*) continue ;; esac
        if head -n1 "$f" | grep -Eq -- '-----BEGIN [A-Z0-9 ]*PRIVATE[ ]KEY-----'; then
          cp "$f" "$cfg/keys/$base"
          chmod 600 "$cfg/keys/$base"
          echo "私钥：keys/$base"
        elif [ "${base##*.}" = "pub" ]; then
          cp "$f" "$cfg/keys/$base"
          chmod 644 "$cfg/keys/$base"
          echo "公钥：keys/$base"
        else
          echo "跳过：$base"
        fi
      done < <(find "$tmp" -type f -print0)
      rm -rf "$tmp"
      ;;
    --secret)
      name="${2:?--secret 需要一个名字}"
      shift 2
      case "$name" in *[!A-Za-z0-9._-]*|'') echo "口令名只能用字母、数字、点、下划线和连字符" >&2; exit 2 ;; esac
      IFS= read -r value || true
      [ -n "$value" ] || { echo "标准输入里没有读到口令" >&2; exit 2; }
      printf '%s\n' "$value" > "$cfg/secrets/$name"
      chmod 600 "$cfg/secrets/$name"
      echo "口令：secrets/$name（已保存，内容不显示）"
      ;;
    --profile)
      profile="${2:?--profile 需要一个路径}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "不认识的参数：$1" >&2
      exit 2
      ;;
  esac
done

if [ -f "$cfg/lab.md" ]; then
  echo "档案：$cfg/lab.md（已存在，未改动）"
else
  cp "${profile:-$plugin/skills/lab-access/lab-profile.example.md}" "$cfg/lab.md"
  chmod 600 "$cfg/lab.md"
  if [ -n "$profile" ]; then echo "档案：$cfg/lab.md"; else echo "档案：$cfg/lab.md（示例，请按实际情况填写）"; fi
fi
echo "配置目录：$cfg"
