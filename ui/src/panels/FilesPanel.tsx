import { ArrowLeft, CornerLeftUp, File, Folder, Link2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { FilePreview, type Quoted } from "../components/Preview";
import { Empty, ICON, IconButton, Notice, Row, ScrollArea, Spinner, When } from "../components/ui";
import { api, asApiError, type FileEntry, type FileList, type Session } from "../lib/api";
import { bytes, joinPath } from "../lib/format";

export function FilesPanel({ session, active, onQuote }: { session: Session; active: boolean; onQuote: (q: Quoted) => void }) {
  const [list, setList] = useState<FileList | null>(null);
  const [open, setOpen] = useState<{ path: string; stamp: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        setList(await api.files(session.id, path));
        setErr(null);
      } catch (e) {
        setErr(asApiError(e).message);
      } finally {
        setLoading(false);
      }
    },
    [session.id],
  );

  useEffect(() => {
    if (active && !list && !loading && !err) void load("");
  }, [active, list, loading, err, load]);

  const pick = (e: FileEntry) => {
    if (!list) return;
    const path = joinPath(list.path, e.name);
    if (e.kind === "dir") void load(path);
    else setOpen({ path, stamp: e.mtime ?? "" });
  };

  if (open)
    return (
      <FilePreview
        sessionId={session.id}
        path={open.path}
        stamp={open.stamp}
        onQuote={onQuote}
        left={
          <IconButton label="返回" size="sm" data-back="" onClick={() => setOpen(null)}>
            <ArrowLeft size={ICON.sm} />
          </IconButton>
        }
      />
    );

  return (
    <div className="panel">
      <div className="panel-bar" data-back="">
        <IconButton label="上一级" size="sm" disabled={!list || list.parent === null} onClick={() => list && list.parent !== null && void load(list.parent)}>
          <CornerLeftUp size={ICON.sm} />
        </IconButton>
        <span className="panel-crumb clip-start" title={list?.path || session.workdir}>
          <bdi>{list ? list.path || session.workdir : session.workdir}</bdi>
        </span>
        <span className="grow" />
        <IconButton label="刷新" size="sm" onClick={() => void load(list?.path ?? "")}>
          {loading ? <Spinner size={ICON.sm} /> : <RefreshCw size={ICON.sm} />}
        </IconButton>
      </div>
      {err && (
        <div className="panel-notices">
          <Notice tone="err">{err}</Notice>
        </div>
      )}
      <ScrollArea className="panel-body">
        {list && list.entries.length === 0 && <Empty title="空目录" />}
        <div className="list panel-list">
          {list?.entries.map((e) => (
            <Row
              key={e.name}
              onClick={() => pick(e)}
              lead={e.kind === "dir" ? <Folder size={ICON.md} /> : e.kind === "link" ? <Link2 size={ICON.md} /> : <File size={ICON.md} />}
              name={e.name}
              meta={
                <>
                  {e.kind === "file" ? bytes(e.size) : ""}
                  {e.kind === "file" && e.mtime ? " · " : ""}
                  <When iso={e.mtime} />
                </>
              }
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
