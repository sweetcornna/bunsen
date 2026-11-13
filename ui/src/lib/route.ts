import { useMemo, useSyncExternalStore } from "react";

export type Route =
  | { name: "new" }
  | { name: "session"; id: string }
  | { name: "servers" }
  | { name: "projects" }
  | { name: "project"; id: string }
  | { name: "settings" };

/** 地址栏里可能是手敲的残缺转义（如 %E4%B8）：解不开就用原串，不能在渲染时抛错。 */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parse(hash: string): Route {
  const [a, b] = hash.replace(/^#\/?/, "").split("/");
  if (a === "s" && b) return { name: "session", id: decode(b) };
  if (a === "servers") return { name: "servers" };
  if (a === "projects") return { name: "projects" };
  if (a === "p" && b) return { name: "project", id: decode(b) };
  if (a === "settings") return { name: "settings" };
  return { name: "new" };
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

/** 不在组件里时读当前路由（例如后台任务完成时判断用户还在不在那一页）。 */
export const currentRoute = (): Route => parse(window.location.hash);

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parse(hash), [hash]);
}

export function go(to: "/" | "/servers" | "/projects" | "/settings" | `/s/${string}` | `/p/${string}`): void {
  window.location.hash = to;
}

/** 链接用的 href（路由是 hash）：真链接键盘能到，也能在新标签页打开。 */
export const sessionHref = (id: string) => `#/s/${encodeURIComponent(id)}`;
export const projectHref = (id: string) => `#/p/${encodeURIComponent(id)}`;
