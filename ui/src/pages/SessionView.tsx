import { ArrowUp, MoreHorizontal, Paperclip, PanelRightClose, PanelRightOpen, Play, RotateCw, Unplug, WifiOff, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { SessionMenu } from "../components/SessionMenu";
import { useSessionDrop } from "../components/SplitDrop";
import { TerminalView, useTermFocus, type AutoFocus, type TermHandle } from "../components/Terminal";
import { Badge, Button, cx, Dot, Empty, ICON, IconButton, Notice, Tabs, Tip } from "../components/ui";
import type { Quoted } from "../components/Preview";
import { api, type Agent, type Research, type Server, type Session } from "../lib/api";
import { ArtifactsPanel } from "../panels/ArtifactsPanel";
import { loadLocal, saveLocal, sessionState } from "../lib/format";
import { go } from "../lib/route";
import { PANEL_EVENT, registerPane, type BarHandle } from "../lib/splitStore";
import { agentOf, serverOf, useApp } from "../lib/store";
import { FilesPanel } from "../panels/FilesPanel";
import { GitPanel } from "../panels/GitPanel";
import { OverviewPanel } from "../panels/OverviewPanel";
import { ResearchPanel } from "../panels/ResearchPanel";

export type Tab = "overview" | "shell" | "files" | "changes" | "artifacts" | "research";
export const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "概览" },
  { value: "shell", label: "终端" },
  { value: "files", label: "文件" },
  { value: "changes", label: "改动" },
  { value: "artifacts", label: "产物" },
  { value: "research", label: "科研" },
];

export function SessionView({ id }: { id: string }) {
  const session = useApp((s) => s.sessions.find((x) => x.id === id));
  const agents = useApp((s) => s.agents);
  const servers = useApp((s) => s.servers);

  const [tab, setTab] = useState<Tab>(() => loadLocal<Tab>("bunsen.tab", "overview"));
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  const [side, setSide] = useState(() => loadLocal("bunsen.side", true));
  const [focusRun, setFocusRun] = useState<{ id: string; n: number } | null>(null);
  const termRef = useRef<TermHandle | null>(null);
  const barRef = useRef<BarHandle | null>(null);
  const [research, setResearch] = useResearch(id, session);
  // 侧栏的会话拖到这里：在分屏中打开（放下的那一侧决定开在右边还是下面）
  const drop = useSessionDrop(id);

  useSessionPoll(id);
  // 分屏的会话选择框关掉后，键盘焦点回到这里的终端
  useEffect(() => registerPane(id, { focus: () => (termRef.current ? (termRef.current.focus(), true) : false), bar: () => barRef.current }), [id]);

  // Ctrl+Mod+B（分屏的面板快捷键）在单会话页开关右边这一栏
  useEffect(() => {
    const on = () =>
      setSide((v: boolean) => {
        saveLocal("bunsen.side", !v);
        return !v;
      });
    window.addEventListener(PANEL_EVENT, on);
    return () => window.removeEventListener(PANEL_EVENT, on);
  }, []);

  if (!session) {
    return (
      <div className="page center">
        <Empty icon={<Unplug size={ICON.lg} />} title="找不到这个对话" hint="它可能已经删除了；刷新一下会话列表，或者开一个新对话。">
          <Button onClick={() => void useApp.getState().refreshSessions(true)}>刷新</Button>
          <Button variant="ghost" onClick={() => go("/")}>
            新对话
          </Button>
        </Empty>
      </div>
    );
  }

  const agent = agentOf(agents, session.agent_id);
  const server = serverOf(servers, session.server_id);
  const st = sessionState(session.state);

  const pickTab = (t: Tab) => {
    setTab(t);
    setOpened((prev) => new Set(prev).add(t));
    saveLocal("bunsen.tab", t);
    if (!side) {
      setSide(true);
      saveLocal("bunsen.side", true);
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
      {/* 会话头只留状态点、标题、服务器别名和有风险的“免确认”；项目、机器代号、工作目录、科研套件都在概览里 */}
      <header className="session-head" data-session-head="">
        {st.dot && <Dot tone={st.dot} label={st.label} />}
        <h1 className="session-title" title={session.title}>
          {session.title}
        </h1>
        <span className="session-server" title={`${session.server_alias}:${session.workdir}`}>
          {session.server_alias}
        </span>
        {session.yolo && (
          <Badge tone="warn" title="跳过权限确认：Agent 执行命令前不再询问" data-yolo="">
            免确认
          </Badge>
        )}
        <div className="session-actions">
          {/* 右边这一栏和分屏的共享面板同一个叫法：面板（分屏稿 14.6） */}
          <IconButton
            label={side ? "隐藏面板" : "显示面板"}
            onClick={() => {
              setSide(!side);
              saveLocal("bunsen.side", !side);
            }}
          >
            {side ? <PanelRightClose size={ICON.md} /> : <PanelRightOpen size={ICON.md} />}
          </IconButton>
          <SessionMenu session={session} onGone={() => go("/")}>
            <IconButton label="更多">
              <MoreHorizontal size={ICON.md} />
            </IconButton>
          </SessionMenu>
        </div>
      </header>

      <PanelGroup direction="horizontal" autoSaveId="bunsen.session.split" className="session-body">
        <Panel id="agent" order={1} defaultSize={side ? 56 : 100} minSize={30} className="pane" {...drop.handlers}>
          <AgentBody session={session} agent={agent} server={server} termRef={termRef} barRef={barRef} />
          {drop.hint}
        </Panel>

        {side && (
          <>
            <PanelResizeHandle className="resize-handle" />
            <Panel id="workspace" order={2} defaultSize={44} minSize={24} className="pane workspace">
              <Workspace
                session={session}
                server={server}
                agent={agent}
                tab={tab}
                opened={opened}
                onPick={pickTab}
                research={research}
                onResearch={setResearch}
                focusRun={focusRun}
                onRun={openRun}
                onCompose={compose}
                onQuote={quote}
              />
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
}

/** 打开时、以及之后每 15 秒，向服务器问一次这个会话的真实状态（分屏时只问焦点格的会话）。 */
export function useSessionPoll(id: string) {
  const setSession = useApp((s) => s.setSession);
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
}

/**
 * 运行记录用来给产物标来源，不必等用户点开“科研”。会话连不上时不取（只会得到 502），恢复后再取（第四期前端遗留，界面统一 5.6）。
 * 还不知道会话状态（直接打开地址、会话列表还没回来）时也先不取，免得连不上的会话先发出一次。
 */
export function useResearch(id: string, session: Session | undefined | null) {
  const [research, setResearch] = useState<Research | null>(null);
  const known = session !== undefined && session !== null;
  const unreachable = session?.state === "unreachable";
  useEffect(() => {
    if (!known || unreachable) return;
    let alive = true;
    api
      .research(id)
      .then((r) => alive && setResearch(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, known, unreachable]);
  return [research, setResearch] as const;
}

/**
 * 会话的正文：代理终端、已退出的提示和输入条；已结束、连不上时是空状态。单会话页和分屏的小窗共用（compact：小窗里的紧凑输入条）。
 * primary：“接续”“重新启动”用不用主按钮样式。分屏里只有焦点格用，其余格用次要样式，同屏最多一个 primary（分屏稿 12.8）。
 * autoFocus：代理终端连上时拿不拿键盘焦点（分屏稿 15.1 第 1、2 条，见 Terminal.tsx 的 AutoFocus）。单会话页 true；
 * 分屏里焦点格 "polite"、非焦点格 false。
 */
export function AgentBody({
  session,
  agent,
  server,
  termRef,
  barRef,
  compact,
  autoFocus = true,
  onOutput,
  primary = true,
}: {
  session: Session;
  agent: Agent | undefined;
  server: Server | undefined;
  termRef: RefObject<TermHandle | null>;
  barRef: RefObject<BarHandle | null>;
  compact?: boolean;
  autoFocus?: AutoFocus;
  onOutput?: () => void;
  primary?: boolean;
}) {
  const setSession = useApp((s) => s.setSession);
  const fail = useApp((s) => s.fail);
  const [termEpoch, setTermEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const attachable = session.state === "running" || session.state === "exited" || session.state === "unknown";
  // 页面打开时就挂着的终端第一次连上时按 autoFocus 拿键盘焦点；从“连不上”恢复、点“接续”“从头开始”之后重挂都算之后的连上（15.1 第 2 条）
  const termFocus = useTermFocus(autoFocus, attachable);

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

  return attachable ? (
    <>
      <div className="agent-term" onClick={() => termRef.current?.focus()}>
        <TerminalView key={termEpoch} ref={termRef} target={{ session: session.id, pane: "agent" }} autoFocus={termFocus} onOutput={onOutput} />
      </div>
      {session.state === "exited" && (
        <Notice
          className="pane-notice"
          action={
            <Button size="sm" variant={primary ? "primary" : "secondary"} icon={<RotateCw size={ICON.sm} />} loading={busy} onClick={() => void restart(true)}>
              {agent?.resume ? "接续" : "重新启动"}
            </Button>
          }
        >
          Agent 已退出{session.exit_status !== null ? `（退出码 ${session.exit_status}）` : ""}，终端还在。
        </Notice>
      )}
      <MessageBar ref={barRef} session={session} compact={compact} />
    </>
  ) : session.state === "stopped" ? (
    <Empty icon={<Play size={ICON.lg} />} title="会话已结束" hint={agent?.resume ? "接续会在原来的工作目录里重新启动 Agent，并接上次的对话。" : "重新启动会在原来的工作目录里再开一个 Agent。"}>
      <Button variant={primary ? "primary" : "secondary"} size="lg" loading={busy} icon={<RotateCw size={ICON.md} />} onClick={() => void restart(true)}>
        {agent?.resume ? "接续" : "重新启动"}
      </Button>
      {agent?.resume && (
        <Button size="lg" variant="ghost" disabled={busy} onClick={() => void restart(false)}>
          从头开始
        </Button>
      )}
    </Empty>
  ) : (
    <Empty icon={<WifiOff size={ICON.lg} />} title={`连不上 ${session.server_alias}`} hint={server?.status_detail ?? "服务器这次没连上。确认机器开着、网络通，再重试。"}>
      <Button loading={busy} onClick={() => void recheck()}>
        重试
      </Button>
      <Button variant="ghost" onClick={() => go("/servers")}>
        检查服务器
      </Button>
    </Empty>
  );
}

/**
 * 面板（代码里叫 Workspace）：概览、终端、文件、改动、产物、科研几个标签页。单会话页右边那一栏；分屏时是网格右侧的共享面板，跟随焦点格。
 * 标签页第一次打开时才挂上，之后切走只是藏起来。
 * “终端”页的终端（面板终端）连上、重连都不自己拿键盘焦点；用户每点一次“终端”标签就把键盘焦点交给它，不管它是不是已经挂着、
 * 面板是不是本来就停在这一页（分屏稿 15.1 第 3 条；单会话页和分屏一样）。
 */
export function Workspace({
  session,
  server,
  agent,
  tab,
  opened,
  onPick,
  research,
  onResearch,
  focusRun,
  onRun,
  onCompose,
  onQuote,
}: {
  session: Session;
  server: Server | undefined;
  agent: Agent | undefined;
  tab: Tab;
  opened: Set<Tab>;
  onPick: (t: Tab) => void;
  research: Research | null;
  onResearch: (r: Research) => void;
  focusRun: { id: string; n: number } | null;
  onRun: (runId: string) => void;
  onCompose: (text: string) => void;
  onQuote: (q: Quoted) => void;
}) {
  // 点“终端”标签：这次提交之后（第一次点时面板终端刚挂上）把键盘焦点交给面板终端。xterm 没连上也能拿焦点，连上时焦点还在那里
  const shellRef = useRef<TermHandle | null>(null);
  const [askShell, setAskShell] = useState(0);
  useEffect(() => {
    if (askShell) shellRef.current?.focus();
  }, [askShell]);
  const pick = (t: Tab) => {
    onPick(t);
    if (t === "shell") setAskShell((n) => n + 1);
  };
  return (
    <>
      <Tabs label="面板" className="workspace-tabs" data-tabs="workspace" value={tab} onChange={pick} items={TABS} />
      <div className="tab-body">
        {opened.has("overview") && (
          <div className={cx("fill", tab !== "overview" && "hidden")}>
            <OverviewPanel session={session} server={server} agent={agent} active={tab === "overview"} />
          </div>
        )}
        {opened.has("shell") && (
          <div className={cx("fill", tab !== "shell" && "hidden")}>
            {session.state === "unreachable" ? <Empty icon={<WifiOff size={ICON.lg} />} title="服务器连不上" hint="连上之后这里是工作目录里的一个 shell。" /> : <TerminalView ref={shellRef} target={{ session: session.id, pane: "shell" }} />}
          </div>
        )}
        {opened.has("files") && (
          <div className={cx("fill", tab !== "files" && "hidden")}>
            <FilesPanel session={session} active={tab === "files"} onQuote={onQuote} />
          </div>
        )}
        {opened.has("changes") && (
          <div className={cx("fill", tab !== "changes" && "hidden")}>
            <GitPanel session={session} active={tab === "changes"} />
          </div>
        )}
        {opened.has("artifacts") && (
          <div className={cx("fill", tab !== "artifacts" && "hidden")}>
            <ArtifactsPanel session={session} active={tab === "artifacts"} runs={research?.runs ?? []} onQuote={onQuote} onRun={onRun} />
          </div>
        )}
        {opened.has("research") && (
          <div className={cx("fill", tab !== "research" && "hidden")}>
            <ResearchPanel session={session} active={tab === "research"} focusRun={focusRun} onCompose={onCompose} onQuote={onQuote} onData={onResearch} />
          </div>
        )}
      </div>
    </>
  );
}

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
const MessageBar = forwardRef<BarHandle, { session: Session; compact?: boolean }>(function MessageBar({ session, compact }, ref) {
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
  const filled = Boolean(text.trim()) || refs.length > 0;
  return (
    <div className="message-bar" data-off={enabled ? undefined : ""} data-compact={compact ? "" : undefined}>
      {refs.length > 0 && (
        <div className="msgbar-refs">
          {refs.map((r, i) => (
            <Badge key={i} title={r.text ?? r.path}>
              <Paperclip size={ICON.xs} />
              <span className="ellipsis">{r.path.split("/").pop()}</span>
              {r.text && <span className="muted">{r.text.split("\n").length} 行</span>}
              <IconButton size="xs" label="移除" onClick={() => setRefs((prev) => prev.filter((_, k) => k !== i))}>
                <X size={ICON.xs} />
              </IconButton>
            </Badge>
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
          aria-label="发给 Agent 的消息"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {/* 有内容时是主要按钮，空着时是 ghost（空着发送等于按一次回车） */}
        <Tip label="发送 ↵" side="top">
          <button type="button" className="icon-button msg-send" data-filled={filled ? "" : undefined} disabled={!enabled || sending} onClick={() => void send()} aria-label="发送">
            <ArrowUp size={ICON.md} />
          </button>
        </Tip>
      </div>
      {/* 按键（Esc、⌃C……往终端里发）常显：终端卡住时不用先点输入框（分屏稿 13.5：不另加说明文字） */}
      <div className="msgbar-keys">
        {QUICK_KEYS.map((k) => (
          <Tip key={k.label} label={k.tip} side="top">
            <Button size="xs" variant="ghost" disabled={!enabled} onClick={() => void api.sendKeys(session.id, k.keys).catch(fail)}>
              {k.label}
            </Button>
          </Tip>
        ))}
      </div>
    </div>
  );
});
