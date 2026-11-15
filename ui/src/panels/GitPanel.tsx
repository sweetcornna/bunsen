import { GitBranch, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Empty, ICON, IconButton, Notice, Row, ScrollArea, Spinner } from "../components/ui";
import { api, asApiError, type GitStatus, type Session } from "../lib/api";

/** git 的状态码换成一个词，放在悬停里；行首照样显示原来的字母（中性色：改动不是异常）。 */
const STATUS_WORD = (code: string) => (code.includes("?") ? "未跟踪" : code.includes("D") ? "删除" : code.includes("A") ? "新增" : code.includes("R") ? "改名" : "修改");

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
        <GitBranch size={ICON.md} className="muted" />
        <span className="mono t-meta">{st?.is_repo ? (st.branch ?? "（游离 HEAD）") : "—"}</span>
        {st?.is_repo && <span className="panel-meta">{st.changes.length} 处改动</span>}
        <span className="grow" />
        <IconButton label="刷新" size="sm" onClick={() => void load(sel)}>
          {loading ? <Spinner size={ICON.sm} /> : <RefreshCw size={ICON.sm} />}
        </IconButton>
      </div>
      {err && (
        <div className="panel-notices">
          <Notice tone="err">{err}</Notice>
        </div>
      )}
      {st && !st.is_repo && <Empty title="不是 git 仓库" />}
      {st?.is_repo && st.changes.length === 0 && <Empty title="没有改动" />}
      {st?.is_repo && st.changes.length > 0 && (
        <div className="git">
          <ScrollArea className="git-files">
            <div className="list panel-list">
              <Row selected={sel === null} onClick={() => void load(null)} lead={<span className="git-code">∗</span>} name="全部改动" />
              {st.changes.map((c) => (
                <Row
                  key={c.path}
                  selected={sel === c.path}
                  onClick={() => void load(c.path)}
                  title={`${STATUS_WORD(c.status)}：${c.path}`}
                  lead={<span className="git-code">{c.status.trim() || "M"}</span>}
                  nameClass="mono clip-start"
                  name={<bdi>{c.path}</bdi>}
                />
              ))}
            </div>
          </ScrollArea>
          <ScrollArea className="git-diff">
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
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
