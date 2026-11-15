import { ArrowUp, Check, CircleDashed, FlaskConical, Folder, FolderGit2, Minus, Plus, RefreshCw, Server as ServerIcon, ShieldOff, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImportDrop } from "../components/ImportDrop";
import { InstallDialog } from "../components/InstallDialog";
import { AgentMark, Badge, Button, cx, Dot, ICON, InlineLink, Logo, Notice, Picker, Spinner, Tip, useScrollEdges } from "../components/ui";
import { ApiError, asApiError, deploy, type Agent, type Project, type Server, type Step } from "../lib/api";
import { fmtDuration, gpuFree, loadLocal, maskUserinfo, saveLocal, serverAddr, serverStatus, STEP_STATUS } from "../lib/format";
import { go } from "../lib/route";
import { hubServer, isLocal, useApp, type Draft } from "../lib/store";

type UiStep = Omit<Step, "status"> & { status: Step["status"] | "pending" };

const STEP_ORDER: [string, string][] = [
  ["connect", "连接服务器"],
  ["tmux", "检查 tmux"],
  ["agent", "查找 Agent"],
  ["workdir", "准备工作目录"],
  ["project", "接入研究项目"],
  ["plugin", "同步插件"],
  ["start", "启动对话"],
  ["verify", "确认运行"],
];

type Starter = { label: string; prompt: string; research?: boolean };
const STARTERS: Starter[] = [
  { label: "开始一轮研究", research: true, prompt: "/research:start " },
  { label: "接续上次的研究", research: true, prompt: "/research:resume" },
  { label: "复现一篇论文", prompt: "复现论文《》的主要结果。先读论文和官方代码，列出要复现的表格与指标，再给出计划；跑实验前先确认显卡占用。" },
  { label: "排查训练问题", prompt: "训练出了问题。\n现象：\n已经试过：\n先读代码和日志定位原因，再设计一个最小的验证实验。" },
  { label: "熟悉这个代码库", prompt: "通读这个仓库，告诉我：入口在哪、数据怎么流、怎么跑通一次最小的训练或评测。" },
];

export function Welcome() {
  const servers = useApp((s) => s.servers);
  const agents = useApp((s) => s.agents);
  const settings = useApp((s) => s.settings);
  const plugins = useApp((s) => s.plugins);
  const projects = useApp((s) => s.projects);
  const projectsReady = useApp((s) => s.projectsReady);
  const projectsError = useApp((s) => s.projectsError);
  const draft = useApp((s) => s.draft);
  const setDraft = useApp((s) => s.setDraft);
  const setSession = useApp((s) => s.setSession);

  // 带着预填进来时一开始就选中预填的服务器，免得先按别的服务器取一遍工作目录。
  const [serverId, setServerId] = useState<string | null>(() => useApp.getState().draft?.server_id ?? loadLocal<string | null>("bunsen.last.server", null));
  const [agentId, setAgentId] = useState<string | null>(() => loadLocal<string | null>("bunsen.last.agent", null));
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workdir, setWorkdir] = useState("");
  const [prompt, setPrompt] = useState("");
  const [yolo, setYolo] = useState(false);
  const [plugin, setPlugin] = useState(true);
  const [steps, setSteps] = useState<UiStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  // 部署时接入的项目（失败时“打开研究项目”指向它）；项目已删、已改成不接入时，不给一键重试。
  const [attempt, setAttempt] = useState<{ projectId: string | null; noRetry: boolean }>({ projectId: null, noRetry: false });
  const [installing, setInstalling] = useState(false);
  // 工具栏放不下时（工作目录已经缩到最窄）：“科研套件”“免确认”收成图标
  const [iconOnly, setIconOnly] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 选“管理研究项目…”跳走时把正在写的内容存进 draft，回来接着写（离开页面时才存，免得本页先把它取走）。
  const keepDraft = useRef(false);
  const latest = useRef<Draft>({});

  // 选中的服务器、Agent 不在了就回落到默认。
  const server = useMemo<Server | null>(() => {
    const pick = servers.find((s) => s.id === serverId) ?? servers.find((s) => s.id === settings?.default_server) ?? servers.find((s) => s.status === "online") ?? servers[0];
    return pick ?? null;
  }, [servers, serverId, settings?.default_server]);
  const agent = useMemo<Agent | null>(() => {
    const pick = agents.find((a) => a.id === agentId) ?? agents.find((a) => a.id === settings?.default_agent) ?? agents[0];
    return pick ?? null;
  }, [agents, agentId, settings?.default_agent]);
  // 项目被删了就当作不接入。
  const project = useMemo<Project | null>(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);
  latest.current = { server_id: server?.id, agent_id: agent?.id, prompt, project_id: project?.id };
  useEffect(
    () => () => {
      if (keepDraft.current) useApp.getState().setDraft(latest.current);
    },
    [],
  );

  // 从别处带过来的预填（例如服务器页、项目页的“新对话”）。
  useEffect(() => {
    if (!draft) return;
    if (draft.server_id) setServerId(draft.server_id);
    if (draft.agent_id) setAgentId(draft.agent_id);
    if (draft.prompt !== undefined) setPrompt(draft.prompt);
    if (draft.project_id) setProjectId(draft.project_id);
    setDraft(null);
    inputRef.current?.focus();
  }, [draft, setDraft]);

  useEffect(() => {
    if (!server) return;
    setWorkdir(loadLocal<string>(`bunsen.workdir.${server.id}`, server.default_workdir || "~"));
  }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 汇合点在某台服务器上（别名:路径）时，只有那台和本机接得进去（契约第 4 节）。
  const hubAt = project ? hubServer(project.hub, servers) : null;
  const hubBlocked = Boolean(server && hubAt && !isLocal(server) && hubAt.server?.id !== server.id);

  // 插件默认随部署整套下发；支持插件目录的 Agent 直接加载，其余的用提示指过去。
  const pluginReady = plugins.length > 0 && Boolean(agent?.plugin_dir_flag || agent?.plugin_prompt);
  const usePlugin = plugin && pluginReady;
  const slash = Boolean(agent?.plugin_dir_flag);
  const skillCount = plugins.reduce((n, p) => n + p.skills.length, 0);
  const agentOnServer = server && agent ? server.probe?.agents[agent.id] : undefined;
  // 接不进项目时不让部署：服务端会先建出工作目录，到 project 一步才失败。
  const canDeploy = Boolean(server && agent && workdir.trim() && !busy && !hubBlocked);
  const hubWarn =
    server && hubBlocked && hubAt ? (
      <Notice tone="warn" className="welcome-notice">
        {hubAt.local && !hubAt.server
          ? `不能部署：这个项目的汇合点在本机上，可 Bunsen 没有启用本机（用 BUNSEN_NO_LOCAL=1 启动的），汇合点在本机的项目只能在这台电脑上用。去掉 BUNSEN_NO_LOCAL 后重启 bunsen serve，或选“不接入项目”，或把项目的汇合点换成各处都能访问的仓库（例如私有 GitHub 仓库）`
          : hubAt.local
          ? `不能部署：${server.alias} 接不进这个项目，汇合点在本机上，只有本机访问得到。换到本机，或选“不接入项目”，或把项目的汇合点换成各处都能访问的仓库（例如私有 GitHub 仓库）`
          : `不能部署：${server.alias} 接不进这个项目，汇合点在 ${hubAt.alias} 上，只有 ${hubAt.alias} 和本机访问得到。换到 ${hubAt.alias} 或本机，或选“不接入项目”，或把项目的汇合点换成各处都能访问的仓库（例如私有 GitHub 仓库）`}
      </Notice>
    ) : null;

  const run = async () => {
    if (!server || !agent || !workdir.trim() || busy || hubBlocked) return;
    setBusy(true);
    setError(null);
    setAttempt({ projectId: project?.id ?? null, noRetry: false });
    const local = isLocal(server);
    setSteps(STEP_ORDER.map(([step, label]) => ({ step, label: local && step === "connect" ? "检查本机" : label, status: "pending", detail: null, ms: null })));
    try {
      const session = await deploy(
        {
          server_id: server.id,
          agent_id: agent.id,
          workdir: workdir.trim(),
          prompt: prompt.trim() || undefined,
          yolo,
          plugins: usePlugin ? plugins.map((p) => p.name) : [],
          project_id: project?.id,
        },
        (st) => setSteps((prev) => (prev ?? []).map((p) => (p.step === st.step ? { ...p, ...st } : p))),
      );
      saveLocal("bunsen.last.server", server.id);
      saveLocal("bunsen.last.agent", agent.id);
      saveLocal(`bunsen.workdir.${server.id}`, workdir.trim());
      setSession(session);
      setPrompt("");
      setSteps(null);
      go(`/s/${session.id}`);
    } catch (e) {
      const err = asApiError(e);
      setError(err);
      // 还没开始任何步骤就被拒绝（服务器、Agent 或研究项目不存在【G5】）：不留一列等待中的步骤，只显示错误。
      setSteps((prev) => (prev?.some((p) => p.status !== "pending") ? prev.map((p) => (p.status === "running" ? { ...p, status: "failed" } : p)) : []));
      // 接入的项目可能已在别处删掉：重新取一次项目列表，真不在了就清掉选择。这时一键重试会悄悄部署出
      // 不接入项目的对话，所以改写提示、不给重试，要用户确认后自己再点部署。
      if (err.code === "not_found" && project) {
        const gone = project.id;
        await useApp.getState().loadProjects();
        const st = useApp.getState();
        if (st.projectsReady && !st.projectsError && !st.projects.some((p) => p.id === gone)) {
          setProjectId((cur) => (cur === gone ? null : cur));
          setError(new ApiError("not_found", `研究项目 ${project.name} 已经删除，已改为不接入项目`, "确认之后再点部署；要接入别的项目，先在下拉框里重新选。", err.status));
          setAttempt({ projectId: null, noRetry: true });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  if (servers.length === 0) {
    return (
      <div className="page">
        <div className="welcome-inner">
          <h1 className="hero t-hero">接入一台服务器</h1>
          <ImportDrop />
          <div className="hero-foot">
            <a href="#/servers">手动添加</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="welcome-inner">
        <h1 className="hero t-hero">
          <Logo size={30} />
          今天研究什么？
        </h1>

        <div className="composer-box">
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={3}
            autoFocus
            placeholder="描述课题或任务…"
            value={prompt}
            // 部署进行中不降透明度，改为不可编辑
            readOnly={busy}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div className="composer-bar">
            <ChipRow onIconOnly={setIconOnly}>
              <Picker
                disabled={busy}
                value={server?.id ?? null}
                onChange={(v) => setServerId(v)}
                placeholder="选择服务器"
                icon={<ServerIcon size={ICON.md} />}
                options={servers.map((s) => ({
                  value: s.id,
                  label: s.alias,
                  hint: serverAddr(s),
                  left: <Dot tone={serverStatus(s.status).dot} label={serverStatus(s.status).label} />,
                  right: s.probe && s.probe.gpus.length > 0 ? <Badge>{s.probe.gpus.length} GPU</Badge> : undefined,
                }))}
              />
              <Picker
                disabled={busy}
                value={agent?.id ?? null}
                onChange={(v) => setAgentId(v)}
                placeholder="选择 Agent"
                options={agents.map((a) => {
                  const on = server?.probe?.agents[a.id];
                  return {
                    value: a.id,
                    label: a.name,
                    hint: a.vendor,
                    left: <AgentMark id={a.id} name={a.name} />,
                    right: on ? <Badge tone={on.present ? "neutral" : "warn"}>{on.present ? "已安装" : "未安装"}</Badge> : undefined,
                  };
                })}
              />
              <WorkdirChip value={workdir} onChange={setWorkdir} disabled={busy} />
              <Picker
                disabled={busy}
                // 不接入项目也是一个选项：选中它，下拉框里的勾和部署请求（不带 project_id）一致。
                value={project?.id ?? "__none"}
                onChange={(v) => {
                  if (v === "__none") setProjectId(null);
                  else if (v === "__retry") void useApp.getState().loadProjects();
                  else if (v !== "__manage") setProjectId(v);
                  else {
                    keepDraft.current = true;
                    go("/projects");
                  }
                }}
                placeholder="不接入项目"
                icon={<FolderGit2 size={ICON.md} />}
                options={[
                  { value: "__none", label: "不接入项目", hint: "研究记录只留在这台机器上" },
                  ...projects.map((p) => ({ value: p.id, label: p.name, hint: `${p.branch} · ${maskUserinfo(p.hub)}`, left: <FolderGit2 size={ICON.md} /> })),
                  // 列表没取到时说清楚，免得以为没有项目；给一个重试的入口。
                  ...(projectsError
                    ? [
                        { value: "__error", label: "取不到研究项目列表", hint: projectsError.message, left: <TriangleAlert size={ICON.md} />, disabled: true },
                        { value: "__retry", label: "重新取项目列表", left: <RefreshCw size={ICON.md} /> },
                      ]
                    : !projectsReady
                      ? [{ value: "__loading", label: "正在取研究项目列表…", left: <Spinner size={ICON.md} />, disabled: true }]
                      : []),
                  { value: "__manage", label: projects.length > 0 ? "管理研究项目…" : "新建研究项目…", left: <Plus size={ICON.md} /> },
                ]}
              />
              <Tip label={`${iconOnly ? "科研套件：" : ""}${pluginReady ? `随部署下发：${plugins.map((p) => p.name).join("、")} · ${skillCount} 个技能` : "没有可用插件"}`}>
                <Button
                  variant="ghost"
                  icon={<FlaskConical size={ICON.md} />}
                  disabled={!pluginReady || busy}
                  onClick={() => setPlugin((v) => !v)}
                  aria-pressed={usePlugin}
                  aria-label="科研套件"
                  data-toggle=""
                  data-icon-only={iconOnly ? "" : undefined}
                >
                  {iconOnly ? null : "科研套件"}
                </Button>
              </Tip>
              <Tip label={`${iconOnly ? "免确认：" : ""}${agent?.yolo_flag ? "跳过权限确认" : "此 Agent 不支持"}`}>
                <Button
                  variant="ghost"
                  tone="warn"
                  icon={<ShieldOff size={ICON.md} />}
                  disabled={!agent?.yolo_flag || busy}
                  onClick={() => setYolo((v) => !v)}
                  aria-pressed={yolo}
                  aria-label="免确认"
                  data-toggle=""
                  data-icon-only={iconOnly ? "" : undefined}
                >
                  {iconOnly ? null : "免确认"}
                </Button>
              </Tip>
            </ChipRow>
            <Tip label="部署 ⌘↵" side="top">
              <button type="button" className="icon-button composer-send" disabled={!canDeploy} onClick={() => void run()} aria-label="部署并开始">
                {busy ? <Spinner size={ICON.lg} /> : <ArrowUp size={ICON.lg} />}
              </button>
            </Tip>
          </div>
        </div>

        {steps ? (
          <>
            {hubWarn}
            <DeployProgress
              steps={steps}
              error={error}
              canRetry={canDeploy && !attempt.noRetry}
              projectId={attempt.projectId}
              agent={agent}
              onInstall={() => setInstalling(true)}
              onRetry={() => void run()}
              onClose={() => {
                setSteps(null);
                setError(null);
              }}
            />
          </>
        ) : (
          <>
            {server && <ServerLine server={server} agent={agent} agentPresent={agentOnServer?.present} onInstall={() => setInstalling(true)} />}
            {hubWarn}
            <div className="starter-list">
              {STARTERS.filter((s) => !s.research || (usePlugin && slash)).map((s) => (
                <Button
                  key={s.label}
                  icon={s.research ? <FlaskConical size={ICON.md} /> : undefined}
                  onClick={() => {
                    if (s.research) setPlugin(true);
                    setPrompt(s.prompt);
                    inputRef.current?.focus();
                  }}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </>
        )}
      </div>

      {server && agent && <InstallDialog server={server} agent={agent} open={installing} onOpenChange={setInstalling} />}
    </div>
  );
}

/**
 * 芯片区不折行，也不遮挡、不裁掉任何一项（设计稿 5.5）。放不下时依次：
 * 1. 工作目录芯片先缩（保留路径末尾，左侧渐隐），最窄到 CSS 的 min-width；
 * 2. 还放不下，“科研套件”“免确认”收成图标（tooltip、aria-label 里有名字）——由这里量出来，告诉 onIconOnly；
 * 3. 再窄（窄屏），下拉芯片的文字截断；实在放不下才横向滚动，两端渐隐。
 * 量的是“完整形态”要多宽：工作目录按最窄算，下拉按文字不截断算，两个开关按完整形态时量到的宽度算，所以不会来回跳。
 */
function ChipRow({ children, onIconOnly }: { children: ReactNode; onIconOnly: (v: boolean) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const full = useRef(new Map<Element, number>());
  useScrollEdges(ref, "x");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const kids = [...el.children] as HTMLElement[];
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      let need = gap * Math.max(0, kids.length - 1);
      let saved = 0; // 两个开关收成图标（正方形，宽等于高）能省下的宽度
      for (const k of kids) {
        if (k.dataset.shrink !== undefined) need += k.dataset.short !== undefined ? k.offsetWidth : parseFloat(getComputedStyle(k).minWidth) || 0;
        else if (k.dataset.toggle !== undefined) {
          if (k.dataset.iconOnly === undefined) full.current.set(k, k.offsetWidth);
          const w = full.current.get(k) ?? k.offsetWidth;
          need += w;
          saved += Math.max(0, w - k.offsetHeight);
        } else {
          // 文字被截断的下拉：按不截断的宽度算
          let w = k.offsetWidth;
          for (const label of k.querySelectorAll<HTMLElement>(".label")) w += Math.max(0, label.scrollWidth - label.clientWidth);
          need += w;
        }
      }
      onIconOnly(need > el.clientWidth + 0.5);
      // 收成图标后还放不下（窄屏）：才让下拉芯片缩、截断文字。平时不让它们参与收缩，免得跟着工作目录缩掉零点几像素就出省略号
      el.toggleAttribute("data-tight", need - saved > el.clientWidth + 0.5);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    for (const k of el.children) ro.observe(k);
    const mo = new MutationObserver(() => {
      for (const k of el.children) ro.observe(k);
      schedule();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [onIconOnly]);
  return (
    <div ref={ref} className="composer-chips">
      {children}
    </div>
  );
}

/**
 * 工作目录芯片：最大 240，工具栏放不下时先缩它（最窄 120）；不在编辑时滚到末尾、左侧渐隐，保留路径末尾。
 * 路径本来就短（完整形态不到 120）时标 data-short：按本来的宽度显示，不撑到 120，也不缩。
 */
function WorkdirChip({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  const label = useRef<HTMLLabelElement | null>(null);
  const floor = useRef(0);
  const toEnd = () => {
    const el = input.current;
    const lab = label.current;
    if (!el || !lab) return;
    if (document.activeElement !== el) el.scrollLeft = el.scrollWidth;
    // 完整形态的宽度：芯片除输入框以外的部分 + 输入框的内容宽度（被撑宽时是撑开后的宽度，正好等于最窄宽度，不会来回跳）
    if (!lab.hasAttribute("data-short")) floor.current = parseFloat(getComputedStyle(lab).minWidth) || 0;
    lab.toggleAttribute("data-short", lab.offsetWidth - el.offsetWidth + el.scrollWidth <= floor.current + 0.5);
    lab.toggleAttribute("data-more-start", el.scrollWidth > el.clientWidth + 1);
  };
  useEffect(toEnd, [value]);
  // 工具栏放不下时芯片会缩窄：缩了也保持滚在末尾
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const ro = new ResizeObserver(toEnd);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <label ref={label} className="workdir-chip" title={value || "工作目录"} data-shrink="">
      <Folder size={ICON.md} />
      <input ref={input} value={value} spellCheck={false} placeholder="~/项目目录" aria-label="工作目录" onChange={(e) => onChange(e.target.value)} onBlur={toEnd} disabled={disabled} style={{ width: `${Math.min(34, Math.max(2, value.length + 1))}ch` }} />
    </label>
  );
}

/** 服务器信息行：最多三项——状态点、名字、一条 muted 说明。 */
function ServerLine({ server, agent, agentPresent, onInstall }: { server: Server; agent: Agent | null; agentPresent: boolean | undefined; onInstall: () => void }) {
  const p = server.probe;
  const st = serverStatus(server.status);
  const free = p ? p.gpus.filter(gpuFree).length : 0;
  const note: ReactNode =
    server.status !== "online" ? (
      (server.status_detail ?? st.label)
    ) : agent && agentPresent === false ? (
      <>
        没装 {agent.name}，<InlineLink onClick={onInstall}>去安装</InlineLink>
      </>
    ) : p && !p.tmux.present ? (
      "没有 tmux，部署前要先装上"
    ) : p && p.gpus.length > 0 ? (
      `${p.gpus.length} 张显卡，${free} 张空闲`
    ) : p ? (
      `${p.os} · ${p.cpus} 核`
    ) : isLocal(server) ? (
      "本机"
    ) : (
      "还没探测"
    );
  return (
    <div className="server-line" data-server-line="">
      <Dot tone={st.dot} label={st.label} />
      <span>{server.alias}</span>
      <span className="muted" title={typeof note === "string" ? note : undefined}>
        {note}
      </span>
    </div>
  );
}

const STEP_ICON: Record<UiStep["status"], ReactNode> = {
  running: <Spinner size={ICON.sm} />,
  ok: <Check size={ICON.sm} />,
  failed: <X size={ICON.sm} />,
  skipped: <Minus size={ICON.sm} />,
  pending: <CircleDashed size={ICON.sm} />,
};

function DeployProgress({
  steps,
  error,
  canRetry,
  projectId,
  agent,
  onInstall,
  onRetry,
  onClose,
}: {
  steps: UiStep[];
  error: ApiError | null;
  canRetry: boolean;
  projectId: string | null;
  agent: Agent | null;
  onInstall: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  // 失败在“接入研究项目”一步（含取不到汇合点）：问题多半在项目的汇合点上，不在服务器上。
  const projectFailed = steps.some((s) => s.step === "project" && s.status === "failed");
  // 失败区只有一个主动作：缺 Agent 时是“安装”（重试也还是缺），其余是“重试”。
  const install = error?.code === "agent_missing" && agent;
  return (
    <div className="deploy-area" data-deploy="">
      {steps.length > 0 && (
        <ol className="deploy-step-list surface-well">
          {steps.map((s) => (
            <li key={s.step} className="deploy-step" data-status={s.status}>
              <span className="deploy-icon" role="img" aria-label={STEP_STATUS[s.status] ?? s.status}>
                {STEP_ICON[s.status] ?? <CircleDashed size={ICON.sm} />}
              </span>
              <span className={cx("deploy-label", s.status === "running" && "shimmer")}>{s.label}</span>
              <span className="deploy-detail">{s.detail}</span>
              {s.ms !== null && <span className="deploy-ms">{fmtDuration(s.ms)}</span>}
            </li>
          ))}
        </ol>
      )}
      {error && (
        // 失败：一条 Notice（err），说明和动作都在里面；失败区只一个 primary
        <Notice tone="err" data-deploy-error="">
          <div className="fw-medium">{error.message}</div>
          {error.hint && <div className="secondary">{error.hint}</div>}
          <div className="row wrap deploy-actions">
            {install ? (
              <>
                <Button variant="primary" onClick={onInstall}>
                  安装 {agent.name}
                </Button>
                <Button variant="ghost" onClick={onRetry} disabled={!canRetry}>
                  重试
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={onRetry} disabled={!canRetry}>
                重试
              </Button>
            )}
            {projectFailed && projectId ? (
              <Button variant="ghost" onClick={() => go(`/p/${encodeURIComponent(projectId)}`)}>
                打开研究项目
              </Button>
            ) : (
              (error.code === "auth_failed" || error.code === "host_unreachable" || error.code === "ssh_failed") && (
                <Button variant="ghost" onClick={() => go("/servers")}>
                  检查服务器
                </Button>
              )
            )}
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
        </Notice>
      )}
    </div>
  );
}
