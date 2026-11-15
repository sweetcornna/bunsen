import { CheckCircle2, ClipboardPaste, FolderOpen, KeyRound, UploadCloud, XCircle } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { api, type ImportResult } from "../lib/api";
import { useApp } from "../lib/store";
import { Button, ICON, Notice, Row, Section, Spinner } from "./ui";

const MAX_FILES = 200;
const MAX_BYTES = 2 * 1024 * 1024;

type Entry = { isFile: boolean; isDirectory: boolean; file?: (ok: (f: File) => void, err: () => void) => void; createReader?: () => { readEntries: (ok: (e: Entry[]) => void, err: () => void) => void } };

/** 把拖进来的东西摊平成文件；拖的是整个 .ssh 目录也行。 */
async function collect(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const roots: Entry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (roots.length === 0) return Array.from(dt.files).filter((f) => f.size <= MAX_BYTES);

  const walk = async (e: Entry): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    if (e.isFile && e.file) {
      const f = await new Promise<File | null>((res) => e.file!(res, () => res(null)));
      if (f && f.size <= MAX_BYTES) out.push(f);
    } else if (e.isDirectory && e.createReader) {
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<Entry[]>((res) => reader.readEntries(res, () => res([])));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const r of roots) await walk(r);
  return out;
}

export function ImportDrop({ compact, onDone }: { compact?: boolean; onDone?: (r: ImportResult) => void }) {
  const loadServers = useApp((s) => s.loadServers);
  const loadKeys = useApp((s) => s.loadKeys);
  const fail = useApp((s) => s.fail);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const run = async (files: File[], configText?: string) => {
    if (files.length === 0 && !configText?.trim()) return;
    setBusy(true);
    try {
      const r = await api.importServers(files, configText);
      setResult(r);
      setText("");
      setPaste(false);
      await Promise.all([loadServers(), loadKeys()]);
      onDone?.(r);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void run(await collect(e.dataTransfer));
  };

  return (
    <div className="import">
      <div
        className="dropzone"
        data-over={over ? "" : undefined}
        data-compact={compact ? "" : undefined}
        aria-busy={busy || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => void onDrop(e)}
      >
        <div className="dropzone-icon">{busy ? <Spinner size={ICON.lg} /> : <UploadCloud size={ICON.lg} />}</div>
        <div className="dropzone-text">
          <span className="fw-medium">{busy ? "导入并测试中…" : "拖入 SSH 配置"}</span>
          <span className="muted t-dense">config · 私钥 · .ssh 目录 · zip</span>
        </div>
        <div className="dropzone-actions">
          <Button icon={<FolderOpen size={ICON.md} />} onClick={() => inputRef.current?.click()} disabled={busy}>
            选择文件
          </Button>
          <Button variant="ghost" icon={<ClipboardPaste size={ICON.md} />} onClick={() => setPaste((v) => !v)} disabled={busy} aria-expanded={paste}>
            粘贴配置
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void run(files);
          }}
        />
      </div>

      {paste && (
        <div className="stack">
          <textarea
            className="input mono"
            rows={7}
            autoFocus
            spellCheck={false}
            placeholder={"Host gpu1\n  HostName 192.168.1.20\n  User me\n  Port 22\n  IdentityFile ~/.ssh/id_ed25519"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row end">
            <Button variant="ghost" onClick={() => setPaste(false)}>
              取消
            </Button>
            <Button loading={busy} disabled={!text.trim()} onClick={() => void run([], text)}>
              导入
            </Button>
          </div>
        </div>
      )}

      {result && <ImportSummary result={result} onClose={() => setResult(null)} />}
    </div>
  );
}

function ImportSummary({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const all = [...result.servers_added.map((s) => ({ s, fresh: true })), ...result.servers_updated.map((s) => ({ s, fresh: false }))];
  const testOf = (id: string) => result.tests.find((t) => t.server_id === id);
  const nothing = all.length === 0 && result.keys_added.length === 0;
  return (
    <Section title={nothing ? "没有可导入的内容" : `导入了 ${all.length} 台服务器 · ${result.keys_added.length} 把密钥`} end={<Button size="sm" variant="ghost" onClick={onClose}>收起</Button>}>
      <div className="list">
        {all.map(({ s, fresh }) => {
          const t = testOf(s.id);
          return (
            <Row
              key={s.id}
              lead={t && !t.ok ? <XCircle size={ICON.md} className="tone-err" /> : <CheckCircle2 size={ICON.md} />}
              name={
                <>
                  <span className="fw-medium">{s.alias}</span>{" "}
                  <span className="mono muted">
                    {s.user}@{s.host}
                    {s.port !== 22 ? `:${s.port}` : ""}
                  </span>
                </>
              }
              meta={`${fresh ? "新增" : "已更新"}${t ? ` · ${t.ok ? (t.key_used ?? "已连接") : (t.detail ?? "连接失败")}` : ""}`}
            />
          );
        })}
        {result.keys_added.map((k) => (
          <Row key={k.name} lead={<KeyRound size={ICON.md} />} name={<><span className="fw-medium">{k.name}</span> <span className="muted">{k.kind}</span></>} meta={<span className="mono">{k.fingerprint}</span>} />
        ))}
      </div>
      {result.warnings.map((w, i) => (
        <Notice key={i} tone="warn">
          {w}
        </Notice>
      ))}
    </Section>
  );
}
