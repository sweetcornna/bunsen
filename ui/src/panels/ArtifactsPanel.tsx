import { ArrowLeft, FileBarChart, FileCode2, FileText, Globe, Image as ImageIcon, NotebookText, RefreshCw, Search, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePreview, type Quoted } from "../components/Preview";
import { cx, Empty, IconButton, Spinner } from "../components/ui";
import { api, asApiError, type Artifact, type ArtifactKind, type ResearchRun, type Session } from "../lib/api";
import { bytes, loadLocal, relTime, saveLocal } from "../lib/format";
import { blobUrl } from "../lib/preview";

const KINDS: { id: ArtifactKind; label: string; icon: typeof ImageIcon }[] = [
  { id: "image", label: "图", icon: ImageIcon },
  { id: "table", label: "表", icon: FileBarChart },
  { id: "doc", label: "文档", icon: FileText },
  { id: "pdf", label: "PDF", icon: FileText },
  { id: "notebook", label: "Notebook", icon: NotebookText },
  { id: "html", label: "网页", icon: Globe },
];
const ICON = Object.fromEntries(KINDS.map((k) => [k.id, k.icon])) as Record<ArtifactKind, typeof ImageIcon>;

/** 哪次运行产生了它：按修改时间落在运行的起止之间来推断，所以标“推断”。只在服务端没给出精确对应（a.run）时用。 */
function producedBy(a: Artifact, runs: ResearchRun[]): ResearchRun | null {
  const t = Date.parse(a.mtime);
  if (Number.isNaN(t)) return null;
  let best: ResearchRun | null = null;
  for (const r of runs) {
    const s = Date.parse(r.started_at);
    const e = r.ended_at ? Date.parse(r.ended_at) : /run/i.test(r.state) ? Date.now() : NaN;
    if (Number.isNaN(s) || Number.isNaN(e)) continue;
    if (t >= s && t <= e + 60_000 && (!best || s > Date.parse(best.started_at))) best = r;
  }
  return best;
}

/**
 * 产物出自哪次运行。exact：outputs.json 里记着（契约 8.3），changed 为真表示运行之后文件又被改过；
 * 否则按修改时间推断。都没有为 null。
 */
type Origin = { run_id: string; exact: true; changed: boolean; verified: boolean | null } | { run_id: string; exact: false };
function originOf(a: Artifact, runs: ResearchRun[]): Origin | null {
  if (a.run) return { run_id: a.run.run_id, exact: true, changed: a.run.verified === false, verified: a.run.verified };
  const r = producedBy(a, runs);
  return r ? { run_id: r.run_id, exact: false } : null;
}

function originTitle(o: Origin): string {
  if (!o.exact) return `推断：按修改时间落在 ${o.run_id} 的起止之间`;
  if (o.changed) return `${o.run_id} 的输出清单里有这个文件，但现在的内容和运行时记下的不一样：运行之后改过`;
  if (o.verified === true) return `${o.run_id} 的输出清单里有这个文件，内容和运行时记下的一致`;
  return `${o.run_id} 的输出清单里有这个文件（大小一致，内容没有比对）`;
}

/** 产物预览顶栏和缩略图下面的来源标记。 */
function OriginBadge({ o, onRun }: { o: Origin; onRun?: (runId: string) => void }) {
  const label = o.exact ? `出自 ${o.run_id}` : `推断 ${o.run_id}`;
  return (
    <>
      {onRun ? (
        <button type="button" className={cx("prov", o.exact && "exact")} onClick={() => onRun(o.run_id)} title={originTitle(o)}>
          <FileCode2 size={11} />
          {label}
        </button>
      ) : null}
      {o.exact && o.changed && (
        <span className="tag warn" title={originTitle(o)}>
          运行之后改过
        </span>
      )}
    </>
  );
}

export function ArtifactsPanel({ session, active, runs, onQuote, onRun }: { session: Session; active: boolean; runs: ResearchRun[]; onQuote: (q: Quoted) => void; onRun: (runId: string) => void }) {
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<ArtifactKind | "all" | "star">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Artifact | null>(null);
  const starKey = `bunsen.stars.${session.id}`;
  const [stars, setStars] = useState<string[]>(() => loadLocal<string[]>(starKey, []));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.artifacts(session.id);
      setItems(r.items);
      setTruncated(r.truncated);
      setErr(null);
    } catch (e) {
      setErr(asApiError(e).message);
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    if (!active || session.state === "unreachable") return;
    void load();
    const t = window.setInterval(() => !document.hidden && void load(), 30000);
    return () => window.clearInterval(t);
  }, [active, load, session.state]);

  const toggleStar = (path: string) =>
    setStars((prev) => {
      const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
      saveLocal(starKey, next);
      return next;
    });

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of items ?? []) c[a.kind] = (c[a.kind] ?? 0) + 1;
    return c;
  }, [items]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((a) => (kind === "all" || (kind === "star" ? stars.includes(a.path) : a.kind === kind)) && (!q || a.path.toLowerCase().includes(q)));
  }, [items, kind, query, stars]);

  if (open) {
    const origin = originOf(open, runs);
    return (
      <FilePreview
        sessionId={session.id}
        path={open.path}
        stamp={open.mtime}
        onQuote={onQuote}
        left={
          <>
            <IconButton label="返回" onClick={() => setOpen(null)}>
              <ArrowLeft size={14} />
            </IconButton>
            <IconButton label={stars.includes(open.path) ? "取消星标" : "星标"} active={stars.includes(open.path)} onClick={() => toggleStar(open.path)}>
              <Star size={13} fill={stars.includes(open.path) ? "currentColor" : "none"} />
            </IconButton>
            {origin && <OriginBadge o={origin} onRun={onRun} />}
          </>
        }
      />
    );
  }

  return (
    <div className="panel">
      <div className="panel-bar wrap">
        <div className="filters">
          <button type="button" className={cx("filter", kind === "all" && "on")} onClick={() => setKind("all")}>
            全部 <i>{items?.length ?? 0}</i>
          </button>
          {KINDS.filter((k) => counts[k.id]).map((k) => (
            <button key={k.id} type="button" className={cx("filter", kind === k.id && "on")} onClick={() => setKind(k.id)}>
              {k.label} <i>{counts[k.id]}</i>
            </button>
          ))}
          {stars.length > 0 && (
            <button type="button" className={cx("filter", kind === "star" && "on")} onClick={() => setKind("star")}>
              <Star size={11} /> <i>{stars.length}</i>
            </button>
          )}
        </div>
        <span className="grow" />
        <label className="mini-search">
          <Search size={12} />
          <input value={query} placeholder="筛选" onChange={(e) => setQuery(e.target.value)} />
        </label>
        <IconButton label="刷新" onClick={() => void load()}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      {err && <div className="note err">{err}</div>}
      <div className="scroll grow">
        {items && shown.length === 0 && <Empty icon={<ImageIcon size={20} />} title={items.length === 0 ? "还没有产物" : "没有匹配项"} />}
        <div className="art-grid">
          {shown.map((a) => (
            <ArtifactTile key={a.path} sessionId={session.id} a={a} starred={stars.includes(a.path)} origin={originOf(a, runs)} onOpen={() => setOpen(a)} />
          ))}
        </div>
        {truncated && <div className="note">只列出最近的 {items?.length} 个</div>}
      </div>
    </div>
  );
}

function ArtifactTile({ sessionId, a, starred, origin, onOpen }: { sessionId: string; a: Artifact; starred: boolean; origin: Origin | null; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const Icon = ICON[a.kind];
  const wantsThumb = a.kind === "image" && a.size <= 6 * 1024 * 1024;

  // 滚到眼前才取缩略图。
  useEffect(() => {
    if (!wantsThumb || !ref.current) return;
    let alive = true;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        blobUrl(sessionId, a.path, a.mtime)
          .then((u) => alive && setThumb(u))
          .catch(() => undefined);
      },
      { rootMargin: "200px" },
    );
    io.observe(ref.current);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [sessionId, a.path, a.mtime, wantsThumb]);

  const dir = a.path.includes("/") ? a.path.slice(0, a.path.lastIndexOf("/")) : "";
  return (
    <button ref={ref} type="button" className="art" onClick={onOpen} title={a.path}>
      <div className={cx("art-thumb", a.kind)}>
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <Icon size={22} strokeWidth={1.4} />}
        {starred && <Star size={11} className="art-star" fill="currentColor" />}
        {origin?.exact && origin.changed && <span className="art-flag">运行之后改过</span>}
      </div>
      <div className="art-name ellipsis">{a.name}</div>
      <div className="art-meta">
        <span className="ellipsis" title={origin ? originTitle(origin) : undefined}>
          {origin ? (origin.exact ? `出自 ${origin.run_id}` : `推断 ${origin.run_id}`) : dir || bytes(a.size)}
        </span>
        <span>{relTime(a.mtime)}</span>
      </div>
    </button>
  );
}
