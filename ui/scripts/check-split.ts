// 分屏布局规则的检查（.orchestra/design-split-view.md 第 1、5、6 节；规则在 src/lib/split.ts）。不引入任何依赖：
//   node --experimental-strip-types scripts/check-split.ts      失败即退出码 1
// 覆盖：1→6 格的加格顺序、全满替换、重复打开只移焦点、在下方打开、拖入的放置；减格后去空列和下格上提、关主格后的提升；
// 四个方向的移动和不能移时的判断、设为主格、替换；窄窗收起与恢复不改布局；列宽、行比例的校验和拖动；
// 存储的版本和格式不对时丢弃；已删除、已归档会话被剔除；焦点循环；快捷键识别。
// 统一审查第 1 轮（分屏稿第 12 节）补：审查列出的 6 条存活变异各自的用例；路由同步的布局、会话列表变化后的剪枝（不论几格）、
// “在分屏中打开”的底；拖入的落点和提示出自同一个函数（12.3）；快捷键只在有效时截（12.4）。
// 第 1 轮修复之后（分屏稿第 13 节）补：松手时列宽个数等于当前列数才写（13.7）；放下的那一格不在底里时提示和落点走同一个回退（13.8）；
// 非 macOS 的 AltGr 判断，key 是字母时照常截（13.1）。
// 统一审查第 2 轮之后（分屏稿第 14 节）补：AltGr 的字符回退只在 Windows 上用，平台由调用方传进来（13.10）；code 为空时全部 6 个键、
// 非 macOS 带 Meta 不算（U2-08）；地址里的会话不在会话列表里时不改布局、显示“找不到这个对话”，审查的两个场景（14.2）。
// 统一审查第 3 轮之后（分屏稿 15.2 第 3 条）补：页面上没有显示网格（“找不到这个对话”）时快捷键按单会话页处理（shownPanes）。
import {
  addPane,
  canMove,
  colTracks,
  columns,
  count,
  dragColumns,
  dragRows,
  dropPane,
  effectiveRowSplit,
  effectiveWeights,
  focusAfter,
  has,
  ids,
  isCollapsed,
  listed,
  maxColumns,
  movePane,
  nextFocus,
  panes,
  parseDrawer,
  parseLayout,
  planDrop,
  planOpen,
  platformOf,
  prune,
  pruneSessions,
  removePane,
  replacePane,
  routeLayout,
  rowTracks,
  setPrimary,
  shortcutFor,
  showsSplit,
  shownPanes,
  single,
  spans,
  splitBase,
  splitKey,
  visiblePanes,
  weightsFit,
  withColWeights,
  type AddResult,
  type DropHint,
  type KeyLike,
  type Layout,
  type Os,
  type ShortcutCtx,
  type SplitAction,
  type Where,
} from "../src/lib/split.ts";

let pass = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) pass++;
  else fails.push(`${name}${detail === undefined ? "" : `  ← ${JSON.stringify(detail)}`}`);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== undefined ? `  ← ${JSON.stringify(detail)}` : ""}`);
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** 布局画成 “列,行=会话” 的列表，便于比较。 */
const grid = (l: Layout | null) => (l ? panes(l).map((c) => `${c.col},${c.row}=${c.id}`).join(" ") : "∅");
/** 非 macOS 的两种系统（13.10：Windows 和 Linux 只在 AltGr 字符的回退上不同）。 */
const PC: Os[] = ["windows", "linux"];
/** 三种系统上结果都一样时返回它，否则返回“不一致”：Windows、Linux 用给的 Ctrl+Alt 事件，macOS 换成 Ctrl+Cmd。 */
function onAll(e: KeyLike): SplitAction | null | "不一致" {
  const r = [splitKey(e, "windows"), splitKey(e, "linux"), splitKey({ ...e, altKey: false, metaKey: true }, "mac")];
  return r.every((x) => x === r[0]) ? r[0] : "不一致";
}
/** 依次加格（每次焦点移到新格，和界面一致）。 */
function build(list: string[], maxCols: number): Layout {
  let l = single(list[0]);
  let focus = list[0];
  for (const id of list.slice(1)) {
    const r = addPane(l, id, { maxCols, focus });
    l = r.layout;
    focus = r.focus;
  }
  return l;
}

// ---------- 1. 加格顺序 ----------
{
  const steps: string[] = [];
  let l = single("A");
  let focus = "A";
  for (const id of ["B", "C", "D", "E", "F"]) {
    const r = addPane(l, id, { maxCols: 3, focus });
    l = r.layout;
    focus = r.focus;
    steps.push(grid(l));
  }
  check("加格 1→2：先在最右开新列", steps[0] === "0,0=A 1,0=B", steps[0]);
  check("加格 2→3：继续开新列到 3 列", steps[1] === "0,0=A 1,0=B 2,0=C", steps[1]);
  check("加格 3→4：列满后填第 1 列的下格", steps[2] === "0,0=A 0,1=D 1,0=B 2,0=C", steps[2]);
  check("加格 4→5：按列从左到右填下格", steps[3] === "0,0=A 0,1=D 1,0=B 1,1=E 2,0=C", steps[3]);
  check("加格 5→6：3 列 × 2 行满", steps[4] === "0,0=A 0,1=D 1,0=B 1,1=E 2,0=C 2,1=F" && count(l) === 6, steps[4]);
  check("加格后焦点在新格", focus === "F");
  check("加格的列数变化后列宽回到等宽", eq(l.colWeights, []));
  const two = build(["A", "B", "C", "D"], 2);
  check("可用 2 列（1440 宽）：第 3 个会话填下格", grid(two) === "0,0=A 0,1=C 1,0=B 1,1=D", grid(two));
  const one = build(["A", "B"], 1);
  check("可用 1 列：第 2 个会话放在下面", grid(one) === "0,0=A 0,1=B", grid(one));
  check("可用列数 = clamp(floor(宽/480), 1, 3)", maxColumns(479) === 1 && maxColumns(960) === 2 && maxColumns(1439) === 2 && maxColumns(1440) === 3 && maxColumns(4000) === 3 && maxColumns(0) === 1);
}

// ---------- 2. 全满替换 ----------
{
  const full = build(["A", "B", "C", "D", "E", "F"], 3);
  const r = addPane(full, "G", { maxCols: 3, focus: "F" });
  check("全满：替换焦点以外最后加入的那一格（焦点 F，换掉 E）", r.replaced === "E" && grid(r.layout) === "0,0=A 0,1=D 1,0=B 1,1=G 2,0=C 2,1=F", { replaced: r.replaced, grid: grid(r.layout) });
  check("全满：替换后焦点在新会话、格数不变", r.focus === "G" && count(r.layout) === 6 && r.added);
  const r2 = addPane(full, "G", { maxCols: 3, focus: "A" });
  check("全满：焦点不是最后加入的那格时，替换最后加入的（F）", r2.replaced === "F" && grid(r2.layout).includes("2,1=G"), r2.replaced);
  const r3 = addPane(r.layout, "H", { maxCols: 3, focus: "G" });
  check("全满：换进来的算最后加入；它是焦点时换前一个（F）", r3.replaced === "F", r3.replaced);
  const four = build(["A", "B", "C", "D"], 2);
  const r4 = addPane(four, "E", { maxCols: 2, focus: "D" });
  check("1440 宽 4 格满：第 5 个替换焦点以外最后加入的（C）", r4.replaced === "C" && count(r4.layout) === 4 && grid(r4.layout) === "0,0=A 0,1=E 1,0=B 1,1=D", grid(r4.layout));
  const wide = build(["A", "B", "C"], 3);
  const r5 = addPane(wide, "D", { maxCols: 2, focus: "C" });
  check("保存的 3 列在窄一些的窗口里（可用 2 列）：不再开新列，填下格", grid(r5.layout) === "0,0=A 0,1=D 1,0=B 2,0=C" && !r5.replaced, grid(r5.layout));
}

// ---------- 3. 重复打开只移焦点 ----------
{
  const l = build(["A", "B", "C"], 3);
  const r = addPane(l, "B", { maxCols: 3, focus: "C" });
  check("已在网格里的会话再打开：布局不变，只移焦点", r.layout === l && r.focus === "B" && !r.added && r.replaced === null);
  const d = dropPane(l, "A", "C", "below", 3);
  check("拖入已在网格里的会话：布局不变，只移焦点", d.layout === l && d.focus === "A" && !d.added);
  check("替换成已在网格里的会话：不变", replacePane(l, "A", "B") === l);
}

// ---------- 4. 在下方打开、拖入 ----------
{
  const l = build(["A", "B"], 3);
  const r = addPane(l, "C", { maxCols: 3, focus: "B", where: "below" });
  check("在下方打开：开在焦点格下面", grid(r.layout) === "0,0=A 1,0=B 1,1=C", grid(r.layout));
  const r2 = addPane(r.layout, "D", { maxCols: 3, focus: "B", where: "below" });
  check("在下方打开：焦点格下面已占用时按加格规则（开新列）", grid(r2.layout) === "0,0=A 1,0=B 1,1=C 2,0=D", grid(r2.layout));
  const r3 = addPane(r.layout, "D", { maxCols: 3, focus: "C", where: "below" });
  check("在下方打开：焦点是下格时按加格规则", grid(r3.layout) === "0,0=A 1,0=B 1,1=C 2,0=D", grid(r3.layout));
  const d = dropPane(l, "C", "A", "right", 3);
  check("拖到某格右侧：在它那一列右边开新列", grid(d.layout) === "0,0=A 1,0=C 2,0=B", grid(d.layout));
  const d2 = dropPane(l, "C", "A", "below", 3);
  check("拖到某格下方：开在它下面", grid(d2.layout) === "0,0=A 0,1=C 1,0=B", grid(d2.layout));
  const full = build(["A", "B", "C", "D", "E", "F"], 3);
  const d3 = dropPane(full, "G", "B", "right", 3);
  check("网格已满时拖入：替换放下的那一格", d3.replaced === "B" && grid(d3.layout) === "0,0=A 0,1=D 1,0=G 1,1=E 2,0=C 2,1=F", grid(d3.layout));
}

// ---------- 5. 减格 ----------
{
  const l = build(["A", "B", "C", "D", "E", "F"], 3);
  const r = removePane(l, "E");
  check("关掉中间列的下格：上格还在", grid(r.layout) === "0,0=A 0,1=D 1,0=B 2,0=C 2,1=F", grid(r.layout));
  const r2 = removePane(r.layout!, "B");
  check("关掉只剩一格的列：去掉空列，右边的列左移", grid(r2.layout) === "0,0=A 0,1=D 1,0=C 1,1=F", grid(r2.layout));
  const r3 = removePane(r2.layout!, "C");
  check("关掉某列的上格：下格上提", grid(r3.layout) === "0,0=A 0,1=D 1,0=F", grid(r3.layout));
  const weighted = { ...build(["A", "B", "C"], 3), colWeights: [1.2, 0.9, 0.9] };
  check("列数变化后列宽回到等宽", eq(removePane(weighted, "C").layout!.colWeights, []));
  const swapped = movePane(weighted, "B", "right")!;
  check("列数不变（移动）时保留列宽", eq(swapped.colWeights, [1.2, 0.9, 0.9]));
  const two = build(["A", "B"], 3);
  const r4 = removePane(two, "B");
  check("关到只剩一格：单格布局", grid(r4.layout) === "0,0=A" && count(r4.layout) === 1 && r4.focus === "A", grid(r4.layout));
  check("最后一格关掉：没有布局", removePane(single("A"), "A").layout === null);
  check("关焦点格：焦点去下一格", removePane(l, "B").focus === "E", removePane(l, "B").focus);
  check("关最后一格（按列、行顺序）：焦点去上一格", removePane(l, "F").focus === "C", removePane(l, "F").focus);
  check("关一个不在网格里的会话：不变", removePane(l, "Z").layout === l);
}

// ---------- 6. 关主格后的提升 ----------
{
  const l = build(["A", "B", "C", "D"], 3); // A D | B | C
  const r = removePane(l, "A");
  check("关主格：同列的下格补到左上成为主格", r.layout!.primary === "D" && grid(r.layout) === "0,0=D 1,0=B 2,0=C" && r.focus === "D", grid(r.layout));
  const l2 = build(["A", "B", "C"], 3);
  const r2 = removePane(l2, "A");
  check("关主格：主格那一列没有下格时，下一列的上格成为主格", r2.layout!.primary === "B" && grid(r2.layout) === "0,0=B 1,0=C", grid(r2.layout));
  const l3 = { ...build(["A", "B", "C"], 3), extras: [...build(["A", "B", "C"], 3).extras, { id: "D", col: 1, row: 1 as const }] }; // A | B D | C
  const r3 = removePane(l3, "A");
  check("关主格：下一列是上下两格时，上格成为主格，下格留在它下面", r3.layout!.primary === "B" && grid(r3.layout) === "0,0=B 0,1=D 1,0=C", grid(r3.layout));
}

// ---------- 7. 移动 ----------
{
  const l = build(["A", "B", "C", "D", "E"], 3); // A D | B E | C
  check("左移：和左边一格交换", grid(movePane(l, "B", "left")) === "0,0=B 0,1=D 1,0=A 1,1=E 2,0=C", grid(movePane(l, "B", "left")));
  check("左移到左上：成为主格", movePane(l, "B", "left")!.primary === "B");
  check("右移：和右边一格交换", grid(movePane(l, "B", "right")) === "0,0=A 0,1=D 1,0=C 1,1=E 2,0=B", grid(movePane(l, "B", "right")));
  check("右移下格到右边空着的下格：移过去", grid(movePane(l, "E", "right")) === "0,0=A 0,1=D 1,0=B 2,0=C 2,1=E", grid(movePane(l, "E", "right")));
  check("上移：下格和上格交换", grid(movePane(l, "D", "up")) === "0,0=D 0,1=A 1,0=B 1,1=E 2,0=C", grid(movePane(l, "D", "up")));
  check("下移：上格和下格交换", grid(movePane(l, "B", "down")) === "0,0=A 0,1=D 1,0=E 1,1=B 2,0=C", grid(movePane(l, "B", "down")));
  check("不能左移：最左一列", !canMove(l, "A", "left") && !canMove(l, "D", "left"));
  check("不能右移：最右一列", !canMove(l, "C", "right"));
  check("不能上移：已经是上格", !canMove(l, "A", "up") && !canMove(l, "C", "up"));
  check("不能下移：下格本身、或下面空着的上格（移下去也会被提上来）", !canMove(l, "D", "down") && !canMove(l, "C", "down"));
  check("能移：四个方向各有可移的格", canMove(l, "B", "left") && canMove(l, "B", "right") && canMove(l, "D", "up") && canMove(l, "A", "down"));
  check("移动不在网格里的会话：不能移", movePane(l, "Z", "left") === null);
  check("设为主格：和左上那格交换", grid(setPrimary(l, "E")) === "0,0=E 0,1=D 1,0=B 1,1=A 2,0=C" && setPrimary(l, "E").primary === "E", grid(setPrimary(l, "E")));
  check("设为主格：已经是主格时不变", setPrimary(l, "A") === l);
  const rep = replacePane(l, "B", "X");
  check("替换：在原位置换成另一个会话", grid(rep) === "0,0=A 0,1=D 1,0=X 1,1=E 2,0=C", grid(rep));
  check("替换主格：新会话成为主格", replacePane(l, "A", "X").primary === "X");
  check("独占一列的格子跨两行", spans(l, panes(l).find((c) => c.id === "C")!) && !spans(l, panes(l).find((c) => c.id === "A")!));
}

// ---------- 8. 窄窗收起与恢复 ----------
{
  const l = build(["A", "B", "C", "D"], 3); // A D | B | C
  const before = JSON.stringify(l);
  check("宽 1600：全部显示", eq(visiblePanes(l, { focus: "B", width: 1600, height: 800 }), ["A", "D", "B", "C"]));
  check("宽 899（< 900）：收起，只显示焦点格", eq(visiblePanes(l, { focus: "B", width: 899, height: 800 }), ["B"]) && isCollapsed(l, 899, 800));
  check("宽 900、3 列放不下 3 × 320：也收起", isCollapsed(l, 960, 800) && !isCollapsed(l, 962, 800));
  check("有上下两格、高度放不下两行：收起", isCollapsed(l, 1600, 400) && !isCollapsed(l, 1600, 401));
  check("没有上下两格时不看高度", !isCollapsed(build(["A", "B"], 3), 1600, 300));
  check("变宽后原样恢复", eq(visiblePanes(l, { focus: "B", width: 1600, height: 800 }), ["A", "D", "B", "C"]));
  check("收起与恢复不改布局", JSON.stringify(l) === before);
  check("焦点不在网格里时收起后显示主格", eq(visiblePanes(l, { focus: "Z", width: 800, height: 800 }), ["A"]));
  check("单独查看：只显示那一格，布局不变", eq(visiblePanes(l, { focus: "B", solo: "C", width: 1600, height: 800 }), ["C"]) && JSON.stringify(l) === before);
  check("单格布局不算收起", !isCollapsed(single("A"), 300, 300));
}

// ---------- 9. 列宽、行比例 ----------
{
  const l = { ...build(["A", "B", "C"], 3), colWeights: [2, 1, 1] };
  check("保存的列宽在当前宽度下满足最小宽度：照用", weightsFit([2, 1, 1], 3, 1600) && eq(effectiveWeights(l, 1600), [2, 1, 1]));
  check("保存的列宽在当前宽度下违反最小宽度：回到等宽", !weightsFit([2, 1, 1], 3, 1200) && eq(effectiveWeights(l, 1200), [1, 1, 1]));
  check("列宽个数和列数对不上：等宽", eq(effectiveWeights({ ...l, colWeights: [1, 1] }, 1600), [1, 1, 1]));
  check("列宽里有 0 或负数：等宽", !weightsFit([1, 0, 1], 3, 3000) && !weightsFit([1, -1, 1], 3, 3000));
  const d = dragColumns([1, 1, 1], 0, 100, 1501);
  check("拖竖分隔线：只在相邻两列之间转移", Math.abs(d[0] - 1.2) < 0.01 && Math.abs(d[1] - 0.8) < 0.01 && d[2] === 1, d);
  const d2 = dragColumns([1, 1, 1], 0, 1000, 1501);
  check("拖竖分隔线：右边那列不窄于 320", Math.abs((d2[1] / 3) * 1499 - 320) < 1, d2);
  const d3 = dragColumns([1, 1, 1], 1, -1000, 1501);
  check("拖竖分隔线：左边那列不窄于 320", Math.abs((d3[1] / 3) * 1499 - 320) < 1, d3);
  check("拖竖分隔线：拖完还是满足最小宽度", weightsFit(d2, 3, 1501) && weightsFit(d3, 3, 1501));
  check("拖不存在的分隔线：不变", eq(dragColumns([1, 1], 1, 50, 1000), [1, 1]));
  check("拖横分隔线：比例跟着变", Math.abs(dragRows(0.5, 100, 801) - 0.625) < 0.001, dragRows(0.5, 100, 801));
  check("拖横分隔线：上下都不矮于 200", Math.abs(dragRows(0.5, 1000, 801) * 800 - 600) < 1 && Math.abs(dragRows(0.5, -1000, 801) * 800 - 200) < 1);
  check("保存的行比例在当前高度下放不下：回到各半", effectiveRowSplit({ ...l, rowSplit: 0.8 }, 801) === 0.5 && effectiveRowSplit({ ...l, rowSplit: 0.7 }, 801) === 0.7);
  check("网格轨道：列之间、行之间各一条 1px", colTracks([1, 2]) === "minmax(0, 1fr) 1px minmax(0, 2fr)" && rowTracks(0.25) === "minmax(0, 0.25fr) 1px minmax(0, 0.75fr)");
}

// ---------- 10. 存储 ----------
{
  const l = build(["A", "B", "C", "D"], 3);
  const saved = JSON.parse(JSON.stringify({ ...l, colWeights: [1.5, 0.75, 0.75], rowSplit: 0.4 }));
  const back = parseLayout(saved);
  check("存储读回：原样", back !== null && grid(back) === grid(l) && eq(back.colWeights, [1.5, 0.75, 0.75]) && back.rowSplit === 0.4);
  const bad: [string, unknown][] = [
    ["null", null],
    ["字符串", "x"],
    ["版本不对", { ...saved, version: 2 }],
    ["没有版本", { ...saved, version: undefined }],
    ["主格不是字符串", { ...saved, primary: 3 }],
    ["主格为空", { ...saved, primary: "" }],
    ["extras 不是数组", { ...saved, extras: {} }],
    ["格子缺 id", { ...saved, extras: [{ col: 1, row: 0 }] }],
    ["列号不是整数", { ...saved, extras: [{ id: "B", col: 1.5, row: 0 }] }],
    ["列号越界", { ...saved, extras: [{ id: "B", col: 3, row: 0 }] }],
    ["行号不是 0、1", { ...saved, extras: [{ id: "B", col: 1, row: 2 }] }],
    ["同一会话出现两次", { ...saved, extras: [{ id: "A", col: 1, row: 0 }] }],
    ["两格同一位置", { ...saved, extras: [{ id: "B", col: 1, row: 0 }, { id: "C", col: 1, row: 0 }] }],
    ["占了主格的位置", { ...saved, extras: [{ id: "B", col: 0, row: 0 }] }],
    ["超过 6 格", { ...saved, extras: ["B", "C", "D", "E", "F", "G"].map((id, i) => ({ id, col: i % 3, row: i < 3 ? 1 : 0 })) }],
    ["列宽不是数组", { ...saved, colWeights: "1,1" }],
    ["列宽有负数", { ...saved, colWeights: [1, -1, 1] }],
    ["列宽多于 3 个（审查 U1-06 的存活变异）", { ...saved, colWeights: [1, 1, 1, 1] }],
    ["行比例越界", { ...saved, rowSplit: 1 }],
    ["行比例不是数", { ...saved, rowSplit: "0.5" }],
  ];
  for (const [what, raw] of bad) check(`存储格式不对时丢弃：${what}`, parseLayout(raw) === null, parseLayout(raw));
  const gap = parseLayout({ version: 1, primary: "A", extras: [{ id: "C", col: 2, row: 0 }], colWeights: [1, 1, 1], rowSplit: 0.5 });
  check("存储里有空列：规范化（去空列，列宽回到等宽）", grid(gap) === "0,0=A 1,0=C" && eq(gap!.colWeights, []), grid(gap));
  const lone = parseLayout({ version: 1, primary: "A", extras: [{ id: "B", col: 1, row: 1 }], colWeights: [], rowSplit: 0.5 });
  check("存储里只有下格的列：下格上提", grid(lone) === "0,0=A 1,0=B", grid(lone));
  check("面板：读回开关和宽度", eq(parseDrawer({ open: true, size: 40 }), { open: true, size: 40 }));
  check("面板：格式不对时用缺省（关着、32%）", eq(parseDrawer(null), { open: false, size: 32 }) && eq(parseDrawer({ open: "yes", size: 5 }), { open: false, size: 32 }) && eq(parseDrawer({ open: true, size: 99 }), { open: true, size: 32 }));
}

// ---------- 11. 剔除已删除、已归档的会话 ----------
{
  const l = build(["A", "B", "C", "D"], 3); // A D | B | C
  const alive = new Set(["A", "C", "D"]); // B 已删除
  const p = prune(l, (id) => alive.has(id));
  check("已删除的会话从布局里拿掉（规则同减格）", grid(p) === "0,0=A 0,1=D 1,0=C", grid(p));
  const archived = new Set(["A"]); // 只剩 A 没归档
  const p2 = prune(l, (id) => archived.has(id));
  check("已归档的会话拿掉，剩一格时是单格布局", grid(p2) === "0,0=A" && count(p2) === 1, grid(p2));
  check("地址里的会话即使已归档也留着", grid(prune(l, (id) => id === "A", "B")) === "0,0=A 1,0=B", grid(prune(l, (id) => id === "A", "B")));
  check("全部不在了：没有布局", prune(l, () => false) === null);
  check("主格被删：下一格成为主格", prune(l, (id) => id !== "A")!.primary === "D");
  check("都还在：不变", prune(l, () => true) === l);
}

// ---------- 12. 焦点循环 ----------
{
  const l = build(["A", "B", "C", "D"], 3); // 按列、行：A D B C
  check("下一格按列、行顺序", nextFocus(l, "A", 1) === "D" && nextFocus(l, "D", 1) === "B" && nextFocus(l, "C", 1) === "A");
  check("上一格按列、行顺序，开头回到末尾", nextFocus(l, "A", -1) === "C" && nextFocus(l, "B", -1) === "D");
  check("焦点不在网格里时从第一格开始", nextFocus(l, "Z", 1) === "A");
  check("ids 按列、行顺序", eq(ids(l), ["A", "D", "B", "C"]) && columns(l) === 3);
}

// ---------- 13. 快捷键 ----------
{
  const k = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; altGraph: boolean }>, key = "") => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  const mac = { ctrlKey: true, metaKey: true };
  const pc = { ctrlKey: true, altKey: true };
  check("macOS：Ctrl+Cmd+\\ 右边打开、- 下方打开", splitKey(k("Backslash", mac), "mac") === "right" && splitKey(k("Minus", mac), "mac") === "below");
  check("macOS：Ctrl+Cmd+] / [ 切换焦点", splitKey(k("BracketRight", mac), "mac") === "next" && splitKey(k("BracketLeft", mac), "mac") === "prev");
  check("macOS：Ctrl+Cmd+W 关闭、B 面板", splitKey(k("KeyW", mac), "mac") === "close" && splitKey(k("KeyB", mac), "mac") === "panel");
  check("其他系统（Windows、Linux）：Mod 是 Alt", PC.every((os) => splitKey(k("BracketRight", pc), os) === "next" && splitKey(k("BracketRight", mac), os) === null));
  check("macOS 上 Ctrl+Alt 不算", splitKey(k("BracketRight", pc), "mac") === null);
  check("只按 Ctrl（Ctrl+[ 是 Esc、Ctrl+] 是 telnet 转义）不算", splitKey(k("BracketLeft", { ctrlKey: true }), "mac") === null && PC.every((os) => splitKey(k("BracketRight", { ctrlKey: true }), os) === null));
  check("只按 Cmd 不算", splitKey(k("KeyW", { metaKey: true }), "mac") === null);
  check("带 Shift 不算", splitKey(k("KeyB", { ...mac, shiftKey: true }), "mac") === null);
  check("Ctrl+Cmd+Alt 不算", splitKey(k("KeyB", { ...mac, altKey: true }), "mac") === null);
  check("带 AltGraph 标志（Windows 报成 Ctrl+Alt 的 AltGr）不算", PC.every((os) => splitKey(k("Minus", { ...pc, altGraph: true }), os) === null));
  check("别的键不算", splitKey(k("KeyK", mac), "mac") === null && splitKey(k("Enter", mac), "mac") === null);
  check("code 为空时按 key 认", splitKey(k("", mac, "]"), "mac") === "next" && splitKey(k("", mac, "W"), "mac") === "close");
}

// ---------- 14. 审查 U1-06 列出的 6 条存活变异，各一条独立用例 ----------
{
  const two = build(["A", "B"], 3); // A | B：2 × 320 远小于 899，收起只能是因为网格宽 < 900
  check("窄窗阈值正好是 900：两列在 899 宽收起、900 宽不收起（NARROW_W）", isCollapsed(two, 899, 800) && isCollapsed(two, 850, 800) && !isCollapsed(two, 900, 800));
  const full = build(["A", "B", "C", "D", "E", "F"], 3);
  const r = addPane(full, "G", { maxCols: 3, focus: "F" }); // E 换成 G
  const r2 = addPane(r.layout, "H", { maxCols: 3, focus: "A" });
  check("替换进来的那格算最后加入：下次全满时（焦点不是它）先换掉它（replacePane）", r2.replaced === "G", { replaced: r2.replaced, extras: r.layout.extras.map((c) => c.id) });
  const four = build(["A", "B", "C", "D"], 3);
  check("单独查看的会话不在布局里：照常显示全部格子（visiblePanes）", eq(visiblePanes(four, { focus: "B", solo: "Z", width: 1600, height: 800 }), ["A", "D", "B", "C"]));
  check("相邻两列合起来不足 640：拖分隔线不改列宽（dragColumns）", eq(dragColumns([1, 1, 1], 0, 50, 900), [1, 1, 1]) && eq(dragColumns([1, 1, 1], 1, -50, 900), [1, 1, 1]));
  check("存储里列宽多于 3 个：丢弃（parseLayout）", parseLayout({ version: 1, primary: "A", extras: [{ id: "B", col: 1, row: 0 }], colWeights: [1, 1, 1, 1], rowSplit: 0.5 }) === null);
  const kk = (code: string, mods: object, key = "") => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  check("ISO 键盘左下的 \\ 键（IntlBackslash）也是“在右边打开”", splitKey(kk("IntlBackslash", { ctrlKey: true, metaKey: true }), "mac") === "right" && PC.every((os) => splitKey(kk("IntlBackslash", { ctrlKey: true, altKey: true }, "\\"), os) === "right"));
}

// ---------- 15. 路由同步的布局（分屏稿第 4 节） ----------
{
  const l = build(["A", "B", "C"], 3);
  check("路由同步：没有布局时建单格布局", grid(routeLayout(null, "X", null)) === "0,0=X");
  check("路由同步：会话已在网格里，布局不变（只移焦点）", routeLayout(l, "B", "C") === l);
  check("路由同步：不在网格里，替换上次的焦点格", grid(routeLayout(l, "X", "C")) === "0,0=A 1,0=B 2,0=X", grid(routeLayout(l, "X", "C")));
  check("路由同步：上次的焦点不在网格里（或没有）时替换主格", grid(routeLayout(l, "X", "Z")) === "0,0=X 1,0=B 2,0=C" && grid(routeLayout(l, "X", null)) === "0,0=X 1,0=B 2,0=C");
}

// ---------- 16. 会话列表变化后的剪枝（12.2：不论几格） ----------
{
  const l = build(["A", "B", "C", "D"], 3); // A D | B | C
  const S = (id: string, archived = false) => ({ id, archived });
  check("打开时校验：已删除、已归档的拿掉", grid(pruneSessions(l, [S("A"), S("B", true), S("D")], null)) === "0,0=A 0,1=D", grid(pruneSessions(l, [S("A"), S("B", true), S("D")], null)));
  check("打开时校验：地址里的会话即使已归档也留着", grid(pruneSessions(l, [S("A"), S("B", true), S("C"), S("D")], null, "B")) === grid(l));
  check("打开时校验：单格布局里的会话没了，布局清空（U1-02）", pruneSessions(single("X"), [S("A")], null) === null && pruneSessions(single("X"), [S("X", true)], null) === null);
  check("使用中：单格布局里的会话被删除，布局清空（U1-02）", pruneSessions(single("X"), [S("A")], [S("A"), S("X")]) === null);
  check("使用中：单格布局里的会话被归档，布局清空（U1-02）", pruneSessions(single("X"), [S("X", true)], [S("X")]) === null);
  const y = addPane(single("A"), "Y", { maxCols: 3, focus: "A" }).layout; // Y 是从归档里打开的
  check("使用中：之前就已归档、被打开进分屏的那一格不动（U1-21）", pruneSessions(y, [S("A"), S("Y", true)], [S("A"), S("Y", true)]) === y);
  check("使用中：上一份列表里没有的（刚建的）不动", pruneSessions(y, [S("A"), S("Y")], [S("A")]) === y);
  check("使用中：从归档里打开的那一格后来被删除，拿掉", grid(pruneSessions(y, [S("A")], [S("A"), S("Y", true)])) === "0,0=A");
  check("使用中：这次被归档的拿掉，其余不动", grid(pruneSessions(l, [S("A"), S("B"), S("C", true), S("D")], [S("A"), S("B"), S("C"), S("D")])) === "0,0=A 0,1=D 1,0=B");
  check("使用中：都还在、状态没变时布局不变", pruneSessions(l, [S("A"), S("B"), S("C"), S("D")], [S("A"), S("B"), S("C"), S("D")]) === l);
}

// ---------- 17. 剪枝以后焦点去哪 ----------
{
  const l = build(["A", "B", "C", "D"], 3); // 按列、行：A D B C
  check("焦点格还在：不动", focusAfter(l, prune(l, (id) => id !== "C"), "B") === "B");
  check("焦点格被拿掉：去按列、行顺序的下一格", focusAfter(l, prune(l, (id) => id !== "B"), "B") === "C");
  check("焦点格是最后一格、被拿掉：去上一格", focusAfter(l, prune(l, (id) => id !== "C"), "C") === "B");
  check("布局空了、焦点本来不在网格里：没有焦点可去", focusAfter(l, null, "A") === null && focusAfter(l, l, "Z") === null);
}

// ---------- 18. “在分屏中打开”的底（12.2） ----------
{
  const ex = (...live: string[]) => (id: string) => live.includes(id);
  const b1 = splitBase(single("X"), { route: null, last: "X", exists: ex("B") });
  check("唯一的会话删掉以后再“在分屏中打开”：没有底，直接打开（U1-02）", b1.base === null && b1.focus === null, b1);
  const ab = build(["A", "X"], 3);
  const b2 = splitBase(ab, { route: "A", last: "A", exists: ex("A", "B") });
  check("保存的布局里有已删除的会话：先去掉再做底", grid(b2.base) === "0,0=A" && b2.focus === "A", b2);
  const b3 = splitBase(ab, { route: null, last: "X", exists: ex("A", "X", "B") });
  check("不在会话页时：焦点是上次的焦点，布局原样做底", b3.base === ab && b3.focus === "X", b3);
  const b4 = splitBase(null, { route: "A", last: null, exists: ex("A") });
  check("在会话页、还没有布局：从地址里的会话的单格开始", grid(b4.base) === "0,0=A" && b4.focus === "A", b4);
  const b5 = splitBase(build(["A", "nope"], 3), { route: "nope", last: "nope", exists: ex("A") });
  check("地址里的会话不存在（找不到这个对话）：不留它，也不拿它当焦点", grid(b5.base) === "0,0=A" && b5.focus === null, b5);
  check("已归档但还在列表里的会话（从归档里打开的）留在底里", splitBase(ab, { route: "A", last: "A", exists: ex("A", "X") }).base === ab);
}

// ---------- 19. 拖入的落点和提示（12.3） ----------
/** 性质测试用的布局：单格、2 列、列满、半满、全满、只能 1 列。 */
const PROPERTY_LAYOUTS: Layout[] = [
  single("A"),
  build(["A", "B"], 2),
  addPane(build(["A", "B"], 2), "D", { maxCols: 2, focus: "B", where: "below" }).layout,
  build(["A", "B", "C"], 3),
  build(["A", "B", "C", "D"], 3),
  build(["A", "B", "C", "D", "E"], 3),
  build(["A", "B", "C", "D", "E", "F"], 3),
  build(["A", "B", "C", "D"], 2),
  build(["A", "B"], 1),
];
/**
 * 提示是不是如实描述了加格（id 加进 l）的结果：替换的就是 of 原来的位置；“下面”就是 of 的正下方；“右边”就是 of 右边紧挨的一列。
 * 只有挨着放下的那一格（target）时才高亮它的右半、下半，否则（含 target 不在布局里）高亮整格。
 */
function hintDescribes(l: Layout, r: AddResult, hint: DropHint, id: string, target: string): boolean {
  const cell = panes(r.layout).find((c) => c.id === id);
  const at = (col: number, row: number) => panes(r.layout).find((c) => c.col === col && c.row === row)?.id;
  if (!cell || r.focus !== id) return false;
  if (hint.kind === "replace") return r.replaced === hint.of && eq(panes(l).find((c) => c.id === hint.of), { ...cell, id: hint.of }) && hint.area === "all";
  if (hint.kind === "below") return !r.replaced && cell.row === 1 && at(cell.col, 0) === hint.of && hint.area === (hint.of === target ? "below" : "all");
  if (hint.kind === "right")
    return !r.replaced && cell.row === 0 && cell.col >= 1 && (hint.of === target ? panes(r.layout).find((c) => c.id === target)?.col === cell.col - 1 && hint.area === "right" : at(cell.col - 1, 0) === hint.of && hint.area === "all");
  return false;
}
{
  const two = build(["A", "B"], 2); // A | B，1440 宽可用 2 列
  const p1 = planDrop(two, "C", "B", "right", 2);
  check("列满时拖到某格右半、它下面空着：开在它下面，提示“在 B 下面打开”，高亮它的下半", grid(p1.result.layout) === "0,0=A 1,0=B 1,1=C" && eq(p1.hint, { kind: "below", of: "B", area: "below" }), p1);
  const abd = addPane(two, "D", { maxCols: 2, focus: "B", where: "below" }).layout; // A | B D
  const p2 = planDrop(abd, "C", "B", "right", 2);
  check("列满、目标下面已占：按第 1 节的顺序填 A 的下格，提示写实际位置“在 A 下面打开”，高亮整格", grid(p2.result.layout) === "0,0=A 0,1=C 1,0=B 1,1=D" && eq(p2.hint, { kind: "below", of: "A", area: "all" }), p2);
  const full = build(["A", "B", "C", "D"], 2); // A C | B D
  const p3 = planDrop(full, "E", "B", "right", 2);
  check("全满：替换放下的那一格，提示“替换 B”", p3.result.replaced === "B" && grid(p3.result.layout) === "0,0=A 0,1=C 1,0=E 1,1=D" && eq(p3.hint, { kind: "replace", of: "B", area: "all" }), p3);
  const p4 = planDrop(two, "C", "A", "right", 3);
  check("列数没到上限：在目标那一列右边开新列，提示“在 A 右边打开”，高亮右半", grid(p4.result.layout) === "0,0=A 1,0=C 2,0=B" && eq(p4.hint, { kind: "right", of: "A", area: "right" }), p4);
  const p5 = planDrop(two, "C", "A", "below", 2);
  check("拖到下半、下面空着：开在它下面，提示“在 A 下面打开”，高亮下半", grid(p5.result.layout) === "0,0=A 0,1=C 1,0=B" && eq(p5.hint, { kind: "below", of: "A", area: "below" }), p5);
  const p6 = planDrop(two, "B", "A", "right", 2);
  check("拖入已在网格里的会话：只移焦点，提示“已在分屏中”", p6.result.layout === two && !p6.result.added && p6.hint.kind === "focus", p6);
  // 性质：任意布局、目标、两侧、可用列数下，提示都等于松手后的结果
  const bad: unknown[] = [];
  let n = 0;
  for (const l of PROPERTY_LAYOUTS)
    for (const target of ids(l))
      for (const side of ["right", "below"] as Where[])
        for (const maxCols of [1, 2, 3]) {
          n++;
          const p = planDrop(l, "N", target, side, maxCols);
          const ok = eq(p.result, dropPane(l, "N", target, side, maxCols)) && hintDescribes(l, p.result, p.hint, "N", target);
          if (!ok) bad.push({ l: grid(l), target, side, maxCols, hint: p.hint, after: grid(p.result.layout) });
        }
  check(`拖入提示等于实际落点（${n} 种布局 × 目标 × 两侧 × 可用列数）`, bad.length === 0, bad.slice(0, 3));
}

// ---------- 20. 快捷键只在有效时截（12.4） ----------
{
  const k = (code: string, mods: object, key = "") => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  const mac = { ctrlKey: true, metaKey: true };
  const pc = { ctrlKey: true, altKey: true };
  const ctx = (o: Partial<ShortcutCtx> = {}): ShortcutCtx => ({ os: "mac", session: true, panes: 2, overlay: false, ...o });
  const all = (e: (code: string) => ReturnType<typeof k>, c: ShortcutCtx) => ["Backslash", "Minus", "BracketRight", "BracketLeft", "KeyW", "KeyB"].map((code) => shortcutFor(e(code), c));
  check("分屏（两格以上）时六个组合都截", eq(all((c) => k(c, mac), ctx()), ["right", "below", "next", "prev", "close", "panel"]));
  check("只有一格：切换焦点、关闭小窗不截（送给终端），开在右边、下方、面板照常", eq(all((c) => k(c, mac), ctx({ panes: 1 })), ["right", "below", null, null, null, "panel"]));
  check("不在会话页：都不截", eq(all((c) => k(c, mac), ctx({ session: false })), [null, null, null, null, null, null]));
  check("有打开的对话框、命令面板：都不处理（U1-07）", eq(all((c) => k(c, mac), ctx({ overlay: true })), [null, null, null, null, null, null]));
  check("输入法组合中（isComposing、key 为 Process）：不截", shortcutFor({ ...k("BracketRight", mac), isComposing: true }, ctx()) === null && shortcutFor(k("BracketRight", mac, "Process"), ctx()) === null);
  const win = ctx({ os: "windows" });
  const lnx = ctx({ os: "linux" });
  check("非 macOS（Windows、Linux）：Ctrl+Alt+键，key 是美式布局的字符时截", [win, lnx].every((c) => shortcutFor(k("Minus", pc, "-"), c) === "below" && shortcutFor(k("BracketRight", pc, "]"), c) === "next" && shortcutFor(k("KeyW", pc, "W"), c) === "close" && shortcutFor(k("Backslash", pc, "\\"), c) === "right"));
  check("Windows：AltGr 打出来的字符（德语布局 Ctrl+Alt+ß 打出 \\，Ctrl+Alt++ 打出 ~）不截", shortcutFor(k("Minus", pc, "\\"), win) === null && shortcutFor(k("BracketRight", pc, "~"), win) === null && shortcutFor(k("KeyB", pc, "{"), win) === null);
  check("非 macOS（Windows、Linux）：带 AltGraph 标志的不截", [win, lnx].every((c) => shortcutFor({ ...k("BracketRight", pc, "]"), altGraph: true }, c) === null));
  check("非 macOS（Windows、Linux）：key 不是单个字符（Unidentified、Dead）时按键位认", [win, lnx].every((c) => shortcutFor(k("BracketRight", pc, "Unidentified"), c) === "next"));
  check("macOS 不看 key（Cmd 按住时 key 是什么都按键位认）", shortcutFor(k("BracketRight", mac, "‘"), ctx()) === "next");
}

// ---------- 21. 松手时写入列宽（13.7）：权重个数等于当前列数才写 ----------
{
  const three = build(["A", "B", "C"], 3);
  const two = removePane(three, "C").layout!; // 拖动途中关掉一格：3 列变 2 列
  const w3 = dragColumns([1, 1, 1], 0, 60, 1501);
  check("个数等于当前列数：写入", eq(withColWeights(three, w3)?.colWeights, w3) && grid(withColWeights(three, w3)) === grid(three));
  check("拖动途中格数变了（3 列的权重、布局已是 2 列）：不写", withColWeights(two, w3) === null, withColWeights(two, w3));
  check("拖动途中加进一格（2 列的权重、布局已是 3 列）：不写", withColWeights(three, [1.2, 0.8]) === null);
  check("复位（空数组）：不论几列都写", eq(withColWeights(two, [])?.colWeights, []) && eq(withColWeights(three, [])?.colWeights, []));
  check("没有布局：不写", withColWeights(null, [1, 1]) === null && withColWeights(null, []) === null);
}

// ---------- 22. 拖入提示和落点的回退（13.8）：openInSplit 和拖入提示都只走 planOpen ----------
{
  // 性质：放下的那一格在底里时等于 planDrop；不在底里（含会话已不在列表里的格子）时等于不带目标的 addPane（菜单、选择框同一个顺序）；
  // 两种情况下提示都如实描述结果
  const bad: unknown[] = [];
  let n = 0;
  let missing = 0;
  for (const l of PROPERTY_LAYOUTS)
    for (const target of [...ids(l), "Z"])
      for (const side of ["right", "below"] as Where[])
        for (const maxCols of [1, 2, 3])
          for (const focus of [null, ids(l)[0], ids(l)[count(l) - 1]]) {
            n++;
            const p = planOpen(l, "N", { where: side, maxCols, focus, target });
            const inBase = has(l, target);
            if (!inBase) missing++;
            const want = inBase ? planDrop(l, "N", target, side, maxCols) : { result: addPane(l, "N", { maxCols, focus, where: side }), hint: null };
            const ok = p.result !== null && eq(p.result, want.result) && (!inBase || eq(p.hint, want.hint)) && hintDescribes(l, p.result, p.hint, "N", target) && (inBase || p.hint.area === "all");
            if (!ok) bad.push({ l: grid(l), target, side, maxCols, focus, hint: p.hint, after: p.result && grid(p.result.layout) });
          }
  check(`planOpen 的提示等于落点（${n} 种，其中 ${missing} 种放下的那一格不在底里）`, bad.length === 0 && missing > 0, bad.slice(0, 3));
  const two = build(["A", "B"], 2);
  const p1 = planOpen(two, "C", { where: "right", maxCols: 3, focus: "B", target: "gone" });
  check("放下的那一格不在底里：按焦点格开新列，提示写实际位置“在 B 右边打开”，高亮整格", grid(p1.result!.layout) === "0,0=A 1,0=B 2,0=C" && eq(p1.hint, { kind: "right", of: "B", area: "all" }), p1);
  const p2 = planOpen(single("A"), "C", { where: "below", maxCols: 2, focus: "A", target: "gone" });
  check("放下的那一格不在底里、拖到下半：开在焦点格下面，提示“在 A 下面打开”，高亮整格（不是它的下半）", grid(p2.result!.layout) === "0,0=A 0,1=C" && eq(p2.hint, { kind: "below", of: "A", area: "all" }), p2);
  const p3 = planOpen(null, "C", { where: "right", maxCols: 3, focus: null, target: "gone" });
  check("没有底（会话列表里一个都不在）：不进分屏，直接打开，提示“打开 C”", p3.result === null && eq(p3.hint, { kind: "open", of: "C", area: "all" }), p3);
  const p4 = planOpen(two, "B", { where: "right", maxCols: 3, focus: "A", target: "gone" });
  check("放下的那一格不在底里、拖入的会话已在网格里：只移焦点，提示“已在分屏中”", p4.result!.layout === two && !p4.result!.added && p4.hint.kind === "focus", p4);
  const p5 = planOpen(two, "C", { where: "below", maxCols: 2, focus: "B" });
  check("菜单、选择框（没有 target）：和 addPane 一样", eq(p5.result, addPane(two, "C", { maxCols: 2, focus: "B", where: "below" })), p5);
}

// ---------- 23. AltGr 判断（13.1）：key 是字母时三种系统上都照常按键位截；字符回退只在 Windows 上（13.10） ----------
{
  const k = (code: string, key: string) => ({ key, code, ctrlKey: true, metaKey: false, altKey: true, shiftKey: false });
  const win: ShortcutCtx = { os: "windows", session: true, panes: 2, overlay: false };
  check("俄语布局 Ctrl+Alt+W（key 为 ц）：截下，关闭小窗", onAll(k("KeyW", "ц")) === "close" && shortcutFor(k("KeyW", "ц"), win) === "close");
  check("俄语布局 Ctrl+Alt+[（key 为 х）：截下，上一格", onAll(k("BracketLeft", "х")) === "prev" && shortcutFor(k("BracketLeft", "х"), win) === "prev");
  check("俄语布局 Ctrl+Alt+]（key 为 ъ）、Ctrl+Alt+B（key 为 и）：截下", onAll(k("BracketRight", "ъ")) === "next" && onAll(k("KeyB", "и")) === "panel");
  check("希腊语布局 Ctrl+Alt+B（key 为 β）：截下，面板开关", onAll(k("KeyB", "β")) === "panel" && shortcutFor(k("KeyB", "β"), win) === "panel");
  check("德语布局 Ctrl+Alt+[（key 为 ü）：截下，上一格", onAll(k("BracketLeft", "ü")) === "prev" && shortcutFor(k("BracketLeft", "ü"), win) === "prev");
  check("大写字母（Caps Lock 下的 Ц、Ü）一样截下", onAll(k("KeyW", "Ц")) === "close" && onAll(k("BracketLeft", "Ü")) === "prev");
  check("Windows 上德语布局 Ctrl+Alt+ß 打出 \\、Ctrl+Alt++ 打出 ~：放行", splitKey(k("Minus", "\\"), "windows") === null && splitKey(k("BracketRight", "~"), "windows") === null && shortcutFor(k("Minus", "\\"), win) === null && shortcutFor(k("BracketRight", "~"), win) === null);
  check("Windows 上美式国际布局打出 « » ¥ ¬：放行", splitKey(k("BracketLeft", "«"), "windows") === null && splitKey(k("BracketRight", "»"), "windows") === null && splitKey(k("Minus", "¥"), "windows") === null && splitKey(k("Backslash", "¬"), "windows") === null);
  check("美式字符照常截下（大小写不论，Windows、Linux）", PC.every((os) => splitKey(k("KeyW", "w"), os) === "close" && splitKey(k("KeyW", "W"), os) === "close" && splitKey(k("Backslash", "\\"), os) === "right"));
  check("macOS 不受影响（Cmd 按住时 key 是什么都按键位认）", splitKey({ ...k("BracketLeft", "«"), altKey: false, metaKey: true }, "mac") === "prev");
}

// ---------- 24. AltGr 的字符回退只在 Windows 上用（13.10）：Linux 等只看 AltGraph 标志 ----------
{
  const k = (code: string, key: string) => ({ key, code, ctrlKey: true, metaKey: false, altKey: true, shiftKey: false });
  const ctx = (os: Os): ShortcutCtx => ({ os, session: true, panes: 2, overlay: false });
  check("Linux 上德语布局 Ctrl+Alt+]（key 为 +）：截下，下一格", splitKey(k("BracketRight", "+"), "linux") === "next" && shortcutFor(k("BracketRight", "+"), ctx("linux")) === "next");
  check("Linux 上法语布局 Ctrl+Alt+]（key 为 $）：截下，下一格", splitKey(k("BracketRight", "$"), "linux") === "next" && shortcutFor(k("BracketRight", "$"), ctx("linux")) === "next");
  check("Linux 上 key 不是美式字符的符号也按键位截（\\ 在 Minus 上、« 在 [ 上、¬ 在 \\ 上）", splitKey(k("Minus", "\\"), "linux") === "below" && splitKey(k("BracketLeft", "«"), "linux") === "prev" && splitKey(k("Backslash", "¬"), "linux") === "right");
  check("Linux 上带 AltGraph 标志的照样放行", splitKey({ ...k("BracketRight", "+"), altGraph: true }, "linux") === null && shortcutFor({ ...k("BracketRight", "]"), altGraph: true }, ctx("linux")) === null);
  check("Windows 上德语 Ctrl+Alt+ß 打出 \\、Ctrl+Alt++ 打出 ~：仍放行", splitKey(k("Minus", "\\"), "windows") === null && splitKey(k("BracketRight", "~"), "windows") === null && shortcutFor(k("Minus", "\\"), ctx("windows")) === null);
  check("Windows 上德语布局 ] 键位的本地符号（+）、法语（$）放行（已知限制：这两个键位当快捷键用不了）", splitKey(k("BracketRight", "+"), "windows") === null && splitKey(k("BracketRight", "$"), "windows") === null);
  const letters: [string, string, SplitAction][] = [["KeyW", "ц", "close"], ["BracketLeft", "х", "prev"], ["BracketRight", "ъ", "next"], ["KeyB", "и", "panel"], ["KeyB", "β", "panel"], ["KeyW", "ς", "close"], ["BracketLeft", "Х", "prev"]];
  const bad = letters.filter(([code, key, want]) => onAll(k(code, key)) !== want || (["mac", ...PC] as Os[]).some((os) => shortcutFor(os === "mac" ? { ...k(code, key), altKey: false, metaKey: true } : k(code, key), ctx(os)) !== want));
  check("俄语、希腊语布局的字母在 macOS、Windows、Linux 上都截下", bad.length === 0, bad);
  check("平台由调用方传入：navigator.platform → mac / windows / linux", platformOf("MacIntel") === "mac" && platformOf("iPad") === "mac" && platformOf("Win32") === "windows" && platformOf("Linux x86_64") === "linux" && platformOf("") === "linux" && platformOf("CrOS x86_64") === "linux");
}

// ---------- 25. 审查 U2-08 的两条存活变异 ----------
{
  const k = (code: string, key: string, mods: object) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  const mac = { ctrlKey: true, metaKey: true };
  const pc = { ctrlKey: true, altKey: true };
  const keys: [string, SplitAction][] = [["\\", "right"], ["-", "below"], ["]", "next"], ["[", "prev"], ["w", "close"], ["W", "close"], ["b", "panel"], ["B", "panel"]];
  const byKey = keys.filter(([key, want]) => splitKey(k("", key, mac), "mac") !== want || PC.some((os) => splitKey(k("", key, pc), os) !== want));
  check("code 为空时按 key 认：\\ - ] [ W B 六个键（大小写不论）都认得", byKey.length === 0, byKey);
  const codes = ["Backslash", "Minus", "BracketRight", "BracketLeft", "KeyW", "KeyB"];
  const win = codes.filter((code) => PC.some((os) => splitKey(k(code, "", { ...pc, metaKey: true }), os) !== null || splitKey(k("", "]", { ...pc, metaKey: true }), os) !== null));
  check("非 macOS 上 Ctrl+Alt+Win（带 Meta）不算", win.length === 0 && PC.every((os) => shortcutFor(k("BracketRight", "]", { ...pc, metaKey: true }), { os, session: true, panes: 2, overlay: false }) === null), win);
}

// ---------- 26. 地址里的会话不在会话列表里（14.2） ----------
{
  const S = (id: string, archived = false) => ({ id, archived });
  const list = [S("A"), S("B"), S("X", true)];
  const ex = listed(list);
  const ab = build(["A", "B"], 3);
  check("“存在”：在会话列表里，含已归档的；空 id 不算", ex("A") && ex("X") && !ex("zz") && !ex(null) && !ex(""));
  check("列表就绪后地址里的会话不存在：布局原样（同一个对象，不写存储）", routeLayout(ab, "zz", "B", ex) === ab && routeLayout(ab, "zz", null, ex) === ab);
  check("列表就绪后地址里的会话不存在、还没有布局：仍然没有布局", routeLayout(null, "zz", null, ex) === null);
  check("地址里的会话存在：照常（不在网格里就替换上次的焦点格）", grid(routeLayout(ab, "X", "B", ex)) === "0,0=A 1,0=X" && routeLayout(ab, "B", "A", ex) === ab && grid(routeLayout(null, "A", null, ex)) === "0,0=A");
  check("列表还没就绪（不给 exists）：照旧换进网格", grid(routeLayout(ab, "zz", "B")) === "0,0=A 1,0=zz");
  const ghost = build(["A", "zz"], 3);
  check("打开时校验：地址里的会话不在列表里，不留它", grid(pruneSessions(ghost, list, null, "zz")) === "0,0=A", grid(pruneSessions(ghost, list, null, "zz")));
  const ax = build(["A", "X"], 3);
  check("打开时校验：地址里的会话已归档但在列表里，留着（和 splitBase 一致）", pruneSessions(ax, list, null, "X") === ax && splitBase(ax, { route: "X", last: "X", exists: ex }).base === ax);
  check("会话页是不是分屏：两格以上、地址里的会话存在", showsSplit(ab, "A", ex) && showsSplit(ax, "X", ex) && !showsSplit(ab, "zz", ex) && !showsSplit(single("A"), "A", ex) && !showsSplit(null, "A", ex));
  // 场景一（审查 probe stale）：存着 A|B 时打开不存在的会话 zz。启动时列表就绪的那一次：先按地址同步，再打开时校验
  const s1 = routeLayout(ab, "zz", null, ex);
  const v1 = s1 && pruneSessions(s1, list, null, "zz");
  check("场景一：存着 A|B 时打开不存在的会话：布局和存储都不变，显示“找不到这个对话”（单会话页）", s1 === ab && v1 === ab && !showsSplit(v1, "zz", ex), { s1: grid(s1), v1: grid(v1) });
  check("场景一：之后地址回到存在的会话 B：网格 A|B 照常", routeLayout(v1, "B", null, ex) === ab && showsSplit(ab, "B", ex));
  // 场景二（审查 probe backdead）：A|B|tmp，删掉 tmp（使用中剪枝），按后退回到 #/s/tmp，再前进回 A
  const abt = build(["A", "B", "tmp"], 3);
  const before = [...list, S("tmp")];
  const after = pruneSessions(abt, list, before);
  const back = routeLayout(after, "tmp", "A", ex);
  check("场景二：A|B|tmp 删掉 tmp：小窗关掉，剩 A|B", grid(after) === "0,0=A 1,0=B", grid(after));
  check("场景二：后退到已删除的 tmp：布局不变，显示“找不到这个对话”", back === after && !showsSplit(back, "tmp", ex), grid(back));
  check("场景二：前进回 A：网格恢复", routeLayout(back, "A", "A", ex) === after && showsSplit(after, "A", ex));
}

// ---------- 27. 页面上没有显示网格时快捷键按单会话页处理（15.2 第 3 条，审查 U3-05） ----------
{
  const ex = listed([{ id: "A" }, { id: "B" }, { id: "C" }]);
  const ab = build(["A", "B"], 3);
  const abc = build(["A", "B", "C"], 3);
  check("显示几格：显示网格时是网格里的格数", shownPanes(ab, "A", ex) === 2 && shownPanes(abc, "C", ex) === 3);
  check("显示几格：“找不到这个对话”（地址里的会话不在列表里）时是 1，不按存储里看不见的布局（面板开关也按这个数：开关单会话页那一栏，不动分屏的面板）", shownPanes(ab, "zz", ex) === 1 && shownPanes(abc, "zz", ex) === 1);
  check("显示几格：单格布局、没有布局、不在会话页时是 1", shownPanes(single("A"), "A", ex) === 1 && shownPanes(null, "A", ex) === 1 && shownPanes(ab, null, ex) === 1);
  const mac = { key: "", ctrlKey: true, metaKey: true, altKey: false, shiftKey: false };
  const ctx = (route: string): ShortcutCtx => ({ os: "mac", session: true, panes: shownPanes(ab, route, ex), overlay: false });
  const keys = ["Backslash", "Minus", "BracketRight", "BracketLeft", "KeyW", "KeyB"].map((code) => ({ ...mac, code }));
  check("存着 A|B、在“找不到这个对话”页：切换焦点、关闭小窗不截（审查探针 P10：Ctrl+Mod+] 不改历史记录、不进网格）", eq(keys.map((e) => shortcutFor(e, ctx("zz"))), ["right", "below", null, null, null, "panel"]));
  check("……回到网格里的会话：六个组合照常都截", eq(keys.map((e) => shortcutFor(e, ctx("B"))), ["right", "below", "next", "prev", "close", "panel"]));
}

console.log(`\n分屏规则检查：${pass} / ${pass + fails.length} 通过`);
if (fails.length > 0) {
  for (const f of fails) console.log(`  FAIL ${f}`);
  process.exit(1);
}
