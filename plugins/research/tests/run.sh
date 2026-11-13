#!/usr/bin/env bash
# 插件自带脚本的端到端测试：脚手架、rk、collab、全部钩子。
#   bash tests/run.sh
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0
out=""
ok() { pass=$((pass + 1)); echo "  ok   $1"; }
no() { fail=$((fail + 1)); echo "  FAIL $1"; printf '%s\n' "$out" | sed 's/^/         /'; }
expect() { # expect <期望退出码> <名称> <命令...>
  local want=$1 name=$2 got
  shift 2
  out=$("$@" 2>&1)
  got=$?
  if [ "$got" = "$want" ]; then ok "$name"; else no "$name（退出码 $got，期望 $want）"; fi
}
has() { case "$out" in *"$1"*) ok "$2" ;; *) no "$2（输出里没有“$1”）" ;; esac; }
hasnt() { case "$out" in *"$1"*) no "$2（输出里不该有“$1”）" ;; *) ok "$2" ;; esac; }

echo "== 脚手架"
proj="$tmp/proj"
mkdir -p "$proj"
git -C "$proj" init -q
git -C "$proj" config user.email test@example.invalid
git -C "$proj" config user.name test
expect 0 "首次建立研究目录" bash "$root/scripts/scaffold.sh" "$proj"
[ -f "$proj/research/PROJECT.md" ] && [ -f "$proj/research/tools/rk.py" ] && ok "模板文件到位" || no "模板文件缺失"
[ "$(git -C "$proj" check-attr merge -- research/LEDGER.md | sed 's/.*: //')" = union ] && ok "只追加的文件设了 union 合并" || no "缺 .gitattributes"
echo "改过的内容" >> "$proj/research/PROJECT.md"
expect 0 "再次执行不覆盖" bash "$root/scripts/scaffold.sh" "$proj"
has "新建 0 个文件" "已有文件未动"
grep -q "改过的内容" "$proj/research/PROJECT.md" && ok "用户内容保留" || no "用户内容被覆盖"
git -C "$proj" add -A && git -C "$proj" commit -qm init

rk() { (cd "$proj" && env -u CLAUDE_CODE_SESSION_ID RK_MACHINE_NAME="${RKN:-mac}" python3 research/tools/rk.py "$@"); }

echo "== rk：运行与等待"
expect 2 "拒绝不合规的运行 ID" rk run bad-id --explore -- true
expect 2 "必须在 --prereg 与 --explore 之间二选一" rk run 20260101-mac-r01-x -- true
expect 0 "启动探索性运行" rk run 20260101-mac-r01-smoke --explore -- sh -c 'echo hello; printf "{\"acc\": 0.9123, \"sub\": {\"f1\": 0.5}}" > "$RESEARCH_RUN_DIR/metrics.json"'
expect 0 "等待到成功结束" rk wait 20260101-mac-r01-smoke --interval 1 --poll 0.2
has "| ok |" "状态为 ok"
has "hello" "带出日志最后一行"
expect 2 "运行 ID 不可复用" rk run 20260101-mac-r01-smoke --explore -- true
expect 0 "启动会失败的运行" rk run 20260101-mac-r02-boom --explore -- sh -c 'exit 7'
expect 1 "失败的运行让 wait 返回 1" rk wait 20260101-mac-r02-boom --interval 1 --poll 0.2
has "退出码 7" "报告真实退出码"
expect 0 "启动长任务" rk run 20260101-mac-r03-long --explore -- sleep 60
expect 3 "到状态间隔返回 3" rk wait 20260101-mac-r03-long --interval 0.01 --poll 0.2
has "仍在运行" "到点时说明仍在运行"
kill "$(cat "$proj/research/runs/20260101-mac-r03-long/pid")" 2>/dev/null
expect 1 "被中断的运行算失败" rk wait 20260101-mac-r03-long --interval 1 --poll 0.2
expect 3 "纯计时等待" rk wait --interval 0.01 --poll 0.2
expect 0 "启动不存在的命令" rk run 20260101-mac-r04-nocmd --explore -- /nonexistent/binary
expect 1 "启动失败记为失败" rk wait 20260101-mac-r04-nocmd --interval 1 --poll 0.2
has "退出码 127" "启动失败的退出码是 127"

echo "== rk：运行 ID 带机器代号"
expect 0 "查看本机代号" rk id
has "本机代号：mac" "报出代号与来源"
expect 0 "生成下一个运行 ID" rk id probe
printf '%s' "$out" | grep -qE '^[0-9]{8}-mac-r01-probe$' && ok "形如 日期-代号-r01-简称" || no "ID 格式不对"
nid="$out"
expect 0 "用生成的 ID 登记" rk run "$nid" --explore --manual
expect 0 "再生成一个" rk id probe
case "$out" in *-mac-r02-probe) ok "同日同机编号递增" ;; *) no "编号没有递增" ;; esac
rk done "$nid" >/dev/null
expect 2 "新运行不接受不带代号的旧格式" rk run 20260101-r09-old --explore -- true
has "要带本机代号" "说明新格式"
has "rk id" "指向 rk id"
expect 2 "不接受别的机器的代号" rk run 20260101-srv-r09-x --explore -- true
has "本机是 mac" "说明本机代号"
expect 2 "代号不合规时报错" env RKN=R2 bash -c "cd '$proj' && RK_MACHINE_NAME=R2 python3 research/tools/rk.py id"
expect 2 "代号不能是 r 加数字" bash -c "cd '$proj' && RK_MACHINE_NAME=r12 python3 research/tools/rk.py id"
expect 0 "默认代号从主机名推出" python3 - "$proj/research/tools/rk.py" <<'EOF'
import importlib.util, re, sys, types
spec = importlib.util.spec_from_file_location("rk", sys.argv[1]); rk = importlib.util.module_from_spec(spec); spec.loader.exec_module(rk)
import os; os.environ.pop("RK_MACHINE_NAME", None)
rk.sys = types.SimpleNamespace(platform="linux")
cases = {"gpu-node-03": "gpun03", "AliceMacBook-Pro": "alicembp", "DESKTOP-ABC123": "desktopa123",
         "ubuntu.lan": "ubuntu", "l40-server": "l40s", "10.0.0.2": None, "localhost": None, "r12": None}
for host, want in cases.items():
    rk.socket = types.SimpleNamespace(gethostname=lambda h=host: h); rk._NAME = None
    got = rk.machine_name()[0]
    assert rk.MACHINE_NAME_RE.match(got), (host, got)
    assert (got == want) if want else re.fullmatch(r"m[0-9a-f]{6}|mr12", got), (host, got, want)
print("ok")
EOF

echo "== rk：本机还是远程"
rkm() { local mid=$1; shift; (cd "$proj" && env -u CLAUDE_CODE_SESSION_ID RK_MACHINE_NAME=mac RK_MACHINE_ID="$mid" python3 research/tools/rk.py "$@"); }
expect 0 "启动长任务" rk run 20260101-mac-r07-host --explore -- sleep 30
m7="$proj/research/runs/20260101-mac-r07-host/meta.json"
sed -i.bak -E 's/"host": "[^"]*"/"host": "renamed-host"/' "$m7" && rm -f "$m7.bak"
expect 3 "主机名变了仍认作本机" rk wait 20260101-mac-r07-host --interval 0.01 --poll 0.2
has "| running |" "状态仍是 running"
expect 2 "机器标识不同才算远程" rkm other-machine wait 20260101-mac-r07-host --interval 0.01 --poll 0.2
has "跑在 renamed-host 上" "提示到那台主机上等"
expect 0 "rk check 对远程未结束的运行给警告" rkm other-machine check
has "rk pull" "提示结束后拉回"
kill "$(cat "$proj/research/runs/20260101-mac-r07-host/pid")" 2>/dev/null
expect 1 "结束" rk wait 20260101-mac-r07-host --interval 1 --poll 0.2

echo "== rk：预登记"
cat > "$proj/research/prereg/p1.md" <<'EOF'
# 预登记：p1
判定规则：acc 的 95% 区间下界 > 0.6 记为通过。
EOF
expect 2 "预登记未提交时拒绝启动" rk run 20260101-mac-r05-conf --prereg research/prereg/p1.md -- true
has "还没提交" "给出原因"
git -C "$proj" add -A && git -C "$proj" commit -qm "prereg p1"
echo "x" >> "$proj/research/LOG.md"
expect 2 "工作区有未提交改动时拒绝确认性运行" rk run 20260101-mac-r05-conf --prereg research/prereg/p1.md -- true
git -C "$proj" checkout -q -- research/LOG.md
expect 0 "预登记已提交后启动" rk run 20260101-mac-r05-conf --prereg research/prereg/p1.md -- sh -c 'printf "{\"acc\": 0.7149}" > "$RESEARCH_RUN_DIR/metrics.json"'
expect 0 "确认性运行结束" rk wait 20260101-mac-r05-conf --interval 1 --poll 0.2
expect 0 "手工批次登记" rk run 20260101-mac-r06-lit --explore --manual
expect 0 "status 列出手工批次" rk status
has "| open |" "手工批次状态为 open"
expect 0 "手工批次完成" rk done 20260101-mac-r06-lit --note "检索完成"
expect 2 "已结束的记录不改写" rk done 20260101-mac-r06-lit --fail
expect 0 "生成运行表" rk status --write
grep -q "20260101-mac-r05-conf" "$proj/research/RUNS.md" && ok "RUNS.md 含运行" || no "RUNS.md 缺运行"
m5="$proj/research/runs/20260101-mac-r05-conf/meta.json"
cp "$m5" "$tmp/m5.orig"
sed -i.bak -E 's/"started_at": "[^"]+"/"started_at": "2000-01-01T00:00:00+00:00"/' "$m5" && rm -f "$m5.bak"
expect 0 "启动时间早于预登记提交也不报错：先后看提交，不看时钟" rk check
hasnt "晚于启动时间" "不比较墙钟"
cp "$tmp/m5.orig" "$m5"
first=$(git -C "$proj" rev-list --max-parents=0 HEAD)
sed -i.bak -E "s/\"git_commit\": \"[0-9a-f]+\"/\"git_commit\": \"$first\"/" "$m5" && rm -f "$m5.bak"
expect 1 "预登记提交不是运行提交的祖先时报错" rk check
has "不是运行所用提交" "指出因果不对"
cp "$tmp/m5.orig" "$m5"
sed -i.bak -E 's/"git_commit": "[0-9a-f]+"/"git_commit": "0123456789abcdef0123456789abcdef01234567"/' "$m5" && rm -f "$m5.bak"
expect 1 "运行提交不在历史里时报错" rk check
has "先把那台机器的提交合并进来" "提示先合并"
cp "$tmp/m5.orig" "$m5"
sed -i.bak -E 's/"git_commit": "[0-9a-f]+"/"git_commit": null/; s/"started_at": "[^"]+"/"started_at": "2000-01-01T00:00:00+00:00"/' "$m5" && rm -f "$m5.bak"
expect 1 "旧记录没有提交号时退回比较时间" rk check
has "晚于启动时间" "旧记录仍核对时间"
cp "$tmp/m5.orig" "$m5"
sed -i.bak -E 's/"sha256": "[0-9a-f]+"/"sha256": "0000"/' "$m5" && rm -f "$m5.bak"
expect 1 "提交里的预登记与启动时内容不一致时报错" rk check
has "与启动时的内容不一致" "指出内容被换过"
cp "$tmp/m5.orig" "$m5"

echo "== rk：拉回远程记录"
remote="$tmp/remote"
mkdir -p "$remote"
git -C "$remote" init -q
bash "$root/scripts/scaffold.sh" "$remote" >/dev/null
rr() { (cd "$remote" && env -u CLAUDE_CODE_SESSION_ID RK_MACHINE_NAME="${RRN:-srv}" python3 research/tools/rk.py "$@"); }
rr run 20260102-srv-r01-far --explore -- sh -c 'echo far-log; printf "{\"acc\": 0.5}" > "$RESEARCH_RUN_DIR/metrics.json"' >/dev/null
rr run 20260102-srv-r02-slow --explore -- sleep 30 >/dev/null
RRN=mac rr run 20260101-mac-r01-smoke --explore -- true >/dev/null  # 两台机器误用同一代号时才会撞号
rr wait 20260102-srv-r01-far 20260101-mac-r01-smoke --interval 1 --poll 0.2 >/dev/null
expect 0 "拉回已结束的运行" rk pull "$remote/research" 20260102-srv-r01-far
has "补齐" "报告补齐的文件"
grep -q far-log "$proj/research/runs/20260102-srv-r01-far/log.txt" 2>/dev/null && ok "日志拉回来了" || no "缺日志"
[ ! -e "$proj/research/runs/20260102-srv-r01-far/pid" ] && [ ! -e "$proj/research/runs/20260102-srv-r01-far/sup.pid" ] && ok "不带 pid 文件" || no "带了 pid 文件"
[ -f "$proj/research/runs/20260102-srv-r01-far/pulled.json" ] && ok "记下来源" || no "没有 pulled.json"
expect 0 "拉回后本机能看到" rk status
has "| 20260102-srv-r01-far | 探索 | ok |" "状态为 ok"
expect 0 "再拉一次不改动" rk pull "$remote/research" 20260102-srv-r01-far
has "本机已齐" "幂等"
expect 1 "没结束的不拉" rk pull "$remote/research" 20260102-srv-r02-slow
has "还没结束" "说明原因"
[ ! -e "$proj/research/runs/20260102-srv-r02-slow" ] && ok "没留下半截记录" || no "留下了半截记录"
expect 1 "本机已有同 ID 的另一条运行时不合并" rk pull "$remote/research" 20260101-mac-r01-smoke
has "另一条运行" "说明冲突"
expect 1 "远程主机连不上时报错" rk pull nohost.invalid:/x 20260102-srv-r01-far
has "复制失败" "说明失败"
kill "$(cat "$remote/research/runs/20260102-srv-r02-slow/pid")" 2>/dev/null

echo "== rk：核验"
ov="$proj/research/OVERVIEW.md"
led="$proj/research/LEDGER.md"
cp "$ov" "$tmp/ov.orig"
cp "$led" "$tmp/led.orig"
echo "| 方法 A | acc | 0.715 | [0.66, 0.77] | 确认 | 20260101-mac-r05-conf:acc |" >> "$ov"
echo "| 冒烟 | f1 | 50.0% | - | 探索 | 20260101-mac-r01-smoke:sub.f1 |" >> "$ov"
echo "| 文献基线 | acc | 0.70 | - | 确认 | arXiv:0000.00000 |" >> "$ov"
expect 0 "数字与运行记录一致时通过" rk check
has "3 行总览" "逐行核对了总览表"
cp "$tmp/ov.orig" "$ov"; echo "| 方法 A | acc | 0.80 | - | 确认 | 20260101-mac-r05-conf:acc |" >> "$ov"
expect 1 "数字对不上时报错" rk check
has "运行记录是 0.7149" "指出真实数值"
cp "$tmp/ov.orig" "$ov"; echo "| 方法 A | acc | 0.715 | - | 确认 |  |" >> "$ov"
expect 1 "没有来源时报错" rk check
cp "$tmp/ov.orig" "$ov"; echo "| 冒烟 | acc | 0.912 | - | 确认 | 20260101-mac-r01-smoke:acc |" >> "$ov"
expect 1 "探索性运行不能标成确认" rk check
cp "$tmp/ov.orig" "$ov"; echo "| 失败的 | acc | 0.9 | - | 探索 | 20260101-mac-r02-boom:acc |" >> "$ov"
expect 1 "失败的运行不能进总览表" rk check
cp "$tmp/ov.orig" "$ov"
aud="$proj/research/audits"
printf '# 20260101-mac-r05-conf\n' > "$proj/research/results/20260101-mac-r05-conf.md"
echo "| C1 | 已证实 | 方法 A 在源内高于常数对照 | run:20260101-mac-r05-conf | 确认 | 2026-01-01 |" >> "$led"
expect 1 "已证实但没有审计记录时报错" rk check
has "没有通过独立审计" "指出缺审计"
C=20260101-mac-r05-conf; S=20260101-mac-r01-smoke
expect 0 "登记一次需退回的审计" rk audit record --runs "$C" --verdict 需退回
has "→ 需退回" "回报登记结果"
expect 1 "审计需退回时不能证实" rk check
has "总评是“需退回”" "给出审计结论"
printf '# 审计\n\n- 运行：%s, %s\n- **总评**：可采信\n\n报告正文\n' "$C" "$S" > "$tmp/report.md"
expect 0 "附报告登记可采信" rk audit record --runs "$C,$S" --verdict 可采信 --report "$tmp/report.md"
has "取代" "取代先前的审计"
rep=$(ls "$aud"/*.md | grep -v TEMPLATE | head -n1)
[ -n "$rep" ] && grep -q "报告正文" "$rep" && ok "报告复制进 audits/" || no "报告没复制"
expect 0 "有证据且当前审计可采信时通过" rk check
cp "$tmp/led.orig" "$led"; echo "| C1 | 已证实 | 经结果页引用 | results/$C.md | 确认 | 2026-01-01 |" >> "$led"
expect 0 "经结果页引用的运行同样核对审计" rk check
expect 0 "status 带审计一栏" rk status
has "| 可采信 |" "显示当前总评"
expect 0 "audit show" rk audit show "$C"
has "$C | 可采信" "列出当前总评"
expect 0 "重审推翻" rk audit record --runs "$C" --verdict 不可采信
expect 1 "后来的审计推翻时不能证实" rk check
has "不可采信" "以取代关系为准"
expect 0 "再审可采信" rk audit record --runs "$C" --verdict 可采信
expect 0 "新的登记取代旧的" rk check
printf '# 审计\n\n- 运行：%s\n- 总评：需退回\n' "$C" > "$tmp/r2.md"
expect 2 "报告与 --verdict 不一致时拒绝" rk audit record --runs "$C" --verdict 可采信 --report "$tmp/r2.md"
has "不一致" "说明不一致"
expect 2 "报告与 --runs 不一致时拒绝" rk audit record --runs "$S" --verdict 需退回 --report "$tmp/r2.md"
expect 2 "审计的运行不在本机时拒绝" rk audit record --runs 20260101-mac-r99-none --verdict 可采信
has "rk pull" "提示先拉回"
expect 2 "总评只能三选一" rk audit record --runs "$C" --verdict 通过
cp "$rep" "$tmp/rep.orig"; echo "改一句" >> "$rep"
expect 1 "登记后改动报告时报错" rk check
has "登记后被改过" "指出报告被改"
cp "$tmp/rep.orig" "$rep"
printf '{"audit_id": "20260101-000000-srv", "runs": ["%s"], "verdict": "需退回", "supersedes": {}}\n' "$C" > "$aud/20260101-000000-srv.json"
expect 1 "两台机器各自登记的审计并存时取较严的" rk check
has "并存" "指出并存"
rm -f "$aud/20260101-000000-srv.json"
echo '{"audit_id": "x"}' > "$aud/20260101-000001-bad.json"
expect 1 "不合规的审计记录报错" rk check
has "应由 rk audit record 生成" "指出格式问题"
rm -f "$aud/20260101-000001-bad.json"
printf '# 审计\n\n- 运行：%s\n- 总评：不可采信\n' "$S" > "$aud/20251231-0900-legacy.md"
expect 0 "没登记的旧格式报告仍按两行读，结构化记录优先" rk audit show "$S"
has "$S | 可采信" "结构化记录优先"
rm -f "$aud/20251231-0900-legacy.md"
printf '# 审计\n\n- 运行：%s\n' "$C" > "$aud/20260101-1300-bad.md"
expect 1 "没登记也没有两行的报告报错" rk check
has "没有登记" "指出要登记"
rm -f "$aud/20260101-1300-bad.md"
cp "$tmp/led.orig" "$led"; echo "| C1 | 已证实 | 没有证据的结论 |  | 确认 | 2026-01-01 |" >> "$led"
expect 1 "已证实却没有证据时报错" rk check
cp "$tmp/led.orig" "$led"; echo "| C1 | 已证实 | 靠失败运行支撑 | run:20260101-mac-r02-boom | 确认 | 2026-01-01 |" >> "$led"
expect 1 "失败的运行不能支撑已证实" rk check
cp "$tmp/led.orig" "$led"; echo "| C1 | 已否定 | 靠失败运行否定 | run:20260101-mac-r02-boom | 确认 | 2026-01-01 |" >> "$led"
expect 1 "失败的运行也不能支撑已否定" rk check
has "不能支撑“已否定”" "指出原因"
cp "$tmp/led.orig" "$led"; echo "| C1 | 未决 | 搁置，未否定 |  | 探索 | 2026-01-01 |" >> "$led"
expect 0 "未决的结论可以没有证据" rk check
cp "$tmp/led.orig" "$led"
echo "| C2 | 未决 | 方法 B 也许有效 |  | 探索 | 2026-01-02 |" >> "$led"
git -C "$proj" add research/LEDGER.md && git -C "$proj" commit -qm "ledger C2"
echo "| C3 | 未决 | 追加一行 |  | 探索 | 2026-01-03 |" >> "$led"
expect 0 "追加新行通过" rk check
cp "$led" "$tmp/led.appended"
sed -i.bak 's/方法 B 也许有效/方法 B 有效/' "$led" && rm -f "$led.bak"
expect 1 "改动已提交的旧行时报错" rk check
has "旧行被改动或删除" "指出旧行变了"
grep -v "方法 B" "$tmp/led.appended" > "$led"
expect 1 "删除已提交的旧行时报错" rk check
cp "$tmp/led.appended" "$led"
expect 0 "恢复后通过" rk check
expect 0 "test_records.py 可直接运行" bash -c "cd '$proj' && python3 research/tools/test_records.py"

echo "== rk：循环开关"
expect 0 "开" rk loop on --session S1
expect 0 "登记在等用户" rk block "层级 1 还是层级 2"
expect 0 "状态" rk loop status
has "在等用户" "status 显示在等用户"
expect 0 "解除" rk unblock

echo "== 钩子：Stop"
gate() { printf '%s' "$1" | CLAUDE_PROJECT_DIR="$proj" bash "$root/hooks/stop-gate.sh"; }
nag='"additionalContext"'
expect 0 "循环开着且无后台任务：提醒" gate '{"session_id":"S1","stop_hook_active":false}'
has "$nag" "以 additionalContext 提醒"
hasnt '"decision"' "不用 decision:block（不显示成钩子错误）"
printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "Stop"' >/dev/null && ok "输出是合法的 Stop 钩子 JSON" || no "输出格式不对"
expect 0 "已提醒过一次：放行" gate '{"session_id":"S1","stop_hook_active":true}'
hasnt "$nag" "不再拦"
expect 0 "有后台任务在跑：放行" gate '{"session_id":"S1","background_tasks":[{"id":"1","type":"shell","status":"running"}]}'
hasnt "$nag" "等待中不拦"
expect 0 "有定时唤醒：放行" gate '{"session_id":"S1","background_tasks":[],"session_crons":[{"id":"c1","schedule":"*/30 * * * *","recurring":true,"prompt":"x"}]}'
hasnt "$nag" "定时唤醒也算等待"
expect 0 "后台任务都结束了：提醒" gate '{"session_id":"S1","background_tasks":[{"id":"1","type":"shell","status":"completed"}]}'
has "$nag" "结束的任务不算等待"
expect 0 "别的会话：放行" gate '{"session_id":"OTHER"}'
hasnt "$nag" "不管别的会话"
rk block "等用户" >/dev/null
expect 0 "在等用户：放行" gate '{"session_id":"S1"}'
hasnt "$nag" "等用户时不拦"
rk unblock >/dev/null
rk loop on >/dev/null
expect 0 "未绑定会话：第一次停下时绑定" gate '{"session_id":"S9"}'
grep -q "^session: S9" "$proj/research/.loop/active" && ok "已绑定 S9" || no "未绑定会话"
rk loop off >/dev/null
expect 0 "循环关着：放行" gate '{"session_id":"S9"}'
hasnt "$nag" "关着不拦"

echo "== 钩子：用户答复"
ur() { printf '%s' "$1" | CLAUDE_PROJECT_DIR="$proj" bash "$root/hooks/user-reply.sh"; }
bl="$proj/research/.loop/blocked"
rk loop on --session S1 >/dev/null
rk block "层级 1 还是层级 2" >/dev/null
expect 0 "任务通知不算答复" ur '{"session_id":"S1","prompt":"<task-notification>\n<status>completed</status>"}'
[ -s "$bl" ] && ok "仍在等用户" || no "被任务通知解除了"
expect 0 "/research:status 不算答复" ur '{"session_id":"S1","prompt":"/research:status"}'
[ -s "$bl" ] && ok "查看现状不解除" || no "被 status 解除了"
expect 0 "别的会话不解除" ur '{"session_id":"OTHER","prompt":"用层级 2"}'
[ -s "$bl" ] && ok "别的会话的消息不算" || no "被别的会话解除了"
expect 0 "用户答复后解除" ur '{"session_id":"S1","prompt":"用层级 2"}'
has "已解除" "告诉统筹者解除了"
has "层级 1 还是层级 2" "带上原来在等的事"
printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "UserPromptSubmit"' >/dev/null && ok "输出是合法的钩子 JSON" || no "输出格式不对"
[ ! -e "$bl" ] && ok "登记已删除" || no "登记还在"
expect 0 "没有在等时不输出" ur '{"session_id":"S1","prompt":"继续"}'
[ -z "$out" ] && ok "输出为空" || no "不该有输出"
expect 0 "Stop 钩子重新生效" gate '{"session_id":"S1"}'
has "$nag" "答复之后又会提醒"
rk loop off >/dev/null

echo "== 钩子：SubagentStart"
sa() { printf '%s' "$1" | CLAUDE_PROJECT_DIR="$2" CLAUDE_PLUGIN_ROOT="$root" bash "$root/hooks/subagent-start.sh"; }
expect 0 "执行者：注入研究目录与协议" sa '{"agent_type":"research:executor"}' "$proj"
has "$root/skills/protocol/SKILL.md" "给出协议路径"
has "$proj/research" "给出研究目录"
printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "SubagentStart"' >/dev/null && ok "输出是合法的钩子 JSON" || no "输出格式不对"
expect 0 "审计员：说明报告格式" sa '{"agent_type":"research:auditor"}' "$proj"
has "总评：可采信" "要求总评一行"
expect 0 "调研员" sa '{"agent_type":"research:scout"}' "$proj"
has "调研员" "按角色注入"
expect 0 "别的代理不注入" sa '{"agent_type":"Explore"}' "$proj"
[ -z "$out" ] && ok "输出为空" || no "不该有输出"
expect 0 "非研究项目不注入" sa '{"agent_type":"research:executor"}' "$tmp"
[ -z "$out" ] && ok "输出为空" || no "不该有输出"

echo "== 钩子：配置"
expect 0 "hooks.json 是合法 JSON" jq -e . "$root/hooks/hooks.json"
for s in $(jq -r '.. | .command? // empty' "$root/hooks/hooks.json" | grep -oE 'hooks/[a-z-]+\.sh'); do
  [ -f "$root/$s" ] && ok "$s 存在" || no "$s 不存在"
done
expect 0 "plugin.json 是合法 JSON" jq -e '.name == "research"' "$root/.claude-plugin/plugin.json"

echo "== 钩子：SessionStart"
ss() { printf '%s' "$1" | CLAUDE_PROJECT_DIR="$2" bash "$root/hooks/session-start.sh"; }
expect 0 "非研究项目不输出" ss '{"source":"startup"}' "$tmp"
[ -z "$out" ] && ok "输出为空" || no "不该有输出"
expect 0 "研究项目、循环未开" ss '{"source":"startup"}' "$proj"
has "循环当前未运行" "提示如何继续"
rk loop on --session S1 >/dev/null
expect 0 "压缩后重新锚定" ss '{"source":"compact"}' "$proj"
has "上下文刚被压缩" "给出恢复清单"
has "当前状态" "附上 STATE.md 开头"
rk loop off >/dev/null

echo "== 钩子：密钥"
cfg="$tmp/cfg"
mkdir -p "$cfg/secrets"
printf 'S3cr3t-Value!%%=#x\n' > "$cfg/secrets/web-password"
guard() { printf '%s' "$1" | RESEARCH_PLUGIN_CONFIG="$cfg" bash "$root/hooks/guard-secrets.sh"; }
expect 0 "普通调用放行" guard '{"tool_name":"Bash","tool_input":{"command":"ssh l40 nvidia-smi"}}'
key_header="-----BEGIN OPENSSH PRIVATE"" KEY-----"
expect 2 "拦截私钥正文" guard "{\"tool_name\":\"Write\",\"tool_input\":{\"content\":\"$key_header\\nabc\"}}"
expect 2 "拦截已登记的口令" guard '{"tool_name":"Agent","tool_input":{"prompt":"登录用 S3cr3t-Value!%=#x 这个密码"}}'
expect 0 "只引用凭据文件路径放行" guard '{"tool_name":"Bash","tool_input":{"command":"curl --netrc-file ~/.config/research-plugin/netrc https://example.invalid"}}'
expect 2 "拦截 cat 口令文件" guard '{"tool_name":"Bash","tool_input":{"command":"cat ~/.config/research-plugin/secrets/web-password"}}'
has "读出私钥或口令文件的内容" "说明拦截原因"
expect 2 "拦截 head 私钥（经 \$HOME）" guard '{"tool_name":"Bash","tool_input":{"command":"cd /tmp && head -c 40 $HOME/.config/research-plugin/keys/id_lab"}}'
expect 2 "拦截重定向读入" guard '{"tool_name":"Bash","tool_input":{"command":"pw=$(< ~/.config/research-plugin/secrets/web-password); echo ok"}}'
expect 2 "拦截自定义配置目录下的读取" guard "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"grep -r pass $cfg/secrets\"}}"
expect 2 "拦截 Read 私钥" guard '{"tool_name":"Read","tool_input":{"file_path":"~/.config/research-plugin/keys/id_lab"}}'
expect 2 "拦截 Grep 口令目录" guard "{\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"a\",\"path\":\"$cfg/secrets\"}}"
expect 0 "ssh -i 引用私钥放行" guard '{"tool_name":"Bash","tool_input":{"command":"ssh -o BatchMode=yes -o IdentitiesOnly=yes -i ~/.config/research-plugin/keys/id_lab -p 22 u@10.0.0.2 true"}}'
expect 0 "chmod 与 ls 放行" guard '{"tool_name":"Bash","tool_input":{"command":"chmod 600 ~/.config/research-plugin/keys/id_lab && ls -l ~/.config/research-plugin/keys"}}'
expect 0 "程序自己读口令文件放行" guard '{"tool_name":"Bash","tool_input":{"command":"python3 login.py --password-file ~/.config/research-plugin/secrets/web-password"}}'
expect 0 "公钥放行" guard '{"tool_name":"Read","tool_input":{"file_path":"/Users/x/.config/research-plugin/keys/id_lab.pub"}}'
expect 0 "实验室档案放行" guard '{"tool_name":"Bash","tool_input":{"command":"cat ~/.config/research-plugin/lab.md"}}'
expect 0 "普通 Read 放行" guard '{"tool_name":"Read","tool_input":{"file_path":"/Users/x/project/research/LOG.md"}}'

echo "== collab"
shared="$tmp/shared"
mkdir -p "$shared"
cp "$root/templates/research/tools/collab.py" "$shared/collab.py"
co() { COLLAB_NOW="${NOW:-2026-01-01 10:00:00}" python3 "$shared/collab.py" "$@"; }
expect 2 "文档不存在时提示先 init" co show
expect 0 "init 创建" co init
expect 0 "init 幂等" co init
expect 0 "登记会话" co register --session A --branch research/a --work "基线" --next "筛选"
expect 0 "更新计划保留其他栏" co plan --session A --next "确认"
expect 0 "读自己的行" co show --section 1
has "| A | research/a | 基线 | 确认 |" "计划已更新、分支保留"
expect 0 "A 认领 l40:0" co claim --session A --host l40 --gpu 0 --run 20260101-mac-r05-conf --mem 20GB --until "2026-01-01 12:00"
expect 3 "B 不能抢同一张卡" co claim --session B --host l40 --gpu 0 --run r --mem 20GB --until "2026-01-01 12:00"
has "不抢卡" "给出不抢卡的提示"
expect 2 "A 重复认领被拒" co claim --session A --host l40 --gpu 0 --run r --mem 20GB --until "2026-01-01 12:00"
expect 2 "预计结束时间不能在过去" co claim --session A --host l40 --gpu 3 --run r --mem 20GB --until "2025-12-31 12:00"
expect 0 "心跳" co beat --session A
expect 0 "延长" co extend --session A --host l40 --gpu 0 --until "2026-01-01 13:00"
expect 0 "B 排队" co queue --session B --need "1×24GB" --dur 3h --hosts l40
expect 3 "C 不能越过排在前面的 B" co claim --session C --host l40 --gpu 1 --run r --mem 20GB --until "2026-01-01 12:00"
expect 0 "别的主机不受排队影响" co claim --session C --host 3090 --gpu 5 --run r --mem 20GB --until "2026-01-01 12:00"
expect 0 "轮到 B 认领" co claim --session B --host l40 --gpu 1 --run rB --mem 20GB --until "2026-01-01 11:00"
expect 0 "B 标记已拿到" co dequeue --session B --got
expect 0 "A 的用卡上限 1：第一张" co claim --session A --host 3090 --gpu 0 --run r --mem 20GB --until "2026-01-01 12:00" --max 1
expect 3 "A 的用卡上限 1：第二张被拒" co claim --session A --host 3090 --gpu 1 --run r --mem 20GB --until "2026-01-01 12:00" --max 1
expect 3 "B 不能释放 A 的卡" co release --session B --host l40 --gpu 0
expect 0 "A 释放" co release --session A --host l40 --gpu 0
expect 0 "释放后可见" co show --section 2
has "已释放 2026-01-01 10:00:00" "写了实际结束时间"
expect 3 "未过期不能接替" co claim --session C --host l40 --gpu 1 --run r --mem 20GB --until "2026-01-01 12:00" --takeover --evidence x
NOW="2026-01-01 12:00:00"
expect 0 "列出疑似过期" co stale
has "l40:1 B" "B 的认领疑似过期"
expect 2 "接替要带证据" co claim --session C --host l40 --gpu 1 --run rC --mem 20GB --until "2026-01-01 14:00" --takeover
expect 0 "带证据接替" co claim --session C --host l40 --gpu 1 --run rC --mem 20GB --until "2026-01-01 14:00" --takeover --evidence "12:00 nvidia-smi 上 l40:1 无进程"
expect 0 "接替写进留言且对方那行不动" co show
has "接替过期认领 l40:1" "留言里有证据"
has "| l40 | 1 | B | rB |" "B 的行还在"
NOW="2026-01-01 10:00:00"
expect 0 "追加结果" co log --session A --kind 结果 "方法 A 源内 acc 0.715；见 results/20260101-mac-r05-conf.md"
expect 0 "留言" co msg --session A --to 全体 "l40:2 风扇报警；请在 12:00 前答复"
expect 0 "回复" co reply --session B --match "风扇报警" "收到，B 不用 l40:2"
expect 0 "回复挂在留言下面" co show --section 5
has "  - [2026-01-01 10:00:00] [B] 收到" "回复缩进在原留言下"
expect 2 "拒绝写入口令" co log --session A --kind 坑 "登录 password=hunter2222"
expect 2 "没有会话名时拒绝" co log --kind 结果 "x"
printf '0, GPU-a, NVIDIA L20, 100, 49140\n1, GPU-b, NVIDIA L20, 30000, 49140\n2, GPU-c, NVIDIA RTX 6000 Ada, 0, 49140\n5, GPU-d, NVIDIA GeForce RTX 3090, 5000, 24576\n' > "$tmp/gpus"
printf 'GPU-b, 4242, 29000\nGPU-d, 4343, 5000\n' > "$tmp/apps"
expect 0 "free 给出每张卡的结论" env COLLAB_SMI_GPUS_FILE="$tmp/gpus" COLLAB_SMI_APPS_FILE="$tmp/apps" COLLAB_NOW="2026-01-01 12:30:00" python3 "$shared/collab.py" free --host l40 --need-mem 8
has "| 2 | NVIDIA RTX 6000 Ada | 0/49140 | 无 | 无 | 可认领 |" "无人认领且无进程：可认领"
has "有人在用但没登记；剩余 19 GB 够，可共卡" "未登记的进程：按剩余显存判断"
has "| B（到 2026-01-01 11:00，更新 2026-01-01 10:00:00） | 不用（已认领） |" "已认领的卡不用"
has "| 0 | NVIDIA L20 | 100/49140 | 无 | 无 | 可认领 |" "已释放的卡重新可认领"
for i in $(seq 1 24); do co log --session "P$i" --kind 结果 "并发写入 $i" >/dev/null 2>&1 & done
wait
n=$(grep -c "并发写入" "$shared/COLLAB.md")
[ "$n" = 24 ] && ok "24 个并发写入全部落盘" || { out="只有 $n 条"; no "并发写入丢失"; }
NOW="2026-02-01 10:00:00"
expect 0 "归档旧条目" co archive --force
has "已归档" "有内容被归档"
grep -q "并发写入" "$shared"/COLLAB-archive-202602.md && ok "旧条目进了归档文件" || no "归档文件缺内容"
grep -q "更早的记录见同目录 COLLAB-archive-202602.md" "$shared/COLLAB.md" && ok "原处留了指针" || no "原处没有指针"
expect 0 "归档后文档仍可写" co log --session A --kind 教训 "归档后追加"

echo "== 两台机器各跑一批，经汇合点合并后 rk check 通过"
hub="$tmp/hub.git"
git init -q --bare "$hub"
seed="$tmp/seed"
mkdir -p "$seed" && git -C "$seed" init -q -b main
bash "$root/scripts/scaffold.sh" "$seed" >/dev/null
git -C "$seed" -c user.email=t@example.invalid -c user.name=t add -A
git -C "$seed" -c user.email=t@example.invalid -c user.name=t commit -qm init
git -C "$seed" push -q "$hub" main
for m in ma mb; do
  git clone -q "$hub" "$tmp/$m" 2>/dev/null
  git -C "$tmp/$m" config user.email "$m@example.invalid"; git -C "$tmp/$m" config user.name "$m"; git -C "$tmp/$m" config pull.rebase false
done
ra() { (cd "$tmp/ma" && env -u CLAUDE_CODE_SESSION_ID RK_MACHINE_NAME=mac RK_MACHINE_ID=box-a python3 research/tools/rk.py "$@"); }
rb() { (cd "$tmp/mb" && env -u CLAUDE_CODE_SESSION_ID RK_MACHINE_NAME=srva RK_MACHINE_ID=box-b python3 research/tools/rk.py "$@"); }
ida=$(ra id base); idb=$(rb id base)
[ "${ida%%-mac-r01-base}" != "$ida" ] && [ "${idb%%-srva-r01-base}" != "$idb" ] && ok "两台机器各自从 r01 编号，ID 不同" || { out="$ida / $idb"; no "两台机器的 ID"; }
ra run "$ida" --explore -- sh -c 'printf "{\"acc\": 0.61}" > "$RESEARCH_RUN_DIR/metrics.json"' >/dev/null
printf '# 预登记：pb\n判定：acc > 0.6 记为通过。\n' > "$tmp/mb/research/prereg/pb.md"
git -C "$tmp/mb" add -A && git -C "$tmp/mb" commit -qm "prereg pb"
rb run "$idb" --prereg research/prereg/pb.md -- sh -c 'printf "{\"acc\": 0.72}" > "$RESEARCH_RUN_DIR/metrics.json"' >/dev/null
ra wait "$ida" --interval 1 --poll 0.2 >/dev/null; rb wait "$idb" --interval 1 --poll 0.2 >/dev/null
for m in a b; do
  d="$tmp/m$m/research"; id=$([ $m = a ] && echo "$ida" || echo "$idb")
  echo "- 2026-01-01 机器 $m：跑完 $id" >> "$d/LOG.md"
  echo "| L$m | 未决 | 机器 $m 的发现 | run:$id | 探索 | 2026-01-01 |" >> "$d/LEDGER.md"
  echo "- 机器 $m 的教训" >> "$d/LESSONS.md"
  "r$m" status --write >/dev/null
  git -C "$tmp/m$m" add -A && git -C "$tmp/m$m" commit -qm "batch on $m"
done
printf '# %s\n' "$idb" > "$tmp/mb/research/results/$idb.md"
rb audit record --runs "$idb" --verdict 可采信 >/dev/null
git -C "$tmp/mb" add -A && git -C "$tmp/mb" commit -qm "result + audit on b"
git -C "$tmp/ma" push -q origin HEAD 2>/dev/null
expect 0 "第二台机器合并时没有冲突" git -C "$tmp/mb" pull -q --no-edit origin main
grep -q "| La |" "$tmp/mb/research/LEDGER.md" && grep -q "| Lb |" "$tmp/mb/research/LEDGER.md" && ok "账本两边的行都在" || no "账本丢行"
grep -q "机器 a" "$tmp/mb/research/LOG.md" && grep -q "机器 b" "$tmp/mb/research/LOG.md" && ok "日志两边都在" || no "日志丢行"
grep -q "$ida" "$tmp/mb/research/RUNS.md" && grep -q "$idb" "$tmp/mb/research/RUNS.md" && ok "RUNS.md 合并后两行都在" || no "RUNS.md 丢行"
expect 0 "合并后 rk check 通过（含另一台机器的预登记运行和审计）" rb check
has "2 条运行" "两台机器的运行都在"
hasnt "[警告]" "没有警告"
git -C "$tmp/mb" push -q origin HEAD 2>/dev/null
expect 0 "第一台机器拉回" git -C "$tmp/ma" pull -q --no-edit origin main
expect 0 "第一台机器上也通过" ra check
hasnt "[错误]" "没有错误"
mkdir -p "$tmp/ma/research/runs/20251231-r01-legacy"
printf '{"run_id": "20251231-r01-legacy", "kind": "explore", "host": "old", "started_at": "2025-12-31T10:00:00+08:00"}\n' > "$tmp/ma/research/runs/20251231-r01-legacy/meta.json"
echo 0 > "$tmp/ma/research/runs/20251231-r01-legacy/exit_code"
expect 0 "旧格式的运行记录仍能识别" ra status
has "| 20251231-r01-legacy | 探索 | ok |" "旧记录照常列出"
expect 0 "新运行没进 RUNS.md 时只给警告" ra check
has "RUNS.md 不是最新" "提醒重新生成"
ra status --write >/dev/null
expect 0 "旧格式记录不影响核验" ra check
idc=$( (cd "$tmp/ma" && env -u CLAUDE_CODE_SESSION_ID RK_MACHINE_NAME=srva RK_MACHINE_ID=box-c python3 research/tools/rk.py id dup) )
(cd "$tmp/ma" && env -u CLAUDE_CODE_SESSION_ID RK_MACHINE_NAME=srva RK_MACHINE_ID=box-c python3 research/tools/rk.py run "$idc" --explore --manual >/dev/null)
expect 0 "两台机器用了同一代号时警告" ra check
has "被 2 台不同的机器用过" "指出代号重复"

echo
echo "通过 $pass，失败 $fail"
[ "$fail" = 0 ]
