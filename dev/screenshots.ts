// 截图：用本机的 Chrome（无界面）打开演示后端，逐页截图。两种用法：
//
// 1. README 用的截图（默认）：截到 docs/images/。
//      PORT=7980 bun dev/mock-server.ts      （另开一个终端）
//      bun dev/screenshots.ts
//
// 2. 界面走查（audit）：重拍界面审计（.orchestra/ui-audit）第 1.2 节的全部状态，加上审计没拍到的补拍项，
//    1440 宽、DPR 1、深浅两种主题；同时做界面统一设计稿第 8 节里能机器判断的几项（每页 primary 数、每行有色元素数、
//    英文状态词和原样 ISO 时间、欢迎页工具栏折行、科研子页滚动渐隐、控制台错误），结果写到 <输出目录>/checks.json。
//      PORT=7995 bun dev/mock-server.ts
//      BUNSEN_BACKEND=http://127.0.0.1:7995 pnpm --dir ui exec vite --port 5205 --strictPort
//      BASE=http://127.0.0.1:5205 bun dev/screenshots.ts audit .orchestra/ui-unify/after [dark|light|both]
//
// 3. 分屏（split）：分屏设计稿（.orchestra/design-split-view.md）的各个状态——2/3/4/6 格、焦点与非焦点、有新输出的点、
//    “更多”菜单、共享面板开关、窄窗收起、单独查看、拖入提示，860 宽面板里的显卡用量（S15），1280、1440、2560 宽面板里的显卡行
//    （S16，单会话页和分屏各一张，加服务器页），加欢迎页工具栏 1280、1440；深浅两种主题。
//    同样做第 2 种用法里的通用核对，外加小窗标题栏的几何核对、S15 的显卡行没有被硬裁、折行时“谁在用”靠右、接入命令没有超出面板右缘，
//    S16 的显卡行一行（行高没有翻倍、谁在用和用量同一行、用量没有被截断、走势图没有数据时不占位），结果写到 <输出目录>/checks.json。
//      PORT=7996 bun dev/mock-server.ts
//      BUNSEN_BACKEND=http://127.0.0.1:7996 pnpm --dir ui exec vite --port 5207 --strictPort
//      BASE=http://127.0.0.1:5207 API=http://127.0.0.1:7996 bun dev/screenshots.ts split .orchestra/split-view/after [dark|light|both]
//
// 环境变量：BASE（README 默认 http://localhost:7980，audit 默认 http://127.0.0.1:5205，split 默认 http://127.0.0.1:5207）、CHROME（Chrome 可执行文件路径）、
// PORT（Chrome 调试端口，README 默认 9334，audit 默认 9351，split 默认 9356）、ONLY（audit、split 只拍名字以这些前缀开头的状态，逗号分隔）、
// API（split：mock 的地址，用来让某个会话产生新输出，默认 http://127.0.0.1:7996）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SPLIT = process.argv[2] === "split";
const AUDIT = process.argv[2] === "audit" || SPLIT;
const BASE = process.env.BASE ?? (SPLIT ? "http://127.0.0.1:5207" : AUDIT ? "http://127.0.0.1:5205" : "http://localhost:7980");
const API = process.env.API ?? "http://127.0.0.1:7996";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = AUDIT ? resolve(process.argv[3] ?? join(import.meta.dir, "..", ".orchestra", SPLIT ? "split-view" : "ui-unify", "after")) : join(import.meta.dir, "..", "docs", "images");
const THEMES: ("dark" | "light")[] = !AUDIT ? ["dark"] : (process.argv[4] ?? "both") === "both" ? ["dark", "light"] : [process.argv[4] as "dark" | "light"];
const PORT = Number(process.env.PORT ?? (SPLIT ? 9356 : AUDIT ? 9351 : 9334));
const W = 1440;
const H = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "bunsen-shots-"));
const chrome = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, "--hide-scrollbars", "--no-first-run", "--disable-gpu", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 50; i++) {
    try {
      const tabs = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = tabs.find((t) => t.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise<void>((ok, bad) => {
          ws.onopen = () => ok();
          ws.onerror = () => bad(new Error("连不上 Chrome"));
        });
        return ws;
      }
    } catch {
      /* Chrome 还没起来 */
    }
    await sleep(200);
  }
  throw new Error("Chrome 没有启动");
}

const ws = await connect();
let seq = 0;
const waiting = new Map<number, (v: any) => void>();
/** audit：控制台错误和警告（带当前状态名）。 */
const consoleIssues: string[] = [];
let state = "";
/** audit：拦截 /api/meta 造启动态。hold：挂起不回；fail：断开；unauth：回 401。 */
let metaMode: null | "hold" | "fail" | "unauth" = null;
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)!(m.result ?? m.error);
    waiting.delete(m.id);
    return;
  }
  if (m.method === "Fetch.requestPaused") {
    const id = m.params.requestId;
    if (metaMode === "fail") void cdp("Fetch.failRequest", { requestId: id, errorReason: "ConnectionRefused" });
    else if (metaMode === "unauth")
      void cdp("Fetch.fulfillRequest", {
        requestId: id,
        responseCode: 401,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify({ error: { code: "unauthorized", message: "令牌不对或缺少令牌" } })).toString("base64"),
      });
    else if (metaMode !== "hold") void cdp("Fetch.continueRequest", { requestId: id });
    return;
  }
  // 启动态是故意造的错误（断开、401），那几张图的控制台报错不算
  const expected = state.startsWith("00-boot");
  if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning" || m.params.type === "assert") && !expected)
    consoleIssues.push(`[${state}] console.${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
  if (m.method === "Runtime.exceptionThrown" && !expected) consoleIssues.push(`[${state}] exception: ${(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text ?? "").slice(0, 300)}`);
  // “找不到项目”“找不到会话”两张图故意请求不存在的地址，它们的 404 不算
  const deliberate404 = m.method === "Log.entryAdded" && /\/(no-such-project|nope99)(\/|$)/.test(m.params.entry.url ?? "");
  if (m.method === "Log.entryAdded" && (m.params.entry.level === "error" || m.params.entry.level === "warning") && !expected && !deliberate404) consoleIssues.push(`[${state}] log.${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
};
const cdp = (method: string, params: object = {}) =>
  new Promise<any>((ok) => {
    const id = ++seq;
    waiting.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression: string) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

async function open(hash: string, theme: "dark" | "light" = "dark") {
  await cdp("Page.navigate", { url: "about:blank" });
  await cdp("Page.navigate", { url: `${BASE}/#token=dev` });
  await sleep(700);
  await js(`localStorage.setItem("bunsen.theme", JSON.stringify("${theme}")); location.hash = ${JSON.stringify(hash)}; 1`);
  await sleep(300);
  await js(`document.documentElement.dataset.theme = "${theme}"; 1`);
  await sleep(1500);
}
/** 点一个文字以 text 开头的按钮或页签（可限定在某个容器里）。 */
const click = (text: string, within = "body") =>
  js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(within)} + " button, " + ${JSON.stringify(within)} + " [role=tab], " + ${JSON.stringify(within)} + " a")].find((b) => b.textContent.trim().replace(/\\s+/g, " ").startsWith(${JSON.stringify(text)})); if (el) el.click(); return !!el; })()`);
async function shot(name: string) {
  await sleep(500);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
  console.log("  ", name);
}

async function readme() {
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

  const sessions = (await (await fetch(`${BASE}/api/sessions`, { headers: { "x-bunsen-token": "dev" } })).json()) as { id: string; state: string }[];
  const sid = (sessions.find((s) => s.state === "running") ?? sessions[0]).id;

  await open("/");
  await shot("welcome.png");

  await open(`/s/${sid}`);
  await click("产物", '[data-tabs="workspace"]');
  await sleep(1200);
  await shot("session.png");

  await click("科研", '[data-tabs="workspace"]');
  await sleep(800);
  await click("结论", '[data-tabs="research"]');
  await shot("research.png");

  await click("概览", '[data-tabs="workspace"]');
  await sleep(800);
  await shot("overview.png");

  await open("/servers");
  await shot("servers.png");

  await open(`/s/${sid}`, "light");
  await click("科研", '[data-tabs="workspace"]');
  await sleep(600);
  await click("运行", '[data-tabs="research"]');
  await shot("light.png");
}

// ---------------------------------------------------------------- audit ----------------------------------------------------------------

type Check = { state: string; name: string; ok: boolean; detail?: unknown };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ state, name, ok, detail });
  if (!ok) console.log(`   FAIL [${state}] ${name}  ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 300)}`);
}
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const want = (name: string) => !ONLY || ONLY.some((p) => name.startsWith(p));
let theme: "dark" | "light" = "dark";

async function waitFor(expr: string, timeout = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await js(`!!(${expr})`)) return true;
    await sleep(100);
  }
  return false;
}
async function route(hash: string, wait = 900) {
  await js(`location.hash = ${JSON.stringify("#" + hash)}; 1`);
  await sleep(wait);
}
async function setTheme(t: "dark" | "light") {
  theme = t;
  const s = await (await fetch(`${BASE}/api/settings`, { headers: { "x-bunsen-token": "dev" } })).json();
  await fetch(`${BASE}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", "x-bunsen-token": "dev" }, body: JSON.stringify({ ...(s as object), theme: t }) });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: t }] });
  await reload();
}
async function reload(hash = "/") {
  await cdp("Page.navigate", { url: "about:blank" });
  await sleep(100);
  await cdp("Page.navigate", { url: `${BASE}/#token=dev` });
  await waitFor(`document.querySelector(".sidebar")`, 8000);
  await sleep(600);
  if (hash !== "/") await route(hash);
}
async function setWidth(w: number) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: H, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}
/** 用真实的鼠标事件点一个元素（Radix 的下拉、菜单只认 pointer 事件）。 */
async function mclick(sel: string, text?: string): Promise<boolean> {
  const box = await js(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${text === undefined ? "els[0]" : `els.find((e) => e.textContent.trim().replace(/\\s+/g, " ").startsWith(${JSON.stringify(text)}))`}; if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, pointerType: "mouse" });
  await sleep(250);
  return true;
}
async function key(k: string, code = k, vk = 0, modifiers = 0) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(150);
}
const escape = () => key("Escape", "Escape", 27);
const setInput = (sel: string, v: string) =>
  js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); if (!i) return false; const proto = i instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const scrollEl = (sel: string, top: number | "bottom") => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.scrollTop = ${top === "bottom" ? "el.scrollHeight" : top}; return true; })()`);

/**
 * 截图前的通用核对：每页最多一个 primary、每行最多一个有色元素、没有英文状态词和原样 ISO 时间；
 * 统一审查第 1 轮补：浮层容器（菜单、下拉、对话框、命令面板、tooltip、toast）自身没有焦点环（U1-03）；tooltip 反色（U1-16）；
 * 输入条的按键常显、没有说明文字（U1-18，分屏稿 13.5）。
 */
const PAGE_CHECKS = `(() => {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && getComputedStyle(e).visibility !== "hidden";
  const dialog = document.querySelector(".dialog");
  const scope = dialog ?? document.body;
  const primaries = [...scope.querySelectorAll('.button[data-variant="primary"]')].filter(visible).map((b) => b.textContent.trim());
  // 有色：状态色的字（直接带文字的元素）、warn/err 徽标、状态点（live/err/warn/new）
  const probe = document.createElement("span");
  document.body.appendChild(probe);
  const colorOf = (v) => { probe.style.color = "var(" + v + ")"; return getComputedStyle(probe).color; };
  const tones = new Set(["--err-text", "--warn-text", "--ok-text", "--accent-text", "--brand"].map(colorOf));
  const accent = colorOf("--accent"), fgPrimary = colorOf("--fg-primary"), bgSurface = colorOf("--bg-surface");
  probe.remove();
  const overlays = [...document.querySelectorAll(".menu-panel, .dialog, .palette, .tooltip, .toast-card")].filter(visible);
  const ringed = overlays.filter((o) => getComputedStyle(o).boxShadow.includes(accent)).map((o) => o.className + (o.matches(":focus-visible") ? "（:focus-visible）" : ""));
  const tips = [...document.querySelectorAll(".tooltip")].filter(visible).map((t) => ({ bg: getComputedStyle(t).backgroundColor, fg: getComputedStyle(t).color })).filter((t) => t.bg !== fgPrimary || t.fg !== bgSurface);
  // 输入条（分屏稿 13.5）：按键常显；按键行里只有按键，不加“↵ 发送 · ⇧↵ 换行”这类说明文字（聚焦与否都一样）
  const bars = [...document.querySelectorAll(".message-bar")].filter(visible).map((b) => {
    const keys = b.querySelector(".msgbar-keys");
    const extra = keys ? [...keys.childNodes].filter((n) => !(n.nodeType === 1 && n.matches("button"))).map((n) => n.textContent.trim()).filter(Boolean) : [];
    return { keys: !!keys && visible(keys) && [...keys.querySelectorAll("button")].every(visible), hint: !!b.querySelector(".msgbar-hint") || extra.length > 0, extra, focused: b.matches(":focus-within") };
  }).filter((x) => !x.keys || x.hint);
  const ownText = (e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  // 会话头和分屏小窗标题栏都算“行”；其中常驻的“免确认”warn 徽标（data-yolo）是设计稿 5.1、分屏稿 12.5 规定的安全信息，不计入（两处豁免方式相同）
  const colored = (e) => !e.matches("[data-yolo]") && (e.matches('.badge[data-tone="warn"], .badge[data-tone="err"], .status-dot[data-tone="live"], .status-dot[data-tone="err"], .status-dot[data-tone="warn"], .status-dot[data-tone="new"]') || (ownText(e) && tones.has(getComputedStyle(e).color) && !e.closest("a, .inline-link, .xterm, .md, pre"))) && visible(e);
  const ROW = ".list-row, .tbl tbody tr, .item, .card-head, .kv > dd, .notice, .issue-row, .tabbar-item, .page-header, .panel-bar, .session-head, .pane-bar";
  const rows = [...scope.querySelectorAll(ROW)].filter(visible);
  const busy = [];
  for (const r of rows) {
    // 一行里嵌着别的行（展开的结论里的问题）时，嵌套行里的颜色归嵌套行：只数最近的行是 r 的元素
    const hits = [r, ...r.querySelectorAll("*")].filter((e) => e.closest(ROW) === r).filter(colored).filter((e, _, all) => !all.some((o) => o !== e && o.contains(e)));
    if (hits.length > 1) busy.push(r.className.split(" ")[0] + "：" + r.innerText.trim().replace(/\\s+/g, " ").slice(0, 80) + "（" + hits.length + " 个）");
  }
  // 显示文字里的英文状态词和原样 ISO：跳过等宽、代码、Markdown、日志、终端、输入框
  const SKIP = ".mono, code, pre, kbd, .md, .log, .xterm, input, textarea, script, style, .sr-only, [aria-hidden=true]";
  // 词两边不能是字母、数字、点、斜杠、连字符：文件名里的 explore.ipynb、prereg/P-001.md 不算
  const words = /(?<![\\w./-])(running|done|failed|exited|stopped|unreachable|online|offline|pending|prereg|explore|cancelled|success|auth_failed|unreviewed|reviewed|retracted|not_found)(?![\\w./-])/i;
  const iso = /\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}/;
  const short = /(^|[^\\w.-])\\d+(m|h\\d+m|d\\d+h)(?![\\w.-])/;
  const english = [], isos = [];
  const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const t = n.textContent;
    const p = n.parentElement;
    if (!t.trim() || !p || p.closest(SKIP) || !visible(p)) continue;
    if (words.test(t)) english.push(t.trim().slice(0, 80));
    if (iso.test(t) || short.test(t)) isos.push(t.trim().slice(0, 80));
  }
  return { primaries, busy, english, isos, ringed, tips, bars };
})()`;

async function snap(name: string, opts: { primaries?: number } = {}) {
  state = name;
  await sleep(450);
  const r = await js(PAGE_CHECKS);
  if (r) {
    check("最多一个 primary", r.primaries.length <= (opts.primaries ?? 1), r.primaries);
    check("每行最多一个有色元素", r.busy.length === 0, r.busy);
    check("没有英文状态词", r.english.length === 0, r.english);
    check("没有原样 ISO 时间和 38m 这类写法", r.isos.length === 0, r.isos);
    check("浮层容器（菜单、下拉、对话框、命令面板、tooltip、toast）没有焦点环", r.ringed.length === 0, r.ringed);
    check("tooltip 反色（底 --fg-primary、字 --bg-surface）", r.tips.length === 0, r.tips);
    check("输入条：按键常显，没有说明文字", r.bars.length === 0, r.bars);
  }
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `${name}--${theme}.png`), Buffer.from(data, "base64"));
  console.log("  ", `${name}--${theme}.png`);
}

async function openSession(id: string, tab?: string) {
  await route(`/s/${id}`);
  await waitFor(`document.querySelector('[data-tabs="workspace"]') || document.querySelector(".empty-block")`, 6000);
  if (tab) {
    await click(tab, '[data-tabs="workspace"]');
    await sleep(700);
  }
}
async function researchTab(label: string) {
  await click(label, '[data-tabs="research"]');
  await sleep(500);
}
async function runTab(label: string) {
  await click(label, '[data-tabs="run"]');
  await sleep(450);
}
async function openRun(rid: string) {
  await researchTab("运行");
  await js(`[...document.querySelectorAll("[data-run]")].find((b) => b.dataset.run.includes(${JSON.stringify(rid)}))?.click(); 1`);
  await waitFor(`document.querySelector('[data-tabs="run"]')`, 5000);
  await sleep(500);
}
async function back() {
  await js(`document.querySelector("[data-back] button, button[data-back]")?.click(); 1`);
  await sleep(400);
}

async function boot() {
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "*/api/meta*" }] });
  for (const [name, mode] of [
    ["00-boot-loading", "hold"],
    ["00-boot-error-unreachable", "fail"],
    ["00-boot-error-no-token", "unauth"],
  ] as const) {
    if (!want(name)) continue;
    metaMode = mode;
    state = name;
    await cdp("Page.navigate", { url: "about:blank" });
    await cdp("Page.navigate", { url: `${BASE}/#token=dev` });
    await sleep(mode === "hold" ? 1500 : 2200);
    await snap(name);
  }
  metaMode = null;
  await cdp("Fetch.disable");
  await reload();
}

async function welcome() {
  await reload();
  if (want("01-welcome")) {
    await waitFor(`document.querySelector('button[aria-label="部署并开始"]')`);
    await snap("01-welcome");
    if (await mclick('button[aria-label="选择服务器"]')) {
      await sleep(300);
      await snap("01-welcome-server-picker");
      await escape();
    }
  }
  // 工具栏不折行：atlas、普通长度的工作目录（审计 #10 的情形），1280 和 1440 宽
  if (want("01-welcome") || want("90")) {
    await mclick('button[aria-label="选择服务器"]');
    await mclick('[role="option"]', "atlas");
    await setInput('input[aria-label="工作目录"]', "~/work/longtail-classification/experiments");
    await sleep(300);
    for (const w of [1280, 1440]) {
      await setWidth(w);
      state = `90-welcome-${w}`;
      const m = await js(`(() => { const bar = document.querySelector(".composer-bar"); const send = document.querySelector(".composer-send"); const chips = [...document.querySelectorAll(".composer-chips > *")]; const tops = [send, ...chips].map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)); return { barH: Math.round(bar.getBoundingClientRect().height), centers: [...new Set(tops)], wrap: getComputedStyle(document.querySelector(".composer-chips")).flexWrap }; })()`);
      check(`${w} 宽：欢迎页工具栏不折行`, m.centers.length === 1 && m.wrap === "nowrap", m);
      await snap(`90-welcome-${w}`);
    }
    await setWidth(W);
  }
  if (want("02")) {
    // 部署进行中、在项目一步失败：从项目页带着项目进欢迎页，工作目录带 timeout
    await route("/p/lt7k2q");
    await waitFor(`document.querySelector("[data-line]")`, 6000);
    await click("新对话", ".page-header");
    await waitFor(`document.querySelector('button[aria-label="部署并开始"]')`);
    await sleep(400);
    await setInput('input[aria-label="工作目录"]', "~/work/longtail-timeout");
    await sleep(200);
    await js(`document.querySelector('button[aria-label="部署并开始"]').click(); 1`);
    await sleep(900);
    await snap("02-deploy-running");
    await waitFor(`document.querySelector("[data-deploy-error]")`, 15000);
    await snap("02-deploy-failed-project");
    // 连不上：换成 titan
    await reload();
    await waitFor(`document.querySelector('button[aria-label="部署并开始"]')`);
    await mclick('button[aria-label="选择服务器"]');
    await mclick('[role="option"]', "titan");
    await sleep(300);
    await js(`document.querySelector('button[aria-label="部署并开始"]').click(); 1`);
    await waitFor(`document.querySelector("[data-deploy-error]")`, 15000);
    await snap("02-deploy-failed-unreachable");
  }
}

async function pages() {
  if (want("03")) {
    await reload("/servers");
    await waitFor(`document.querySelector("[data-server]")`);
    await snap("03-servers");
    await scrollEl(".page", 700);
    await snap("03-servers-scrolled");
    await scrollEl(".page", "bottom");
    await snap("03-servers-bottom");
  }
  if (want("04")) {
    await route("/settings");
    await waitFor(`document.querySelector('[data-page="settings"]')`);
    await snap("04-settings");
    await scrollEl(".page", "bottom");
    await snap("04-settings-bottom");
  }
  if (want("05")) {
    await route("/projects");
    await waitFor(`document.querySelectorAll(".project-card").length >= 4`);
    await snap("05-projects");
    await click("新建项目", ".page-header");
    await waitFor(`document.querySelector(".dialog")`);
    await snap("05-projects-new-dialog");
    await escape();
  }
  if (want("06")) {
    await route("/p/lt7k2q");
    await waitFor(`document.querySelector("[data-line]")`, 6000);
    await snap("06-project");
    for (const [i, top] of [[2, 700], [3, 1400], [4, "bottom"]] as const) {
      await scrollEl(".page", top);
      await snap(`06-project-p${i}`);
    }
    await route("/p/pf3m9a");
    await waitFor(`document.querySelector("[data-hub-down]")`, 6000);
    await snap("06-project-hub-offline");
    await route("/p/q2sk8d");
    await waitFor(`document.querySelector("[data-line]")`, 6000);
    await snap("06-project-old-rk");
    await route("/p/no-such-project");
    await waitFor(`document.querySelector(".empty-block-title")`, 6000);
    await snap("06-project-not-found");
  }
}

async function session() {
  if (want("1")) {
    await reload();
    await openSession("k7f2qa", "概览");
    await snap("10-session-overview");
    await click("文件", '[data-tabs="workspace"]');
    await waitFor(`document.querySelector(".panel .list-row")`, 5000);
    await snap("11-session-files");
    await js(`[...document.querySelectorAll(".panel .list-row")].find((r) => /\\.(md|py|yaml)$/.test(r.innerText.trim().split("\\n")[0]))?.click(); 1`);
    await waitFor(`document.querySelector("[data-crumb]")`, 5000);
    await sleep(600);
    await snap("11-session-file-preview");
    await click("改动", '[data-tabs="workspace"]');
    await sleep(900);
    await snap("12-session-git");
    await click("产物", '[data-tabs="workspace"]');
    await waitFor(`document.querySelectorAll(".art").length >= 4`, 5000);
    await sleep(600);
    await snap("13-session-artifacts");
  }
  if (want("2")) {
    await reload();
    await openSession("k7f2qa", "科研");
    await waitFor(`document.querySelector('[data-tabs="research"]')`);
    for (const [n, label] of [["20-research-state", "状态"], ["21-research-runs", "运行"], ["22-research-claims", "结论"]] as const) {
      await researchTab(label);
      await snap(n);
    }
    await researchTab("可信度");
    await sleep(150);
    await snap("23-research-trust-loading");
    await waitFor(`document.querySelector("[data-trust]")`, 8000);
    await snap("23-research-trust");
    // 展开第一条结论：看细节
    await js(`document.querySelector("[data-claim] button")?.click(); 1`);
    await snap("23-research-trust-claim-open");
    for (const [n, label] of [["24-research-ideas", "想法"], ["25-research-overview", "总览"], ["26-research-notes", "记录"]] as const) {
      await researchTab(label);
      await snap(n);
    }
    await openSession("lc3n8p", "科研");
    await researchTab("可信度");
    await waitFor(`document.querySelector("[data-trust]")`, 8000);
    await snap("27-trust-partial-failures-lc3n8p");
    await openSession("v6h3om", "科研");
    await researchTab("可信度");
    await waitFor(`document.querySelector(".empty-block-title")`, 8000);
    await snap("28-trust-unavailable-v6h3om");
  }
  if (want("3")) {
    await reload();
    await openSession("k7f2qa", "科研");
    await waitFor(`document.querySelector('[data-tabs="research"]')`);
    await openRun("r03");
    for (const [n, label] of [["30-run-log", "日志"], ["31-run-metrics", "指标"], ["32-run-result", "结果页"], ["33-run-env", "环境"], ["34-run-inputs", "输入"], ["35-run-outputs", "输出"], ["36-run-meta", "元数据"]] as const) {
      await runTab(label);
      if (n === "34-run-inputs") {
        // 审查 U1-10：路径列占剩余宽度、不比界面统一之前窄（审计图里约 120px 的文字宽）；sha 只显示前 8 位，全值在 title
        state = n;
        const m = await js(`(() => {
          const t = document.querySelector('[data-prov="inputs"] table'); if (!t) return null;
          const ths = [...t.querySelectorAll("thead th")].map((th) => { const cs = getComputedStyle(th); return Math.round(th.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)); });
          const shas = [...t.querySelectorAll("[data-sha]")].map((e) => ({ text: e.textContent, title: e.title }));
          return { path: ths[0], rest: ths.slice(1), table: Math.round(t.getBoundingClientRect().width), shas };
        })()`);
        check("运行输入表：路径列文字宽不少于 120px（界面统一之前的宽度）", !!m && m.path >= 120, m);
        check("运行输入表：sha 显示前 8 位，悬停 title 是全文", !!m && m.shas.length > 0 && m.shas.every((x: any) => /^[0-9a-f]{8}$/.test(x.text) && x.title.length === 64 && x.title.startsWith(x.text)), m?.shas);
      }
      await snap(n);
    }
    await back();
    await openRun("r04");
    await runTab("环境");
    await snap("37-run-r04-env");
    await runTab("输入");
    await snap("37-run-r04-inputs-empty");
    await runTab("输出");
    await snap("37-run-r04-outputs-error");
    await back();
    await openRun("r05");
    await runTab("环境");
    await snap("38-run-r05-env-live");
    await runTab("输出");
    await snap("38-run-r05-outputs-live");
    await back();
  }
  if (want("4")) {
    await reload();
    await openSession("k7f2qa");
    await mclick('[data-session-head] button[aria-label="更多"]');
    await waitFor(`document.querySelector(".menu-panel")`);
    await snap("40-session-menu");
    await mclick(".menu-row", "结束会话");
    await waitFor(`document.querySelector(".dialog")`);
    await snap("41-session-confirm-stop");
    await escape();
    await js(`[...document.querySelectorAll(".side-nav .list-row")].find((r) => r.innerText.includes("搜索"))?.click(); 1`);
    await waitFor(`document.querySelector(".palette")`);
    await snap("42-palette");
    await setInput(".palette-search input", "长尾");
    await sleep(300);
    await snap("42-palette-query");
    await escape();
  }
  if (want("5")) {
    await reload();
    await openSession("m2x8cd", "产物");
    await sleep(800);
    await snap("50-artifacts-no-plugin");
    await click("科研", '[data-tabs="workspace"]');
    await sleep(900);
    await snap("50-empty-research-no-plugin");
    await openSession("t4r7vb", "科研");
    await sleep(900);
    await snap("51-session-unreachable");
    await openSession("d0x1zz");
    await sleep(600);
    await snap("52-session-stopped");
    await route("/s/nope99");
    await sleep(600);
    await snap("53-session-not-found");
    await openSession("k7f2qa");
    await mclick('button[aria-label="收起侧栏"]');
    await sleep(400);
    await snap("54-sidebar-collapsed");
    await mclick('button[aria-label="展开侧栏"]');
  }
}

async function extras() {
  if (want("60")) {
    // ErrorBoundary：把项目视图的 machines 改成数字，页面渲染出错
    await reload();
    await js(`window.__mutate = { "/view": (j) => ({ ...j, machines: 5 }) }; 1`);
    const before = consoleIssues.length;
    await route("/p/lt7k2q", 1800);
    await waitFor(`document.querySelector("[data-error-boundary]")`, 6000);
    await snap("60-error-boundary");
    // 这一张是故意弄坏的：React 报的渲染错误不算
    consoleIssues.length = before;
    await js(`window.__mutate = null; 1`);
  }
  if (want("61")) {
    await reload();
    await openSession("k7f2qa", "概览");
    await js(`[...document.querySelectorAll(".inline-link")].find((b) => b.title === "点击复制")?.click(); 1`);
    await waitFor(`document.querySelector(".toast-card")`, 3000);
    await snap("61-toast");
  }
  if (want("62")) {
    await reload("/servers");
    await click("添加服务器", ".page-header");
    await waitFor(`document.querySelector(".dialog")`);
    await snap("62-dialog-add-server");
    await escape();
  }
  if (want("63")) {
    await reload("/settings");
    await waitFor(`document.querySelector("[data-agent]")`);
    await js(`document.querySelector("[data-agent] .list-row-main")?.click(); 1`);
    await waitFor(`document.querySelector(".dialog")`);
    await snap("63-dialog-edit-agent");
    await escape();
  }
  if (want("64")) {
    await reload("/servers");
    await waitFor(`document.querySelector("[data-server]")`);
    // 一台服务器上没装的 Agent：点它的芯片打开安装对话框
    const ok = await js(`(() => { const b = [...document.querySelectorAll(".card-agents .button")].find((x) => x.innerText.includes("未安装")); if (b) b.click(); return !!b; })()`);
    if (ok) {
      await waitFor(`document.querySelector(".dialog")`);
      await snap("64-dialog-install-agent");
      await click("开始安装", ".dialog");
      await waitFor(`document.querySelector(".dialog-term")`, 5000);
      await sleep(1500);
      await snap("64-dialog-install-terminal");
      await escape();
    } else check("有没装 Agent 的服务器可以拍安装对话框", false);
  }
  if (want("65")) {
    // tooltip：反色（统一稿第 2 节，审查 U1-16），悬停会话头的图标按钮
    await reload();
    await openSession("k7f2qa");
    const b = await js(`(() => { const r = document.querySelector('[data-session-head] button[aria-label="更多"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
    await waitFor(`document.querySelector(".tooltip")`, 3000);
    await sleep(300);
    state = "65-tooltip";
    check("悬停图标按钮出现 tooltip", await js(`!!document.querySelector(".tooltip")`));
    await snap("65-tooltip");
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  }
  if (want("66")) {
    // 菜单的键盘高亮比悬停深一级（审查 U1-15）：键盘打开会话头的“更多”，第一项被键盘高亮；再用鼠标悬停另一项
    await reload();
    await openSession("k7f2qa");
    await js(`document.querySelector('[data-session-head] button[aria-label="更多"]').focus(); 1`);
    await key("Enter", "Enter", 13);
    await waitFor(`document.querySelector(".menu-panel .menu-row[data-highlighted]")`, 3000);
    await sleep(300);
    state = "66-menu-keyboard";
    const fill = (v: string) => `(() => { const p = document.createElement("div"); p.style.background = "var(${v})"; document.body.appendChild(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; })()`;
    const sel = await js(fill("--fill-selected"));
    const hov = await js(fill("--fill-hover"));
    const kb = await js(`getComputedStyle(document.querySelector(".menu-panel .menu-row[data-highlighted]")).backgroundColor`);
    check("菜单：键盘高亮的条目用 --fill-selected（比悬停深一级）", kb === sel && sel !== hov, { kb, sel, hov });
    await snap("66-menu-keyboard");
    const rows = await js(`[...document.querySelectorAll(".menu-panel .menu-row")].map((r) => { const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: rows[2].x, y: rows[2].y });
    await sleep(300);
    const hv = await js(`(() => { const r = document.querySelector(".menu-panel .menu-row[data-highlighted]"); return r ? getComputedStyle(r).backgroundColor : null; })()`);
    check("菜单：鼠标悬停的条目用 --fill-hover", hv === hov, { hv, hov });
    await snap("66-menu-hover");
    await escape();
  }
  if (want("70")) {
    // 窄屏（860 以下）
    await setWidth(800);
    await reload();
    await snap("70-narrow-welcome");
    await openSession("k7f2qa", "科研");
    await sleep(600);
    await snap("70-narrow-session-research");
    await route("/servers");
    await snap("70-narrow-servers");
    await route("/p/lt7k2q");
    await waitFor(`document.querySelector("[data-line]")`, 6000);
    await snap("70-narrow-project");
    await setWidth(W);
  }
  if (want("80")) {
    // 大数据量：几百条结论、5000 个输出文件
    await reload();
    await openSession("h9big1", "科研");
    await researchTab("可信度");
    await waitFor(`document.querySelectorAll("[data-claim]").length >= 400`, 15000);
    await snap("80-big-trust");
    await openRun("r09-sweep");
    await runTab("输出");
    await waitFor(`document.querySelector('[data-prov="outputs"] tbody tr')`, 6000);
    await snap("80-big-outputs");
    await back();
  }
  if (want("91")) {
    // 科研面板 7 个子页在 1280 宽：子页标签栏放不下时横向滚动、两端渐隐；内容超出时上下渐隐（滚到中间看两端）
    await setWidth(1280);
    await reload();
    await openSession("k7f2qa", "科研");
    for (const label of ["状态", "运行", "结论", "可信度", "想法", "总览", "记录"]) {
      await researchTab(label);
      if (label === "可信度") await waitFor(`document.querySelector("[data-trust]")`, 15000);
      await sleep(400);
      state = `91-fade-1280-${label}`;
      const f = await js(`(() => {
        const mask = (e) => { const m = getComputedStyle(e).maskImage || getComputedStyle(e).webkitMaskImage; return !!m && m !== "none"; };
        const bar = document.querySelector('[data-tabs="research"] .tabbar-scroll');
        const tabsOver = bar.scrollWidth > bar.clientWidth + 1;
        const b = document.querySelector('[data-body="research"]');
        const over = b.scrollHeight > b.clientHeight + 1;
        if (over) b.scrollTop = Math.round((b.scrollHeight - b.clientHeight) / 2);
        return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok({ tabsOver, tabsEnd: bar.hasAttribute("data-more-end") || bar.hasAttribute("data-more-start"), tabsMask: mask(bar), over, start: b.hasAttribute("data-more-start"), end: b.hasAttribute("data-more-end"), bodyMask: mask(b) }))));
      })()`);
      check(`1280 宽科研“${label}”：子页标签栏放不下时两端渐隐`, !f.tabsOver || (f.tabsEnd && f.tabsMask), f);
      check(`1280 宽科研“${label}”：内容超出时上下渐隐`, !f.over || (f.start && f.end && f.bodyMask), f);
      await snap(`91-fade-1280-${label}`);
      await js(`document.querySelector('[data-body="research"]').scrollTop = 0; 1`);
    }
    await setWidth(W);
  }
}

// ---------------------------------------------------------------- split ----------------------------------------------------------------

const S = { A: "k7f2qa", B: "lc3n8p", C: "m2x8cd", D: "a2abs9", E: "h9big1", F: "v6h3om", G: "q9d4ht" };
type Cell = { id: string; col: number; row: number };

async function setSize(w: number, h: number) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
}
/** 预置分屏布局（和共享面板的开关；local 是另外要预置的 localStorage 键）后新开文档，打开 focus 那个会话。 */
async function openSplit(focus: string, extras: Cell[], drawer: { open: boolean; size: number } | null = null, local: Record<string, unknown> = {}) {
  await reload();
  const layout = { version: 1, primary: S.A, extras, colWeights: [], rowSplit: 0.5 };
  await js(`localStorage.setItem("bunsen.split.v1", ${JSON.stringify(JSON.stringify(layout))}); ${drawer ? `localStorage.setItem("bunsen.split.drawer", ${JSON.stringify(JSON.stringify(drawer))})` : `localStorage.removeItem("bunsen.split.drawer")`}; ${Object.entries(local).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`).join(" ")} 1`);
  await cdp("Page.navigate", { url: "about:blank" });
  await sleep(100);
  await cdp("Page.navigate", { url: `${BASE}/#/s/${focus}` });
  await waitFor(`document.querySelectorAll(".split-pane").length >= 1`, 8000);
  await sleep(1500);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
}
/**
 * 小窗标题栏的几何核对：高 32（--bar-pane）、里面的东西不出标题栏、按钮不和标题重叠；格子之间 1px。
 * 统一审查第 1 轮补：标题栏顺序是状态点、标题、别名、徽标（分屏稿 12.5）；终端用 --bg-sunken（U1-16）。
 */
const PANE_CHECKS = `(() => {
  const bad = [];
  const bars = [...document.querySelectorAll(".split-pane .pane-bar")];
  const probe = document.createElement("div");
  probe.style.background = "var(--bg-sunken)";
  document.body.appendChild(probe);
  const sunken = getComputedStyle(probe).backgroundColor;
  probe.remove();
  for (const t of document.querySelectorAll(".split-pane .term")) if (getComputedStyle(t).backgroundColor !== sunken) bad.push(t.closest(".split-pane").dataset.pane + " 终端底色不是 --bg-sunken：" + getComputedStyle(t).backgroundColor);
  for (const b of bars) {
    const r = b.getBoundingClientRect();
    const id = b.closest(".split-pane").dataset.pane;
    const kids = [...b.children];
    const pos = [".status-dot", ".session-title", ".session-server", "[data-yolo]"].map((sel) => kids.findIndex((k) => k.matches(sel))).filter((i) => i >= 0);
    if (pos.some((p, i) => i > 0 && p < pos[i - 1])) bad.push(id + " 标题栏顺序不是状态点、标题、别名、徽标");
    if (Math.abs(r.height - 32) > 0.5) bad.push(id + " 标题栏高 " + r.height);
    for (const k of b.querySelectorAll("*")) {
      const kr = k.getBoundingClientRect();
      if (!kr.width || getComputedStyle(k).visibility === "hidden") continue;
      if (kr.left < r.left - 0.5 || kr.right > r.right + 0.5 || kr.top < r.top - 0.5 || kr.bottom > r.bottom + 0.5) bad.push(id + " " + (k.getAttribute("aria-label") || k.className || k.tagName) + " 出了标题栏");
    }
    const title = b.querySelector(".session-title")?.getBoundingClientRect();
    const acts = [...b.querySelectorAll(".pane-actions, [data-drawer-toggle], [data-split-switch], [data-restore]")].map((e) => e.getBoundingClientRect()).filter((x) => x.width);
    if (title && acts.some((a) => a.left < title.right - 0.5 && title.left < a.right - 0.5)) bad.push(id + " 按钮压在标题上");
  }
  const panes = [...document.querySelectorAll(".split-pane")].map((p) => p.getBoundingClientRect());
  for (const a of panes) for (const c of panes) if (a !== c && Math.abs(a.top - c.top) < 1 && c.left > a.right - 0.5 && c.left - a.right < 4 && Math.abs(c.left - a.right - 1) > 0.1) bad.push("格间 " + (c.left - a.right));
  return { bars: bars.length, bad };
})()`;
/**
 * 共享面板概览里的显卡行（分屏稿 14.4）：用量一栏的盒子在不在外层的可见区域里（有 overflow 的祖先把它裁掉就是“硬裁”）；
 * 内容放不下（scrollWidth > clientWidth）时要是省略号、title 是全文；这一行的其余各项也都在可见区域里。
 */
const GPU_CLIP = `(() => {
  const clipOf = (e) => { let l = -Infinity, r = Infinity; for (let p = e.parentElement; p; p = p.parentElement) { if (getComputedStyle(p).overflowX !== "visible") { const b = p.getBoundingClientRect(); l = Math.max(l, b.left); r = Math.min(r, b.right); } } return { l, r }; };
  const rows = [...document.querySelectorAll("[data-drawer] .gpu-list > dd")].map((dd) => {
    const u = dd.querySelector(".gpu-usage");
    const c = clipOf(dd);
    const ur = u.getBoundingClientRect();
    const cs = getComputedStyle(u);
    const usage = { text: u.textContent.trim(), title: u.title, w: Math.round(ur.width), sw: u.scrollWidth, cw: u.clientWidth, cut: u.scrollWidth > u.clientWidth + 0.5, ellipsis: cs.textOverflow === "ellipsis" && cs.overflowX === "hidden", inClip: ur.left >= c.l - 0.5 && ur.right <= c.r + 0.5, right: Math.round(ur.right), clip: Math.round(c.r) };
    // 一行的各项在 .gpu-line 里（分屏稿 15.2 第 1 条）
    const line = dd.querySelector(".gpu-line") ?? dd;
    const out = [...line.children].filter((k) => { const r = k.getBoundingClientRect(); return r.width > 0 && (r.left < c.l - 0.5 || r.right > c.r + 0.5); }).map((k) => (k.getAttribute("class") || k.tagName) + " " + Math.round(k.getBoundingClientRect().right) + ">" + Math.round(c.r));
    // 折行时“谁在用”靠右（右缘贴着这一栏的右缘），不掉到下一行左侧
    const who = dd.querySelector(".gpu-who").getBoundingClientRect(), meter = dd.querySelector(".meter").getBoundingClientRect(), ddr = dd.getBoundingClientRect();
    const wrapped = who.top > meter.bottom - 0.5;
    return { usage, out, dd: Math.round(ddr.width), wrapped, whoRight: Math.round(who.right), ddRight: Math.round(ddr.right) };
  });
  // 接入命令（15.2 第 4 条）：命令文字的范围（Range）不超过面板右缘，code 里也没有横向溢出
  const drawer = document.querySelector("[data-drawer]")?.getBoundingClientRect();
  const cmds = [...document.querySelectorAll("[data-drawer] .cmd-well > code")].map((code) => { const rg = document.createRange(); rg.selectNodeContents(code); const r = rg.getBoundingClientRect(); return { text: code.textContent, right: Math.round(r.right), drawer: Math.round(drawer?.right ?? 0), sw: code.scrollWidth, cw: code.clientWidth, out: !drawer || r.right > drawer.right + 0.5 || code.scrollWidth > code.clientWidth + 0.5 }; });
  return { rows, cmds, drawer: Math.round(drawer?.width ?? 0) };
})()`;
/**
 * 缺省宽度的面板里的显卡行（分屏稿 15.2 第 1 条，审查 U3-01）：每一行 .gpu-line 的高度不超过一行、各项竖直中心对齐（谁在用和用量同一行）、
 * 用量没有被截断；走势图（spark）在不在：none 没渲染、hidden 渲染了但这一栏放不下不显示、否则是它的宽度。scope：面板的选择器。
 */
const GPU_ROWS = (scope: string) => `(() => {
  const list = document.querySelector(${JSON.stringify(scope + " .gpu-list")});
  if (!list) return { lh: 0, rows: [] };
  const lh = parseFloat(getComputedStyle(list).lineHeight);
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), h: Math.round(r.height), cy: Math.round(r.top + r.height / 2) }; };
  const rows = [...list.querySelectorAll(":scope > dd")].map((dd) => {
    const line = dd.querySelector(".gpu-line"), u = dd.querySelector(".gpu-usage"), w = dd.querySelector(".gpu-who"), m = dd.querySelector(".meter"), s = dd.querySelector(".spark");
    const shown = [m, u, w, s].filter((e) => e && e.getBoundingClientRect().width > 0);
    const cys = shown.map((e) => box(e).cy);
    return { dd: Math.round(dd.getBoundingClientRect().width), h: line ? Math.round(line.getBoundingClientRect().height) : -1, usage: box(u), who: box(w), meterW: Math.round(m.getBoundingClientRect().width), spark: !s ? "none" : s.getBoundingClientRect().width > 0 ? Math.round(s.getBoundingClientRect().width) : "hidden", cut: u.scrollWidth > u.clientWidth + 0.5, spread: Math.max(...cys) - Math.min(...cys) };
  });
  return { lh, rows };
})()`;
async function splitSnap(name: string, expect?: string) {
  state = name;
  if (expect) check(`这一张该有的东西在：${expect}`, await js(`!!document.querySelector(${JSON.stringify(expect)})`));
  const r = await js(PANE_CHECKS);
  check("小窗标题栏：高 32、东西不出界、按钮不压标题；格间 1px", r && r.bad.length === 0, r);
  await snap(name);
}
async function paneMenu(id: string) {
  await js(`document.querySelector('.split-pane[data-pane="${id}"] .pane-bar').scrollIntoView(); 1`);
  await mclick(`.split-pane[data-pane="${id}"] .pane-bar button[aria-label="更多"]`);
  await waitFor(`document.querySelector(".menu-panel")`, 3000);
  await sleep(300);
}
/** 从侧栏拖 id 到 target 那一格的 (fx, fy) 处，停在上面不放（拍放置提示）。 */
async function dragOver(id: string, target: string, fx: number, fy: number) {
  await js(`(() => {
    window.__dt = new DataTransfer();
    document.querySelector('[data-session="${id}"] a').dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__dt }));
    const p = ${target === "single" ? `document.querySelector(".session .pane")` : `document.querySelector('.split-pane[data-pane="${target}"]')`};
    const r = p.getBoundingClientRect();
    p.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: r.left + r.width * ${fx}, clientY: r.top + r.height * ${fy} }));
    return 1;
  })()`);
  await sleep(300);
}
const dragEnd = () => js(`(() => { document.querySelectorAll(".split-pane, .session .pane").forEach((p) => p.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: document.body }))); window.dispatchEvent(new DragEvent("dragend")); return 1; })()`);

async function split() {
  await setSize(W, H);
  const two: Cell[] = [{ id: S.B, col: 1, row: 0 }];
  const three: Cell[] = [...two, { id: S.C, col: 0, row: 1 }];
  const four: Cell[] = [...three, { id: S.D, col: 1, row: 1 }];
  if (want("S01")) {
    await openSplit(S.B, two);
    await splitSnap("S01-split-2");
  }
  if (want("S02")) {
    await openSplit(S.C, three);
    await splitSnap("S02-split-3");
  }
  if (want("S03")) {
    await openSplit(S.A, four);
    await splitSnap("S03-split-4-focus");
    // 非焦点格悬停：标题栏按钮出现
    const bar = await js(`(() => { const r = document.querySelector('.split-pane[data-pane="${S.D}"] .pane-bar').getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + r.height / 2 }; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: bar.x, y: bar.y });
    await sleep(400);
    await splitSnap("S03-split-4-hover-nonfocus");
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  }
  if (want("S04")) {
    // 有新输出的点：给非焦点格推一段输出
    await openSplit(S.A, four);
    await sleep(1200);
    await fetch(`${API}/__dev/emit?session=${S.B}`, { method: "POST" });
    await waitFor(`document.querySelector('.split-pane[data-pane="${S.B}"] .status-dot[data-tone="new"]')`, 3000);
    // 分屏稿 12.6：“有新输出”是空心环，“运行中”是实心点，形态不同，不只靠颜色区分
    state = "S04-new-output";
    const dots = await js(`(() => { const st = (e) => e && { bg: getComputedStyle(e).backgroundColor, shadow: getComputedStyle(e).boxShadow, w: e.getBoundingClientRect().width }; return { neu: st(document.querySelector('.status-dot[data-tone="new"]')), live: st(document.querySelector('.split-pane .status-dot[data-tone="live"]')) }; })()`);
    const clear = (c: string) => /rgba\(.*,\s*0\)$/.test(c) || c === "transparent";
    check("有新输出的点是空心环（透明底、内描边），运行中的点是实心点", !!dots.neu && !!dots.live && clear(dots.neu.bg) && /inset/.test(dots.neu.shadow) && !clear(dots.live.bg) && dots.live.shadow === "none", dots);
    await splitSnap("S04-new-output", '.split-pane:not([data-focused]) .status-dot[data-tone="new"]');
  }
  if (want("S05")) {
    // 终端有焦点时用鼠标点“更多”：菜单面板不画焦点环（审查 U1-03，通用核对里查）
    await openSplit(S.B, four);
    await waitFor(`document.activeElement?.closest('.split-pane[data-pane="${S.B}"]')`, 3000);
    await paneMenu(S.B);
    await splitSnap("S05-more-menu", "[data-pane-menu]");
    await escape();
    // 键盘打开：第一项是键盘高亮（--fill-selected，比悬停深一级，审查 U1-15）
    await js(`document.querySelector('.split-pane[data-pane="${S.B}"] .pane-bar button[aria-label="更多"]').focus(); 1`);
    await key("ArrowDown", "ArrowDown", 40);
    await waitFor(`document.querySelector(".menu-panel .menu-row[data-highlighted]")`, 3000);
    await sleep(300);
    await splitSnap("S05-more-menu-keyboard", ".menu-panel .menu-row[data-highlighted]");
    await escape();
  }
  if (want("S06")) {
    // 单独查看
    await openSplit(S.B, four);
    await paneMenu(S.B);
    await mclick(".menu-panel .menu-row", "单独查看");
    await sleep(500);
    await splitSnap("S06-solo", "[data-restore]");
  }
  if (want("S07")) {
    // 窄窗（网格不到 900）：只显示焦点格，标题栏“分屏（N）”
    await setSize(1100, H);
    await openSplit(S.A, four);
    await splitSnap("S07-narrow", "[data-split-switch]");
    await mclick("[data-split-switch]");
    await waitFor(`document.querySelector(".menu-panel")`, 3000);
    await splitSnap("S07-narrow-switch", "[data-split-switch-menu]");
    await escape();
    await setSize(W, H);
  }
  if (want("S08")) {
    // 拖入提示：单会话页右侧、格子下半、网格已满时替换（先清掉上一张图留下的分屏布局）
    await reload();
    await js(`localStorage.removeItem("bunsen.split.v1"); localStorage.removeItem("bunsen.split.drawer"); 1`);
    await cdp("Page.navigate", { url: "about:blank" });
    await sleep(100);
    await cdp("Page.navigate", { url: `${BASE}/#/s/${S.A}` });
    await waitFor(`document.querySelector("[data-session-head]")`);
    await sleep(800);
    await dragOver(S.B, "single", 0.8, 0.3);
    await splitSnap("S08-drop-single-right", '[data-session-head] ~ .session-body [data-drop-hint="right"]');
    await dragEnd();
    await openSplit(S.A, two);
    await dragOver(S.C, S.A, 0.25, 0.85);
    await splitSnap("S08-drop-below", '.split-pane [data-drop-hint="below"]');
    await dragEnd();
    await openSplit(S.A, four);
    await dragOver(S.E, S.B, 0.7, 0.3);
    await splitSnap("S08-drop-replace", '.split-pane [data-drop-hint="replace"]');
    await dragEnd();
    // 列满（1440 宽 2 列）时拖到右格的右半：提示和落点一致，是“在 B 下面打开”（分屏稿 12.3）
    await openSplit(S.A, two);
    await dragOver(S.C, S.B, 0.8, 0.3);
    await splitSnap("S08-drop-full-columns", `.split-pane[data-pane="${S.B}"] [data-drop-hint="below"][data-side="below"][data-drop-of="${S.B}"]`);
    await dragEnd();
  }
  if (want("S13")) {
    // 分隔线获得键盘焦点：3px 强调色条（审查 U1-15）
    await openSplit(S.A, four);
    await key("Shift", "ShiftLeft", 16);
    await js(`document.querySelector('.split-handle[data-axis="col"]').focus(); 1`);
    await sleep(300);
    state = "S13-handle-focus";
    const h = await js(`(() => { const e = document.querySelector('.split-handle[data-axis="col"]'); const p = document.createElement("span"); p.style.color = "var(--accent)"; document.body.appendChild(p); const acc = getComputedStyle(p).color; p.remove(); const cs = getComputedStyle(e); return { fv: e.matches(":focus-visible"), w: e.getBoundingClientRect().width, bg: cs.backgroundColor, shadow: cs.boxShadow, acc }; })()`);
    check("分隔线键盘聚焦：1px 线加两侧各 1px，成为 3px 的强调色条", h.fv && h.w === 1 && h.bg === h.acc && h.shadow.includes(h.acc) && /0px 0px 0px 1px/.test(h.shadow), h);
    await splitSnap("S13-handle-focus");
  }
  if (want("S14")) {
    // 几格都已退出或已结束：只有焦点格的“接续”是主按钮，同屏最多一个 primary（分屏稿 12.8，通用核对里也查）
    await openSplit(S.G, [{ id: "w8e2yk", col: 1, row: 0 }, { id: S.G, col: 0, row: 1 }, { id: "d0x1zz", col: 1, row: 1 }]);
    state = "S14-exited-panes";
    const b = await js(`[...document.querySelectorAll(".split-pane")].map((p) => ({ id: p.dataset.pane, focused: p.hasAttribute("data-focused"), variants: [...p.querySelectorAll(".pane-body .button")].filter((x) => /接续|重新启动/.test(x.innerText)).map((x) => x.dataset.variant) }))`);
    const ok = b.filter((p: any) => p.variants.length > 0).length >= 2 && b.every((p: any) => p.variants.every((v: string) => v === (p.focused ? "primary" : "secondary")));
    check("分屏里已退出、已结束的格子：只有焦点格的“接续”是主按钮", ok, b);
    await splitSnap("S14-exited-panes");
  }
  if (want("S09")) {
    // 共享面板：1440 开着时网格不到 900，收起成焦点格；2560 开着时网格照常
    await openSplit(S.A, four, { open: true, size: 32 });
    await splitSnap("S09-drawer-1440", ".split:has([data-drawer]) [data-split-switch]");
  }
  if (want("S15")) {
    // 窄面板里的显卡用量（分屏稿 14.4，审查 U2-04）：860 宽、3 格、面板开着停在“概览”。用量一栏放不下时收缩、省略号，不硬裁
    await setSize(860, H);
    await openSplit(S.A, three, { open: true, size: 32 }, { "bunsen.tab": "overview" });
    await waitFor(`document.querySelectorAll("[data-drawer] .gpu-list .gpu-usage").length > 0`, 8000);
    await sleep(400);
    state = "S15-drawer-860-split3";
    const g = await js(GPU_CLIP);
    check("窄面板的显卡区有用量一栏（这张图核对的前提）", g.rows.length > 0, g);
    check("窄面板的显卡用量：没有被外层硬裁（盒子在可见区域里）", g.rows.length > 0 && g.rows.every((r: any) => r.usage.inClip), g.rows.map((r: any) => r.usage));
    check("窄面板的显卡用量：放不下时是省略号，悬停 title 是全文", g.rows.length > 0 && g.rows.every((r: any) => !r.usage.cut || (r.usage.ellipsis && r.usage.title === r.usage.text)), g.rows.map((r: any) => r.usage));
    check("窄面板的显卡用量：至少露出一截（不是被挤成 0 宽）", g.rows.length > 0 && g.rows.every((r: any) => r.usage.cw >= Math.min(r.usage.sw, 40)), g.rows.map((r: any) => r.usage));
    check("窄面板的显卡行：每一项都在可见区域里（不被挤出去）", g.rows.length > 0 && g.rows.every((r: any) => r.out.length === 0), g.rows.map((r: any) => r.out));
    // 分屏稿 15.2 第 1 条（审查 U3-01）：这一栏很窄才折行，折行时“谁在用”靠右
    check("窄面板的显卡行：这一栏很窄（约 200px 以内）时折行，“谁在用”靠右（右缘贴着这一栏的右缘）", g.rows.length > 0 && g.rows.every((r: any) => r.dd <= 200 && r.wrapped && Math.abs(r.whoRight - r.ddRight) <= 1), g.rows.map((r: any) => ({ dd: r.dd, wrapped: r.wrapped, who: r.whoRight, dd_r: r.ddRight })));
    // 分屏稿 15.2 第 4 条（审查 U3-06）：接入命令里的 dev@atlas.lab.example 断不开时也不撑出面板
    check("窄面板的接入命令：没有超出面板右缘（命令文字在面板里折行，code 里没有横向溢出）", g.cmds.length === 2 && g.cmds.every((c: any) => !c.out), g.cmds);
    await splitSnap("S15-drawer-860-split3", "[data-drawer] .gpu-usage");
    await setSize(W, H);
  }
  if (want("S16")) {
    // 缺省宽度的面板里的显卡行（分屏稿 15.2 第 1 条，审查 U3-01）：1280、1440、2560 宽，单会话页和分屏各一张，面板停在“概览”。
    // 刚打开时每块显卡只有 1 个利用率读数：走势图没有数据，不渲染（不占位）。点一次“刷新”有了 2 个读数再量：每块显卡一行
    // （行高没有翻倍）、谁在用和用量同一行、用量没有被截断；走势图这一栏放得下时显示，放不下时不显示
    for (const w of [1280, 1440, 2560]) {
      const h = w >= 2560 ? 1440 : H;
      for (const where of ["split", "single"] as const) {
        await setSize(w, h);
        const scope = where === "split" ? "[data-drawer]" : ".session-body > .workspace";
        if (where === "split") await openSplit(S.A, two, { open: true, size: 32 }, { "bunsen.tab": "overview" });
        else {
          await reload();
          await js(`localStorage.removeItem("bunsen.split.v1"); localStorage.removeItem("bunsen.split.drawer"); localStorage.setItem("bunsen.tab", '"overview"'); localStorage.setItem("bunsen.side", "true"); localStorage.removeItem("react-resizable-panels:bunsen.session.split"); 1`);
          await cdp("Page.navigate", { url: "about:blank" });
          await sleep(100);
          await cdp("Page.navigate", { url: `${BASE}/#/s/${S.A}` });
          await waitFor(`document.querySelector("[data-session-head]")`, 8000);
        }
        const name = `S16-gpu-${w}-${where}`;
        state = name;
        const ready = await waitFor(`document.querySelectorAll(${JSON.stringify(scope + " .gpu-list .gpu-usage")}).length > 0`, 8000);
        await sleep(400);
        const g0 = await js(GPU_ROWS(scope));
        check("（前提）面板停在“概览”，显卡区有 4 行", ready && g0.rows.length === 4, g0);
        check("走势图没有数据（刚打开，只有 1 个读数）时不渲染，不占位", g0.rows.length > 0 && g0.rows.every((r: any) => r.spark === "none"), g0.rows.map((r: any) => r.spark));
        // 刷新一次：每块显卡有 2 个读数，走势图有数据
        await js(`[...document.querySelectorAll(${JSON.stringify(scope + " .section")})].find((s) => s.innerText.startsWith("显卡"))?.querySelector("button")?.click(); 1`);
        await waitFor(`document.querySelectorAll(${JSON.stringify(scope + " .gpu-list .spark")}).length === 4`, 6000);
        await sleep(300);
        const g = await js(GPU_ROWS(scope));
        const one = (r: any) => r.h > 0 && r.h <= g.lh && r.spread <= 2;
        check(`（前提）刷新后每块显卡都有走势数据（这一栏宽 ${g.rows[0]?.dd ?? "?"}px）`, g.rows.length === 4 && g.rows.every((r: any) => r.spark !== "none"), g.rows.map((r: any) => r.spark));
        check("每块显卡一行：行高不超过一行（没有翻倍），各项竖直对齐", g.rows.length === 4 && g.rows.every(one), g.rows.map((r: any) => ({ dd: r.dd, h: r.h, lh: g.lh, spread: r.spread })));
        check("“谁在用”和用量在同一行", g.rows.length === 4 && g.rows.every((r: any) => Math.abs(r.who.cy - r.usage.cy) <= 1 && r.who.l >= r.usage.r), g.rows.map((r: any) => ({ who: r.who, usage: r.usage })));
        check("用量没有被截断（不是省略号）", g.rows.length === 4 && g.rows.every((r: any) => !r.cut), g.rows.map((r: any) => ({ cut: r.cut, w: r.usage })));
        check("走势图：这一栏放得下（280px 以上）时显示、在同一行，放不下时不显示（不把用量挤成省略号）", g.rows.length === 4 && g.rows.every((r: any) => (r.dd > 280 ? typeof r.spark === "number" : r.spark === "hidden")), g.rows.map((r: any) => ({ dd: r.dd, spark: r.spark })));
        await (where === "split" ? splitSnap(name, `${scope} .gpu-line`) : snap(name));
      }
    }
    // 服务器页的服务器卡片用同一个 GpuTable（没有走势）：1440 宽同样每块显卡一行
    await setSize(W, H);
    await reload("/servers");
    state = "S16-gpu-1440-servers";
    const ready = await waitFor(`document.querySelectorAll(".page .gpu-list .gpu-usage").length > 0`, 8000);
    const gs = await js(GPU_ROWS(".page"));
    check("服务器页的显卡（同一个 GpuTable）：每块显卡一行、谁在用和用量同一行、用量没有被截断、没有走势", ready && gs.rows.length > 0 && gs.rows.every((r: any) => r.h > 0 && r.h <= gs.lh && r.spread <= 2 && Math.abs(r.who.cy - r.usage.cy) <= 1 && !r.cut && r.spark === "none"), gs);
    await snap("S16-gpu-1440-servers");
  }
  await setSize(2560, 1440);
  const six: Cell[] = [
    { id: S.B, col: 1, row: 0 },
    { id: S.C, col: 2, row: 0 },
    { id: S.D, col: 0, row: 1 },
    { id: S.E, col: 1, row: 1 },
    { id: S.F, col: 2, row: 1 },
  ];
  if (want("S10")) {
    await openSplit(S.A, six.slice(0, 2));
    await splitSnap("S10-split-3-cols-2560");
    await openSplit(S.E, six);
    await splitSnap("S10-split-6-2560");
  }
  if (want("S11")) {
    await openSplit(S.A, four, { open: false, size: 32 });
    await splitSnap("S11-drawer-closed-2560");
    await openSplit(S.A, four, { open: true, size: 32 });
    await splitSnap("S11-drawer-open-2560", "[data-drawer]");
  }
  await setSize(W, H);
  if (want("S12")) {
    // 欢迎页工具栏：长工作目录、选了项目，1280 和 1440
    for (const w of [1280, 1440]) {
      await setSize(w, H);
      await reload();
      await waitFor(`document.querySelector('button[aria-label="部署并开始"]')`);
      await mclick('button[aria-label="选择服务器"]');
      await mclick('[role="option"]', "atlas");
      await mclick('button[aria-label="不接入项目"]');
      await mclick('[role="option"]', "长尾分类的标签平滑");
      await setInput('input[aria-label="工作目录"]', "~/work/longtail-classification/experiments/2026-11-ablation-runs");
      await js(`document.activeElement?.blur(); 1`);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
      await sleep(600);
      await snap(`S12-welcome-${w}`);
    }
    await setSize(W, H);
  }
  await js(`localStorage.removeItem("bunsen.split.v1"); localStorage.removeItem("bunsen.split.drawer"); 1`);
}

async function audit() {
  await cdp("Log.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  // 无头 Chrome 没有剪贴板权限；__mutate 按地址改服务端回的 JSON（造 ErrorBoundary）
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__mutate = null;
      try { Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true }); } catch {}
      const __f = window.fetch.bind(window);
      window.fetch = async (...a) => {
        const r = await __f(...a);
        const u = String(a[0]);
        const mut = window.__mutate && Object.entries(window.__mutate).find(([k]) => u.includes(k));
        if (mut && r.ok) { const j = await r.clone().json(); return new Response(JSON.stringify(mut[1](j)), { status: r.status, headers: r.headers }); }
        return r;
      };`,
  });
  for (const t of THEMES) {
    await setTheme(t);
    if (SPLIT) {
      await split();
      continue;
    }
    await boot();
    await welcome();
    await pages();
    await session();
    await extras();
  }
}

try {
  mkdirSync(OUT, { recursive: true });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  if (AUDIT) await audit();
  else await readme();
} finally {
  if (AUDIT) {
    // 主题恢复成深色
    try {
      const s = await (await fetch(`${BASE}/api/settings`, { headers: { "x-bunsen-token": "dev" } })).json();
      await fetch(`${BASE}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", "x-bunsen-token": "dev" }, body: JSON.stringify({ ...(s as object), theme: "dark" }) });
    } catch {}
    const failed = checks.filter((c) => !c.ok);
    writeFileSync(join(OUT, "checks.json"), JSON.stringify({ checks, consoleIssues }, null, 2));
    console.log(`\n核对 ${checks.length} 项，失败 ${failed.length} 项；控制台错误与警告 ${consoleIssues.length} 条`);
    for (const c of consoleIssues) console.log(`  ${c}`);
  }
  ws.close();
  chrome.kill();
  await chrome.exited;
  rmSync(profile, { recursive: true, force: true });
}
