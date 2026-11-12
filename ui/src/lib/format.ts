import type { ServerStatus, SessionState } from "./api";

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

/** 侧栏用的短时间。 */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分`;
  if (s < 86400) return `${Math.floor(s / 3600)} 时`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fullTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString("zh-CN", { hour12: false });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const gb = (n: number) => (n >= 100 ? `${Math.round(n)}` : n.toFixed(1).replace(/\.0$/, "")) + " GB";

export const SESSION_STATE: Record<SessionState, { label: string; tone: "ok" | "warn" | "err" | "mute" }> = {
  running: { label: "运行中", tone: "ok" },
  exited: { label: "已退出", tone: "warn" },
  stopped: { label: "已停止", tone: "mute" },
  unreachable: { label: "连不上", tone: "err" },
  unknown: { label: "未检查", tone: "mute" },
};

export const SERVER_STATUS: Record<ServerStatus, { label: string; tone: "ok" | "warn" | "err" | "mute" }> = {
  online: { label: "在线", tone: "ok" },
  offline: { label: "离线", tone: "err" },
  auth_failed: { label: "认证失败", tone: "warn" },
  unknown: { label: "未检查", tone: "mute" },
};

/** 给没有图标的东西一个稳定的色相。 */
const HUES = [212, 28, 150, 280, 190, 320, 48, 100, 250, 5];
export function hueOf(s: string): number {
  let h = 13;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return HUES[h % HUES.length];
}

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
