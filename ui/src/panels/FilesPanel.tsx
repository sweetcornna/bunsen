import { ArrowLeft, CornerLeftUp, File, Folder, Link2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { FilePreview, type Quoted } from "../components/Preview";
import { Empty, IconButton, Spinner } from "../components/ui";
import { api, asApiError, type FileEntry, type FileList, type Session } from "../lib/api";
import { bytes, joinPath, relTime } from "../lib/format";

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
          <IconButton label="返回" onClick={() => setOpen(null)}>
            <ArrowLeft size={14} />
          </IconButton>
        }
      />
    );

  return (
    <div className="panel">
      <div className="panel-bar">
        <IconButton label="上一级" disabled={!list || list.parent === null} onClick={() => list && list.parent !== null && void load(list.parent)}>
          <CornerLeftUp size={14} />
        </IconButton>
        <span className="mono ellipsis crumb" title={list?.path}>
          {list ? list.path || session.workdir : session.workdir}
        </span>
        <span className="grow" />
        <IconButton label="刷新" onClick={() => void load(list?.path ?? "")}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      {err && <div className="note err">{err}</div>}
      <div className="scroll grow">
        {list && list.entries.length === 0 && <Empty title="空目录" />}
        {list?.entries.map((e) => (
          <button key={e.name} type="button" className="file-row" onClick={() => pick(e)}>
            {e.kind === "dir" ? <Folder size={14} className="c-accent" /> : e.kind === "link" ? <Link2 size={14} /> : <File size={14} />}
            <span className="ellipsis">{e.name}</span>
            <span className="grow" />
            <span className="dim">{e.kind === "file" ? bytes(e.size) : ""}</span>
            <span className="dim file-time">{relTime(e.mtime)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
