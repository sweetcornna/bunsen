import { ArrowLeft, ExternalLink, FileText, FlaskConical, GitCommitHorizontal, Play, Quote, RefreshCw, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { Markdown } from "../components/Markdown";
import { FilePreview, type Quoted } from "../components/Preview";
import { Button, cx, Dot, Empty, IconButton, Pill, Segmented, Spinner, type Tone } from "../components/ui";
import { api, asApiError, type ApiError, type Research, type ResearchRun, type ResearchTrust, type RunDetail, type Session } from "../lib/api";
import { relTime } from "../lib/format";
import { previewPath, type PathCtx } from "../lib/paths";
import { asRecord, citeUrl, claimTone, envOf, inputsOf, normalizeTrust, outputsOf, preregPaths, runTone } from "../lib/research";
import { useApp } from "../lib/store";
import { EnvView, InputsView, OutputsView } from "./RunProvenance";
import { TrustView } from "./TrustView";

type Sub = "state" | "runs" | "claims" | "trust" | "ideas" | "overview" | "notes";
type RunTab = "log" | "metrics" | "result" | "env" | "inputs" | "outputs" | "meta";
/** 可信度上次取到不到这么久时，重新打开这一页不自动再取（审查 P4F1-08），点刷新照取。 */
const TRUST_FRESH_MS = 60_000;
/** 页签栏放不下时可以横向滚动；键盘移到的页签整个滚进可见区（Chrome 对部分可见的元素获得焦点时不滚，焦点框会被裁掉，审查 P4F1-05）。 */
const revealTab = (e: FocusEvent<HTMLDivElement>) => {
  if (e.target !== e.currentTarget) e.target.scrollIntoView({ block: "nearest", inline: "nearest" });
};

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
function parseEvidence(text: string, paths: PathCtx): Evidence[] {
  return text
    .split(/[;；]/)
    .map((s) => s.trim().replace(/^`|`$/g, ""))
    .filter(Boolean)
    .map((s): Evidence => {
      if (/^run:/i.test(s)) return { label: s.slice(4), kind: "run", target: s.slice(4).trim() };
      const cite = /^(doi|arxiv):/i.test(s) ? citeUrl(s) : null;
      if (cite) return { label: s, kind: "link", target: cite };
      if (/^https?:\/\//.test(s)) return { label: s.replace(/^https?:\/\//, "").slice(0, 40), kind: "link", target: s };
      if (/^[\w./-]+\.[A-Za-z0-9]+$/.test(s)) {
        // 研究目录里的记录相对研究目录，其余相对工作目录；都经路径出口，换不了的只显示文字。
        const rel = previewPath(s, /^(results|prereg|runs|strategy)\//.test(s) ? "home" : "workdir", paths);
        return rel ? { label: s, kind: "file", target: rel } : { label: s, kind: "text", target: s };
      }
      return { label: s, kind: "text", target: s };
    });
}

export function ResearchPanel({ session, active, focusRun, onCompose, onQuote, onData }: { session: Session; active: boolean; focusRun: { id: string; n: number } | null; onCompose: (text: string) => void; onQuote: (q: Quoted) => void; onData: (r: Research) => void }) {
  const [data, setData] = useState<Research | null>(null);
  const [sub, setSub] = useState<Sub>("state");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [run, setRunId] = useState<string | null>(null);
  // 运行详情停在哪一页放在这里：从“输出”点开文件预览再返回时，还回到“输出”。换一条运行时回到日志。
  const [runTab, setRunTab] = useState<RunTab>("log");
  const setRun = useCallback((id: string | null) => {
    setRunTab("log");
    setRunId(id);
  }, []);
  const [file, setFile] = useState<string | null>(null);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  // 可信度（契约 8.1）：服务端不缓存、要在服务器上跑四条命令，所以只在打开这一页和点刷新时请求，不轮询；
  // 上一次的结果留着，刷新期间照常显示。同一时刻只发一个请求。
  // 请求可以取消：换会话（组件卸载）时取消正在进行的那一个，免得几个最长 150 秒的请求堆着占连接（审查 P4F1-08）。
  const [trust, setTrust] = useState<ResearchTrust | null>(null);
  const [trustErr, setTrustErr] = useState<ApiError | null>(null);
  const [trustLoading, setTrustLoading] = useState(false);
  const trustReq = useRef<AbortController | null>(null);
  const trustAt = useRef(0);
  useEffect(() => () => trustReq.current?.abort(), []);

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

  /** force：点刷新、重试时为真；自动打开时上次结果还新鲜就不取。 */
  const loadTrust = useCallback(
    async (force: boolean) => {
      if (trustReq.current) return; // 已经在取
      if (!force && Date.now() - trustAt.current < TRUST_FRESH_MS) return;
      const ctl = new AbortController();
      trustReq.current = ctl;
      setTrustLoading(true);
      try {
        const t = normalizeTrust(await api.trust(session.id, ctl.signal));
        if (ctl.signal.aborted) return;
        trustAt.current = Date.now();
        setTrust(t);
        setTrustErr(null);
      } catch (e) {
        if (!ctl.signal.aborted) setTrustErr(asApiError(e));
      } finally {
        if (trustReq.current === ctl) trustReq.current = null;
        if (!ctl.signal.aborted) setTrustLoading(false);
      }
    },
    [session.id],
  );
  const retryTrust = useCallback(() => void loadTrust(true), [loadTrust]);

  // 打开可信度页（切到这一页，或者面板重新可见时正停在这一页）时请求一次。
  const present = data?.present === true;
  const offline = session.state === "unreachable";
  useEffect(() => {
    if (active && sub === "trust" && present && !offline) void loadTrust(false);
  }, [active, sub, present, offline, loadTrust]);

  const refresh = () => {
    void load();
    if (sub === "trust") void loadTrust(true);
  };

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
  // 路径预览的上下文（契约 Q8）：所有点开预览的路径都经 lib/paths.ts 的 previewPath。
  const serverHome = useApp((s) => s.servers.find((x) => x.id === session.server_id)?.probe?.home ?? null);
  const repoPrefix = data?.repo_prefix ?? null;
  const paths = useMemo<PathCtx>(() => ({ workdir: session.workdir, serverHome, home, repoPrefix }), [session.workdir, serverHome, home, repoPrefix]);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  // 最后一道关：交给文件预览的路径再过一次出口（相对工作目录），过不了的不打开。
  const openFile = useCallback((p: string) => {
    const safe = previewPath(p, "workdir", pathsRef.current);
    if (safe) setFile(safe);
  }, []);

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
    return <RunView session={session} runId={run} run={r} home={home} paths={paths} tab={runTab} setTab={setRunTab} onBack={() => setRun(null)} onQuote={onQuote} onFile={openFile} />;
  }

  // 会话这次没连上服务器、也还没取到过研究记录：不一直转圈，说清楚并给重试。
  if (!data && offline)
    return (
      <div className="panel">
        <Empty icon={<WifiOff size={20} />} title="连不上服务器" hint={err ?? "这个对话所在的服务器这次没连上，取不到研究记录。"}>
          <Button loading={loading} onClick={() => void load()}>
            重试
          </Button>
        </Empty>
      </div>
    );

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
    else if (e.kind === "file") openFile(e.target);
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
        <IconButton label="刷新" onClick={refresh}>
          {loading || (sub === "trust" && trustLoading) ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
      </div>
      {data?.loop.blocked && <div className="note warn">{data.loop.blocked}</div>}
      {offline && <div className="note warn">连不上服务器，下面是最近一次取到的内容。</div>}
      {err && <div className="note err">{err}</div>}
      <div className="panel-bar tabs-scroll" onFocus={revealTab}>
        <Segmented
          value={sub}
          onChange={setSub}
          options={[
            { value: "state", label: "状态" },
            { value: "runs", label: "运行" },
            { value: "claims", label: "结论" },
            { value: "trust", label: "可信度" },
            { value: "ideas", label: "想法" },
            { value: "overview", label: "总览" },
            { value: "notes", label: "记录" },
          ]}
        />
      </div>
      <div className="scroll grow">
        {!data && !err && <Empty title={<Spinner />} />}
        {data && sub === "state" && <Doc md={data.state_md} />}
        {data && sub === "trust" && <TrustView trust={trust} error={trustErr} loading={trustLoading} offline={offline} paths={paths} planMd={data.plan_md} onRun={setRun} onFile={openFile} onRetry={retryTrust} />}
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
                    {parseEvidence(c["证据"] ?? "", paths).map((e, k) => (
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
      <Markdown text={md} images="link" />
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

function RunView({ session, runId, run, home, paths, tab, setTab, onBack, onQuote, onFile }: { session: Session; runId: string; run: ResearchRun | undefined; home: string; paths: PathCtx; tab: RunTab; setTab: (t: RunTab) => void; onBack: () => void; onQuote: (q: Quoted) => void; onFile: (path: string) => void }) {
  const [d, setD] = useState<RunDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
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
  // 服务端原样带回的记录先整理：形状不对的当作没有或“格式不认识”，不让整页出错（审查 P4F1-01、12）。
  const meta = useMemo(() => asRecord(d?.meta), [d?.meta]);
  const env = useMemo(() => envOf(d?.env), [d?.env]);
  const outputs = useMemo(() => outputsOf(d?.outputs), [d?.outputs]);
  const inputs = useMemo(() => inputsOf(meta), [meta]);
  const cmd = Array.isArray(meta.cmd) ? (meta.cmd as unknown[]).join(" ") : (run?.cmd ?? "");
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
          {preregPaths(meta).map((p, i) => {
            // meta.prereg[].path 相对仓库根（不在仓库里时为绝对路径，rk.py 的 run 记录）；旧服务端没有 repo_prefix 时，
            // 退而按研究目录下的 prereg/… 找。都经路径出口，和其他出处一致（审查 P4F2-02）。
            const tail = /(?:^|\/)(prereg\/[^/].*)$/.exec(p);
            const rel = previewPath(p, "repo", paths) ?? (tail ? previewPath(tail[1], "home", paths) : null);
            return rel ? (
              <button key={i} type="button" className="ev file" onClick={() => onFile(rel)} title={p}>
                <FileText size={10} />
                {p.split("/").pop()}
              </button>
            ) : (
              <span key={i} className="ev text" title={p}>
                {p.split("/").pop()}
              </span>
            );
          })}
          {run?.started_at && <span className="ev text">{relTime(run.started_at)}</span>}
          {typeof meta.host === "string" && <span className="ev text">{meta.host}</span>}
        </div>
      </div>
      <div className="panel-bar tabs-scroll" onFocus={revealTab}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "log", label: "日志" },
            { value: "metrics", label: `指标${metrics.length ? ` ${metrics.length}` : ""}` },
            { value: "result", label: "结果页" },
            { value: "env", label: "环境" },
            { value: "inputs", label: `输入${inputs?.length ? ` ${inputs.length}` : ""}` },
            { value: "outputs", label: `输出${outputs.value?.files.length ? ` ${outputs.value.files.length}` : ""}` },
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
        {d && tab === "result" && (d.result_md?.trim() ? <div className="pad"><Markdown text={d.result_md} images="link" /></div> : <Empty title="没有结果页" />)}
        {d && tab === "env" && <EnvView env={env.value} bad={env.bad} meta={meta} live={live} />}
        {d && tab === "inputs" && <InputsView inputs={inputs} meta={meta} paths={paths} onFile={onFile} />}
        {d && tab === "outputs" && <OutputsView outputs={outputs.value} bad={outputs.bad} meta={meta} live={live} paths={paths} onFile={onFile} />}
        {d && tab === "meta" && <pre className="log">{JSON.stringify(d.meta, null, 2)}</pre>}
      </div>
    </div>
  );
}
