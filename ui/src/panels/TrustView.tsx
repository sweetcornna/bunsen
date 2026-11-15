import { Check, ChevronRight, Copy, ExternalLink, FileText, Play, ShieldQuestion, WifiOff } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Markdown } from "../components/Markdown";
import { Badge, Button, Empty, EmptyLine, Fact, Facts, GroupTitle, ICON, IconButton, Loading, Notice, Row, Section, Spinner, Table, When, type BadgeTone } from "../components/ui";
import type { ApiError, ResearchTrust, ReviewItemType, RkCheck, RkCiteReport, RkCiteStatus, RkClaim, RkIssue, RkPlanStatus, RkReviewStatus, TrustCommand } from "../lib/api";
import { copyText, fmtFull, hasKey } from "../lib/format";
import { BAD_SEGMENT_WHY, hasBadSegment, previewPath, visiblePath, type PathCtx } from "../lib/paths";
import { auditTone, citeUrl, groupIssues, resolveCommand, runStatus, splitLoc, strictestAudit, TRUST } from "../lib/research";
import { useApp } from "../lib/store";

const COMMAND: Record<TrustCommand, string> = { check: "rk check", review: "rk review status", cite: "rk cite check", plan: "rk plan status" };
const ITEM_TYPE: Record<ReviewItemType, string> = { action: "动作", number: "数字", citation: "引用", figure: "图表", deliverable: "交付物", excerpt: "摘录", other: "其他" };
/** 结果页的核对状态。已核、空白是正常的，用中性；未核 warn；缺失 err（第 0 节原则 3）。 */
const RESULT_REVIEW: Record<RkClaim["results"][number]["review"], { tone: BadgeTone; label: string }> = {
  reviewed: { tone: "neutral", label: "已核" },
  blank: { tone: "neutral", label: "空白" },
  unreviewed: { tone: "warn", label: "未核" },
  missing: { tone: "err", label: "缺失" },
};
const CITE: Record<RkCiteStatus, { tone: BadgeTone; label: string }> = {
  ok: { tone: "neutral", label: "已核实" },
  not_found: { tone: "err", label: "解析不到" },
  retracted: { tone: "err", label: "已撤稿" },
  unchecked: { tone: "warn", label: "未查" },
  error: { tone: "warn", label: "查询出错" },
};
/** 这两类问题和结论的“核对”一项说的是同一件事，结论下面不再重复（审查 P4F1-11）。 */
const SHOWN_IN_REVIEW_COLUMN = new Set(["review.claim_unreviewed", "review.result_unreviewed"]);
/** 未核文件超过这个数时先折起来。 */
const FOLD = 20;

/**
 * 证据和出处芯片：能打开的是 xs 次要按钮，打不开的是徽标（只显示文字）。
 * data-ev 标明种类：run（运行详情）、file（文件预览）、link（外部链接）、text（不能点）。
 */
export function EvChip({ kind, onClick, title, label, tone, children }: { kind: "run" | "file" | "link" | "text"; onClick?: () => void; title?: string; label?: string; tone?: BadgeTone; children: ReactNode }) {
  if (kind === "text" || !onClick)
    return (
      <Badge data-ev="text" tone={tone} title={title}>
        {children}
      </Badge>
    );
  const Icon = kind === "run" ? Play : kind === "file" ? FileText : ExternalLink;
  return (
    <Button size="xs" data-ev={kind} icon={<Icon size={ICON.xs} />} onClick={onClick} title={title} aria-label={label}>
      {children}
    </Button>
  );
}

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
        <Empty icon={<WifiOff size={ICON.lg} />} title="连不上服务器" hint="这个对话所在的服务器这次没连上，取不到可信度。">
          <Button onClick={onRetry}>重试</Button>
        </Empty>
      );
    if (error && !loading)
      return (
        <Empty icon={<ShieldQuestion size={ICON.lg} />} title={`取不到可信度：${error.message}`} hint={error.hint}>
          <Button onClick={onRetry}>重试</Button>
        </Empty>
      );
    return <Loading hint="在服务器上依次执行 rk check、rk review status、rk cite check、rk plan status，慢的时候要一两分钟。" />;
  }
  if (!trust.available)
    return (
      <Empty icon={<ShieldQuestion size={ICON.lg} />} title="看不到可信度" hint={trust.reason ?? "这台机器上的研究工具不可用"}>
        <Button loading={loading} onClick={onRetry}>
          再看一次
        </Button>
      </Empty>
    );
  return (
    <div className="sections panel-sections" data-trust="">
      <Summary trust={trust} loading={loading} />
      {(error || trust.failures.length > 0) && (
        <div className="stack">
          {error && (
            <Notice tone="err" data-failure="refresh">
              刷新没有完成：{error.message}。下面是 {fmtFull(trust.checked_at)} 的结果。
            </Notice>
          )}
          {trust.failures.map((f, i) => {
            const [first, ...rest] = f.message.split("\n");
            return (
              <Notice key={i} tone="err" data-failure={f.command} raw={rest.length > 0 ? f.message : null}>
                <b>{hasKey(COMMAND, f.command) ? COMMAND[f.command] : f.command}</b> 没有结果：{first}
              </Notice>
            );
          })}
        </div>
      )}
      <ClaimsSection check={trust.check} cite={trust.cite} open={open} />
      <ReviewSection review={trust.review} open={open} />
      <IssuesSection check={trust.check} open={open} />
      <PlanSection plan={trust.plan} failed={trust.failures.some((f) => f.command === "plan")} planMd={planMd} open={open} />
    </div>
  );
});

/** 一个计数：没有结果时写“—”；err 为真且大于 0 时上色（每行只有一个上色的数）。 */
function Num({ n, label, err }: { n: number | null; label: string; err?: boolean }) {
  return (
    <span>
      <b className={err && n !== null && n > 0 ? "tone-err" : undefined}>{n ?? "—"}</b> {label}
    </span>
  );
}

/** 汇总两行文字：结论按可信度分，只有“不可信”上色；问题按种类分，只有“未关闭问题”上色。 */
function Summary({ trust, loading }: { trust: ResearchTrust; loading: boolean }) {
  const claims = trust.check?.claims ?? null;
  const by = (t: RkClaim["trust"]) => (claims ? claims.filter((c) => c.trust === t).length : null);
  const unreviewed = trust.review ? trust.review.files.filter((f) => f.state === "unreviewed").length : null;
  const cites = trust.cite?.items ?? null;
  const citeBad = cites ? cites.filter((c) => c.status === "not_found").length : null;
  const retracted = cites ? cites.filter((c) => c.status === "retracted").length : null;
  return (
    <div className="trust-summary" data-trust-summary="">
      <div className="trust-summary-line">
        <Num n={claims?.length ?? null} label="条结论" />：<Num n={by("ok")} label="可信" /> · <Num n={by("warn")} label="存疑" /> · <Num n={by("fail")} label="不可信" err />
      </div>
      <div className="trust-summary-line">
        <Num n={trust.review?.open_fails.length ?? null} label="未关闭问题" err /> · <Num n={unreviewed} label="未核文件" /> · <Num n={citeBad} label="引用解析不到" /> · <Num n={retracted} label="已撤稿" />
      </div>
      <div className="trust-when">
        {loading && <Spinner size={ICON.xs} />}
        {trust.rk_version && <span className="mono">rk {trust.rk_version}</span>}
        <span>
          <When iso={trust.checked_at} /> 核对
        </span>
      </div>
    </div>
  );
}

/** 一个研究目录里的出处：runs/<ID> 点开运行详情；其余经路径出口换算，能预览的点开预览，不能的显示转义后的文字。 */
function FileRef({ path, line, open, label }: { path: string; line?: number | null; open: Open; label?: string }) {
  const run = /^runs\/([A-Za-z0-9._-]{1,64})\/?$/.exec(path);
  const text = label ?? `${visiblePath(path)}${line ? `:${line}` : ""}`;
  if (run)
    return (
      <EvChip kind="run" onClick={() => open.run(run[1])} title="打开运行详情">
        {text}
      </EvChip>
    );
  const rel = /\.[A-Za-z0-9]+$/.test(path) ? previewPath(path, "home", open.paths) : null;
  if (rel)
    return (
      <EvChip kind="file" onClick={() => open.file(rel)} title={`打开 ${path}`}>
        {text}
      </EvChip>
    );
  return (
    <EvChip kind="text" title={hasBadSegment(path) ? BAD_SEGMENT_WHY : path}>
      {text}
    </EvChip>
  );
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
      <Section title="结论" data-section="claims">
        <EmptyLine>rk check 没有结果，列不出结论。</EmptyLine>
      </Section>
    );
  return (
    <Section title="结论" count={check.claims.length} data-section="claims">
      {check.claims.length === 0 ? (
        <EmptyLine>账本里还没有结论。</EmptyLine>
      ) : (
        <div className="list" data-claims="">
          {check.claims.map((c, ci) => (
            <ClaimRow key={`${ci}:${c.id}`} c={c} issues={c.id ? issuesByRef.get(c.id) : undefined} titles={titles} open={open} />
          ))}
        </div>
      )}
    </Section>
  );
}

/**
 * 每条结论一行：编号 · 结论（截断）· 可信度徽标（可信不显示）· 展开箭头。
 * 展开后用 Facts 列出状态、可信度、推断审计（逐条明细是可见文字，审查 P4F2-03）、核对、证据运行、引用、相关问题。
 */
const ClaimRow = memo(function ClaimRow({ c, issues, titles, open }: { c: RkClaim; issues: { e: RkIssue; err: boolean }[] | undefined; titles: Map<string, string | null>; open: Open }) {
  const [expanded, setExpanded] = useState(false);
  const t = hasKey(TRUST, c.trust) ? TRUST[c.trust] : { tone: "neutral" as const, label: c.trust || "—" };
  return (
    <div className="claim-row" data-claim={c.id} data-open={expanded ? "" : undefined}>
      <Row
        name={
          <>
            <span className="mono muted">{c.id || "—"}</span> {c.text}
          </>
        }
        meta={
          <>
            {t.tone !== "neutral" && <Badge tone={t.tone}>{t.label}</Badge>}
            <ChevronRight size={ICON.md} className="claim-chev" aria-hidden />
          </>
        }
        title={c.text}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded && <ClaimDetail c={c} t={t} issues={issues} titles={titles} open={open} />}
    </div>
  );
});

function ClaimDetail({ c, t, issues, titles, open }: { c: RkClaim; t: { tone: BadgeTone; label: string }; issues: { e: RkIssue; err: boolean }[] | undefined; titles: Map<string, string | null>; open: Open }) {
  const audit = strictestAudit(c.runs);
  const auditTo = auditTone(audit.verdict);
  const auditDetail = c.runs.map((r) => `${r.run_id}：${r.audit ?? "未审"}`).join("；");
  return (
    <div className="claim-detail">
      <div className="claim-text-full">{c.text}</div>
      <Facts>
        <Fact label="状态" data-fact="status">
          {c.status || <span className="muted">—</span>}
          {c.kind && <span className="muted"> · {c.kind}</span>}
        </Fact>
        <Fact label="可信度" data-fact="trust">
          <span className={t.tone === "err" ? "tone-err" : t.tone === "warn" ? "tone-warn" : undefined}>{t.label}</span>
        </Fact>
        <Fact label="推断审计" data-fact="audit">
          <div>
            <span className={auditTo === "err" ? "tone-err" : auditTo === "warn" ? "tone-warn" : undefined}>{audit.verdict ?? "未审"}</span>
            {audit.verdict && audit.unaudited > 0 && <span className="muted"> · 另 {audit.unaudited} 条未审</span>}
          </div>
          {/* 逐条明细是可见文字（审查 P4F2-03；设计稿 5.2：不只放在 title 里） */}
          <div className="muted" data-audit-detail="">逐条：{auditDetail || "没有证据运行"}</div>
        </Fact>
        <Fact label="核对" data-fact="review">
          <div className={c.review === "reviewed" ? undefined : "tone-warn"}>{c.review === "reviewed" ? "账本行已核" : "账本行未核"}</div>
          {c.results.length > 0 && (
            <div className="chips">
              {c.results.map((r, i) => {
                const st = hasKey(RESULT_REVIEW, r.review) ? RESULT_REVIEW[r.review] : { tone: "neutral" as const, label: r.review || "状态未知" };
                const name = r.path.split("/").pop() || r.path;
                const rel = r.review === "missing" ? null : previewPath(r.path, "home", open.paths);
                const bad = hasBadSegment(r.path);
                const title = bad ? BAD_SEGMENT_WHY : `${r.path}：${st.label}${r.open_fails ? `，${r.open_fails} 个未关闭问题` : ""}`;
                return (
                  <EvChip key={`${i}:${r.path}`} kind={rel ? "file" : "text"} tone={rel ? undefined : st.tone} onClick={rel ? () => open.file(rel) : undefined} title={title}>
                    {bad ? visiblePath(name) : name} · {st.label}
                    {r.open_fails > 0 && ` · ${r.open_fails} 问题`}
                  </EvChip>
                );
              })}
            </div>
          )}
        </Fact>
        <Fact label="证据运行" data-fact="runs">
          {c.runs.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <div className="chips">
              {c.runs.map((r, i) => {
                const st = runStatus(r.state);
                const label = `${r.run_id}，${st.label}，推断审计${r.audit ? `：${r.audit}` : "：未审"}`;
                return (
                  <EvChip key={`${i}:${r.run_id}`} kind="run" onClick={() => open.run(r.run_id)} title={label} label={`打开运行 ${label}`}>
                    {r.run_id}
                    {st.kind !== "ok" && ` · ${st.label}`}
                  </EvChip>
                );
              })}
            </div>
          )}
        </Fact>
        <Fact label="引用" data-fact="cite">
          {c.citations.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            <div className="chips">
              {c.citations.map((x, i) => {
                const st = hasKey(CITE, x.status) ? CITE[x.status] : { tone: "neutral" as const, label: x.status || "状态未知" };
                const url = citeUrl(x.id);
                const title = [titles.get(x.id), st.label].filter(Boolean).join("\n");
                return (
                  <EvChip key={`${i}:${x.id}`} kind={url ? "link" : "text"} tone={url ? undefined : st.tone} onClick={url ? () => window.open(url, "_blank", "noopener,noreferrer") : undefined} title={title}>
                    {x.id}
                    {(x.status !== "ok" || !url) && ` · ${st.label}`}
                  </EvChip>
                );
              })}
            </div>
          )}
        </Fact>
        {issues && issues.length > 0 && (
          <Fact label="相关问题" data-fact="issues">
            <div className="claim-issues">
              {issues.map(({ e, err }, i) => (
                <div key={i} className="issue-row">
                  <span className={`issue-severity ${err ? "tone-err" : "tone-warn"}`}>{err ? "错误" : "警告"}</span>
                  <span className="issue-main">{e.message}</span>
                </div>
              ))}
            </div>
          </Fact>
        )}
      </Facts>
    </div>
  );
}

function ReviewSection({ review, open }: { review: RkReviewStatus | null; open: Open }) {
  const toast = useApp((s) => s.toast);
  const [all, setAll] = useState(false);
  if (!review)
    return (
      <Section title="未关闭的问题" data-section="review">
        <EmptyLine>rk review status 没有结果。</EmptyLine>
      </Section>
    );
  const unreviewed = review.files.filter((f) => f.state === "unreviewed");
  const shownFiles = all ? unreviewed : unreviewed.slice(0, FOLD);
  const home = open.paths.home;
  const copy = (ref: string) => void copyText(resolveCommand(home, ref)).then((ok) => toast(ok ? "ok" : "err", ok ? "已复制关闭命令" : "复制失败", ok ? "把 … 换成关闭的理由，在这个对话的工作目录里执行。" : null));
  return (
    <Section title="未关闭的问题" count={review.open_fails.length} data-section="review">
      {review.open_fails.length === 0 ? (
        <EmptyLine>审计员核出的问题都已关闭。</EmptyLine>
      ) : (
        <div className="items" data-fails="">
          {review.open_fails.map((f, i) => (
            <div key={`${i}:${f.ref}`} className="item" data-fail={f.ref}>
              <div className="item-meta">
                <FileRef path={f.file} line={f.line} open={open} />
                {f.row && <Badge mono>{f.row}</Badge>}
                <span>{hasKey(ITEM_TYPE, f.type) ? ITEM_TYPE[f.type] : f.type || "其他"}</span>
                <span className="grow" />
                <span title={f.review_id}>
                  <When iso={f.recorded_at} />
                </span>
              </div>
              <div className="item-title">{f.claim}</div>
              {f.note && <div className="item-text">{f.note}</div>}
              {f.evidence.length > 0 && (
                <div className="chips">
                  {f.evidence.map((e, k) => (
                    <EvChip key={k} kind="text" title={e}>
                      {e}
                    </EvChip>
                  ))}
                </div>
              )}
              {f.ref && (
                <div className="cmd-well surface-well">
                  <code className="mono">{resolveCommand(home, f.ref)}</code>
                  <IconButton label="复制关闭命令" size="sm" onClick={() => copy(f.ref)}>
                    <Copy size={ICON.sm} />
                  </IconButton>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="stack" data-unreviewed="">
        <GroupTitle>未核的结论文件 {unreviewed.length}</GroupTitle>
        {unreviewed.length === 0 ? (
          <EmptyLine>
            <Check size={ICON.xs} /> 都核过了
          </EmptyLine>
        ) : (
          <div className="chips">
            {shownFiles.map((f, i) => (
              <FileRef key={`${i}:${f.path}`} path={f.path} open={open} label={`${visiblePath(f.path)}${f.last_review ? " · 核过后改过" : ""}`} />
            ))}
            {unreviewed.length > FOLD && (
              <Button size="xs" variant="ghost" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                {all ? "收起" : `另 ${unreviewed.length - FOLD} 个`}
              </Button>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

const LEVEL = { error: { label: "错误", cls: "tone-err" }, warning: { label: "警告", cls: "tone-warn" }, note: { label: "提示", cls: "muted" } } as const;

function IssueRow({ level, issue, open }: { level: "error" | "warning" | "note"; issue: RkIssue; open: Open }) {
  const loc = issue.file ? splitLoc(issue.file) : null;
  return (
    <div className="issue-row">
      <span className={`issue-severity ${LEVEL[level].cls}`}>{LEVEL[level].label}</span>
      <div className="issue-main">
        <div>{issue.message}</div>
        <div className="item-meta">
          <span className="mono">{issue.code}</span>
          {loc && <FileRef path={loc.path} line={loc.line} open={open} />}
          {issue.ref && <Badge mono>{issue.ref}</Badge>}
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
      <Section title="rk check" data-section="check">
        <EmptyLine>rk check 没有结果。</EmptyLine>
      </Section>
    );
  return (
    <Section title="rk check" count={`${check.errors.length} 个错误 · ${check.warnings.length} 个警告`} data-section="check">
      {groups.length === 0 ? (
        <EmptyLine>没有错误和警告。</EmptyLine>
      ) : (
        groups.map((g) => (
          <div key={g.prefix || "other"} className="issue-group">
            <GroupTitle>
              {g.label} <span className="muted">{g.items.length}</span>
            </GroupTitle>
            {g.items.map((it, i) => (
              <IssueRow key={i} level={it.level} issue={it.issue} open={open} />
            ))}
          </div>
        ))
      )}
      {check.notes.length > 0 && (
        <div className="issue-group">
          <div>
            <Button size="sm" variant="ghost" onClick={() => setNotes((v) => !v)} aria-expanded={notes}>
              {notes ? "收起提示" : `另有 ${check.notes.length} 条提示`}
            </Button>
          </div>
          {notes && check.notes.map((n, i) => <IssueRow key={i} level="note" issue={n} open={open} />)}
        </div>
      )}
    </Section>
  );
}

function PlanSection({ plan, failed, planMd, open }: { plan: RkPlanStatus | null; failed: boolean; planMd: string | null | undefined; open: Open }) {
  const [raw, setRaw] = useState(false);
  const rawToggle = planMd?.trim() ? (
    <Button size="sm" variant="ghost" onClick={() => setRaw((v) => !v)} aria-expanded={raw}>
      {raw ? "收起 PLAN.md" : "看 PLAN.md 原文"}
    </Button>
  ) : null;
  const body = !plan ? (
    <EmptyLine>{failed ? "rk plan status 没有结果。" : "没有计划信息。"}</EmptyLine>
  ) : !plan.present ? (
    <EmptyLine>还没有研究计划（PLAN.md 里没有步骤）。</EmptyLine>
  ) : (
    <>
      {/* 计划的状态：一行最多一个有色徽标——没批准、批准后改过才用 warn */}
      <div className="plan-status">
        {plan.approved ? (
          <Badge>
            已批准
            {plan.approved_at && (
              <>
                {" · "}
                <When iso={plan.approved_at} />
              </>
            )}
          </Badge>
        ) : (
          <Badge tone="warn">还没批准</Badge>
        )}
        {plan.approved && (plan.changed_since_approval ? <Badge tone="warn">批准后改过</Badge> : <Badge>批准后没改过</Badge>)}
        {plan.approved && plan.deviations_since_approval > 0 && <Badge>批准后记了 {plan.deviations_since_approval} 条偏离</Badge>}
      </div>
      {plan.phases.map((ph, i) => (
        <div key={i} className="plan-phase">
          <GroupTitle>{ph.title}</GroupTitle>
          {ph.steps.length === 0 ? (
            <EmptyLine>这个阶段还没有步骤。</EmptyLine>
          ) : (
            <Table density="panel" data-plan-table="">
              <thead>
                <tr>
                  <th className="shrink">编号</th>
                  <th>步骤与交付物</th>
                  <th className="shrink">状态</th>
                </tr>
              </thead>
              <tbody>
                {ph.steps.map((s, si) => {
                  const done = s.status.includes("完成");
                  return (
                    <tr key={`${si}:${s.id}`}>
                      <td className="mono nowrap">{s.id}</td>
                      <td>
                        <div>{s.step}</div>
                        {(s.prereg || s.deliverables.length > 0) && (
                          <div className="chips">
                            {s.prereg && (
                              <EvChip kind="text" title="预登记">
                                {s.prereg}
                              </EvChip>
                            )}
                            {s.deliverables.map((d, di) => {
                              // 找到了的交付物（resolved，相对仓库根或绝对路径，Q9）经路径出口换算后可以预览。
                              const rel = d.exists && d.resolved ? previewPath(d.resolved, "repo", open.paths) : null;
                              const title = `交付物 ${d.path}：${d.exists ? (rel ? "存在，点开预览" : "存在") : done ? "步骤已完成，交付物却不存在" : "还没有"}`;
                              return (
                                <EvChip key={`${di}:${d.path}`} kind={rel ? "file" : "text"} tone={!d.exists && done ? "err" : undefined} onClick={rel ? () => open.file(rel) : undefined} title={title}>
                                  {d.path}
                                  {!d.exists && (done ? " · 缺失" : " · 还没有")}
                                </EvChip>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td className="nowrap">{s.status || <span className="muted">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      ))}
    </>
  );
  return (
    <Section title="计划" end={rawToggle} data-section="plan">
      {body}
      {raw && planMd && (
        <div className="surface-well" data-plan-raw="">
          {/* PLAN.md 来自服务器：图片不自动加载，只给链接 */}
          <Markdown text={planMd} images="link" />
        </div>
      )}
    </Section>
  );
}
