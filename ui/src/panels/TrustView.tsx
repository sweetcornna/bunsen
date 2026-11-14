import { Check, Copy, ExternalLink, FileText, Play, ShieldQuestion, WifiOff } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Markdown } from "../components/Markdown";
import { Button, cx, Dot, Empty, IconButton, Pill, Spinner, type Tone } from "../components/ui";
import type { ApiError, ResearchTrust, ReviewItemType, RkCheck, RkCiteReport, RkCiteStatus, RkClaim, RkIssue, RkPlanStatus, RkReviewStatus, TrustCommand } from "../lib/api";
import { copyText, fullTime, hasKey, relTime } from "../lib/format";
import { previewPath, type PathCtx } from "../lib/paths";
import { auditTone, citeUrl, claimTone, groupIssues, resolveCommand, runTone, splitLoc, strictestAudit, TRUST } from "../lib/research";
import { useApp } from "../lib/store";

const COMMAND: Record<TrustCommand, string> = { check: "rk check", review: "rk review status", cite: "rk cite check", plan: "rk plan status" };
const ITEM_TYPE: Record<ReviewItemType, string> = { action: "动作", number: "数字", citation: "引用", figure: "图表", deliverable: "交付物", excerpt: "摘录", other: "其他" };
const RESULT_REVIEW: Record<RkClaim["results"][number]["review"], { tone: Tone; label: string }> = {
  reviewed: { tone: "ok", label: "已核" },
  blank: { tone: "mute", label: "空白" },
  unreviewed: { tone: "warn", label: "未核" },
  missing: { tone: "err", label: "缺失" },
};
const CITE: Record<RkCiteStatus, { tone: Tone; label: string }> = {
  ok: { tone: "ok", label: "已核实" },
  not_found: { tone: "err", label: "解析不到" },
  retracted: { tone: "err", label: "已撤稿" },
  unchecked: { tone: "warn", label: "未查" },
  error: { tone: "warn", label: "查询出错" },
};
const STEP_TONE = (s: string): Tone => (s.includes("完成") ? "ok" : s.includes("进行") ? "accent" : "mute");
/** 运行状态写成文字，不只靠颜色（审查 P4F1-14）。 */
const RUN_STATE: Record<Tone, string> = { ok: "完成", err: "失败", accent: "进行中", warn: "", mute: "" };
const runStateText = (state: string) => RUN_STATE[runTone(state)] || state || "状态未知";
/** 这两类问题和结论行的“核对”一列说的是同一件事，结论行下面不再重复（审查 P4F1-11）。 */
const SHOWN_IN_REVIEW_COLUMN = new Set(["review.claim_unreviewed", "review.result_unreviewed"]);
/** 未核文件超过这个数时先折起来。 */
const FOLD = 20;

type Open = { run: (id: string) => void; file: (path: string) => void; paths: PathCtx };

type Props = {
  trust: ResearchTrust | null;
  error: ApiError | null;
  loading: boolean;
  /** 会话这次没连上服务器。 */
  offline: boolean;
  paths: PathCtx;
  planMd: string | null | undefined;
  onRun: (id: string) => void;
  onFile: (path: string) => void;
  onRetry: () => void;
};

// 研究面板每 20 秒取一次研究记录，可信度的数据没变时不重新渲染（审查 P4F1-03、04）。
export const TrustView = memo(function TrustView({ trust, error, loading, offline, paths, planMd, onRun, onFile, onRetry }: Props) {
  const open = useMemo<Open>(() => ({ run: onRun, file: onFile, paths }), [onRun, onFile, paths]);
  if (!trust) {
    if (offline && !loading)
      return (
        <Empty icon={<WifiOff size={20} />} title="连不上服务器" hint="这个对话所在的服务器这次没连上，取不到可信度。">
          <Button onClick={onRetry}>重试</Button>
        </Empty>
      );
    if (error && !loading)
      return (
        <Empty icon={<ShieldQuestion size={20} />} title={`取不到可信度：${error.message}`} hint={error.hint}>
          <Button onClick={onRetry}>重试</Button>
        </Empty>
      );
    return <Empty title={<Spinner />} hint="在服务器上依次执行 rk check、rk review status、rk cite check、rk plan status，慢的时候要一两分钟。" />;
  }
  if (!trust.available)
    return (
      <Empty icon={<ShieldQuestion size={20} />} title="看不到可信度" hint={trust.reason ?? "这台机器上的研究工具不可用"}>
        <Button loading={loading} onClick={onRetry}>
          再看一次
        </Button>
      </Empty>
    );
  return (
    <div className="trust">
      <Summary trust={trust} loading={loading} />
      {error && (
        <div className="note err">
          刷新没有完成：{error.message}。下面是 {fullTime(trust.checked_at)} 的结果。
        </div>
      )}
      {trust.failures.map((f, i) => (
        <div key={i} className="note err">
          <b>{hasKey(COMMAND, f.command) ? COMMAND[f.command] : f.command}</b> 没有结果：{f.message}
        </div>
      ))}
      <ClaimsSection check={trust.check} cite={trust.cite} open={open} />
      <ReviewSection review={trust.review} open={open} />
      <IssuesSection check={trust.check} open={open} />
      <PlanSection plan={trust.plan} failed={trust.failures.some((f) => f.command === "plan")} planMd={planMd} open={open} />
    </div>
  );
});

function Stat({ n, label, tone }: { n: number | null; label: string; tone: Tone }) {
  return (
    <span className="stat">
      <b className={n === null ? "dim" : n > 0 && tone !== "mute" ? `c-${tone}` : undefined}>{n ?? "—"}</b>
      {label}
    </span>
  );
}

function Summary({ trust, loading }: { trust: ResearchTrust; loading: boolean }) {
  const claims = trust.check?.claims ?? null;
  const by = (t: RkClaim["trust"]) => (claims ? claims.filter((c) => c.trust === t).length : null);
  const unreviewed = trust.review ? trust.review.files.filter((f) => f.state === "unreviewed").length : null;
  const cites = trust.cite?.items ?? null;
  const citeBad = cites ? cites.filter((c) => c.status === "not_found").length : null;
  const retracted = cites ? cites.filter((c) => c.status === "retracted").length : null;
  return (
    <div className="trust-sum">
      <div className="stats">
        <Stat n={claims?.length ?? null} label="条结论" tone="mute" />
        <Stat n={by("ok")} label="可信" tone="mute" />
        <Stat n={by("warn")} label="存疑" tone="warn" />
        <Stat n={by("fail")} label="不可信" tone="err" />
        <span className="stat-sep" />
        <Stat n={trust.review?.open_fails.length ?? null} label="未关闭问题" tone="err" />
        <Stat n={unreviewed} label="未核文件" tone="warn" />
        <Stat n={citeBad} label="引用解析不到" tone="err" />
        <Stat n={retracted} label="已撤稿" tone="err" />
      </div>
      <span className="dim trust-when" title={fullTime(trust.checked_at)}>
        {loading && <Spinner size={11} />}
        {trust.rk_version && <span className="mono">rk {trust.rk_version}</span>}
        {relTime(trust.checked_at) || fullTime(trust.checked_at)}核对
      </span>
    </div>
  );
}

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="trust-sec">
      <h4>
        {title}
        {extra}
      </h4>
      {children}
    </section>
  );
}

/** 一个研究目录里的出处：runs/<ID> 点开运行详情；其余经路径出口换算，能预览的点开预览。 */
function FileRef({ path, line, open, label }: { path: string; line?: number | null; open: Open; label?: ReactNode }) {
  const run = /^runs\/([A-Za-z0-9._-]{1,64})\/?$/.exec(path);
  const text = label ?? `${path}${line ? `:${line}` : ""}`;
  if (run)
    return (
      <button type="button" className="ev run" onClick={() => open.run(run[1])} title="打开运行详情">
        <Play size={10} />
        {text}
      </button>
    );
  const rel = /\.[A-Za-z0-9]+$/.test(path) ? previewPath(path, "home", open.paths) : null;
  if (rel)
    return (
      <button type="button" className="ev file" onClick={() => open.file(rel)} title={`打开 ${path}`}>
        <FileText size={10} />
        {text}
      </button>
    );
  return <span className="ev text">{text}</span>;
}

function ClaimsSection({ check, cite, open }: { check: RkCheck | null; cite: RkCiteReport | null; open: Open }) {
  const titles = useMemo(() => new Map((cite?.items ?? []).map((c) => [c.id, c.title])), [cite]);
  // 编号 → 指向它的错误、警告（审查 P4F1-04：建一次表，不在每一行里扫全部问题）。
  const issuesByRef = useMemo(() => {
    const m = new Map<string, { e: RkIssue; err: boolean }[]>();
    if (!check) return m;
    const add = (e: RkIssue, err: boolean) => {
      if (!e.ref || SHOWN_IN_REVIEW_COLUMN.has(e.code)) return;
      const list = m.get(e.ref);
      if (list) list.push({ e, err });
      else m.set(e.ref, [{ e, err }]);
    };
    for (const e of check.errors) add(e, true);
    for (const w of check.warnings) add(w, false);
    return m;
  }, [check]);
  if (!check)
    return (
      <Section title="结论">
        <div className="card-hint">rk check 没有结果，列不出结论。</div>
      </Section>
    );
  return (
    <Section title="结论" extra={<span className="dim">{check.claims.length}</span>}>
      {check.claims.length === 0 ? (
        <div className="card-hint">账本里还没有结论。</div>
      ) : (
        <div className="table-wrap">
          <table className="table trust-table">
            <thead>
              <tr>
                <th>编号</th>
                <th>状态</th>
                <th>结论</th>
                <th>推断审计</th>
                <th>核对</th>
                <th>证据运行</th>
                <th>引用</th>
                <th>可信度</th>
              </tr>
            </thead>
            <tbody>
              {check.claims.map((c, ci) => (
                <ClaimRow key={`${ci}:${c.id}`} c={c} issues={c.id ? issuesByRef.get(c.id) : undefined} titles={titles} open={open} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function ClaimRow({ c, issues, titles, open }: { c: RkClaim; issues: { e: RkIssue; err: boolean }[] | undefined; titles: Map<string, string | null>; open: Open }) {
  const audit = strictestAudit(c.runs);
  const t = hasKey(TRUST, c.trust) ? TRUST[c.trust] : { tone: "mute" as const, label: c.trust || "—" };
  const auditDetail = c.runs.map((r) => `${r.run_id}：${r.audit ?? "未审"}`).join("\n") || "没有证据运行";
  return (
    <tr>
      <td className="mono nowrap">{c.id || <span className="dim">—</span>}</td>
      <td className="nowrap">{c.status ? <Pill tone={claimTone(c.status)}>{c.status}</Pill> : <span className="dim">—</span>}</td>
      <td className="cell-text c-text">
        <div>{c.text}</div>
        {c.kind && <span className="tag">{c.kind}</span>}
        {issues && issues.length > 0 && (
          <ul className="claim-issues">
            {issues.map(({ e, err }, i) => (
              <li key={i} className={err ? "c-err" : "c-warn"}>
                {e.message}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="nowrap" data-label="推断审计" title={auditDetail}>
        <div>
          <Pill tone={auditTone(audit.verdict)}>{audit.verdict ?? "未审"}</Pill>
          {audit.verdict && audit.unaudited > 0 && <div className="dim">另 {audit.unaudited} 条未审</div>}
          {/* 逐条明细：悬停看 title，读屏读这段视觉隐藏的文字（generic 元素上的 aria-label 读屏不读，审查 P4F2-03） */}
          <span className="sr-only">逐条：{auditDetail.replace(/\n/g, "；")}</span>
        </div>
      </td>
      <td data-label="核对">
        <div>
          <div className="nowrap">{c.review === "reviewed" ? <span className="c-ok">账本行已核</span> : <span className="c-warn">账本行未核</span>}</div>
          {c.results.length > 0 && (
            <div className="chips">
              {c.results.map((r, i) => {
                const st = hasKey(RESULT_REVIEW, r.review) ? RESULT_REVIEW[r.review] : { tone: "mute" as const, label: r.review || "状态未知" };
                const name = r.path.split("/").pop() || r.path;
                const rel = r.review === "missing" ? null : previewPath(r.path, "home", open.paths);
                const title = `${r.path}：${st.label}${r.open_fails ? `，${r.open_fails} 个未关闭问题` : ""}`;
                const body = (
                  <>
                    {rel && <FileText size={10} />}
                    {name} · {st.label}
                    {r.open_fails > 0 && ` · ${r.open_fails} 问题`}
                  </>
                );
                return rel ? (
                  <button key={`${i}:${r.path}`} type="button" className={cx("ev file", `t-${st.tone}`)} onClick={() => open.file(rel)} title={title}>
                    {body}
                  </button>
                ) : (
                  <span key={`${i}:${r.path}`} className={cx("ev text", `t-${st.tone}`)} title={title}>
                    {body}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </td>
      <td data-label="证据运行">
        {c.runs.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          <div className="chips">
            {c.runs.map((r, i) => {
              const state = runStateText(r.state);
              const label = `${r.run_id}，${state}，推断审计${r.audit ? `：${r.audit}` : "：未审"}`;
              return (
                <button key={`${i}:${r.run_id}`} type="button" className="ev run" onClick={() => open.run(r.run_id)} title={label} aria-label={`打开运行 ${label}`}>
                  <Dot tone={runTone(r.state)} />
                  {r.run_id}
                  {runTone(r.state) !== "ok" && ` · ${state}`}
                </button>
              );
            })}
          </div>
        )}
      </td>
      <td data-label="引用">
        {c.citations.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          <div className="chips">
            {c.citations.map((x, i) => {
              const st = hasKey(CITE, x.status) ? CITE[x.status] : { tone: "mute" as const, label: x.status || "状态未知" };
              const url = citeUrl(x.id);
              const title = [titles.get(x.id), st.label].filter(Boolean).join("\n");
              return url ? (
                <button key={`${i}:${x.id}`} type="button" className={cx("ev link", `t-${st.tone}`)} onClick={() => window.open(url, "_blank", "noopener,noreferrer")} title={title}>
                  <ExternalLink size={10} />
                  {x.id}
                  {x.status !== "ok" && ` · ${st.label}`}
                </button>
              ) : (
                <span key={`${i}:${x.id}`} className={cx("ev text", `t-${st.tone}`)} title={title}>
                  {x.id} · {st.label}
                </span>
              );
            })}
          </div>
        )}
      </td>
      <td className="nowrap c-trust">
        <Pill tone={t.tone}>{t.label}</Pill>
      </td>
    </tr>
  );
}

function ReviewSection({ review, open }: { review: RkReviewStatus | null; open: Open }) {
  const toast = useApp((s) => s.toast);
  const [all, setAll] = useState(false);
  if (!review)
    return (
      <Section title="未关闭的问题">
        <div className="card-hint">rk review status 没有结果。</div>
      </Section>
    );
  const unreviewed = review.files.filter((f) => f.state === "unreviewed");
  const shownFiles = all ? unreviewed : unreviewed.slice(0, FOLD);
  const home = open.paths.home;
  const copy = (ref: string) => void copyText(resolveCommand(home, ref)).then((ok) => toast(ok ? "ok" : "err", ok ? "已复制关闭命令" : "复制失败", ok ? "把 … 换成关闭的理由，在这个对话的工作目录里执行。" : null));
  return (
    <Section title="未关闭的问题" extra={<span className="dim">{review.open_fails.length}</span>}>
      {review.open_fails.length === 0 ? (
        <div className="card-hint">审计员核出的问题都已关闭。</div>
      ) : (
        <div className="fails">
          {review.open_fails.map((f, i) => (
            <div key={`${i}:${f.ref}`} className="fail">
              <div className="fail-head">
                <FileRef path={f.file} line={f.line} open={open} />
                {f.row && <span className="tag mono">{f.row}</span>}
                <span className="tag">{hasKey(ITEM_TYPE, f.type) ? ITEM_TYPE[f.type] : f.type || "其他"}</span>
                <span className="grow" />
                <span className="dim nowrap" title={`${f.review_id} · ${fullTime(f.recorded_at)}`}>
                  {relTime(f.recorded_at)}
                </span>
              </div>
              <div className="fail-claim">{f.claim}</div>
              {f.note && <div className="fail-note">{f.note}</div>}
              {f.evidence.length > 0 && (
                <div className="chips">
                  {f.evidence.map((e, k) => (
                    <span key={k} className="ev text" title={e}>
                      {e}
                    </span>
                  ))}
                </div>
              )}
              {f.ref && (
                <div className="fail-cmd">
                  <code className="run-cmd">{resolveCommand(home, f.ref)}</code>
                  <IconButton label="复制关闭命令" onClick={() => copy(f.ref)}>
                    <Copy size={13} />
                  </IconButton>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="trust-sub">
        <span className="dim">未核的结论文件 {unreviewed.length}</span>
        {unreviewed.length === 0 ? (
          <span className="c-ok">
            <Check size={11} /> 都核过了
          </span>
        ) : (
          <div className="chips">
            {shownFiles.map((f, i) => (
              <FileRef key={`${i}:${f.path}`} path={f.path} open={open} label={`${f.path}${f.last_review ? " · 核过后改过" : ""}`} />
            ))}
            {unreviewed.length > FOLD && (
              <button type="button" className="link-btn" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                {all ? "收起" : `另 ${unreviewed.length - FOLD} 个`}
              </button>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function IssueRow({ level, issue, open }: { level: "error" | "warning" | "note"; issue: RkIssue; open: Open }) {
  const loc = issue.file ? splitLoc(issue.file) : null;
  return (
    <div className="issue">
      <span className={cx("issue-level", level === "error" ? "c-err" : level === "warning" ? "c-warn" : "dim")}>{level === "error" ? "错误" : level === "warning" ? "警告" : "提示"}</span>
      <div className="issue-body">
        <div>{issue.message}</div>
        <div className="issue-meta">
          <span className="mono dim">{issue.code}</span>
          {loc && <FileRef path={loc.path} line={loc.line} open={open} />}
          {issue.ref && <span className="tag mono">{issue.ref}</span>}
        </div>
      </div>
    </div>
  );
}

function IssuesSection({ check, open }: { check: RkCheck | null; open: Open }) {
  const [notes, setNotes] = useState(false);
  const groups = useMemo(() => (check ? groupIssues(check.errors, check.warnings) : []), [check]);
  if (!check)
    return (
      <Section title="rk check">
        <div className="card-hint">rk check 没有结果。</div>
      </Section>
    );
  return (
    <Section
      title="rk check"
      extra={
        <span className="dim">
          {check.errors.length} 个错误 · {check.warnings.length} 个警告
        </span>
      }
    >
      {groups.length === 0 ? (
        <div className="card-hint">没有错误和警告。</div>
      ) : (
        groups.map((g) => (
          <div key={g.prefix || "other"} className="issue-group">
            <div className="issue-group-head">
              {g.label}
              <span className="dim">{g.items.length}</span>
            </div>
            {g.items.map((it, i) => (
              <IssueRow key={i} level={it.level} issue={it.issue} open={open} />
            ))}
          </div>
        ))
      )}
      {check.notes.length > 0 && (
        <div className="issue-group">
          <button type="button" className="link-btn" onClick={() => setNotes((v) => !v)} aria-expanded={notes}>
            {notes ? "收起提示" : `另有 ${check.notes.length} 条提示`}
          </button>
          {notes && check.notes.map((n, i) => <IssueRow key={i} level="note" issue={n} open={open} />)}
        </div>
      )}
    </Section>
  );
}

function PlanSection({ plan, failed, planMd, open }: { plan: RkPlanStatus | null; failed: boolean; planMd: string | null | undefined; open: Open }) {
  const [raw, setRaw] = useState(false);
  const rawToggle = planMd?.trim() ? (
    <button type="button" className="link-btn" onClick={() => setRaw((v) => !v)} aria-expanded={raw}>
      {raw ? "收起 PLAN.md" : "看 PLAN.md 原文"}
    </button>
  ) : null;
  const body = !plan ? (
    <div className="card-hint">{failed ? "rk plan status 没有结果。" : "没有计划信息。"}</div>
  ) : !plan.present ? (
    <div className="card-hint">还没有研究计划（PLAN.md 里没有步骤）。</div>
  ) : (
    <>
      <div className="chips plan-state">
        {plan.approved ? <Pill tone="ok">已批准{plan.approved_at ? ` · ${relTime(plan.approved_at)}` : ""}</Pill> : <Pill tone="warn">还没批准</Pill>}
        {plan.approved && (plan.changed_since_approval ? <Pill tone="warn">批准后改过</Pill> : <Pill tone="mute">批准后没改过</Pill>)}
        {plan.approved && plan.deviations_since_approval > 0 && <span className="tag">批准后记了 {plan.deviations_since_approval} 条偏离</span>}
      </div>
      {plan.phases.map((ph, i) => (
        <div key={i} className="plan-phase">
          <div className="issue-group-head">{ph.title}</div>
          {ph.steps.length === 0 ? (
            <div className="card-hint">这个阶段还没有步骤。</div>
          ) : (
            <div className="table-wrap">
              <table className="table plan-table">
                <thead>
                  <tr>
                    <th>编号</th>
                    <th>步骤与交付物</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {ph.steps.map((s, si) => {
                    const done = s.status.includes("完成");
                    return (
                      <tr key={`${si}:${s.id}`}>
                        <td className="mono nowrap">{s.id}</td>
                        <td className="cell-text">
                          <div>{s.step}</div>
                          {(s.prereg || s.deliverables.length > 0) && (
                            <div className="chips">
                              {s.prereg && (
                                <span className="ev text" title="预登记">
                                  {s.prereg}
                                </span>
                              )}
                              {s.deliverables.map((d, di) => {
                                // 找到了的交付物（resolved，相对仓库根或绝对路径，Q9）经路径出口换算后可以预览。
                                const rel = d.exists && d.resolved ? previewPath(d.resolved, "repo", open.paths) : null;
                                const cls = cx(rel ? "ev file" : "ev text", d.exists ? "t-ok" : done ? "t-err" : undefined);
                                const title = `交付物 ${d.path}：${d.exists ? (rel ? "存在，点开预览" : "存在") : done ? "步骤已完成，交付物却不存在" : "还没有"}`;
                                const body = (
                                  <>
                                    {d.exists ? <Check size={10} /> : null}
                                    {d.path}
                                    {!d.exists && (done ? " · 缺失" : " · 还没有")}
                                  </>
                                );
                                return rel ? (
                                  <button key={`${di}:${d.path}`} type="button" className={cls} onClick={() => open.file(rel)} title={title}>
                                    {body}
                                  </button>
                                ) : (
                                  <span key={`${di}:${d.path}`} className={cls} title={title}>
                                    {body}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </td>
                        <td className="nowrap">
                          <Pill tone={STEP_TONE(s.status)}>{s.status || "—"}</Pill>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </>
  );
  return (
    <Section title="计划" extra={rawToggle && <span className="grow-right">{rawToggle}</span>}>
      {body}
      {raw && planMd && (
        <div className="plan-raw">
          {/* PLAN.md 来自服务器：图片不自动加载，只给链接 */}
          <Markdown text={planMd} images="link" />
        </div>
      )}
    </Section>
  );
}
