import { useMemo, useSyncExternalStore } from "react";

export type Route =
  | { name: "new" }
  | { name: "session"; id: string }
  | { name: "servers" }
  | { name: "settings" };

function parse(hash: string): Route {
  const [a, b] = hash.replace(/^#\/?/, "").split("/");
  if (a === "s" && b) return { name: "session", id: b };
  if (a === "servers") return { name: "servers" };
  if (a === "settings") return { name: "settings" };
  return { name: "new" };
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parse(hash), [hash]);
}

export function go(to: "/" | "/servers" | "/settings" | `/s/${string}`): void {
  window.location.hash = to;
}
