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

// 状态来自服务端：新版服务端加了状态、或者拿到的根本不是会话（地址拼错时），都按“未检查”显示，不能在渲染时抛错。
export const hasKey = <K extends string>(table: Record<K, unknown>, key: string): key is K => Object.prototype.hasOwnProperty.call(table, key);
export const sessionState = (state: string) => (hasKey(SESSION_STATE, state) ? SESSION_STATE[state] : SESSION_STATE.unknown);
export const serverStatus = (status: string) => (hasKey(SERVER_STATUS, status) ? SERVER_STATUS[status] : SERVER_STATUS.unknown);

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
