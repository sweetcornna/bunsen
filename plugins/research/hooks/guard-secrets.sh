#!/usr/bin/env bash
# PreToolUse 钩子：私钥和口令不外泄。
#   1) 私钥正文和已登记的口令不进命令、文件、子代理任务说明或消息；
#   2) 不读出私钥和口令文件的内容：Read / Grep 这些文件，或在 Bash 里用 cat、head、grep、cp 之类处理它们。
#      只引用路径是允许的：ssh -i <私钥>、ssh-add、chmod、ls、--password-file <口令文件>。公钥（.pub）不受限。
# 口令登记在 ~/.config/research-plugin/secrets/ 下，一个文件一条（由 scripts/setup-lab.sh 写入）。
# 没有命中、没有登记、解析不了，一律放行。第 2 条是启发式检查，挡住常见写法，不是沙箱。
set -u
input=$(cat)
cfg="${RESEARCH_PLUGIN_CONFIG:-$HOME/.config/research-plugin}"
payload="$input" tool="" path="" cmd=""
if command -v jq >/dev/null 2>&1; then
  decoded=$(printf '%s' "$input" | jq -r '[.tool_input | .. | strings] | join("\n")' 2>/dev/null) && [ -n "$decoded" ] && payload="$decoded"
  tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null)
  path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null)
  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)
fi

block() {
  echo "【research】已拦截：${1}。密钥和口令只用于登录，只引用文件路径，不读出内容，不写进命令、文件、仓库、协作文档、子代理任务说明或任何消息，也不在回复里复述。SSH 用 ~/.ssh/config 里的别名（或 ssh -i <私钥路径>）；程序要口令时让它自己从文件读（例如 --password-file <路径>）。确实需要人看的，请用户自己打开。" >&2
  exit 2
}

# 1) 内容里出现私钥正文或已登记的口令
if printf '%s' "$payload" | grep -Eq -- '-----BEGIN [A-Z0-9 ]*PRIVATE[ ]KEY-----'; then
  block "这次调用的内容里含有私钥正文"
fi
if [ -d "$cfg/secrets" ]; then
  pats=$(cat "$cfg/secrets"/* 2>/dev/null | tr -d '\r' | awk 'length($0) >= 6')
  if [ -n "$pats" ] && printf '%s' "$payload" | grep -Fq -f <(printf '%s\n' "$pats"); then
    block "这次调用的内容里含有已登记的口令"
  fi
fi

# 2) 读出私钥或口令文件的内容
secret_refs() { # 标准输入里指向 keys/、secrets/ 的路径（.pub 除外），每行一个
  local toks
  toks=$(tr -s " \t'\"=;|&()<>\`," '\n')
  {
    printf '%s\n' "$toks" | grep -E '(research-plugin|RESEARCH_PLUGIN_CONFIG)\}?/(keys|secrets)(/|$)'
    printf '%s\n' "$toks" | grep -F -e "$cfg/keys" -e "$cfg/secrets"
  } | grep -vE '\.pub$' | sort -u
}

case "$tool" in
  Read | Grep)
    [ -n "$path" ] || exit 0
    p="$path"
    case "$p" in "~/"*) p="$HOME/${p#\~/}" ;; esac
    ref=$(printf '%s\n' "$p" | secret_refs | head -n1)
    [ -n "$ref" ] && block "这次调用要读取私钥或口令文件（${ref}）"
    ;;
  Bash)
    [ -n "$cmd" ] || exit 0
    ref=$(printf '%s\n' "$cmd" | secret_refs | head -n1)
    [ -n "$ref" ] || exit 0
    verbs='cat|less|more|head|tail|bat|nl|tac|rev|xxd|od|hexdump|strings|base64|grep|egrep|fgrep|rg|ag|sed|awk|cut|sort|uniq|diff|cmp|cp|mv|tee|pbcopy|xclip|openssl|gpg|vi|vim|nano|code|open'
    if printf '%s\n' "$cmd" | grep -Eq "(^|[[:space:];|&(\`/])($verbs)([[:space:]]|$)" ||
       printf '%s\n' "$cmd" | grep -Eq '<[[:space:]]*[^[:space:]<]*(keys|secrets)(/|[[:space:]]|$)'; then
      block "这条命令会读出私钥或口令文件的内容（${ref}）"
    fi
    ;;
esac
exit 0
