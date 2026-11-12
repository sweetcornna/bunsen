import { ArrowUp, Check, CircleDashed, Cpu, FlaskConical, Folder, Minus, Server as ServerIcon, ShieldOff, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImportDrop } from "../components/ImportDrop";
import { InstallDialog } from "../components/InstallDialog";
import { AgentMark, Button, cx, Dot, Logo, Picker, Spinner, Tip } from "../components/ui";
import { ApiError, asApiError, deploy, type Agent, type Server, type Step } from "../lib/api";
import { gpuFree, loadLocal, saveLocal, SERVER_STATUS } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";

type UiStep = Omit<Step, "status"> & { status: Step["status"] | "pending" };

const STEP_ORDER: [string, string][] = [
  ["connect", "连接服务器"],
  ["tmux", "检查 tmux"],
  ["agent", "查找 Agent"],
  ["workdir", "准备工作目录"],
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
  const draft = useApp((s) => s.draft);
  const setDraft = useApp((s) => s.setDraft);
  const setSession = useApp((s) => s.setSession);

  const [serverId, setServerId] = useState<string | null>(() => loadLocal<string | null>("outpost.last.server", null));
  const [agentId, setAgentId] = useState<string | null>(() => loadLocal<string | null>("outpost.last.agent", null));
  const [workdir, setWorkdir] = useState("");
  const [prompt, setPrompt] = useState("");
  const [yolo, setYolo] = useState(false);
  const [plugin, setPlugin] = useState(true);
  const [steps, setSteps] = useState<UiStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [installing, setInstalling] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 从别处带过来的预填（例如服务器页的“新对话”）。
  useEffect(() => {
    if (!draft) return;
    if (draft.server_id) setServerId(draft.server_id);
    if (draft.agent_id) setAgentId(draft.agent_id);
    if (draft.prompt !== undefined) setPrompt(draft.prompt);
    setDraft(null);
    inputRef.current?.focus();
  }, [draft, setDraft]);

  // 选中的服务器、Agent 不在了就回落到默认。
  const server = useMemo<Server | null>(() => {
    const pick = servers.find((s) => s.id === serverId) ?? servers.find((s) => s.id === settings?.default_server) ?? servers.find((s) => s.status === "online") ?? servers[0];
    return pick ?? null;
  }, [servers, serverId, settings?.default_server]);
  const agent = useMemo<Agent | null>(() => {
    const pick = agents.find((a) => a.id === agentId) ?? agents.find((a) => a.id === settings?.default_agent) ?? agents[0];
    return pick ?? null;
  }, [agents, agentId, settings?.default_agent]);

  useEffect(() => {
    if (!server) return;
    setWorkdir(loadLocal<string>(`outpost.workdir.${server.id}`, server.default_workdir || "~"));
  }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 插件默认随部署整套下发；支持插件目录的 Agent 直接加载，其余的用提示指过去。
  const pluginReady = plugins.length > 0 && Boolean(agent?.plugin_dir_flag || agent?.plugin_prompt);
  const usePlugin = plugin && pluginReady;
  const slash = Boolean(agent?.plugin_dir_flag);
  const skillCount = plugins.reduce((n, p) => n + p.skills.length, 0);
  const agentOnServer = server && agent ? server.probe?.agents[agent.id] : undefined;
  const canDeploy = Boolean(server && agent && workdir.trim() && !busy);

  const run = async () => {
    if (!server || !agent || !workdir.trim() || busy) return;
    setBusy(true);
    setError(null);
    setSteps(STEP_ORDER.map(([step, label]) => ({ step, label, status: "pending", detail: null, ms: null })));
    try {
      const session = await deploy(
        {
          server_id: server.id,
          agent_id: agent.id,
          workdir: workdir.trim(),
          prompt: prompt.trim() || undefined,
          yolo,
          plugins: usePlugin ? plugins.map((p) => p.name) : [],
        },
        (st) => setSteps((prev) => (prev ?? []).map((p) => (p.step === st.step ? { ...p, ...st } : p))),
      );
      saveLocal("outpost.last.server", server.id);
      saveLocal("outpost.last.agent", agent.id);
      saveLocal(`outpost.workdir.${server.id}`, workdir.trim());
      setSession(session);
      setPrompt("");
      setSteps(null);
      go(`/s/${session.id}`);
    } catch (e) {
      setError(asApiError(e));
      setSteps((prev) => prev?.map((p) => (p.status === "running" ? { ...p, status: "failed" } : p)) ?? null);
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
            <a onClick={() => go("/servers")}>手动添加</a>
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
              value={server?.id ?? null}
              onChange={(v) => setServerId(v)}
              placeholder="选择服务器"
              icon={<ServerIcon size={13} />}
              options={servers.map((s) => ({
                value: s.id,
                label: s.alias,
                hint: `${s.user}@${s.host}${s.port !== 22 ? `:${s.port}` : ""}`,
                left: <Dot tone={SERVER_STATUS[s.status].tone} />,
                right: s.probe && s.probe.gpus.length > 0 ? <span className="select-tag">{s.probe.gpus.length} GPU</span> : undefined,
              }))}
            />
            <Picker
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
          <DeployProgress
            steps={steps}
            error={error}
            busy={busy}
            agent={agent}
            onInstall={() => setInstalling(true)}
            onRetry={() => void run()}
            onClose={() => {
              setSteps(null);
              setError(null);
            }}
          />
        ) : (
          <>
            {server && <ServerLine server={server} agent={agent} agentPresent={agentOnServer?.present} onInstall={() => setInstalling(true)} />}
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
      <Dot tone={SERVER_STATUS[server.status].tone} />
      <span>{server.alias}</span>
      {server.status !== "online" && <span className="dim">{server.status_detail ?? SERVER_STATUS[server.status].label}</span>}
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
          <a onClick={onInstall}>去安装</a>
        </>
      )}
    </div>
  );
}

function DeployProgress({
  steps,
  error,
  busy,
  agent,
  onInstall,
  onRetry,
  onClose,
}: {
  steps: UiStep[];
  error: ApiError | null;
  busy: boolean;
  agent: Agent | null;
  onInstall: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="deploy">
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
            {(error.code === "auth_failed" || error.code === "host_unreachable" || error.code === "ssh_failed") && <Button onClick={() => go("/servers")}>检查服务器</Button>}
            <Button onClick={onRetry} disabled={busy}>
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
