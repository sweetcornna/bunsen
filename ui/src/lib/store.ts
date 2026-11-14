import { useEffect } from "react";
import { create } from "zustand";
import { api, asApiError, type Agent, type ApiError, type KeyInfo, type Meta, type MemberSync, type Plugin, type Project, type ProjectMember, type ProjectView, type Server, type Session, type Settings } from "./api";
import { hasKey, isLocal } from "./format";
import { currentRoute, projectHref } from "./route";

export type Toast = { id: number; tone: "info" | "ok" | "err"; text: string; hint?: string | null; link?: { label: string; href: string } };
export type Draft = { server_id?: string; agent_id?: string; prompt?: string; project_id?: string };
/** 一个项目最近一次“立即同步”：只留最新一次。at 是完成的时间（毫秒），还没完成过为 0。 */
export type ProjectSyncState = { running: boolean; at: number; members: MemberSync[] | null; view: ProjectView | null; error: ApiError | null };
const NO_SYNC: ProjectSyncState = { running: false, at: 0, members: null, view: null, error: null };

type AppState = {
  boot: "loading" | "ready" | "unauthorized" | "offline";
  bootDetail: string | null;
  meta: Meta | null;
  settings: Settings | null;
  agents: Agent[];
  plugins: Plugin[];
  servers: Server[];
  sessions: Session[];
  projects: Project[];
  /** 项目列表至少取过一次（没取到之前不能断定某个项目已删除） */
  projectsReady: boolean;
  /** 上次采纳的项目列表是第几次请求取到的（0：还没取到过） */
  projectsLoaded: number;
  /** 上次取项目列表失败的原因；列表和 projectsReady 保持失败前的样子，取成功后清空 */
  projectsError: { message: string; hint: string | null } | null;
  /**
   * 会话引用了、列表里却没有的项目 → 发现时已经发出过几次列表请求。之后发出的请求取回的列表里还没有，才算已删除
   * （项目可能是在命令行或 MCP 里刚建的，手上的列表是旧的）。-1：确知已删除（在这里删的，或服务端说没有）。
   */
  projectsMissing: Record<string, number>;
  syncs: Record<string, ProjectSyncState>;
  keys: KeyInfo[];
  refreshing: boolean;
  draft: Draft | null;
  toasts: Toast[];

  init: () => Promise<void>;
  refreshSessions: (remote?: boolean) => Promise<void>;
  loadServers: () => Promise<void>;
  loadProjects: () => Promise<void>;
  noteMissingProjects: (ids: string[]) => void;
  setProject: (p: Project) => void;
  dropProject: (id: string) => void;
  syncProject: (id: string) => Promise<void>;
  clearSync: (id: string) => void;
  loadKeys: () => Promise<void>;
  loadAgents: () => Promise<void>;
  loadPlugins: () => Promise<void>;
  setSession: (s: Session) => void;
  dropSession: (id: string) => void;
  setServer: (s: Server) => void;
  dropServer: (id: string) => void;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  setDraft: (d: Draft | null) => void;
  toast: (tone: Toast["tone"], text: string, hint?: string | null, link?: Toast["link"]) => void;
  fail: (e: unknown) => void;
  dismiss: (id: number) => void;
};

let toastSeq = 1;
// 项目列表的请求编号：只采纳最新一次请求的结果，晚到的旧响应丢掉。
let projectsReq = 0;
// 在这里新建（setProject 加进来的）或删除的项目 → 当时已经发出过几次列表请求。在那之前发出的请求取回的列表
// 还不知道这次改动：新建的补进去、删掉的去掉；之后发出的请求取回的列表以它为准，记录随之作废。
const localEdits = new Map<string, { at: number; added: boolean }>();
// 第一次取项目列表就失败时按退避自动重试几次；之后靠窗口重新获得焦点或手动重试。
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
let retryTimer: number | undefined;
let retryCount = 0;

export const useApp = create<AppState>((set, get) => ({
  boot: "loading",
  bootDetail: null,
  meta: null,
  settings: null,
  agents: [],
  plugins: [],
  servers: [],
  sessions: [],
  projects: [],
  projectsReady: false,
  projectsLoaded: 0,
  projectsError: null,
  projectsMissing: {},
  syncs: {},
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
      void get().loadProjects();
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
  loadProjects: async () => {
    const n = ++projectsReq;
    const take = (fetched: Project[]) => {
      if (n !== projectsReq) return;
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      retryCount = 0;
      let projects = fetched;
      for (const [id, e] of localEdits) {
        if (n > e.at) localEdits.delete(id);
        else if (!e.added) projects = projects.filter((x) => x.id !== id);
        else {
          const mine = projectOf(get().projects, id);
          if (mine && !projectOf(projects, id)) projects = [...projects, mine];
        }
      }
      set({ projects, projectsReady: true, projectsLoaded: n, projectsError: null });
    };
    try {
      take(await api.projects());
    } catch (e) {
      const err = asApiError(e);
      // 旧版服务端没有项目接口：未知的 /api 路由回 404 not_found，当作没有项目。
      if (err.status === 404 && err.code === "not_found") return take([]);
      if (n !== projectsReq) return;
      // 其余（连不上、服务端出错）不能断定没有项目：列表保持原样，只记下原因。
      set({ projectsError: { message: err.message, hint: err.hint } });
      if (!get().projectsReady && retryTimer === undefined && retryCount < RETRY_MS.length) {
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          void get().loadProjects();
        }, RETRY_MS[retryCount++]);
      }
    }
  },
  noteMissingProjects: (ids) => {
    const st = get();
    const fresh = ids.filter((id) => !hasKey(st.projectsMissing, id) && !projectOf(st.projects, id));
    if (fresh.length === 0) return;
    set({ projectsMissing: { ...st.projectsMissing, ...Object.fromEntries(fresh.map((id) => [id, projectsReq])) } });
    void get().loadProjects();
  },
  setProject: (p) =>
    set((st) => {
      if (!projectOf(st.projects, p.id)) localEdits.set(p.id, { at: projectsReq, added: true });
      // 确知它在：撤掉“找不到”的记录，免得之后一份旧列表把它判成已删除。
      const missing = { ...st.projectsMissing };
      delete missing[p.id];
      return {
        projects: st.projects.some((x) => x.id === p.id) ? st.projects.map((x) => (x.id === p.id ? p : x)) : [...st.projects, p],
        projectsMissing: missing,
      };
    }),
  dropProject: (id) => {
    localEdits.set(id, { at: projectsReq, added: false });
    set((st) => ({ projects: st.projects.filter((x) => x.id !== id), projectsMissing: { ...st.projectsMissing, [id]: -1 } }));
  },

  syncProject: async (id) => {
    if (get().syncs[id]?.running) return;
    const name = projectOf(get().projects, id)?.name ?? id;
    const put = (patch: Partial<ProjectSyncState>) =>
      set((st) => ({ syncs: { ...st.syncs, [id]: { ...(st.syncs[id] ?? NO_SYNC), ...patch } } }));
    // 同步可能要几分钟，完成时用户可能已经离开项目页：还在就照常提示，不在了就提示里带上项目名和回去的链接。
    const here = () => {
      const r = currentRoute();
      return r.name === "project" && findProject(get().projects, r.id)?.id === id;
    };
    put({ running: true, members: null, error: null }); // 上一轮的结果不再显示
    try {
      const r = await api.syncProject(id);
      if (projectOf(get().projects, id)) get().setProject(r.view.project);
      put({ running: false, at: Date.now(), members: r.members, view: r.view, error: null });
      const link = here() ? undefined : { label: "查看同步结果", href: projectHref(id) };
      const who = link ? `${name}：` : "";
      const bad = r.members.filter((m) => !m.ok).length;
      // 服务器不在了的成员会话不同步（契约 3.2），members 里没有它们：和“真没有成员”分开说。
      const skipped = syncSkipped(r.members, r.view);
      const why = skipped.length > 0 ? `${skipped.length} 个对话没有同步：${skipReason(skipped)}` : null;
      const also = skipped.length > 0 ? `，${skipped.length} 个跳过` : "";
      if (r.members.length === 0 && skipped.length === 0) get().toast("info", `${who}还没有接入这个项目的对话`, null, link);
      else if (r.members.length === 0) get().toast("err", `${who}没有同步任何对话：接入的 ${skipped.length} 个对话所在的服务器都不可用`, skipReason(skipped), link);
      else if (bad === 0) get().toast(skipped.length > 0 ? "info" : "ok", `${who}${r.members.length} 个对话都已同步${also}`, why, link);
      else get().toast("err", `${who}${bad} 个对话没同步完${also}`, link ? why : ["看下面的同步结果", why].filter(Boolean).join("；"), link);
    } catch (e) {
      const err = asApiError(e);
      const away = !here();
      put({ running: false, at: Date.now(), members: null, view: null, error: err });
      if (err.code === "not_found" && err.status === 404) {
        // 在本页删掉的项目（projectsMissing 为 -1）同步回来找不到是意料之中，不提示；
        // 还在项目页上时页面会换成“没有这个研究项目”，也不用提示。
        const deletedHere = get().projectsMissing[id] === -1;
        get().dropProject(id);
        if (away && !deletedHere) get().toast("err", `研究项目 ${name} 已经不在了`, err.hint);
      } else {
        get().toast("err", away ? `${name} 同步失败：${err.message}` : err.message, err.hint, away ? { label: "打开项目", href: projectHref(id) } : undefined);
      }
    }
  },
  clearSync: (id) => set((st) => (st.syncs[id] ? { syncs: { ...st.syncs, [id]: { ...st.syncs[id], members: null } } } : {})),

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

  toast: (tone, text, hint, link) => {
    const id = toastSeq++;
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, tone, text, hint, link }] }));
    window.setTimeout(() => get().dismiss(id), tone === "err" || link ? 9000 : 3500);
  },
  fail: (e) => {
    const err = asApiError(e);
    get().toast("err", err.message, err.hint);
  },
  dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
}));

// 会话引用了列表里没有的项目：先记下来、重取一次列表再下结论（Sidebar、Palette、会话页都靠这里）。
useApp.subscribe((st, prev) => {
  if (!st.projectsReady || (st.sessions === prev.sessions && st.projects === prev.projects && st.projectsReady === prev.projectsReady)) return;
  const ids = new Set<string>();
  for (const s of st.sessions) if (s.project_id && !projectOf(st.projects, s.project_id) && !hasKey(st.projectsMissing, s.project_id)) ids.add(s.project_id);
  if (ids.size > 0) st.noteMissingProjects([...ids]);
});

export const agentOf = (agents: Agent[], id: string) => agents.find((a) => a.id === id);
export const serverOf = (servers: Server[], id: string) => servers.find((s) => s.id === id);
export const projectOf = (projects: Project[], id: string | null | undefined) => (id ? projects.find((p) => p.id === id) : undefined);
/** 按地址里写的 id 或名称找项目：先按 id，找不到再按名称（契约 3.2【G8】）。 */
export const findProject = (projects: Project[], key: string) => projects.find((p) => p.id === key) ?? projects.find((p) => p.name === key);

export const DELETED_PROJECT = "（已删除的项目）";
type ProjectsSlice = Pick<AppState, "projects" | "projectsReady" | "projectsLoaded" | "projectsMissing">;
/**
 * 会话的 project_id 对应什么：找到了就是那个项目；还不能下结论时是 "pending"（列表没取到过，或者发现找不到之后还没重取过）；
 * 重取过还找不到才是 "deleted"（契约 3.2：前端把找不到的项目显示为“（已删除的项目）”）。
 */
export function projectRef(st: ProjectsSlice, id: string): Project | "pending" | "deleted" {
  const p = projectOf(st.projects, id);
  if (p) return p;
  const since = st.projectsMissing[id];
  return st.projectsReady && since !== undefined && st.projectsLoaded > since ? "deleted" : "pending";
}
/** 一行文字里怎么称呼会话接入的项目：项目名；还不能下结论时先写 id；已删除时写“（已删除的项目）”。 */
export function projectLabel(st: ProjectsSlice, id: string): string {
  const r = projectRef(st, id);
  return r === "pending" ? id : r === "deleted" ? DELETED_PROJECT : r.name;
}

export { isLocal };

/**
 * “立即同步”跳过的成员会话：视图里列着、同步结果里没有的。服务端只同步所在服务器还在的会话（契约 3.2），
 * 服务器已删除、本机停用（BUNSEN_NO_LOCAL=1，本机上的会话按“服务器已删除”处理【G15】）的都不在结果里。
 */
export function syncSkipped(members: MemberSync[], view: ProjectView): ProjectMember[] {
  const done = new Set(members.map((m) => m.session_id));
  return view.members.filter((m) => !done.has(m.session_id));
}
/** 一个跳过的会话为什么没同步。本机的 id 固定为 local（契约第 1 节）。 */
export const skipWhy = (m: Pick<ProjectMember, "server_id" | "server_alias">) =>
  m.server_id === "local" ? "本机已停用（bunsen serve 用 BUNSEN_NO_LOCAL=1 启动）" : `服务器 ${m.server_alias} 已删除`;
/** 几个跳过的会话合起来的原因，例如“服务器 gpu-old 已删除；本机已停用（…）”。 */
export function skipReason(skipped: ProjectMember[]): string {
  return [...new Set(skipped.map(skipWhy))].join("；");
}

/**
 * 汇合点写成 <别名>:<路径> 时，它在哪台服务器上（契约 3.2、第 4 节）。
 * 返回 null：是普通 git 地址（含 git@github.com:… 和 https://…），各台机器都能访问。
 * 别名按第一个冒号切；含 / 或 @ 的、对不上任何服务器的都当作 git 地址（服务端同样这么处理）。
 * local 永远指本机，即使有台远程服务器叫 local；本机改过别名时，新别名也指本机【G3】。
 * 没有本机记录（BUNSEN_NO_LOCAL=1）时 local 照样指本机，server 为 null。
 */
export function hubServer(hub: string, servers: Server[]): { alias: string; server: Server | null; local: boolean } | null {
  const h = hub.trim();
  const i = h.indexOf(":");
  if (i <= 0 || h.includes("://")) return null;
  const alias = h.slice(0, i);
  if (/[/@]/.test(alias) || !h.slice(i + 1)) return null;
  if (alias === "local") return { alias, server: servers.find((s) => isLocal(s)) ?? null, local: true };
  const server = servers.find((s) => s.alias === alias);
  return server ? { alias, server, local: isLocal(server) } : null;
}

/** 会话接入的项目。列表里没有时记下来重取一次（项目可能是在命令行里建的），重取后还没有才算已删除。 */
export function useProject(id: string): Project | "pending" | "deleted" {
  const ref = useApp((s) => projectRef(s, id));
  const ready = useApp((s) => s.projectsReady);
  useEffect(() => {
    if (ready && ref === "pending") useApp.getState().noteMissingProjects([id]);
  }, [id, ready, ref]);
  return ref;
}
