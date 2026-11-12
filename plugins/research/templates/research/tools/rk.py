#!/usr/bin/env python3
"""rk — research kit：研究循环里应当由机器保证的那部分。

    rk run <运行ID> (--prereg 文件... | --explore) [--manual] [--allow-dirty] -- <入口命令>
    rk wait [运行ID...] [--interval 分钟]      阻塞到全部结束或到状态间隔（后台运行，靠退出通知唤醒）
    rk done <运行ID> [--fail] [--note 说明]    结束一条手工批次（文献、推导等没有进程的工作）
    rk status [--write] [--json]               所有运行的真实状态；--write 重新生成 RUNS.md
    rk check                                   核验记录：数字可追溯、预登记早于启动、结论有证据
    rk loop on|off|status                      研究循环开关（Stop 钩子据此判断）
    rk block <要用户决定的事> | rk unblock      登记/解除“在等用户”

只用标准库。本文件随研究目录入库，本机与远程主机用同一份：
    python3 research/tools/rk.py <命令> ...
研究目录默认是本文件的上上级目录，可用环境变量 RESEARCH_HOME 覆盖。
"""
import argparse
import datetime
import getpass
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

HOME = Path(os.environ.get("RESEARCH_HOME") or Path(__file__).resolve().parent.parent).resolve()
RUNS = HOME / "runs"
LOOP = HOME / ".loop"
RUN_ID_RE = re.compile(r"^\d{8}-r\d{2,}-[\w.-]+$")
EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_TICK = 0, 1, 2, 3


def die(msg, code=EXIT_USAGE):
    print(f"rk: {msg}", file=sys.stderr)
    sys.exit(code)


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def git(args, cwd):
    try:
        p = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)
    except OSError:
        return 127, ""
    return p.returncode, p.stdout.strip()


def repo_root(path):
    rc, out = git(["rev-parse", "--show-toplevel"], path)
    return Path(out) if rc == 0 and out else None


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def load_meta(rid):
    try:
        return json.loads((RUNS / rid / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_json(path, obj):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False
    return True


def state_of(rid):
    """返回 (状态, 退出码)。状态：ok / failed / running / open / remote / lost。
    lost = 进程不在且没有退出码：按失败处理，不能当成功。"""
    d = RUNS / rid
    ec = d / "exit_code"
    if ec.exists():
        try:
            code = int(ec.read_text().strip())
        except ValueError:
            return "lost", None
        return ("ok" if code == 0 else "failed"), code
    meta = load_meta(rid)
    if not meta:
        return "lost", None
    if meta.get("manual"):
        return "open", None
    if meta.get("host") != socket.gethostname():
        return "remote", None
    for name in ("sup.pid", "pid"):
        f = d / name
        if f.exists():
            try:
                if pid_alive(int(f.read_text().strip())):
                    return "running", None
            except ValueError:
                pass
    return "lost", None


def run_ids():
    if not RUNS.is_dir():
        return []
    return sorted(p.name for p in RUNS.iterdir() if (p / "meta.json").exists())


# ---------------------------------------------------------------- run


def cmd_run(a):
    rid = a.run_id
    if not RUN_ID_RE.match(rid):
        die("运行 ID 形如 YYYYMMDD-rNN-简称，例如 20261112-r01-baseline")
    d = RUNS / rid
    if d.exists():
        die(f"运行 ID {rid} 已存在。失败的批次保留记录、不覆盖；用新 ID 重跑，规则不变。")
    if bool(a.prereg) == bool(a.explore):
        die("每次运行二选一：--prereg <文件>（判定规则已提交，结果可作确认/筛选）"
            "或 --explore（冒烟、试点、描述性；结果只能标“探索”）")
    cmd = a.cmd or []
    if not a.manual and not cmd:
        die("缺少命令：rk run <ID> ... -- <入口命令>（没有进程的工作用 --manual）")
    cwd = Path(a.cwd or os.getcwd()).resolve()
    root = repo_root(cwd)
    meta = {
        "run_id": rid,
        "kind": "prereg" if a.prereg else "explore",
        "manual": bool(a.manual),
        "cmd": cmd,
        "cwd": str(cwd),
        "host": socket.gethostname(),
        "user": getpass.getuser(),
        "started_at": now(),
        "git_commit": None,
        "git_dirty": None,
        "prereg": [],
        "deviations": [],
        "note": a.note or "",
    }
    if root:
        rc, head = git(["rev-parse", "HEAD"], root)
        meta["git_commit"] = head if rc == 0 else None
        _, st = git(["status", "--porcelain", "--untracked-files=no"], root)
        meta["git_dirty"] = bool(st)
    for p in a.prereg or []:
        fp = Path(p) if os.path.isabs(p) else cwd / p
        fp = fp.resolve()
        if not fp.is_file():
            die(f"预登记文件不存在：{p}")
        entry = {"path": str(fp.relative_to(root)) if root and root in fp.parents else str(fp),
                 "sha256": sha256_bytes(fp.read_bytes())}
        committed = False
        if root:
            rc, _ = git(["ls-files", "--error-unmatch", str(fp)], root)
            _, st = git(["status", "--porcelain", "--", str(fp)], root)
            committed = rc == 0 and not st
        if committed:
            _, entry["commit"] = git(["log", "-1", "--format=%H", "--", str(fp)], root)
        elif a.allow_dirty:
            entry["uncommitted"] = True
        else:
            die(f"预登记文件 {p} 还没提交。判定规则必须在看到任何分数之前提交：先提交，再启动。")
        meta["prereg"].append(entry)
    if meta["kind"] == "prereg" and root and meta["git_dirty"] and not a.allow_dirty:
        die("工作区有未提交的改动。配置与代码先提交，结果才能对上提交号；"
            "确需如此用 --allow-dirty（会记入运行记录，rk check 会报出来）。")
    d.mkdir(parents=True)
    write_json(d / "meta.json", meta)
    if a.manual:
        print(f"已登记手工批次 {rid}（{meta['kind']}）。完成后：rk done {rid} [--fail]")
        return
    sup = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "_supervise", rid],
        cwd=str(cwd), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, env=dict(os.environ, RESEARCH_HOME=str(HOME)))
    (d / "sup.pid").write_text(str(sup.pid))
    print(f"已启动 {rid}（{meta['kind']}） 监督进程 {sup.pid} 日志 {d / 'log.txt'}\n"
          f"等待：rk wait {rid} --interval <状态间隔分钟>（放后台，结束或到点会唤醒你；不要轮询日志）")


def cmd_supervise(a):
    d = RUNS / a.run_id
    meta = load_meta(a.run_id)

    def finish(code):
        meta["ended_at"] = now()
        meta["exit_code"] = code
        write_json(d / "meta.json", meta)
        tmp = d / "exit_code.tmp"
        tmp.write_text(f"{code}\n")
        os.replace(tmp, d / "exit_code")

    env = dict(os.environ, RESEARCH_RUN_ID=a.run_id, RESEARCH_RUN_DIR=str(d), RESEARCH_HOME=str(HOME))
    with open(d / "log.txt", "ab", buffering=0) as log:
        try:
            p = subprocess.Popen(meta["cmd"], cwd=meta["cwd"], stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, env=env)
        except OSError as e:
            log.write(f"rk: 启动失败：{e}\n".encode())
            finish(127)
            return
        (d / "pid").write_text(str(p.pid))

        def forward(sig, _frame):
            try:
                p.send_signal(sig)
            except OSError:
                pass

        signal.signal(signal.SIGTERM, forward)
        signal.signal(signal.SIGINT, forward)
        code = p.wait()
    finish(code)


def cmd_done(a):
    d = RUNS / a.run_id
    meta = load_meta(a.run_id)
    if not meta:
        die(f"没有这条运行：{a.run_id}")
    state, _ = state_of(a.run_id)
    if state in ("ok", "failed"):
        die(f"{a.run_id} 已经结束（{state}）；记录不改写。")
    if state == "running":
        die(f"{a.run_id} 的进程还在跑；等它结束，不要手工标记。")
    code = 1 if (a.fail or state == "lost") else 0
    if state == "lost" and not a.fail:
        die(f"{a.run_id} 的进程已不在且没有退出码，只能记为失败：rk done {a.run_id} --fail --note <原因>")
    meta["ended_at"] = now()
    meta["exit_code"] = code
    if a.note:
        meta["note"] = (meta.get("note", "") + " " + a.note).strip()
    write_json(d / "meta.json", meta)
    (d / "exit_code").write_text(f"{code}\n")
    print(f"{a.run_id} 记为 {'失败' if code else '完成'}")


# ---------------------------------------------------------------- wait / status


def last_log_line(rid, width=160):
    f = RUNS / rid / "log.txt"
    try:
        with open(f, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 4096))
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return ""
    lines = [ln.strip() for ln in re.split(r"[\r\n]+", tail) if ln.strip()]
    return lines[-1][:width] if lines else ""


def elapsed(meta):
    try:
        t0 = datetime.datetime.fromisoformat(meta["started_at"])
        t1 = datetime.datetime.fromisoformat(meta["ended_at"]) if meta.get("ended_at") \
            else datetime.datetime.now().astimezone()
        secs = int((t1 - t0).total_seconds())
    except (KeyError, ValueError):
        return "?"
    return f"{secs // 3600}h{secs % 3600 // 60:02d}m" if secs >= 3600 else f"{secs // 60}m{secs % 60:02d}s"


def cmd_wait(a):
    for rid in a.run_ids:
        if not (RUNS / rid / "meta.json").exists():
            die(f"没有这条运行：{rid}")
        if state_of(rid)[0] == "remote":
            die(f"{rid} 跑在 {load_meta(rid).get('host')} 上：在那台主机上执行 rk wait（例如经 ssh）。")
    deadline = time.time() + a.interval * 60
    while True:
        states = {rid: state_of(rid) for rid in a.run_ids}
        pending = [r for r, (s, _) in states.items() if s in ("running", "open")]
        if a.run_ids and not pending:
            break
        if time.time() >= deadline:
            break
        time.sleep(min(a.poll, max(0.1, deadline - time.time())))
    bad = False
    for rid, (s, code) in states.items():
        bad = bad or s in ("failed", "lost")
        print(f"{rid} | {s} | 退出码 {'-' if code is None else code} | {elapsed(load_meta(rid))} | {last_log_line(rid)}")
    if a.run_ids and not pending:
        print("全部结束。先看退出码，再读结果；失败或缺失不能当成功。" if not bad
              else "有运行失败或丢失：保留记录，查明原因写进日志与教训，用新 ID 重跑，规则不变。")
        sys.exit(EXIT_FAILED if bad else EXIT_OK)
    print(f"到状态间隔（{a.interval:g} 分钟）" + (f"，仍在运行：{', '.join(pending)}" if pending else "") +
          "。这一拍只做三件事：一句状态、更新心跳、重新等待。")
    sys.exit(EXIT_TICK)


def cmd_status(a):
    rows = []
    for rid in run_ids():
        m = load_meta(rid)
        s, code = state_of(rid)
        pre = ",".join(f"{p['path']}@{p.get('commit', '未提交')[:8]}" for p in m.get("prereg", [])) or "-"
        rows.append({"run_id": rid, "kind": m.get("kind", "?"), "state": s, "exit_code": code,
                     "host": m.get("host", "?"), "started_at": m.get("started_at", "?"),
                     "ended_at": m.get("ended_at", ""), "elapsed": elapsed(m),
                     "git_commit": (m.get("git_commit") or "")[:8], "git_dirty": m.get("git_dirty"),
                     "prereg": pre, "note": m.get("note", "")})
    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    head = "| 运行 ID | 性质 | 状态 | 退出码 | 主机 | 开始 | 用时 | 提交 | 预登记 | 备注 |\n|---|---|---|---|---|---|---|---|---|---|"
    body = "\n".join(
        f"| {r['run_id']} | {'确认/筛选' if r['kind'] == 'prereg' else '探索'} | {r['state']} | "
        f"{'-' if r['exit_code'] is None else r['exit_code']} | {r['host']} | {r['started_at']} | {r['elapsed']} | "
        f"{r['git_commit'] or '-'}{'（脏）' if r['git_dirty'] else ''} | {r['prereg']} | {r['note']} |" for r in rows)
    table = head + ("\n" + body if body else "")
    if a.write:
        (HOME / "RUNS.md").write_text(
            "# 运行表\n\n由 `rk status --write` 从 runs/*/meta.json 生成，不要手改。"
            "状态 lost = 进程不在且无退出码，按失败处理。\n\n" + table + "\n", encoding="utf-8")
        print(f"已写入 {HOME / 'RUNS.md'}（{len(rows)} 条）")
    else:
        print(table)


# ---------------------------------------------------------------- check


def parse_tables(text):
    tables, cur = [], None
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("|") and s.endswith("|") and len(s) > 1:
            cells = [c.strip() for c in s[1:-1].split("|")]
            if cur is None:
                cur = {"header": cells, "rows": [], "sep": False}
                tables.append(cur)
            elif not cur["sep"] and not cur["rows"] and all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                cur["sep"] = True
            else:
                cur["rows"].append(cells)
        else:
            cur = None
    return tables


def col(header, *names):
    for i, h in enumerate(header):
        if any(n in h for n in names):
            return i
    return None


def lookup(obj, dotted):
    for part in dotted.split("."):
        if isinstance(obj, dict) and part in obj:
            obj = obj[part]
        elif isinstance(obj, list) and part.isdigit() and int(part) < len(obj):
            obj = obj[int(part)]
        else:
            return None
    return obj


def numbers_match(shown, actual):
    s = shown.replace(",", "").replace("−", "-").strip()
    pct = s.endswith("%")
    m = re.search(r"-?\d+(?:\.\d+)?(?:[eE]-?\d+)?", s)
    if not m or not isinstance(actual, (int, float)) or isinstance(actual, bool):
        return False
    lit = m.group(0)
    val = float(lit)
    mant = re.split(r"[eE]", lit)[0]
    decimals = len(mant.split(".")[1]) if "." in mant else 0
    scale = float("1" + lit[len(mant):]) if len(lit) > len(mant) else 1.0
    tol = 0.5 * 10 ** (-decimals) * scale * (1 + 1e-9) + 1e-12
    candidates = [actual, actual * 100] if pct else [actual]
    return any(abs(val - c) <= tol for c in candidates)


EXTERNAL = re.compile(r"^(doi:|arxiv:|https?://|isbn:|pmid:)", re.I)


def cmd_check(a):
    errors, warns, notes = [], [], []
    root = repo_root(HOME)
    ids = run_ids()
    states = {rid: state_of(rid) for rid in ids}

    for rid in ids:
        m, (s, _) = load_meta(rid), states[rid]
        if s == "lost":
            errors.append(f"runs/{rid}：进程不在且没有退出码。按失败归档：rk done {rid} --fail --note <原因>")
        if m.get("kind") == "prereg":
            if m.get("git_dirty"):
                warns.append(f"runs/{rid}：启动时工作区有未提交改动，结果对不上单一提交号。")
            t0 = m.get("started_at", "")
            for p in m.get("prereg", []):
                if p.get("uncommitted") or not p.get("commit"):
                    errors.append(f"runs/{rid}：预登记 {p['path']} 启动时未提交，无法证明规则早于分数。")
                    continue
                if not root:
                    warns.append(f"runs/{rid}：不在 git 仓库里，无法核对预登记提交 {p['commit'][:8]}。")
                    continue
                rc, _ = git(["cat-file", "-e", p["commit"] + "^{commit}"], root)
                if rc != 0:
                    errors.append(f"runs/{rid}：预登记提交 {p['commit'][:8]} 不在仓库历史里。")
                    continue
                blob = subprocess.run(["git", "show", f"{p['commit']}:{p['path']}"], cwd=str(root), capture_output=True)
                if blob.returncode != 0 or sha256_bytes(blob.stdout) != p["sha256"]:
                    errors.append(f"runs/{rid}：提交 {p['commit'][:8]} 里的 {p['path']} 与启动时的内容不一致。")
                _, ct = git(["show", "-s", "--format=%cI", p["commit"]], root)
                try:
                    if datetime.datetime.fromisoformat(ct) > datetime.datetime.fromisoformat(t0):
                        errors.append(f"runs/{rid}：预登记提交时间 {ct} 晚于启动时间 {t0}。")
                except ValueError:
                    warns.append(f"runs/{rid}：无法比较预登记提交时间与启动时间。")
                cur = root / p["path"]
                if cur.is_file() and sha256_bytes(cur.read_bytes()) != p["sha256"]:
                    notes.append(f"runs/{rid}：{p['path']} 启动后有改动；判定以提交 {p['commit'][:8]} 的版本为准，"
                                 f"看过结果后的改动只能算“描述”。")
            if s == "ok" and not (HOME / "results" / f"{rid}.md").exists():
                warns.append(f"runs/{rid}：已结束但没有结果页 results/{rid}.md。")
        if m.get("deviations"):
            notes.append(f"runs/{rid}：登记了偏离：{'；'.join(m['deviations'])}")

    ov = HOME / "OVERVIEW.md"
    n_rows = 0
    if ov.exists():
        for t in parse_tables(ov.read_text(encoding="utf-8")):
            c_src, c_val = col(t["header"], "来源"), col(t["header"], "数值")
            if c_src is None:
                continue
            c_kind = col(t["header"], "性质")
            for row in t["rows"]:
                if len(row) <= c_src:
                    continue
                n_rows += 1
                label = row[0] or "(空)"
                src = row[c_src].strip().strip("`")
                if not src:
                    errors.append(f"OVERVIEW「{label}」：没有登记来源。新行必须写来源（运行ID:指标键 或外部出处）。")
                    continue
                if EXTERNAL.match(src):
                    continue
                rid, _, key = src.partition(":")
                if rid not in states:
                    errors.append(f"OVERVIEW「{label}」：来源里的运行 {rid} 不存在。")
                    continue
                if states[rid][0] != "ok":
                    errors.append(f"OVERVIEW「{label}」：来源运行 {rid} 的状态是 {states[rid][0]}，不能进总览表。")
                    continue
                if load_meta(rid).get("kind") == "explore" and (c_kind is None or "探索" not in row[c_kind]):
                    errors.append(f"OVERVIEW「{label}」：{rid} 是探索性运行，“性质”一栏必须标“探索”。")
                if c_val is None or not key:
                    errors.append(f"OVERVIEW「{label}」：来源要写成 运行ID:指标键，并有“数值”一栏。")
                    continue
                try:
                    metrics = json.loads((RUNS / rid / "metrics.json").read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    errors.append(f"OVERVIEW「{label}」：runs/{rid}/metrics.json 缺失或不是合法 JSON。")
                    continue
                actual = lookup(metrics, key)
                if actual is None:
                    errors.append(f"OVERVIEW「{label}」：runs/{rid}/metrics.json 里没有键 {key}。")
                elif not numbers_match(row[c_val], actual):
                    errors.append(f"OVERVIEW「{label}」：表里写 {row[c_val]}，运行记录是 {actual}（{rid}:{key}）。")

    led = HOME / "LEDGER.md"
    n_claims = 0
    if led.exists():
        for t in parse_tables(led.read_text(encoding="utf-8")):
            c_st, c_ev = col(t["header"], "状态"), col(t["header"], "证据")
            if c_st is None or c_ev is None:
                continue
            for row in t["rows"]:
                if len(row) <= max(c_st, c_ev):
                    continue
                n_claims += 1
                label, status, ev = row[0], row[c_st], row[c_ev]
                tokens = [x.strip().strip("`") for x in re.split(r"[;；,，\s]+", ev) if x.strip().strip("`")]
                if ("已证实" in status or "已否定" in status) and not tokens:
                    errors.append(f"LEDGER {label}：状态是“{status}”却没有证据。")
                for tok in tokens:
                    if tok.startswith("run:"):
                        rid = tok[4:]
                        if rid not in states:
                            errors.append(f"LEDGER {label}：证据里的运行 {rid} 不存在。")
                        elif states[rid][0] != "ok" and "已证实" in status:
                            errors.append(f"LEDGER {label}：证据运行 {rid} 的状态是 {states[rid][0]}，不能支撑“已证实”。")
                    elif "/" in tok and not EXTERNAL.match(tok):
                        if not ((HOME / tok).exists() or (root and (root / tok).exists())):
                            errors.append(f"LEDGER {label}：证据文件 {tok} 不存在。")

    for kind, items in (("错误", errors), ("警告", warns), ("说明", notes)):
        for it in items:
            print(f"[{kind}] {it}")
    print(f"rk check：{len(ids)} 条运行，{n_rows} 行总览，{n_claims} 条结论；"
          f"{len(errors)} 个错误，{len(warns)} 个警告。")
    sys.exit(EXIT_FAILED if errors else EXIT_OK)


# ---------------------------------------------------------------- loop


def cmd_loop(a):
    active = LOOP / "active"
    if a.action == "on":
        LOOP.mkdir(parents=True, exist_ok=True)
        sid = a.session or os.environ.get("CLAUDE_CODE_SESSION_ID", "")
        active.write_text(f"started: {now()}\nsession: {sid}\n", encoding="utf-8")
        (LOOP / "blocked").unlink(missing_ok=True)
        print("研究循环：开。" + ("" if sid else "（会话将在第一次停下时绑定）"))
    elif a.action == "off":
        active.unlink(missing_ok=True)
        print("研究循环：关。")
    else:
        if active.exists():
            blocked = LOOP / "blocked"
            print("研究循环：开\n" + active.read_text(encoding="utf-8").strip() +
                  (f"\n在等用户：{blocked.read_text(encoding='utf-8').strip()}" if blocked.exists() else ""))
        else:
            print("研究循环：关")


def cmd_block(a):
    LOOP.mkdir(parents=True, exist_ok=True)
    (LOOP / "blocked").write_text(f"{now()} {a.what}\n", encoding="utf-8")
    print("已登记：在等用户决定。同一件事也要写进 SUMMARY.md 的“需要你决定的事”，并在回复里问清楚。")


def cmd_unblock(_a):
    (LOOP / "blocked").unlink(missing_ok=True)
    print("已解除“在等用户”。")


def main():
    ap = argparse.ArgumentParser(prog="rk", description="research kit")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("run", help="登记并启动一次运行（后台、带退出码与日志）")
    p.add_argument("run_id")
    p.add_argument("--prereg", action="append", metavar="文件", help="已提交的预登记/分析脚本，可多次")
    p.add_argument("--explore", action="store_true", help="探索性运行：冒烟、试点、描述")
    p.add_argument("--manual", action="store_true", help="没有进程的批次（文献、推导、人工步骤）")
    p.add_argument("--allow-dirty", action="store_true")
    p.add_argument("--cwd")
    p.add_argument("--note")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("_supervise")
    p.add_argument("run_id")
    p.set_defaults(fn=cmd_supervise)

    p = sub.add_parser("done", help="结束一条手工批次，或把丢失的运行归档为失败")
    p.add_argument("run_id")
    p.add_argument("--fail", action="store_true")
    p.add_argument("--note")
    p.set_defaults(fn=cmd_done)

    p = sub.add_parser("wait", help="阻塞到运行结束或到状态间隔；退出码 0 全部成功 / 1 有失败 / 3 到点")
    p.add_argument("run_ids", nargs="*")
    p.add_argument("--interval", type=float, default=30, help="状态间隔（分钟），默认 30")
    p.add_argument("--poll", type=float, default=10, help=argparse.SUPPRESS)
    p.set_defaults(fn=cmd_wait)

    p = sub.add_parser("status", help="所有运行的真实状态")
    p.add_argument("--write", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("check", help="核验记录")
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser("loop", help="研究循环开关")
    p.add_argument("action", choices=["on", "off", "status"])
    p.add_argument("--session")
    p.set_defaults(fn=cmd_loop)

    p = sub.add_parser("block", help="登记“在等用户决定”")
    p.add_argument("what")
    p.set_defaults(fn=cmd_block)

    p = sub.add_parser("unblock")
    p.set_defaults(fn=cmd_unblock)

    argv, tail = sys.argv[1:], []
    if "--" in argv:  # “--” 之后原样作为入口命令
        i = argv.index("--")
        argv, tail = argv[:i], argv[i + 1:]
    a = ap.parse_args(argv)
    a.cmd = tail
    a.fn(a)


if __name__ == "__main__":
    main()
