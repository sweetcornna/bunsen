# 钩子共用：定位研究目录。被 source，不单独执行。
# 研究目录默认是 <项目>/research；项目里有 .claude/research-home 时以它的第一行为准。
research_home() {
  local proj="${CLAUDE_PROJECT_DIR:-$PWD}" rel="research"
  if [ -f "$proj/.claude/research-home" ]; then
    rel=$(head -n1 "$proj/.claude/research-home" | tr -d '\r')
    [ -n "$rel" ] || rel="research"
  fi
  case "$rel" in
    /*) printf '%s\n' "$rel" ;;
    *) printf '%s\n' "$proj/$rel" ;;
  esac
}
