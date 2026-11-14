import { FolderGit2, GitMerge, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { Button, Confirm, cx, Empty, Field, Menu, Modal, Pill, Spinner, Toggle, type Tone } from "../components/ui";
import { api, asApiError, type ApiError, type MemberSync, type ProjectLine, type ProjectMachine, type ProjectMember, type ProjectRun, type ProjectView } from "../lib/api";
import { fullTime, hasKey, maskUserinfo, relTime, sessionState } from "../lib/format";
import { go, projectHref, sessionHref } from "../lib/route";
import { BRANCH_RULE, branchProblem, defaultBranch, homeProblem, hubProblem, nameProblem, normalizeHome, trimName } from "../lib/projectRules";
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

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <div>
            <h1>研究项目</h1>
          </div>
          <Button icon={<Plus size={13} />} onClick={() => setAdding(true)}>
            新建项目
          </Button>
        </header>

        {loadError && projects.length === 0 ? (
          <Empty icon={<FolderGit2 size={22} />} title={`取不到研究项目：${loadError.message}`} hint={loadError.hint}>
            <Button loading={retrying} onClick={() => void retry()}>
              重试
            </Button>
          </Empty>
        ) : !ready ? (
          <Empty title={<Spinner />} />
        ) : projects.length === 0 ? (
          <Empty icon={<FolderGit2 size={22} />} title="还没有研究项目" hint="同一个研究项目可以同时在本机和几台服务器上推进：各台机器的记录经汇合点（一个 git 远程）自动汇合，在这里看到合并后的全貌。">
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
              新建项目
            </Button>
          </Empty>
        ) : (
          <>
            {loadError && (
              <div className="note err with-action">
                <div>
                  取不到最新的项目列表，下面是上次取到的：{loadError.message}
                  {loadError.hint && <div className="dim">{loadError.hint}</div>}
                </div>
                <Button size="sm" loading={retrying} onClick={() => void retry()}>
                  重试
                </Button>
              </div>
            )}
            <div className="server-list">
              {projects.map((p) => {
                const members = sessions.filter((s) => s.project_id === p.id && !s.archived).length;
                return (
                  <a key={p.id} className="server-card project-card" href={projectHref(p.id)}>
                    <div className="server-name">
                      <b>{p.name}</b>
                      <span className="tag mono">{p.branch}</span>
                      {p.fetch_error && <Pill tone="err">取不到汇合点</Pill>}
                    </div>
                    <div className="server-sub mono ellipsis" title={maskUserinfo(p.hub)}>
                      {maskUserinfo(p.hub)}
                    </div>
                    <div className="dim project-card-foot">
                      <span>{members > 0 ? `${members} 个对话接入` : "还没有对话接入"}</span>
                      <span>{p.fetched_at ? `${relTime(p.fetched_at)}取过汇合点` : "还没取过汇合点"}</span>
                    </div>
                  </a>
                );
              })}
            </div>
          </>
        )}
      </div>
      {adding && <ProjectForm onClose={() => setAdding(false)} />}
    </div>
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
    <Modal
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
          <input className={cx("field", nameErr && "invalid")} value={f.name} onChange={set("name")} placeholder="长尾分类的标签平滑" autoFocus disabled={busy} />
        </Field>
        <Field label="汇合点" className="wide" hint={hubErr ?? (at ? `${where}的裸仓库` : undefined)}>
          <input className={cx("field mono", hubErr && "invalid")} value={f.hub} onChange={set("hub")} placeholder="git@github.com:you/proj.git" spellCheck={false} disabled={busy} />
        </Field>
        <Field label="研究分支（可选）" hint={branchHint}>
          <input className={cx("field mono", branchErr && "invalid")} value={f.branch} onChange={set("branch")} placeholder="research/longtail" spellCheck={false} disabled={busy} />
        </Field>
        <Field label="研究目录" hint={homeErr ?? (!home ? "留空用 research" : homeSaved !== home ? `会存成 ${homeSaved}` : "仓库里的相对路径")}>
          <input className={cx("field mono", homeErr && "invalid")} value={f.home} onChange={set("home")} spellCheck={false} disabled={busy} />
        </Field>
      </div>
      {at && (
        <div className="form-extra">
          <Toggle checked={create} onChange={setCreate} label={`${where}还没有这个仓库时，新建一个空的裸仓库`} disabled={busy} />
          <div className="dim">
            {at.local
              ? "汇合点在本机时，只有本机的对话能接入；要让服务器也接入，改用 GitHub 这类各处都能访问的仓库。"
              : `汇合点在 ${at.alias} 上时，只有 ${at.alias} 自己和本机能接入；别的服务器要接入就改用 GitHub 这类各处都能访问的仓库。`}
          </div>
        </div>
      )}
      {error && (
        <div className="note err">
          {error.message}
          {error.hint && <div className="dim">{error.hint}</div>}
        </div>
      )}
    </Modal>
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
        <Empty icon={<FolderGit2 size={22} />} title={error.missing ? "没有这个研究项目" : error.message} hint={error.missing ? "它可能已经被删除。" : error.hint}>
          {!error.missing && <Button onClick={() => void load(false)}>重试</Button>}
          <Button onClick={() => go("/projects")}>回到项目列表</Button>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <div className="project-title">
            <h1>{p?.name ?? "研究项目"}</h1>
            {p && (
              <div className="server-sub mono">
                {maskUserinfo(p.hub)} · {p.branch}
                {view?.research_head && <span className="dim"> @ {view.research_head.slice(0, 8)}</span>}
                <span className="dim sans">{p.fetched_at ? ` · ${relTime(p.fetched_at)}取过` : ""}</span>
              </div>
            )}
          </div>
          <div className="row">
            {/* 带上之前存下的预填（例如去管理项目之前写了一半的提示词） */}
            <Button size="sm" variant="primary" disabled={!p || deleting} onClick={() => p && (setDraft({ ...useApp.getState().draft, project_id: p.id }), go("/"))}>
              新对话
            </Button>
            <Button size="sm" icon={<RefreshCw size={12} />} loading={refreshing} disabled={busy} onClick={() => void refresh()} title="重新取一次汇合点">
              刷新
            </Button>
            <Button size="sm" icon={<GitMerge size={12} />} loading={syncing} disabled={!pid || busy} onClick={() => pid && void useApp.getState().syncProject(pid)} title="在每个接入的对话里执行 rk sync，再重新取汇合点">
              {syncing ? "同步中…" : "立即同步"}
            </Button>
            <Menu
              trigger={
                <button type="button" className="icon-btn" aria-label="更多" disabled={deleting}>
                  <MoreHorizontal size={15} />
                </button>
              }
              // 同步进行中不能删：删完同步回来只会得到“找不到项目”
              items={[{ label: syncing ? "删除项目（同步完成后才能删）" : "删除项目", icon: <Trash2 size={14} />, danger: true, disabled: !p || deleting || syncing, onSelect: () => setConfirmDel(true) }]}
            />
          </div>
        </header>

        {deleting && (
          <div className="note with-action">
            <div className="row">
              <Spinner size={13} />
              正在删除项目…要等本机的汇合点镜像空闲，正在取汇合点时可能要一两分钟。
            </div>
          </div>
        )}
        {delError && (
          <div className="note err with-action">
            <div>
              删除没有完成：{delError.message}
              {delError.hint && <div className="dim">{delError.hint}</div>}
            </div>
          </div>
        )}

        {!view ? (
          <Empty title={<Spinner />} />
        ) : (
          <>
            {(view.warnings.length > 0 || error) && (
              <div className="note-stack">
                {view.warnings.map((w, i) => (
                  <div key={`${i}:${w}`} className="note warn">
                    {w}
                  </div>
                ))}
                {error && (
                  <div className="note err">
                    {error.message}
                    {error.hint && <div className="dim">{error.hint}</div>}
                  </div>
                )}
              </div>
            )}
            {pid && sync?.members && sync.members.length + skipped.length > 0 && (
              <SyncResults members={sync.members} skipped={skipped} at={sync.at} view={view} onClose={() => useApp.getState().clearSync(pid)} />
            )}
            {view.decisions && (
              <section className="card">
                <h3>需要你决定</h3>
                {/* 内容来自汇合点：图片不自动加载（会请求外部地址），只给链接 */}
                <Markdown text={view.decisions} images="link" />
              </section>
            )}
            <MachinesCard view={view} />
            <LinesCard view={view} />
            <RunsCard runs={view.runs} />
            <MembersCard view={view} />
          </>
        )}
      </div>
      <Confirm
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`删除项目 ${p?.name ?? ""}？`}
        body="只删除 Bunsen 里的项目记录和本机的只读镜像。汇合点和各台机器上的仓库都不动，接入过的对话照常运行。"
        confirmLabel="删除"
        danger
        onConfirm={() => p && remove(p.id, p.name)}
      />
    </div>
  );
}

function SyncResults({ members, skipped, at, view, onClose }: { members: MemberSync[]; skipped: ProjectMember[]; at: number; view: ProjectView; onClose: () => void }) {
  // 同一台服务器上可能有几个对话，按标题区分【修订 A3】；旧版服务端没有 title，用视图里的成员补上。
  const titleOf = (m: MemberSync) => m.title || view.members.find((x) => x.session_id === m.session_id)?.title || m.session_id;
  const done = new Date(at).toISOString();
  return (
    <section className="card">
      <h3>
        同步结果
        <span className="dim" title={fullTime(done)}>
          {fullTime(done)} 完成
        </span>
        <span className="grow" />
        <button type="button" className="link-btn" onClick={onClose}>
          收起
        </button>
      </h3>
      <ul className="plain-list">
        {members.map((m) => (
          <li key={m.session_id}>
            <Pill tone={m.ok ? "ok" : "err"}>{m.ok ? "完成" : "没完成"}</Pill>
            <a href={sessionHref(m.session_id)}>{titleOf(m)}</a>
            <span className="dim">{m.server_alias}</span>
            <span className={m.ok ? "dim" : "c-err"}>{m.detail}</span>
          </li>
        ))}
        {skipped.map((m) => (
          <li key={m.session_id}>
            <Pill tone="mute">跳过</Pill>
            <a href={sessionHref(m.session_id)}>{m.title || m.session_id}</a>
            <span className="dim">{m.server_alias}</span>
            <span className="dim">{skipWhy(m)}，不参与同步</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function machineState(m: ProjectMachine): { tone: Tone; label: string } {
  if (m.conflict) return { tone: "err", label: "并入会冲突" };
  if (m.ahead > 0) return { tone: "warn", label: `${m.ahead} 个提交待并入` };
  if (m.behind > 0) return { tone: "mute", label: `落后 ${m.behind}` };
  return { tone: "ok", label: "已汇合" };
}

function MachinesCard({ view }: { view: ProjectView }) {
  return (
    <section className="card flush">
      <h3>
        机器
        <span className="dim">{view.machines.length}</span>
      </h3>
      {view.machines.length === 0 ? (
        <div className="card-hint">汇合点上还没有任何机器的 sync 分支。部署一个接入本项目的对话，或在仓库里执行 rk sync --setup。</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>代号</th>
                <th>服务器</th>
                <th>最新提交</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {view.machines.map((m) => {
                const st = machineState(m);
                return (
                  <tr key={m.code}>
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
                        <span className="dim" title="Bunsen 里没有用这个代号的对话">
                          —
                        </span>
                      )}
                    </td>
                    <td className="cell-text">
                      <div className="ellipsis" title={m.subject}>
                        {m.subject || <span className="dim">（没有说明）</span>}
                      </div>
                      <div className="dim mono" title={fullTime(m.committed_at)}>
                        {m.head.slice(0, 8)}
                        {m.committed_at && <span className="sans"> · {relTime(m.committed_at)}</span>}
                      </div>
                    </td>
                    <td className="nowrap">
                      <Pill tone={st.tone}>{st.label}</Pill>
                      {m.ahead > 0 && m.behind > 0 && !m.conflict && <div className="dim">也落后 {m.behind}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
// 项目整体的数字体现在警告里，视图顶部不另设摘要（Q11）。
function Count({ n, tone }: { n: number | null | undefined; tone: Tone }) {
  if (typeof n !== "number")
    return (
      <span className="dim" title="研究分支上的研究工具旧于 0.6.0，没有核对记录可数">
        —
      </span>
    );
  return <span className={n > 0 ? `c-${tone}` : "dim"}>{n}</span>;
}

function LinesCard({ view }: { view: ProjectView }) {
  const branch = view.project.branch;
  return (
    <section className="card flush">
      <h3>
        研究线
        <span className="dim">{view.lines.length}</span>
      </h3>
      {view.lines.length === 0 ? (
        <div className="card-hint">还没有研究线：在接入的对话里 rk line new &lt;线&gt;。</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>线</th>
                <th>推进者</th>
                <th>阶段</th>
                <th>在等什么</th>
                <th>下一步</th>
                <th className="num tight">
                  未关闭
                  <br />
                  问题
                </th>
                <th className="num tight">
                  未核
                  <br />
                  文件
                </th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((l) => (
                <tr key={l.line}>
                  <td className="nowrap">
                    <b className="mono">{l.line}</b>
                    {l.source !== branch && (
                      <div>
                        <span className="tag" title={lineSourceWhy(l)}>
                          取自 {l.source}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="mono nowrap">
                    {l.holder ?? <span className="dim sans">无人持有</span>}
                    <span className="dim"> #{l.token}</span>
                  </td>
                  <td className="cell-text">{l.stage ?? <span className="dim">—</span>}</td>
                  <td className="cell-text">{l.waiting ?? <span className="dim">—</span>}</td>
                  <td>
                    {l.next.length > 0 ? (
                      <ul className="next-list">
                        {l.next.map((n, i) => (
                          <li key={i}>{n.replace(/^\s*(\d+\.|[-*])\s+(\[[ xX]\]\s+)?/, "")}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="dim">—</span>
                    )}
                    {l.updated && <div className="dim">更新于 {l.updated}</div>}
                  </td>
                  <td className="num tight">
                    <Count n={l.open_fails} tone="err" />
                  </td>
                  <td className="num tight">
                    <Count n={l.unreviewed} tone="warn" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const RUN_TONE: Record<ProjectRun["state"], { tone: Tone; label: string }> = {
  ok: { tone: "ok", label: "成功" },
  failed: { tone: "err", label: "失败" },
  open: { tone: "accent", label: "未结束" },
};

type RunFilter = "all" | "open" | "failed" | "pending";
type RunFilterDef = { id: RunFilter; label: string; test: (r: ProjectRun) => boolean };
const ALL_RUNS: RunFilterDef = { id: "all", label: "全部", test: () => true };
const RUN_FILTERS: RunFilterDef[] = [
  ALL_RUNS,
  { id: "open", label: "未结束", test: (r) => r.state === "open" },
  { id: "failed", label: "失败", test: (r) => r.state === "failed" },
  { id: "pending", label: "未进研究分支", test: (r) => !r.integrated },
];

function RunsCard({ runs }: { runs: ProjectRun[] }) {
  const [all, setAll] = useState(false);
  const [chosen, setFilter] = useState<RunFilter>("all");
  // 选中的那一类刷新后变成 0 条（例如未结束的都跑完了）：回到“全部”。
  const want = RUN_FILTERS.find((f) => f.id === chosen) ?? ALL_RUNS;
  const current = runs.some(want.test) ? want : ALL_RUNS;
  const filter = current.id;
  useEffect(() => {
    if (chosen !== filter) setFilter(filter);
  }, [chosen, filter]);
  const picked = runs.filter(current.test);
  const shown = all ? picked : picked.slice(0, 50);
  return (
    <section className="card flush">
      <h3>
        运行
        <span className="dim">{runs.length}</span>
        <span className="grow" />
        {runs.length > 0 && (
          <span className="filters">
            {RUN_FILTERS.map((f) => {
              const n = runs.filter(f.test).length;
              return (
                <button key={f.id} type="button" className={cx("filter", filter === f.id && "on")} onClick={() => setFilter(f.id)} disabled={n === 0 && f.id !== "all"}>
                  {f.label}
                  {f.id !== "all" && <i>{n}</i>}
                </button>
              );
            })}
          </span>
        )}
      </h3>
      {runs.length === 0 ? (
        <div className="card-hint">还没有运行记录。</div>
      ) : picked.length === 0 ? (
        <div className="card-hint">没有这一类的运行。</div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>运行</th>
                  <th>机器</th>
                  <th>线</th>
                  <th>状态</th>
                  <th>开始</th>
                  <th>汇合</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const st = hasKey(RUN_TONE, r.state) ? RUN_TONE[r.state] : { tone: "mute" as const, label: r.state };
                  return (
                    <tr key={r.run_id}>
                      <td>
                        <span className="mono nowrap">{r.run_id}</span>
                        <div className="dim ellipsis run-note" title={r.note || undefined}>
                          {r.kind}
                          {r.note && ` · ${r.note}`}
                        </div>
                      </td>
                      <td className="mono nowrap">{r.machine ?? <span className="dim">—</span>}</td>
                      <td className="mono nowrap">{r.line ?? <span className="dim">—</span>}</td>
                      <td className="nowrap">
                        <Pill tone={st.tone}>
                          {st.label}
                          {r.state === "failed" && r.exit_code !== null ? ` ${r.exit_code}` : ""}
                        </Pill>
                      </td>
                      <td className="dim nowrap" title={fullTime(r.started_at)}>
                        {r.started_at ? relTime(r.started_at) : "—"}
                      </td>
                      <td className="nowrap">{r.integrated ? <span className="c-ok">已进研究分支</span> : <span className="c-warn">只在 {r.source}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {picked.length > shown.length && (
            <button type="button" className="link-btn table-more" onClick={() => setAll(true)}>
              显示全部 {picked.length} 条
            </button>
          )}
        </>
      )}
    </section>
  );
}

function MembersCard({ view }: { view: ProjectView }) {
  return (
    <section className="card">
      <h3>
        接入的对话
        <span className="dim">{view.members.length}</span>
      </h3>
      {view.members.length === 0 ? (
        <div className="card-hint">还没有。点“新对话”在本机或某台服务器上接入这个项目。</div>
      ) : (
        <ul className="plain-list">
          {view.members.map((m) => {
            const st = sessionState(m.state);
            return (
              <li key={m.session_id}>
                <Pill tone={st.tone}>{st.label}</Pill>
                <a href={sessionHref(m.session_id)}>{m.title}</a>
                <span className="dim">
                  {m.server_alias} · <span className="mono">{m.workdir}</span>
                </span>
                {m.machine ? <span className="tag mono">{m.machine}</span> : <span className="tag warn">还没有代号</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
