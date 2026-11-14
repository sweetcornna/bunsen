// 研究面板、可信度页、运行详情共用的小工具。
import type { Tone } from "../components/ui";
import { hasKey } from "./format";
import type { ResearchTrust, RkAuditVerdict, RkCheck, RkCiteReport, RkCiteStatus, RkClaim, RkEnv, RkInput, RkIssue, RkOpenFail, RkOutputs, RkPlanStatus, RkReviewStatus, TrustCommand } from "./api";

export const runTone = (state: string): Tone => (/run|queue|wait/i.test(state) ? "accent" : /fail|error|kill|timeout|lost/i.test(state) ? "err" : /done|ok|success/i.test(state) ? "ok" : "mute");
export const claimTone = (s: string): Tone => (s.includes("证实") ? "ok" : s.includes("否定") ? "err" : s.includes("未决") ? "warn" : "mute");

/** 结论的可信度（rk check 的 claims[].trust）。 */
export const TRUST: Record<RkClaim["trust"], { tone: Tone; label: string }> = {
  ok: { tone: "ok", label: "可信" },
  warn: { tone: "warn", label: "存疑" },
  fail: { tone: "err", label: "不可信" },
};

const AUDIT_RANK: Record<RkAuditVerdict, number> = { 可采信: 1, 需退回: 2, 不可采信: 3 };
export const auditTone = (v: RkAuditVerdict | null): Tone => (v === "可采信" ? "ok" : v === "需退回" ? "warn" : v === "不可采信" ? "err" : "mute");

/** 证据运行里最严的推断审计总评；没有任何总评为 null（界面上记“未审”）。unaudited：没有总评的证据运行数。 */
export function strictestAudit(runs: RkClaim["runs"]): { verdict: RkAuditVerdict | null; unaudited: number } {
  let verdict: RkAuditVerdict | null = null;
  let unaudited = 0;
  for (const r of runs) {
    // 不认识的总评（rk 以后加了新的取值）当作没有，不往“可采信”上算。
    // 用 hasKey，不用 in：原型链上的 toString、constructor 不算认识的总评（审查 P4F2-04）。
    if (!r.audit || !hasKey(AUDIT_RANK, r.audit)) unaudited++;
    else if (!verdict || AUDIT_RANK[r.audit] > AUDIT_RANK[verdict]) verdict = r.audit;
  }
  return { verdict, unaudited };
}

/** rk check 的问题按 code 前缀分组的顺序和名称（契约第 7 节）；不认识的前缀归“其他”。 */
export const ISSUE_GROUPS: { prefix: string; label: string }[] = [
  { prefix: "review", label: "核对" },
  { prefix: "prov", label: "溯源" },
  { prefix: "cite", label: "引用" },
  { prefix: "plan", label: "计划" },
  { prefix: "run", label: "运行记录" },
  { prefix: "prereg", label: "预登记" },
  { prefix: "audit", label: "推断审计" },
  { prefix: "line", label: "研究线" },
  { prefix: "overview", label: "总览表" },
  { prefix: "ledger", label: "账本" },
  { prefix: "sync", label: "同步" },
  { prefix: "index", label: "RUNS.md 与 STATE.md" },
];
export type IssueGroup = { prefix: string; label: string; items: { level: "error" | "warning"; issue: RkIssue }[] };

export function groupIssues(errors: RkIssue[], warnings: RkIssue[]): IssueGroup[] {
  const known = new Set(ISSUE_GROUPS.map((g) => g.prefix));
  const groups = new Map<string, IssueGroup>();
  const add = (level: "error" | "warning", issue: RkIssue) => {
    const code = typeof issue.code === "string" ? issue.code : "";
    const dot = code.indexOf(".");
    const prefix = dot > 0 && known.has(code.slice(0, dot)) ? code.slice(0, dot) : "";
    let g = groups.get(prefix);
    if (!g) groups.set(prefix, (g = { prefix, label: ISSUE_GROUPS.find((x) => x.prefix === prefix)?.label ?? "其他", items: [] }));
    g.items.push({ level, issue });
  };
  for (const e of errors) add("error", e);
  for (const w of warnings) add("warning", w);
  const order = [...ISSUE_GROUPS.map((g) => g.prefix), ""];
  return order.map((p) => groups.get(p)).filter((g): g is IssueGroup => Boolean(g));
}

/** 拼进命令行的一个参数：只含常见安全字符时原样，否则用单引号包起来（# 也加引号：开了 extendedglob 的 zsh 当它是通配符）。 */
export function shellArg(s: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.:@/+=-]*$/.test(s) ? s : shellQuote(s);
}
/** 一律用单引号包起来，内部的单引号写成 '\''。 */
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 关闭一条未关闭的 fail 的完整命令（契约 Q12），在工作目录里执行；说明留给用户填。研究目录以 - 开头时补 ./，免得 python3 当成选项。 */
export function resolveCommand(home: string, ref: string): string {
  const h = home.replace(/\/+$/, "");
  return `python3 ${shellArg(`${h.startsWith("-") ? "./" : ""}${h}/tools/rk.py`)} review resolve ${shellQuote(ref)} --note "…"`;
}

/** `results/x.md:12` 这样的出处拆成路径和行号。 */
export function splitLoc(loc: string): { path: string; line: number | null } {
  const m = /^(.*?):(\d+)$/.exec(loc);
  return m ? { path: m[1], line: Number(m[2]) } : { path: loc, line: null };
}

/** 规范形式的标识符（doi:…、arXiv:…）对应的外部页面；编号里的 #、?、% 要编码，斜杠保留（审查 P4F1-09）。 */
export function citeUrl(id: string): string | null {
  const enc = (x: string) => encodeURIComponent(x.trim()).replace(/%2F/gi, "/");
  if (/^doi:/i.test(id)) return id.slice(4).trim() ? `https://doi.org/${enc(id.slice(4))}` : null;
  if (/^arxiv:/i.test(id)) return id.slice(6).trim() ? `https://arxiv.org/abs/${enc(id.slice(6))}` : null;
  return null;
}

/** sha256 只显示前 12 位。 */
export const shortHash = (h: string | null | undefined) => (h ? h.slice(0, 12) : "");

// ---------- 服务端透传的 rk 记录的整理 ----------
// Bunsen 只要求 rk 的输出是 JSON 对象就原样透传（契约 8.1、8.2）；运行目录里的 env.json、outputs.json 还可能是旧运行的
// 脚本自己写的同名文件。形状不对的一段当作没有结果，免得整页渲染出错（审查 P4F1-01、12）：
// 数组补成空的，字符串、数字、布尔字段类型不对时换成缺省值，数组里不是对象的项去掉。

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const objs = (v: unknown): Record<string, unknown>[] => arr<unknown>(v).filter(isObj);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] => arr<unknown>(v).filter((x): x is string => typeof x === "string");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;
const EMPTY: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>;
/** 不是对象时给一个固定的空对象（引用不变，useMemo 的依赖不会每次都变）。 */
export const asRecord = (v: unknown): Record<string, unknown> => (isObj(v) ? v : EMPTY);
const whyBad = (v: unknown) => (isObj(v) && typeof v.error === "string" && v.error ? v.error : "输出不是预期的格式");

const issuesOf = (v: unknown): RkIssue[] => objs(v).map((x) => ({ code: str(x.code), message: str(x.message), file: strOrNull(x.file), ref: strOrNull(x.ref) }));

function checkOf(v: unknown): RkCheck | string | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || (v.ok === false && typeof v.error === "string") || !Array.isArray(v.claims) || !Array.isArray(v.errors) || !Array.isArray(v.warnings)) return whyBad(v);
  const counts = isObj(v.counts) ? v.counts : {};
  return {
    ok: bool(v.ok),
    rk_version: str(v.rk_version),
    counts: { runs: num(counts.runs) ?? 0, overview_rows: num(counts.overview_rows) ?? 0, claims: num(counts.claims) ?? 0, errors: num(counts.errors) ?? 0, warnings: num(counts.warnings) ?? 0, notes: num(counts.notes) ?? 0 },
    errors: issuesOf(v.errors),
    warnings: issuesOf(v.warnings),
    notes: issuesOf(v.notes),
    claims: objs(v.claims).map((c) => ({
      id: str(c.id),
      status: str(c.status),
      text: str(c.text),
      kind: str(c.kind),
      date: str(c.date),
      decisive: bool(c.decisive),
      evidence: strs(c.evidence),
      runs: objs(c.runs).map((r) => ({ run_id: str(r.run_id), state: str(r.state), audit: strOrNull(r.audit) as RkClaim["runs"][number]["audit"], audit_id: strOrNull(r.audit_id) })),
      results: objs(c.results).map((r) => ({ path: str(r.path), review: str(r.review) as RkClaim["results"][number]["review"], open_fails: num(r.open_fails) ?? 0 })),
      citations: objs(c.citations).map((x) => ({ id: str(x.id), status: str(x.status) as RkClaim["citations"][number]["status"] })),
      review: str(c.review) as RkClaim["review"],
      trust: str(c.trust) as RkClaim["trust"],
    })),
  };
}
function reviewOf(v: unknown): RkReviewStatus | string | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || (v.ok === false && typeof v.error === "string") || !Array.isArray(v.files) || !Array.isArray(v.open_fails)) return whyBad(v);
  return {
    rk_version: str(v.rk_version),
    files: objs(v.files).map((f) => ({ path: str(f.path), sha256: str(f.sha256), state: str(f.state) as RkReviewStatus["files"][number]["state"], open_fails: num(f.open_fails) ?? 0, last_review: strOrNull(f.last_review), last_reviewed_sha256: strOrNull(f.last_reviewed_sha256) })),
    open_fails: objs(v.open_fails).map((f) => ({
      ref: str(f.ref),
      review_id: str(f.review_id),
      file: str(f.file),
      line: num(f.line),
      row: strOrNull(f.row),
      type: str(f.type) as RkOpenFail["type"],
      claim: str(f.claim),
      evidence: strs(f.evidence),
      note: str(f.note),
      recorded_at: str(f.recorded_at),
    })),
    problems: num(v.problems) ?? 0,
  };
}
function citeOf(v: unknown): RkCiteReport | string | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || (v.ok === false && typeof v.error === "string") || !Array.isArray(v.items)) return whyBad(v);
  return {
    ok: bool(v.ok),
    rk_version: str(v.rk_version),
    checked: num(v.checked) ?? 0,
    skipped: num(v.skipped) ?? 0,
    items: objs(v.items).map((x) => ({ id: str(x.id), status: str(x.status) as RkCiteStatus, files: strs(x.files), cache: strOrNull(x.cache), title: strOrNull(x.title), error: strOrNull(x.error) })),
  };
}
function planOf(v: unknown): RkPlanStatus | string | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || (v.ok === false && typeof v.error === "string") || typeof v.present !== "boolean") return whyBad(v);
  return {
    present: v.present,
    approved: bool(v.approved),
    approved_at: strOrNull(v.approved_at),
    changed_since_approval: bool(v.changed_since_approval),
    deviations_since_approval: num(v.deviations_since_approval) ?? 0,
    phases: objs(v.phases).map((ph) => ({
      title: str(ph.title),
      steps: objs(ph.steps).map((s) => ({
        id: str(s.id),
        step: str(s.step),
        status: str(s.status),
        prereg: strOrNull(s.prereg),
        deliverables: objs(s.deliverables).map((d) => ({ path: str(d.path), exists: bool(d.exists), resolved: strOrNull(d.resolved) })),
      })),
    })),
  };
}

const ORDER: TrustCommand[] = ["check", "review", "cite", "plan"];

export function normalizeTrust(raw: unknown): ResearchTrust {
  const t = isObj(raw) ? raw : {};
  const failures = objs(t.failures).map((f) => ({ command: str(f.command) as TrustCommand, message: str(f.message) }));
  const extra: ResearchTrust["failures"] = [];
  const take = <T,>(command: TrustCommand, v: T | string | null): T | null => {
    if (typeof v !== "string") return v;
    if (!failures.some((f) => f.command === command)) extra.push({ command, message: v });
    return null;
  };
  return {
    available: t.available === true,
    reason: strOrNull(t.reason),
    rk_version: strOrNull(t.rk_version),
    checked_at: str(t.checked_at),
    check: take("check", checkOf(t.check)),
    review: take("review", reviewOf(t.review)),
    cite: take("cite", citeOf(t.cite)),
    plan: take("plan", planOf(t.plan)),
    // 按命令的执行顺序列出
    failures: [...failures, ...extra].sort((a, b) => ORDER.indexOf(a.command) - ORDER.indexOf(b.command)),
  };
}

/** 整理后的一份记录：value 为 null 且 bad 为真表示文件在、但格式不认识。 */
export type Parsed<T> = { value: T | null; bad: boolean };

/** runs/<ID>/env.json（契约 3.3）：version 不是 1、缺 python 或 os、包清单不是数组，都算格式不认识。 */
export function envOf(v: unknown): Parsed<RkEnv> {
  if (v === null || v === undefined) return { value: null, bad: false };
  if (!isObj(v) || v.version !== 1 || !isObj(v.python) || !isObj(v.os) || !isObj(v.packages) || !Array.isArray(v.packages.lines)) return { value: null, bad: true };
  const tool = v.packages.tool;
  const gpu = isObj(v.gpu) ? v.gpu : null;
  return {
    bad: false,
    value: {
      version: 1,
      captured_at: str(v.captured_at),
      python: { executable: strOrNull(v.python.executable), version: strOrNull(v.python.version) },
      packages: { tool: tool === "pip" || tool === "uv" || tool === "conda" ? tool : null, lines: strs(v.packages.lines), truncated: bool(v.packages.truncated) },
      gpu: gpu ? { driver: strOrNull(gpu.driver), cuda: strOrNull(gpu.cuda), names: strs(gpu.names) } : null,
      os: { system: str(v.os.system), release: str(v.os.release), machine: str(v.os.machine), platform: str(v.os.platform) },
      host: str(v.host),
      fingerprint: str(v.fingerprint),
    },
  };
}

/** runs/<ID>/outputs.json（契约 3.2）：version 不是 1、files 不是数组，都算格式不认识；path 不是字符串的项去掉。 */
export function outputsOf(v: unknown): Parsed<RkOutputs> {
  if (v === null || v === undefined) return { value: null, bad: false };
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.files)) return { value: null, bad: true };
  return {
    bad: false,
    value: {
      version: 1,
      run_id: str(v.run_id),
      written_at: str(v.written_at),
      truncated: bool(v.truncated),
      files: objs(v.files)
        .filter((f) => typeof f.path === "string" && f.path !== "")
        .map((f) => ({ path: f.path as string, sha256: strOrNull(f.sha256), size: num(f.size) as number, partial: bool(f.partial), unhashed: bool(f.unhashed) })),
    },
  };
}

/** meta.inputs（契约 3.1）：不是数组为 null（旧运行没有）；不是对象、path 不是字符串的项去掉，数字字段类型不对时为 null。 */
export function inputsOf(meta: Record<string, unknown>): RkInput[] | null {
  if (!Array.isArray(meta.inputs)) return null;
  return objs(meta.inputs)
    .filter((x) => typeof x.path === "string" && x.path !== "")
    .map((x) => ({ path: x.path as string, type: x.type === "dir" ? "dir" : "file", sha256: strOrNull(x.sha256), size: num(x.size) as number, files: num(x.files), partial: bool(x.partial), unhashed: bool(x.unhashed) }));
}

/** meta.prereg 里的路径（只取 path 是字符串的项）。 */
export const preregPaths = (meta: Record<string, unknown>): string[] => objs(meta.prereg).map((p) => p.path).filter((x): x is string => typeof x === "string" && x !== "");

/** 字节数；不是数字时为 “—”。 */
export const sizeText = (n: unknown, bytes: (n: number) => string) => (typeof n === "number" && Number.isFinite(n) ? bytes(n) : "—");
