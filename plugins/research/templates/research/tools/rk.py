#!/usr/bin/env python3
"""rk — research kit：研究循环里应当由机器保证的那部分。

    rk id [简称]                               本机代号；给出简称时生成下一个运行 ID（日期-代号-rNN-简称）
    rk run <运行ID> (--prereg 文件... | --explore) [--manual] [--allow-dirty] -- <入口命令>
    rk wait [运行ID...] [--interval 分钟]      阻塞到全部结束或到状态间隔（后台运行，靠退出通知唤醒）
    rk done <运行ID> [--fail] [--note 说明]    结束一条手工批次（文献、推导等没有进程的工作）
    rk pull <别名>:<远程研究目录> <运行ID...>  把远程主机上已结束的运行记录（含日志）拉回本机
    rk status [--write] [--json]               所有运行的真实状态；--write 重新生成 RUNS.md
    rk audit record --runs <ID,...> --verdict <总评> [--report 文件]   登记一次独立审计（结构化，rk check 据此判断）
    rk audit show [运行ID...]                  每条运行当前有效的审计总评
    rk check                                   核验记录：数字可追溯、预登记在先、结论有证据与审计、账本只追加
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
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOME = Path(os.environ.get("RESEARCH_HOME") or Path(__file__).resolve().parent.parent).resolve()
RUNS = HOME / "runs"
LOOP = HOME / ".loop"
# 运行 ID：日期-机器代号-rNN-简称。代号让两台机器各自编号也不会撞号，合并时不冲突。
# 不带代号的旧格式（日期-rNN-简称）只用于识别已有记录，新运行必须带代号。
NEW_ID_RE = re.compile(r"^(?P<date>\d{8})-(?P<machine>(?!r\d+-)[a-z][a-z0-9]{1,11})-r(?P<n>\d{2,})-(?P<name>[\w.-]+)$")
OLD_ID_RE = re.compile(r"^\d{8}-r\d{2,}-[\w.-]+$")
MACHINE_NAME_RE = re.compile(r"^(?!r\d+$)[a-z][a-z0-9]{1,11}$")
NAME_RE = re.compile(r"^[\w.-]+$")
VERDICTS = ("可采信", "需退回", "不可采信")
SEVERITY = {v: i for i, v in enumerate(VERDICTS)}


def valid_run_id(rid):
    return bool(NEW_ID_RE.match(rid) or OLD_ID_RE.match(rid))
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


_MACHINE = None


def machine_id():
    """本机的稳定标识（取哈希，不把硬件序号写进记录）。主机名会随网络变化，不能用来判断“是不是本机”。
    取不到时退回主机名。环境变量 RK_MACHINE_ID 可覆盖（测试用）。"""
    global _MACHINE
    if _MACHINE is None:
        raw = os.environ.get("RK_MACHINE_ID", "")
        for f in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            if raw:
                break
            try:
                raw = Path(f).read_text().strip()
            except OSError:
                pass
        if not raw and sys.platform == "darwin":
            try:
                out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                                     capture_output=True, text=True, timeout=5).stdout
                m = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', out)
                raw = m.group(1) if m else ""
            except (OSError, subprocess.SubprocessError):
                raw = ""
        _MACHINE = sha256_bytes(raw.encode())[:16] if raw else "host:" + socket.gethostname()
    return _MACHINE


_NAME = None


def machine_name():
    """运行 ID 里的机器代号 → (代号, 来源)。环境变量 RK_MACHINE_NAME 优先（Bunsen 会注入自己的服务器 ID）；
    否则从主机名取：首段按词切开，第一个词加其余词的首字母（数字整段保留），如 gpu-node-03 → gpun03、
    AliceMacBook-Pro → alicembp。macOS 用 LocalHostName，因为 gethostname 常常是 IP。
    主机名是 IP、localhost 或取不出两位以上时，用本机标识的哈希（m + 6 位）。"""
    global _NAME
    if _NAME:
        return _NAME
    raw = os.environ.get("RK_MACHINE_NAME", "").strip()
    if raw:
        if not MACHINE_NAME_RE.match(raw):
            die(f"RK_MACHINE_NAME={raw} 不合规：2 到 12 位小写字母或数字，字母开头，不能是 r 加数字。")
        _NAME = (raw, "环境变量 RK_MACHINE_NAME")
        return _NAME
    host = ""
    if sys.platform == "darwin":
        try:
            host = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True,
                                  text=True, timeout=5).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            host = ""
    host = host or socket.gethostname()
    label = "" if re.fullmatch(r"[\d.:]+", host) or host.lower().startswith("localhost") else host.split(".")[0]
    words = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+", label)
    code = (words[0] + "".join(w if w.isdigit() else w[0] for w in words[1:])).lower() if words else ""
    if code and not code[0].isalpha():
        code = "m" + code
    code = code[:12]
    if MACHINE_NAME_RE.match(code):
        _NAME = (code, f"主机名 {host}")
    else:
        _NAME = ("m" + sha256_bytes(machine_id().encode())[:6], "本机标识的哈希（主机名不可用）")
        if not MACHINE_NAME_RE.match(_NAME[0]):
            _NAME = ("m" + sha256_bytes(_NAME[0].encode())[:6], _NAME[1])
    return _NAME


def next_run_id(name):
    code, _ = machine_name()
    day = datetime.date.today().strftime("%Y%m%d")
    n = 0
    if RUNS.is_dir():
        for d in RUNS.iterdir():
            m = NEW_ID_RE.match(d.name)
            if m and m["date"] == day and m["machine"] == code:
                n = max(n, int(m["n"]))
    return f"{day}-{code}-r{n + 1:02d}-{name}"


def on_this_machine(meta):
    if meta.get("machine"):
        return meta["machine"] == machine_id()
    return meta.get("host") == socket.gethostname()  # 旧记录没有 machine 字段


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
    if not on_this_machine(meta):
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


def cmd_id(a):
    code, src = machine_name()
    if not a.name:
        print(f"本机代号：{code}（来自{src}）。要换就设环境变量 RK_MACHINE_NAME。")
        return
    if not NAME_RE.match(a.name):
        die("简称只用字母、数字、下划线、点和连字符")
    print(next_run_id(a.name))


def cmd_run(a):
    rid = a.run_id
    code, src = machine_name()
    pid_ = NEW_ID_RE.match(rid)
    if not pid_:
        if OLD_ID_RE.match(rid):
            die(f"运行 ID 现在要带本机代号：YYYYMMDD-{code}-rNN-简称（不同机器各自编号也不会撞）。"
                f"用 rk id <简称> 生成下一个，例如 {next_run_id(rid.split('-', 2)[2])}")
        die(f"运行 ID 形如 YYYYMMDD-<本机代号>-rNN-简称；本机代号是 {code}（来自{src}）。用 rk id <简称> 生成下一个。")
    if pid_["machine"] != code:
        die(f"运行 ID 里的机器代号是 {pid_['machine']}，本机是 {code}（来自{src}）。"
            f"每台机器只用自己的代号编号：rk id {pid_['name']}")
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
        "machine": machine_id(),
        "machine_name": code,
        "user": getpass.getuser(),
        "started_at": now(),
        "git_commit": None,
        "git_dirty": None,
        "prereg": [],
        "deviations": [],
        "note": a.note or "",
        "line": a.line or os.environ.get("RESEARCH_LINE") or None,
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


# ---------------------------------------------------------------- pull

PULL_SKIP = ("pid", "sup.pid")


def cmd_pull(a):
    """把远程主机上已结束的运行记录拉回本机。只补缺失的文件，从不覆盖本机已有的记录。"""
    m = re.match(r"^([^/:]+):(.+)$", a.source)
    bad = False
    RUNS.mkdir(parents=True, exist_ok=True)
    for rid in a.run_ids:
        if not valid_run_id(rid):
            print(f"{rid}：不是合法的运行 ID", file=sys.stderr)
            bad = True
            continue
        tmp = Path(tempfile.mkdtemp(prefix=".pull-", dir=str(RUNS)))
        try:
            got = tmp / rid
            if m:
                host, path = m.groups()
                p = subprocess.run(["scp", "-q", "-r", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                                    f"{host}:{path.rstrip('/')}/runs/{rid}", str(tmp)],
                                   capture_output=True, text=True)
                if p.returncode != 0 or not got.is_dir():
                    print(f"{rid}：从 {host} 复制失败：{(p.stderr or '').strip()[:300]}", file=sys.stderr)
                    bad = True
                    continue
            else:
                src = Path(a.source).expanduser() / "runs" / rid
                if not src.is_dir():
                    print(f"{rid}：{src} 不存在", file=sys.stderr)
                    bad = True
                    continue
                shutil.copytree(src, got)
            try:
                rmeta = json.loads((got / "meta.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                print(f"{rid}：远程记录没有可读的 meta.json", file=sys.stderr)
                bad = True
                continue
            if rmeta.get("run_id") != rid:
                print(f"{rid}：远程 meta.json 里的运行 ID 是 {rmeta.get('run_id')}，对不上", file=sys.stderr)
                bad = True
                continue
            if not (got / "exit_code").exists():
                print(f"{rid}：在 {rmeta.get('host', '?')} 上还没结束（没有退出码）。结束后再拉；"
                      f"现在要看日志就 ssh 过去读。", file=sys.stderr)
                bad = True
                continue
            d = RUNS / rid
            if d.exists():
                lmeta = load_meta(rid)
                if lmeta.get("started_at") != rmeta.get("started_at"):
                    print(f"{rid}：本机已有同 ID 的另一条运行（启动时间不同），不合并。", file=sys.stderr)
                    bad = True
                    continue
                lec, rec = d / "exit_code", got / "exit_code"
                if lec.exists() and lec.read_text().strip() != rec.read_text().strip():
                    print(f"{rid}：本机与远程的退出码不一致，不合并，请人工核查。", file=sys.stderr)
                    bad = True
                    continue
            d.mkdir(exist_ok=True)
            added = []
            for f in sorted(got.rglob("*")):
                rel = f.relative_to(got)
                if f.is_dir() or rel.name in PULL_SKIP or rel.name.endswith(".tmp"):
                    continue
                dst = d / rel
                if dst.exists():
                    continue
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dst)
                added.append(str(rel))
            if not (d / "pulled.json").exists():
                write_json(d / "pulled.json", {"from": a.source, "pulled_at": now(), "files": added})
            state, code = state_of(rid)
            print(f"{rid}：{state}（退出码 {code}），补齐 {len(added)} 个文件"
                  + (f"：{', '.join(added[:8])}" if added else "（本机已齐）"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(EXIT_FAILED if bad else EXIT_OK)


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
    for line in held_lines():  # 顺手续租：剩不到一半租期时向协调主机续一次，失败不影响等待
        c = cache_read(line) or {}
        if c.get("deadline", 0) - time.time() < 6 * 3600:
            out, _ = lease_call("renew", line, holder=machine_name()[0], token=c.get("token"))
            if out and out.get("ok"):
                cache_write(line, out)
            elif out:
                cache_drop(line)
                print(f"注意：研究线 {line} 的推进权已不在本机（{out.get('message')}）。停下对这条线的写入。")
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
    audits = load_audits()[0]
    for rid in run_ids():
        m = load_meta(rid)
        s, code = state_of(rid)
        pre = ",".join(f"{p['path']}@{p.get('commit', '未提交')[:8]}" for p in m.get("prereg", [])) or "-"
        rows.append({"run_id": rid, "kind": m.get("kind", "?"), "state": s, "exit_code": code,
                     "host": m.get("host", "?"), "started_at": m.get("started_at", "?"),
                     "ended_at": m.get("ended_at", ""), "elapsed": elapsed(m),
                     "git_commit": (m.get("git_commit") or "")[:8], "git_dirty": m.get("git_dirty"),
                     "prereg": pre, "audit": audits.get(rid, ("",))[0], "line": m.get("line"),
                     "note": m.get("note", "")})
    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    head = ("| 运行 ID | 性质 | 状态 | 退出码 | 主机 | 开始 | 用时 | 提交 | 预登记 | 审计 | 备注 |\n"
            "|---|---|---|---|---|---|---|---|---|---|---|")
    body = "\n".join(
        f"| {r['run_id']} | {'确认/筛选' if r['kind'] == 'prereg' else '探索'} | {r['state']} | "
        f"{'-' if r['exit_code'] is None else r['exit_code']} | {r['host']} | {r['started_at']} | {r['elapsed']} | "
        f"{r['git_commit'] or '-'}{'（脏）' if r['git_dirty'] else ''} | {r['prereg']} | {r['audit'] or '-'} | {r['note']} |"
        for r in rows)
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
VERDICT_RE = re.compile(r"^\s*[-*]?\s*\**总评\**\s*[:：]\s*\**\s*(不可采信|需退回|可采信)", re.M)
AUDIT_RUNS_RE = re.compile(r"^\s*[-*]?\s*\**运行\**\s*[:：]\s*(.+)$", re.M)


def audit_records():
    """audits/*.json（rk audit record 写的结构化记录）→ (记录列表, 问题列表)。"""
    recs, problems = [], []
    d = HOME / "audits"
    for f in sorted(d.glob("*.json")) if d.is_dir() else []:
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            problems.append(f"audits/{f.name}：不是合法的 JSON。")
            continue
        if (not isinstance(r, dict) or r.get("audit_id") != f.stem or r.get("verdict") not in VERDICTS
                or not isinstance(r.get("runs"), list) or not r["runs"]):
            problems.append(f"audits/{f.name}：缺 audit_id、runs 或 verdict，或与文件名不符（应由 rk audit record 生成）。")
            continue
        rep = r.get("report")
        if rep:
            rp = HOME / rep
            if not rp.is_file():
                problems.append(f"audits/{f.name}：报告 {rep} 不存在。")
            elif r.get("report_sha256") and sha256_bytes(rp.read_bytes()) != r["report_sha256"]:
                problems.append(f"audits/{f.name}：报告 {rep} 登记后被改过。审计报告只读；要更正就重新审计、重新登记。")
        recs.append(r)
    return recs, problems


def current_audits(recs):
    """每条运行当前有效的结构化审计：{运行ID: [记录...]}。
    先后不看时钟，看“取代”关系：rk audit record 登记时，把它看得到的、同一条运行上仍有效的审计记为被取代。
    两台机器各自登记、彼此没看到时，两份并存，由调用方取较严的总评。"""
    gone = {(rid, old) for r in recs for rid, olds in (r.get("supersedes") or {}).items() for old in olds}
    out = {}
    for r in recs:
        for rid in r["runs"]:
            if (rid, r["audit_id"]) not in gone:
                out.setdefault(rid, []).append(r)
    return out


def load_audits():
    """→ ({运行ID: (总评, 出处)}, 问题, 警告)。结构化记录优先；同一条运行有几份并存的有效审计时取最严的总评。
    没有对应结构化记录的 audits/*.md 按旧格式读“运行”“总评”两行（0.2 的做法），以文件名排序后最后一份为准。"""
    recs, problems = audit_records()
    warns, out = [], {}
    for rid, rs in current_audits(recs).items():
        worst = max(rs, key=lambda r: (SEVERITY[r["verdict"]], r["audit_id"]))
        out[rid] = (worst["verdict"], f"audits/{worst['audit_id']}.json")
        if len({r["verdict"] for r in rs}) > 1:
            warns.append(f"运行 {rid} 有 {len(rs)} 份并存的审计（{'、'.join(r['audit_id'] for r in rs)}），"
                         f"总评不一致，按最严的“{worst['verdict']}”算。重审后用 rk audit record 登记一份新的即可取代。")
    referenced = {r.get("report") for r in recs}
    d = HOME / "audits"
    legacy = {}
    for f in sorted(d.glob("*.md")) if d.is_dir() else []:
        if f.name == "TEMPLATE.md" or f"audits/{f.name}" in referenced:
            continue
        text = f.read_text(encoding="utf-8")
        mv, mr = VERDICT_RE.search(text), AUDIT_RUNS_RE.search(text)
        if not mv or not mr:
            problems.append(f"audits/{f.name}：没有登记。用 rk audit record --runs <运行ID> --verdict <总评> "
                            f"--report audits/{f.name} 登记，或删掉这份文件。")
            continue
        for rid in split_ids(mr.group(1)):
            legacy[rid] = (mv.group(1), f"audits/{f.name}")
    for rid, v in legacy.items():
        out.setdefault(rid, v)
    return out, problems, warns


def split_ids(text):
    return [x.strip().strip("`") for x in re.split(r"[;；,，\s]+", text) if x.strip().strip("`")]


def cmd_audit(a):
    if a.action == "show":
        audits, problems, warns = load_audits()
        ids = a.run_ids or sorted(audits)
        for rid in ids:
            v = audits.get(rid)
            print(f"{rid} | {v[0] if v else '未审'} | {v[1] if v else '-'}")
        for it in problems:
            print(f"[错误] {it}")
        for it in warns:
            print(f"[警告] {it}")
        return
    runs = split_ids(a.runs or "")
    if not runs:
        die("缺 --runs：这次审计覆盖的运行 ID，逗号分隔")
    if a.verdict not in VERDICTS:
        die(f"--verdict 只能是 {' / '.join(VERDICTS)}")
    for rid in runs:
        if not valid_run_id(rid):
            die(f"{rid} 不是合法的运行 ID")
        if not (RUNS / rid / "meta.json").exists():
            die(f"runs/{rid} 不在本机。审计看的是原始记录：远程的运行先 rk pull 拉回。")
    code, _ = machine_name()
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    aid, k = f"{stamp}-{code}", 1
    adir = HOME / "audits"
    adir.mkdir(parents=True, exist_ok=True)
    while (adir / f"{aid}.json").exists():
        k += 1
        aid = f"{stamp}-{code}-{k}"
    report = sha = None
    if a.report:
        rp = Path(a.report).expanduser()
        rp = (rp if rp.is_absolute() else Path.cwd() / rp).resolve()
        if not rp.is_file():
            die(f"报告文件不存在：{a.report}")
        text = rp.read_text(encoding="utf-8")
        mv, mr = VERDICT_RE.search(text), AUDIT_RUNS_RE.search(text)
        if mv and mv.group(1) != a.verdict:
            die(f"报告里写的总评是“{mv.group(1)}”，与 --verdict {a.verdict} 不一致。")
        if mr and set(split_ids(mr.group(1))) != set(runs):
            die(f"报告里写的运行是 {', '.join(split_ids(mr.group(1)))}，与 --runs 不一致。")
        if adir.resolve() not in rp.parents:
            dst = adir / f"{aid}.md"
            shutil.copy2(rp, dst)
            rp = dst
        report = str(rp.relative_to(HOME.resolve())) if HOME.resolve() in rp.parents else str(rp)
        sha = sha256_bytes(rp.read_bytes())
    recs, _ = audit_records()
    cur = current_audits(recs)
    supersedes = {rid: [r["audit_id"] for r in cur[rid]] for rid in runs if cur.get(rid)}
    rk_root = repo_root(HOME)
    head = git(["rev-parse", "HEAD"], rk_root)[1] if rk_root else ""
    rec = {"audit_id": aid, "runs": runs, "verdict": a.verdict, "report": report, "report_sha256": sha,
           "by": a.by or "research:auditor", "note": a.note or "", "recorded_at": now(),
           "machine": machine_id(), "machine_name": code, "git_head": head or None, "supersedes": supersedes}
    write_json(adir / f"{aid}.json", rec)
    print(f"已登记审计 {aid}：{', '.join(runs)} → {a.verdict}"
          + (f"；取代 {'、'.join(sorted({x for v in supersedes.values() for x in v}))}" if supersedes else "")
          + (f"；报告 {report}" if report else "；没有附报告"))


def ledger_rows(text):
    rows = set()
    for t in parse_tables(text):
        if col(t["header"], "状态") is None:
            continue
        rows.update(tuple(r) for r in t["rows"] if any(r))
    return rows


def cmd_check(a):
    errors, warns, notes = [], [], []
    root = repo_root(HOME)
    ids = run_ids()
    states = {rid: state_of(rid) for rid in ids}
    audits, problems, audit_warns = load_audits()
    errors.extend(problems)
    warns.extend(audit_warns)
    for rid, (_, f) in audits.items():
        if rid not in states:
            warns.append(f"{f}：审计的运行 {rid} 在 runs/ 里不存在（远程的运行先 rk pull 拉回）。")

    codes = {}
    for rid in ids:
        m = load_meta(rid)
        if m.get("run_id") != rid:
            errors.append(f"runs/{rid}：meta.json 里的运行 ID 是 {m.get('run_id')}，与目录名不符。")
        pm = NEW_ID_RE.match(rid)
        if pm and m.get("machine_name") and m["machine_name"] != pm["machine"]:
            errors.append(f"runs/{rid}：ID 里的机器代号 {pm['machine']} 与记录的 {m['machine_name']} 不符。")
        if pm and m.get("machine"):
            codes.setdefault(pm["machine"], set()).add(m["machine"])
    for code, ms in sorted(codes.items()):
        if len(ms) > 1:
            warns.append(f"机器代号 {code} 被 {len(ms)} 台不同的机器用过，运行 ID 可能撞号。"
                         f"给其中一台设环境变量 RK_MACHINE_NAME（2 到 12 位小写字母或数字）。")

    for rid in ids:
        m, (s, _) = load_meta(rid), states[rid]
        if s == "lost":
            errors.append(f"runs/{rid}：进程不在且没有退出码。按失败归档：rk done {rid} --fail --note <原因>")
        if s == "remote":
            warns.append(f"runs/{rid}：跑在 {m.get('host', '?')} 上，本机还没有退出码。"
                         f"结束后 rk pull <别名>:<远程研究目录> {rid} 拉回记录再核验。")
        if m.get("kind") == "prereg":
            if m.get("git_dirty"):
                warns.append(f"runs/{rid}：启动时工作区有未提交改动，结果对不上单一提交号。")
            t0 = m.get("started_at", "")
            run_commit = m.get("git_commit")
            if root and run_commit and git(["cat-file", "-e", run_commit + "^{commit}"], root)[0] != 0:
                errors.append(f"runs/{rid}：运行所用的提交 {run_commit[:8]} 不在本仓库历史里，无法证明预登记在先。"
                              f"先把那台机器的提交合并进来（它的 sync 分支或研究分支），再核验。")
                run_commit = "missing"
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
                if run_commit == "missing":
                    pass
                elif run_commit:  # 先后看提交因果：预登记提交必须是运行所用提交的祖先（或就是它），与时钟无关
                    rc, _ = git(["merge-base", "--is-ancestor", p["commit"], run_commit], root)
                    if rc == 1:
                        errors.append(f"runs/{rid}：预登记提交 {p['commit'][:8]} 不是运行所用提交 {run_commit[:8]} "
                                      f"的祖先，无法证明判定规则早于分数。")
                    elif rc != 0:
                        warns.append(f"runs/{rid}：无法判断预登记提交与运行提交的先后。")
                else:  # 旧记录没有提交号，只能退回比较时间
                    _, ct = git(["show", "-s", "--format=%cI", p["commit"]], root)
                    try:
                        if datetime.datetime.fromisoformat(ct) > datetime.datetime.fromisoformat(t0):
                            errors.append(f"runs/{rid}：预登记提交时间 {ct} 晚于启动时间 {t0}。")
                        else:
                            notes.append(f"runs/{rid}：没有记录运行所用的提交，预登记先后只按时间核对。")
                    except ValueError:
                        warns.append(f"runs/{rid}：无法比较预登记提交时间与启动时间。")
                cur = root / p["path"]
                if cur.is_file() and sha256_bytes(cur.read_bytes()) != p["sha256"]:
                    notes.append(f"runs/{rid}：{p['path']} 启动后有改动；判定以提交 {p['commit'][:8]} 的版本为准，"
                                 f"看过结果后的改动只能算“描述”。")
            if s == "ok" and not (HOME / "results" / f"{rid}.md").exists():
                warns.append(f"runs/{rid}：已结束但没有结果页 results/{rid}.md。")
            elif s == "ok" and rid not in audits:
                warns.append(f"runs/{rid}：有结果页但还没有审计记录（audits/）。")
        if m.get("deviations"):
            notes.append(f"runs/{rid}：登记了偏离：{'；'.join(m['deviations'])}")

    for f in line_files():
        fm, _ = read_line(f)
        if not fm.get("token") or not fm.get("holder"):
            errors.append(f"state/{f.name}：开头缺推进权信息（holder、token）。用 rk line new / rk line take 生成，不要手写。")
            continue
        if not root:
            continue
        rel = str(f.resolve().relative_to(root.resolve()))
        T, base, holder = fm_token(fm), fm.get("base", "-"), fm.get("holder")
        if base != "-" and git(["cat-file", "-e", base + "^{commit}"], root)[0] != 0:
            warns.append(f"state/{f.name}：接手时的提交 {base[:8]} 不在本仓库历史里，无法核对有没有双写。")
            base = "-"
        rc, out = git(["log", "--format=%H", "--", rel], root)
        stale = []
        for c in (out.split() if rc == 0 else []):
            blob = subprocess.run(["git", "show", f"{c}:{rel}"], cwd=str(root), capture_output=True)
            if blob.returncode != 0:
                continue
            m = FM_RE.match(blob.stdout.decode("utf-8", "replace"))
            t = 0
            if m:
                tm = re.search(r"^token:\s*(\d+)", m.group(1), re.M)
                t = int(tm.group(1)) if tm else 0
            if t > T:
                errors.append(f"state/{f.name}：当前编号 #{T} 小于提交 {c[:8]} 里的 #{t}，新推进者的记录被旧的覆盖了。"
                              f"从提交 {c[:8]} 恢复这个文件，再由持有者整理。")
                break
            if t < T and base != "-" and git(["merge-base", "--is-ancestor", c, base], root)[0] != 0:
                stale.append(f"{c[:8]}（#{t}）")
        if stale:
            errors.append(f"state/{f.name}：提交 {'、'.join(stale[:5])} 是旧推进权下写的，但 #{T}（{holder}）接手时没有看到它们，"
                          f"可能是失联的旧推进者在交接或接管之后还在写。核对这些改动、把需要的内容并进当前状态后，"
                          f"由持有者执行 rk line take {f.stem} --restamp 重新盖章。")
    if line_files():
        st = HOME / "STATE.md"
        want = {(f.stem, read_line(f)[0].get("holder"), fm_token(read_line(f)[0])) for f in line_files()}
        have = set()
        for t in parse_tables(st.read_text(encoding="utf-8")) if st.exists() else []:
            c_l, c_h, c_t = col(t["header"], "线"), col(t["header"], "推进者"), col(t["header"], "编号")
            if None in (c_l, c_h, c_t):
                continue
            for row in t["rows"]:
                if len(row) > max(c_l, c_h, c_t):
                    h = "-" if row[c_h] == "无人持有" else row[c_h]
                    have.add((row[c_l], h, int(row[c_t].lstrip("#") or 0) if row[c_t].lstrip("#").isdigit() else -1))
        if have != want:
            warns.append("STATE.md 总览与 state/ 不一致（合并别的机器的记录之后常见）：rk line status --write 重新生成。")

    rf = HOME / "RUNS.md"
    if rf.exists():
        shown, dup = {}, False
        for t in parse_tables(rf.read_text(encoding="utf-8")):
            c_id, c_st = col(t["header"], "运行 ID"), col(t["header"], "状态")
            if c_id is None or c_st is None:
                continue
            for row in t["rows"]:
                if len(row) > max(c_id, c_st) and row[c_id]:
                    dup = dup or row[c_id] in shown
                    shown[row[c_id]] = row[c_st]
        if dup or shown != {rid: states[rid][0] for rid in ids}:
            warns.append("RUNS.md 不是最新（新运行结束或合并别的机器的记录之后常见）：rk status --write 重新生成。")

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
        led_text = led.read_text(encoding="utf-8")
        if root:  # 只追加：任何提交过的行都必须原样还在
            try:
                rel = led.resolve().relative_to(root.resolve())
            except ValueError:
                rel = None
            rc, out = git(["log", "--format=%H", "--", str(rel)], root) if rel else (1, "")
            cur, seen = ledger_rows(led_text), set()
            for c in (out.split() if rc == 0 else []):
                blob = subprocess.run(["git", "show", f"{c}:{rel}"], cwd=str(root), capture_output=True)
                if blob.returncode != 0:
                    continue
                for r in ledger_rows(blob.stdout.decode("utf-8", "replace")) - cur - seen:
                    seen.add(r)
                    errors.append(f"LEDGER 已提交的旧行被改动或删除（见提交 {c[:8]}）：「{' | '.join(r)[:120]}」。"
                                  f"账本只追加：恢复原行，状态变化用新行更正或撤回。")
        for t in parse_tables(led_text):
            c_st, c_ev = col(t["header"], "状态"), col(t["header"], "证据")
            if c_st is None or c_ev is None:
                continue
            for row in t["rows"]:
                if len(row) <= max(c_st, c_ev):
                    continue
                n_claims += 1
                label, status, ev = row[0], row[c_st], row[c_ev]
                tokens = [x.strip().strip("`") for x in re.split(r"[;；,，\s]+", ev) if x.strip().strip("`")]
                decisive = "已证实" in status or "已否定" in status
                if decisive and not tokens:
                    errors.append(f"LEDGER {label}：状态是“{status}”却没有证据。")
                used = []
                for tok in tokens:
                    if tok.startswith("run:"):
                        rid = tok[4:]
                        if rid not in states:
                            errors.append(f"LEDGER {label}：证据里的运行 {rid} 不存在。")
                        else:
                            used.append(rid)
                    elif "/" in tok and not EXTERNAL.match(tok):
                        if not ((HOME / tok).exists() or (root and (root / tok).exists())):
                            errors.append(f"LEDGER {label}：证据文件 {tok} 不存在。")
                        elif re.match(r"^(research/)?results/", tok) and Path(tok).stem in states:
                            used.append(Path(tok).stem)
                if not decisive:
                    continue
                for rid in dict.fromkeys(used):
                    if states[rid][0] != "ok":
                        errors.append(f"LEDGER {label}：证据运行 {rid} 的状态是 {states[rid][0]}，"
                                      f"失败或没结束的运行不能支撑“{status}”。")
                    elif audits.get(rid, ("",))[0] != "可采信":
                        got = audits.get(rid)
                        errors.append(f"LEDGER {label}：“{status}”依赖的运行 {rid} 没有通过独立审计"
                                      + (f"（{got[1]} 的总评是“{got[0]}”）。" if got else
                                         "（audits/ 里没有它的审计记录）。"))

    for kind, items in (("错误", errors), ("警告", warns), ("说明", notes)):
        for it in items:
            print(f"[{kind}] {it}")
    print(f"rk check：{len(ids)} 条运行，{n_rows} 行总览，{n_claims} 条结论；"
          f"{len(errors)} 个错误，{len(warns)} 个警告。")
    sys.exit(EXIT_FAILED if errors else EXIT_OK)


# ---------------------------------------------------------------- 研究线与推进权

STATE_DIR = HOME / "state"
LEASE_DIR = LOOP / "leases"
HANDOFFS = HOME / "handoffs"
LINE_RE = re.compile(r"^[\w-]{1,32}$")
FM_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)
GEN_MARK = "<!-- rk:generated"
FM_KEYS = ("line", "holder", "token", "base", "stamped", "from")
LINE_TEMPLATE = """# 研究线：<线>

只有持有推进权的机器写本文件：`rk line take` 取得，`rk handoff` 交给别的机器。开头 `---` 之间的推进权信息由 rk 维护，不要手改；正文每完成一步就重写。

- **要回答的问题**：<问题>
- **最后更新**：<时间>
- **阶段**：<调研 | 发散 | 派工 | 运行中 | 审核 | 受阻 | 收尾>
- **在等什么**：<无 | 运行 ID（等待器已在后台）| 子代理 | 用户的决定>
- **预算已用**：<批数 x / y；GPU·小时；连续无进展批数 n；同一路线连续失败批数 m>
- **执行者**：<代理 ID，可否续用>

## 下一步
按顺序做。每项写明它推进的是想法池（IDEAS 编号）里的哪一项。

1. <…>

## 已认领的资源
- <主机:卡 → 运行 ID，预计结束；没有就写“无”>
"""


def read_line(path):
    text = Path(path).read_text(encoding="utf-8")
    m = FM_RE.match(text)
    fm = {}
    if m:
        for ln in m.group(1).splitlines():
            k, _, v = ln.partition(":")
            if k.strip():
                fm[k.strip()] = v.strip()
    return fm, text[m.end():] if m else text


def fm_token(fm):
    try:
        return int(fm.get("token") or 0)
    except ValueError:
        return 0


def write_line(path, fm, body):
    head = "---\n" + "".join(f"{k}: {fm[k]}\n" for k in FM_KEYS if fm.get(k) not in (None, "")) + "---\n"
    tmp = Path(path).with_name(Path(path).name + ".tmp")
    tmp.write_text(head + body, encoding="utf-8")
    os.replace(tmp, path)


def line_files():
    if not STATE_DIR.is_dir():
        return []
    return sorted(f for f in STATE_DIR.glob("*.md") if f.name != "TEMPLATE.md" and LINE_RE.match(f.stem))


def line_path(line):
    if not LINE_RE.match(line or ""):
        die("研究线的名字只用字母、数字、下划线和连字符，最多 32 个字符")
    return STATE_DIR / f"{line}.md"


def body_field(body, name):
    m = re.search(rf"\*\*{name}\*\*\s*[:：]\s*(.+)", body)
    return m.group(1).strip() if m else ""


def body_section(body, title, n=3):
    m = re.search(rf"^##\s*{title}[^\n]*\n(.*?)(?=^## |\Z)", body, re.S | re.M)
    if not m:
        return []
    return [ln for ln in m.group(1).splitlines() if re.match(r"^\s*(\d+\.|[-*])\s+\S", ln)][:n]


def overview_text():
    rows, nexts = [], []
    for f in line_files():
        fm, body = read_line(f)
        holder = fm.get("holder") or "-"
        rows.append(f"| {f.stem} | {holder if holder != '-' else '无人持有'} | #{fm_token(fm)} | "
                    f"{body_field(body, '阶段') or '-'} | {body_field(body, '在等什么') or '-'} | "
                    f"{body_field(body, '最后更新') or '-'} |")
        nexts.append(f"\n### {f.stem}（{holder if holder != '-' else '无人持有'}）\n\n" +
                     ("\n".join(body_section(body, "下一步")) or "- （没写）") + "\n")
    return ("# 当前状态（总览）\n\n" + GEN_MARK + " 由 rk line status --write 从 state/*.md 生成，不要手改 -->\n"
            "每条研究线的状态写在 `state/<线>.md`，只由持有推进权的机器改写；本文件是汇总。\n\n"
            "| 线 | 推进者 | 编号 | 阶段 | 在等什么 | 最后更新 |\n|---|---|---|---|---|---|\n" +
            "\n".join(rows) + "\n\n## 各线的下一步\n" + "".join(nexts))


def write_overview():
    (HOME / "STATE.md").write_text(overview_text(), encoding="utf-8")


def collab_cmd():
    """协调主机上的 collab.py 怎么调用：环境变量 RK_COLLAB，或本机的 .loop/collab（rk line config 写入）。
    都没有时用本机的登记（.loop/LEASES.json）：一台机器上够用，跨机器交接需要协调主机。"""
    env = os.environ.get("RK_COLLAB", "").strip()
    if env:
        return shlex.split(env), "环境变量 RK_COLLAB"
    f = LOOP / "collab"
    if f.exists() and f.read_text(encoding="utf-8").strip():
        return shlex.split(f.read_text(encoding="utf-8").strip()), ".loop/collab"
    return None, "本机（没有配置协调主机）"


def lease_call(action, line=None, **kw):
    """调用协调主机上的 collab.py lease → (结果, 错误)。结果是 collab 给出的 JSON；连不上时结果为 None。"""
    base, _ = collab_cmd()
    args = ["lease", action, "--json"]
    if base is None:
        LOOP.mkdir(parents=True, exist_ok=True)
        base = [sys.executable, str(Path(__file__).resolve().parent / "collab.py")]
        args += ["--leases", str(LOOP / "LEASES.json")]
    if line:
        args += ["--line", line]
    for k, v in kw.items():
        if v is None or v is False:
            continue
        args += [f"--{k.replace('_', '-')}"] if v is True else [f"--{k.replace('_', '-')}", str(v)]
    if os.path.basename(base[0]) == "ssh":
        args = [shlex.quote(x) for x in args]
    try:
        p = subprocess.run(base + args, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        return None, f"连不上协调主机：{e}"
    lines = [ln for ln in p.stdout.splitlines() if ln.strip()]
    try:
        return json.loads(lines[-1]), None
    except (IndexError, ValueError):
        return None, f"协调主机没有给出结果（退出码 {p.returncode}）：{(p.stderr or p.stdout).strip()[:300]}"


def cache_read(line):
    try:
        return json.loads((LEASE_DIR / f"{line}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def cache_write(line, out):
    try:
        left = (datetime.datetime.strptime(out["expires"], "%Y-%m-%d %H:%M:%S")
                - datetime.datetime.strptime(out["now"], "%Y-%m-%d %H:%M:%S")).total_seconds()
    except (KeyError, TypeError, ValueError):
        left = 0
    LEASE_DIR.mkdir(parents=True, exist_ok=True)
    write_json(LEASE_DIR / f"{line}.json", {"line": line, "holder": out["holder"], "token": out["token"],
                                            "expires": out["expires"], "deadline": time.time() + left,
                                            "via": collab_cmd()[1]})


def cache_drop(line):
    (LEASE_DIR / f"{line}.json").unlink(missing_ok=True)


def held_lines():
    return sorted(f.stem for f in LEASE_DIR.glob("*.json")) if LEASE_DIR.is_dir() else []


def commit_paths(paths, msg):
    """只提交这几个文件（不带上别的暂存改动），返回新提交号；不在 git 仓库里返回 None。"""
    root = repo_root(HOME)
    if not root:
        return None
    rels = [str(Path(p).resolve().relative_to(root.resolve())) for p in paths if Path(p).exists()]
    git(["add", "--", *rels], root)
    p = subprocess.run(["git", "commit", "-q", "-m", msg, "--", *rels], cwd=str(root), capture_output=True, text=True)
    if p.returncode != 0:
        print(f"rk: 提交失败，请手工提交 {' '.join(rels)}：{(p.stderr or p.stdout).strip()[:300]}", file=sys.stderr)
        return None
    return git(["rev-parse", "HEAD"], root)[1]


def head_commit():
    root = repo_root(HOME)
    rc, out = git(["rev-parse", "HEAD"], root) if root else (1, "")
    return out if rc == 0 and out else "-"


def behind_upstream():
    """→ (落后几个提交, 上游名)；没有上游或取不到时 (0, None)。会先 git fetch。"""
    root = repo_root(HOME)
    if not root:
        return 0, None
    rc, up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root)
    if rc != 0:
        return 0, None
    try:
        subprocess.run(["git", "fetch", "-q"], cwd=str(root), capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        pass
    rc, n = git(["rev-list", "--count", "HEAD..@{u}"], root)
    return (int(n) if rc == 0 and n.isdigit() else 0), up


def stamp_line(line, path, body, out, me, extra_msg, frm=""):
    fm = {"line": line, "holder": out["holder"] or "-", "token": str(out["token"]), "base": head_commit(),
          "stamped": now(), "from": frm}
    write_line(path, fm, body)
    write_overview()
    return commit_paths([path, HOME / "STATE.md"], f"研究线 {line}：{extra_msg}（推进权 #{out['token']}）")


def cmd_line(a):
    me = machine_name()[0]
    if a.action == "config":
        if a.collab is not None:
            LOOP.mkdir(parents=True, exist_ok=True)
            (LOOP / "collab").write_text(a.collab.strip() + "\n", encoding="utf-8")
        cmd, src = collab_cmd()
        print(f"协调主机：{' '.join(cmd) if cmd else '未配置'}（来自{src}）。本机代号 {me}。")
        if cmd:
            out, err = lease_call("show")
            print("连通。" if out is not None else f"连不上：{err}")
        return
    if a.action == "status":
        if a.write:
            write_overview()
            print(f"已写入 {HOME / 'STATE.md'}")
            return
        held = set(held_lines())
        coord = {}
        if a.lease:
            out, err = lease_call("show")
            coord = out or {}
            if err:
                print(f"（{err}）")
        for f in line_files():
            fm, body = read_line(f)
            mark = "本机持有" if f.stem in held else ""
            c = coord.get(f.stem)
            if c and (c.get("holder") or "-") != (fm.get("holder") or "-"):
                mark += f"；协调主机上是 {c.get('holder') or '无人持有'} #{c.get('token')}（先 git pull）"
            print(f"{f.stem} | {fm.get('holder') or '-'} #{fm_token(fm)} | {body_field(body, '阶段') or '-'} | "
                  f"{body_field(body, '在等什么') or '-'} | {mark or '-'}")
        if not line_files():
            print("还没有研究线：rk line new <线> --question \"<要回答的问题>\"")
        return
    if a.action == "beat":
        lost = False
        for line in held_lines():
            c = cache_read(line) or {}
            out, err = lease_call("renew", line, holder=me, token=c.get("token"))
            if out is None:
                print(f"{line}：{err}；本机记录的租期到 {c.get('expires')}")
            elif out.get("ok"):
                cache_write(line, out)
                print(f"{line}：续租到 {out['expires']}（#{out['token']}）")
            else:
                cache_drop(line)
                lost = True
                print(f"{line}：已不再持有。{out.get('message')}")
        if not held_lines() and not lost:
            print("本机没有持有任何研究线。")
        sys.exit(EXIT_FAILED if lost else EXIT_OK)

    if not a.line:
        die(f"rk line {a.action} <线>")
    path = line_path(a.line)
    if a.action == "new":
        if path.exists():
            die(f"state/{a.line}.md 已存在：要在这台机器推进用 rk line take {a.line}")
        out, err = lease_call("acquire", a.line, holder=me)
        if out is None:
            die(err, EXIT_FAILED)
        if not out.get("ok"):
            die(out.get("message"), EXIT_TICK)
        tpl = STATE_DIR / "TEMPLATE.md"
        body = read_line(tpl)[1] if tpl.exists() else LINE_TEMPLATE
        body = body.replace("<线>", a.line).replace("<问题>", a.question or "<…>").replace("<时间>", now())
        st = HOME / "STATE.md"
        if not line_files() and st.exists():
            old = st.read_text(encoding="utf-8")
            if GEN_MARK not in old and "<时间>" not in old:  # 手写过的 STATE.md：并进第一条线，不丢
                body += f"\n## 迁移自 STATE.md（{now()}）\n\n" + re.sub(r"^(#+)", r"#\1", old, flags=re.M)
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        cache_write(a.line, out)
        c = stamp_line(a.line, path, body, out, me, f"新建，推进权归 {me}")
        print(f"已建研究线 {a.line}：state/{a.line}.md，推进权 #{out['token']} 归本机（{me}），到 {out['expires']}"
              + (f"；已提交 {c[:8]}" if c else "") + ("" if collab_cmd()[0] else "。没有配置协调主机，推进权只登记在本机；"
                                                     "要跨机器交接先 rk line config --collab \"<命令>\""))
        return
    if not path.exists():
        die(f"没有研究线 {a.line}（state/{a.line}.md）。别的机器建的先 git pull；新线用 rk line new。")
    fm, body = read_line(path)
    if a.action == "take":
        behind, up = behind_upstream()
        if behind:
            die(f"本地落后 {up} {behind} 个提交：先 git pull，拿到上一个推进者的记录再接手。")
        out, err = lease_call("acquire", a.line, holder=me, takeover=a.takeover, evidence=a.evidence,
                              restamp=a.restamp)
        if out is None:
            die(err, EXIT_FAILED)
        if not out.get("ok"):
            die(out.get("message"), EXIT_TICK)
        if out["token"] < fm_token(fm):  # 本机登记处不是这条线的权威（多半是没配协调主机）
            die(f"仓库里 {a.line} 的推进权已到 #{fm_token(fm)}，{collab_cmd()[1]} 只给出 #{out['token']}："
                f"这条线是经协调主机登记的。先 rk line config --collab \"<命令>\" 配上同一台协调主机再接手。")
        cache_write(a.line, out)
        if fm.get("holder") == me and fm_token(fm) == out["token"]:
            print(f"{a.line}：推进权 #{out['token']} 在本机（{me}），续租到 {out['expires']}。")
            return
        if out["event"] == "续租":  # 协调主机上已经是本机（例如别的机器刚交接过来），仓库里还是旧记录
            if fm_token(fm) < out["token"]:
                cache_drop(a.line)
                die(f"协调主机上 {a.line} 已交给本机（#{out['token']}），仓库里的记录还是 #{fm_token(fm)}："
                    f"先 git pull 拿到交接记录，再 rk line take {a.line}。")
        prev = fm.get("holder") if fm.get("holder") not in (None, "-", me) else ""
        c = stamp_line(a.line, path, body, out, me, out["event"], prev)
        print(f"{a.line}：{out['event']}，推进权 #{out['token']} 归本机（{me}），到 {out['expires']}"
              + (f"；已提交 {c[:8]}" if c else ""))
        return
    if a.action == "release":
        c = cache_read(a.line)
        if not c:
            die(f"本机没有 {a.line} 的推进权。")
        out, err = lease_call("release", a.line, holder=me, token=c["token"])
        if out is None:
            die(err, EXIT_FAILED)
        cache_drop(a.line)
        if not out.get("ok"):
            die(out.get("message"), EXIT_TICK)
        cm = stamp_line(a.line, path, body, out, me, f"{me} 交出推进权")
        print(f"{a.line}：已交出推进权（#{out['token']}）" + (f"；已提交 {cm[:8]}" if cm else ""))


def handoff_summary(line, me, to, token, note, left_runs, body, src):
    def tail(f, n):
        try:
            return "\n".join(Path(f).read_text(encoding="utf-8").splitlines()[-n:])
        except OSError:
            return "（没有）"
    decide = "（没有）"
    try:
        m = re.search(r"^##[^\n]*需要你决定[^\n]*\n(.*?)(?=^## |\Z)", (HOME / "SUMMARY.md").read_text(encoding="utf-8"),
                      re.S | re.M)
        decide = m.group(1).strip() or "（没有）" if m else "（没有）"
    except OSError:
        pass
    state = re.sub(r"^(#+)", r"##\1", body.strip(), flags=re.M)
    runs = "\n".join(f"- {rid}：在 {me} 上跑完后，到接手的机器上 rk pull <{me} 的别名>:<研究目录> {rid}"
                     for rid in left_runs) or "- 无"
    return (f"# 交接：{line}（{me} → {to}，推进权 #{token}）\n\n"
            f"- 时间：{now()}\n- 交接时的提交：{src}\n\n"
            f"## 交接说明\n\n{note or '（没写。下面是原始记录，按它们接着做。）'}\n\n"
            f"## 留在原机器上的运行\n\n{runs}\n\n"
            f"## 需要用户决定的事（SUMMARY.md）\n\n{decide}\n\n"
            f"## 接手步骤\n\n1. `git pull`\n2. `python3 research/tools/rk.py line take {line}`\n"
            f"3. `/research:resume {line}`：先读本文件，再读 `state/{line}.md`\n\n"
            f"## 这条线的状态（state/{line}.md 原文）\n\n{state}\n\n"
            f"## 日志末尾（LOG.md 最后 30 行）\n\n{tail(HOME / 'LOG.md', 30)}\n")


def cmd_handoff(a):
    """把一条研究线交给另一台机器：前置检查 → 写交接摘要并盖章 → 推送 → 协调主机上转移推进权 →（可选）在目标机器上接手。
    中途失败可以原样重跑：已完成的步骤会跳过。"""
    me = machine_name()[0]
    line, to = a.line, a.to
    path = line_path(line)
    if not MACHINE_NAME_RE.match(to or "") or to == me:
        die("--to 是接手机器的代号（在那台机器上执行 rk id 查看），且不能是本机")
    if not path.exists():
        die(f"没有研究线 {line}")
    root = repo_root(HOME)
    if not root:
        die("交接靠 git 搬运记录：研究目录要在 git 仓库里。")
    if collab_cmd()[0] is None:
        die("跨机器交接需要协调主机（两台机器都能连上的那台）：rk line config --collab \"ssh <别名> python3 <目录>/collab.py\"")
    fm, body = read_line(path)
    cache = cache_read(line)
    resumed = bool(cache) and fm.get("holder") == to and fm.get("from") == me and fm_token(fm) == cache["token"] + 1
    problems = []
    transferred = False
    if not cache:
        problems.append(("这台机器没有这条线的推进权", f"rk line take {line}"))
    else:
        out, err = lease_call("show", line)
        cur = (out or {}).get(line) or {}
        if out is None:
            problems.append((err, "检查 rk line config 里的协调主机，或稍后重试"))
        elif cur.get("holder") == me and cur.get("token") == cache["token"]:
            pass
        elif resumed and cur.get("holder") == to and cur.get("token") == cache["token"] + 1:
            transferred = True
        else:
            problems.append((f"协调主机上推进权是 {cur.get('holder') or '无人持有'} #{cur.get('token')}，"
                             f"本机记录是 #{cache['token']}", f"git pull 之后 rk line status --lease 核对"))
    _, st = git(["status", "--porcelain", "--", str(HOME)], root)
    if st:
        problems.append(("研究目录有没提交的改动：" + "；".join(st.splitlines()[:5]),
                         f"git add {HOME.relative_to(root) if root in HOME.parents else HOME} && git commit -m \"交接前提交\""))
    behind, up = behind_upstream()
    if not up:
        problems.append(("当前分支没有上游，接手的机器拿不到记录", "git push -u origin <分支>"))
    elif behind:
        problems.append((f"落后 {up} {behind} 个提交", "git pull"))
    left = [rid for rid in run_ids() if load_meta(rid).get("line") == line and state_of(rid)[0] in ("running", "open")]
    if left and not a.leave_runs:
        problems.append((f"这条线还有运行没结束：{', '.join(left)}",
                         "等它们结束（rk wait），或加 --leave-runs：留在本机跑完，接手的机器之后用 rk pull 拉回"))
    remote = re.match(r"^([^/:]+):(.+)$", a.remote) if a.remote else None
    if a.remote and not remote:
        die("--remote 写成 <ssh 别名>:<目标机器上的研究目录>")
    if remote:
        host, rdir = remote.groups()
        try:
            p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host,
                                f"python3 {shlex.quote(rdir.rstrip('/') + '/tools/rk.py')} id"],
                               capture_output=True, text=True, timeout=60)
            m = re.search(r"本机代号：([a-z][a-z0-9]*)", p.stdout)
            if not m:
                problems.append((f"在 {host} 上没跑通 rk：{(p.stderr or p.stdout).strip()[:200]}",
                                 f"确认 {host} 上有这个仓库、研究目录是 {rdir}"))
            elif m.group(1) != to:
                problems.append((f"{host} 的机器代号是 {m.group(1)}，不是 {to}", f"改用 --to {m.group(1)}"))
        except (OSError, subprocess.SubprocessError) as e:
            problems.append((f"连不上 {host}：{e}", "检查 ssh 别名；或不带 --remote，到目标机器上手工接手"))
    print(f"交接 {line}：{me} → {to}")
    for why, fix in problems:
        print(f"  ✗ {why}\n    修复：{fix}")
    if problems:
        sys.exit(EXIT_FAILED)
    print("  ✓ 前置检查通过" + ("（接着上次没完成的交接）" if resumed else ""))
    if a.dry_run:
        return
    token = cache["token"] + 1
    if not resumed:
        HANDOFFS.mkdir(parents=True, exist_ok=True)
        src = head_commit()
        summ = HANDOFFS / f"{datetime.datetime.now():%Y%m%d-%H%M%S}-{line}-{me}-{to}.md"
        summ.write_text(handoff_summary(line, me, to, token, a.note, left, body, src), encoding="utf-8")
        write_line(path, {"line": line, "holder": to, "token": str(token), "base": src, "stamped": now(), "from": me}, body)
        write_overview()
        if not commit_paths([path, summ, HOME / "STATE.md"], f"研究线 {line}：交接给 {to}（推进权 #{token}）"):
            die("交接记录没能提交，交接没有进行。")
        print(f"  ✓ 交接摘要 {summ.relative_to(HOME)}，已盖章 #{token} 并提交")
    try:
        p = subprocess.run(["git", "push", "-q"], cwd=str(root), capture_output=True, text=True, timeout=180)
        pushed = p.returncode == 0
        perr = (p.stderr or "").strip()[:300]
    except (OSError, subprocess.SubprocessError) as e:
        pushed, perr = False, str(e)
    if not pushed:
        die(f"推送失败：{perr}。交接记录已在本地提交；网络好了原样重跑这条 rk handoff 命令。", EXIT_FAILED)
    print("  ✓ 已推送")
    if not transferred:
        out, err = lease_call("transfer", line, holder=me, token=cache["token"], to=to)
        if out is None or not out.get("ok"):
            die(f"协调主机没完成转移：{err or out.get('message')}。记录已推送；原样重跑这条命令即可。", EXIT_FAILED)
    cache_drop(line)
    print(f"  ✓ 推进权 #{token} 已交给 {to}；本机不再写 state/{line}.md")
    if remote:
        host, rdir = remote.groups()
        cmd = (f"cd {shlex.quote(rdir)} && git pull -q --ff-only && "
               f"python3 tools/rk.py line take {shlex.quote(line)}")
        try:
            p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, cmd],
                               capture_output=True, text=True, timeout=180)
            ok = p.returncode == 0
            msg = (p.stdout + p.stderr).strip()[:300]
        except (OSError, subprocess.SubprocessError) as e:
            ok, msg = False, str(e)
        print(f"  {'✓' if ok else '✗'} {host} 上接手：{msg}")
        if not ok:
            print(f"    到 {host} 上手工执行：git pull && python3 research/tools/rk.py line take {line}")
    else:
        print(f"接手：到 {to} 上执行 git pull && python3 research/tools/rk.py line take {line}，然后 /research:resume {line}")
    if not held_lines():
        print("本机已不持有任何研究线：研究循环可以关掉（rk loop off）。在跑的运行照常跑完。")


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

    p = sub.add_parser("id", help="本机代号；给出简称时生成下一个运行 ID")
    p.add_argument("name", nargs="?")
    p.set_defaults(fn=cmd_id)

    p = sub.add_parser("run", help="登记并启动一次运行（后台、带退出码与日志）")
    p.add_argument("run_id")
    p.add_argument("--prereg", action="append", metavar="文件", help="已提交的预登记/分析脚本，可多次")
    p.add_argument("--explore", action="store_true", help="探索性运行：冒烟、试点、描述")
    p.add_argument("--manual", action="store_true", help="没有进程的批次（文献、推导、人工步骤）")
    p.add_argument("--allow-dirty", action="store_true")
    p.add_argument("--cwd")
    p.add_argument("--note")
    p.add_argument("--line", help="这次运行属于哪条研究线（交接时据此检查有没有没跑完的运行）；默认取环境变量 RESEARCH_LINE")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("_supervise")
    p.add_argument("run_id")
    p.set_defaults(fn=cmd_supervise)

    p = sub.add_parser("done", help="结束一条手工批次，或把丢失的运行归档为失败")
    p.add_argument("run_id")
    p.add_argument("--fail", action="store_true")
    p.add_argument("--note")
    p.set_defaults(fn=cmd_done)

    p = sub.add_parser("pull", help="把远程主机上已结束的运行记录（含日志）拉回本机；只补缺失的文件")
    p.add_argument("source", metavar="别名:远程研究目录", help="也可以是本机上另一个研究目录的路径")
    p.add_argument("run_ids", nargs="+")
    p.set_defaults(fn=cmd_pull)

    p = sub.add_parser("wait", help="阻塞到运行结束或到状态间隔；退出码 0 全部成功 / 1 有失败 / 3 到点")
    p.add_argument("run_ids", nargs="*")
    p.add_argument("--interval", type=float, default=30, help="状态间隔（分钟），默认 30")
    p.add_argument("--poll", type=float, default=10, help=argparse.SUPPRESS)
    p.set_defaults(fn=cmd_wait)

    p = sub.add_parser("status", help="所有运行的真实状态")
    p.add_argument("--write", action="store_true")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("audit", help="登记或查看独立审计")
    p.add_argument("action", choices=["record", "show"])
    p.add_argument("run_ids", nargs="*", help="show 时只看这些运行")
    p.add_argument("--runs", help="record：这次审计覆盖的运行 ID，逗号分隔")
    p.add_argument("--verdict", help="record：可采信 / 需退回 / 不可采信")
    p.add_argument("--report", help="record：审计员报告；不在 audits/ 里时复制进去")
    p.add_argument("--by", help="record：审计员（默认 research:auditor）")
    p.add_argument("--note")
    p.set_defaults(fn=cmd_audit)

    p = sub.add_parser("line", help="研究线与推进权：new / take / beat / release / status / config")
    p.add_argument("action", choices=["new", "take", "beat", "release", "status", "config"])
    p.add_argument("line", nargs="?")
    p.add_argument("--question", help="new：这条线要回答的问题")
    p.add_argument("--takeover", action="store_true", help="take：接管已到期、持有者失联的推进权")
    p.add_argument("--evidence", help="take --takeover：你确认对方已停下的证据")
    p.add_argument("--restamp", action="store_true", help="take：持有者重新盖章（核对合并进来的旧写入之后）")
    p.add_argument("--write", action="store_true", help="status：重新生成 STATE.md 总览")
    p.add_argument("--lease", action="store_true", help="status：同时核对协调主机上的推进权")
    p.add_argument("--collab", help="config：调用协调主机上 collab.py 的命令前缀，例如 \"ssh gpu-a python3 /shared/collab.py\"")
    p.set_defaults(fn=cmd_line)

    p = sub.add_parser("handoff", help="把一条研究线交给另一台机器")
    p.add_argument("line")
    p.add_argument("--to", required=True, help="接手机器的代号（在那台机器上 rk id 查看）")
    p.add_argument("--remote", help="<ssh 别名>:<那台机器上的研究目录>：交接后直接在那里 git pull 并接手")
    p.add_argument("--note", help="给接手者的几句话：做到哪、下一步、要注意什么")
    p.add_argument("--leave-runs", action="store_true", help="这条线没跑完的运行留在本机跑完")
    p.add_argument("--dry-run", action="store_true", help="只做前置检查")
    p.set_defaults(fn=cmd_handoff)

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
