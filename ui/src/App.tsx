import { PanelLeftOpen, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Palette } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { Button, cx, IconButton, Logo, Spinner, Toasts, Tooltip } from "./components/ui";
import { loadLocal, saveLocal } from "./lib/format";
import { go, useRoute } from "./lib/route";
import { useApp } from "./lib/store";
import { Servers } from "./pages/Servers";
import { SessionView } from "./pages/SessionView";
import { Settings } from "./pages/Settings";
import { Welcome } from "./pages/Welcome";

function applyTheme(theme: "dark" | "light" | "system") {
  const resolved = theme === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = resolved;
  saveLocal("bunsen.theme", resolved);
}

export function App() {
  const boot = useApp((s) => s.boot);
  const bootDetail = useApp((s) => s.bootDetail);
  const init = useApp((s) => s.init);
  const theme = useApp((s) => s.settings?.theme);
  const interval = useApp((s) => s.settings?.status_interval_secs ?? 30);
  const route = useRoute();
  const [collapsed, setCollapsed] = useState(() => loadLocal("bunsen.sidebar.collapsed", false));
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (!theme) return;
    applyTheme(theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const on = () => applyTheme("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  // 定时向各台服务器问一遍对话状态；窗口在后台时不问。
  useEffect(() => {
    if (boot !== "ready") return;
    const t = window.setInterval(() => !document.hidden && void useApp.getState().refreshSessions(true), Math.max(10, interval) * 1000);
    const onShow = () => !document.hidden && void useApp.getState().refreshSessions(true);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [boot, interval]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (k === "n" && !e.shiftKey && e.metaKey) {
        e.preventDefault();
        go("/");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const toggleSidebar = () => {
    setCollapsed((v) => {
      saveLocal("bunsen.sidebar.collapsed", !v);
      return !v;
    });
  };

  if (boot === "loading") {
    return (
      <div className="splash">
        <Logo size={28} />
        <Spinner />
      </div>
    );
  }

  if (boot !== "ready") {
    return (
      <div className="splash">
        <Logo size={28} />
        <h1>{boot === "unauthorized" ? "缺少访问令牌" : "连不上 Bunsen 服务"}</h1>
        <p>
          {boot === "unauthorized"
            ? "用 bunsen serve 打印的地址打开（带 #token=…）。"
            : (bootDetail ?? "确认 bunsen serve 还在运行。")}
        </p>
        <Button onClick={() => void init()}>重试</Button>
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={350} skipDelayDuration={200}>
      <div className={cx("app", collapsed && "collapsed")}>
        {!collapsed && <Sidebar route={route} onCollapse={toggleSidebar} onPalette={() => setPalette(true)} />}
        <main className="main">
          {collapsed && (
            <div className="rail">
              <IconButton label="展开侧栏" side="right" onClick={toggleSidebar}>
                <PanelLeftOpen size={15} />
              </IconButton>
              <IconButton label="新对话" side="right" onClick={() => go("/")}>
                <Plus size={15} />
              </IconButton>
            </div>
          )}
          <div className="main-body">
            {route.name === "new" && <Welcome />}
            {route.name === "session" && <SessionView key={route.id} id={route.id} />}
            {route.name === "servers" && <Servers />}
            {route.name === "settings" && <Settings />}
          </div>
        </main>
      </div>
      <Palette open={palette} onOpenChange={setPalette} />
      <Toasts />
    </Tooltip.Provider>
  );
}
