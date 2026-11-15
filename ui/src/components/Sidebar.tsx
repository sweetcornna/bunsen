import { ChevronDown, ChevronRight, FolderGit2, MoreHorizontal, PanelLeftClose, Plus, RefreshCw, Search, Server as ServerIcon, Settings as SettingsIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { Session } from "../lib/api";
import { sessionState } from "../lib/format";
import { go, sessionHref, type Route } from "../lib/route";
import { startSessionDrag } from "../lib/splitStore";
import { agentOf, projectLabel, useApp } from "../lib/store";
import { SessionMenu } from "./SessionMenu";
import { Dot, ICON, IconButton, Logo, Row, ScrollArea, Spinner, When } from "./ui";

const stamp = (s: Session) => Date.parse(s.last_active_at ?? s.created_at) || 0;
const DAY = 86400_000;

export function Sidebar({ route, onCollapse, onPalette }: { route: Route; onCollapse: () => void; onPalette: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const servers = useApp((s) => s.servers);
  const projects = useApp((s) => s.projects);
  const projectsReady = useApp((s) => s.projectsReady);
  const refreshing = useApp((s) => s.refreshing);
  const refreshSessions = useApp((s) => s.refreshSessions);
  const [showArchived, setShowArchived] = useState(false);

  const groups = useMemo(() => {
    const live = sessions.filter((s) => !s.archived).sort((a, b) => stamp(b) - stamp(a));
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    const today = day.getTime();
    const rest = live.filter((s) => !s.pinned);
    const within = (from: number, to: number) => rest.filter((s) => stamp(s) >= from && stamp(s) < to);
    return [
      { key: "pinned", label: "置顶", items: live.filter((s) => s.pinned) },
      { key: "today", label: "今天", items: within(today, Infinity) },
      { key: "yesterday", label: "昨天", items: within(today - DAY, today) },
      { key: "week", label: "过去 7 天", items: within(today - 7 * DAY, today - DAY) },
      { key: "older", label: "更早", items: within(-Infinity, today - 7 * DAY) },
    ].filter((g) => g.items.length > 0);
  }, [sessions]);
  const archived = useMemo(() => sessions.filter((s) => s.archived).sort((a, b) => stamp(b) - stamp(a)), [sessions]);
  const online = servers.filter((s) => s.status === "online").length;
  const activeId = route.name === "session" ? route.id : null;

  return (
    <aside className="sidebar">
      <div className="side-head">
        <button type="button" className="brand" onClick={() => go("/")}>
          <Logo size={18} />
          <span>Bunsen</span>
        </button>
        <IconButton label="刷新会话状态" onClick={() => void refreshSessions(true)} disabled={refreshing}>
          {refreshing ? <Spinner size={ICON.md} /> : <RefreshCw size={ICON.md} />}
        </IconButton>
        <IconButton label="收起侧栏" onClick={onCollapse}>
          <PanelLeftClose size={ICON.md} />
        </IconButton>
      </div>

      <nav className="side-nav" aria-label="动作">
        <Row density="nav" lead={<Plus size={ICON.md} />} name="新对话" meta={<kbd>⌘N</kbd>} selected={route.name === "new"} onClick={() => go("/")} />
        <Row density="nav" lead={<Search size={ICON.md} />} name="搜索" meta={<kbd>⌘K</kbd>} onClick={onPalette} />
      </nav>

      <ScrollArea className="side-list" role="navigation" aria-label="云端对话">
        {groups.length === 0 && archived.length === 0 && <div className="empty-line side-section">还没有对话</div>}
        {groups.map((g) => (
          <section key={g.key} className="side-section">
            <h3 className="group-title">{g.label}</h3>
            {g.items.map((s) => (
              <SessionRow key={s.id} session={s} active={s.id === activeId} />
            ))}
          </section>
        ))}
        {archived.length > 0 && (
          <section className="side-section">
            <button type="button" className="group-title" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived}>
              {showArchived ? <ChevronDown size={ICON.xs} /> : <ChevronRight size={ICON.xs} />}
              已归档 {archived.length}
            </button>
            {showArchived && archived.map((s) => <SessionRow key={s.id} session={s} active={s.id === activeId} />)}
          </section>
        )}
      </ScrollArea>

      <nav className="side-foot" aria-label="页面">
        <Row
          density="nav"
          lead={<FolderGit2 size={ICON.md} />}
          name="研究项目"
          meta={projects.length > 0 ? `${projects.length} 个` : projectsReady ? "未建" : ""}
          selected={route.name === "projects" || route.name === "project"}
          onClick={() => go("/projects")}
        />
        <Row
          density="nav"
          lead={<ServerIcon size={ICON.md} />}
          name="服务器"
          meta={servers.length === 0 ? "未添加" : `${online}/${servers.length} 在线`}
          selected={route.name === "servers"}
          onClick={() => go("/servers")}
        />
        <Row density="nav" lead={<SettingsIcon size={ICON.md} />} name="设置" selected={route.name === "settings"} onClick={() => go("/settings")} />
      </nav>
    </aside>
  );
}

function SessionRow({ session, active }: { session: Session; active: boolean }) {
  const agents = useApp((s) => s.agents);
  const project = useApp((s) => (session.project_id ? projectLabel(s, session.project_id) : null));
  const agent = agentOf(agents, session.agent_id);
  const st = sessionState(session.state);
  const tip = `${session.title}\n${st.label} · ${agent?.name ?? session.agent_id} · ${session.server_alias}:${session.workdir}${project ? `\n研究项目 ${project}${session.machine ? ` · 机器 ${session.machine}` : ""}` : ""}`;
  // 右键打开同一个“更多”菜单；拖进会话页在分屏中打开（分屏稿第 5 节）
  const [menu, setMenu] = useState(false);
  return (
    <Row
      density="nav"
      data-session={session.id}
      selected={active}
      href={sessionHref(session.id)}
      title={tip}
      onDragStart={(e) => startSessionDrag(e, session.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
      // 状态点只给“运行中”和“连不上”；其他状态留出同样的位置，标题对齐
      lead={st.dot ? <Dot tone={st.dot} label={st.label} /> : <span />}
      name={session.title}
      meta={<When iso={session.last_active_at ?? session.created_at} />}
      tail={
        <SessionMenu session={session} split open={menu} onOpenChange={setMenu}>
          <IconButton label="更多" size="sm">
            <MoreHorizontal size={ICON.sm} />
          </IconButton>
        </SessionMenu>
      }
    />
  );
}
