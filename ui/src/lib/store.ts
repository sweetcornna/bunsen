import { create } from "zustand";
import { api, asApiError, type Agent, type KeyInfo, type Meta, type Plugin, type Server, type Session, type Settings } from "./api";

export type Toast = { id: number; tone: "info" | "ok" | "err"; text: string; hint?: string | null };
export type Draft = { server_id?: string; agent_id?: string; prompt?: string };

type AppState = {
  boot: "loading" | "ready" | "unauthorized" | "offline";
  bootDetail: string | null;
  meta: Meta | null;
  settings: Settings | null;
  agents: Agent[];
  plugins: Plugin[];
  servers: Server[];
  sessions: Session[];
  keys: KeyInfo[];
  refreshing: boolean;
  draft: Draft | null;
  toasts: Toast[];

  init: () => Promise<void>;
  refreshSessions: (remote?: boolean) => Promise<void>;
  loadServers: () => Promise<void>;
  loadKeys: () => Promise<void>;
  loadAgents: () => Promise<void>;
  loadPlugins: () => Promise<void>;
  setSession: (s: Session) => void;
  dropSession: (id: string) => void;
  setServer: (s: Server) => void;
  dropServer: (id: string) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  setDraft: (d: Draft | null) => void;
  toast: (tone: Toast["tone"], text: string, hint?: string | null) => void;
  fail: (e: unknown) => void;
  dismiss: (id: number) => void;
};

let toastSeq = 1;

export const useApp = create<AppState>((set, get) => ({
  boot: "loading",
  bootDetail: null,
  meta: null,
  settings: null,
  agents: [],
  plugins: [],
  servers: [],
  sessions: [],
  keys: [],
  refreshing: false,
  draft: null,
  toasts: [],

  init: async () => {
    try {
      const [meta, settings, agents, servers, sessions, keys] = await Promise.all([
        api.meta(),
        api.settings(),
        api.agents(),
        api.servers(),
        api.sessions(false),
        api.keys(),
      ]);
      set({ boot: "ready", bootDetail: null, meta, settings, agents, servers, sessions, keys });
      void get().loadPlugins();
      void get().refreshSessions(true);
    } catch (e) {
      const err = asApiError(e);
      set({
        boot: err.code === "unauthorized" || err.code === "forbidden" ? "unauthorized" : "offline",
        bootDetail: err.message,
      });
    }
  },

  refreshSessions: async (remote = true) => {
    if (get().refreshing) return;
    set({ refreshing: true });
    try {
      const sessions = await api.sessions(remote);
      set({ sessions });
      if (remote) set({ servers: await api.servers() });
    } catch (e) {
      // 后台刷新失败不打扰；手动刷新的失败由调用方提示。
      if (!remote) get().fail(e);
    } finally {
      set({ refreshing: false });
    }
  },

  loadServers: async () => set({ servers: await api.servers() }),
  loadKeys: async () => set({ keys: await api.keys() }),
  loadAgents: async () => set({ agents: await api.agents() }),
  loadPlugins: async () => {
    try {
      set({ plugins: await api.plugins() });
    } catch {
      set({ plugins: [] });
    }
  },

  setSession: (s) =>
    set((st) => ({
      sessions: st.sessions.some((x) => x.id === s.id) ? st.sessions.map((x) => (x.id === s.id ? s : x)) : [s, ...st.sessions],
    })),
  dropSession: (id) => set((st) => ({ sessions: st.sessions.filter((x) => x.id !== id) })),
  setServer: (s) =>
    set((st) => ({
      servers: st.servers.some((x) => x.id === s.id) ? st.servers.map((x) => (x.id === s.id ? s : x)) : [...st.servers, s],
    })),
  dropServer: (id) => set((st) => ({ servers: st.servers.filter((x) => x.id !== id) })),

  saveSettings: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    const next = { ...cur, ...patch };
    set({ settings: next });
    try {
      set({ settings: await api.putSettings(next) });
    } catch (e) {
      set({ settings: cur });
      get().fail(e);
    }
  },

  setDraft: (draft) => set({ draft }),

  toast: (tone, text, hint) => {
    const id = toastSeq++;
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, tone, text, hint }] }));
    window.setTimeout(() => get().dismiss(id), tone === "err" ? 9000 : 3500);
  },
  fail: (e) => {
    const err = asApiError(e);
    get().toast("err", err.message, err.hint);
  },
  dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

export const agentOf = (agents: Agent[], id: string) => agents.find((a) => a.id === id);
export const serverOf = (servers: Server[], id: string) => servers.find((s) => s.id === id);
