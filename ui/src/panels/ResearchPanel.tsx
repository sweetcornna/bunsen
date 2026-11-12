import { ArrowLeft, ExternalLink, FileText, FlaskConical, GitCommitHorizontal, Play, Quote, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { FilePreview, type Quoted } from "../components/Preview";
import { Button, cx, Dot, Empty, IconButton, Pill, Segmented, Spinner, type Tone } from "../components/ui";
import { api, asApiError, type Research, type ResearchRun, type RunDetail, type Session } from "../lib/api";
import { relTime } from "../lib/format";

type Sub = "state" | "runs" | "claims" | "ideas" | "overview" | "notes";

const runTone = (state: string): Tone => (/run|queue|wait/i.test(state) ? "accent" : /fail|error|kill|timeout|lost/i.test(state) ? "err" : /done|ok|success/i.test(state) ? "ok" : "mute");
const claimTone = (s: string): Tone => (s.includes("证实") ? "ok" : s.includes("否定") ? "err" : s.includes("未决") ? "warn" : "mute");
const ideaTone = (s: string): Tone => (s.includes("已确认") ? "ok" : /通过|预登记/.test(s) ? "accent" : /未过|未确认/.test(s) ? "warn" : s.includes("否决") ? "err" : "mute");

/** 从 Markdown 里取出表头含 must 的那张表。 */
function mdTable(md: string | null | undefined, must: string): Record<string, string>[] {
  if (!md) return [];
  const lines = md.split("\n");
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|") || !lines[i].includes(must) || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const head = cells(lines[i]);
    const out: Record<string, string>[] = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const c = cells(lines[j]);
      if (c.every((x) => !x)) continue;
      out.push(Object.fromEntries(head.map((h, k) => [h.replace(/（.*?）|\(.*?\)/g, "").trim(), c[k] ?? ""])));
    }
    return out;
  }
  return [];
}

type Evidence = { label: string; kind: "run" | "file" | "link" | "text"; target: string };
function parseEvidence(text: string, home: string): Evidence[] {
  return text
    .split(/[;；]/)
    .map((s) => s.trim().replace(/^`|`$/g, ""))
    .filter(Boolean)
    .map((s): Evidence => {
      if (/^run:/i.test(s)) return { label: s.slice(4), kind: "run", target: s.slice(4).trim() };
      if (/^doi:/i.test(s)) return { label: s, kind: "link", target: `https://doi.org/${s.slice(4).trim()}` };
      if (/^arxiv:/i.test(s)) return { label: s, kind: "link", target: `https://arxiv.org/abs/${s.slice(6).trim()}` };
      if (/^https?:\/\//.test(s)) return { label: s.replace(/^https?:\/\//, "").slice(0, 40), kind: "link", target: s };
      if (/^[\w./-]+\.[A-Za-z0-9]+$/.test(s)) return { label: s, kind: "file", target: /^(results|prereg|runs|strategy)\//.test(s) ? `${home}/${s}` : s };
      return { label: s, kind: "text", target: s };
    });
}

export function ResearchPanel({ session, active, focusRun, onCompose, onQuote, onData }: { session: Session; active: boolean; focusRun: { id: string; n: number } | null; onCompose: (text: string) => void; onQuote: (q: Quoted) => void; onData: (r: Research) => void }) {
  const [data, setData] = useState<Research | null>(null);
  const [sub, setSub] = useState<Sub>("state");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.research(session.id);
      setData(r);
      onDataRef.current(r);
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
    const t = window.setInterval(() => !document.hidden && void load(), 20000);
    return () => window.clearInterval(t);
  }, [active, load, session.state]);

  useEffect(() => {
    if (focusRun) {
      setFile(null);
      setRun(focusRun.id);
    }
  }, [focusRun]);

  const claims = useMemo(() => mdTable(data?.ledger_md, "状态"), [data?.ledger_md]);
  const ideas = useMemo(() => mdTable(data?.ideas_md, "想法"), [data?.ideas_md]);
  const withPlugin = session.plugin === "research" || (session.plugins ?? []).includes("research");
  const home = data?.home ?? "research";

  if (file)
    return (
      <FilePreview
        sessionId={session.id}
        path={file}
        onQuote={onQuote}
        left={
          <IconButton label="返回" onClick={() => setFile(null)}>
            <ArrowLeft size={14} />
          </IconButton>
        }
      />
    );

  if (run && data) {
    const r = data.runs.find((x) => x.run_id === run);
    return <RunView session={session} runId={run} run={r} home={home} onBack={() => setRun(null)} onQuote={onQuote} onFile={setFile} />;
  }

  if (data && !data.present)
    return (
      <div className="panel">
        <Empty icon={<FlaskConical size={20} />} title="还没有研究记录" hint={withPlugin ? undefined : "此对话未加载科研插件"}>
          {withPlugin && (
            <Button variant="primary" onClick={() => onCompose("/research:start ")}>
              开始研究
            </Button>
          )}
          <Button icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} onClick={() => void load()}>
            刷新
          </Button>
        </Empty>
      </div>
    );

  const running = data?.runs.filter((r) => runTone(r.state) === "accent").length ?? 0;
  const confirmed = claims.filter((c) => (c["状态"] ?? "").includes("证实")).length;
  const openEvidence = (e: Evidence) => {
    if (e.kind === "run") setRun(e.target);
    else if (e.kind === "file") setFile(e.target);
    else if (e.kind === "link") window.open(e.target, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="panel">
      <div className="kpis">
        <div className="kpi">
          <span>循环</span>
          <b className={data?.loop.blocked ? "c-warn" : data?.loop.on ? "c-ok" : "dim"}>{data?.loop.blocked ? "等你" : data?.loop.on ? "进行中" : "未开启"}</b>
        </div>
        <button type="button" className="kpi" onClick={() => setSub("runs")}>
          <span>运行</span>
          <b>
            {running > 0 && <Dot tone="accent" pulse />}
            {running}
            <i>/ {data?.runs.length ?? 0}</i>
          </b>
        </button>
        <button type="button" className="kpi" onClick={() => setSub("claims")}>
          <span>已证实</span>
          <b>
            {confirmed}
            <i>/ {claims.length}</i>
          </b>
        </button>
        <button type="button" className="kpi" onClick={() => setSub("ideas")}>
          <span>想法</span>
          <b>{ideas.length}</b>
        </button>
        <span className="grow" />
        {withPlugin && (
          <Button size="sm" variant="ghost" onClick={() => onCompose(data?.loop.on ? "/research:status" : "/research:resume")}>
            {data?.loop.on ? "问进展" : "接续"}
          </Button>
        )}
        <IconButton label="刷新" onClick={() => void load()}>
          {loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      {data?.loop.blocked && <div className="note warn">{data.loop.blocked}</div>}
      {err && <div className="note err">{err}</div>}
      <div className="panel-bar">
        <Segmented
          value={sub}
          onChange={setSub}
          options={[
            { value: "state", label: "状态" },
            { value: "runs", label: "运行" },
            { value: "claims", label: "结论" },
            { value: "ideas", label: "想法" },
            { value: "overview", label: "总览" },
            { value: "notes", label: "记录" },
          ]}
        />
      </div>
      <div className="scroll grow">
        {!data && !err && <Empty title={<Spinner />} />}
        {data && sub === "state" && <Doc md={data.state_md} />}
        {data && sub === "overview" && <Doc md={data.overview_md ?? data.summary_md} />}
        {data && sub === "notes" && <Doc md={[data.lessons_md, data.log_tail && `---\n\n${data.log_tail}`].filter(Boolean).join("\n\n")} />}
        {data &&
          sub === "runs" &&
          (data.runs.length === 0 ? (
            <Empty title="还没有运行" />
          ) : (
            <div className="rows">
              {[...data.runs].reverse().map((r) => (
                <button key={r.run_id} type="button" className="run-row" onClick={() => setRun(r.run_id)}>
                  <Dot tone={runTone(r.state)} pulse={runTone(r.state) === "accent"} />
                  <span className="mono run-id ellipsis">{r.run_id}</span>
                  <span className={cx("tag", r.kind === "explore" ? undefined : "accent")}>{r.kind === "explore" ? "探索" : "预登记"}</span>
                  <span className="dim ellipsis grow">{r.note}</span>
                  <span className="mono dim">{r.elapsed}</span>
                  <span className={cx("run-state", runTone(r.state))}>
                    {r.state}
                    {r.exit_code ? ` ${r.exit_code}` : ""}
                  </span>
                </button>
              ))}
            </div>
          ))}
        {data &&
          sub === "claims" &&
          (claims.length === 0 ? (
            <Doc md={data.ledger_md} empty="还没有结论" />
          ) : (
            <div className="rows">
              {claims.map((c, i) => (
                <div key={i} className="claim">
                  <div className="claim-head">
                    <span className="mono dim">{c["编号"]}</span>
                    <Pill tone={claimTone(c["状态"] ?? "")}>{c["状态"]}</Pill>
                    {c["性质"] && <span className="tag">{c["性质"]}</span>}
                    <span className="grow" />
                    <span className="dim">{c["日期"]}</span>
                  </div>
                  <div className="claim-text">{c["结论"]}</div>
                  <div className="chips">
                    {parseEvidence(c["证据"] ?? "", home).map((e, k) => (
                      <button key={k} type="button" className={cx("ev", e.kind)} disabled={e.kind === "text"} onClick={() => openEvidence(e)}>
                        {e.kind === "run" ? <Play size={10} /> : e.kind === "file" ? <FileText size={10} /> : e.kind === "link" ? <ExternalLink size={10} /> : null}
                        {e.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        {data &&
          sub === "ideas" &&
          (ideas.length === 0 ? (
            <Doc md={data.ideas_md} empty="还没有想法" />
          ) : (
            <div className="rows">
              {ideas.map((c, i) => (
                <div key={i} className="claim">
                  <div className="claim-head">
                    <span className="mono dim">{c["编号"]}</span>
                    <Pill tone={ideaTone(c["状态"] ?? "")}>{c["状态"] || "候选"}</Pill>
                    {c["簇"] && <span className="tag">{c["簇"]}</span>}
                    {c["类型"] && <span className="tag">{c["类型"]}</span>}
                  </div>
                  <div className="claim-text">{c["想法"]}</div>
                  {(c["可证伪的预测"] || c["最便宜的判决性检验"]) && (
                    <dl className="idea-facts">
                      {c["可证伪的预测"] && (
                        <>
                          <dt>预测</dt>
                          <dd>{c["可证伪的预测"]}</dd>
                        </>
                      )}
                      {c["最便宜的判决性检验"] && (
                        <>
                          <dt>检验</dt>
                          <dd>{c["最便宜的判决性检验"]}</dd>
                        </>
                      )}
                    </dl>
                  )}
                </div>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function Doc({ md, empty = "还没有内容" }: { md: string | null | undefined; empty?: string }) {
  return md?.trim() ? (
    <div className="pad">
      <Markdown text={md} />
    </div>
  ) : (
    <Empty title={empty} />
  );
}

function flatten(obj: unknown, prefix = "", out: [string, string][] = [], depth = 0): [string, string][] {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && depth < 4) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else if (prefix) {
    out.push([prefix, typeof obj === "number" ? (Number.isInteger(obj) ? String(obj) : Number(obj.toPrecision(6)).toString()) : typeof obj === "string" ? obj : JSON.stringify(obj)]);
  }
  return out;
}

function RunView({ session, runId, run, home, onBack, onQuote, onFile }: { session: Session; runId: string; run: ResearchRun | undefined; home: string; onBack: () => void; onQuote: (q: Quoted) => void; onFile: (path: string) => void }) {
  const [d, setD] = useState<RunDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"log" | "metrics" | "result" | "meta">("log");
  const logRef = useRef<HTMLPreElement | null>(null);
  const stick = useRef(true);
  const live = run ? runTone(run.state) === "accent" : false;

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .run(session.id, runId, 400)
        .then((r) => alive && (setD(r), setErr(null)))
        .catch((e) => alive && setErr(asApiError(e).message));
    void tick();
    if (!live) return () => void (alive = false);
    const t = window.setInterval(() => !document.hidden && void tick(), 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [session.id, runId, live]);

  // 日志跟随到底，除非用户往上翻了。
  useEffect(() => {
    const el = logRef.current?.parentElement;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [d?.log_tail, tab]);

  const metrics = useMemo(() => (d?.metrics ? flatten(d.metrics) : []), [d?.metrics]);
  const meta = (d?.meta ?? {}) as Record<string, unknown>;
  const cmd = Array.isArray(meta.cmd) ? (meta.cmd as string[]).join(" ") : (run?.cmd ?? "");
  const commit = String(meta.git_commit ?? run?.commit ?? "").slice(0, 8);

  return (
    <div className="panel">
      <div className="panel-bar">
        <IconButton label="返回" onClick={onBack}>
          <ArrowLeft size={14} />
        </IconButton>
        {run && <Dot tone={runTone(run.state)} pulse={live} />}
        <span className="mono ellipsis">{runId}</span>
        {run && <span className="dim">{run.elapsed}</span>}
        <span className="grow" />
        <IconButton label="引用到消息" onClick={() => onQuote({ path: `${home}/runs/${runId}` })}>
          <Quote size={13} />
        </IconButton>
      </div>
      <div className="run-facts">
        {cmd && <code className="run-cmd">{cmd}</code>}
        <div className="chips">
          {commit && (
            <span className={cx("ev", meta.git_dirty ? "warn" : undefined)} title={meta.git_dirty ? "启动时有未提交改动" : undefined}>
              <GitCommitHorizontal size={11} />
              {commit}
              {meta.git_dirty ? " *" : ""}
            </span>
          )}
          {((meta.prereg as { path: string }[] | undefined) ?? []).map((p, i) => (
            <button key={i} type="button" className="ev file" onClick={() => onFile(p.path.startsWith(home) ? p.path : `${home}/${p.path.replace(/^.*?(prereg\/)/, "$1")}`)}>
              <FileText size={10} />
              {p.path.split("/").pop()}
            </button>
          ))}
          {run?.started_at && <span className="ev text">{relTime(run.started_at)}</span>}
          {typeof meta.host === "string" && <span className="ev text">{meta.host}</span>}
        </div>
      </div>
      <div className="panel-bar">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "log", label: "日志" },
            { value: "metrics", label: `指标${metrics.length ? ` ${metrics.length}` : ""}` },
            { value: "result", label: "结果页" },
            { value: "meta", label: "元数据" },
          ]}
        />
      </div>
      {err && <div className="note err">{err}</div>}
      <div
        className="scroll grow"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!d && !err && <Empty title={<Spinner />} />}
        {d && tab === "log" && (d.log_tail.trim() ? <pre ref={logRef} className="log">{d.log_tail}</pre> : <Empty title="没有日志" />)}
        {d &&
          tab === "metrics" &&
          (metrics.length === 0 ? (
            <Empty title="没有 metrics.json" />
          ) : (
            <table className="table data">
              <tbody>
                {metrics.map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td className="num">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        {d && tab === "result" && (d.result_md?.trim() ? <div className="pad"><Markdown text={d.result_md} /></div> : <Empty title="没有结果页" />)}
        {d && tab === "meta" && <pre className="log">{JSON.stringify(d.meta, null, 2)}</pre>}
      </div>
    </div>
  );
}
