// 界面统一的机器检查（设计稿 .orchestra/design-ui-unify.md 第 6 节）。不引入任何依赖：
//   node --experimental-strip-types scripts/check-style.ts          违规即退出码 1
//   node --experimental-strip-types scripts/check-style.ts --report 只报告，退出码 0
// 五类检查：CSS 刻度与颜色字面量、TSX（图标尺寸、sm 按钮和图标按钮里的图标尺寸、面板里不用 primary、行内样式、旧类名）、
// 令牌（每个都用到、没有未定义的引用）、对比度（从 tokens.css 解析两种主题）、词表（界面不直接显示后端的英文状态值和原样时间）。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const UI = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(UI, "src");
const STYLES = join(SRC, "styles");
const REPORT = process.argv.includes("--report");

type Violation = { kind: string; where: string; what: string };
const out: Violation[] = [];
const add = (kind: string, where: string, what: string) => out.push({ kind, where, what });
const rel = (p: string) => relative(UI, p);

function walk(dir: string, ext: string): string[] {
  const files: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p, ext));
    else if (e.name.endsWith(ext)) files.push(p);
  }
  return files.sort();
}

// ---------- 旧类名（设计稿第 2 节“取代”一栏，加审计列出的容器、表单、标题写法） ----------
const OLD_CLASSES = [
  // 按钮
  "btn", "icon-btn", "send", "small", "link-btn", "toggle-chip", "starter", "starters", "agent-chip", "agent-chips", "table-more", "prov", "exact", "key", "ref",
  // 标签和切换
  "tab", "tabs", "tabs-scroll", "segmented", "kpi", "kpis", "filter", "filters", "side-link", "side-new", "side-search",
  // 列表行
  "side-row", "side-row-main", "side-row-title", "side-row-time", "side-row-more", "menu-item", "palette-item", "file-row", "git-row", "run-row", "key-row",
  "plain-list", "import-line", "claim", "claim-head", "claim-text", "issue", "issue-level", "issue-body", "issue-meta", "agent-row", "agent-row-main", "deploy-steps",
  // 表格和拼出来的表格
  "table", "data", "trust-table", "plan-table", "prov-table", "facts", "idea-facts", "env-facts", "gpu", "gpus", "gpu-tag", "gpu-idx", "gpu-num", "agent-table",
  // 徽标
  "pill", "tag", "select-tag", "ev", "art-flag", "agent-mark", "stat", "stats", "stat-sep", "run-state", "c-ok", "c-accent",
  // 表面和容器
  "card", "flush", "server-card", "import-result", "key-list", "fails", "fail", "radio-card", "note", "note-stack", "form-extra", "plan-raw", "deploy", "nb-in",
  "codeline", "run-cmd", "pkg-list", "composer", "msgbar", "drop", "trust-sec", "trust-sum", "with-action",
  // 空状态
  "empty", "empty-title", "empty-hint", "empty-icon", "empty-actions", "card-hint", "side-empty", "menu-empty", "splash",
  // 提示和错误
  "deploy-error", "fail-note", "fail-head", "fail-claim", "fail-cmd",
  // 弹层
  "modal", "modal-head", "modal-title", "modal-desc", "modal-body", "modal-foot", "overlay", "pop", "menu", "menu-sep", "menu-icon", "tip", "toast", "toasts",
  "palette-input", "palette-list", "palette-hint",
  // 表单
  "field", "select-field", "form-field", "form-label", "form-hint", "chip", "input-chip", "mini-search", "setting",
  // 小节标题
  "side-group", "issue-group-head", "keys",
  // 旧的工具类和修饰类（换成 .muted、.tone-*、data-* 属性）
  "dim", "c-err", "c-warn", "crumb", "table-wrap", "cell-text", "rows", "trust", "scroll", "busy", "on", "active", "accent", "ok", "mute", "warn", "err",
  "light", "fit", "narrow", "with-spark", "compact", "over", "text", "file", "run", "link", "pulse", "dot", "chev-old",
];
const OLD = new Set(OLD_CLASSES);
/** 设计稿要求定义、但还没有界面用到的令牌。（--bar-pane 在 D 步分屏的小窗标题栏用上了，已从这里删掉。） */
const RESERVED = new Set<string>([]);

// ---------- 1. CSS ----------
const SCALE_PROPS = /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left|border-radius|border-(top|bottom)-(left|right)-radius|font-size|height|min-height|max-height|line-height|font-weight|letter-spacing|transition|transition-duration|animation|animation-duration)(-(top|right|bottom|left|inline|block|start|end|inline-start|inline-end))?$/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|color-mix\(/;
const NAMED_COLOR = /(^|[\s,(])(white|black|red|blue|green|gray|grey|yellow|orange|silver)(?=$|[\s,);])/;

/** 去掉 var(...) 之后的值里还剩下的长度、时长字面量。 */
function stripVars(v: string): string {
  let s = v;
  for (let i = 0; i < 6; i++) s = s.replace(/var\(--[\w-]+(,[^()]*)?\)/g, "V");
  return s;
}
function badLiterals(prop: string, value: string, selector: string): string[] {
  const v = stripVars(value.replace(/!important/g, ""));
  const bad: string[] = [];
  if (prop === "font-weight") {
    if (/\b\d{3}\b|\bbold\b|\bbolder\b|\blighter\b/.test(v)) bad.push(value);
    return bad;
  }
  if (prop === "line-height") {
    for (const m of v.matchAll(/(?<![\w-])(\d*\.?\d+)(px|em|rem|%)?(?![\w-])/g)) {
      if (m[0] === "1" || m[0] === "0") continue;
      bad.push(m[0]);
    }
    return bad;
  }
  if (prop.startsWith("animation") && /\binfinite\b/.test(v)) return bad; // 转圈、呼吸、扫光是循环周期，不是过渡时长
  for (const m of v.matchAll(/(?<![\w-])(-?\d*\.?\d+)(px|rem|em|ms|s)(?![\w-])/g)) {
    const lit = m[0];
    if (lit === "1px" || lit === "0px") continue;
    if (m[2] === "em" && /\.md\b|\bcode\b|\bkbd\b/.test(selector)) continue; // Markdown 按阅读字号的比例
    bad.push(lit);
  }
  return bad;
}

function checkCss(file: string) {
  const text = readFileSync(file, "utf8");
  // 逐条规则拆开：选择器 { 声明; 声明 }，注释先换成空格（保留 allow 注释的位置信息）
  const lines = text.split("\n");
  let selector = "";
  lines.forEach((line, i) => {
    const where = `${rel(file)}:${i + 1}`;
    const allow = /\/\*\s*allow:/.test(line);
    const clean = line.replace(/\/\*.*?\*\//g, "");
    const open = clean.indexOf("{");
    if (open >= 0) selector = clean.slice(0, open).trim() || selector;
    // 旧类名作为选择器
    for (const m of clean.slice(0, open >= 0 ? open : 0).matchAll(/\.([a-zA-Z][\w-]*)/g)) if (OLD.has(m[1])) add("css-old-class", where, `.${m[1]}`);
    const body = open >= 0 ? clean.slice(open + 1) : clean;
    for (const decl of body.split(";")) {
      const c = decl.indexOf(":");
      if (c < 0) continue;
      const prop = decl.slice(0, c).replace(/[{}]/g, "").trim();
      const value = decl.slice(c + 1).replace(/[{}]/g, "").trim();
      if (!/^-?[a-z][\w-]*$/.test(prop) || prop.startsWith("--")) continue;
      if (allow) continue;
      if (COLOR_LITERAL.test(stripVars(value))) add("css-color", where, `${prop}: ${value}`);
      if (NAMED_COLOR.test(` ${stripVars(value)} `) && /color|background|fill|stroke|shadow|outline|border/.test(prop)) add("css-color", where, `${prop}: ${value}`);
      if (SCALE_PROPS.test(prop)) for (const b of badLiterals(prop, value, selector)) add("css-scale", where, `${prop}: ${value}（${b}）`);
    }
  });
}

// ---------- 2. TSX ----------
/** 允许的行内样式：文件 + 内容（设计稿第 6 节：现有 3 处动态值，加分屏的网格变量）。 */
const STYLE_OK: [string, RegExp][] = [
  ["src/components/ui.tsx", /style=\{\{ width: `\$\{Math\.max\(0, Math\.min\(100, value\)\)\}%` \}\}/],
  ["src/pages/Welcome.tsx", /style=\{\{ width: `\$\{Math\.min\(/],
  // 分屏网格的两个 CSS 变量：列宽（--split-cols）和行比例（--split-rows），设计稿第 6 节“加上分屏的网格变量”
  ["src/pages/SplitView.tsx", /style=\{\{ "--split-cols": cols, "--split-rows": rows \} as CSSProperties\}/],
];

/** 一行里 className="…"、className={…} 和 cx(…) 的内容（按括号配对，跨行的取到行尾）。 */
function classExprs(line: string): string[] {
  const out: string[] = [];
  const grab = (start: number, open: string, close: string) => {
    let depth = 0;
    for (let j = start; j < line.length; j++) {
      if (line[j] === open) depth++;
      else if (line[j] === close && --depth === 0) return line.slice(start + 1, j);
    }
    return line.slice(start + 1);
  };
  for (const m of line.matchAll(/className=/g)) {
    const at = (m.index ?? 0) + m[0].length;
    if (line[at] === '"') out.push(line.slice(at, line.indexOf('"', at + 1) + 1));
    else if (line[at] === "{") out.push(grab(at, "{", "}"));
  }
  for (const m of line.matchAll(/\bcx\(/g)) out.push(grab((m.index ?? 0) + 2, "(", ")"));
  return out;
}

/**
 * 开始标签里顶层的属性（不看 {…} 里面嵌套的 JSX）：名字 → 原文的值（"…"、'…' 或 {…}，没有值的是 ""）。
 * 返回属性表和开始标签结尾 > 的位置；找不到结尾时为 null。
 */
function openTag(text: string, from: number): { attrs: Map<string, string>; end: number; selfClosing: boolean } | null {
  const attrs = new Map<string, string>();
  let i = from;
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  /** 从 { 开始，到配对的 } 为止（跳过里面的字符串）。 */
  const braces = () => {
    const s = i;
    let depth = 0;
    let quote = "";
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return text.slice(s, ++i);
    }
    return null;
  };
  while (i < text.length) {
    skipWs();
    if (text[i] === ">") return { attrs, end: i, selfClosing: false };
    if (text.startsWith("/>", i)) return { attrs, end: i + 1, selfClosing: true };
    if (text[i] === "{") {
      if (braces() === null) return null; // {...rest}
      continue;
    }
    const name = /^[\w:.-]+/.exec(text.slice(i))?.[0];
    if (!name) return null;
    i += name.length;
    skipWs();
    if (text[i] !== "=") {
      attrs.set(name, "");
      continue;
    }
    i++;
    skipWs();
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      const close = text.indexOf(q, i + 1);
      if (close < 0) return null;
      attrs.set(name, text.slice(i, close + 1));
      i = close + 1;
    } else if (text[i] === "{") {
      const v = braces();
      if (v === null) return null;
      attrs.set(name, v);
    } else return null;
  }
  return null;
}

/** size 属性写成字面量时的值："sm"、'sm'、{"sm"}、{'sm'}、{`sm`} 都是 sm；表达式（随状态变的）为 null。 */
function literalSize(v: string | undefined): string | null {
  if (!v) return null;
  const m = /^(?:"([\w-]+)"|'([\w-]+)'|\{\s*(?:"([\w-]+)"|'([\w-]+)'|`([\w-]+)`)\s*\})$/.exec(v.trim());
  return m ? (m.slice(1).find((x) => x !== undefined) ?? null) : null;
}

/**
 * 控件尺寸和图标尺寸要搭配（设计稿 1.8：--h-sm 控件里用 14 的图标）：size 为 sm 的 IconButton、Button 里的图标（含 Spinner）只允许
 * ICON.sm 或 ICON.xs。查子元素，也查 Button 的 icon 属性；size 写成 "sm" 或 {"sm"} 都算。按整段文本解析，开始标签和子元素可以跨行
 * （审查 U1-11；U2-07 补 Button 的 icon 属性和 size={"sm"} 写法）。
 */
function checkIconPairs(file: string, text: string) {
  const r = rel(file);
  const lineOf = (i: number) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/<(IconButton|Button)\b/g)) {
    const tag = m[1];
    const start = m.index ?? 0;
    const open = openTag(text, start + m[0].length);
    if (!open || literalSize(open.attrs.get("size")) !== "sm") continue;
    const bad = (where: number, size: string, place: string) =>
      add("tsx-icon-pair", `${r}:${lineOf(where)}`, `size="sm" 的 ${tag} ${place}size={${size}}（只允许 ICON.sm、ICON.xs）`);
    const icon = open.attrs.get("icon");
    if (icon) {
      const at = text.indexOf(icon, start);
      for (const s of icon.matchAll(/\bsize=\{([^}]*)\}/g)) if (!/^ICON\.(sm|xs)$/.test(s[1].trim())) bad(at + (s.index ?? 0), s[1].trim(), "的 icon 属性里 ");
    }
    if (open.selfClosing) continue;
    const close = text.indexOf(`</${tag}>`, open.end);
    if (close < 0) continue;
    const body = text.slice(open.end + 1, close);
    for (const s of body.matchAll(/\bsize=\{([^}]*)\}/g)) if (!/^ICON\.(sm|xs)$/.test(s[1].trim())) bad(open.end + 1 + (s.index ?? 0), s[1].trim(), "里 ");
  }
}

/**
 * 会话页右侧面板（src/panels/ 只用在这一栏）里的按钮不用 primary：空状态的“开始研究”等一律次要样式，同屏的 primary 留给发送和
 * “接续”（分屏稿 14.5，补 12.8）。
 */
function checkPanelPrimary(file: string, text: string) {
  const r = rel(file);
  if (!r.startsWith("src/panels/")) return;
  text.split("\n").forEach((line, i) => {
    if (/\bvariant=(?:"primary"|'primary'|\{[^}]*["'`]primary["'`][^}]*\})/.test(line)) add("tsx-panel-primary", `${r}:${i + 1}`, line.trim().slice(0, 120));
  });
}

function checkTsx(file: string) {
  const text = readFileSync(file, "utf8");
  const r = rel(file);
  checkIconPairs(file, text);
  checkPanelPrimary(file, text);
  const lucide = new Set<string>();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g))
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) lucide.add(name);
    }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const where = `${r}:${i + 1}`;
    // 图标尺寸：lucide 图标（和 <Icon>、<t.icon> 这类动态图标）的 size 只能是 ICON.*
    for (const m of line.matchAll(/<([A-Z][\w]*|[a-z]\w*\.icon)\b([^>]*?)\bsize=\{([^}]*)\}/g)) {
      const tag = m[1];
      if (!(lucide.has(tag) || /^(Icon|\w+\.icon)$/.test(tag))) continue;
      // Spinner 把调用方给的 ICON 尺寸原样传给 Loader2
      if (!/^ICON\.(xs|sm|md|lg)$/.test(m[3].trim()) && !(r === "src/components/ui.tsx" && tag === "Loader2" && m[3].trim() === "size")) add("tsx-icon-size", where, `<${tag} size={${m[3]}}>`);
    }
    for (const m of line.matchAll(/<([A-Z][\w]*)\b[^>]*?\bsize=(\d+|"\d+")/g)) if (lucide.has(m[1])) add("tsx-icon-size", where, `<${m[1]} size=${m[2]}>`);
    // 行内样式
    if (line.includes("style={{") && !STYLE_OK.some(([f, re]) => f === r && re.test(line))) add("tsx-inline-style", where, line.trim().slice(0, 120));
    // 旧类名：只看 className=… 和 cx(…) 的表达式里的字符串；比较运算的操作数（tone === "err"）不是类名
    for (const expr of classExprs(line)) {
      const e = expr.replace(/(===|!==)\s*"[^"]*"/g, "").replace(/"[^"]*"\s*(===|!==)/g, "");
      for (const m of e.matchAll(/"([^"\n]*)"/g)) for (const tok of m[1].split(/\s+/)) if (OLD.has(tok)) add("tsx-old-class", where, tok);
      for (const m of e.matchAll(/`([^`\n]*)`/g)) for (const tok of m[1].replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) if (OLD.has(tok)) add("tsx-old-class", where, tok);
    }
  });
}

// ---------- 3. 令牌 ----------
type Block = Map<string, string>;
function parseBlocks(css: string): { base: Block; dark: Block; light: Block } {
  const base: Block = new Map();
  const dark: Block = new Map();
  const light: Block = new Map();
  // 去掉注释和 @media 块（粗指针的覆盖只改尺寸，不参与颜色计算）
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    // @media 里的覆盖（粗指针）只看外层的值
    const target = /data-theme="light"/.test(sel) ? light : /data-theme="dark"/.test(sel) ? dark : /^:root$/.test(sel) ? base : null;
    if (!target) continue;
    for (const d of m[2].split(";")) {
      const c = d.indexOf(":");
      if (c < 0) continue;
      const k = d.slice(0, c).trim();
      if (k.startsWith("--")) target.set(k, d.slice(c + 1).trim());
    }
  }
  return { base, dark, light };
}

function checkTokens(tokensCss: string, cssFiles: string[], tsxFiles: string[]) {
  const { base, dark, light } = parseBlocks(tokensCss);
  const defined = new Set([...base.keys(), ...dark.keys(), ...light.keys()]);
  // 组件里就地定义的局部变量（例如 AgentMark 的色相、渐隐宽度）
  const local = new Set<string>();
  const uses = new Map<string, number>();
  const literal = new Set<string>();
  const sources: [string, string][] = [...cssFiles.map((f) => [f, readFileSync(f, "utf8")] as [string, string]), ...tsxFiles.map((f) => [f, readFileSync(f, "utf8")] as [string, string])];
  for (const [f, t] of sources) {
    const isTokens = f.endsWith("tokens.css");
    if (!isTokens) for (const m of t.matchAll(/(?<![\w-])(--[a-zA-Z][\w-]*)\s*:/g)) local.add(m[1]);
    for (const m of t.matchAll(/["'](--[a-zA-Z][\w-]*)["']\s*(as string)?\]?\s*:/g)) local.add(m[1]);
    for (const m of t.matchAll(/var\((--[a-zA-Z][\w-]*)/g)) uses.set(m[1], (uses.get(m[1]) ?? 0) + 1);
    // TSX 里按名字读取的令牌（终端读 --term-bg 等）：只算“用到”，不参与“未定义”的检查（命令行参数也长这样）
    if (!f.endsWith(".css")) for (const m of t.matchAll(/["'`](--[a-zA-Z][\w-]*)["'`]/g)) literal.add(m[1]);
  }
  for (const name of defined) if (!uses.has(name) && !literal.has(name) && !RESERVED.has(name)) add("token-unused", "src/styles/tokens.css", name);
  // Radix 在运行时给弹层设的变量（--radix-*）不归 tokens.css 管
  for (const [name, n] of uses) if (!defined.has(name) && !local.has(name) && !name.startsWith("--radix-")) add("token-undefined", `${n} 处`, name);
  return { base, dark, light };
}

// ---------- 4. 对比度 ----------
type RGBA = [number, number, number, number];
function resolve(name: string, theme: Block, base: Block, depth = 0): string {
  const raw = theme.get(name) ?? base.get(name);
  if (raw === undefined) throw new Error(`令牌 ${name} 没有定义`);
  if (depth > 8) throw new Error(`令牌 ${name} 引用太深`);
  return raw.replace(/var\((--[\w-]+)\)/g, (_, n: string) => resolve(n, theme, base, depth + 1));
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function parseColor(v: string): RGBA {
  const s = v.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const [r, g, b] = hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [r, g, b, a];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+))?\s*\)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error(`认不出的颜色：${v}`);
}
const over = (top: RGBA, bottom: RGBA): RGBA => {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
};
const lum = ([r, g, b]: RGBA) => {
  const c = (x: number) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** 一个“底”：令牌名，或 “上层令牌@下层底”（半透明的叠在下层上）。 */
function bgOf(spec: string, theme: Block, base: Block): RGBA {
  const parts = spec.split("@");
  let c = parseColor(resolve(parts[parts.length - 1], theme, base));
  for (let i = parts.length - 2; i >= 0; i--) c = over(parseColor(resolve(parts[i], theme, base)), c);
  return c;
}

const TEXT_PAIRS: [string, string[]][] = [
  ["--fg-primary", ["--bg-page", "--bg-surface", "--bg-float", "--bg-raised", "--bg-sunken"]],
  ["--fg-secondary", ["--bg-page", "--bg-surface", "--bg-float", "--bg-raised", "--bg-sunken", "--fill-control@--bg-surface", "--fill-selected@--bg-page"]],
  ["--fg-muted", ["--bg-page", "--bg-surface", "--bg-float", "--bg-raised", "--bg-sunken", "--fill-selected@--bg-surface", "--fill-selected@--bg-page", "--fill-hover@--bg-page", "--fill-selected@--bg-float"]],
  ["--accent-text", ["--bg-page", "--bg-surface", "--bg-float", "--accent-soft@--bg-surface"]],
  ["--ok-text", ["--ok-soft@--bg-surface", "--bg-surface"]],
  ["--warn-text", ["--warn-soft@--bg-surface", "--bg-surface", "--bg-page", "--bg-sunken"]],
  ["--err-text", ["--err-soft@--bg-surface", "--bg-surface", "--bg-page", "--bg-sunken"]],
  ["--btn-primary-fg", ["--btn-primary-bg"]],
  ["--danger-fg", ["--danger-bg"]],
  ["--tip-fg", ["--tip-bg"]],
  ["--term-fg", ["--term-bg"]],
];
const SURFACE_PAIRS: [string, string, number][] = [["--bg-surface", "--bg-page", 1.1]];

function checkContrast(base: Block, dark: Block, light: Block): string[] {
  const table: string[] = [];
  for (const [themeName, theme] of [["深色", dark], ["浅色", light]] as const) {
    for (const [fg, bgs] of TEXT_PAIRS)
      for (const bg of bgs) {
        try {
          const back = bgOf(bg, theme, base);
          const r = ratio(over(parseColor(resolve(fg, theme, base)), back), back);
          table.push(`${themeName} ${fg} / ${bg}: ${r.toFixed(2)}`);
          if (r < 4.5) add("contrast-text", themeName, `${fg} / ${bg} = ${r.toFixed(2)}（要 ≥ 4.5）`);
        } catch (e) {
          add("contrast-parse", themeName, `${fg} / ${bg}: ${(e as Error).message}`);
        }
      }
    for (const [a, b, min] of SURFACE_PAIRS) {
      try {
        const r = ratio(bgOf(a, theme, base), bgOf(b, theme, base));
        table.push(`${themeName} ${a} / ${b}: ${r.toFixed(3)}`);
        if (r < min) add("contrast-surface", themeName, `${a} / ${b} = ${r.toFixed(3)}（要 ≥ ${min}）`);
      } catch (e) {
        add("contrast-parse", themeName, `${a} / ${b}: ${(e as Error).message}`);
      }
    }
  }
  return table;
}

// ---------- 5. 词表 ----------
// 界面不直接显示后端的英文状态值、运行类型、原样时间、“38m”这类时长：渲染这些字段一律经 lib/format.ts、lib/research.ts 的词表和时间函数。
// 下面这些字段的值本来就是中文（研究记录里人写的），不算：结论状态（c.status、c["状态"]）、计划步骤状态（s.status）。
const VOCAB_FIELDS = /\{\s*[\w.]+\.(state|kind|elapsed|exit_status|status|verdict|review|trust)\s*\}/g;
const VOCAB_OK: [string, RegExp][] = [
  ["src/panels/TrustView.tsx", /\{(s|c)\.status\}/],
  ["src/panels/TrustView.tsx", /\{c\.kind\}/], // 结论性质（确认、探索）是账本里的中文
  ["src/components/ImportDrop.tsx", /\{k\.kind\}/], // 密钥类型（ED25519、RSA 4096）
  ["src/pages/Servers.tsx", /\{k\.kind\}/],
  ["src/pages/SessionView.tsx", /退出码 \$\{session\.exit_status\}/], // 退出码是数字
];
const RAW_TIME_FIELD = /\{\s*[\w.]+\.(\w+_at|mtime|updated|last_checked)\s*\}/g;
const RAW_TIME_CALL = /toISOString\(\)|toLocaleString\(|toLocaleDateString\(|toLocaleTimeString\(/;
const ENGLISH_STATUS = />\s*(running|done|failed|exited|stopped|unreachable|unknown|prereg|explore|ok|open|pending|skipped)\s*</i;

function checkVocab(file: string) {
  const r = rel(file);
  if (/lib\/format\.ts$|lib\/research\.ts$/.test(r)) return;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const where = `${r}:${i + 1}`;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const m of line.matchAll(VOCAB_FIELDS)) {
        const before = line.slice(0, m.index);
        if (/[\w-]+=\{?\s*$/.test(before) && !/>\s*$/.test(before)) continue; // 属性值（key、title 等）不是显示文字
        if (VOCAB_OK.some(([f, re]) => f === r && (re.test(m[0]) || re.test(line)))) continue;
        add("vocab-raw-field", where, m[0]);
      }
      for (const m of line.matchAll(RAW_TIME_FIELD)) {
        const before = line.slice(0, m.index);
        if (/[\w-]+=\{?\s*$/.test(before) && !/>\s*$/.test(before)) continue; // 属性值
        add("vocab-raw-time", where, m[0]);
      }
      if (RAW_TIME_CALL.test(line)) add("vocab-raw-time", where, line.trim().slice(0, 120));
      if (ENGLISH_STATUS.test(line)) add("vocab-english", where, line.trim().slice(0, 120));
    });
}

// ---------- 跑 ----------
const cssFiles = walk(STYLES, ".css");
const tsxFiles = [...walk(SRC, ".tsx"), ...walk(SRC, ".ts")];
for (const f of cssFiles) if (!f.endsWith("tokens.css")) checkCss(f);
for (const f of tsxFiles.filter((f) => f.endsWith(".tsx"))) checkTsx(f);
const { base, dark, light } = checkTokens(readFileSync(join(STYLES, "tokens.css"), "utf8"), cssFiles, tsxFiles);
const table = checkContrast(base, dark, light);
for (const f of tsxFiles.filter((f) => f.endsWith(".tsx"))) checkVocab(f);

const kinds = new Map<string, Violation[]>();
for (const v of out) kinds.set(v.kind, [...(kinds.get(v.kind) ?? []), v]);
if (process.argv.includes("--contrast")) for (const t of table) console.log(t);
for (const [k, vs] of kinds) {
  console.log(`\n${k}：${vs.length} 处`);
  for (const v of vs.slice(0, process.argv.includes("--all") ? Infinity : 40)) console.log(`  ${v.where}  ${v.what}`);
  if (vs.length > 40 && !process.argv.includes("--all")) console.log(`  …另 ${vs.length - 40} 处（--all 看全部）`);
}
console.log(`\n共 ${out.length} 处违规（${[...kinds].map(([k, v]) => `${k} ${v.length}`).join("，") || "无"}）`);
if (out.length > 0 && !REPORT) process.exit(1);
