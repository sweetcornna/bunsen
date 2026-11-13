import { Download, Quote } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, asApiError } from "../lib/api";
import { bytes } from "../lib/format";
import { blobUrl, download, extOf, isNumeric, kindOf, parseDelimited, parseNotebook, rawText, type NbCell } from "../lib/preview";
import { Markdown } from "./Markdown";
import { cx, Empty, IconButton, Segmented, Spinner } from "./ui";

export type Quoted = { path: string; text?: string };

const FRAME_CSS = `<style>html{color-scheme:light dark}body{margin:12px;font:13px/1.5 -apple-system,system-ui,sans-serif}table{border-collapse:collapse;font-size:12px}th,td{border:1px solid #8884;padding:3px 8px;text-align:right}th{font-weight:600}</style>`;

/** 按扩展名选预览方式：图、PDF、表格、Notebook、网页、Markdown、代码。服务器上的内容一律不在本页的源里执行。 */
export function FilePreview({ sessionId, path, stamp, onQuote, left }: { sessionId: string; path: string; stamp?: string; onQuote?: (q: Quoted) => void; left?: ReactNode }) {
  const kind = kindOf(path);
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "source">("view");
  const [fit, setFit] = useState(true);

  useEffect(() => {
    let alive = true;
    setText(null);
    setUrl(null);
    setErr(null);
    setTruncated(false);
    const ok = <T,>(f: (v: T) => void) => (v: T) => alive && f(v);
    const bad = (e: unknown) => alive && setErr(asApiError(e).message);
    if (kind === "image" || kind === "pdf") blobUrl(sessionId, path, stamp).then(ok(setUrl)).catch(bad);
    else if (kind === "notebook") rawText(sessionId, path).then(ok(setText)).catch(bad);
    else if (kind !== "binary")
      api
        .file(sessionId, path)
        .then(
          ok((f) => {
            setSize(f.size);
            setTruncated(f.truncated);
            if (f.binary) setErr("二进制文件");
            else setText(f.text ?? "");
          }),
        )
        .catch(bad);
    return () => {
      alive = false;
    };
  }, [sessionId, path, stamp, kind]);

  const hasSource = kind === "markdown" || kind === "html" || kind === "table" || kind === "notebook";
  const loading = !err && kind !== "binary" && text === null && url === null;
  const quote = () => {
    const sel = window.getSelection()?.toString().trim() ?? "";
    onQuote?.({ path, text: sel ? sel.slice(0, 4000) : undefined });
  };

  return (
    <div className="panel">
      <div className="panel-bar">
        {left}
        <span className="mono ellipsis crumb" title={path}>
          {path}
        </span>
        {size !== null && <span className="dim">{bytes(size)}</span>}
        <span className="grow" />
        {hasSource && text !== null && (
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "view", label: "预览" },
              { value: "source", label: "源码" },
            ]}
          />
        )}
        {onQuote && (
          <IconButton label="引用到消息" onClick={quote}>
            <Quote size={13} />
          </IconButton>
        )}
        <IconButton label="下载" onClick={() => void download(sessionId, path)}>
          <Download size={13} />
        </IconButton>
      </div>
      {truncated && <div className="note warn">只显示前 512 KB</div>}
      <div className={cx("scroll grow", (kind === "image" || kind === "pdf") && "stage")}>
        {err ? (
          <Empty title={err} />
        ) : loading ? (
          <Empty title={<Spinner />} />
        ) : kind === "binary" ? (
          <Empty title={`.${extOf(path)} 不支持预览`} />
        ) : kind === "image" && url ? (
          <img className={cx("img-view", fit && "fit")} src={url} alt={path} onClick={() => setFit((v) => !v)} />
        ) : kind === "pdf" && url ? (
          <iframe className="frame" src={url} title={path} />
        ) : text === null ? null : mode === "source" || kind === "text" ? (
          <Code text={text} />
        ) : kind === "markdown" ? (
          <div className="pad">
            <Markdown text={text} images="link" />
          </div>
        ) : kind === "table" ? (
          <DataTable text={text} delim={extOf(path) === "tsv" ? "\t" : ","} />
        ) : kind === "notebook" ? (
          <Notebook text={text} />
        ) : (
          <iframe className="frame light" sandbox="" srcDoc={text} title={path} />
        )}
      </div>
    </div>
  );
}

export function Code({ text }: { text: string }) {
  const gutter = useMemo(() => {
    const n = text.split("\n").length;
    let s = "";
    for (let i = 1; i <= n; i++) s += i + "\n";
    return s;
  }, [text]);
  return (
    <div className="code">
      <pre className="code-gutter" aria-hidden>
        {gutter}
      </pre>
      <pre className="code-text">{text}</pre>
    </div>
  );
}

function DataTable({ text, delim }: { text: string; delim: string }) {
  const { rows, more } = useMemo(() => parseDelimited(text, delim, 1000), [text, delim]);
  if (rows.length === 0) return <Empty title="空表" />;
  const [head, ...body] = rows;
  const numeric = head.map((_, c) => body.slice(0, 50).every((r) => r[c] === undefined || r[c] === "" || isNumeric(r[c])));
  return (
    <>
      <table className="table data">
        <thead>
          <tr>
            <th className="rownum" />
            {head.map((h, i) => (
              <th key={i} className={numeric[i] ? "num" : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              <td className="rownum">{i + 1}</td>
              {head.map((_, c) => (
                <td key={c} className={numeric[c] ? "num" : undefined}>
                  {r[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more && <div className="note">只显示前 {body.length} 行</div>}
    </>
  );
}

function Notebook({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try {
      return parseNotebook(text);
    } catch {
      return null;
    }
  }, [text]);
  if (!parsed) return <Empty title="无法解析 notebook" />;
  return (
    <div className="nb">
      {parsed.cells.map((c, i) => (
        <NbCellView key={i} cell={c} />
      ))}
    </div>
  );
}

function NbCellView({ cell }: { cell: NbCell }) {
  if (cell.type === "markdown")
    return (
      <div className="nb-md">
        <Markdown text={cell.source} images="link" />
      </div>
    );
  return (
    <div className="nb-cell">
      <div className="nb-in">
        <span className="nb-count">[{cell.count ?? " "}]</span>
        <pre>{cell.source}</pre>
      </div>
      {cell.outputs.map((o, i) =>
        o.kind === "image" ? (
          <img key={i} className="nb-img" src={o.src} alt="" />
        ) : o.kind === "html" ? (
          <iframe key={i} className="nb-frame" sandbox="" srcDoc={FRAME_CSS + o.text} title="output" />
        ) : (
          <pre key={i} className={cx("nb-out", o.kind === "error" && "err")}>
            {o.text}
          </pre>
        ),
      )}
    </div>
  );
}
