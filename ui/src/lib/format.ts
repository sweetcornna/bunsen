import type { DotTone } from "../components/ui";
import type { Server, ServerStatus, SessionState } from "./api";

/** 是不是本机那条服务器记录（契约 v1.3 第 1 节）。判断本机一律用它，不直接比较 source。 */
export const isLocal = (s: Pick<Server, "source"> | null | undefined) => s?.source === "local";

/** 服务器地址的一行说明：本机不经 ssh，只写用户。 */
export function serverAddr(s: Pick<Server, "source" | "user" | "host" | "port">): string {
  if (isLocal(s)) return `本机 · ${s.user}`;
  return `${s.user}@${s.host}${s.port !== 22 ? `:${s.port}` : ""}`;
}

/**
 * 显示汇合点这类 git 地址时遮掉 URL 里的 userinfo：https://user:token@host/… → https://***@host/…，免得令牌出现在界面上。
 * 只处理带 scheme:// 的写法；scp 写法（git@host:path）和 <别名>:<路径> 原样返回。userinfo 里写了裸 @ 时遮到最后一个 @。
 */
export function maskUserinfo(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/, "$1***@");
}

// ---------- 时间：界面上只有这一种写法（设计稿第 4 节） ----------
const pad2 = (n: number) => String(n).padStart(2, "0");
/** 时间点：ISO 串、服务端写的本地时间串，或毫秒时间戳。 */
export type TimeIn = string | number | null | undefined;
const parseTime = (iso: TimeIn): number | null => {
  if (typeof iso === "number") return Number.isFinite(iso) ? iso : null;
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/**
 * 一个时间点：1 分钟内“刚刚”，1 小时内“N 分钟前”，今天“14:01”，昨天“昨天 14:01”，今年“11月11日 21:40”，更早“2025-11-11”。
 * 认不出的时间返回空串（界面不显示原文）。
 */
export function fmtWhen(iso: TimeIn, now = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const s = (now - t) / 1000;
  if (s < 60 && s > -60) return "刚刚";
  if (s >= 60 && s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const d = new Date(t);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = 86400_000;
  if (t >= today.getTime() && t < today.getTime() + day) return hm;
  if (t >= today.getTime() - day && t < today.getTime()) return `昨天 ${hm}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 悬停时的完整本地时间：“2026-11-13 14:01:51”；认不出为空串。 */
export function fmtFull(iso: TimeIn): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 时长：“0.4 秒”“38 秒”“12 分”“1 小时 3 分”“2 天 4 小时”。 */
export function fmtDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} 秒`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  const dd = Math.floor(h / 24);
  return h % 24 ? `${dd} 天 ${h % 24} 小时` : `${dd} 天`;
}

/** 研究工具写的时长（“38m”“4h20m”“2m30s”“1d3h”）换成毫秒；认不出为 null。 */
export function parseElapsed(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^\s*(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+(?:\.\d+)?)\s*s)?\s*$/i.exec(s);
  if (!m || m.slice(1).every((x) => x === undefined)) return null;
  const [d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0));
  return ((d * 24 + h) * 60 + mi) * 60_000 + se * 1000;
}

/** 一次运行的时长：有起止时间按起止算，还在跑按现在算，否则读研究工具写的 elapsed。 */
export function runDuration(r: { started_at?: string | null; ended_at?: string | null; elapsed?: string | null }, live = false, now = Date.now()): string {
  const s = parseTime(r.started_at);
  const e = parseTime(r.ended_at);
  if (s !== null && e !== null && e >= s) return fmtDuration(e - s);
  if (s !== null && live) return fmtDuration(now - s);
  return fmtDuration(parseElapsed(r.elapsed));
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const gb = (n: number) => (n >= 100 ? `${Math.round(n)}` : n.toFixed(1).replace(/\.0$/, "")) + " GB";

/** 会话状态（设计稿第 4 节）：只有“运行中”（live 点）和“连不上”（err 点）带点，已退出、已停止不显示点。 */
export const SESSION_STATE: Record<SessionState, { label: string; dot: "live" | "err" | null }> = {
  running: { label: "运行中", dot: "live" },
  exited: { label: "已退出", dot: null },
  stopped: { label: "已停止", dot: null },
  unreachable: { label: "连不上", dot: "err" },
  unknown: { label: "未检查", dot: null },
};

/** 服务器状态：在线和未检查用中性点，离线 err，认证失败 warn。 */
export const SERVER_STATUS: Record<ServerStatus, { label: string; dot: DotTone }> = {
  online: { label: "在线", dot: "idle" },
  offline: { label: "离线", dot: "err" },
  auth_failed: { label: "认证失败", dot: "warn" },
  unknown: { label: "未检查", dot: "idle" },
};

/** 部署步骤的状态词。 */
export const STEP_STATUS: Record<string, string> = { running: "进行中", ok: "完成", failed: "失败", skipped: "跳过", pending: "等待" };

// 状态来自服务端：新版服务端加了状态、或者拿到的根本不是会话（地址拼错时），都按“未检查”显示，不能在渲染时抛错。
export const hasKey = <K extends string>(table: Record<K, unknown>, key: string): key is K => Object.prototype.hasOwnProperty.call(table, key);
export const sessionState = (state: string) => (hasKey(SESSION_STATE, state) ? SESSION_STATE[state] : SESSION_STATE.unknown);
export const serverStatus = (status: string) => (hasKey(SERVER_STATUS, status) ? SERVER_STATUS[status] : SERVER_STATUS.unknown);

/** 空闲显卡：显存占用不到 5% 且没有进程。 */
export function gpuFree(g: { mem_used_mb: number; mem_total_mb: number; procs: number }): boolean {
  return g.procs === 0 && g.mem_used_mb < g.mem_total_mb * 0.05;
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存不了就算了，这些只是界面偏好 */
  }
}
