// 分屏的布局规则（.orchestra/design-split-view.md 第 1、4、5、6 节）：全是纯函数，不依赖 React 和 DOM。
// ui/scripts/check-split.ts 用 node --experimental-strip-types 直接跑这个文件，所以这里不 import 任何模块。
//
// 模型：一个主格固定在左上（列 0、行 0），其余格子是 extras，位置 { col, row }，row 只有 0、1；最多 3 列 × 2 行。
// extras 的顺序就是加入的顺序（“全满时替换最后加入的那一格”按它算）。焦点不存：地址里的会话就是焦点。

export const SPLIT_KEY = "bunsen.split.v1";
export const DRAWER_KEY = "bunsen.split.drawer";
export const MAX_COLS = 3;
export const MAX_PANES = 6;
/** 每列的宽度预算：可用列数 = clamp(floor(网格宽 / 480), 1, 3)。 */
export const COL_BUDGET = 480;
export const MIN_COL_W = 320;
export const MIN_ROW_H = 200;
/** 网格比这窄时只显示焦点格。 */
export const NARROW_W = 900;
/** 格子之间的分隔线。 */
export const DIVIDER = 1;
export const DEFAULT_ROW_SPLIT = 0.5;
/** 共享面板占会话页宽度的百分比：缺省、最小、最大。 */
export const DRAWER_DEFAULT = 32;
export const DRAWER_MIN = 20;
export const DRAWER_MAX = 60;

export type Row = 0 | 1;
export type Cell = { id: string; col: number; row: Row };
export type Layout = { version: 1; primary: string; extras: Cell[]; colWeights: number[]; rowSplit: number };
export type Where = "right" | "below";
export type Dir = "left" | "right" | "up" | "down";
export type Drawer = { open: boolean; size: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const okSplit = (r: unknown): r is number => typeof r === "number" && Number.isFinite(r) && r > 0 && r < 1;
const round = (n: number) => Math.round(n * 10000) / 10000;

export function single(id: string): Layout {
  return { version: 1, primary: id, extras: [], colWeights: [], rowSplit: DEFAULT_ROW_SPLIT };
}

/** 按加入顺序的全部格子：主格在前。 */
function cells(l: Layout): Cell[] {
  return [{ id: l.primary, col: 0, row: 0 }, ...l.extras];
}

/** 全部格子（含主格），按列、行排序：焦点循环、“下一格”、关主格后的提升都按这个顺序。 */
export function panes(l: Layout): Cell[] {
  return cells(l).sort((a, b) => a.col - b.col || a.row - b.row);
}
export const ids = (l: Layout): string[] => panes(l).map((c) => c.id);
export const count = (l: Layout | null): number => (l ? 1 + l.extras.length : 0);
export const has = (l: Layout | null, id: string | null | undefined): boolean => Boolean(l && id && (l.primary === id || l.extras.some((c) => c.id === id)));
export const columns = (l: Layout): number => 1 + Math.max(0, ...l.extras.map((c) => c.col));
export const cellOf = (l: Layout, id: string): Cell | undefined => cells(l).find((c) => c.id === id);
const at = (list: Cell[], col: number, row: Row) => list.find((c) => c.col === col && c.row === row);
/** 有没有哪一列是上下两格。 */
export const twoRows = (l: Layout): boolean => l.extras.some((c) => c.row === 1);
/** 这一格是不是独占一整列（上下没有别的格子）。 */
export const spans = (l: Layout, c: Cell): boolean => c.row === 0 && !at(cells(l), c.col, 1);

/** 可用列数：clamp(floor(网格宽 / 480), 1, 3)。 */
export function maxColumns(width: number): number {
  return clamp(Math.floor(width / COL_BUDGET), 1, MAX_COLS);
}

/**
 * 规范化：去重（同一会话、同一位置都只留先来的）；去掉空列、列号重排；只剩下格的列，下格上提；(0,0) 那格成为主格。
 * 列数和 prev 不同时列宽回到等宽；行比例不合法时回到各半。
 */
function build(list: Cell[], prev: Layout): Layout {
  const seen = new Set<string>();
  const taken = new Set<string>();
  let out = list.filter((c) => {
    const k = `${c.col}:${c.row}`;
    if (seen.has(c.id) || taken.has(k)) return false;
    seen.add(c.id);
    taken.add(k);
    return true;
  });
  const cols = [...new Set(out.map((c) => c.col))].sort((a, b) => a - b);
  out = out.map((c) => ({ ...c, col: cols.indexOf(c.col) }));
  out = out.map((c) => (c.row === 1 && !at(out, c.col, 0) ? { ...c, row: 0 as Row } : c));
  const primary = at(out, 0, 0);
  if (!primary) throw new Error("分屏布局没有主格");
  const n = cols.length;
  return {
    version: 1,
    primary: primary.id,
    extras: out.filter((c) => c !== primary).map((c) => ({ id: c.id, col: c.col, row: c.row })),
    colWeights: n === columns(prev) && prev.colWeights.length === n ? prev.colWeights : [],
    rowSplit: okSplit(prev.rowSplit) ? prev.rowSplit : DEFAULT_ROW_SPLIT,
  };
}

/** 规范化一份布局（读存储、手写的布局用）。 */
export function normalize(l: Layout): Layout {
  return build(cells(l), l);
}

export type AddOpts = {
  /** 当前网格宽度下的可用列数（maxColumns）。 */
  maxCols: number;
  /** 焦点格：“在下方打开”放在它下面；全满时它不被替换。 */
  focus?: string | null;
  where?: Where;
  /** 拖进来时放下的那一格：右侧在它右边开新列，下方开在它下面。 */
  anchor?: string | null;
};
export type AddResult = { layout: Layout; focus: string; added: boolean; replaced: string | null };

/**
 * 加一格（分屏稿第 1 节）：
 * - 已经在网格里：不重复开，只把焦点移过去（added 为 false）；
 * - 在下方打开：焦点格（或 anchor）下面空着就放那里，否则按下面的规则；
 * - 列数没到上限：在最右开新列（有 anchor 时开在 anchor 那一列的右边）；
 * - 列数到上限：按列从左到右填空着的下格；
 * - 全满：替换焦点以外最后加入的那一格（replaced 是被换掉的会话）。
 */
export function addPane(l: Layout, id: string, o: AddOpts): AddResult {
  if (has(l, id)) return { layout: l, focus: id, added: false, replaced: null };
  const list = cells(l);
  const cols = columns(l);
  const maxCols = clamp(Math.floor(o.maxCols) || 1, 1, MAX_COLS);
  const room = list.length < MAX_PANES;
  const done = (layout: Layout): AddResult => ({ layout, focus: id, added: true, replaced: null });
  if (o.where === "below" && room) {
    const anchor = list.find((c) => c.id === (o.anchor ?? o.focus));
    if (anchor && anchor.row === 0 && !at(list, anchor.col, 1)) return done(build([...list, { id, col: anchor.col, row: 1 }], l));
  }
  if (cols < maxCols && room) {
    const anchor = o.anchor ? list.find((c) => c.id === o.anchor) : undefined;
    const after = anchor ? anchor.col : cols - 1;
    const shifted = list.map((c) => (c.col > after ? { ...c, col: c.col + 1 } : c));
    return done(build([...shifted, { id, col: after + 1, row: 0 }], l));
  }
  if (room) for (let c = 0; c < cols; c++) if (!at(list, c, 1)) return done(build([...list, { id, col: c, row: 1 }], l));
  const victim = [...list].reverse().find((c) => c.id !== o.focus) ?? list[list.length - 1];
  return { layout: replacePane(l, victim.id, id), focus: id, added: true, replaced: victim.id };
}

/**
 * 拖进网格（分屏稿第 1、5 节，12.3）：
 * - 放在下半边：目标下面空着就开在它下面；
 * - 列数没到上限：在目标那一列的右边开新列；
 * - 放在右半边、列数已到上限：目标下面空着就开在它下面；
 * - 否则按第 1 节的顺序填空着的下格；全满时替换放下的那一格（而不是“最后加入的那一格”）。
 */
export function dropPane(l: Layout, id: string, target: string, side: Where, maxCols: number): AddResult {
  if (has(l, id)) return { layout: l, focus: id, added: false, replaced: null };
  const list = cells(l);
  const t = list.find((c) => c.id === target);
  if (!t) return addPane(l, id, { maxCols, focus: target, where: side });
  const done = (layout: Layout): AddResult => ({ layout, focus: id, added: true, replaced: null });
  const max = clamp(Math.floor(maxCols) || 1, 1, MAX_COLS);
  const cols = columns(l);
  const belowFree = t.row === 0 && !at(list, t.col, 1);
  if (list.length < MAX_PANES) {
    if (side === "below" && belowFree) return done(build([...list, { id, col: t.col, row: 1 }], l));
    if (cols < max) return done(build([...list.map((c) => (c.col > t.col ? { ...c, col: c.col + 1 } : c)), { id, col: t.col + 1, row: 0 }], l));
    if (belowFree) return done(build([...list, { id, col: t.col, row: 1 }], l));
    for (let c = 0; c < cols; c++) if (!at(list, c, 1)) return done(build([...list, { id, col: c, row: 1 }], l));
  }
  return { layout: replacePane(l, target, id), focus: id, added: true, replaced: target };
}

/**
 * 拖入提示（12.3）：由落点反推，保证提示和松手后的结果一致。
 * kind：focus（已在分屏中）、replace（替换 of）、right（在 of 右边打开）、below（在 of 下面打开）、open（不进分屏，直接打开 of，13.8）；
 * area：高亮放下的那一格的哪一块（right 右半、below 下半、all 整格）。落点不挨着目标时高亮整格，文字写实际位置。
 */
export type DropHint = { kind: "focus" | "replace" | "open" | Where; of: string; area: Where | "all" };
export type DropPlan = { result: AddResult; hint: DropHint };

/** 由加格的结果反推提示（target：放下的那一格；不在结果里时高亮整格）。 */
function hintFor(result: AddResult, id: string, target: string | null | undefined): DropHint {
  if (!result.added) return { kind: "focus", of: id, area: "all" };
  if (result.replaced) return { kind: "replace", of: result.replaced, area: "all" };
  const list = cells(result.layout);
  const me = list.find((c) => c.id === id) as Cell;
  if (me.row === 1) {
    const above = (at(list, me.col, 0) as Cell).id;
    return { kind: "below", of: above, area: above === target ? "below" : "all" };
  }
  const t = list.find((c) => c.id === target);
  if (t && t.col === me.col - 1) return { kind: "right", of: t.id, area: "right" };
  return { kind: "right", of: (at(list, me.col - 1, 0) as Cell).id, area: "all" };
}

export function planDrop(l: Layout, id: string, target: string, side: Where, maxCols: number): DropPlan {
  const result = dropPane(l, id, target, side, maxCols);
  return { result, hint: hintFor(result, id, target) };
}

export type OpenPlan = { result: AddResult | null; hint: DropHint };

/**
 * “在分屏中打开”的落点和提示（12.3、13.8）：openInSplit（菜单、选择框、拖入）和拖入提示都只调它，回退只有这一套。
 * - 没有底（base 为 null，见 splitBase）：不进分屏，直接打开 id（result 为 null，提示 open）；
 * - 拖进来、放下的那一格在底里：按 planDrop；
 * - 其余（菜单、选择框没有 target；放下的那一格不在底里，例如它的会话已不在会话列表里）：按 addPane 的顺序放在焦点格右边或下面。
 * 提示一律由结果反推（hintFor），所以和松手后的结果一致。
 */
export function planOpen(base: Layout | null, id: string, o: { where: Where; maxCols: number; focus: string | null; target?: string | null }): OpenPlan {
  if (!base) return { result: null, hint: { kind: "open", of: id, area: "all" } };
  if (o.target && has(base, o.target)) return planDrop(base, id, o.target, o.where, o.maxCols);
  const result = addPane(base, id, { maxCols: o.maxCols, focus: o.focus, where: o.where });
  return { result, hint: hintFor(result, id, o.target) };
}

/**
 * 在原位置把一格换成另一个会话（侧栏点击、后退前进、全满时的替换）。换进来的算最后加入。
 * 新会话已经在网格里时不变（调用方只移焦点）。
 */
export function replacePane(l: Layout, from: string, to: string): Layout {
  if (!has(l, from) || has(l, to)) return l;
  const list = cells(l);
  const old = list.find((c) => c.id === from)!;
  const rest = list.filter((c) => c !== old);
  const cell = { ...old, id: to };
  // 主格留在最前（它的位置固定）；其余的换进来的放到最后
  return build(old.col === 0 && old.row === 0 ? [cell, ...rest] : [...rest, cell], l);
}

/**
 * 减一格：去掉空列、只剩下格的列下格上提；关掉主格时，下一格（按列、行顺序）补到左上成为主格。
 * focus：关掉的是焦点格时焦点该去哪（按列、行顺序的下一格，没有就上一格）。最后一格关掉后 layout 为 null。
 */
export function removePane(l: Layout, id: string): { layout: Layout | null; focus: string | null } {
  const order = ids(l);
  const i = order.indexOf(id);
  if (i < 0) return { layout: l, focus: null };
  const rest = cells(l).filter((c) => c.id !== id);
  if (rest.length === 0) return { layout: null, focus: null };
  const left = order.filter((x) => x !== id);
  return { layout: build(rest, l), focus: left[Math.min(i, left.length - 1)] };
}

/**
 * 移到左、右、上、下（“更多”菜单）。目标位置有格子就交换，空着（相邻列的下格）就移过去。
 * 不能移时返回 null：最左不能左移、最右不能右移；上格不能上移；下面空着的上格不能下移（移下去也会被提上来）。
 */
export function movePane(l: Layout, id: string, dir: Dir): Layout | null {
  const list = cells(l);
  const me = list.find((c) => c.id === id);
  if (!me) return null;
  const cols = columns(l);
  const to =
    dir === "left" ? { col: me.col - 1, row: me.row } : dir === "right" ? { col: me.col + 1, row: me.row } : dir === "up" ? { col: me.col, row: 0 as Row } : { col: me.col, row: 1 as Row };
  if (to.col < 0 || to.col >= cols) return null;
  if (dir === "up" && me.row !== 1) return null;
  if (dir === "down" && me.row !== 0) return null;
  const other = at(list, to.col, to.row);
  if (!other && (dir === "down" || to.row === 0)) return null;
  const next = list.map((c) => (c === me ? { ...c, col: to.col, row: to.row } : other && c === other ? { ...c, col: me.col, row: me.row } : c));
  return build(next, l);
}
export const canMove = (l: Layout, id: string, dir: Dir): boolean => movePane(l, id, dir) !== null;

/** 设为主格：和左上那格交换位置。 */
export function setPrimary(l: Layout, id: string): Layout {
  if (l.primary === id || !has(l, id)) return l;
  const me = cellOf(l, id)!;
  const list = cells(l).map((c) => (c.id === id ? { ...c, col: 0, row: 0 as Row } : c.id === l.primary ? { ...c, col: me.col, row: me.row } : c));
  return build(list, l);
}

/** 焦点循环（Ctrl+Mod+] / [）：按列、行顺序，末尾回到开头。 */
export function nextFocus(l: Layout, id: string, step: 1 | -1): string {
  const order = ids(l);
  const i = order.indexOf(id);
  if (i < 0) return order[0];
  return order[(i + step + order.length) % order.length];
}

/**
 * 网格放不下时暂时收起其余格子，只显示焦点格（分屏稿第 1 节“窄窗”）：网格宽 < 900；或者已有的列在最小列宽下放不下；
 * 或者有上下两格的列而高度放不下两行。只看尺寸，不改布局。
 */
export function isCollapsed(l: Layout, width: number, height: number): boolean {
  if (count(l) < 2) return false;
  const cols = columns(l);
  if (width < NARROW_W) return true;
  if (width < cols * MIN_COL_W + (cols - 1) * DIVIDER) return true;
  return twoRows(l) && height < 2 * MIN_ROW_H + DIVIDER;
}

/** 要渲染的格子：单独查看时只有那一格；收起时只有焦点格；否则全部（按列、行顺序）。 */
export function visiblePanes(l: Layout, o: { focus: string | null; solo?: string | null; width: number; height: number }): string[] {
  if (o.solo && has(l, o.solo)) return [o.solo];
  if (isCollapsed(l, o.width, o.height)) return [has(l, o.focus) ? (o.focus as string) : l.primary];
  return ids(l);
}

// ---------- 列宽、行比例 ----------

const usable = (size: number, parts: number) => size - (parts - 1) * DIVIDER;

/** 保存的列宽在当前宽度下是否可用：列数对得上、都是正数、每列不窄于 320。 */
export function weightsFit(weights: number[], cols: number, width: number): boolean {
  if (cols < 1 || weights.length !== cols) return false;
  if (!weights.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)) return false;
  const sum = weights.reduce((a, b) => a + b, 0);
  const avail = usable(width, cols);
  return weights.every((w) => (w / sum) * avail >= MIN_COL_W - 0.5);
}

/** 当前要用的列宽（相对值）：保存的不可用就等宽。 */
export function effectiveWeights(l: Layout, width: number): number[] {
  const cols = columns(l);
  return weightsFit(l.colWeights, cols, width) ? l.colWeights : Array.from({ length: cols }, () => 1);
}

/** 当前要用的行比例：两行各自放不下 200 时回到各半。 */
export function effectiveRowSplit(l: Layout, height: number): number {
  const avail = usable(height, 2);
  const r = okSplit(l.rowSplit) ? l.rowSplit : DEFAULT_ROW_SPLIT;
  return r * avail >= MIN_ROW_H - 0.5 && (1 - r) * avail >= MIN_ROW_H - 0.5 ? r : DEFAULT_ROW_SPLIT;
}

/**
 * 拖第 i 条竖分隔线（第 i 列和第 i+1 列之间）dx 像素：只在这两列之间转移宽度，两列都不窄于 320。
 * 返回新的列宽（相对值，和为列数）。
 */
export function dragColumns(weights: number[], i: number, dx: number, width: number): number[] {
  const cols = weights.length;
  if (i < 0 || i >= cols - 1) return weights;
  const sum = weights.reduce((a, b) => a + b, 0);
  const avail = usable(width, cols);
  const px = weights.map((w) => (w / sum) * avail);
  const pair = px[i] + px[i + 1];
  if (pair < 2 * MIN_COL_W) return weights;
  const left = clamp(px[i] + dx, MIN_COL_W, pair - MIN_COL_W);
  px[i] = left;
  px[i + 1] = pair - left;
  return px.map((p) => round((p / avail) * cols));
}

/**
 * 松手时写入列宽（分屏稿 13.7）：权重个数等于布局此刻的列数才写，返回新布局；不等时返回 null，不写
 * （拖动途中格数变了：关掉、加进一格，而这条分隔线还在）。空数组是复位（双击、Home），总能写。
 */
export function withColWeights(l: Layout | null, weights: number[]): Layout | null {
  if (!l || (weights.length > 0 && weights.length !== columns(l))) return null;
  return { ...l, colWeights: weights };
}

/** 拖横分隔线 dy 像素：全网格一个比例，上下两行都不矮于 200。 */
export function dragRows(split: number, dy: number, height: number): number {
  const avail = usable(height, 2);
  if (avail < 2 * MIN_ROW_H) return split;
  const top = clamp(split * avail + dy, MIN_ROW_H, avail - MIN_ROW_H);
  return round(top / avail);
}

/** CSS Grid 的轨道：列之间、行之间各是一条 1px 的分隔线轨道。 */
export const colTracks = (weights: number[]): string => weights.map((w) => `minmax(0, ${w}fr)`).join(` ${DIVIDER}px `);
export const rowTracks = (split: number): string => `minmax(0, ${split}fr) ${DIVIDER}px minmax(0, ${round(1 - split)}fr)`;

// ---------- 存储 ----------

/** 读 localStorage 里的布局：版本不对、格式不对时丢弃（返回 null），不报错。 */
export function parseLayout(raw: unknown): Layout | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.primary !== "string" || !r.primary || !Array.isArray(r.extras)) return null;
  if (!Array.isArray(r.colWeights) || !okSplit(r.rowSplit)) return null;
  if (r.extras.length > MAX_PANES - 1 || r.colWeights.length > MAX_COLS) return null;
  if (!r.colWeights.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)) return null;
  const extras: Cell[] = [];
  const seen = new Set<string>([r.primary]);
  const taken = new Set<string>(["0:0"]);
  for (const e of r.extras) {
    if (!e || typeof e !== "object") return null;
    const c = e as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id || !Number.isInteger(c.col) || (c.row !== 0 && c.row !== 1)) return null;
    const col = c.col as number;
    if (col < 0 || col >= MAX_COLS) return null;
    const k = `${col}:${c.row}`;
    if (seen.has(c.id) || taken.has(k)) return null;
    seen.add(c.id);
    taken.add(k);
    extras.push({ id: c.id, col, row: c.row });
  }
  return normalize({ version: 1, primary: r.primary, extras, colWeights: r.colWeights as number[], rowSplit: r.rowSplit });
}

/** 共享面板的开关和宽度：格式不对时用缺省（关着、32%）。 */
export function parseDrawer(raw: unknown): Drawer {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const open = typeof r.open === "boolean" ? r.open : false;
  const size = typeof r.size === "number" && Number.isFinite(r.size) && r.size >= DRAWER_MIN && r.size <= DRAWER_MAX ? r.size : DRAWER_DEFAULT;
  return { open, size };
}

/**
 * 去掉已删除、已归档的会话（打开时校验；使用中被删、被归档时关掉它的小窗）。alive 返回 false 的拿掉；
 * keep（地址里的会话）总是留着：单独打开一个已归档的会话照样能看。全拿掉了返回 null。
 */
export function prune(l: Layout, alive: (id: string) => boolean, keep?: string | null): Layout | null {
  let cur: Layout | null = l;
  for (const id of ids(l)) {
    if (!cur || id === keep || alive(id)) continue;
    cur = removePane(cur, id).layout;
  }
  return cur;
}

// ---------- 路由同步、会话列表变化、在分屏中打开（分屏稿第 4、6 节，12.2） ----------

export type SessionLite = { id: string; archived?: boolean };

/**
 * “存在”的判断（14.2）：在会话列表里，含已归档的（从归档里打开的会话算存在）。splitBase 的 exists、打开时校验的 keep、
 * routeLayout、showsSplit 都用这一个。
 */
export const listed =
  (sessions: SessionLite[]) =>
  (id: string | null | undefined): boolean =>
    Boolean(id) && sessions.some((s) => s.id === id);

/**
 * 地址换成会话 id 时的布局：已在网格里不变（只移焦点）；不在就替换上次的焦点格（它不在网格里时替换主格）；没有布局时建单格布局。
 * exists（会话列表就绪后给）：id 不在列表里（旧链接、后退到已删除的会话）时不改布局，原样返回 l（可能是 null），
 * 页面显示单会话页的“找不到这个对话”（14.2）。不给 exists（列表还没就绪）时照旧。
 */
export function routeLayout(l: Layout | null, id: string, last: string | null, exists?: (id: string) => boolean): Layout | null {
  if (exists && !exists(id)) return l;
  if (!l) return single(id);
  if (has(l, id)) return l;
  return replacePane(l, last && has(l, last) ? last : l.primary, id);
}

/** 会话页是分屏还是单会话页（14.2）：网格里两格以上、而且地址里的会话存在；不存在时是单会话页的“找不到这个对话”，布局不动。 */
export function showsSplit(l: Layout | null, route: string, exists: (id: string) => boolean): boolean {
  return count(l) > 1 && exists(route);
}

/**
 * 页面上此刻显示几格（15.2 第 3 条）：显示网格时是网格里的格数；没有显示网格（单会话页、“找不到这个对话”、不在会话页）时是 1。
 * 分屏快捷键（切换焦点、关闭小窗截不截，shortcutFor 的 panes）和面板开关（开关分屏的面板还是单会话页右边那一栏）都按这个数，
 * 不按存储里看不见的布局：“找不到这个对话”页上存着 A|B 时，Ctrl+Mod+] 不把这条历史记录换成 A，Ctrl+Mod+B 不动分屏的面板状态。
 */
export function shownPanes(l: Layout | null, route: string | null, exists: (id: string) => boolean): number {
  return route !== null && showsSplit(l, route, exists) ? count(l) : 1;
}

/**
 * 会话列表变了以后布局里该拿掉哪些（12.2：不论几格；拿空了返回 null）。
 * - 打开时校验（before 为 null）：已删除、已归档的都拿掉；keep（地址里的会话）只要在列表里就留着（14.2，和 splitBase 一致），
 *   单独打开一个已归档的会话照样能看；不在列表里（找不到这个对话）的照样拿掉。
 * - 使用中（before 是上一份列表）：只拿掉这次被删除、这次被归档的；之前就已归档的（从归档里打开的那一格）不动，
 *   上一份列表里没有的（刚建的）也不动。
 */
export function pruneSessions(l: Layout, now: SessionLite[], before: SessionLite[] | null, keep?: string | null): Layout | null {
  const cur = new Map(now.map((s) => [s.id, s]));
  if (!before) return prune(l, (id) => Boolean(cur.get(id) && !cur.get(id)!.archived), listed(now)(keep) ? keep : null);
  const old = new Map(before.map((s) => [s.id, s]));
  return prune(l, (id) => {
    const p = old.get(id);
    const c = cur.get(id);
    return !p || (Boolean(c) && !(c!.archived && !p.archived));
  });
}

/** 剪枝以后焦点去哪：焦点格还在就不动；被拿掉了就去按列、行顺序的下一格（没有就上一格）；布局空了、焦点本来就不在网格里时为 null。 */
export function focusAfter(l: Layout, next: Layout | null, focus: string | null): string | null {
  if (!next || !focus || !has(l, focus)) return null;
  if (has(next, focus)) return focus;
  const order = ids(l);
  const left = order.filter((x) => has(next, x));
  return left[Math.min(order.indexOf(focus), left.length - 1)] ?? next.primary;
}

/**
 * “在分屏中打开”以哪份布局为底（12.2）：保存的布局先去掉已经不在会话列表里的会话（地址里那个只要还在就留着；
 * 从归档里打开的那一格也留着，归档是使用中的变化，由 pruneSessions 关掉）。
 * 焦点：地址里的会话；不在会话页时是上次的焦点（还在布局里的话）。剩下的布局空了时，有焦点就从它的单格开始，否则 base 为 null（直接打开）。
 */
export function splitBase(l: Layout | null, o: { route: string | null; last: string | null; exists: (id: string) => boolean }): { base: Layout | null; focus: string | null } {
  const route = o.route && o.exists(o.route) ? o.route : null;
  const kept = l ? prune(l, o.exists, route) : null;
  const focus = route ?? (o.last && has(kept, o.last) ? o.last : null);
  return { base: kept ?? (focus ? single(focus) : null), focus };
}

// ---------- 快捷键（分屏稿第 5 节） ----------

export type KeyLike = { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; altGraph?: boolean; isComposing?: boolean };
export type SplitAction = Where | "next" | "prev" | "close" | "panel";
/** 快捷键按哪种系统认（13.10）：linux 指 macOS、Windows 以外的系统（Linux、ChromeOS……）。纯函数不读 navigator，由调用方传进来。 */
export type Os = "mac" | "windows" | "linux";
/** navigator.platform → Os。 */
export function platformOf(platform: string): Os {
  if (/Mac|iPhone|iPad|iPod/.test(platform)) return "mac";
  if (/^Win/.test(platform)) return "windows";
  return "linux";
}

const BY_CODE: Record<string, SplitAction> = { Backslash: "right", IntlBackslash: "right", Minus: "below", BracketRight: "next", BracketLeft: "prev", KeyW: "close", KeyB: "panel" };
const BY_KEY: Record<string, SplitAction> = { "\\": "right", "-": "below", "]": "next", "[": "prev", w: "close", b: "panel" };
/** 这几个键位在美式布局下打出的字符。 */
const US_CHAR: Record<string, string> = { Backslash: "\\", IntlBackslash: "\\", Minus: "-", BracketRight: "]", BracketLeft: "[", KeyW: "w", KeyB: "b" };
/** 一个字母（Unicode \p{L}：拉丁、西里尔、希腊、希伯来……含 ü、å、ß）。 */
const LETTER = /^\p{L}$/u;

/**
 * 分屏快捷键：Ctrl + Mod + 键。Mod 在 macOS 是 Cmd，其他系统是 Alt（带 Meta、即 Win 键的不算）。带 Shift、AltGr 标志的不算。
 * 按物理键位（code）认，code 为空时按 key。
 * AltGr（分屏稿 13.1、13.10）：
 * - Linux 等：AltGr 不会带出 Ctrl+Alt，只看 AltGraph 标志。key 是这个键位的本地符号时照常截（德语布局 Ctrl+Alt+] 的 key 是 +，
 *   法语布局是 $）。
 * - Windows 上 Ctrl+Alt 就是 AltGr：事件没带 AltGraph 标志时，只有 key 是单个字符、不是字母、又不是这个键位在美式布局下的字符，
 *   才当作 AltGr 打出来的字符放行（德语布局 Ctrl+Alt+ß 打出 \、Ctrl+Alt++ 打出 ~，美式国际布局打出 « » ¥ ¬）。
 * - 三种系统上 key 是字母时都照常按键位截：俄语布局 Ctrl+Alt+W 的 key 是 ц、Ctrl+Alt+[ 是 х，希腊语 Ctrl+Alt+B 是 β，德语 Ctrl+Alt+[ 是 ü。
 *
 * 已知限制（分屏稿 13.2、13.10，v1 接受；Bunsen 还没有面向用户的快捷键文档，记在这里和设计稿里）：
 * - 非 macOS 上，截下来的 Ctrl+Alt+\ - [ ] W B 会盖住终端里同样的 Meta+Ctrl 组合（emacs、readline 的少数命令）；
 * - Windows 上 xterm 自己把 Ctrl+Alt 当 AltGr：单格时这些组合即使不截，也送不到终端；
 * - Windows 上德语、法语等布局里，AltGr 打出符号的那几个键位（如德语的 +、法语的 $）当快捷键用不了。
 */
export function splitKey(e: KeyLike, os: Os): SplitAction | null {
  const mac = os === "mac";
  if (!e.ctrlKey || e.shiftKey || e.altGraph) return null;
  if (mac ? !e.metaKey || e.altKey : !e.altKey || e.metaKey) return null;
  if (!e.code) return BY_KEY[e.key.toLowerCase()] ?? null;
  const a = BY_CODE[e.code] ?? null;
  if (a && os === "windows" && [...e.key].length === 1 && !LETTER.test(e.key) && e.key.toLowerCase() !== US_CHAR[e.code]) return null;
  return a;
}

/** 判断快捷键时要知道的此刻状态：哪种系统、在不在会话页、网格里几格、有没有打开的对话框或命令面板。 */
export type ShortcutCtx = { os: Os; session: boolean; panes: number; overlay: boolean };

/**
 * 分屏快捷键此刻要不要截下来（12.4）：动作不会产生效果时不截，按键原样送给终端。
 * - 不在会话页、页面上有打开的对话框或命令面板、输入法组合中：不截；
 * - 只有一格时的切换焦点（] [）和关闭小窗（W）：不截；
 * - 开在右边、下方（打开会话选择框）和面板开关在会话页总是有效（单会话页的 B 开关右边那一栏）。
 */
export function shortcutFor(e: KeyLike, c: ShortcutCtx): SplitAction | null {
  if (!c.session || c.overlay || e.isComposing || e.key === "Process") return null;
  const a = splitKey(e, c.os);
  if (!a) return null;
  if ((a === "next" || a === "prev" || a === "close") && c.panes < 2) return null;
  return a;
}
