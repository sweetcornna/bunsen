import * as Dialog from "@radix-ui/react-dialog";
import { Moon, Plus, RefreshCw, Search, Server as ServerIcon, Settings as SettingsIcon, Sun } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SESSION_STATE } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";
import { AgentMark, cx, Dot } from "./ui";

type Item = { key: string; label: string; hint?: string; icon: ReactNode; run: () => void };

/** ⌘K：跳到任何一个对话、服务器或动作。 */
export function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const sessions = useApp((s) => s.sessions);
  const servers = useApp((s) => s.servers);
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
    const all: Item[] = [
      { key: "new", label: "新对话", icon: <Plus size={14} />, run: () => go("/") },
      { key: "servers", label: "服务器", hint: "导入 SSH 配置、测试、探测", icon: <ServerIcon size={14} />, run: () => go("/servers") },
      { key: "settings", label: "设置", icon: <SettingsIcon size={14} />, run: () => go("/settings") },
      { key: "refresh", label: "刷新所有对话的状态", icon: <RefreshCw size={14} />, run: () => void st.refreshSessions(true) },
      { key: "theme", label: dark ? "切换到浅色" : "切换到深色", icon: dark ? <Sun size={14} /> : <Moon size={14} />, run: () => void st.saveSettings({ theme: dark ? "light" : "dark" }) },
      ...sessions.map((s) => ({
        key: `s:${s.id}`,
        label: s.title,
        hint: `${SESSION_STATE[s.state].label} · ${s.server_alias} · ${s.workdir}`,
        icon: <AgentMark id={s.agent_id} name={agents.find((a) => a.id === s.agent_id)?.name} />,
        run: () => go(`/s/${s.id}`),
      })),
      ...servers.map((s) => ({
        key: `h:${s.id}`,
        label: `在 ${s.alias} 上开新对话`,
        hint: `${s.user}@${s.host}`,
        icon: <Dot tone={s.status === "online" ? "ok" : s.status === "unknown" ? "mute" : "err"} />,
        run: () => {
          st.setDraft({ server_id: s.id });
          go("/");
        },
      })),
    ];
    const q = query.trim().toLowerCase();
    return q ? all.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q)) : all;
    // settings 只为了主题切换后重算
  }, [query, sessions, servers, agents, settings]);

  const pick = (i: Item | undefined) => {
    if (!i) return;
    onOpenChange(false);
    i.run();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="palette" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">搜索与跳转</Dialog.Title>
          <div className="palette-input">
            <Search size={15} />
            <input
              autoFocus
              value={query}
              placeholder="搜索对话、服务器或动作…"
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
          <div className="palette-list">
            {items.length === 0 && <div className="menu-empty">没有匹配的结果</div>}
            {items.map((i, idx) => (
              <button key={i.key} type="button" className={cx("palette-item", idx === cursor && "on")} onMouseEnter={() => setCursor(idx)} onClick={() => pick(i)} ref={idx === cursor ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}>
                <span className="menu-icon">{i.icon}</span>
                <span className="ellipsis">{i.label}</span>
                {i.hint && <span className="dim ellipsis palette-hint">{i.hint}</span>}
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
