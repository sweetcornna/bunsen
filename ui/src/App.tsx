import { KeyRound, PanelLeftOpen, Plus, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Palette, type PalettePick } from "./components/Palette";
import { Sidebar } from "./components/Sidebar";
import { Button, cx, Empty, ICON, IconButton, Loading, Toasts, Tooltip } from "./components/ui";
import { loadLocal, saveLocal } from "./lib/format";
import { currentRoute, go, useRoute } from "./lib/route";
import { listed, showsSplit } from "./lib/split";
import { closePicker, openInSplit, requestKeyboardFocus, splitAction, splitShortcut, syncRoute, useSplit } from "./lib/splitStore";
import { useApp } from "./lib/store";
import { ProjectPage, Projects } from "./pages/Projects";
import { Servers } from "./pages/Servers";
import { SessionView } from "./pages/SessionView";
import { SplitView } from "./pages/SplitView";
import { Settings } from "./pages/Settings";
import { Welcome } from "./pages/Welcome";

const PICK: Record<"right" | "below", PalettePick> = {
  right: { title: "在右边打开对话", placeholder: "选一个对话，在右边打开…", onPick: (id) => openInSplit(id, "right") },
  below: { title: "在下方打开对话", placeholder: "选一个对话，在焦点格下方打开…", onPick: (id) => openInSplit(id, "below") },
};

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
  // 网格里有两个以上会话时会话页是分屏；只剩一个时就是原来的单会话页。地址里的会话不在会话列表里时也是单会话页
  // （“找不到这个对话”），布局不动（分屏稿 14.2，规则在 split.ts 的 showsSplit）
  const layout = useSplit((s) => s.layout);
  const routeListed = useApp((s) => route.name === "session" && listed(s.sessions)(route.id));
  const picker = useSplit((s) => s.picker);
  const split = route.name === "session" && showsSplit(layout, route.id, () => routeListed);

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

  // 项目列表上次没取到：窗口重新获得焦点、标签页切回来时再取一次（第一次失败后的几次自动重试在 store 里）。
  useEffect(() => {
    if (boot !== "ready") return;
    const retry = () => {
      const st = useApp.getState();
      if (!document.hidden && st.projectsError) void st.loadProjects();
    };
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [boot]);

  // 分屏快捷键（Ctrl+Mod+…，Mod 在 macOS 是 Cmd、其他系统是 Alt）：在 window 上捕获，终端聚焦时也生效（终端那边也把它们截下）。
  // 只在动作此刻有效时截：只有一格时的切换焦点和关闭、对话框或命令面板开着、输入法组合中，按键原样往下传（分屏稿 12.4）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = splitShortcut(e);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      splitAction(a);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // 布局里的会话跟着地址走（启动时地址里已经是某个会话）
  useEffect(() => {
    if (boot === "ready") syncRoute();
  }, [boot]);

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

  // 启动加载、连不上、缺令牌都用同一个空状态：标题说发生了什么，说明说怎么办。
  if (boot === "loading") {
    return (
      <div className="boot">
        <Loading hint="正在连接 Bunsen 服务…" />
      </div>
    );
  }

  if (boot !== "ready") {
    const noToken = boot === "unauthorized";
    return (
      <div className="boot">
        <Empty
          icon={noToken ? <KeyRound size={ICON.lg} /> : <Unplug size={ICON.lg} />}
          title={noToken ? "缺少访问令牌" : "连不上 Bunsen 服务"}
          hint={
            <>
              {noToken ? "用 bunsen serve 打印的地址打开（带 #token=…）。" : "确认 bunsen serve 还在运行，然后重试。"}
              {bootDetail && <div className="muted">{bootDetail}</div>}
            </>
          }
        >
          <Button onClick={() => void init()}>重试</Button>
        </Empty>
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
                <PanelLeftOpen size={ICON.md} />
              </IconButton>
              <IconButton label="新对话" side="right" onClick={() => go("/")}>
                <Plus size={ICON.md} />
              </IconButton>
            </div>
          )}
          <div className="main-body">
            {/* 一页出错只换掉这一页，侧栏还在；换页（key 变了）就重新渲染 */}
            {/* 分屏时 key 固定，切换焦点不重挂网格；单会话页照旧按会话重置 */}
            <ErrorBoundary page key={split ? "split" : route.name === "session" || route.name === "project" ? `${route.name}:${route.id}` : route.name}>
              {route.name === "new" && <Welcome />}
              {route.name === "session" && (split ? <SplitView focus={route.id} /> : <SessionView key={route.id} id={route.id} />)}
              {route.name === "projects" && <Projects />}
              {route.name === "project" && <ProjectPage key={route.id} id={route.id} />}
              {route.name === "servers" && <Servers />}
              {route.name === "settings" && <Settings />}
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <Palette open={palette} onOpenChange={setPalette} />
      {/* Ctrl+Mod+\、Ctrl+Mod+-：复用命令面板选一个会话，开在右边或焦点格下面 */}
      <Palette
        open={picker !== null}
        onOpenChange={(v) => {
          if (v) return;
          closePicker();
          const r = currentRoute();
          if (r.name === "session") requestKeyboardFocus(r.id);
        }}
        pick={picker ? PICK[picker] : undefined}
      />
      <Toasts />
    </Tooltip.Provider>
  );
}
