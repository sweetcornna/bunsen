import { Copy, CornerDownLeft, FileText, FlaskConical, Folder, GitCompare, Images, LayoutDashboard, MoreHorizontal, Paperclip, X, PanelRightClose, PanelRightOpen, Play, RotateCw, Server as ServerIcon, ShieldOff, SquareTerminal, Unplug } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { SessionMenu } from "../components/SessionMenu";
import { TerminalView, type TermHandle } from "../components/Terminal";
import { AgentMark, Button, cx, Empty, IconButton, Pill, Tip } from "../components/ui";
import type { Quoted } from "../components/Preview";
import { api, type Research, type Session } from "../lib/api";
import { ArtifactsPanel } from "../panels/ArtifactsPanel";
import { copyText, loadLocal, saveLocal, SESSION_STATE } from "../lib/format";
import { go } from "../lib/route";
import { agentOf, serverOf, useApp } from "../lib/store";
import { FilesPanel } from "../panels/FilesPanel";
import { GitPanel } from "../panels/GitPanel";
import { OverviewPanel } from "../panels/OverviewPanel";
import { ResearchPanel } from "../panels/ResearchPanel";

type Tab = "overview" | "shell" | "files" | "changes" | "artifacts" | "research";
const TABS: { id: Tab; label: string; icon: typeof Folder }[] = [
  { id: "overview", label: "概览", icon: LayoutDashboard },
  { id: "shell", label: "终端", icon: SquareTerminal },
  { id: "files", label: "文件", icon: FileText },
  { id: "changes", label: "改动", icon: GitCompare },
  { id: "artifacts", label: "产物", icon: Images },
  { id: "research", label: "科研", icon: FlaskConical },
];

export function SessionView({ id }: { id: string }) {
  const session = useApp((s) => s.sessions.find((x) => x.id === id));
  const agents = useApp((s) => s.agents);
  const servers = useApp((s) => s.servers);
  const setSession = useApp((s) => s.setSession);
  const toast = useApp((s) => s.toast);
  const fail = useApp((s) => s.fail);

  const [tab, setTab] = useState<Tab>(() => loadLocal<Tab>("outpost.tab", "overview"));
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  const [side, setSide] = useState(() => loadLocal("outpost.side", true));
  const [termEpoch, setTermEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [research, setResearch] = useState<Research | null>(null);
  const [focusRun, setFocusRun] = useState<{ id: string; n: number } | null>(null);
  const termRef = useRef<TermHandle | null>(null);
  const barRef = useRef<BarHandle | null>(null);

  // 打开时、以及之后每 15 秒，向服务器问一次真实状态。
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.hidden) return;
      api
        .session(id)
        .then((s) => alive && setSession(s))
        .catch(() => undefined);
    };
    tick();
    const t = window.setInterval(tick, 15000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [id, setSession]);

  // 运行记录用来给产物标来源，不必等用户点开“科研”。
  useEffect(() => {
    let alive = true;
    api
      .research(id)
      .then((r) => alive && setResearch(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  if (!session) {
    return (
      <div className="page center">
        <Empty icon={<Unplug size={22} />} title="找不到这个对话" >
          <Button onClick={() => void useApp.getState().refreshSessions(true)}>刷新</Button>
          <Button variant="primary" onClick={() => go("/")}>
            新对话
          </Button>
        </Empty>
      </div>
    );
  }

  const agent = agentOf(agents, session.agent_id);
  const server = serverOf(servers, session.server_id);
  const st = SESSION_STATE[session.state];
  const attachable = session.state === "running" || session.state === "exited" || session.state === "unknown";

  const pickTab = (t: Tab) => {
    setTab(t);
    setOpened((prev) => new Set(prev).add(t));
    saveLocal("outpost.tab", t);
    if (!side) {
      setSide(true);
      saveLocal("outpost.side", true);
    }
  };

  const restart = async (resume: boolean) => {
    setBusy(true);
    try {
      setSession(await api.restart(session.id, resume));
      setTermEpoch((n) => n + 1);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true);
    try {
      setSession(await api.session(session.id));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const compose = (text: string) => {
    barRef.current?.fill(text);
  };
  const quote = (q: Quoted) => barRef.current?.attach(q);
  const openRun = (runId: string) => {
    setFocusRun((prev) => ({ id: runId, n: (prev?.n ?? 0) + 1 }));
    pickTab("research");
  };

  return (
    <div className="session">
      <header className="session-head">
        <div className="session-title">
          <h1 title={session.title}>{session.title}</h1>
          <Pill tone={st.tone}>
            {st.label}
            {session.state === "exited" && session.exit_status !== null ? `（${session.exit_status}）` : ""}
          </Pill>
        </div>
        <div className="session-meta">
          <span>
            <AgentMark id={session.agent_id} name={agent?.name} size={14} />
            {agent?.name ?? session.agent_id}
          </span>
          <span>
            <ServerIcon size={12} />
            {session.server_alias}
          </span>
          <span className="mono ellipsis" title={session.workdir}>
            <Folder size={12} />
            {session.workdir}
          </span>
          {(session.plugins?.length || session.plugin) && (
            <span className="tag accent" title={(session.plugins ?? [session.plugin]).join("、")}>
              <FlaskConical size={11} />
              科研套件
            </span>
          )}
          {session.yolo && (
            <span className="tag warn">
              <ShieldOff size={11} />
              免确认
            </span>
          )}
          {session.origin === "discovered" && <span className="tag">在服务器上发现</span>}
        </div>
        <div className="session-actions">
          {session.state === "exited" && (
            <Button size="sm" variant="primary" icon={<RotateCw size={12} />} loading={busy} onClick={() => void restart(true)}>
              {agent?.resume ? "接续" : "重新启动"}
            </Button>
          )}
          <IconButton label="复制接入命令" onClick={() => void copyText(session.attach_cmd).then((ok) => toast(ok ? "ok" : "err", ok ? "已复制" : "复制失败"))}>
            <Copy size={14} />
          </IconButton>
          <IconButton
            label={side ? "收起工作区" : "展开工作区"}
            onClick={() => {
              setSide(!side);
              saveLocal("outpost.side", !side);
            }}
          >
            {side ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </IconButton>
          <SessionMenu session={session} onGone={() => go("/")}>
            <button type="button" className="icon-btn" aria-label="更多">
              <MoreHorizontal size={15} />
            </button>
          </SessionMenu>
        </div>
      </header>

      <PanelGroup direction="horizontal" autoSaveId="outpost.session.split" className="session-body">
        <Panel defaultSize={56} minSize={30} className="pane">
          {attachable ? (
            <>
              <div className="agent-term" onClick={() => termRef.current?.focus()}>
                <TerminalView key={termEpoch} ref={termRef} target={{ session: session.id, pane: "agent" }} autoFocus />
              </div>
              <MessageBar ref={barRef} session={session} />
            </>
          ) : session.state === "stopped" ? (
            <Empty icon={<Play size={22} />} title="会话已结束">
              <Button variant="primary" loading={busy} icon={<RotateCw size={13} />} onClick={() => void restart(true)}>
                {agent?.resume ? "接续" : "重新启动"}
              </Button>
              {agent?.resume && (
                <Button disabled={busy} onClick={() => void restart(false)}>
                  从头开始
                </Button>
              )}
            </Empty>
          ) : (
            <Empty icon={<Unplug size={22} />} title={`连不上 ${session.server_alias}`} hint={server?.status_detail ?? undefined}>
              <Button variant="primary" loading={busy} onClick={() => void recheck()}>
                重试
              </Button>
              <Button onClick={() => go("/servers")}>检查服务器</Button>
            </Empty>
          )}
        </Panel>

        {side && (
          <>
            <PanelResizeHandle className="resize-handle" />
            <Panel defaultSize={44} minSize={24} className="pane workspace">
              <div className="tabs" role="tablist">
                {TABS.map((t) => (
                  <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx("tab", tab === t.id && "on")} onClick={() => pickTab(t.id)}>
                    <t.icon size={13} />
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="tab-body">
                {opened.has("overview") && (
                  <div className={cx("fill", tab !== "overview" && "hidden")}>
                    <OverviewPanel session={session} server={server} agent={agent} active={tab === "overview"} />
                  </div>
                )}
                {opened.has("shell") && (
                  <div className={cx("fill", tab !== "shell" && "hidden")}>
                    {session.state === "unreachable" ? <Empty title="服务器连不上" /> : <TerminalView target={{ session: session.id, pane: "shell" }} autoFocus />}
                  </div>
                )}
                {opened.has("files") && (
                  <div className={cx("fill", tab !== "files" && "hidden")}>
                    <FilesPanel session={session} active={tab === "files"} onQuote={quote} />
                  </div>
                )}
                {opened.has("changes") && (
                  <div className={cx("fill", tab !== "changes" && "hidden")}>
                    <GitPanel session={session} active={tab === "changes"} />
                  </div>
                )}
                {opened.has("artifacts") && (
                  <div className={cx("fill", tab !== "artifacts" && "hidden")}>
                    <ArtifactsPanel session={session} active={tab === "artifacts"} runs={research?.runs ?? []} onQuote={quote} onRun={openRun} />
                  </div>
                )}
                {opened.has("research") && (
                  <div className={cx("fill", tab !== "research" && "hidden")}>
                    <ResearchPanel session={session} active={tab === "research"} focusRun={focusRun} onCompose={compose} onQuote={quote} onData={setResearch} />
                  </div>
                )}
              </div>
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
}

type BarHandle = { fill: (text: string) => void; attach: (q: Quoted) => void };

const QUICK_KEYS: { label: string; keys: string[]; tip: string }[] = [
  { label: "Esc", keys: ["Escape"], tip: "打断" },
  { label: "⌃C", keys: ["C-c"], tip: "Ctrl-C" },
  { label: "↑", keys: ["Up"], tip: "上" },
  { label: "↓", keys: ["Down"], tip: "下" },
  { label: "⇥", keys: ["Tab"], tip: "Tab" },
  { label: "⇧⇥", keys: ["BTab"], tip: "Shift-Tab 切换模式" },
  { label: "⏎", keys: ["Enter"], tip: "回车" },
];

/** 终端下面的输入条：长提示在这里写更顺手，发送时整段粘贴进 Agent，多行也安全。 */
const MessageBar = forwardRef<BarHandle, { session: Session }>(function MessageBar({ session }, ref) {
  const fail = useApp((s) => s.fail);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [refs, setRefs] = useState<Quoted[]>([]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const enabled = session.state === "running";

  useImperativeHandle(ref, () => ({
    fill: (t: string) => {
      setText(t);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(t.length, t.length);
      });
    },
    attach: (q: Quoted) => {
      setRefs((prev) => [...prev.filter((r) => r.path !== q.path || r.text !== q.text), q].slice(-6));
      inputRef.current?.focus();
    },
  }));

  const send = async () => {
    if (!enabled || sending) return;
    setSending(true);
    try {
      // 引用的文件和选中的片段跟在消息后面，Agent 自己去读。
      const tail = refs.map((r) => (r.text ? `[${r.path}]\n${r.text.split("\n").map((l) => `> ${l}`).join("\n")}` : `[${r.path}]`)).join("\n");
      const body = [text.trim(), tail].filter(Boolean).join("\n\n");
      if (body) await api.sendText(session.id, body, true);
      else await api.sendKeys(session.id, ["Enter"]);
      setText("");
      setRefs([]);
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  };

  const rows = Math.min(8, Math.max(1, text.split("\n").length));
  return (
    <div className={cx("msgbar", !enabled && "off")}>
      {refs.length > 0 && (
        <div className="refs">
          {refs.map((r, i) => (
            <span key={i} className="ref" title={r.text ?? r.path}>
              <Paperclip size={11} />
              <span className="ellipsis">{r.path.split("/").pop()}</span>
              {r.text && <i>{r.text.split("\n").length} 行</i>}
              <button type="button" aria-label="移除" onClick={() => setRefs((prev) => prev.filter((_, k) => k !== i))}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="msgbar-box">
        <textarea
          ref={inputRef}
          rows={rows}
          value={text}
          disabled={!enabled}
          placeholder={enabled ? "发消息…" : "未运行"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Tip label="发送 ↵" side="top">
          <button type="button" className="send small" disabled={!enabled || sending} onClick={() => void send()} aria-label="发送">
            <CornerDownLeft size={14} />
          </button>
        </Tip>
      </div>
      <div className="msgbar-keys">
        {QUICK_KEYS.map((k) => (
          <Tip key={k.label} label={k.tip} side="top">
            <button type="button" className="key" disabled={!enabled} onClick={() => void api.sendKeys(session.id, k.keys).catch(fail)}>
              {k.label}
            </button>
          </Tip>
        ))}
      </div>
    </div>
  );
});
