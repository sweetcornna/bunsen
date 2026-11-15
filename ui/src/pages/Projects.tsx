import { FolderGit2, GitMerge, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { Badge, Button, Confirm, Dialog, Dot, Empty, EmptyLine, Field, ICON, IconButton, Loading, Menu, Notice, Page, Row, Section, Segmented, Spinner, Table, Toggle, When } from "../components/ui";
import { api, asApiError, type ApiError, type MemberSync, type ProjectLine, type ProjectMachine, type ProjectMember, type ProjectRun, type ProjectView } from "../lib/api";
import { fmtWhen, maskUserinfo, sessionState } from "../lib/format";
import { go, projectHref, sessionHref } from "../lib/route";
import { BRANCH_RULE, branchProblem, defaultBranch, homeProblem, hubProblem, nameProblem, normalizeHome, trimName } from "../lib/projectRules";
import { runKind, runStatus } from "../lib/research";
import { findProject, hubServer, projectOf, skipWhy, syncSkipped, useApp } from "../lib/store";

/** 研究项目列表。一个项目是一个汇合点（git 远程）加一条研究分支；几台机器各写各的 sync 分支，经研究分支汇合。 */
export function Projects() {
  const projects = useApp((s) => s.projects);
  const ready = useApp((s) => s.projectsReady);
  const loadError = useApp((s) => s.projectsError);
  const sessions = useApp((s) => s.sessions);
  const [adding, setAdding] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    void useApp.getState().loadProjects();
  }, []);

  const retry = async () => {
    setRetrying(true);
    await useApp.getState().loadProjects();
    setRetrying(false);
  };

  const empty = ready && !loadError && projects.length === 0;
  return (
    <Page
      title="研究项目"
      data-page="projects"
      actions={
        // 没有项目时主动作在空状态里，页头的这个降为 secondary（每页最多一个 primary）
        <Button variant={empty ? "secondary" : "primary"} icon={<Plus size={ICON.md} />} onClick={() => setAdding(true)}>
          新建项目
        </Button>
      }
    >
      {loadError && projects.length === 0 ? (
        <Empty icon={<FolderGit2 size={ICON.lg} />} title={`取不到研究项目：${loadError.message}`} hint={loadError.hint}>
          <Button loading={retrying} onClick={() => void retry()}>
            重试
          </Button>
        </Empty>
      ) : !ready ? (
        <Loading />
      ) : projects.length === 0 ? (
        <Empty icon={<FolderGit2 size={ICON.lg} />} title="还没有研究项目" hint="同一个研究项目可以同时在本机和几台服务器上推进：各台机器的记录经汇合点（一个 git 远程）自动汇合，在这里看到合并后的全貌。">
          <Button variant="primary" size="lg" icon={<Plus size={ICON.md} />} onClick={() => setAdding(true)}>
            新建项目
          </Button>
        </Empty>
      ) : (
        <>
          {loadError && (
            <Notice
              tone="err"
              hint={loadError.hint}
              action={
                <Button size="sm" loading={retrying} onClick={() => void retry()}>
                  重试
                </Button>
              }
            >
              取不到最新的项目列表，下面是上次取到的：{loadError.message}
            </Notice>
          )}
          <div className="card-list">
            {projects.map((p) => {
              const members = sessions.filter((s) => s.project_id === p.id && !s.archived).length;
              return (
                <a key={p.id} className="surface-card project-card" href={projectHref(p.id)} data-project={p.id}>
                  <div className="card-head">
                    <span className="card-name">{p.name}</span>
                    <Badge mono>{p.branch}</Badge>
                    {p.fetch_error && <Badge tone="err">汇合点连不上</Badge>}
                  </div>
                  <div className="card-addr mono" title={maskUserinfo(p.hub)}>
                    {maskUserinfo(p.hub)}
                  </div>
                  <div className="card-meta muted">
                    {members > 0 ? `${members} 个对话接入` : "还没有对话接入"}
                    {" · "}
                    {p.fetched_at ? <When iso={p.fetched_at} suffix=" 取过汇合点" /> : "还没取过汇合点"}
                  </div>
                </a>
              );
            })}
          </div>
        </>
      )}
      {adding && <ProjectForm onClose={() => setAdding(false)} />}
    </Page>
  );
}

function ProjectForm({ onClose }: { onClose: () => void }) {
  const servers = useApp((s) => s.servers);
  const setProject = useApp((s) => s.setProject);
  const [f, setF] = useState({ name: "", hub: "", branch: "", home: "research" });
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);
  // 保存中不能关对话框；页面被别的方式换走（例如 ⌘N）时 mounted 为假，建好后只进列表、不再跳转。
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));

  // 汇合点写成 <别名>:<路径> 且别名是 Bunsen 里的一台服务器（或本机）：可以顺手在那里建裸仓库。
  const at = useMemo(() => hubServer(f.hub, servers), [f.hub, servers]);
  const where = at ? (at.local ? "本机上" : `${at.alias} 上`) : "";
  // 汇合点、研究目录和服务端一样不去空白，原样校验、原样送出；研究目录留空表示用缺省的 research。
  const name = trimName(f.name);
  const hub = f.hub;
  const branch = f.branch.trim();
  const home = f.home;
  const nameErr = nameProblem(f.name, true);
  const hubErr = hubProblem(hub, true);
  const branchErr = branch ? branchProblem(branch) : null;
  const homeErr = home ? homeProblem(home) : null;
  const homeSaved = home && !homeErr ? normalizeHome(home) : null;
  const valid = name.length > 0 && !nameErr && hub.length > 0 && !hubErr && !branchErr && !homeErr;
  const branchHint = !branch
    ? `留空：汇合点上唯一的 research/*，没有就${name ? `用 ${defaultBranch(name)}` : "按名称起"}`
    : branchErr
      ? `${branchErr}。${BRANCH_RULE}`
      : BRANCH_RULE;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.addProject({
        name,
        hub,
        branch: branch || undefined,
        home: home || undefined,
        create: Boolean(at) && create,
      });
      setProject(p);
      if (!mounted.current) return;
      onClose();
      go(`/p/${p.id}`);
    } catch (e) {
      const err = asApiError(e);
      setError({ message: err.message, hint: err.hint });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      // 关闭按钮、Esc、点遮罩都走这里：保存中一律不关。
      onOpenChange={(v) => !v && !busy && onClose()}
      title="新建研究项目"
      description="汇合点是几台机器都能推送的 git 仓库：私有 GitHub 仓库最省事；也可以是某台服务器上的裸仓库（写成 别名:路径）。"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void save()}>
            建立并取汇合点
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="名称" className="wide" hint={nameErr ?? "最多 40 个字符，不能含 /"}>
          <input className="input" aria-invalid={Boolean(nameErr)} value={f.name} onChange={set("name")} placeholder="长尾分类的标签平滑" disabled={busy} />
        </Field>
        <Field label="汇合点" className="wide" hint={hubErr ?? (at ? `${where}的裸仓库` : undefined)}>
          <input className="input mono" aria-invalid={Boolean(hubErr)} value={f.hub} onChange={set("hub")} placeholder="git@github.com:you/proj.git" spellCheck={false} disabled={busy} />
        </Field>
        <Field label="研究分支（可选）" hint={branchHint}>
          <input className="input mono" aria-invalid={Boolean(branchErr)} value={f.branch} onChange={set("branch")} placeholder="research/longtail" spellCheck={false} disabled={busy} />
        </Field>
        <Field label="研究目录" hint={homeErr ?? (!home ? "留空用 research" : homeSaved !== home ? `会存成 ${homeSaved}` : "仓库里的相对路径")}>
          <input className="input mono" aria-invalid={Boolean(homeErr)} value={f.home} onChange={set("home")} spellCheck={false} disabled={busy} />
        </Field>
      </div>
      {at && (
        <div className="stack">
          <Toggle checked={create} onChange={setCreate} label={`${where}还没有这个仓库时，新建一个空的裸仓库`} disabled={busy} />
          <div className="field-hint">
            {at.local
              ? "汇合点在本机时，只有本机的对话能接入；要让服务器也接入，改用 GitHub 这类各处都能访问的仓库。"
              : `汇合点在 ${at.alias} 上时，只有 ${at.alias} 自己和本机能接入；别的服务器要接入就改用 GitHub 这类各处都能访问的仓库。`}
          </div>
        </div>
      )}
      {error && (
        <Notice tone="err" hint={error.hint}>
          {error.message}
        </Notice>
      )}
    </Dialog>
  );
}

/** 一个研究项目的统一视图：各台机器、研究线、运行，都从汇合点读出。 */
export function ProjectPage({ id }: { id: string }) {
  // 地址里的 id 可以是项目 id 或名称：先按 id 找，找不到再按名称【G8】。
  const known = useApp((s) => findProject(s.projects, id));
  const dropProject = useApp((s) => s.dropProject);
  const setDraft = useApp((s) => s.setDraft);
  const fail = useApp((s) => s.fail);
  const toast = useApp((s) => s.toast);
  const [view, setView] = useState<ProjectView | null>(null);
  // local：前端自己拦下的“找不到”（地址里的名称拼不进路径），列表认得这个名称之后会按 id 再取一次。
  const [error, setError] = useState<{ message: string; hint: string | null; missing: boolean; local?: boolean } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState<{ message: string; hint: string | null } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const p = view?.project ?? known;
  const pid = p?.id;
  // “立即同步”的进度和结果在 store 里：离开页面再回来照常显示，完成时不在这一页也会有提示。
  const sync = useApp((s) => (pid ? s.syncs[pid] : undefined));
  const syncing = sync?.running ?? false;
  // 这次同步跳过的成员会话（所在服务器已删除或本机已停用）：和同步了的一起列在结果里。
  const skipped = sync?.members && sync.view ? syncSkipped(sync.members, sync.view) : [];
  const busy = refreshing || syncing || deleting;
  const missing = error?.missing ?? false;
  // 视图请求编号：只接受最新一次的结果。alive：页面还开着；dropping：项目正在删除或已删除。
  // 页面关了或项目删了之后迟到的响应一律丢掉，免得旧视图盖掉新视图、或把刚删掉的项目又加回列表。
  const seq = useRef(0);
  const alive = useRef(true);
  const dropping = useRef(false);
  const lastLoad = useRef(0);
  const mountedAt = useRef(Date.now());
  const seenSync = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 找不到这个项目：页面换成“没有这个研究项目”，和首次加载就找不到时一样。只有服务端回的 404（在别处删了）才从列表里
  // 去掉请求的那个项目；前端自己拦下的（地址是 . 或 ..，status 0）不动列表，免得把一个还在的项目当成已删除。
  const lost = useCallback((err: ApiError, target: string) => {
    const st = useApp.getState();
    if (err.status === 404 && projectOf(st.projects, target)) st.dropProject(target);
    setView(null);
    setError({ message: err.message, hint: err.hint, missing: true, local: err.status === 0 });
  }, []);

  const load = useCallback(
    async (refresh: boolean) => {
      const n = ++seq.current;
      lastLoad.current = Date.now();
      // 列表里认得这个 id 或名称时按项目 id 请求（名称可能是 . 或 .. 这类拼不进路径的旧名称）。
      const target = findProject(useApp.getState().projects, id)?.id ?? id;
      try {
        const v = await api.projectView(target, refresh);
        if (!alive.current || dropping.current || n !== seq.current) return;
        setView(v);
        setError(null);
        useApp.getState().setProject(v.project);
      } catch (e) {
        if (!alive.current || dropping.current || n !== seq.current) return;
        const err = asApiError(e);
        if (err.code === "not_found") lost(err, target);
        else setError({ message: err.message, hint: err.hint, missing: false });
      }
    },
    [id, lost],
  );

  useEffect(() => {
    setView(null);
    void load(false);
  }, [load]);

  // 名称拼不进路径、当时列表里又还没有它：列表认得之后按项目 id 再取一次。
  useEffect(() => {
    if (error?.local && known) void load(false);
  }, [error?.local, known?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 页面开着时每分钟看一次（服务端 20 秒内不重复取汇合点）；切回这个标签页时，距上次超过 20 秒就马上看一次。
  // 刷新、同步、删除进行中，或者已经知道没有这个项目时都不看。
  useEffect(() => {
    if (busy || missing) return;
    const t = window.setInterval(() => !document.hidden && void load(false), 60_000);
    const onShow = () => {
      if (!document.hidden && Date.now() - lastLoad.current > 20_000) void load(false);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [load, busy, missing]);

  // 打开页面之后完成的同步：用它带回来的视图（之前发出、还没回来的视图请求作废）；服务端说没有这个项目时同上。
  useEffect(() => {
    if (!sync || sync.running || sync.at <= mountedAt.current || sync.at <= seenSync.current) return;
    seenSync.current = sync.at;
    if (!alive.current || dropping.current) return;
    if (sync.view) {
      seq.current++;
      lastLoad.current = sync.at;
      setView(sync.view);
      setError(null);
    } else if (sync.error?.code === "not_found" && pid) {
      lost(sync.error, pid);
    }
  }, [sync, lost, pid]);

  const refresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  // 删除要等这个项目的镜像空闲（契约第 6 节【G17】的文件锁），正在取汇合点时可能要一两分钟：期间页面只读。
  const remove = (target: string, name: string) => {
    dropping.current = true;
    setDeleting(true);
    setDelError(null);
    const done = () => {
      dropProject(target);
      if (alive.current) go("/projects");
      else toast("ok", `已删除研究项目 ${name}`);
    };
    void api
      .deleteProject(target)
      .then(done)
      .catch((e: unknown) => {
        const err = asApiError(e);
        if (err.code === "not_found" && err.status === 404) return done(); // 已经在别处删掉了
        dropping.current = false;
        if (!alive.current) return fail(err);
        setDeleting(false);
        setDelError({ message: err.message, hint: err.hint });
        void load(false); // 删除期间的视图响应都丢掉了，重新取一次
      });
  };

  if (error && !view) {
    return (
      <div className="page center">
        <Empty icon={<FolderGit2 size={ICON.lg} />} title={error.missing ? "没有这个研究项目" : error.message} hint={error.missing ? "它可能已经被删除。回到项目列表看看。" : error.hint}>
          {!error.missing && <Button onClick={() => void load(false)}>重试</Button>}
          <Button variant={error.missing ? "secondary" : "ghost"} onClick={() => go("/projects")}>
            回到项目列表
          </Button>
        </Empty>
      </div>
    );
  }

  const hubDown = Boolean(view?.project.fetch_error ?? p?.fetch_error);
  const split = view ? splitWarnings(view) : null;
  return (
    <Page
      data-page="project"
      title={p?.name ?? "研究项目"}
      sub={
        p && (
          <>
            <span className="mono">
              {maskUserinfo(p.hub)} · {p.branch}
              {view?.research_head && ` @ ${view.research_head.slice(0, 8)}`}
            </span>
            {p.fetched_at && (
              <>
                {" · "}
                <When iso={p.fetched_at} suffix=" 取过" />
              </>
            )}
          </>
        )
      }
      actions={
        <>
          <Button icon={<RefreshCw size={ICON.md} />} loading={refreshing} disabled={busy} onClick={() => void refresh()} title="重新取一次汇合点">
            刷新
          </Button>
          <Button icon={<GitMerge size={ICON.md} />} loading={syncing} disabled={!pid || busy} onClick={() => pid && void useApp.getState().syncProject(pid)} title="在每个接入的对话里执行 rk sync，再重新取汇合点">
            {syncing ? "同步中…" : "立即同步"}
          </Button>
          {/* 带上之前存下的预填（例如去管理项目之前写了一半的提示词） */}
          <Button variant="primary" disabled={!p || deleting} onClick={() => p && (setDraft({ ...useApp.getState().draft, project_id: p.id }), go("/"))}>
            新对话
          </Button>
          <Menu
            trigger={
              <IconButton label="更多" disabled={deleting}>
                <MoreHorizontal size={ICON.md} />
              </IconButton>
            }
            // 同步进行中不能删：删完同步回来只会得到“找不到项目”
            items={[{ label: syncing ? "删除项目（同步完成后才能删）" : "删除项目", icon: <Trash2 size={ICON.md} />, danger: true, disabled: !p || deleting || syncing, onSelect: () => setConfirmDel(true) }]}
          />
        </>
      }
    >
      {deleting && <Notice icon={<Spinner size={ICON.md} />}>正在删除项目…要等本机的汇合点镜像空闲，正在取汇合点时可能要一两分钟。</Notice>}
      {delError && (
        <Notice tone="err" hint={delError.hint}>
          删除没有完成：{delError.message}
        </Notice>
      )}

      {!view || !split ? (
        <Loading />
      ) : (
        <>
          {hubDown && (
            <Notice tone="err" raw={view.project.fetch_error} data-hub-down="" hint={view.project.fetched_at ? <>下面是 <When iso={view.project.fetched_at} /> 取到的内容。</> : "还没有成功取得过汇合点，下面暂时是空的。"}>
              汇合点连不上
            </Notice>
          )}
          <ProjectNotices items={split.top} error={error} />
          {pid && sync?.members && sync.members.length + skipped.length > 0 && <SyncResults members={sync.members} skipped={skipped} at={sync.at} view={view} onClose={() => useApp.getState().clearSync(pid)} />}
          <div className="sections">
            {view.decisions && (
              <Section title="需要你决定" data-section="decisions">
                {/* 内容来自汇合点：图片不自动加载（会请求外部地址），只给链接 */}
                <Markdown text={view.decisions} images="link" />
              </Section>
            )}
            <MachinesCard view={view} stale={split.stale} hubDown={hubDown} />
            <LinesCard view={view} hubDown={hubDown} />
            <RunsCard runs={view.runs} hubDown={hubDown} />
            <MembersCard view={view} />
          </div>
        </>
      )}
      <Confirm
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`删除项目 ${p?.name ?? ""}？`}
        body="只删除 Bunsen 里的项目记录和本机的只读镜像。汇合点和各台机器上的仓库都不动，接入过的对话照常运行。"
        confirmLabel="删除"
        danger
        onConfirm={() => p && remove(p.id, p.name)}
      />
    </Page>
  );
}

/**
 * 服务端的警告分两类（设计稿 5.3）：
 * - 有归属行的，只在那一行显示，顶部不重复：某台机器“并入会冲突”“N 小时没有同步”（机器表）、某个会话“还没有机器代号”（接入的对话）、
 *   研究分支上未关闭的核对问题和没核过的结论文件（研究线表的两列，合计写在研究线区块标题旁）；
 * - 汇合点取不到另有“汇合点连不上”一条（原始报错折叠），这时“汇合点上还没有研究分支”也不再单列。
 * 其余是项目级的，顶部合成一条“N 条需要处理”。
 */
function splitWarnings(view: ProjectView): { top: string[]; stale: Map<string, string> } {
  const codes = new Set(view.machines.map((m) => m.code));
  const conflicts = new Set(view.machines.filter((m) => m.conflict).map((m) => m.code));
  const titles = new Set(view.members.filter((m) => !m.machine).map((m) => m.title));
  const hubDown = Boolean(view.project.fetch_error);
  const stale = new Map<string, string>();
  const top: string[] = [];
  for (const w of view.warnings) {
    if (w.startsWith("取不到汇合点：")) continue;
    if (hubDown && w.startsWith("汇合点上还没有 ")) continue;
    const conflict = /^(\S+) 的记录并入 .* 会冲突/.exec(w);
    if (conflict && conflicts.has(conflict[1])) continue;
    const late = /^(\S+) 已经 (\d+) 小时没有同步$/.exec(w);
    if (late && codes.has(late[1])) {
      stale.set(late[1], `${late[2]} 小时没有同步`);
      continue;
    }
    const noCode = /^会话 (.+) 还没有机器代号/.exec(w);
    if (noCode && titles.has(noCode[1])) continue;
    if (/^研究分支上有 \d+ 个未关闭的核对问题、\d+ 个结论文件还没核过$/.test(w) && view.lines.length > 0) continue;
    top.push(w);
  }
  return { top, stale };
}

/** 顶部的项目级问题：一条 Notice“N 条需要处理”，先显示前 2 条、其余折起；有出错时用 err，否则 warn。 */
function ProjectNotices({ items, error }: { items: string[]; error: { message: string; hint: string | null } | null }) {
  const [all, setAll] = useState(false);
  if (items.length === 0 && !error) return null;
  const list = error ? [`${error.message}${error.hint ? `（${error.hint}）` : ""}`, ...items] : items;
  const shown = all ? list : list.slice(0, 2);
  return (
    <Notice
      tone={error ? "err" : "warn"}
      data-project-notice=""
      action={
        list.length > 2 && (
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? "收起" : `另 ${list.length - 2} 条`}
          </Button>
        )
      }
    >
      {list.length === 1 ? (
        list[0]
      ) : (
        <>
          <div className="fw-medium">{list.length} 条需要处理</div>
          <ul className="issue-list">
            {shown.map((w, i) => (
              <li key={`${i}:${w}`}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </Notice>
  );
}

function SyncResults({ members, skipped, at, view, onClose }: { members: MemberSync[]; skipped: ProjectMember[]; at: number; view: ProjectView; onClose: () => void }) {
  // 同一台服务器上可能有几个对话，按标题区分【修订 A3】；旧版服务端没有 title，用视图里的成员补上。
  const titleOf = (m: MemberSync) => m.title || view.members.find((x) => x.session_id === m.session_id)?.title || m.session_id;
  return (
    <Section
      title="同步结果"
      data-section="sync"
      count={<When iso={at} suffix=" 完成" />}
      end={
        <Button size="sm" variant="ghost" onClick={onClose}>
          收起
        </Button>
      }
    >
      <div className="list">
        {members.map((m) => (
          <Row
            key={m.session_id}
            href={sessionHref(m.session_id)}
            name={
              <>
                {titleOf(m)} <span className="muted">{m.server_alias}</span>
              </>
            }
            meta={<span className={m.ok ? undefined : "tone-err"}>{m.ok ? m.detail || "完成" : `没完成：${m.detail}`}</span>}
            title={m.detail || undefined}
          />
        ))}
        {skipped.map((m) => (
          <Row
            key={m.session_id}
            href={sessionHref(m.session_id)}
            name={
              <>
                {m.title || m.session_id} <span className="muted">{m.server_alias}</span>
              </>
            }
            meta={`跳过：${skipWhy(m)}，不参与同步`}
          />
        ))}
      </div>
    </Section>
  );
}

/** 机器的汇合状态：已汇合、待并入、落后都是正常流转，用中性字；并入会冲突 err；很久没同步 warn。一行只有一个上色的字。 */
function machineState(m: ProjectMachine, stale: string | undefined): { cls?: string; label: string; extra?: string } {
  const lag = m.ahead > 0 && m.behind > 0 && !m.conflict ? `也落后 ${m.behind}` : undefined;
  if (m.conflict) return { cls: "tone-err", label: "并入会冲突", extra: [lag, stale].filter(Boolean).join(" · ") || undefined };
  if (stale) return { cls: "tone-warn", label: stale, extra: m.ahead > 0 ? `${m.ahead} 个提交待并入` : m.behind > 0 ? `落后 ${m.behind}` : undefined };
  if (m.ahead > 0) return { label: `${m.ahead} 个提交待并入`, extra: lag };
  if (m.behind > 0) return { cls: "muted", label: `落后 ${m.behind}` };
  return { label: "已汇合" };
}

function MachinesCard({ view, stale, hubDown }: { view: ProjectView; stale: Map<string, string>; hubDown: boolean }) {
  return (
    <Section title="机器" count={view.machines.length} data-section="machines">
      {view.machines.length === 0 ? (
        <EmptyLine>{hubDown ? "汇合点连不上，列不出机器。" : "汇合点上还没有任何机器的 sync 分支。部署一个接入本项目的对话，或在仓库里执行 rk sync --setup。"}</EmptyLine>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className="shrink">代号</th>
              <th className="shrink">服务器</th>
              <th>最新提交</th>
              <th className="shrink">状态</th>
            </tr>
          </thead>
          <tbody>
            {view.machines.map((m) => {
              const st = machineState(m, stale.get(m.code));
              return (
                <tr key={m.code} data-machine={m.code}>
                  <td className="mono nowrap">{m.code}</td>
                  <td className="nowrap">
                    {m.server_alias ? (
                      m.sessions.length > 0 ? (
                        <a href={sessionHref(m.sessions[0])} title={`${m.sessions.length} 个对话`}>
                          {m.server_alias}
                        </a>
                      ) : (
                        m.server_alias
                      )
                    ) : (
                      <span className="muted" title="Bunsen 里没有用这个代号的对话">
                        —
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="ellipsis" title={m.subject}>
                      {m.subject || <span className="muted">（没有说明）</span>}
                    </div>
                    <div className="muted t-meta">
                      <span className="mono">{m.head.slice(0, 8)}</span>
                      {m.committed_at && (
                        <>
                          {" · "}
                          <When iso={m.committed_at} />
                        </>
                      )}
                    </div>
                  </td>
                  <td className="nowrap">
                    <div className={st.cls}>{st.label}</div>
                    {st.extra && <div className="muted t-meta">{st.extra}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

/**
 * 研究线不取自研究分支时为什么取这一份（契约第 4 节）：编号大的为准；编号相同时以推进者自己分支上的那份为准（它最新）。
 * 取自推进者自己的 sync 分支时，可能编号更大，也可能编号相同、内容一样，所以只说是“推进者自己分支上的那份”。
 */
function lineSourceWhy(l: ProjectLine): string {
  const rule = "研究线取编号最大的一份，编号相同时取推进者自己分支上的那份";
  if (l.holder && l.source === `sync/${l.holder}`) return `显示的是推进者自己分支上的那份（${rule}）`;
  return `显示的是 ${l.source} 上的那份，它的编号最大（${rule}）`;
}

// 研究线的两个数：研究分支上的 rk.py 旧于 0.6.0 时为 null（没算，契约 Q10），旧版服务端没有这两个字段；都显示“—”，不当成没有问题。
// 未关闭问题大于 0 时是这一行唯一上色的字；未核文件用中性字。
function Count({ n, err }: { n: number | null | undefined; err?: boolean }) {
  if (typeof n !== "number")
    return (
      <span className="muted" title="研究分支上的研究工具旧于 0.6.0，没有核对记录可数">
        —
      </span>
    );
  return <span className={n > 0 ? (err ? "tone-err" : undefined) : "muted"}>{n}</span>;
}

/** 模板占位（“<无 | 运行 ID …>”这类没填的尖括号）不当内容显示。 */
const unfilled = (s: string | null | undefined) => !s || /^<[^>]*>$/.test(s.trim());

function LinesCard({ view, hubDown }: { view: ProjectView; hubDown: boolean }) {
  const branch = view.project.branch;
  const t = view.trust;
  return (
    <Section
      title="研究线"
      count={view.lines.length}
      data-section="lines"
      end={t && (t.open_fails > 0 || t.unreviewed > 0) ? <span className="muted t-meta" data-lines-total="">研究分支合计 {t.open_fails} 个未关闭问题 · {t.unreviewed} 个未核文件</span> : undefined}
    >
      {view.lines.length === 0 ? (
        <EmptyLine>{hubDown ? "汇合点连不上，列不出研究线。" : "还没有研究线：在接入的对话里 rk line new <线>。"}</EmptyLine>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className="shrink">线</th>
              <th className="shrink">推进者</th>
              <th>阶段</th>
              <th>在等什么</th>
              <th>下一步</th>
              <th className="num shrink" title="未关闭的核对问题">
                问题
              </th>
              <th className="num shrink" title="没核过的结论文件">
                未核
              </th>
            </tr>
          </thead>
          <tbody>
            {view.lines.map((l) => {
              const next = l.next.map((n) => n.replace(/^\s*(\d+\.|[-*])\s+(\[[ xX]\]\s+)?/, "")).filter((n) => !unfilled(n));
              return (
                <tr key={l.line} data-line={l.line}>
                  <td className="nowrap">
                    <span className="mono fw-medium">{l.line}</span>
                    {l.source !== branch && (
                      <div className="muted t-meta" title={lineSourceWhy(l)}>
                        取自 <span className="mono">{l.source}</span>
                      </div>
                    )}
                  </td>
                  <td className="mono nowrap">
                    {l.holder ?? <span className="muted sans">无人持有</span>}
                    <span className="muted"> #{l.token}</span>
                  </td>
                  <td>{unfilled(l.stage) ? <span className="muted">—</span> : l.stage}</td>
                  <td>{unfilled(l.waiting) ? <span className="muted">—</span> : l.waiting}</td>
                  <td>
                    {next.length > 0 ? (
                      <ul className="next-list">
                        {next.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted">—</span>
                    )}
                    {l.updated && <div className="muted t-meta">更新于 {fmtWhen(l.updated) || l.updated}</div>}
                  </td>
                  <td className="num">
                    <Count n={l.open_fails} err />
                  </td>
                  <td className="num">
                    <Count n={l.unreviewed} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Section>
  );
}

type RunFilter = "all" | "open" | "failed" | "pending";
type RunFilterDef = { id: RunFilter; label: string; test: (r: ProjectRun) => boolean };
const ALL_RUNS: RunFilterDef = { id: "all", label: "全部", test: () => true };
const RUN_FILTERS: RunFilterDef[] = [
  ALL_RUNS,
  { id: "open", label: "进行中", test: (r) => r.state === "open" },
  { id: "failed", label: "失败", test: (r) => r.state === "failed" },
  { id: "pending", label: "未进研究分支", test: (r) => !r.integrated },
];

function RunsCard({ runs, hubDown }: { runs: ProjectRun[]; hubDown: boolean }) {
  const [all, setAll] = useState(false);
  const [chosen, setFilter] = useState<RunFilter>("all");
  // 选中的那一类刷新后变成 0 条（例如进行中的都跑完了）：回到“全部”。
  const want = RUN_FILTERS.find((f) => f.id === chosen) ?? ALL_RUNS;
  const current = runs.some(want.test) ? want : ALL_RUNS;
  const filter = current.id;
  useEffect(() => {
    if (chosen !== filter) setFilter(filter);
  }, [chosen, filter]);
  const picked = runs.filter(current.test);
  const shown = all ? picked : picked.slice(0, 50);
  return (
    <Section
      title="运行"
      count={runs.length}
      data-section="runs"
      end={
        runs.length > 0 && (
          <Segmented<RunFilter>
            label="按状态筛选运行"
            value={filter}
            onChange={setFilter}
            options={RUN_FILTERS.map((f) => {
              const n = runs.filter(f.test).length;
              return { value: f.id, label: f.label, count: f.id === "all" ? null : n, disabled: n === 0 && f.id !== "all" };
            })}
          />
        )
      }
    >
      {runs.length === 0 ? (
        <EmptyLine>{hubDown ? "汇合点连不上，列不出运行。" : "还没有运行记录。"}</EmptyLine>
      ) : picked.length === 0 ? (
        <EmptyLine>没有这一类的运行。</EmptyLine>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>运行</th>
                <th className="shrink">机器</th>
                <th className="shrink">线</th>
                <th className="shrink">状态</th>
                <th className="shrink">开始</th>
                <th className="shrink">汇合</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                // 状态按第 4 节：成功是中性字，只有失败（err 字）和进行中（live 点）显眼。
                const st = runStatus(r.state === "open" ? "running" : r.state === "ok" ? "done" : r.state, r.exit_code);
                const kind = runKind(r.kind);
                return (
                  <tr key={r.run_id} data-run={r.run_id}>
                    <td>
                      <span className="mono nowrap">{r.run_id}</span>
                      <div className="muted ellipsis t-meta" title={r.note || undefined}>
                        {kind.label}
                        {r.note && ` · ${r.note}`}
                      </div>
                    </td>
                    <td className="mono nowrap">{r.machine ?? <span className="muted">—</span>}</td>
                    <td className="mono nowrap">{r.line ?? <span className="muted">—</span>}</td>
                    <td className="nowrap">
                      {st.kind === "live" && <Dot tone="live" label="进行中" />} <span className={st.kind === "failed" ? "tone-err" : undefined}>{st.label}</span>
                    </td>
                    <td className="muted nowrap">{r.started_at ? <When iso={r.started_at} /> : "—"}</td>
                    <td className="nowrap">{r.integrated ? <span className="muted">已进研究分支</span> : <span>只在 <span className="mono">{r.source}</span></span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {picked.length > shown.length && (
            <div className="table-foot">
              <Button size="sm" variant="ghost" data-more="" onClick={() => setAll(true)}>
                显示全部 {picked.length} 条
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function MembersCard({ view }: { view: ProjectView }) {
  return (
    <Section title="接入的对话" count={view.members.length} data-section="members">
      {view.members.length === 0 ? (
        <EmptyLine>还没有。点“新对话”在本机或某台服务器上接入这个项目。</EmptyLine>
      ) : (
        <div className="list">
          {view.members.map((m) => {
            const st = sessionState(m.state);
            // 一行只有一个上色的元素：连不上（err 点）优先；没有机器代号（warn 徽标）时不再画运行中的点
            const dot = st.dot === "err" || (st.dot === "live" && m.machine) ? st.dot : null;
            return (
              <Row
                key={m.session_id}
                href={sessionHref(m.session_id)}
                data-member={m.session_id}
                title={`${m.title}\n${st.label} · ${m.server_alias}:${m.workdir}`}
                lead={dot ? <Dot tone={dot} label={st.label} /> : <span />}
                name={
                  <>
                    {m.title} <span className="muted">{m.server_alias}</span> <span className="mono muted t-meta">{m.workdir}</span>
                  </>
                }
                meta={m.machine ? <Badge mono>{m.machine}</Badge> : <Badge tone={dot === "err" ? "neutral" : "warn"}>还没有机器代号</Badge>}
              />
            );
          })}
        </div>
      )}
    </Section>
  );
}
