// 把侧栏的会话拖进会话页：放下的那一侧决定开在右边还是下面（.orchestra/design-split-view.md 第 5 节）。
// 单会话页的左栏和分屏的每一格都是放置目标；拖到上面时显示放置提示（强调色：拖放目标，统一稿 1.5）。
// 提示的文字和高亮区域、松手后的落点出自同一个纯函数（split.ts 的 planOpen，分屏稿 12.3；放下的那一格不在底里时也一样，13.8）。
import { useEffect, useState, type DragEvent } from "react";
import type { DropHint, Where } from "../lib/split";
import { draggingSession, dropHint, openInSplit, SESSION_MIME } from "../lib/splitStore";
import { useApp } from "../lib/store";

const isSessionDrag = (e: DragEvent) => draggingSession() !== null || [...e.dataTransfer.types].includes(SESSION_MIME);

/** 放下的那一侧：离下边比离右边近就是下面，否则是右边。 */
function sideOf(e: DragEvent): Where {
  const r = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - r.left) / Math.max(1, r.width);
  const y = (e.clientY - r.top) / Math.max(1, r.height);
  return y > x ? "below" : "right";
}

function hintText(h: DropHint, title: (id: string) => string): string {
  if (h.kind === "focus") return "已在分屏中";
  if (h.kind === "replace") return `替换 ${title(h.of)}`;
  // 没有可用的分屏布局：松手就是直接打开它（从别的窗口拖进来时拖动中读不到是哪个会话）
  if (h.kind === "open") return h.of ? `打开 ${title(h.of)}` : "在这里打开";
  return `在 ${title(h.of)} ${h.kind === "right" ? "右边" : "下面"}打开`;
}

export function useSessionDrop(target: string) {
  const [side, setSide] = useState<Where | null>(null);
  const sessions = useApp((s) => s.sessions);
  // 拖动结束（含取消、拖到窗口外、源行被卸下）、窗口失焦时复位：dragleave 不一定会来
  useEffect(() => {
    if (!side) return;
    const reset = () => setSide(null);
    window.addEventListener("dragend", reset, true);
    window.addEventListener("drop", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragend", reset, true);
      window.removeEventListener("drop", reset);
      window.removeEventListener("blur", reset);
    };
  }, [side]);
  const handlers = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!isSessionDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const s = sideOf(e);
      if (s !== side) setSide(s);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSide(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!isSessionDrag(e)) return;
      e.preventDefault();
      const id = e.dataTransfer.getData(SESSION_MIME) || draggingSession();
      const s = side ?? sideOf(e);
      setSide(null);
      if (id) openInSplit(id, s, target);
    },
  };
  // 从别的窗口拖进来时拖动中读不到会话 id：按“一个不在网格里的会话”算
  const h = side ? dropHint(draggingSession() ?? "", target, side) : null;
  const title = (id: string) => sessions.find((x) => x.id === id)?.title ?? id;
  const hint = h ? (
    <div className="split-drop" data-side={h.area} data-drop-hint={h.kind} data-drop-of={h.of} aria-hidden>
      <span>{hintText(h, title)}</span>
    </div>
  ) : null;
  return { handlers, hint };
}
