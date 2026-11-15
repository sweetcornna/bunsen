import * as Dialog from "@radix-ui/react-dialog";
import { FolderGit2, Moon, Plus, RefreshCw, Search, Server as ServerIcon, Settings as SettingsIcon, Sun } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { serverAddr, serverStatus, sessionState } from "../lib/format";
import { go } from "../lib/route";
import { projectLabel, useApp } from "../lib/store";
import { AgentMark, Dot, ICON, Row, ScrollArea } from "./ui";

type Item = { key: string; label: string; hint?: string; icon: ReactNode; run: () => void };

/** 选会话模式（分屏的 Ctrl+Mod+\、Ctrl+Mod+-）：只列没归档的对话，选中的交给 onPick。 */
export type PalettePick = { title: string; placeholder: string; onPick: (sessionId: string) => void };

/** ⌘K：跳到任何一个对话、服务器或动作。pick：复用同一个面板选一个会话（在分屏中打开）。 */
export function Palette({ open, onOpenChange, pick: chooser }: { open: boolean; onOpenChange: (v: boolean) => void; pick?: PalettePick }) {
  const sessions = useApp((s) => s.sessions);
  const servers = useApp((s) => s.servers);
  const projects = useApp((s) => s.projects);
  const projectsReady = useApp((s) => s.projectsReady);
  const projectsLoaded = useApp((s) => s.projectsLoaded);
  const projectsMissing = useApp((s) => s.projectsMissing);
  const agents = useApp((s) => s.agents);
  const settings = useApp((s) => s.settings);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const st = useApp.getState();
    const dark = document.documentElement.dataset.theme !== "light";
    const sessionItem = (s: (typeof sessions)[number], run: () => void): Item => {
      const project = s.project_id ? projectLabel({ projects, projectsReady, projectsLoaded, projectsMissing }, s.project_id) : null;
      return {
        key: `s:${s.id}`,
        label: s.title,
        hint: `${sessionState(s.state).label} · ${s.server_alias} · ${s.workdir}${project ? ` · ${project}` : ""}`,
        icon: <AgentMark id={s.agent_id} name={agents.find((a) => a.id === s.agent_id)?.name} />,
        run,
      };
    };
    const q = query.trim().toLowerCase();
    const match = (list: Item[]) => (q ? list.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q)) : list);
    if (chooser) return match(sessions.filter((s) => !s.archived).map((s) => sessionItem(s, () => chooser.onPick(s.id))));
    const all: Item[] = [
      { key: "new", label: "新对话", icon: <Plus size={ICON.md} />, run: () => go("/") },
      { key: "projects", label: "研究项目", hint: "几台机器上的研究记录汇合后的全貌", icon: <FolderGit2 size={ICON.md} />, run: () => go("/projects") },
      { key: "servers", label: "服务器", hint: "导入 SSH 配置、测试、探测", icon: <ServerIcon size={ICON.md} />, run: () => go("/servers") },
      { key: "settings", label: "设置", icon: <SettingsIcon size={ICON.md} />, run: () => go("/settings") },
      { key: "refresh", label: "刷新所有对话的状态", icon: <RefreshCw size={ICON.md} />, run: () => void st.refreshSessions(true) },
      { key: "theme", label: dark ? "切换到浅色" : "切换到深色", icon: dark ? <Sun size={ICON.md} /> : <Moon size={ICON.md} />, run: () => void st.saveSettings({ theme: dark ? "light" : "dark" }) },
      ...projects.map((p) => ({
        key: `p:${p.id}`,
        label: p.name,
        hint: `研究项目 · ${p.branch}`,
        icon: <FolderGit2 size={ICON.md} />,
        run: () => go(`/p/${p.id}`),
      })),
      ...sessions.map((s) => sessionItem(s, () => go(`/s/${s.id}`))),
      ...servers.map((s) => ({
        key: `h:${s.id}`,
        label: `在 ${s.alias} 上开新对话`,
        hint: serverAddr(s),
        icon: <Dot tone={serverStatus(s.status).dot} label={serverStatus(s.status).label} />,
        run: () => {
          st.setDraft({ server_id: s.id });
          go("/");
        },
      })),
    ];
    return match(all);
    // settings 只为了主题切换后重算
  }, [query, sessions, servers, projects, projectsReady, projectsLoaded, projectsMissing, agents, settings, chooser]);

  const pick = (i: Item | undefined) => {
    if (!i) return;
    onOpenChange(false);
    i.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        {/* 选会话模式：关掉时不把焦点还给原处，分屏会把键盘焦点交给新开的那一格 */}
        <Dialog.Content className="palette surface-float" aria-describedby={undefined} data-palette-pick={chooser ? "" : undefined} onCloseAutoFocus={chooser ? (e) => e.preventDefault() : undefined}>
          <Dialog.Title className="sr-only">{chooser ? chooser.title : "搜索与跳转"}</Dialog.Title>
          <div className="palette-search">
            <Search size={ICON.md} />
            <input
              autoFocus
              value={query}
              placeholder={chooser ? chooser.placeholder : "搜索对话、服务器或动作…"}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(items.length - 1, c + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(0, c - 1));
                } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  pick(items[cursor]);
                }
              }}
            />
          </div>
          <ScrollArea className="palette-results">
            {items.length === 0 && <div className="menu-note">没有匹配的结果</div>}
            {items.map((i, idx) => (
              <PaletteRow key={i.key} item={i} on={idx === cursor} onHover={() => setCursor(idx)} onPick={() => pick(i)} />
            ))}
          </ScrollArea>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 一行：图标 · 名称 · 说明（右侧 muted）。键盘移到的那一行滚进可见区。 */
function PaletteRow({ item, on, onHover, onPick }: { item: Item; on: boolean; onHover: () => void; onPick: () => void }) {
  return (
    <div onMouseEnter={onHover} ref={on ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}>
      <Row density="nav" lead={item.icon} name={item.label} meta={item.hint} selected={on} onClick={onPick} data-palette-item={item.key} />
    </div>
  );
}
