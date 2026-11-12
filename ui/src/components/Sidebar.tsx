import { ChevronDown, ChevronRight, MoreHorizontal, PanelLeftClose, Plus, RefreshCw, Search, Server as ServerIcon, Settings as SettingsIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { Session } from "../lib/api";
import { SESSION_STATE, shortTime } from "../lib/format";
import { go, type Route } from "../lib/route";
import { agentOf, useApp } from "../lib/store";
import { SessionMenu } from "./SessionMenu";
import { cx, Dot, IconButton, Logo, Spinner } from "./ui";

const stamp = (s: Session) => Date.parse(s.last_active_at ?? s.created_at) || 0;
const DAY = 86400_000;

export function Sidebar({ route, onCollapse, onPalette }: { route: Route; onCollapse: () => void; onPalette: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const servers = useApp((s) => s.servers);
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
          {refreshing ? <Spinner size={13} /> : <RefreshCw size={14} />}
        </IconButton>
        <IconButton label="收起侧栏" onClick={onCollapse}>
          <PanelLeftClose size={15} />
        </IconButton>
      </div>

      <div className="side-actions">
        <button type="button" className={cx("side-new", route.name === "new" && "on")} onClick={() => go("/")}>
          <Plus size={14} />
          <span>新对话</span>
          <kbd>⌘N</kbd>
        </button>
        <button type="button" className="side-search" onClick={onPalette}>
          <Search size={13} />
          <span>搜索</span>
          <kbd>⌘K</kbd>
        </button>
      </div>

      <nav className="side-list" aria-label="云端对话">
        {groups.length === 0 && archived.length === 0 && (
          <div className="side-empty">
            还没有对话
          </div>
        )}
        {groups.map((g) => (
          <section key={g.key}>
            <h3 className="side-group">{g.label}</h3>
            {g.items.map((s) => (
              <SessionRow key={s.id} session={s} active={s.id === activeId} />
            ))}
          </section>
        ))}
        {archived.length > 0 && (
          <section>
            <button type="button" className="side-group as-button" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              已归档
              <span>{archived.length}</span>
            </button>
            {showArchived && archived.map((s) => <SessionRow key={s.id} session={s} active={s.id === activeId} />)}
          </section>
        )}
      </nav>

      <div className="side-foot">
        <button type="button" className={cx("side-link", route.name === "servers" && "on")} onClick={() => go("/servers")}>
          <ServerIcon size={14} />
          <span>服务器</span>
          <em>{servers.length === 0 ? "未添加" : `${online}/${servers.length} 在线`}</em>
        </button>
        <button type="button" className={cx("side-link", route.name === "settings" && "on")} onClick={() => go("/settings")}>
          <SettingsIcon size={14} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}

function SessionRow({ session, active }: { session: Session; active: boolean }) {
  const agents = useApp((s) => s.agents);
  const agent = agentOf(agents, session.agent_id);
  const st = SESSION_STATE[session.state];
  const running = session.state === "running";
  return (
    <div className={cx("side-row", active && "on")}>
      <button type="button" className="side-row-main" onClick={() => go(`/s/${session.id}`)} title={`${session.title}\n${st.label} · ${agent?.name ?? session.agent_id} · ${session.server_alias}:${session.workdir}`}>
        <Dot tone={st.tone} pulse={running} />
        <span className="side-row-title">{session.title}</span>
        <span className="side-row-time">{shortTime(session.last_active_at ?? session.created_at)}</span>
      </button>
      <SessionMenu session={session}>
        <button type="button" className="icon-btn side-row-more" aria-label="更多">
          <MoreHorizontal size={14} />
        </button>
      </SessionMenu>
    </div>
  );
}
