#!/usr/bin/env bash
# 只补缺失文档；安全升级研究工具，升级前备份，拒绝未提交修改。
set -eu
proj="${1:?用法：scaffold.sh <项目目录> [研究目录名]}"
[ -d "$proj" ] || { echo "项目目录不存在：$proj" >&2; exit 2; }
proj="$(cd "$proj" && pwd)"
plugin="$(cd "$(dirname "$0")/.." && pwd)"
. "$plugin/hooks/lib.sh"
if [ -n "${2:-}" ]; then
  case "$2" in /*) home="$2" ;; *) home="$proj/$2" ;; esac
else
  home=$(CLAUDE_PROJECT_DIR="$proj" research_home)
fi
python3 - "$plugin/templates/research" "$proj" "$home" <<'PY'
import os, pathlib, re, shutil, subprocess, sys, tempfile, time
src, proj, home = map(pathlib.Path, sys.argv[1:])
home = home.resolve()
tools = home / 'tools'
env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_LITERAL_PATHSPECS='1', GIT_ALLOW_PROTOCOL='file:git:http:https:ssh')
env.pop('GIT_GLOB_PATHSPECS', None); env.pop('GIT_NOGLOB_PATHSPECS', None)
def stop(message):
    print(message, file=sys.stderr); raise SystemExit(2)
def inside(path, root):
    try: path.resolve().relative_to(root); return True
    except ValueError: return False
def safe(dst, root):
    if not inside(dst, root): stop('拒绝跟随越界符号链接：' + str(dst))
def version(path):
    try: text = path.read_text(encoding='utf-8', errors='replace')
    except FileNotFoundError: return None
    m = re.search(r'''^RK_VERSION\s*=\s*['"]([^'"]+)['"]''', text, re.M)
    return m.group(1) if m else None
def parts(v):
    return tuple(map(int,v.split('.'))) if v and re.fullmatch(r'[0-9]+(?:\.[0-9]+)*',v) else None
files = [f for f in src.rglob('*') if f.is_file() and f.name != '.DS_Store' and f.suffix != '.pyc' and '__pycache__' not in f.parts]
files.sort(key=lambda f: f.name=='rk.py')  # 入口版本最后替换，失败后可以重新执行升级
# 检查目标本身和整条目录链；tools 根也不能通过链接搬到其他目录。
safe(tools, tools)
for f in files:
    dst = home / f.relative_to(src)
    safe(dst, tools if f.relative_to(src).parts[0] == 'tools' else home)
new, old = version(src/'tools/rk.py'), version(tools/'rk.py')
n, o = parts(new), parts(old)
if n is None: stop('模板 RK_VERSION 不合规')
width = max(len(n),len(o or ()))
upgrade = old is None or (o is not None and o+(0,)*(width-len(o)) < n+(0,)*(width-len(n)))
replaced = [home/f.relative_to(src) for f in files if f.relative_to(src).parts[0]=='tools' and os.path.lexists(home/f.relative_to(src))]
# 从真实研究目录寻找仓库，不能把绝对 home 的状态错误归到 proj 所在仓库。
anchor=home
while not anchor.is_dir(): anchor=anchor.parent
root=subprocess.run(['git','rev-parse','--show-toplevel'],cwd=anchor,env=env,capture_output=True,timeout=10)
repo=pathlib.Path(os.fsdecode(root.stdout).strip()) if root.returncode==0 else None
if repo is None and any((d/'.git').exists() for d in [anchor,*anchor.parents]): stop('无法检查已有仓库的工具状态，停止升级')
def git(args):
    local_env=dict(env)
    if args[0]=='check-ignore': local_env.pop('GIT_LITERAL_PATHSPECS',None)  # 本命令本来就接收字面路径，不接受 pathspec magic
    r=subprocess.run(['git',*args],cwd=repo,env=local_env,capture_output=True,timeout=10)
    if r.returncode not in (0,1): stop('检查工具状态失败：'+r.stderr.decode('utf-8','replace'))
    return r
if upgrade and repo:
    rels=[str((home/f.relative_to(src)).relative_to(repo)) for f in files if f.relative_to(src).parts[0]=='tools']
    state=git(['status','--porcelain','-z','--untracked-files=all','--',*rels])
    if state.returncode: stop('检查工具状态失败，停止升级')
    if state.stdout: stop('研究工具有未提交的修改：先提交或处理，再升级（未写入工具）')
created=0
# 非工具文档仍然只补缺失，不跟随目标文件链接。
for f in files:
    rel=f.relative_to(src); dst=home/rel
    if rel.parts[0]=='tools': continue
    if not os.path.lexists(dst):
        dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(f,dst); created+=1
if upgrade:
    backup=None
    if replaced:
        backup=home/'.loop/tool-backups'/('v'+str(old or 'unversioned')+'-'+str(time.time_ns()))
        safe(home/'.loop',home/'.loop')
        safe(backup,home/'.loop')
        if repo and git(['check-ignore','-q','--',str(backup.relative_to(repo)/'probe')]).returncode!=0:
            stop('备份目录未被 git 忽略：请先让研究目录的 .loop/ 被忽略，再升级')
        backup.mkdir(parents=True)
        for dst in replaced:
            target=backup/dst.relative_to(tools);target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(dst,target,follow_symlinks=False)
        print('研究工具备份：'+str(backup))
    for f in files:
        rel=f.relative_to(src)
        if rel.parts[0]!='tools': continue
        dst=home/rel;safe(dst,tools)
        dst.parent.mkdir(parents=True,exist_ok=True)
        if not os.path.lexists(dst): created+=1
        # 临时文件 + 原子替换；绝不以写模式打开目标链接。
        fd,tmp=tempfile.mkstemp(prefix='.rk-upgrade-',dir=dst.parent);os.close(fd)
        try:
            shutil.copy2(f,tmp)
            if f.suffix=='.py': os.chmod(tmp,os.stat(tmp).st_mode|0o111)
            safe(dst,tools);os.replace(tmp,dst)
        finally:
            if os.path.lexists(tmp): os.unlink(tmp)
    print('研究工具已更新：'+str(old or '无版本')+' → '+new)
# 升级旧项目也补本期瞬态文件规则，保留用户规则且重复执行不追加。
ignore = home / '.gitignore'
safe(ignore, home)
text = ignore.read_text(encoding='utf-8') if ignore.exists() else ''
for rule in (src / '.gitignore').read_text(encoding='utf-8').splitlines():
    if rule.startswith('runs/*/.rk-') and rule not in text.splitlines():
        text += ('' if not text or text.endswith('\n') else '\n') + rule + '\n'
ignore.write_text(text, encoding='utf-8')
# 旧项目的 .gitattributes 不覆盖，只补没有显式定义的摘录合并规则。
attrs = home / '.gitattributes'
text = attrs.read_text(encoding='utf-8') if attrs.exists() else ''
if not any(line.strip().split()[:1] == ['sources/excerpts.md'] for line in text.splitlines()):
    safe(attrs, home)
    attrs.write_text(text + ('' if not text or text.endswith('\n') else '\n') + 'sources/excerpts.md merge=union\n', encoding='utf-8')
for d in ['runs','results','prereg','strategy','audits','state','handoffs','sources']:
    safe(home/d,home);(home/d).mkdir(parents=True,exist_ok=True)
# 显式参数才更新发现配置；自动发现不重写用户的 CRLF/多行配置。
print('研究目录：'+str(home)+'（新建 '+str(created)+' 个文件，已有文档未动）')
print('下一步：填写 '+str(home/'PROJECT.md')+'；工具入口 python3 '+str(home/'tools/rk.py'))
PY
if [ -n "${2:-}" ] && [ "$2" != research ]; then
  mkdir -p "$proj/.claude"
  printf '%s\n' "$2" > "$proj/.claude/research-home"
fi
