# 固定契约夹具，不是 rk 的实现。只用于本地测试。
RK_VERSION = "0.6.0"
import json
import os
from pathlib import Path
import subprocess
import sys
import time

home = Path(os.environ['RESEARCH_HOME'])
command = sys.argv[1]
with (home / 'commands').open('a') as f:
    f.write(' '.join(sys.argv[1:]) + '\n')
case = json.loads((home / 'case.json').read_text()) if (home / 'case.json').exists() else {}
mode = case.get(command)
if mode == 'timeout':
    time.sleep(30)
if mode == 'cancel':
    child = subprocess.Popen([sys.executable, '-c', "import time,pathlib,signal;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(4);pathlib.Path('escaped').write_text('bad')"])
    (home / 'child.pid').write_text(str(child.pid))
    time.sleep(30)
if mode == 'invalid':
    print('not JSON')
    print("ignored\none\ntwo\nhttps://USER:pa'ss@host/repo\nPlease make sure you have the correct access rights\nand the repository exists.", file=sys.stderr)
    sys.exit(1)
if mode == 'array':
    print('[]')
    sys.exit(0)
if mode == 'overflow':
    print(json.dumps({'padding': 'x' * (4 * 1024 * 1024)}))
    sys.exit(0)
if mode == 'exit2':
    print('{}')
    sys.exit(2)
if command == 'status':
    print('[]')
    sys.exit(0)
print((home / (command + '.json')).read_text())
sys.exit(1 if command in ('check', 'cite') or mode == 'exit1' else 0)
