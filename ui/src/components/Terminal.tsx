import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { RotateCw } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { termUrl, type TermTarget } from "../lib/api";
import { isSplitKey } from "../lib/splitStore";
import { Button, ICON } from "./ui";

export type TermHandle = { focus: () => void; reconnect: () => void };
type Conn = "connecting" | "connected" | "closed";

/**
 * 拖分屏分隔线时暂停终端的 fit：只改 CSS 变量，松手后各终端 fit 一次（分屏稿第 7 节）。
 * 拖动开始 holdTermFit(true)，松手 holdTermFit(false)。
 */
const FIT_EVENT = "bunsen:term-fit";
export function holdTermFit(on: boolean) {
  const root = document.documentElement;
  if (on) root.setAttribute("data-resizing", "");
  else if (root.hasAttribute("data-resizing")) {
    root.removeAttribute("data-resizing");
    window.dispatchEvent(new Event(FIT_EVENT));
  }
}
/** 连上、改尺寸之后 tmux 会整屏重画：这段时间里的输出不算“新输出”。 */
const QUIET_CONNECT_MS = 1000;
const QUIET_RESIZE_MS = 600;

const DARK: ITheme = {
  black: "#2b2b2b", red: "#ff7b72", green: "#3fb950", yellow: "#d29922", blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#c9c9c9",
  brightBlack: "#6e6e6e", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f5f5f5",
};
const LIGHT: ITheme = {
  black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00", blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
};

function readTheme(): ITheme {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const light = root.dataset.theme === "light";
  return {
    ...(light ? LIGHT : DARK),
    background: v("--term-bg"),
    foreground: v("--term-fg"),
    cursor: v("--accent"),
    cursorAccent: v("--term-bg"),
    selectionBackground: v("--term-sel"),
  };
}

/**
 * 终端连上时要不要拿键盘焦点（分屏稿 15.1）。终端分两种：代理终端（单会话页的主终端、分屏每格的终端）和面板终端（面板“终端”页的 shell）。
 * - true：这个终端第一次连上时拿，之后的每次连上按 "polite"。只给单会话页的代理终端（第 1 条）和对话框里的终端。
 * - "polite"：键盘焦点本来就在这个终端里、在它所在的那一格（分屏的小窗；单会话页是会话主区）里、或落在 body 上无处可去时才拿（第 2 条）。
 *   那一格里的输入条不算：用户正在输入条里打字时，终端重连不把焦点拉走（场景表“焦点在输入条里，断线重连，仍在输入条”）。
 * - false、不给：不拿。分屏的非焦点格（第 1、2 条）；面板终端（第 3 条，只有用户点“终端”标签时由面板调 focus()）。
 * 按这一次连接开始时给的值判断（分屏里焦点格会变：变了以后的下一次连接按新值）。
 */
export type AutoFocus = boolean | "polite";
/** 终端所在的那一格：分屏的小窗；单会话页是会话主区（左边那一栏）。 */
const SCOPE = ".split-pane, .session-body > .pane";
const politeFocus = (root: HTMLElement | null) => {
  const a = document.activeElement;
  if (!a || a === document.body || Boolean(root?.contains(a))) return true;
  const scope = root?.closest(SCOPE);
  return Boolean(scope?.contains(a)) && !a.closest(".message-bar");
};

/**
 * 代理终端会重挂（会话从“连不上”恢复、点“接续”“从头开始”之后；分屏稿 15.1 第 2 条）：true 只给页面打开时就挂着的那一个终端，
 * 之后同一处再挂上的都给 "polite"。页面打开时没挂着终端（已结束、连不上）的，之后第一次挂上也算“之后的连上”。
 * "polite"、false 原样传下去。shown：终端此刻挂着没有。
 */
export function useTermFocus(autoFocus: AutoFocus, shown: boolean): AutoFocus {
  // 还在页面打开时的第一次渲染里（这时挂上的终端才算“第一次”）
  const opening = useRef(shown);
  useEffect(() => {
    opening.current = false;
  }, []);
  return autoFocus === true && !opening.current ? "polite" : autoFocus;
}

/**
 * 一个接到 /ws/term 的终端。断开只是本机这头断了，服务器上的 tmux 会话还在，
 * 所以“重新连接”总是安全的。
 */
export const TerminalView = forwardRef<TermHandle, { target: TermTarget; autoFocus?: AutoFocus; onConn?: (c: Conn) => void; onOutput?: () => void }>(
  function TerminalView({ target, autoFocus, onConn, onOutput }, ref) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const hostRef = useRef<HTMLDivElement | null>(null);
    // 连上过没有：autoFocus 为 true 时只有第一次连上直接拿键盘焦点，之后的重连按 "polite"（15.1 第 1、2 条）
    const connectedOnce = useRef(false);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const [conn, setConn] = useState<Conn>("connecting");
    const [detail, setDetail] = useState<string | null>(null);
    const [epoch, setEpoch] = useState(0);
    const targetKey = JSON.stringify(target);
    const onConnRef = useRef(onConn);
    onConnRef.current = onConn;
    // 有新输出时告诉分屏的小窗（“有新输出”的点）；连上、改尺寸后的整屏重画不算
    const onOutputRef = useRef(onOutput);
    onOutputRef.current = onOutput;
    const quietRef = useRef(0);

    useImperativeHandle(ref, () => ({
      focus: () => termRef.current?.focus(),
      reconnect: () => setEpoch((n) => n + 1),
    }));

    // 终端本体只建一次。
    useEffect(() => {
      const host = hostRef.current!;
      const term = new Terminal({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
        fontSize: 13,
        lineHeight: 1.3,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 8000,
        macOptionIsMeta: true,
        allowTransparency: false,
        theme: readTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;

      const safeFit = () => {
        if (host.clientWidth < 40 || host.clientHeight < 20) return; // 藏在别的标签页后面时不量
        try {
          fit.fit();
        } catch {
          /* 还没布局好 */
        }
      };
      safeFit();

      let raf = 0;
      let held = false;
      const ro = new ResizeObserver(() => {
        // 拖分屏分隔线时先不 fit，松手后 fit 一次
        if (document.documentElement.hasAttribute("data-resizing")) {
          held = true;
          return;
        }
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(safeFit);
      });
      ro.observe(host);
      const onRelease = () => {
        if (!held) return;
        held = false;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(safeFit);
      };
      window.addEventListener(FIT_EVENT, onRelease);
      // 分屏快捷键（Ctrl+Mod+…）在终端聚焦时也要能用：截下来不送进终端，交给分屏（App 在 window 上处理）
      term.attachCustomKeyEventHandler((e) => !isSplitKey(e));

      const mo = new MutationObserver(() => {
        term.options.theme = readTheme();
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      const subData = term.onData((data) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
      });
      const subSize = term.onResize(({ cols, rows }) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          quietRef.current = Math.max(quietRef.current, Date.now() + QUIET_RESIZE_MS);
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      return () => {
        cancelAnimationFrame(raf);
        window.removeEventListener(FIT_EVENT, onRelease);
        ro.disconnect();
        mo.disconnect();
        subData.dispose();
        subSize.dispose();
        // xterm 打开时排了一个 0ms 的定时器去同步滚动区；刚打开就卸下（分屏里格子刚挂上就收起）时等它跑完再销毁，免得它读到已销毁的渲染器
        window.setTimeout(() => term.dispose(), 0);
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    // 连接；目标变了或点了“重新连接”就重来。
    useEffect(() => {
      const term = termRef.current;
      if (!term) return;
      let alive = true;
      let retry = 0;
      let openedAt = 0;
      const update = (c: Conn, d: string | null) => {
        if (!alive) return;
        setConn(c);
        setDetail(d);
        onConnRef.current?.(c);
      };

      term.reset();
      quietRef.current = Number.MAX_SAFE_INTEGER; // 连上之前（含连上时的整屏重画）都不算新输出
      update("connecting", null);
      const ws = new WebSocket(termUrl(JSON.parse(targetKey) as TermTarget, term.cols, term.rows));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      let serverClosed = false;

      ws.onopen = () => {
        openedAt = Date.now();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
          if (Date.now() > quietRef.current) onOutputRef.current?.();
          return;
        }
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type !== "status") return;
          if (msg.state === "connected") {
            quietRef.current = Date.now() + QUIET_CONNECT_MS;
            update("connected", null);
            // 连上后按当前尺寸再对一次，免得远端还是旧尺寸。
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            const first = !connectedOnce.current;
            connectedOnce.current = true;
            if ((autoFocus === true && first) || (autoFocus && politeFocus(rootRef.current))) term.focus();
          } else if (msg.state === "closed") {
            serverClosed = true;
            update("closed", msg.detail ?? null);
          } else update("connecting", msg.detail ?? null);
        } catch {
          /* 不认识的文本帧，忽略 */
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        if (!serverClosed) {
          // 连了一阵才断的多半是网络抖动，自动再试一次。
          if (openedAt && Date.now() - openedAt > 8000) {
            retry = window.setTimeout(() => alive && setEpoch((n) => n + 1), 1500);
            update("connecting", "连接断了，正在重连…");
          } else update("closed", "连接已断开");
        }
      };

      return () => {
        alive = false;
        window.clearTimeout(retry);
        ws.onclose = null;
        ws.onmessage = null;
        ws.close();
        if (wsRef.current === ws) wsRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetKey, epoch]);

    return (
      <div className="term" ref={rootRef}>
        <div className="term-host" ref={hostRef} />
        {conn !== "connected" && (
          <div className="term-overlay">
            {conn === "connecting" ? (
              <div className="term-note shimmer">{detail ?? "正在连接…"}</div>
            ) : (
              <div className="term-note">
                <div>{detail ?? "连接已断开"}</div>
                {/* 用户自己点了这个终端的“重新连接”：先把键盘焦点放进终端（按钮马上换成“正在连接…”，焦点不会掉到 body；面板终端连上时不自己拿，15.1 第 3 条） */}
                <Button
                  size="sm"
                  icon={<RotateCw size={ICON.sm} />}
                  onClick={() => {
                    termRef.current?.focus();
                    setEpoch((n) => n + 1);
                  }}
                >
                  重新连接
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  },
);
