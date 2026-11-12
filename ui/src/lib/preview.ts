import { api } from "./api";

export type PreviewKind = "image" | "pdf" | "table" | "notebook" | "html" | "markdown" | "text" | "binary";

const EXT: Record<string, PreviewKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image",
  pdf: "pdf",
  csv: "table", tsv: "table",
  ipynb: "notebook",
  html: "html", htm: "html",
  md: "markdown", markdown: "markdown",
};
const BINARY = new Set(["xlsx", "xls", "parquet", "docx", "pptx", "zip", "gz", "tar", "pt", "pth", "ckpt", "safetensors", "npy", "npz", "pkl", "bin", "h5", "hdf5", "onnx", "so", "o", "a", "mp4", "mov", "mp3", "wav", "ttf", "woff", "woff2"]);
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", pdf: "application/pdf" };

export const extOf = (path: string) => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();
export function kindOf(path: string): PreviewKind {
  const e = extOf(path);
  return EXT[e] ?? (BINARY.has(e) ? "binary" : "text");
}

// ---- 原始文件 → 对象地址：有缓存、限并发 ----
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
let active = 0;
const waiters: (() => void)[] = [];
const acquire = () => (active < 4 ? (active++, Promise.resolve()) : new Promise<void>((r) => waiters.push(() => (active++, r()))));
const release = () => {
  active--;
  waiters.shift()?.();
};

/** 取文件的对象地址（图片、PDF 用）。stamp 变了（文件更新了）就重取。 */
export function blobUrl(sessionId: string, path: string, stamp = ""): Promise<string> {
  const key = `${sessionId}\n${path}\n${stamp}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = pending.get(key);
  if (running) return running;
  const p = (async () => {
    await acquire();
    try {
      const buf = await api.raw(sessionId, path);
      const url = URL.createObjectURL(new Blob([buf], { type: MIME[extOf(path)] ?? "application/octet-stream" }));
      cache.set(key, url);
      if (cache.size > 240) {
        const first = cache.keys().next().value as string;
        URL.revokeObjectURL(cache.get(first)!);
        cache.delete(first);
      }
      return url;
    } finally {
      release();
      pending.delete(key);
    }
  })();
  pending.set(key, p);
  return p;
}

export async function rawText(sessionId: string, path: string): Promise<string> {
  return new TextDecoder().decode(await api.raw(sessionId, path));
}

export async function download(sessionId: string, path: string): Promise<void> {
  const url = await blobUrl(sessionId, path, "dl");
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || "file";
  a.click();
}

// ---- CSV ----
export function parseDelimited(text: string, delim: string, maxRows = 1000): { rows: string[][]; more: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) return { rows, more: i + 1 < n };
    } else cell += c;
    i++;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, more: false };
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export const isNumeric = (s: string) => s !== "" && !Number.isNaN(Number(s));

// ---- Notebook ----
export type NbOutput = { kind: "text" | "error"; text: string } | { kind: "image"; src: string } | { kind: "html"; text: string };
export type NbCell = { type: "markdown" | "code" | "raw"; source: string; count: number | null; outputs: NbOutput[] };

const join = (v: unknown): string => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");

export function parseNotebook(text: string): { cells: NbCell[]; lang: string } {
  const nb = JSON.parse(text);
  const lang: string = nb?.metadata?.kernelspec?.language ?? nb?.metadata?.language_info?.name ?? "python";
  const cells: NbCell[] = (nb.cells ?? []).map((c: Record<string, unknown>) => {
    const outputs: NbOutput[] = [];
    for (const o of (c.outputs as Record<string, unknown>[] | undefined) ?? []) {
      if (o.output_type === "stream") outputs.push({ kind: "text", text: stripAnsi(join(o.text)) });
      else if (o.output_type === "error") outputs.push({ kind: "error", text: stripAnsi(join(o.traceback).replace(/\n?$/, "")) || `${o.ename}: ${o.evalue}` });
      else {
        const data = (o.data ?? {}) as Record<string, unknown>;
        const img = ["image/png", "image/jpeg", "image/gif"].find((m) => data[m]);
        if (img) outputs.push({ kind: "image", src: `data:${img};base64,${join(data[img]).replace(/\s+/g, "")}` });
        else if (data["text/html"] && /<table/i.test(join(data["text/html"]))) outputs.push({ kind: "html", text: join(data["text/html"]) });
        else if (data["text/plain"]) outputs.push({ kind: "text", text: stripAnsi(join(data["text/plain"])) });
      }
    }
    return { type: c.cell_type as NbCell["type"], source: join(c.source), count: (c.execution_count as number | null) ?? null, outputs };
  });
  return { cells, lang };
}
