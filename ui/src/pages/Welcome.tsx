import { ArrowUp, Check, CircleDashed, Cpu, FlaskConical, Folder, FolderGit2, Minus, Plus, RefreshCw, Server as ServerIcon, ShieldOff, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImportDrop } from "../components/ImportDrop";
import { InstallDialog } from "../components/InstallDialog";
import { AgentMark, Button, cx, Dot, Logo, Picker, Spinner, Tip } from "../components/ui";
import { ApiError, asApiError, deploy, type Agent, type Project, type Server, type Step } from "../lib/api";
import { gpuFree, loadLocal, maskUserinfo, saveLocal, serverAddr, serverStatus } from "../lib/format";
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
      <div className="server-line hub-warn">
        <TriangleAlert size={11} />
        {hubAt.local && !hubAt.server
          ? `不能部署：这个项目的汇合点在本机上，可 Bunsen 没有启用本机（用 BUNSEN_NO_LOCAL=1 启动的），汇合点在本机的项目只能在这台电脑上用。去掉 BUNSEN_NO_LOCAL 后重启 bunsen serve，或选“不接入项目”，或把项目的汇合点换成各处都能访问的仓库（例如私有 GitHub 仓库）`
          : hubAt.local
          ? `不能部署：${server.alias} 接不进这个项目，汇合点在本机上，只有本机访问得到。换到本机，或选“不接入项目”，或把项目的汇合点换成各处都能访问的仓库（例如私有 GitHub 仓库）`
          : `不能部署：${server.alias} 接不进这个项目，汇合点在 ${hubAt.alias} 上，只有 ${hubAt.alias} 和本机访问得到。换到 ${hubAt.alias} 或本机，或选“不接入项目”，或把项目的汇合点换成各处都能访问的仓库（例如私有 GitHub 仓库）`}
      </div>
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
      <div className="page welcome">
        <div className="welcome-inner">
          <h1 className="hero">接入一台服务器</h1>
          <ImportDrop />
          <div className="hero-foot">
            <a href="#/servers">手动添加</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page welcome">
      <div className="welcome-inner">
        <h1 className="hero">
          <Logo size={30} />
          今天研究什么？
        </h1>

        <div className={cx("composer", busy && "busy")}>
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={3}
            autoFocus
            placeholder="描述课题或任务…"
            value={prompt}
            disabled={busy}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run();
              }
            }}
          />
          <div className="composer-bar">
            <Picker
              disabled={busy}
              value={server?.id ?? null}
              onChange={(v) => setServerId(v)}
              placeholder="选择服务器"
              icon={<ServerIcon size={13} />}
              options={servers.map((s) => ({
                value: s.id,
                label: s.alias,
                hint: serverAddr(s),
                left: <Dot tone={serverStatus(s.status).tone} />,
                right: s.probe && s.probe.gpus.length > 0 ? <span className="select-tag">{s.probe.gpus.length} GPU</span> : undefined,
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
                  right: on ? <span className={cx("select-tag", on.present ? "ok" : "mute")}>{on.present ? "已安装" : "未安装"}</span> : undefined,
                };
              })}
            />
            <label className="chip input-chip" title="工作目录">
              <Folder size={13} />
              <input value={workdir} spellCheck={false} placeholder="~/项目目录" onChange={(e) => setWorkdir(e.target.value)} disabled={busy} style={{ width: `${Math.min(34, Math.max(8, workdir.length + 1))}ch` }} />
            </label>
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
              icon={<FolderGit2 size={13} />}
              options={[
                { value: "__none", label: "不接入项目", hint: "研究记录只留在这台机器上" },
                ...projects.map((p) => ({ value: p.id, label: p.name, hint: `${p.branch} · ${maskUserinfo(p.hub)}`, left: <FolderGit2 size={13} /> })),
                // 列表没取到时说清楚，免得以为没有项目；给一个重试的入口。
                ...(projectsError
                  ? [
                      { value: "__error", label: "取不到研究项目列表", hint: projectsError.message, left: <TriangleAlert size={13} />, disabled: true },
                      { value: "__retry", label: "重新取项目列表", left: <RefreshCw size={13} /> },
                    ]
                  : !projectsReady
                    ? [{ value: "__loading", label: "正在取研究项目列表…", left: <Spinner size={13} />, disabled: true }]
                    : []),
                { value: "__manage", label: projects.length > 0 ? "管理研究项目…" : "新建研究项目…", left: <Plus size={13} /> },
              ]}
            />
            <Tip label={pluginReady ? `随部署下发：${plugins.map((p) => p.name).join("、")} · ${skillCount} 个技能` : "没有可用插件"}>
              <button type="button" className={cx("chip toggle-chip", usePlugin && "on")} disabled={!pluginReady || busy} onClick={() => setPlugin((v) => !v)} aria-pressed={usePlugin}>
                <FlaskConical size={13} />
                科研套件
              </button>
            </Tip>
            <Tip label={agent?.yolo_flag ? "跳过权限确认" : "此 Agent 不支持"}>
              <button type="button" className={cx("chip toggle-chip warn", yolo && "on")} disabled={!agent?.yolo_flag || busy} onClick={() => setYolo((v) => !v)} aria-pressed={yolo}>
                <ShieldOff size={13} />
                免确认
              </button>
            </Tip>
            <span className="grow" />
            <Tip label="部署 ⌘↵">
              <button type="button" className="send" disabled={!canDeploy} onClick={() => void run()} aria-label="部署并开始">
                {busy ? <Spinner size={15} /> : <ArrowUp size={16} />}
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
            <div className="starters">
              {STARTERS.filter((s) => !s.research || (usePlugin && slash)).map((s) => (
                <button
                  key={s.label}
                  type="button"
                  className="starter"
                  onClick={() => {
                    if (s.research) setPlugin(true);
                    setPrompt(s.prompt);
                    inputRef.current?.focus();
                  }}
                >
                  {s.research && <FlaskConical size={12} />}
                  {s.label}
                </button>
              ))}
            </div>
          </>
        )}

      </div>

      {server && agent && <InstallDialog server={server} agent={agent} open={installing} onOpenChange={setInstalling} />}
    </div>
  );
}

function ServerLine({ server, agent, agentPresent, onInstall }: { server: Server; agent: Agent | null; agentPresent: boolean | undefined; onInstall: () => void }) {
  const p = server.probe;
  const free = p ? p.gpus.filter(gpuFree).length : 0;
  return (
    <div className="server-line">
      <Dot tone={serverStatus(server.status).tone} />
      <span>{server.alias}</span>
      {isLocal(server) && <span className="tag">本机</span>}
      {server.status !== "online" && <span className="dim">{server.status_detail ?? serverStatus(server.status).label}</span>}
      {p && (
        <>
          <i>·</i>
          <span>{p.os}</span>
          <i>·</i>
          <span>
            <Cpu size={11} /> {p.cpus} 核
          </span>
          {p.gpus.length > 0 && (
            <>
              <i>·</i>
              <span className={free > 0 ? "c-ok" : "c-warn"}>
                {p.gpus.length} 张显卡，{free} 张空闲
              </span>
            </>
          )}
          {!p.tmux.present && (
            <>
              <i>·</i>
              <span className="c-err">没有 tmux</span>
            </>
          )}
        </>
      )}
      
      {agent && agentPresent === false && (
        <>
          <i>·</i>
          <span className="c-warn">
            <TriangleAlert size={11} /> 没装 {agent.name}
          </span>
          <button type="button" className="link-btn" onClick={onInstall}>
            去安装
          </button>
        </>
      )}
    </div>
  );
}

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
  return (
    <div className="deploy">
      {steps.length > 0 && (
        <ol className="deploy-steps">
          {steps.map((s) => (
            <li key={s.step} className={s.status}>
              <span className="deploy-icon">
                {s.status === "running" ? (
                  <Spinner size={13} />
                ) : s.status === "ok" ? (
                  <Check size={13} />
                ) : s.status === "failed" ? (
                  <X size={13} />
                ) : s.status === "skipped" ? (
                  <Minus size={13} />
                ) : (
                  <CircleDashed size={13} />
                )}
              </span>
              <span className="deploy-label">{s.label}</span>
              <span className="deploy-detail">{s.detail}</span>
              {s.ms !== null && <span className="deploy-ms">{s.ms < 1000 ? `${s.ms} ms` : `${(s.ms / 1000).toFixed(1)} s`}</span>}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <div className="deploy-error">
          <div>
            <b>{error.message}</b>
            {error.hint && <p>{error.hint}</p>}
          </div>
          <div className="row">
            {error.code === "agent_missing" && agent && (
              <Button variant="primary" onClick={onInstall}>
                安装 {agent.name}
              </Button>
            )}
            {projectFailed && projectId ? (
              <Button onClick={() => go(`/p/${encodeURIComponent(projectId)}`)}>打开研究项目</Button>
            ) : (
              (error.code === "auth_failed" || error.code === "host_unreachable" || error.code === "ssh_failed") && <Button onClick={() => go("/servers")}>检查服务器</Button>
            )}
            <Button onClick={onRetry} disabled={!canRetry}>
              重试
            </Button>
            <Button variant="ghost" onClick={onClose}>
              关闭
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
