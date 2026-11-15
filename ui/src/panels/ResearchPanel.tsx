import { ArrowLeft, FlaskConical, Quote, RefreshCw, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { FilePreview, type Quoted } from "../components/Preview";
import { Badge, Button, Dot, Empty, Fact, Facts, ICON, IconButton, Loading, Notice, Row, ScrollArea, Spinner, Table, Tabs, When } from "../components/ui";
import { api, asApiError, type ApiError, type Research, type ResearchRun, type ResearchTrust, type RunDetail, type Session } from "../lib/api";
import { fmtFull, runDuration } from "../lib/format";
import { previewPath, type PathCtx } from "../lib/paths";
import { asRecord, citeUrl, envOf, inputsOf, isLiveRun, normalizeTrust, outputsOf, preregPaths, runKind, runStatus } from "../lib/research";
import { useApp } from "../lib/store";
import { EnvView, InputsView, OutputsView } from "./RunProvenance";
import { EvChip, TrustView } from "./TrustView";

type Sub = "state" | "runs" | "claims" | "trust" | "ideas" | "overview" | "notes";
type RunTab = "log" | "metrics" | "result" | "env" | "inputs" | "outputs" | "meta";
/** 可信度上次取到不到这么久时，重新打开这一页不自动再取（审查 P4F1-08），点刷新照取。 */
const TRUST_FRESH_MS = 60_000;
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
          <IconButton label="返回" size="sm" data-back="" onClick={() => setFile(null)}>
            <ArrowLeft size={ICON.sm} />
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
        <Empty icon={<WifiOff size={ICON.lg} />} title="连不上服务器" hint={err ?? "这个对话所在的服务器这次没连上，取不到研究记录。"}>
          <Button loading={loading} onClick={() => void load()}>
            重试
          </Button>
        </Empty>
      </div>
    );

  if (data && !data.present)
    return (
      <div className="panel">
        <Empty icon={<FlaskConical size={ICON.lg} />} title="还没有研究记录" hint={withPlugin ? "在输入条里发 /research:start 开始一项研究。" : "这个对话没有加载科研插件。"}>
          {/* 面板里的空状态按钮一律次要样式：primary 留给发送和“接续”，同屏一个（分屏稿 14.5） */}
          {withPlugin && (
            <Button onClick={() => onCompose("/research:start ")}>
              开始研究
            </Button>
          )}
          <Button variant={withPlugin ? "ghost" : "secondary"} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Empty>
      </div>
    );

  const running = data?.runs.filter((r) => isLiveRun(r.state)).length ?? 0;
  const openEvidence = (e: Evidence) => {
    if (e.kind === "run") setRun(e.target);
    else if (e.kind === "file") openFile(e.target);
    else if (e.kind === "link") window.open(e.target, "_blank", "noopener,noreferrer");
  };
  const busy = loading || (sub === "trust" && trustLoading);

  return (
    <div className="panel">
      {/* 两层导航：会话面板标签 → 这里的子页标签。计数并进标签，没有 KPI 条（设计稿 5.2） */}
      <Tabs<Sub>
        label="研究记录"
        data-tabs="research"
        value={sub}
        onChange={setSub}
        items={[
          { value: "state", label: "状态" },
          { value: "runs", label: "运行", count: data ? data.runs.length : null, icon: running > 0 ? <Dot tone="live" label={`${running} 个运行在进行`} /> : undefined },
          { value: "claims", label: "结论", count: data ? claims.length : null },
          { value: "trust", label: "可信度" },
          { value: "ideas", label: "想法", count: data ? ideas.length : null },
          { value: "overview", label: "总览" },
          { value: "notes", label: "记录" },
        ]}
        end={
          <>
            {withPlugin && (
              <Button size="sm" variant="ghost" title={data?.loop.on ? "研究循环在进行：问它现在到哪一步" : "研究循环没在进行：让它接着做"} onClick={() => onCompose(data?.loop.on ? "/research:status" : "/research:resume")}>
                {data?.loop.on ? "问进展" : "接续"}
              </Button>
            )}
            <IconButton label="刷新" size="sm" onClick={refresh}>
              {busy ? <Spinner size={ICON.sm} /> : <RefreshCw size={ICON.sm} />}
            </IconButton>
          </>
        }
      />
      {(data?.loop.blocked || (offline && data) || err) && (
        <div className="panel-notices">
          {data?.loop.blocked && <Notice tone="warn">研究循环在等你：{data.loop.blocked}</Notice>}
          {offline && data && <Notice tone="warn">连不上服务器，下面是最近一次取到的内容。</Notice>}
          {err && <Notice tone="err">{err}</Notice>}
        </div>
      )}
      <ScrollArea className="panel-body" data-body="research">
        {!data && !err && <Loading />}
        {data && sub === "state" && <Doc md={data.state_md} />}
        {data && sub === "trust" && <TrustView trust={trust} error={trustErr} loading={trustLoading} offline={offline} paths={paths} planMd={data.plan_md} onRun={setRun} onFile={openFile} onRetry={retryTrust} />}
        {data && sub === "overview" && <Doc md={data.overview_md ?? data.summary_md} />}
        {data && sub === "notes" && <Doc md={[data.lessons_md, data.log_tail && `---\n\n${data.log_tail}`].filter(Boolean).join("\n\n")} />}
        {data &&
          sub === "runs" &&
          (data.runs.length === 0 ? (
            <Empty title="还没有运行" hint="预登记或探索运行开始后会列在这里。" />
          ) : (
            <div className="list" data-pad="">
              {[...data.runs].reverse().map((r) => (
                <RunRow key={r.run_id} r={r} onOpen={() => setRun(r.run_id)} />
              ))}
            </div>
          ))}
        {data &&
          sub === "claims" &&
          (claims.length === 0 ? (
            <Doc md={data.ledger_md} empty="还没有结论" />
          ) : (
            <div className="items" data-claim-list="">
              {claims.map((c, i) => (
                <div key={i} className="item" data-ledger-claim={c["编号"]}>
                  <div className="item-meta">
                    <span className="mono">{c["编号"]}</span>
                    {c["状态"] && <Badge>{c["状态"]}</Badge>}
                    {c["性质"] && <span>{c["性质"]}</span>}
                    <span className="grow" />
                    {c["日期"] && <span className="nowrap">{c["日期"]}</span>}
                  </div>
                  <div className="item-title">{c["结论"]}</div>
                  {c["证据"] && (
                    <div className="chips">
                      {parseEvidence(c["证据"], paths).map((e, k) => (
                        <EvChip key={k} kind={e.kind} onClick={e.kind === "text" ? undefined : () => openEvidence(e)} title={e.target}>
                          {e.label}
                        </EvChip>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        {data &&
          sub === "ideas" &&
          (ideas.length === 0 ? (
            <Doc md={data.ideas_md} empty="还没有想法" />
          ) : (
            <div className="items" data-idea-list="">
              {ideas.map((c, i) => (
                <div key={i} className="item">
                  <div className="item-meta">
                    <span className="mono">{c["编号"]}</span>
                    <Badge>{c["状态"] || "候选"}</Badge>
                    {[c["簇"], c["类型"]].filter(Boolean).join(" · ")}
                  </div>
                  <div className="item-title">{c["想法"]}</div>
                  {(c["可证伪的预测"] || c["最便宜的判决性检验"]) && (
                    <Facts>
                      {c["可证伪的预测"] && <Fact label="预测">{c["可证伪的预测"]}</Fact>}
                      {c["最便宜的判决性检验"] && <Fact label="检验">{c["最便宜的判决性检验"]}</Fact>}
                    </Facts>
                  )}
                </div>
              ))}
            </div>
          ))}
      </ScrollArea>
    </div>
  );
}

/** 运行列表的一行：编号（等宽）· 说明 · 类型 · 状态（第 4 节）· 时间。一行最多一个有色元素：进行中的点或失败的字。 */
function RunRow({ r, onOpen }: { r: ResearchRun; onOpen: () => void }) {
  const st = runStatus(r.state, r.exit_code);
  const kind = runKind(r.kind);
  const dur = runDuration(r, st.kind === "live");
  return (
    <Row
      data-run={r.run_id}
      onClick={onOpen}
      title={`${r.run_id}${r.note ? `\n${r.note}` : ""}`}
      lead={st.kind === "live" ? <Dot tone="live" label="进行中" /> : <span />}
      name={
        <>
          <span className="mono t-meta">{r.run_id}</span>
          {r.note && <span className="muted"> {r.note}</span>}
        </>
      }
      meta={
        <span className="run-meta-cells">
          {kind.prereg ? <Badge>{kind.label}</Badge> : <span>{kind.label}</span>}
          <span className={st.kind === "failed" ? "tone-err" : st.kind === "ok" || st.kind === "cancelled" ? "secondary" : undefined}>{st.label}</span>
          {dur && <span>{dur}</span>}
          <When iso={r.started_at} />
        </span>
      }
    />
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
  const live = run ? isLiveRun(run.state) : false;

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
  const exit = typeof meta.exit_code === "number" ? meta.exit_code : (run?.exit_code ?? null);
  const st = runStatus(run?.state ?? (typeof meta.status === "string" ? meta.status : null), exit);
  const kind = runKind(run?.kind ?? (typeof meta.kind === "string" ? meta.kind : null));
  const dur = run ? runDuration(run, live) : "";
  // 返回条上的一行元信息：状态 · 类型 · 开始 · 时长。状态按第 4 节上色（只有失败用 err 字，进行中用点）。
  const metaTitle = [st.label, kind.label, run?.started_at ? `开始 ${fmtFull(run.started_at)}` : "", dur && `用时 ${dur}`].filter(Boolean).join(" · ");

  return (
    <div className="panel">
      <div className="panel-bar" data-back="">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={ICON.sm} />} data-back="" onClick={onBack} title="回到运行列表">
          运行
        </Button>
        <span className="mono clip-start run-id" title={runId}>
          <bdi>{runId}</bdi>
        </span>
        <span className="run-meta-line" title={metaTitle} data-run-meta="">
          {st.kind === "live" && <Dot tone="live" label="进行中" />}
          <span className={st.kind === "failed" ? "tone-err" : undefined}>{st.label}</span>
          <span className="dot-sep">{kind.label}</span>
          {run?.started_at && (
            <span className="dot-sep">
              <When iso={run.started_at} />
            </span>
          )}
          {dur && <span className="dot-sep">{dur}</span>}
        </span>
        <IconButton label="引用到消息" size="sm" onClick={() => onQuote({ path: `${home}/runs/${runId}` })}>
          <Quote size={ICON.sm} />
        </IconButton>
      </div>
      <Tabs<RunTab>
        label="运行详情"
        data-tabs="run"
        value={tab}
        onChange={setTab}
        items={[
          { value: "log", label: "日志" },
          { value: "metrics", label: "指标", count: metrics.length || null },
          { value: "result", label: "结果页" },
          { value: "env", label: "环境" },
          { value: "inputs", label: "输入", count: inputs?.length || null },
          { value: "outputs", label: "输出", count: outputs.value?.files.length || null },
          { value: "meta", label: "元数据" },
        ]}
      />
      {err && (
        <div className="panel-notices">
          <Notice tone="err">{err}</Notice>
        </div>
      )}
      <ScrollArea
        className="panel-body"
        data-body="run"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!d && !err && <Loading />}
        {d && tab === "log" && (d.log_tail.trim() ? <pre ref={logRef} className="log">{d.log_tail}</pre> : <Empty title="没有日志" />)}
        {d &&
          tab === "metrics" &&
          (metrics.length === 0 ? (
            <Empty title="没有 metrics.json" />
          ) : (
            <Table density="panel" className="data-tbl">
              <tbody>
                {metrics.map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono">{k}</td>
                    <td className="num">{v}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ))}
        {d &&
          tab === "result" &&
          (d.result_md?.trim() ? (
            <div className="pad">
              <Markdown text={d.result_md} images="link" />
            </div>
          ) : (
            <Empty title="没有结果页" />
          ))}
        {d && tab === "env" && <EnvView env={env.value} bad={env.bad} meta={meta} live={live} />}
        {d && tab === "inputs" && <InputsView inputs={inputs} meta={meta} paths={paths} onFile={onFile} />}
        {d && tab === "outputs" && <OutputsView outputs={outputs.value} bad={outputs.bad} meta={meta} live={live} paths={paths} onFile={onFile} />}
        {d && tab === "meta" && (
          <div className="pad stack" data-run-facts="">
            {/* 命令、提交、预登记、主机：原来顶部的事实芯片，放到元数据页（设计稿 5.2：顶部不再用事实芯片） */}
            <Facts>
              <Fact label="命令">{cmd ? <code className="cmd-text">{cmd}</code> : <span className="muted">—</span>}</Fact>
              <Fact label="提交">
                {commit ? (
                  <span title={meta.git_dirty ? "启动时有未提交改动" : undefined}>
                    <span className="mono">{commit}</span>
                    {meta.git_dirty ? <span className="tone-warn"> · 启动时有未提交改动</span> : null}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </Fact>
              <Fact label="预登记">
                {preregPaths(meta).length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  <div className="chips">
                    {preregPaths(meta).map((p, i) => {
                      // meta.prereg[].path 相对仓库根（不在仓库里时为绝对路径，rk.py 的 run 记录）；旧服务端没有 repo_prefix 时，
                      // 退而按研究目录下的 prereg/… 找。都经路径出口，和其他出处一致（审查 P4F2-02）。
                      const tail = /(?:^|\/)(prereg\/[^/].*)$/.exec(p);
                      const rel = previewPath(p, "repo", paths) ?? (tail ? previewPath(tail[1], "home", paths) : null);
                      return (
                        <EvChip key={i} kind={rel ? "file" : "text"} onClick={rel ? () => onFile(rel) : undefined} title={p}>
                          {p.split("/").pop()}
                        </EvChip>
                      );
                    })}
                  </div>
                )}
              </Fact>
              {typeof meta.host === "string" && (
                <Fact label="主机">
                  <span className="mono">{meta.host}</span>
                </Fact>
              )}
            </Facts>
            <pre className="log surface-well">{JSON.stringify(d.meta, null, 2)}</pre>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
