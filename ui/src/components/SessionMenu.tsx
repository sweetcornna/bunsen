import { Archive, ArchiveRestore, Columns2, Copy, Pencil, Pin, PinOff, Square, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { api, type Session } from "../lib/api";
import { copyText } from "../lib/format";
import { go } from "../lib/route";
import { openInSplit } from "../lib/splitStore";
import { useApp } from "../lib/store";
import { Button, Confirm, Dialog, Field, ICON, Menu, type MenuItem } from "./ui";

/**
 * 会话的“更多”菜单：侧栏和会话页头共用。split：侧栏用，最前面加“在分屏中打开”。
 * open/onOpenChange：受控打开（侧栏右键）。
 */
export function SessionMenu({
  session,
  children,
  onGone,
  split,
  open,
  onOpenChange,
}: {
  session: Session;
  children: ReactNode;
  onGone?: () => void;
  split?: boolean;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const { items, dialogs } = useSessionMenu(session, onGone);
  // 选了“在分屏中打开”：菜单关掉时不把焦点还给侧栏，键盘焦点交给新开的那一格
  const opened = useRef(false);
  const toSplit: MenuItem = {
    label: "在分屏中打开",
    icon: <Columns2 size={ICON.md} />,
    onSelect: () => {
      opened.current = true;
      openInSplit(session.id);
    },
  };
  return (
    <>
      <Menu
        trigger={children}
        open={open}
        onOpenChange={onOpenChange}
        items={split ? [toSplit, "sep", ...items] : items}
        onCloseAutoFocus={(e) => {
          if (opened.current) e.preventDefault();
          opened.current = false;
        }}
      />
      {dialogs}
    </>
  );
}

/** 会话菜单的条目和它们的对话框（重命名、结束、删除）：分屏小窗的“更多”菜单复用这些条目。 */
export function useSessionMenu(session: Session, onGone?: () => void): { items: MenuItem[]; dialogs: ReactNode } {
  const setSession = useApp((s) => s.setSession);
  const dropSession = useApp((s) => s.dropSession);
  const toast = useApp((s) => s.toast);
  const fail = useApp((s) => s.fail);
  const [dlg, setDlg] = useState<null | "rename" | "stop" | "delete">(null);
  const [title, setTitle] = useState(session.title);
  const live = session.state === "running" || session.state === "exited";

  const patch = (p: { title?: string; pinned?: boolean; archived?: boolean }) =>
    api.patchSession(session.id, p).then(setSession).catch(fail);

  const items: MenuItem[] = [
    { label: session.pinned ? "取消置顶" : "置顶", icon: session.pinned ? <PinOff size={ICON.md} /> : <Pin size={ICON.md} />, onSelect: () => void patch({ pinned: !session.pinned }) },
    {
      label: "重命名",
      icon: <Pencil size={ICON.md} />,
      onSelect: () => {
        setTitle(session.title);
        setDlg("rename");
      },
    },
    {
      label: "复制接入命令",
      icon: <Copy size={ICON.md} />,
      onSelect: () => void copyText(session.attach_cmd).then((ok) => toast(ok ? "ok" : "err", ok ? "已复制" : "复制失败")),
    },
    {
      label: session.archived ? "取消归档" : "归档",
      icon: session.archived ? <ArchiveRestore size={ICON.md} /> : <Archive size={ICON.md} />,
      onSelect: () => void patch({ archived: !session.archived }),
    },
    "sep",
    { label: "结束会话", icon: <Square size={ICON.md} />, disabled: !live, danger: true, onSelect: () => setDlg("stop") },
    { label: "删除记录", icon: <Trash2 size={ICON.md} />, danger: true, onSelect: () => setDlg("delete") },
  ];

  const dialogs = (
    <>
      <Dialog
        open={dlg === "rename"}
        onOpenChange={(v) => !v && setDlg(null)}
        title="重命名"
        size="sm"
        footer={
          <>
            <Button variant="ghost" data-dialog-cancel="" onClick={() => setDlg(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!title.trim()}
              onClick={() => {
                setDlg(null);
                void patch({ title: title.trim() });
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <Field label="标题">
          <input
            className="input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim()) {
                setDlg(null);
                void patch({ title: title.trim() });
              }
            }}
          />
        </Field>
      </Dialog>

      <Confirm
        open={dlg === "stop"}
        onOpenChange={(v) => !v && setDlg(null)}
        title="结束这个会话？"
        body={
          <>
            结束 <b>{session.server_alias}</b> 上的 <code>{session.tmux}</code>。之后可以重新启动。
          </>
        }
        confirmLabel="结束会话"
        danger
        onConfirm={() => void api.stop(session.id).then(setSession).catch(fail)}
      />

      <Confirm
        open={dlg === "delete"}
        onOpenChange={(v) => !v && setDlg(null)}
        title="删除这条记录？"
        body={
          live ? (
            <>
              会话还在 <b>{session.server_alias}</b> 上运行，会先结束它。工作目录不受影响。
            </>
          ) : (
            <>只删除本机记录。</>
          )
        }
        confirmLabel={live ? "结束并删除" : "删除"}
        danger
        onConfirm={() =>
          void api
            .deleteSession(session.id, live)
            .then(() => {
              dropSession(session.id);
              onGone ? onGone() : window.location.hash === `#/s/${session.id}` && go("/");
            })
            .catch(fail)
        }
      />
    </>
  );
  return { items, dialogs };
}
