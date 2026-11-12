import { Archive, ArchiveRestore, Copy, Pencil, Pin, PinOff, Square, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, type Session } from "../lib/api";
import { copyText } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";
import { Button, Confirm, Field, Menu, Modal } from "./ui";

/** 会话的“更多”菜单：侧栏和会话页头共用。 */
export function SessionMenu({ session, children, onGone }: { session: Session; children: ReactNode; onGone?: () => void }) {
  const setSession = useApp((s) => s.setSession);
  const dropSession = useApp((s) => s.dropSession);
  const toast = useApp((s) => s.toast);
  const fail = useApp((s) => s.fail);
  const [dlg, setDlg] = useState<null | "rename" | "stop" | "delete">(null);
  const [title, setTitle] = useState(session.title);
  const live = session.state === "running" || session.state === "exited";

  const patch = (p: { title?: string; pinned?: boolean; archived?: boolean }) =>
    api.patchSession(session.id, p).then(setSession).catch(fail);

  return (
    <>
      <Menu
        trigger={children}
        items={[
          { label: session.pinned ? "取消置顶" : "置顶", icon: session.pinned ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => void patch({ pinned: !session.pinned }) },
          {
            label: "重命名",
            icon: <Pencil size={14} />,
            onSelect: () => {
              setTitle(session.title);
              setDlg("rename");
            },
          },
          {
            label: "复制接入命令",
            icon: <Copy size={14} />,
            onSelect: () => void copyText(session.attach_cmd).then((ok) => toast(ok ? "ok" : "err", ok ? "已复制" : "复制失败")),
          },
          {
            label: session.archived ? "取消归档" : "归档",
            icon: session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />,
            onSelect: () => void patch({ archived: !session.archived }),
          },
          "sep",
          { label: "结束会话", icon: <Square size={14} />, disabled: !live, danger: true, onSelect: () => setDlg("stop") },
          { label: "删除记录", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDlg("delete") },
        ]}
      />

      <Modal
        open={dlg === "rename"}
        onOpenChange={(v) => !v && setDlg(null)}
        title="重命名"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDlg(null)}>
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
            className="field"
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
      </Modal>

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
}
