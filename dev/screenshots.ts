// 生成 README 用的截图：用本机的 Chrome（无界面）打开演示后端，逐页截图到 docs/images/。
//   PORT=7980 bun dev/mock-server.ts      （另开一个终端）
//   bun dev/screenshots.ts
// 环境变量：BASE（默认 http://localhost:7980）、CHROME（Chrome 可执行文件路径）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:7980";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = join(import.meta.dir, "..", "docs", "images");
const PORT = 9334;
const W = 1440;
const H = 900;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "outpost-shots-"));
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
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)!(m.result ?? m.error);
    waiting.delete(m.id);
  }
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
  await js(`localStorage.setItem("outpost.theme", JSON.stringify("${theme}")); location.hash = ${JSON.stringify(hash)}; 1`);
  await sleep(300);
  await js(`document.documentElement.dataset.theme = "${theme}"; 1`);
  await sleep(1500);
}
/** 点一个文字完全匹配的按钮（可限定在某个容器里）。 */
const click = (text: string, within = "body") =>
  js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(within)} + " button, " + ${JSON.stringify(within)} + " [role=tab]")].find((b) => b.textContent.trim().replace(/\\s+/g, " ").startsWith(${JSON.stringify(text)})); if (el) el.click(); return !!el; })()`);
async function shot(name: string) {
  await sleep(500);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
  console.log("  ", name);
}

try {
  mkdirSync(OUT, { recursive: true });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

  const sessions = (await (await fetch(`${BASE}/api/sessions`, { headers: { "x-outpost-token": "dev" } })).json()) as { id: string; state: string }[];
  const sid = (sessions.find((s) => s.state === "running") ?? sessions[0]).id;

  await open("/");
  await shot("welcome.png");

  await open(`/s/${sid}`);
  await click("产物", ".tabs");
  await sleep(1200);
  await shot("session.png");

  await click("科研", ".tabs");
  await sleep(800);
  await click("结论", ".panel");
  await shot("research.png");

  await click("概览", ".tabs");
  await sleep(800);
  await shot("overview.png");

  await open("/servers");
  await shot("servers.png");

  await open(`/s/${sid}`, "light");
  await click("科研", ".tabs");
  await sleep(600);
  await click("运行", ".panel");
  await shot("light.png");
} finally {
  ws.close();
  chrome.kill();
  await chrome.exited;
  rmSync(profile, { recursive: true, force: true });
}
