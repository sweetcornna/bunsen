// 运行详情里的“环境”“输入”“输出”三节（第四期契约 3.1–3.3、8.2）。
// 记录都先经 lib/research.ts 整理（envOf、outputsOf、inputsOf），路径预览一律经 lib/paths.ts 的 previewPath。
import { Copy, FileText, Search } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { cx, Empty, IconButton } from "../components/ui";
import type { RkEnv, RkInput, RkOutputs } from "../lib/api";
import { bytes, copyText, fullTime, relTime } from "../lib/format";
import { previewPath, type PathCtx } from "../lib/paths";
import { shortHash, sizeText } from "../lib/research";
import { useApp } from "../lib/store";

type Meta = Record<string, unknown>;
/** 0.6.0 起的运行 meta 里有 rk_version；之前的运行没有环境、输入、输出记录。 */
const isNew = (meta: Meta) => typeof meta.rk_version === "string" && meta.rk_version !== "";
const OLD_RUN = "这是研究工具 0.6.0 之前的运行，没有这项记录。";
const BAD = (file: string) => `${file} 不是研究工具写的格式（可能是运行脚本自己写的同名文件），这里不显示。`;
/** 输出清单一次显示多少行（审查 P4F1-03）。 */
const PAGE = 200;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** 哈希的一行：前 12 位，悬停看全文；部分哈希、没算哈希另外标出；记录里缺哈希（又没标 unhashed）显示 “—”。 */
function Hash({ sha, partial, unhashed, partialWhy }: { sha: string | null; partial: boolean; unhashed: boolean; partialWhy: string }) {
  if (unhashed)
    return (
      <span className="tag warn" title="所有输入和输出合计超过 8 GiB 的读取预算，之后的文件没有计算哈希">
        没算哈希
      </span>
    );
  if (!sha) return <span className="dim">—</span>;
  return (
    <span className="nowrap">
      <span className="mono dim" title={sha}>
        {shortHash(sha)}
      </span>
      {partial && (
        <span className="tag" title={partialWhy}>
          部分
        </span>
      )}
    </span>
  );
}

/** 一个可以预览的路径：能换成工作目录里的路径就给按钮，否则只显示文字，悬停说明为什么不能点。 */
function PathCell({ path, rel, onFile, why = "不在工作目录里，不能预览" }: { path: string; rel: string | null; onFile: (path: string) => void; why?: string }) {
  return rel ? (
    <button type="button" className="link-btn mono" onClick={() => onFile(rel)} title={`预览 ${rel}`}>
      <FileText size={11} />
      {path}
    </button>
  ) : (
    <span className="mono dim" title={why}>
      {path}
    </span>
  );
}

export const EnvView = memo(function EnvView({ env, bad, meta, live }: { env: RkEnv | null; bad: boolean; meta: Meta; live: boolean }) {
  const toast = useApp((s) => s.toast);
  const [showPkgs, setShowPkgs] = useState(false);
  const [filter, setFilter] = useState("");
  const pkgs = useMemo(() => {
    const lines = env?.packages.lines ?? [];
    const f = filter.trim().toLowerCase();
    return f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
  }, [env, filter]);

  if (bad) return <Empty title="环境记录的格式不认识" hint={BAD("env.json")} />;
  if (!env) {
    const why = !isNew(meta)
      ? OLD_RUN
      : typeof meta.env_sha256 === "string"
        ? "记录里有 env.json，但它超过 256 KiB 或格式不对，读不出来。"
        : live
          ? "运行还没结束：环境在后台采集，最晚在运行结束后一分钟内写好。"
          : "环境没在时限内采集完，这次运行没有环境记录（log.txt 末尾有说明）。";
    return <Empty title="没有环境记录" hint={why} />;
  }
  const gpuNames = env.gpu ? groupNames(env.gpu.names) : [];
  return (
    <div className="pad">
      <dl className="facts env-facts">
        <Fact label="解释器">
          {env.python.version || env.python.executable ? (
            <>
              {env.python.version ? `Python ${env.python.version}` : <span className="dim">版本未知</span>}
              {env.python.executable && <div className="mono dim">{env.python.executable}</div>}
            </>
          ) : (
            <span className="dim">没找到 Python</span>
          )}
        </Fact>
        <Fact label="包">
          {env.packages.tool ? (
            <>
              <span>
                {env.packages.tool} · {env.packages.lines.length} 行
              </span>
              {env.packages.truncated && <span className="tag warn">清单超出上限，只记了前面一部分</span>}{" "}
              {env.packages.lines.length > 0 && (
                <button type="button" className="link-btn" onClick={() => setShowPkgs((v) => !v)} aria-expanded={showPkgs}>
                  {showPkgs ? "收起清单" : "展开清单"}
                </button>
              )}
            </>
          ) : (
            <span className="dim">pip、uv、conda 都没有列出包</span>
          )}
        </Fact>
        <Fact label="显卡">
          {!env.gpu ? (
            <span className="dim">没有 nvidia-smi</span>
          ) : (
            <>
              {gpuNames.length > 0 ? gpuNames.join("、") : <span className="dim">nvidia-smi 没有列出显卡</span>}
              <div className="dim">
                驱动 {env.gpu.driver ?? "未知"} · CUDA {env.gpu.cuda ?? "未知"}
              </div>
            </>
          )}
        </Fact>
        <Fact label="系统">
          {[env.os.system, env.os.release].filter(Boolean).join(" ") || <span className="dim">未知</span>}
          {env.os.machine && ` · ${env.os.machine}`}
          {env.os.platform && <div className="mono dim">{env.os.platform}</div>}
        </Fact>
        <Fact label="主机">{env.host || <span className="dim">—</span>}</Fact>
        <Fact label="采集于">{env.captured_at ? fullTime(env.captured_at) : <span className="dim">—</span>}</Fact>
        <Fact label="指纹">
          {env.fingerprint ? (
            <span className="nowrap">
              <span className="mono" title={env.fingerprint}>
                {shortHash(env.fingerprint)}
              </span>
              <IconButton label="复制指纹" onClick={() => void copyText(env.fingerprint).then((ok) => toast(ok ? "ok" : "err", ok ? "已复制指纹" : "复制失败"))}>
                <Copy size={12} />
              </IconButton>
            </span>
          ) : (
            <span className="dim">—</span>
          )}
          <div className="dim">解释器版本、包、显卡驱动、CUDA、系统都相同的运行，指纹相同。</div>
        </Fact>
      </dl>
      {showPkgs && (
        <div className="pkgs">
          <label className="mini-search">
            <Search size={12} />
            <input value={filter} placeholder="筛选包" aria-label="筛选包" onChange={(e) => setFilter(e.target.value)} />
          </label>
          <pre className="log pkg-list">{pkgs.join("\n") || "没有匹配的包"}</pre>
        </div>
      )}
    </div>
  );
});

/** 同名显卡合并成 “4 × 名称”。 */
function groupNames(names: string[]): string[] {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m].map(([n, k]) => (k > 1 ? `${k} × ${n}` : n));
}

export const InputsView = memo(function InputsView({ inputs, meta, paths, onFile }: { inputs: RkInput[] | null; meta: Meta; paths: PathCtx; onFile: (path: string) => void }) {
  if (!inputs) return <Empty title="没有输入清单" hint={isNew(meta) ? "meta.json 里没有 inputs。" : OLD_RUN} />;
  if (inputs.length === 0) return <Empty title="没有声明输入" hint="启动时没有用 rk run --in 声明输入。" />;
  return (
    <div className="table-wrap">
      <table className="table prov-table">
        <thead>
          <tr>
            <th>路径</th>
            <th>类型</th>
            <th>大小</th>
            <th>sha256</th>
          </tr>
        </thead>
        <tbody>
          {inputs.map((x, i) => (
            <tr key={`${i}:${x.path}`}>
              <td className="cell-path">
                {/* 目录不能预览（审查 P4F2-05）；文件按相对仓库根的路径换算 */}
                {x.type === "dir" ? <PathCell path={x.path} rel={null} onFile={onFile} why="目录不能预览" /> : <PathCell path={x.path} rel={previewPath(x.path, "repo", paths)} onFile={onFile} />}
              </td>
              <td className="nowrap">{x.type === "dir" ? `目录${x.files !== null ? ` · ${x.files} 个文件` : ""}` : "文件"}</td>
              <td className="nowrap dim">{sizeText(x.size, bytes)}</td>
              <td>
                <Hash sha={x.sha256} partial={x.partial} unhashed={x.unhashed} partialWhy={x.type === "dir" ? "目录里超过 10000 个文件，只算了前 10000 个" : "文件超过 256 MiB，只按大小和首尾各 1 MiB 计算"} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});

export const OutputsView = memo(function OutputsView({ outputs, bad, meta, live, paths, onFile }: { outputs: RkOutputs | null; bad: boolean; meta: Meta; live: boolean; paths: PathCtx; onFile: (path: string) => void }) {
  const [limit, setLimit] = useState(PAGE);
  const [filter, setFilter] = useState("");
  // 路径换算只在清单或工作目录变了时做一次（审查 P4F1-03）。
  const rows = useMemo(() => (outputs?.files ?? []).map((f) => ({ f, rel: previewPath(f.path, "repo", paths) })), [outputs, paths]);
  const picked = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? rows.filter((r) => r.f.path.toLowerCase().includes(q)) : rows;
  }, [rows, filter]);
  const outs = Array.isArray(meta.outs) ? (meta.outs as unknown[]).filter((x): x is string => typeof x === "string") : [];

  if (bad) return <Empty title="输出清单的格式不认识" hint={BAD("outputs.json")} />;
  if (!outputs) {
    const why = !isNew(meta)
      ? OLD_RUN
      : typeof meta.outputs_sha256 === "string"
        ? "记录里有 outputs.json，但它超过 1 MiB 或格式不对，读不出来。"
        : live
          ? "运行结束时才写输出清单。"
          : "没有输出清单：运行没有正常结束，或者是手工批次还没执行 rk done。";
    return <Empty title="没有输出清单" hint={why} />;
  }
  const shown = picked.slice(0, limit);
  const more = Math.min(PAGE, picked.length - shown.length);
  return (
    <>
      <div className="prov-head">
        <span>
          {outputs.files.length} 个文件
          {outputs.written_at && (
            <>
              {" "}
              · <span title={fullTime(outputs.written_at)}>{relTime(outputs.written_at) || fullTime(outputs.written_at)}写入</span>
            </>
          )}
        </span>
        {outs.length > 0 && (
          <span className="dim">
            声明的输出目录：<span className="mono">{outs.join("、")}</span>
          </span>
        )}
        {outputs.files.length > PAGE && (
          <label className="mini-search">
            <Search size={12} />
            <input
              value={filter}
              placeholder="筛选路径"
              aria-label="筛选输出文件的路径"
              onChange={(e) => {
                setFilter(e.target.value);
                setLimit(PAGE);
              }}
            />
          </label>
        )}
      </div>
      {outputs.truncated && <div className="note warn">超过 5000 个文件，清单只记了前 5000 个。</div>}
      {outputs.files.length === 0 ? (
        <Empty title="这次运行没有留下输出文件" />
      ) : picked.length === 0 ? (
        <Empty title="没有匹配的文件" />
      ) : (
        <div className="table-wrap">
          <table className="table prov-table">
            <thead>
              <tr>
                <th>路径</th>
                <th>大小</th>
                <th>sha256</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ f, rel }, i) => (
                <tr key={`${i}:${f.path}`}>
                  <td className="cell-path">
                    <PathCell path={f.path} rel={rel} onFile={onFile} />
                  </td>
                  <td className="nowrap dim">{sizeText(f.size, bytes)}</td>
                  <td>
                    <Hash sha={f.sha256} partial={f.partial} unhashed={f.unhashed} partialWhy="文件超过 256 MiB，只按大小和首尾各 1 MiB 计算" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {more > 0 && (
            <button type="button" className={cx("link-btn", "table-more")} onClick={() => setLimit((n) => n + PAGE)}>
              再显示 {more} 行（已显示 {shown.length} / {picked.length}）
            </button>
          )}
        </div>
      )}
    </>
  );
});
