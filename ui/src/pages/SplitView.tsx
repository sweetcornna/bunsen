// 分屏：两个以上会话时的会话页（.orchestra/design-split-view.md；按统一稿第 9 节调整）。只剩一格时 App 渲染原来的 SessionView。
// - 网格：CSS Grid，列之间、行之间各一条 1px 的分隔线轨道（--line），格子之间没有间距；列宽、行比例只通过两个 CSS 变量给出。
// - 小窗：32px 标题栏（状态点、标题、服务器别名，右侧“更多”和“关闭”）、代理终端、紧凑输入条。焦点格标题栏上沿 2px 强调色线，
//   其余格内容压暗到 85%，标题栏按钮悬停或键盘聚焦时才出现。
// - 共享面板：网格右侧一个面板，只显示焦点格那个会话的数据，跟随焦点；标签页不变。
// 小窗的 DOM 顺序按列、行排，和视觉顺序一致（Tab、读屏顺序，分屏稿 12.9）；位置由 CSS 决定。重排时 React 只移动节点，
// 终端不重挂、不重连；被移动的格子里的焦点元素会失焦，SplitGrid 在提交后把焦点还给它。
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Columns2, LayoutPanelLeft, Maximize2, Minimize2, MoreHorizontal, PanelRightClose, PanelRightOpen, Unplug, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SyntheticEvent } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { useSessionMenu } from "../components/SessionMenu";
import { useSessionDrop } from "../components/SplitDrop";
import { holdTermFit, type TermHandle } from "../components/Terminal";
import { Badge, Button, Dot, Empty, ICON, IconButton, Menu, type MenuItem } from "../components/ui";
import type { Session } from "../lib/api";
import { loadLocal, saveLocal, sessionState } from "../lib/format";
import { canMove, colTracks, DEFAULT_ROW_SPLIT, dragColumns, dragRows, DRAWER_MAX, DRAWER_MIN, effectiveRowSplit, effectiveWeights, ids, isCollapsed, panes, rowTracks, spans, visiblePanes, type Cell, type Dir, type Layout } from "../lib/split";
import {
  closePane,
  focusPane,
  hasPendingFocus,
  makePrimary,
  moveTo,
  paneBar,
  registerPane,
  requestKeyboardFocus,
  setColWeights,
  setDrawerSize,
  setGridSize,
  setRowSplit,
  toggleDrawer,
  toggleSolo,
  useSplit,
  type BarHandle,
} from "../lib/splitStore";
import { agentOf, serverOf, useApp } from "../lib/store";
import { AgentBody, useResearch, useSessionPoll, Workspace, type Tab } from "./SessionView";

/** 只有一格可见（窄窗收起、单独查看）时的轨道。 */
const ONE = "minmax(0, 1fr)";

export function SplitView({ focus }: { focus: string }) {
  const layout = useSplit((s) => s.layout);
  const solo = useSplit((s) => s.solo);
  const drawer = useSplit((s) => s.drawer);
  const session = useApp((s) => s.sessions.find((x) => x.id === focus));
  const gridRef = useRef<HTMLDivElement | null>(null);
  // 量到网格尺寸之前不挂小窗（useLayoutEffect 在绘制前量好），免得按估算挂上的终端马上又被收起
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const drawerSize = useRef<number | null>(null);
  // 共享面板的标签页：跟随焦点时保持不变（提到这里，换焦点时面板整个换掉也不丢），和单会话页一样记住上次停在哪一页（分屏稿 13.4）。
  // 面板关着时不挂，打开分屏本身连不出第 7 路；面板开着、停在“终端”页时，面板里的终端另算一路
  const [tab, setTab] = useState<Tab>(() => loadLocal<Tab>("bunsen.tab", "overview"));
  const pickTab = (t: Tab) => {
    setTab(t);
    saveLocal("bunsen.tab", t);
  };

  // 只为焦点会话问状态（其余格靠全局的定时刷新），不会因为格子多而多发请求
  useSessionPoll(focus);

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next = { width: el.clientWidth, height: el.clientHeight };
      setGridSize(next);
      setSize((p) => (p && p.width === next.width && p.height === next.height ? p : next));
    };
    measure();
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(measure);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      setGridSize(null);
    };
  }, []);

  // 进入分屏（或刷新后恢复）时，键盘焦点给焦点格的终端
  useEffect(() => {
    if (!hasPendingFocus()) requestKeyboardFocus(focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!layout) return null;

  return (
    <div className="split" data-split="">
      <PanelGroup direction="horizontal" className="session-body" onLayout={(sizes) => (drawerSize.current = sizes.length === 2 ? sizes[1] : null)}>
        <Panel id="grid" order={1} minSize={30} className="pane">
          <SplitGrid layout={layout} focus={focus} solo={solo} size={size} gridRef={gridRef} drawerOpen={drawer.open} />
        </Panel>
        {drawer.open && (
          <>
            {/* 拖面板边线时终端也先不 fit，松手 fit 一次；宽度松手才存 */}
            <PanelResizeHandle
              className="resize-handle"
              onDragging={(on) => {
                holdTermFit(on);
                if (!on && drawerSize.current !== null) setDrawerSize(drawerSize.current);
              }}
            />
            <Panel id="drawer" order={2} defaultSize={drawer.size} minSize={DRAWER_MIN} maxSize={DRAWER_MAX} className="pane workspace" data-drawer="">
              {session ? <SharedPanel key={session.id} session={session} tab={tab} onTab={pickTab} /> : <Empty icon={<Unplug size={ICON.lg} />} title="找不到这个对话" hint="它可能已经删除了。" />}
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
}

function SplitGrid({ layout, focus, solo, size, gridRef, drawerOpen }: { layout: Layout; focus: string; solo: string | null; size: { width: number; height: number } | null; gridRef: RefObject<HTMLDivElement | null>; drawerOpen: boolean }) {
  const visible = size ? visiblePanes(layout, { focus, solo, width: size.width, height: size.height }) : [];
  const keep = useKeepFocus(gridRef, visible.join(" "));
  if (!size) return <div ref={gridRef} className="split-grid" data-split-grid="" />;
  const alone = visible.length === 1;
  const collapsed = !solo && isCollapsed(layout, size.width, size.height);
  const weights = effectiveWeights(layout, size.width);
  const rowSplit = effectiveRowSplit(layout, size.height);
  const cols = alone ? ONE : colTracks(weights);
  const rows = alone ? ONE : rowTracks(rowSplit);
  const cells = panes(layout);
  const topRight = alone ? visible[0] : cells.filter((c) => c.row === 0).reduce((a, b) => (b.col > a.col ? b : a)).id;
  return (
    // 行内样式只有网格的两个 CSS 变量（列宽、行比例），check-style 的白名单里注明
    <div ref={gridRef} className="split-grid" data-split-grid="" data-alone={alone ? "" : undefined} style={{ "--split-cols": cols, "--split-rows": rows } as CSSProperties} onFocus={keep.onFocus}>
      {/* visiblePanes 已按列、行排好：DOM 顺序就是视觉顺序 */}
      {visible.map((id) => {
        const cell = cells.find((c) => c.id === id) as Cell;
        return (
          <SplitPane key={id} id={id} cell={cell} span={spans(layout, cell)} layout={layout} focused={id === focus} alone={alone} solo={solo === id} collapsed={collapsed} topRight={id === topRight} drawerOpen={drawerOpen} />
        );
      })}
      {!alone && <Dividers layout={layout} weights={weights} rowSplit={rowSplit} size={size} gridRef={gridRef} />}
    </div>
  );
}

/**
 * 重排后键盘焦点不能丢（分屏稿 12.9）：React 移动格子的 DOM 节点时，节点里有焦点的元素会失焦（焦点落到 body）。
 * 记下网格里最后获得焦点的元素，顺序变了以后它还在网格里、而焦点无处可去时，把焦点还给它。
 */
function useKeepFocus(gridRef: RefObject<HTMLDivElement | null>, order: string) {
  const last = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = last.current;
    const active = document.activeElement;
    if (el && el.isConnected && gridRef.current?.contains(el) && el !== active && (!active || active === document.body)) el.focus({ preventScroll: true });
  }, [order, gridRef]);
  return { onFocus: (e: ReactFocusEvent) => void (last.current = e.target instanceof HTMLElement ? e.target : null) };
}

/** 列与列之间、上下两格之间的分隔线：拖动只改 CSS 变量，松手才写入布局；双击复位；键盘方向键每次 24px，Home 复位。 */
function Dividers({ layout, weights, rowSplit, size, gridRef }: { layout: Layout; weights: number[]; rowSplit: number; size: { width: number; height: number }; gridRef: RefObject<HTMLDivElement | null> }) {
  const cols = weights.length;
  const sum = weights.reduce((a, b) => a + b, 0);
  const twoRowCols = [...new Set(layout.extras.filter((c) => c.row === 1).map((c) => c.col))].sort();
  const STEP = 24;
  // 正在拖的那条线。拖动途中格子被卸下（会话被删、窄窗收起）时 pointerup 不会再来：复位 data-resizing 和终端 fit 的暂停，
  // 不写入布局；这条线还在网格里时把拖动中改过的 CSS 变量还原成这一次渲染的值。
  // 拖竖分隔线途中列数变了（关掉、加进一格，这条线还在）也一样，立即中止，不等松手（分屏稿 13.11）
  const active = useRef<{ handle: HTMLElement; stop: () => void; axis: "col" | "row"; cols: number } | null>(null);
  const tracks = { cols: colTracks(weights), rows: rowTracks(rowSplit) };
  // 最近一次渲染的轨道：松手时列宽没写进去（格数变了），网格回到它
  const latest = useRef(tracks);
  latest.current = tracks;
  useLayoutEffect(() => {
    const a = active.current;
    if (!a || (a.handle.isConnected && !(a.axis === "col" && a.cols !== cols))) return;
    a.stop();
    gridRef.current?.style.setProperty("--split-cols", tracks.cols);
    gridRef.current?.style.setProperty("--split-rows", tracks.rows);
  });
  useEffect(() => () => active.current?.stop(), []);

  const drag = (e: ReactPointerEvent<HTMLDivElement>, axis: "col" | "row", i: number) => {
    const grid = gridRef.current;
    if (e.button !== 0 || !grid) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.setAttribute("data-dragging", "");
    const start = axis === "col" ? e.clientX : e.clientY;
    let moved = false;
    let w = weights;
    let r = rowSplit;
    holdTermFit(true);
    const pointer = e.pointerId;
    const stop = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.removeAttribute("data-dragging");
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      holdTermFit(false);
      if (active.current?.handle === handle) active.current = null;
    };
    const onMove = (ev: PointerEvent) => {
      const d = (axis === "col" ? ev.clientX : ev.clientY) - start;
      if (!moved && Math.abs(d) < 3) return;
      moved = true;
      if (axis === "col") {
        w = dragColumns(weights, i, d, size.width);
        grid.style.setProperty("--split-cols", colTracks(w));
      } else {
        r = dragRows(rowSplit, d, size.height);
        grid.style.setProperty("--split-rows", rowTracks(r));
      }
    };
    const onUp = () => {
      if (moved) {
        // 松手时核对：拖动途中格数变了（关掉、加进一格，这条线还在），权重个数不等于当前列数，就不写，
        // 拖动中改过的列宽变量回到当前渲染的值（分屏稿 13.7）
        if (axis === "col") {
          if (!setColWeights(w)) grid.style.setProperty("--split-cols", latest.current.cols);
        } else setRowSplit(r);
      }
      stop();
    };
    active.current = { handle, stop, axis, cols };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  const key = (e: ReactKeyboardEvent<HTMLDivElement>, axis: "col" | "row", i: number) => {
    const back = axis === "col" ? "ArrowLeft" : "ArrowUp";
    const fwd = axis === "col" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== fwd && e.key !== "Home") return;
    e.preventDefault();
    const d = e.key === "Home" ? 0 : e.key === back ? -STEP : STEP;
    if (axis === "col") setColWeights(e.key === "Home" ? [] : dragColumns(weights, i, d, size.width));
    else setRowSplit(e.key === "Home" ? DEFAULT_ROW_SPLIT : dragRows(rowSplit, d, size.height));
  };

  return (
    <>
      {Array.from({ length: cols - 1 }, (_, i) => (
        <div
          key={`c${i}`}
          className="split-handle"
          data-axis="col"
          data-at={i}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整列宽（双击复位）"
          aria-valuenow={Math.round((weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / sum) * 100)}
          tabIndex={0}
          onPointerDown={(e) => drag(e, "col", i)}
          onDoubleClick={() => setColWeights([])}
          onKeyDown={(e) => key(e, "col", i)}
        />
      ))}
      {twoRowCols.map((c) => (
        <div
          key={`r${c}`}
          className="split-handle"
          data-axis="row"
          data-col={c}
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整行高（双击复位）"
          aria-valuenow={Math.round(rowSplit * 100)}
          tabIndex={0}
          onPointerDown={(e) => drag(e, "row", c)}
          onDoubleClick={() => setRowSplit(DEFAULT_ROW_SPLIT)}
          onKeyDown={(e) => key(e, "row", c)}
        />
      ))}
    </>
  );
}

function SplitPane({
  id,
  cell,
  span,
  layout,
  focused,
  alone,
  solo,
  collapsed,
  topRight,
  drawerOpen,
}: {
  id: string;
  cell: Cell;
  span: boolean;
  layout: Layout;
  focused: boolean;
  alone: boolean;
  solo: boolean;
  collapsed: boolean;
  topRight: boolean;
  drawerOpen: boolean;
}) {
  const session = useApp((s) => s.sessions.find((x) => x.id === id));
  const agents = useApp((s) => s.agents);
  const servers = useApp((s) => s.servers);
  const paneRef = useRef<HTMLElement | null>(null);
  const termRef = useRef<TermHandle | null>(null);
  const barRef = useRef<BarHandle | null>(null);
  const [unread, setUnread] = useState(false);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const drop = useSessionDrop(id);

  // “有新输出”：失去焦点之后终端有新输出时亮，获得焦点后消失
  useEffect(() => {
    if (focused) setUnread(false);
  }, [focused]);
  const onOutput = useCallback(() => {
    if (!focusedRef.current) setUnread(true);
  }, []);

  useEffect(
    () =>
      registerPane(id, {
        // 终端还在就给终端；已结束、连不上时给这一格里第一个能操作的控件。没给进去（还没建好）就下一帧再试
        focus: () => {
          const pane = paneRef.current;
          if (termRef.current) termRef.current.focus();
          else pane?.querySelector<HTMLElement>(".pane-body button:not(:disabled), .pane-body textarea:not(:disabled)")?.focus();
          return !!pane && pane.contains(document.activeElement);
        },
        bar: () => barRef.current,
      }),
    [id],
  );

  // 在格子里任意位置按下鼠标、或键盘焦点进入格子，就切换焦点（关闭按钮、面板开关除外）
  const take = (e: SyntheticEvent) => {
    if (!(e.target instanceof Element) || !e.target.closest("[data-keep-focus]")) focusPane(id);
  };

  const st = session ? sessionState(session.state) : null;
  const title = session?.title ?? "找不到这个对话";
  return (
    <section
      ref={paneRef}
      className="split-pane"
      data-pane={id}
      data-focused={focused ? "" : undefined}
      data-col={alone ? undefined : cell.col}
      data-row={alone ? undefined : cell.row}
      data-span={!alone && span ? "" : undefined}
      data-alone={alone ? "" : undefined}
      aria-label={title}
      onPointerDownCapture={take}
      onFocusCapture={take}
      {...drop.handlers}
    >
      <header className="pane-bar" data-pane-bar="">
        {/* 一行一个有色元素：有新输出时它占状态点的位置 */}
        {unread ? <Dot tone="new" label="有新输出" /> : st?.dot && <Dot tone={st.dot} label={st.label} />}
        <h2 className="session-title" title={title}>
          {title}
        </h2>
        {/* 顺序和会话头一致：状态点、标题、别名、徽标（分屏稿 12.5）。“免确认”是安全信息，每格都要看得到 */}
        {session && (
          <span className="session-server" title={`${session.server_alias}:${session.workdir}`}>
            {session.server_alias}
          </span>
        )}
        {session?.yolo && (
          <Badge tone="warn" title="跳过权限确认：Agent 执行命令前不再询问" data-yolo="">
            免确认
          </Badge>
        )}
        {collapsed && focused && <SplitSwitcher layout={layout} focus={id} />}
        {solo && (
          <Button size="sm" variant="ghost" icon={<Minimize2 size={ICON.sm} />} onClick={() => toggleSolo(id)} data-restore="">
            还原
          </Button>
        )}
        <div className="pane-actions">
          {session && <PaneMenu id={id} session={session} layout={layout} alone={alone} solo={solo} drawerOpen={drawerOpen} />}
          <IconButton size="sm" label="关闭小窗" data-keep-focus="" data-close-pane="" onClick={() => closePane(id)}>
            <X size={ICON.sm} />
          </IconButton>
        </div>
        {topRight && (
          <IconButton size="sm" label={drawerOpen ? "隐藏面板" : "显示面板"} data-keep-focus="" data-drawer-toggle="" onClick={toggleDrawer}>
            {drawerOpen ? <PanelRightClose size={ICON.sm} /> : <PanelRightOpen size={ICON.sm} />}
          </IconButton>
        )}
      </header>
      <div className="pane-body">
        {session ? (
          <ErrorBoundary pane>
            {/* 同屏最多一个 primary：只有焦点格里的“接续”等动作用主按钮样式（分屏稿 12.8）。
                终端连上时只有焦点格按 polite 拿键盘焦点（接续、从“连不上”恢复之后），非焦点格不拿（15.1 第 1、2 条）；
                进入分屏、换焦点格时的交接由 requestKeyboardFocus 做（12.1） */}
            <AgentBody
              session={session}
              agent={agentOf(agents, session.agent_id)}
              server={serverOf(servers, session.server_id)}
              termRef={termRef}
              barRef={barRef}
              compact
              autoFocus={focused ? "polite" : false}
              onOutput={onOutput}
              primary={focused}
            />
          </ErrorBoundary>
        ) : (
          <Empty icon={<Unplug size={ICON.lg} />} title="找不到这个对话" hint="它可能已经删除了；关掉这一格就好。" />
        )}
      </div>
      {drop.hint}
    </section>
  );
}

const MOVES: { dir: Dir; label: string; icon: typeof ArrowLeft }[] = [
  { dir: "left", label: "移到左边", icon: ArrowLeft },
  { dir: "right", label: "移到右边", icon: ArrowRight },
  { dir: "up", label: "移到上面", icon: ArrowUp },
  { dir: "down", label: "移到下面", icon: ArrowDown },
];

/** 小窗的“更多”：面板、单独查看、设为主格、移动，再加会话菜单的条目，最后“关闭小窗”。 */
function PaneMenu({ id, session, layout, alone, solo, drawerOpen }: { id: string; session: Session; layout: Layout; alone: boolean; solo: boolean; drawerOpen: boolean }) {
  const { items: sessionItems, dialogs } = useSessionMenu(session, () => undefined);
  // 选了分屏的动作：菜单关掉时不把焦点还给“更多”按钮，键盘焦点回到这一格的终端
  const acted = useRef(false);
  const act = (fn: () => void) => () => {
    acted.current = true;
    fn();
  };
  const items: MenuItem[] = [
    {
      label: drawerOpen ? "隐藏面板" : "显示面板",
      icon: drawerOpen ? <PanelRightClose size={ICON.md} /> : <PanelRightOpen size={ICON.md} />,
      onSelect: act(() => {
        toggleDrawer();
        requestKeyboardFocus(id);
      }),
    },
    { label: solo ? "还原分屏" : "单独查看", icon: solo ? <Minimize2 size={ICON.md} /> : <Maximize2 size={ICON.md} />, disabled: alone && !solo, onSelect: act(() => toggleSolo(id)) },
    { label: "设为主格", icon: <LayoutPanelLeft size={ICON.md} />, disabled: alone || layout.primary === id, onSelect: act(() => makePrimary(id)) },
    "sep",
    ...MOVES.map(({ dir, label, icon: I }) => ({ label, icon: <I size={ICON.md} />, disabled: alone || !canMove(layout, id, dir), onSelect: act(() => moveTo(id, dir)) })),
    "sep",
    ...sessionItems,
    "sep",
    { label: "关闭小窗", icon: <X size={ICON.md} />, onSelect: act(() => closePane(id)) },
  ];
  return (
    <>
      <Menu
        items={items}
        data-pane-menu=""
        onCloseAutoFocus={(e) => {
          if (acted.current) e.preventDefault();
          acted.current = false;
        }}
        trigger={
          <IconButton size="sm" label="更多">
            <MoreHorizontal size={ICON.sm} />
          </IconButton>
        }
      />
      {dialogs}
    </>
  );
}

/** 窄窗时焦点格标题栏上的“分屏（N）”：点开切换焦点格显示哪个会话（布局不变，变宽后原样恢复）。 */
function SplitSwitcher({ layout, focus }: { layout: Layout; focus: string }) {
  const sessions = useApp((s) => s.sessions);
  const list = ids(layout);
  // 选了会话：菜单关掉时不把焦点还给这个按钮，键盘焦点交给选中的会话
  const picked = useRef(false);
  return (
    <Menu
      align="start"
      data-split-switch-menu=""
      onCloseAutoFocus={(e) => {
        if (picked.current) e.preventDefault();
        picked.current = false;
      }}
      items={list.map((x) => ({
        label: sessions.find((s) => s.id === x)?.title ?? x,
        icon: x === focus ? <Check size={ICON.md} /> : undefined,
        onSelect: () => {
          picked.current = true;
          focusPane(x, true);
        },
      }))}
      trigger={
        <Button size="sm" variant="ghost" icon={<Columns2 size={ICON.sm} />} data-split-switch="">
          分屏（{list.length}）
        </Button>
      }
    />
  );
}

/**
 * 共享面板：焦点格那个会话的面板（Workspace）。换焦点时整个换掉（只为焦点会话取数据），当前标签页不变（tab 在 SplitView 里）。
 * 标签页第一次选中（或面板打开时就停在那一页）才挂上；“终端”标签页另算一路连接：点开过之后保持到面板关闭或焦点会话换掉，
 * 离开“终端”页不断开（分屏稿 15.2 第 2 条）。面板终端只在用户点“终端”标签时拿键盘焦点，Workspace 里处理（15.1 第 3 条）。
 */
function SharedPanel({ session, tab, onTab }: { session: Session; tab: Tab; onTab: (t: Tab) => void }) {
  const agents = useApp((s) => s.agents);
  const servers = useApp((s) => s.servers);
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  const [focusRun, setFocusRun] = useState<{ id: string; n: number } | null>(null);
  const [research, setResearch] = useResearch(session.id, session);
  const pick = (t: Tab) => {
    onTab(t);
    setOpened((prev) => new Set(prev).add(t));
  };
  return (
    <Workspace
      session={session}
      server={serverOf(servers, session.server_id)}
      agent={agentOf(agents, session.agent_id)}
      tab={tab}
      opened={opened}
      onPick={pick}
      research={research}
      onResearch={setResearch}
      focusRun={focusRun}
      onRun={(runId) => {
        setFocusRun((prev) => ({ id: runId, n: (prev?.n ?? 0) + 1 }));
        pick("research");
      }}
      onCompose={(text) => paneBar(session.id)?.fill(text)}
      onQuote={(q) => paneBar(session.id)?.attach(q)}
    />
  );
}
