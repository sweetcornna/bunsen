import { Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, IconButton, Meter, Spinner } from "../components/ui";
import { api, type Agent, type Gpu, type Server, type Session } from "../lib/api";
import { copyText, fullTime, gb, gpuFree } from "../lib/format";
import { useApp } from "../lib/store";

export function OverviewPanel({ session, server, agent, active }: { session: Session; server: Server | undefined; agent: Agent | undefined; active: boolean }) {
  const toast = useApp((s) => s.toast);
  const [gpus, setGpus] = useState<Gpu[] | null>(server?.probe?.gpus ?? null);
  const [gpuErr, setGpuErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const history = useRef<Record<number, number[]>>({});
  const [, bump] = useState(0);

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

  // 这个标签页开着的时候，每 20 秒看一眼显卡。
  useEffect(() => {
    if (!active || session.state === "unreachable") return;
    void loadGpus();
    const t = window.setInterval(() => !document.hidden && void loadGpus(), 10000);
    return () => window.clearInterval(t);
  }, [active, loadGpus, session.state]);

  const copy = (text: string, what: string) => void copyText(text).then((ok) => toast(ok ? "ok" : "err", ok ? `已复制${what}` : "复制失败"));
  const p = server?.probe;

  return (
    <div className="panel scroll">
      <section className="card">
        <h3>对话</h3>
        <dl className="facts">
          <dt>Agent</dt>
          <dd>{agent?.name ?? session.agent_id}</dd>
          <dt>服务器</dt>
          <dd>
            {session.server_alias}
            {server && <span className="dim mono"> {server.user}@{server.host}{server.port !== 22 ? `:${server.port}` : ""}</span>}
          </dd>
          <dt>工作目录</dt>
          <dd className="mono">{session.workdir}</dd>
          <dt>tmux 会话</dt>
          <dd className="mono">{session.tmux}</dd>
          <dt>创建</dt>
          <dd>{fullTime(session.created_at)}</dd>
          <dt>最近活动</dt>
          <dd>{fullTime(session.last_active_at)}</dd>
          <dt>已连接</dt>
          <dd>{session.attached} 个终端</dd>
        </dl>
      </section>

      <section className="card">
        <h3>接入命令</h3>
        <div className="codeline">
          <code>{session.attach_cmd}</code>
          <IconButton label="复制" onClick={() => copy(session.attach_cmd, "接入命令")}>
            <Copy size={13} />
          </IconButton>
        </div>
        <div className="codeline">
          <code>bunsen attach {session.id}</code>
          <IconButton label="复制" onClick={() => copy(`bunsen attach ${session.id}`, "命令")}>
            <Copy size={13} />
          </IconButton>
        </div>
      </section>

      <section className="card">
        <h3>
          显卡
          <span className="grow" />
          <Button size="sm" variant="ghost" icon={loading ? <Spinner size={12} /> : <RefreshCw size={12} />} onClick={() => void loadGpus()} disabled={loading}>
            刷新
          </Button>
        </h3>
        {gpuErr && <p className="card-hint c-err">{gpuErr}</p>}
        
        {gpus && gpus.length === 0 && <p className="card-hint">无显卡</p>}
        {gpus && gpus.length > 0 && <GpuTable gpus={gpus} history={history.current} />}
      </section>

      {p && (
        <section className="card">
          <h3>服务器</h3>
          <dl className="facts">
            <dt>系统</dt>
            <dd>
              {p.os} <span className="dim">{p.arch}</span>
            </dd>
            <dt>处理器</dt>
            <dd>{p.cpus} 核</dd>
            <dt>内存</dt>
            <dd>
              {gb(p.mem_free_gb)} 可用 / {gb(p.mem_total_gb)}
            </dd>
            {p.disk_home && (
              <>
                <dt>主目录磁盘</dt>
                <dd>
                  {gb(p.disk_home.free_gb)} 可用 / {gb(p.disk_home.total_gb)}
                </dd>
              </>
            )}
            <dt>tmux</dt>
            <dd>{p.tmux.present ? (p.tmux.version ?? "有") : "没有"}</dd>
          </dl>
        </section>
      )}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="spark" />;
  const w = 56;
  const h = 16;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (Math.min(100, v) / 100) * (h - 2)).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function GpuTable({ gpus, history }: { gpus: Gpu[]; history?: Record<number, number[]> }) {
  return (
    <div className="gpus">
      {gpus.map((g) => {
        const mem = g.mem_total_mb > 0 ? (g.mem_used_mb / g.mem_total_mb) * 100 : 0;
        const free = gpuFree(g);
        const users = [...new Set((g.apps ?? []).map((a) => a.user))];
        const apps = (g.apps ?? []).map((a) => `${a.user}  ${a.pid}  ${(a.mem_mb / 1024).toFixed(1)}G  ${a.name}`).join("\n");
        return (
          <div key={g.index} className={history ? "gpu with-spark" : "gpu"} title={apps || undefined}>
            <span className="gpu-idx">{g.index}</span>
            <span className="gpu-name ellipsis" title={g.name}>
              {g.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "")}
            </span>
            <Meter value={mem} tone={free ? "ok" : mem > 85 ? "err" : "warn"} />
            <span className="gpu-num">
              {(g.mem_used_mb / 1024).toFixed(1)} / {(g.mem_total_mb / 1024).toFixed(0)} G
            </span>
            {history && <Spark values={history[g.index] ?? []} />}
            <span className="gpu-num">{g.util_pct}%</span>
            <span className={free ? "gpu-tag ok" : "gpu-tag"}>{free ? "空闲" : users.length ? users.join(" ") : `${g.procs} 进程`}</span>
          </div>
        );
      })}
    </div>
  );
}
