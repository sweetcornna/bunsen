// 分屏的状态（.orchestra/design-split-view.md 第 4–6 节）。规则在 split.ts（纯函数），这里只管存取、路由和键盘焦点：
// - 布局存 localStorage（bunsen.split.v1），共享面板的开关和宽度另存（bunsen.split.drawer）；多个标签共用一份，以最后写入的为准。
// - 焦点不存：地址里的会话（#/s/<id>）就是焦点格。切换焦点用 replaceState 改地址，不新增历史记录；
//   侧栏点击、后退前进照常走 hash 导航：会话已在网格里只移焦点，不在就替换上次的焦点格。
// - 只剩一格时就是原来的单会话页（App 渲染 SessionView），不留分屏痕迹。
import type { DragEvent } from "react";
import { create } from "zustand";
import type { Quoted } from "../components/Preview";
import { loadLocal, saveLocal } from "./format";
import { currentRoute, go, sessionHref } from "./route";
import {
  count,
  DRAWER_KEY,
  focusAfter,
  has,
  listed,
  maxColumns,
  movePane,
  nextFocus,
  parseDrawer,
  parseLayout,
  planOpen,
  platformOf,
  pruneSessions,
  removePane,
  routeLayout,
  setPrimary,
  shortcutFor,
  shownPanes,
  SPLIT_KEY,
  splitBase,
  withColWeights,
  type AddResult,
  type Dir,
  type Drawer,
  type DropHint,
  type KeyLike,
  type Layout,
  type SplitAction,
  type Where,
} from "./split";
import { useApp } from "./store";

type SplitState = {
  layout: Layout | null;
  /** 上次的焦点会话：离开会话页再回来、侧栏点击时，替换的就是这一格。只在内存里。 */
  last: string | null;
  /** “单独查看”的那一格（暂时只显示它，布局不变）。只在内存里。 */
  solo: string | null;
  drawer: Drawer;
  /** 快捷键打开的会话选择框：选中的会话开在右边还是下方。 */
  picker: Where | null;
};

export const useSplit = create<SplitState>(() => ({
  layout: parseLayout(loadLocal<unknown>(SPLIT_KEY, null)),
  last: null,
  solo: null,
  drawer: parseDrawer(loadLocal<unknown>(DRAWER_KEY, null)),
  picker: null,
}));

useSplit.subscribe((st, prev) => {
  if (st.layout !== prev.layout) saveLocal(SPLIT_KEY, st.layout);
  if (st.drawer !== prev.drawer) saveLocal(DRAWER_KEY, st.drawer);
});

/** 单会话页的面板开关（Ctrl+Mod+B 在单会话页时发这个事件，SessionView 自己切换）。 */
export const PANEL_EVENT = "bunsen:panel";
/** 快捷键按哪种系统认（13.10：AltGr 的字符回退只在 Windows 上用）。 */
export const OS = platformOf(typeof navigator !== "undefined" ? navigator.platform : "");

export function eventKey(e: KeyboardEvent): KeyLike {
  return { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, altGraph: e.getModifierState?.("AltGraph") ?? false, isComposing: e.isComposing };
}
/** 页面上有没有打开的对话框（含命令面板、会话选择框）：开着时不处理分屏快捷键（12.4）。 */
const overlayOpen = () => document.querySelector('[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])') !== null;
const routeSession = (): string | null => {
  const r = currentRoute();
  return r.name === "session" ? r.id : null;
};
/** 页面上此刻显示几格：没有显示网格（单会话页、“找不到这个对话”）时是 1（15.2 第 3 条，规则在 split.ts 的 shownPanes）。 */
const shown = (): number => shownPanes(useSplit.getState().layout, routeSession(), listed(useApp.getState().sessions));

/** 这个按键此刻是不是要截下来的分屏快捷键（12.4，规则在 split.ts 的 shortcutFor）。App 在 window 上用它，终端的按键处理也用它。 */
export const splitShortcut = (e: KeyboardEvent): SplitAction | null =>
  shortcutFor(eventKey(e), { os: OS, session: currentRoute().name === "session", panes: shown(), overlay: overlayOpen() });
export const isSplitKey = (e: KeyboardEvent): boolean => splitShortcut(e) !== null;

/** 焦点换到 id：改地址但不新增历史记录，再补发一次 hashchange 让路由跟上。 */
function setRoute(id: string) {
  if (routeSession() === id) return;
  history.replaceState(history.state, "", sessionHref(id));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/**
 * 地址变了（侧栏点击、后退前进、手敲地址、程序改写）：会话在网格里只移焦点，不在就替换上次的焦点格；没有布局时建单格布局。
 * 分屏里焦点格变了、而键盘焦点此刻在另一格里时，把键盘焦点交给新焦点格的终端；在网格之外（侧栏、对话框、命令面板）不抢（12.1）。
 * 地址里的会话不在会话列表里（旧链接、后退到已删除的会话）：不改布局、不写存储，App 显示单会话页的“找不到这个对话”；
 * 之后地址回到存在的会话，网格照常恢复（14.2）。会话列表就绪之前不动布局：这时页面还只是“正在连接”，看不到网格；
 * 启动时这里就会跑一次，那时照旧把地址里的会话换进去，会在知道它存不存在之前就换掉一格并写进存储。列表就绪时再同步（见文件末尾）。
 */
export function syncRoute() {
  const id = routeSession();
  if (!id) return;
  const app = useApp.getState();
  if (app.boot !== "ready") return;
  const st = useSplit.getState();
  const layout = routeLayout(st.layout, id, st.last, listed(app.sessions));
  if (!has(layout, id)) return;
  if (layout !== st.layout || st.last !== id || (st.solo && st.solo !== id)) useSplit.setState({ layout, last: id, solo: st.solo === id ? id : null });
  if (count(layout) > 1 && st.last !== null && st.last !== id) requestKeyboardFocus(id, true);
}

// ---------- 键盘焦点：切换焦点时把键盘焦点交给新焦点格的终端 ----------

/** 输入条：共享面板里的“引用”“问进展”往焦点格的输入条里填。 */
export type BarHandle = { fill: (text: string) => void; attach: (q: Quoted) => void };
/** focus 返回 false：还给不了（终端还没建好），下一帧再试。 */
type PaneHandle = { focus: () => boolean; bar: () => BarHandle | null };
const handles = new Map<string, PaneHandle>();
/** soft：只在键盘焦点还在别的格里（或无处可去）时才给，见 requestKeyboardFocus。 */
let pending: { id: string; at: number; soft: boolean } | null = null;
let frame = 0;
const nextFrame = () => {
  if (!frame)
    frame = requestAnimationFrame(() => {
      frame = 0;
      flushFocus();
    });
};
/** 键盘焦点此刻在哪一格里（不在任何一格里为 null）。 */
const activePane = (): string | null => document.activeElement?.closest(".split-pane")?.getAttribute("data-pane") ?? null;
/** 键盘焦点无处可去：落在 body 上（所在的元素被卸下、移走了）。 */
const nowhere = () => !document.activeElement || document.activeElement === document.body;

function flushFocus() {
  if (!pending) return;
  if (Date.now() - pending.at > 2000) {
    pending = null;
    return;
  }
  // soft：键盘焦点已经在目标格里（点进了它的输入条），或者用户把它移到了网格之外，就不再给
  if (pending.soft) {
    const now = activePane();
    if (now === pending.id || (now === null && !nowhere())) {
      pending = null;
      return;
    }
  }
  const h = handles.get(pending.id);
  if (!h) return; // 小窗挂上时（registerPane）再给
  // 菜单、对话框关掉之前锁着焦点（给了也会被拉回去）：等它们关掉
  if (document.activeElement?.closest(".menu-panel, [role=dialog]")) return nextFrame();
  if (!h.focus()) return nextFrame();
  pending = null;
}
/**
 * 下一帧（小窗挂上、菜单关掉之后）把键盘焦点给 id 那一格的终端。
 * soft（焦点格因为路由变化而变了，12.1）：键盘焦点此刻在另一格里、或无处可去时才给；在网格之外（侧栏、对话框、命令面板）不抢。
 * 已经有一个给同一格的普通请求时，soft 请求不把它降级。
 */
export function requestKeyboardFocus(id: string, soft = false) {
  if (soft) {
    if (pending && pending.id === id && !pending.soft && Date.now() - pending.at <= 2000) return;
    const from = activePane();
    if (from === id || (from === null && !nowhere())) return;
  }
  pending = { id, at: Date.now(), soft };
  nextFrame();
}
/** 有没有还没给出去的普通请求（soft 的不算：进入分屏时照样把键盘焦点给焦点格）。 */
export const hasPendingFocus = () => pending !== null && !pending.soft && Date.now() - pending.at <= 2000;
/** 小窗挂上时登记：怎么把键盘焦点给它、它的输入条（共享面板里“引用”“问进展”往焦点格的输入条里填）。 */
export function registerPane(id: string, h: PaneHandle): () => void {
  handles.set(id, h);
  flushFocus();
  return () => {
    if (handles.get(id) === h) handles.delete(id);
  };
}
export const paneBar = (id: string) => handles.get(id)?.bar() ?? null;

// 在 React 的路由订阅之前登记：同一次 hashchange 里布局先换好，界面不会先画出旧布局。（放在键盘焦点的状态之后：syncRoute 会用到它们）
window.addEventListener("hashchange", syncRoute);
syncRoute();

// ---------- 网格尺寸 ----------

let measured: { width: number; height: number } | null = null;
/** SplitView 量到的网格尺寸；卸下时设回 null。 */
export function setGridSize(s: { width: number; height: number } | null) {
  measured = s;
}
/** 当前（或即将出现的）网格宽度：在分屏里用量到的；单会话页按主区宽度和共享面板估算。 */
export function gridSize(): { width: number; height: number } {
  if (measured) return measured;
  const main = document.querySelector(".main-body");
  const w = main?.clientWidth ?? window.innerWidth;
  const h = main?.clientHeight ?? window.innerHeight;
  const d = useSplit.getState().drawer;
  return { width: d.open ? Math.floor(w * (1 - d.size / 100)) - 1 : w, height: h };
}

// ---------- 动作 ----------

const titleOf = (id: string) => useApp.getState().sessions.find((s) => s.id === id)?.title ?? id;

function applyAdd(r: AddResult, route: string | null) {
  useSplit.setState({ layout: r.layout, solo: null, picker: null });
  if (r.replaced) useApp.getState().toast("info", `已替换 ${titleOf(r.replaced)}`);
  requestKeyboardFocus(r.focus);
  if (route) setRoute(r.focus);
  else go(`/s/${r.focus}`);
}

/** “在分屏中打开”以哪份布局为底、焦点是谁（12.2：保存的布局先按当前会话列表过滤）。拖入提示和松手后的落点都从这里算。 */
function openBase() {
  const st = useSplit.getState();
  const sessions = useApp.getState().sessions;
  return splitBase(st.layout, { route: routeSession(), last: st.last, exists: listed(sessions) });
}

/** 落点和提示：openInSplit 和 dropHint 用同一个底、同一个可用列数、同一个纯函数（split.ts 的 planOpen，12.3、13.8）。 */
const openPlan = (id: string, where: Where, target?: string | null) => {
  const { base, focus } = openBase();
  return planOpen(base, id, { where, maxCols: maxColumns(gridSize().width), focus, target });
};

/**
 * 在分屏中打开（侧栏菜单、拖入、Ctrl+Mod+\ 和 Ctrl+Mod+- 的选择框）。anchor：拖进来时放下的那一格。
 * 不在会话页时（欢迎页、设置……）加进保存的布局，再打开新加的那一格；还没有可用的布局时就是普通打开。
 */
export function openInSplit(id: string, where: Where = "right", anchor?: string | null) {
  const route = routeSession();
  const { result } = openPlan(id, where, anchor);
  if (!result) {
    useSplit.setState({ picker: null });
    go(`/s/${id}`);
    return;
  }
  applyAdd(result, route);
}

/** 拖进来的会话放在 target 的 side 会怎样（拖入提示）：和松手后的 openInSplit 出自同一个 openPlan。 */
export function dropHint(id: string, target: string, side: Where): DropHint {
  return openPlan(id, side, target).hint;
}

/** 焦点移到 id。keyboard：顺便把键盘焦点交给它的终端（快捷键、菜单）；点击和 Tab 进来的不抢焦点。 */
export function focusPane(id: string, keyboard = false) {
  const st = useSplit.getState();
  if (!has(st.layout, id)) return;
  if (st.solo && st.solo !== id) useSplit.setState({ solo: null });
  setRoute(id);
  if (keyboard) requestKeyboardFocus(id);
}

/** 关闭小窗（只从分屏里拿掉，不影响会话本身）。关的是焦点格时焦点去相邻那一格。 */
export function closePane(id: string) {
  const st = useSplit.getState();
  if (!st.layout || count(st.layout) < 2 || !has(st.layout, id)) return;
  const r = removePane(st.layout, id);
  const focus = routeSession();
  useSplit.setState({ layout: r.layout, solo: st.solo === id ? null : st.solo });
  const next = focus === id ? r.focus : focus;
  if (next) {
    if (focus === id) setRoute(next);
    requestKeyboardFocus(next);
  }
}

export function moveTo(id: string, dir: Dir) {
  const l = useSplit.getState().layout;
  const next = l && movePane(l, id, dir);
  if (next) useSplit.setState({ layout: next });
  requestKeyboardFocus(id);
}
export function makePrimary(id: string) {
  const l = useSplit.getState().layout;
  if (l) useSplit.setState({ layout: setPrimary(l, id) });
  requestKeyboardFocus(id);
}
/** 单独查看：暂时只显示这一格；再点一次（或“还原”）回到分屏，布局不变。 */
export function toggleSolo(id: string) {
  const st = useSplit.getState();
  useSplit.setState({ solo: st.solo === id ? null : id });
  setRoute(id);
  requestKeyboardFocus(id);
}
export function toggleDrawer() {
  const d = useSplit.getState().drawer;
  useSplit.setState({ drawer: { ...d, open: !d.open } });
}
export function setDrawerSize(size: number) {
  const d = useSplit.getState().drawer;
  const s = Math.round(size * 10) / 10;
  if (d.size !== s) useSplit.setState({ drawer: { ...d, size: s } });
}
/** 写入列宽：个数对不上布局此刻的列数（拖动途中格数变了）就不写，返回 false（分屏稿 13.7，规则在 split.ts 的 withColWeights）。 */
export function setColWeights(colWeights: number[]): boolean {
  const next = withColWeights(useSplit.getState().layout, colWeights);
  if (next) useSplit.setState({ layout: next });
  return next !== null;
}
export function setRowSplit(rowSplit: number) {
  const l = useSplit.getState().layout;
  if (l) useSplit.setState({ layout: { ...l, rowSplit } });
}
export const closePicker = () => useSplit.setState({ picker: null });

/** 快捷键（App 在 window 上捕获，终端聚焦时也生效）。没有显示网格时按单会话页处理（15.2 第 3 条）。 */
export function splitAction(a: SplitAction) {
  const st = useSplit.getState();
  const focus = routeSession();
  if (!focus) return;
  const multi = shown() > 1;
  if (a === "right" || a === "below") useSplit.setState({ picker: a });
  else if ((a === "next" || a === "prev") && multi && st.layout) focusPane(nextFocus(st.layout, focus, a === "next" ? 1 : -1), true);
  else if (a === "close" && multi) closePane(focus);
  else if (a === "panel") {
    if (multi) toggleDrawer();
    else window.dispatchEvent(new Event(PANEL_EVENT));
  }
}

// ---------- 侧栏拖入 ----------

export const SESSION_MIME = "application/x-bunsen-session";
let dragging: string | null = null;
export const draggingSession = () => dragging;
export function startSessionDrag(e: DragEvent, id: string) {
  dragging = id;
  e.dataTransfer.setData(SESSION_MIME, id);
  e.dataTransfer.effectAllowed = "copyLink";
  // 拖完（含拖到窗口外取消、源行被卸下时 dragend 到不了 window 的情形：靠 drop 和窗口失焦兜底）就复位
  const end = () => {
    dragging = null;
    window.removeEventListener("dragend", end, true);
    window.removeEventListener("drop", end);
    window.removeEventListener("blur", end);
  };
  window.addEventListener("dragend", end, true);
  // drop 用冒泡阶段：放置目标自己的 onDrop 先拿到会话 id
  window.addEventListener("drop", end);
  window.addEventListener("blur", end);
}

// ---------- 已删除、已归档的会话 ----------

// 打开时校验（12.2）：boot 第一次就绪时（不论这时有没有布局）把已删除、已归档的从布局里拿掉，地址里那个在列表里就留着（14.2）。
// 之后都按“使用中”的规则：这次被删除、这次被归档的，它的小窗自动关掉（单格布局也一样，拿空了就清掉布局）；
// 之前就已归档、又被打开进分屏的那一格不动。规则在 split.ts 的 pruneSessions、focusAfter。
// 地址同步（14.2）：列表就绪之前 syncRoute 不动布局，所以第一次就绪时先按地址同步、再校验（地址里的会话不在列表里时同步什么也不做）；
// 地址里的会话原来不在列表里、这次出现了（刷新、轮询找到了它），也同步一次，免得分屏画出一个不在网格里的焦点。
let validated = false;
useApp.subscribe((st, prev) => {
  if (st.boot !== "ready" || (st.sessions === prev.sessions && prev.boot === "ready")) return;
  const first = !validated;
  validated = true;
  const route = routeSession();
  if (route && (first || !listed(prev.sessions)(route)) && listed(st.sessions)(route)) syncRoute();
  const l = useSplit.getState().layout;
  if (!l) return;
  const next = pruneSessions(l, st.sessions, first ? null : prev.sessions, first ? route : null);
  if (next === l) return;
  const focus = routeSession();
  const st2 = useSplit.getState();
  useSplit.setState({ layout: next, solo: st2.solo && has(next, st2.solo) ? st2.solo : null });
  const f = focusAfter(l, next, focus);
  if (f && f !== focus) {
    setRoute(f);
    // 被关掉的是焦点格：键盘焦点在它里面（或无处可去）时交给新焦点格，在侧栏、对话框里时不抢（12.1）
    requestKeyboardFocus(f, true);
  }
});
