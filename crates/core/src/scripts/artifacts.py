import datetime
import hashlib
import json
import os
import subprocess
import sys

EXTS = {__EXTS__}
SKIP = {__SKIP__}
DOC_DIRS = {'results', 'reports', 'report', 'paper', 'papers', 'figures', 'outputs', 'output'}
items = []
n = 0
for root, dirs, files in os.walk('.'):
    rel = os.path.relpath(root, '.')
    depth = 0 if rel == '.' else rel.count(os.sep) + 1
    dirs[:] = [] if depth + 1 >= __DEPTH__ else [d for d in dirs if not d.startswith('.') and d not in SKIP]
    for f in files:
        if '.' not in f or '\n' in f:
            continue
        ext = f.rsplit('.', 1)[1].lower()
        if ext not in EXTS:
            continue
        p = os.path.join(root, f)
        try:
            st = os.stat(p)
        except OSError:
            continue
        name = p.encode('utf-8', 'surrogateescape').decode('utf-8', 'replace')
        print('%d|%d|%s' % (st.st_size, int(st.st_mtime), name))
        if ext not in ('md', 'tex', 'docx') or any(d.lower() in DOC_DIRS for d in root.split('/')):
            items.append((int(st.st_mtime), name[2:] if name.startswith('./') else name, p))
        n += 1
        if n >= __CAP__:
            break
    if n >= __CAP__:
        break

# 先排序、截断，只为本响应真正返回的产物计算哈希。
items.sort(key=lambda item: (-item[0], item[1]))
items = items[:int(sys.argv[2]) if len(sys.argv) > 2 else 300]
try:
    repo = subprocess.run(['git', 'rev-parse', '--show-toplevel'], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=10, check=True).stdout.decode().strip()
except (OSError, ValueError, subprocess.SubprocessError):
    repo = None

work_root = os.path.realpath(os.getcwd())

def key(path):
    absolute = os.path.realpath(path if os.path.isabs(path) else os.path.join(repo or os.getcwd(), path))
    if os.path.commonpath([work_root, absolute]) != work_root:
        return None
    if repo and os.path.commonpath([repo, absolute]) == repo:
        return os.path.relpath(absolute, repo)
    return absolute

wanted = {k for _, _, p in items for k in [key(os.path.abspath(p))] if k is not None}
latest = {}
home = sys.argv[1] if len(sys.argv) > 1 else 'research'
try:
    # 不遍历无关文件；至多读取 2000 份清单，每份独立有界。
    with os.scandir(os.path.join(home, 'runs')) as entries:
        count = 0
        for entry in entries:
            if not entry.is_dir():
                continue
            count += 1
            if count > 2000:
                break
            try:
                with open(os.path.join(entry.path, 'outputs.json'), 'rb') as f:
                    if os.fstat(f.fileno()).st_size > 4 * 1024 * 1024:
                        continue
                    raw = f.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024:
                    continue
                record = json.loads(raw)
                if (not isinstance(record, dict) or record.get('run_id') != entry.name
                    or type(record.get('version')) is not int or record['version'] != 1
                    or type(record.get('truncated')) is not bool):
                    continue
                if not isinstance(record.get('written_at'), str):
                    continue
                when = datetime.datetime.fromisoformat(record['written_at'].replace('Z', '+00:00')).timestamp()
                files = record['files']
                if not isinstance(files, list):
                    continue
                for f in files:
                    if not isinstance(f, dict) or not isinstance(f.get('path'), str):
                        continue
                    if (type(f.get('size')) is not int or f['size'] < 0
                        or type(f.get('partial')) is not bool or type(f.get('unhashed')) is not bool
                        or 'sha256' not in f or f['sha256'] is not None and not isinstance(f['sha256'], str)):
                        continue
                    path = key(f['path'])
                    rank = (when, entry.name)
                    if path in wanted and (path not in latest or rank > latest[path][0]):
                        latest[path] = (rank, f)
            except (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError, AttributeError):
                continue
except OSError:
    pass

budget = __HASH_BUDGET__
provenance = {}
for _, name, p in items:
    identity = key(os.path.abspath(p))
    if identity is None:
        continue
    match = latest.get(identity)
    if match is None:
        continue
    rank, f = match
    verified = None
    try:
        with open(p, 'rb') as source:
            before = os.fstat(source.fileno())
            size = before.st_size
            if size != f.get('size'):
                verified = False
            elif not f.get('unhashed') and isinstance(f.get('sha256'), str):
                partial = size > 256 * 1024 * 1024
                cost = 2 * 1024 * 1024 if partial else size
                if cost <= budget:
                    budget -= cost
                    h = hashlib.sha256()
                    if partial:
                        h.update((str(size) + '\n').encode())
                        h.update(source.read(1024 * 1024))
                        source.seek(-1024 * 1024, os.SEEK_END)
                        h.update(source.read(1024 * 1024))
                    else:
                        left = size
                        while left:
                            data = source.read(min(left, 1024 * 1024))
                            if not data:
                                break
                            h.update(data)
                            left -= len(data)
                    after = os.fstat(source.fileno())
                    verified = h.hexdigest() == f['sha256'] and (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
    except OSError:
        pass
    provenance[name] = {'run_id': rank[1], 'verified': verified}
print('__OP_RUN__')
print(json.dumps(provenance))
