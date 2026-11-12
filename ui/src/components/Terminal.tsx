import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { RotateCw } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { termUrl, type TermTarget } from "../lib/api";
import { Button } from "./ui";

export type TermHandle = { focus: () => void; reconnect: () => void };
type Conn = "connecting" | "connected" | "closed";

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
    selectionBackground: light ? "rgba(47,116,245,0.22)" : "rgba(79,140,255,0.32)",
  };
}

/**
 * 一个接到 /ws/term 的终端。断开只是本机这头断了，服务器上的 tmux 会话还在，
 * 所以“重新连接”总是安全的。
 */
export const TerminalView = forwardRef<TermHandle, { target: TermTarget; autoFocus?: boolean; onConn?: (c: Conn) => void }>(
  function TerminalView({ target, autoFocus, onConn }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const [conn, setConn] = useState<Conn>("connecting");
    const [detail, setDetail] = useState<string | null>(null);
    const [epoch, setEpoch] = useState(0);
    const targetKey = JSON.stringify(target);
    const onConnRef = useRef(onConn);
    onConnRef.current = onConn;

    useImperativeHandle(ref, () => ({
      focus: () => termRef.current?.focus(),
      reconnect: () => setEpoch((n) => n + 1),
    }));

    // 终端本体只建一次。
    useEffect(() => {
      const host = hostRef.current!;
      const term = new Terminal({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
        fontSize: 12.5,
        lineHeight: 1.25,
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
      const ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(safeFit);
      });
      ro.observe(host);

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
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
      });

      return () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        mo.disconnect();
        subData.dispose();
        subSize.dispose();
        term.dispose();
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
          return;
        }
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type !== "status") return;
          if (msg.state === "connected") {
            update("connected", null);
            // 连上后按当前尺寸再对一次，免得远端还是旧尺寸。
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
            if (autoFocus) term.focus();
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
      <div className="term">
        <div className="term-host" ref={hostRef} />
        {conn !== "connected" && (
          <div className="term-overlay">
            {conn === "connecting" ? (
              <div className="term-note live">{detail ?? "正在连接…"}</div>
            ) : (
              <div className="term-note col">
                <div>{detail ?? "连接已断开"}</div>
                <Button size="sm" icon={<RotateCw size={12} />} onClick={() => setEpoch((n) => n + 1)}>
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
