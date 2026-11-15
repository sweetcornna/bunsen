import { Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProjectName } from "../components/ProjectName";
import { Button, EmptyLine, Fact, Facts, ICON, IconButton, InlineLink, Meter, Notice, ScrollArea, Section, Spinner, When } from "../components/ui";
import { api, type Agent, type Gpu, type Server, type Session } from "../lib/api";
import { copyText, gb, gpuFree, isLocal, serverAddr } from "../lib/format";
import { useApp } from "../lib/store";

/** 概览：对话的全部元信息（会话头只留状态、标题、服务器）、接入命令、显卡、服务器。 */
export function OverviewPanel({ session, server, agent, active }: { session: Session; server: Server | undefined; agent: Agent | undefined; active: boolean }) {
  const toast = useApp((s) => s.toast);
  const [gpus, setGpus] = useState<Gpu[] | null>(server?.probe?.gpus ?? null);
  const [gpuErr, setGpuErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const history = useRef<Record<number, number[]>>({});
  const [, bump] = useState(0);
  const offline = session.state === "unreachable";

  const loadGpus = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.gpus(session.server_id);
      for (const g of list) history.current[g.index] = [...(history.current[g.index] ?? []), g.util_pct].slice(-40);
      setGpus(list);
      bump((n) => n + 1);
      setGpuErr(null);
    } catch (e) {
      setGpuErr(e instanceof Error ? e.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, [session.server_id]);

  // 这个标签页开着的时候，每 10 秒看一眼显卡。
  useEffect(() => {
    if (!active || offline) return;
    void loadGpus();
    const t = window.setInterval(() => !document.hidden && void loadGpus(), 10000);
    return () => window.clearInterval(t);
  }, [active, loadGpus, offline]);

  const copy = (text: string, what: string) => void copyText(text).then((ok) => toast(ok ? "ok" : "err", ok ? `已复制${what}` : "复制失败"));
  const p = server?.probe;
  const plugins = session.plugins?.length ? session.plugins : session.plugin ? [session.plugin] : [];

  return (
    <div className="panel">
      <ScrollArea className="panel-body">
        <div className="sections panel-sections">
          <Section title="对话">
            <Facts>
              <Fact label="Agent">{agent?.name ?? session.agent_id}</Fact>
              <Fact label="服务器">
                {session.server_alias}
                {server && <span className={isLocal(server) ? "muted" : "muted mono"}> {serverAddr(server)}</span>}
              </Fact>
              <Fact label="工作目录">
                <InlineLink mono title="点击复制" onClick={() => copy(session.workdir, "工作目录")}>
                  {session.workdir}
                </InlineLink>
              </Fact>
              {session.project_id && (
                <>
                  <Fact label="研究项目">
                    <ProjectName id={session.project_id} />
                  </Fact>
                  <Fact label="机器代号">{session.machine ? <span className="mono">{session.machine}</span> : <span className="muted">还没有：仓库里有研究目录后执行 rk sync --setup</span>}</Fact>
                </>
              )}
              <Fact label="科研套件">{plugins.length > 0 ? plugins.join("、") : <span className="muted">没有加载</span>}</Fact>
              {session.origin === "discovered" && <Fact label="来源">在服务器上发现</Fact>}
              <Fact label="tmux 会话">
                <span className="mono">{session.tmux}</span>
              </Fact>
              <Fact label="创建">
                <When iso={session.created_at} />
              </Fact>
              <Fact label="最近活动">{session.last_active_at ? <When iso={session.last_active_at} /> : <span className="muted">—</span>}</Fact>
              <Fact label="已连接">{session.attached} 个终端</Fact>
            </Facts>
          </Section>

          <Section title="接入命令">
            {[session.attach_cmd, `bunsen attach ${session.id}`].map((cmd, i) => (
              <div key={i} className="cmd-well surface-well">
                <code className="mono">{cmd}</code>
                <IconButton label="复制" size="sm" onClick={() => copy(cmd, i === 0 ? "接入命令" : "命令")}>
                  <Copy size={ICON.sm} />
                </IconButton>
              </div>
            ))}
          </Section>

          <Section
            title="显卡"
            end={
              !offline && (
                <Button size="sm" variant="ghost" icon={loading ? <Spinner size={ICON.sm} /> : <RefreshCw size={ICON.sm} />} onClick={() => void loadGpus()} disabled={loading}>
                  刷新
                </Button>
              )
            }
          >
            {offline ? (
              <EmptyLine>连不上服务器，显卡信息暂不可用</EmptyLine>
            ) : (
              <>
                {gpuErr && <Notice tone="err">{gpuErr}</Notice>}
                {gpus && gpus.length === 0 && <EmptyLine>没有显卡</EmptyLine>}
                {gpus && gpus.length > 0 && <GpuTable gpus={gpus} history={history.current} />}
                {!gpus && !gpuErr && <EmptyLine>正在读取…</EmptyLine>}
              </>
            )}
          </Section>

          {p && (
            <Section title="服务器">
              <Facts>
                <Fact label="系统">
                  {p.os} <span className="muted">{p.arch}</span>
                </Fact>
                <Fact label="处理器">{p.cpus} 核</Fact>
                <Fact label="内存">
                  {gb(p.mem_free_gb)} 可用 / {gb(p.mem_total_gb)}
                </Fact>
                {p.disk_home && (
                  <Fact label="主目录磁盘">
                    {gb(p.disk_home.free_gb)} 可用 / {gb(p.disk_home.total_gb)}
                  </Fact>
                )}
                <Fact label="tmux">{p.tmux.present ? (p.tmux.version ?? "有") : <span className="tone-err">没有</span>}</Fact>
              </Facts>
            </Section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** 利用率走势。没有数据（不到 2 个点）时不渲染，不占位（分屏稿 15.2 第 1 条）。 */
function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 56;
  const h = 16;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (Math.min(100, v) / 100) * (h - 2)).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 显卡：每张一行 Facts——编号和型号 · 显存条 · 用量和利用率 ·（走势）· 谁在用。显存满不算异常，条用中性色。
 * 缺省宽度的面板里一行；这一栏窄到约 200px 以内才折行（容器查询，样式在 app.css 的 .gpu-line，分屏稿 15.2 第 1 条）。
 */
export function GpuTable({ gpus, history }: { gpus: Gpu[]; history?: Record<number, number[]> }) {
  return (
    <Facts className="gpu-list">
      {gpus.map((g) => {
        const mem = g.mem_total_mb > 0 ? (g.mem_used_mb / g.mem_total_mb) * 100 : 0;
        const free = gpuFree(g);
        const users = [...new Set((g.apps ?? []).map((a) => a.user))];
        const apps = (g.apps ?? []).map((a) => `${a.user}  ${a.pid}  ${(a.mem_mb / 1024).toFixed(1)}G  ${a.name}`).join("\n");
        const usage = `${(g.mem_used_mb / 1024).toFixed(1)} / ${(g.mem_total_mb / 1024).toFixed(0)} G · ${g.util_pct}%`;
        return (
          <Fact
            key={g.index}
            label={
              <span title={g.name}>
                <span className="mono">{g.index}</span> {g.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "")}
              </span>
            }
          >
            <div className="gpu-line">
              <Meter value={mem} />
              {/* 窄面板里放不下时省略号截断，悬停看全文 */}
              <span className="gpu-usage" title={usage}>
                {usage}
              </span>
              {history && <Spark values={history[g.index] ?? []} />}
              <span className="gpu-who" title={apps || undefined}>
                {free ? "空闲" : users.length ? users.join(" ") : `${g.procs} 进程`}
              </span>
            </div>
          </Fact>
        );
      })}
    </Facts>
  );
}
