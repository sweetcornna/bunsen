import { GitBranch, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cx, Empty, IconButton, Spinner } from "../components/ui";
import { api, asApiError, type GitStatus, type Session } from "../lib/api";

const STATUS_TONE = (code: string) => (code.includes("?") ? "new" : code.includes("D") ? "del" : code.includes("A") ? "new" : "mod");

export function GitPanel({ session, active }: { session: Session; active: boolean }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async (path: string | null) => {
      setLoading(true);
      try {
        const status = await api.git(session.id);
        setSt(status);
        const keep = path && status.changes.some((c) => c.path === path) ? path : null;
        setSel(keep);
        setDiff(status.is_repo ? (await api.gitDiff(session.id, keep ?? undefined)).diff : "");
        setErr(null);
      } catch (e) {
        setErr(asApiError(e).message);
      } finally {
        setLoading(false);
      }
    },
    [session.id],
  );

  // 每次切到这个标签页都重新读一遍。
  useEffect(() => {
    if (active) void load(sel);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const lines = useMemo(() => diff.split("\n"), [diff]);
  const selStatus = sel ? st?.changes.find((c) => c.path === sel)?.status : undefined;

  return (
    <div className="panel">
      <div className="panel-bar">
        <GitBranch size={13} className="dim" />
        <span className="mono">{st?.is_repo ? (st.branch ?? "（游离 HEAD）") : "—"}</span>
        {st?.is_repo && <span className="dim">{st.changes.length} 处改动</span>}
        <span className="grow" />
        <IconButton label="刷新" onClick={() => void load(sel)}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      {err && <div className="note err">{err}</div>}
      {st && !st.is_repo && <Empty title="不是 git 仓库" />}
      {st?.is_repo && st.changes.length === 0 && <Empty title="没有改动" />}
      {st?.is_repo && st.changes.length > 0 && (
        <div className="git">
          <div className="git-list scroll">
            <button type="button" className={cx("git-row", sel === null && "on")} onClick={() => void load(null)}>
              <span className="git-code">∗</span>
              <span>全部改动</span>
            </button>
            {st.changes.map((c) => (
              <button key={c.path} type="button" className={cx("git-row", sel === c.path && "on")} onClick={() => void load(c.path)} title={c.path}>
                <span className={cx("git-code", STATUS_TONE(c.status))}>{c.status.trim() || "M"}</span>
                <span className="ellipsis rtl">{c.path}</span>
              </button>
            ))}
          </div>
          <div className="git-diff scroll">
            {diff.trim() === "" ? (
              <Empty title={selStatus?.includes("?") ? "未跟踪的新文件" : "没有差异"} />
            ) : (
              <pre className="diff">
                {lines.map((l, i) => (
                  <span key={i} className={l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ") ? "d-meta" : l.startsWith("@@") ? "d-hunk" : l.startsWith("+") ? "d-add" : l.startsWith("-") ? "d-del" : undefined}>
                    {l + "\n"}
                  </span>
                ))}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
