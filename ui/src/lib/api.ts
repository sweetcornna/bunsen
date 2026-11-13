// 与 docs/API.md 一一对应的类型和请求封装。

export type Agent = {
  id: string;
  name: string;
  vendor: string;
  description: string;
  detect: string;
  launch: string;
  launch_with_prompt: string | null;
  resume: string | null;
  yolo_flag: string | null;
  plugin_dir_flag: string | null;
  plugin_prompt?: string | null;
  install: { label: string; cmd: string }[];
  auth_hint: string;
  docs_url: string;
  builtin: boolean;
};

export type Gpu = {
  index: number;
  name: string;
  mem_used_mb: number;
  mem_total_mb: number;
  util_pct: number;
  procs: number;
  temp_c?: number | null;
  apps?: { pid: number; user: string; mem_mb: number; name: string }[];
};

export type Probe = {
  checked_at: string;
  hostname: string;
  user: string;
  home: string;
  os: string;
  kernel: string;
  arch: string;
  shell: string;
  cpus: number;
  mem_total_gb: number;
  mem_free_gb: number;
  disk_home: { total_gb: number; free_gb: number } | null;
  tmux: { present: boolean; version: string | null };
  tools: { git: string | null; python: string | null; node: string | null; rsync: boolean };
  agents: Record<string, { present: boolean; version: string | null; path: string | null }>;
  gpus: Gpu[];
};

export type ServerStatus = "unknown" | "online" | "offline" | "auth_failed";

export type Server = {
  id: string;
  alias: string;
  host: string;
  user: string;
  port: number;
  key: string | null;
  proxy_jump: string | null;
  proxy_command: string | null;
  source: "upload" | "manual" | "local";
  note: string;
  default_workdir: string;
  status: ServerStatus;
  status_detail: string | null;
  last_checked: string | null;
  probe: Probe | null;
};

export type KeyInfo = { name: string; kind: string; fingerprint: string; has_pub: boolean; used_by: string[] };

export type SessionState = "running" | "exited" | "stopped" | "unreachable" | "unknown";

export type Session = {
  id: string;
  title: string;
  server_id: string;
  server_alias: string;
  agent_id: string;
  workdir: string;
  tmux: string;
  created_at: string;
  last_active_at: string | null;
  state: SessionState;
  exit_status: number | null;
  attached: number;
  pinned: boolean;
  archived: boolean;
  plugin: string | null;
  plugins?: string[];
  yolo: boolean;
  preview: string | null;
  attach_cmd: string;
  origin: "local" | "discovered";
  /** v1.3：接入的研究项目与本机在项目里的代号 */
  project_id?: string | null;
  machine?: string | null;
};

export type StepStatus = "running" | "ok" | "failed" | "skipped";
export type Step = { step: string; label: string; status: StepStatus; detail: string | null; ms: number | null };

export type Settings = {
  theme: "dark" | "light" | "system";
  default_server: string | null;
  default_agent: string | null;
  research_plugin_path: string | null;
  plugin_paths?: string[];
  status_interval_secs: number;
};

export type Plugin = {
  name: string;
  version: string;
  description: string;
  source: "bundled" | "local";
  path: string | null;
  skills: string[];
  agents: string[];
  hooks: boolean;
};

export type Meta = { version: string; data_dir: string; platform: string; dev: boolean };

export type ImportResult = {
  servers_added: Server[];
  servers_updated: Server[];
  keys_added: KeyInfo[];
  warnings: string[];
  tests: { server_id: string; ok: boolean; key_used: string | null; detail: string | null }[];
};

export type TestResult = { ok: boolean; latency_ms: number | null; key_used: string | null; server: Server };

export type FileEntry = { name: string; kind: "dir" | "file" | "link"; size: number; mtime: string | null };
export type FileList = { path: string; parent: string | null; entries: FileEntry[] };
export type FileContent = { path: string; size: number; binary: boolean; truncated: boolean; text: string | null };
export type GitStatus = { is_repo: boolean; branch: string | null; changes: { path: string; status: string }[] };

export type ResearchRun = {
  run_id: string;
  kind: string;
  state: string;
  exit_code: number | null;
  host: string;
  started_at: string;
  elapsed: string;
  note: string;
  cmd?: string | null;
  cwd?: string | null;
  ended_at?: string | null;
  prereg?: string[];
  commit?: string | null;
  dirty?: boolean | null;
  has_metrics?: boolean;
  has_result?: boolean;
};

export type RunDetail = {
  run_id: string;
  meta: Record<string, unknown>;
  log_tail: string;
  metrics: Record<string, unknown> | null;
  result_md: string | null;
};

export type ArtifactKind = "image" | "pdf" | "table" | "notebook" | "html" | "doc";
export type Artifact = { path: string; name: string; kind: ArtifactKind; size: number; mtime: string };
export type HostNotes = { text: string; exists: boolean };

export type Research = {
  present: boolean;
  home: string;
  loop: { on: boolean; started: string | null; blocked: string | null };
  state_md: string | null;
  summary_md: string | null;
  ideas_md: string | null;
  ledger_md: string | null;
  overview_md?: string | null;
  lessons_md?: string | null;
  log_tail?: string | null;
  prereg?: { name: string; title: string }[];
  results?: { name: string; title: string }[];
  runs: ResearchRun[];
};

export type DeployBody = {
  server_id: string;
  agent_id: string;
  title?: string;
  workdir: string;
  prompt?: string;
  yolo?: boolean;
  plugins?: string[];
  extra_args?: string;
  project_id?: string;
};

// ---------- 研究项目（v1.3，docs/API.md 第 12 节）----------

export type Project = {
  id: string;
  name: string;
  hub: string;
  branch: string;
  home: string;
  created_at: string;
  fetched_at: string | null;
  fetch_error: string | null;
};

export type NewProject = { name: string; hub: string; branch?: string; home?: string; create?: boolean };

export type ProjectMember = {
  session_id: string;
  title: string;
  server_id: string;
  server_alias: string;
  workdir: string;
  state: SessionState;
  machine: string | null;
};

export type ProjectMachine = {
  code: string;
  head: string;
  committed_at: string | null;
  subject: string;
  ahead: number;
  behind: number;
  conflict: boolean | null;
  sessions: string[];
  server_alias: string | null;
};

export type ProjectLine = {
  line: string;
  holder: string | null;
  token: number;
  stamped: string | null;
  stage: string | null;
  waiting: string | null;
  updated: string | null;
  next: string[];
  source: string;
};

export type ProjectRun = {
  run_id: string;
  machine: string | null;
  kind: string;
  state: "ok" | "failed" | "open";
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  line: string | null;
  note: string;
  has_metrics: boolean;
  integrated: boolean;
  source: string;
};

export type ProjectView = {
  project: Project;
  research_head: string | null;
  machines: ProjectMachine[];
  lines: ProjectLine[];
  runs: ProjectRun[];
  members: ProjectMember[];
  decisions: string | null;
  warnings: string[];
};

export type MemberSync = {
  session_id: string;
  server_alias: string;
  /** 会话标题【修订 A3】；旧版服务端没有这个字段。 */
  title?: string;
  ok: boolean;
  detail: string;
  result: Record<string, unknown> | null;
};
export type ProjectSync = { members: MemberSync[]; view: ProjectView };

export type ServerInput = {
  alias: string;
  host: string;
  user: string;
  port?: number;
  key?: string | null;
  proxy_jump?: string | null;
  note?: string;
  default_workdir?: string;
};

// ---------- 令牌 ----------

const TOKEN_KEY = "bunsen.token";
let memToken: string | null = null;

/** 启动地址形如 /#token=xxx：读出来存好，再把片段抹掉。 */
export function captureToken(): void {
  const m = /[#&]token=([^&]+)/.exec(window.location.hash);
  if (!m) return;
  memToken = decodeURIComponent(m[1]);
  try {
    sessionStorage.setItem(TOKEN_KEY, memToken);
  } catch {
    /* 隐私模式下存不了，只留在内存里 */
  }
  history.replaceState(null, "", window.location.pathname + window.location.search + "#/");
}

export function token(): string {
  if (memToken) return memToken;
  try {
    const t = sessionStorage.getItem(TOKEN_KEY);
    if (t) return (memToken = t);
  } catch {
    /* 同上 */
  }
  return import.meta.env.DEV ? "dev" : "";
}

// ---------- 请求 ----------

export class ApiError extends Error {
  code: string;
  hint: string | null;
  status: number;
  constructor(code: string, message: string, hint: string | null, status: number) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

export function asApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError("internal", e instanceof Error ? e.message : String(e), null, 0);
}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const j = await res.json();
    if (j && j.error) return new ApiError(j.error.code ?? "internal", j.error.message ?? "请求失败", j.error.hint ?? null, res.status);
  } catch {
    /* 不是 JSON */
  }
  const code = res.status === 401 ? "unauthorized" : res.status === 403 ? "forbidden" : "internal";
  return new ApiError(code, `请求失败（${res.status}）`, null, res.status);
}

// 路径里的 id、名称都用 encodeURIComponent 拼，但它不转义点：整段是 . 或 .. 时浏览器照样会把路径规范化成
// 别的接口（例如 /api/sessions/.. → /api/），拿回来的东西会被当成会话。这种段一定不是真的 id，不发请求，直接当作找不到。
// status 为 0：是前端自己拦下的，不是服务端说没有（调用方据此不去改列表，例如不把同名的项目当成已删除）。
const DOT_SEGMENT = /\/(?:\.|%2e){1,2}(?=[/?#]|$)/i;

async function send(method: string, path: string, body?: unknown, accept?: string): Promise<Response> {
  if (DOT_SEGMENT.test(path.split("?")[0])) throw new ApiError("not_found", "地址不对：找不到这一项", "检查地址栏里的 id 或名称。", 0);
  const headers: Record<string, string> = { "x-bunsen-token": token() };
  if (accept) headers["accept"] = accept;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  try {
    return await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError("offline", "连不上 Bunsen 服务", "确认 bunsen serve 还在运行，然后刷新页面。", 0);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, body);
  if (!res.ok) throw await errorFrom(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const q = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export const api = {
  meta: () => req<Meta>("GET", "/api/meta"),
  settings: () => req<Settings>("GET", "/api/settings"),
  putSettings: (s: Settings) => req<Settings>("PUT", "/api/settings", s),

  agents: () => req<Agent[]>("GET", "/api/agents"),
  plugins: () => req<Plugin[]>("GET", "/api/plugins"),
  putAgent: (a: Agent) => req<Agent>("PUT", `/api/agents/${encodeURIComponent(a.id)}`, a),
  deleteAgent: (id: string) => req<unknown>("DELETE", `/api/agents/${encodeURIComponent(id)}`),

  servers: () => req<Server[]>("GET", "/api/servers"),
  importServers: (files: File[], configText?: string) => {
    const fd = new FormData();
    for (const f of files) fd.append("files", f, f.name);
    if (configText && configText.trim()) fd.append("config_text", configText);
    return req<ImportResult>("POST", "/api/servers/import", fd);
  },
  addServer: (s: ServerInput) => req<Server>("POST", "/api/servers", s),
  patchServer: (id: string, s: Partial<ServerInput>) => req<Server>("PATCH", `/api/servers/${encodeURIComponent(id)}`, s),
  deleteServer: (id: string) => req<unknown>("DELETE", `/api/servers/${encodeURIComponent(id)}`),
  testServer: (id: string, tryAllKeys = false) =>
    req<TestResult>("POST", `/api/servers/${encodeURIComponent(id)}/test`, { try_all_keys: tryAllKeys }),
  probeServer: (id: string) => req<Server>("POST", `/api/servers/${encodeURIComponent(id)}/probe`, {}),
  gpus: (id: string) => req<Gpu[]>("GET", `/api/servers/${encodeURIComponent(id)}/gpus`),
  installAgent: (id: string, agentId: string, method = 0) =>
    req<{ tmux: string }>("POST", `/api/servers/${encodeURIComponent(id)}/install-agent`, { agent_id: agentId, method }),

  keys: () => req<KeyInfo[]>("GET", "/api/keys"),
  deleteKey: (name: string) => req<unknown>("DELETE", `/api/keys/${encodeURIComponent(name)}`),

  sessions: (refresh: boolean) => req<Session[]>("GET", `/api/sessions?refresh=${refresh ? 1 : 0}`),
  session: (id: string) => req<Session>("GET", `/api/sessions/${encodeURIComponent(id)}`),
  patchSession: (id: string, p: { title?: string; pinned?: boolean; archived?: boolean }) =>
    req<Session>("PATCH", `/api/sessions/${encodeURIComponent(id)}`, p),
  sendText: (id: string, text: string, enter = true) =>
    req<{ ok: boolean }>("POST", `/api/sessions/${encodeURIComponent(id)}/send`, { text, enter }),
  sendKeys: (id: string, keys: string[]) => req<{ ok: boolean }>("POST", `/api/sessions/${encodeURIComponent(id)}/keys`, { keys }),
  capture: (id: string, lines = 200) => req<{ text: string }>("GET", `/api/sessions/${encodeURIComponent(id)}/capture${q({ lines })}`),
  restart: (id: string, resume = true) => req<Session>("POST", `/api/sessions/${encodeURIComponent(id)}/restart`, { resume }),
  stop: (id: string) => req<Session>("POST", `/api/sessions/${encodeURIComponent(id)}/stop`, {}),
  deleteSession: (id: string, force = false) =>
    req<unknown>("DELETE", `/api/sessions/${encodeURIComponent(id)}?force=${force ? 1 : 0}`),

  files: (id: string, path: string) => req<FileList>("GET", `/api/sessions/${encodeURIComponent(id)}/files${q({ path })}`),
  file: (id: string, path: string) => req<FileContent>("GET", `/api/sessions/${encodeURIComponent(id)}/file${q({ path })}`),
  git: (id: string) => req<GitStatus>("GET", `/api/sessions/${encodeURIComponent(id)}/git`),
  gitDiff: (id: string, path?: string) => req<{ diff: string }>("GET", `/api/sessions/${encodeURIComponent(id)}/git/diff${q({ path })}`),
  research: (id: string) => req<Research>("GET", `/api/sessions/${encodeURIComponent(id)}/research`),
  run: (id: string, runId: string, lines = 200) => req<RunDetail>("GET", `/api/sessions/${encodeURIComponent(id)}/research/run${q({ run_id: runId, lines })}`),
  artifacts: (id: string, limit = 300) => req<{ items: Artifact[]; truncated: boolean }>("GET", `/api/sessions/${encodeURIComponent(id)}/artifacts${q({ limit })}`),
  raw: async (id: string, path: string): Promise<ArrayBuffer> => {
    const res = await send("GET", `/api/sessions/${encodeURIComponent(id)}/raw${q({ path })}`);
    if (!res.ok) throw await errorFrom(res);
    return res.arrayBuffer();
  },
  projects: () => req<Project[]>("GET", "/api/projects"),
  addProject: (p: NewProject) => req<Project>("POST", "/api/projects", p),
  deleteProject: (id: string) => req<unknown>("DELETE", `/api/projects/${encodeURIComponent(id)}`),
  projectView: (id: string, refresh = false) =>
    req<ProjectView>("GET", `/api/projects/${encodeURIComponent(id)}/view${q({ refresh: refresh ? 1 : undefined })}`),
  syncProject: (id: string) => req<ProjectSync>("POST", `/api/projects/${encodeURIComponent(id)}/sync`),

  notes: (serverId: string) => req<HostNotes>("GET", `/api/servers/${encodeURIComponent(serverId)}/notes`),
  putNotes: (serverId: string, text: string) => req<HostNotes>("PUT", `/api/servers/${encodeURIComponent(serverId)}/notes`, { text }),
};

/** 部署：按行读 NDJSON，每来一步回调一次，最后返回建好的会话。 */
export async function deploy(body: DeployBody, onStep: (s: Step) => void): Promise<Session> {
  const res = await send("POST", "/api/sessions", body, "application/x-ndjson");
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("ndjson") || !res.body) {
    // 非流式：成功是 {session, steps}，失败是 422 {error, steps}。失败时也先把走过的步骤交出去，界面上看得到停在哪一步。
    const j = await res
      .clone()
      .json()
      .catch(() => null);
    for (const s of (Array.isArray(j?.steps) ? j.steps : []) as Step[]) onStep(s);
    if (!res.ok) throw await errorFrom(res);
    if (!j?.session) throw new ApiError("internal", "部署没有返回结果", "看看服务端日志。", res.status);
    return j.session as Session;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let result: Session | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.type === "step") onStep(msg as Step);
    else if (msg.type === "done") result = msg.session as Session;
    else if (msg.type === "error")
      throw new ApiError(msg.error?.code ?? "internal", msg.error?.message ?? "部署失败", msg.error?.hint ?? null, 422);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handle(line);
      }
    }
    if (done) break;
  }
  handle(buf);
  if (!result) throw new ApiError("internal", "部署没有返回结果", "看看服务端日志。", 0);
  return result;
}

export type TermTarget =
  | { session: string; pane: "agent" | "shell" }
  | { server: string; pane: "shell" }
  | { server: string; pane: "install"; agent: string };

export function termUrl(target: TermTarget, cols: number, rows: number): string {
  const u = new URLSearchParams({ token: token(), cols: String(cols), rows: String(rows) });
  for (const [k, v] of Object.entries(target)) u.set(k, v);
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/term?${u.toString()}`;
}
