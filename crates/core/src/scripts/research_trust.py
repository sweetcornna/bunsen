# Python 3.9+；仅用标准库。由 Bunsen 执行器交给本机/远端同一脚本。
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time

home, marker = sys.argv[1:3]
per_command, total = map(float, sys.argv[3:5])
limit = 4 * 1024 * 1024
with open(os.path.join(home, 'tools/rk.py'), 'rb') as f:
    source = f.read(1024 * 1024).decode('utf-8', 'replace')
version = re.search(r'^\s*RK_VERSION\s*=\s*[\'\"](\d+\.\d+\.\d+)[\'\"]', source, re.M)
if not version or tuple(map(int, version[1].split('.'))) < (0, 6, 0):
    sys.exit(0)

active = None

def stop():
    # 独立进程组允许只取消当前命令；外层取消时由信号处理器清理该组。
    global active
    if active is None:
        return
    p, active = active, None
    def send(sig):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS 沙箱对已消失的进程组有时返回 EPERM；与执行器一样用系统 kill。
            subprocess.run(['/bin/kill', '-TERM' if sig == signal.SIGTERM else '-KILL', '--', '-%d' % p.pid],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)
    send(signal.SIGTERM)
    # 留给外层执行器（TERM 后 3 秒 KILL）至少 1 秒清理余量，防止监督器先死、孙进程逃走。
    if p.poll() is None:
        time.sleep(2)
    send(signal.SIGKILL)
    p.wait(timeout=1)

def cancelled(signum, frame):
    stop()
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, cancelled)
signal.signal(signal.SIGHUP, cancelled)
deadline = time.monotonic() + total
for name, args in [('check', ['check']), ('review', ['review', 'status']),
                   ('cite', ['cite', 'check', '--offline']), ('plan', ['plan', 'status'])]:
    value, error, cause = None, None, None
    out, err = bytearray(), bytearray()
    end = min(deadline, time.monotonic() + per_command)
    if end <= time.monotonic():
        error = '脚本总计 150 秒预算已用尽，命令未执行'
    else:
        try:
            env = dict(os.environ, RESEARCH_HOME=home)
            active = subprocess.Popen([sys.executable, os.path.join(home, 'tools/rk.py')] + args + ['--json'],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      env=env, start_new_session=True)
            with selectors.DefaultSelector() as sel:
                sel.register(active.stdout, selectors.EVENT_READ, out)
                sel.register(active.stderr, selectors.EVENT_READ, err)
                while sel.get_map() or active.poll() is None:
                    remaining = end - time.monotonic()
                    if remaining <= 0:
                        error = '命令超时（单条最多 60 秒；脚本总计 150 秒）'
                        break
                    for key, _ in sel.select(min(remaining, 0.1)):
                        data = os.read(key.fd, 65536)
                        if not data:
                            sel.unregister(key.fileobj)
                            continue
                        key.data.extend(data)
                        if key.data is out and len(out) > limit:
                            error = '命令输出超过 4 MiB'
                            break
                        if key.data is err and len(err) > 65536:
                            del err[:-65536]
                    if error:
                        break
            if not error:
                code = active.wait()
                try:
                    value = json.loads(out.decode('utf-8'))
                    if not isinstance(value, dict):
                        raise ValueError('不是对象')
                except (ValueError, UnicodeError, RecursionError):
                    error = '命令输出不是合法 JSON 对象'
                # check/cite 的 1 表示发现问题，不是传输失败。
                if code != 0 and not (code == 1 and name in ('check', 'cite')):
                    cause = value.get('error') if isinstance(value, dict) else None
                    error = cause if isinstance(cause, str) else '命令退出码 %d' % code
            if error is not None:
                detail = err.decode('utf-8', 'replace')
                if detail and not isinstance(cause, str):
                    error = detail + '\n' + error
        except (OSError, ValueError) as exc:
            error = str(exc)
        finally:
            stop()
    print(marker + ' ' + name, flush=True)
    print(json.dumps({'error': error} if error is not None else {'value': value}, ensure_ascii=True), flush=True)
    print(marker + ' end', flush=True)
