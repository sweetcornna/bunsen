import { Activity, Download, KeyRound, MoreHorizontal, NotebookPen, Pencil, Plus, ScanSearch, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "../components/Markdown";
import { ImportDrop } from "../components/ImportDrop";
import { InstallDialog, ShellDialog } from "../components/InstallDialog";
import { AgentMark, Button, Confirm, cx, Empty, Field, Menu, Modal, Picker, Pill, Segmented, Spinner } from "../components/ui";
import { api, type Agent, type KeyInfo, type Server, type ServerInput } from "../lib/api";
import { gb, relTime, serverAddr, serverStatus } from "../lib/format";
import { go } from "../lib/route";
import { isLocal, useApp } from "../lib/store";
import { GpuTable } from "../panels/OverviewPanel";

export function Servers() {
  const servers = useApp((s) => s.servers);
  const keys = useApp((s) => s.keys);
  const [editing, setEditing] = useState<Server | "new" | null>(null);

  return (
    <div className="page">
      <div className="page-inner">
        <header className="page-head">
          <div>
            <h1>服务器</h1>
          </div>
          <Button icon={<Plus size={13} />} onClick={() => setEditing("new")}>
            手动添加
          </Button>
        </header>

        <ImportDrop compact={servers.length > 0} />

        {servers.length === 0 ? (
          <Empty title="还没有服务器" />
        ) : (
          <div className="server-list">
            {servers.map((s) => (
              <ServerCard key={s.id} server={s} onEdit={() => setEditing(s)} />
            ))}
          </div>
        )}

        {keys.length > 0 && <KeyList keys={keys} />}
      </div>
      {editing && <ServerForm server={editing === "new" ? null : editing} keys={keys} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ServerCard({ server, onEdit }: { server: Server; onEdit: () => void }) {
  const agents = useApp((s) => s.agents);
  const sessions = useApp((s) => s.sessions);
  const setServer = useApp((s) => s.setServer);
  const dropServer = useApp((s) => s.dropServer);
  const setDraft = useApp((s) => s.setDraft);
  const toast = useApp((s) => s.toast);
  const fail = useApp((s) => s.fail);
  const [busy, setBusy] = useState<null | "test" | "probe">(null);
  const [shell, setShell] = useState(false);
  const [install, setInstall] = useState<Agent | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [notes, setNotes] = useState(false);
  const st = serverStatus(server.status);
  const p = server.probe;
  const local = isLocal(server);
  const live = sessions.filter((x) => x.server_id === server.id && !x.archived && x.state === "running").length;

  const test = async () => {
    setBusy("test");
    try {
      // 本机不经 ssh，没有密钥可试。
      const r = await api.testServer(server.id, !local && !server.key);
      setServer(r.server);
      if (r.ok) toast("ok", `${server.alias} 连接正常${r.latency_ms !== null ? `，${r.latency_ms} ms` : ""}`);
      else toast("err", `${server.alias} 连不上`, r.server.status_detail);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const probe = async () => {
    setBusy("probe");
    try {
      setServer(await api.probeServer(server.id));
    } catch (e) {
      fail(e);
      void useApp.getState().loadServers();
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="server-card">
      <header>
        <div className="server-name">
          <b>{server.alias}</b>
          {local && <span className="tag">本机</span>}
          <Pill tone={st.tone}>{st.label}</Pill>
          {live > 0 && <span className="tag accent">{live} 个对话在跑</span>}
        </div>
        <div className="row">
          <Button size="sm" variant="primary" onClick={() => (setDraft({ server_id: server.id }), go("/"))}>
            新对话
          </Button>
          <Button size="sm" icon={<Activity size={12} />} loading={busy === "test"} onClick={() => void test()}>
            测试
          </Button>
          <Button size="sm" icon={<ScanSearch size={12} />} loading={busy === "probe"} onClick={() => void probe()}>
            探测
          </Button>
          <Button size="sm" icon={<SquareTerminal size={12} />} onClick={() => setShell(true)}>
            终端
          </Button>
          <Menu
            trigger={
              <button type="button" className="icon-btn" aria-label="更多">
                <MoreHorizontal size={15} />
              </button>
            }
            items={[
              { label: "主机笔记", icon: <NotebookPen size={14} />, onSelect: () => setNotes(true) },
              { label: "编辑", icon: <Pencil size={14} />, onSelect: onEdit },
              // 本机删不掉（契约第 1 节）：不想要它就用 BUNSEN_NO_LOCAL=1 启动。
              ...(local ? [] : ["sep" as const, { label: "删除", icon: <Trash2 size={14} />, danger: true, onSelect: () => setConfirmDel(true) }]),
            ]}
          />
        </div>
      </header>

      {local ? (
        <div className="server-sub">
          {serverAddr(server)}
          {server.last_checked && <span className="dim"> · {relTime(server.last_checked)}检查</span>}
        </div>
      ) : (
        <div className="server-sub mono">
          {serverAddr(server)}
          {server.proxy_jump && <span className="dim"> 经 {server.proxy_jump}</span>}
          <span className="dim sans">
            {" · "}
            {server.key ? (
              <>
                <KeyRound size={11} /> {server.key}
              </>
            ) : (
              "未指定密钥"
            )}
            {server.last_checked && ` · ${relTime(server.last_checked)}检查`}
          </span>
        </div>
      )}
      {server.status !== "online" && server.status_detail && <div className="note err">{server.status_detail}</div>}
      {server.note && <div className="server-note">{server.note}</div>}

      {p ? (
        <>
          <div className="server-facts">
            <span>{p.os}</span>
            <span>{p.arch}</span>
            <span>{p.cpus} 核</span>
            <span>
              内存 {gb(p.mem_free_gb)} / {gb(p.mem_total_gb)}
            </span>
            {p.disk_home && (
              <span>
                磁盘 {gb(p.disk_home.free_gb)} / {gb(p.disk_home.total_gb)}
              </span>
            )}
            <span className={p.tmux.present ? undefined : "c-err"}>tmux {p.tmux.present ? (p.tmux.version ?? "") : "缺失"}</span>
            {p.tools.git && <span>git {p.tools.git}</span>}
            {p.tools.python && <span>python {p.tools.python}</span>}
            {p.tools.node && <span>node {p.tools.node}</span>}
          </div>

          <div className="agent-chips">
            {agents.map((a) => {
              const on = p.agents[a.id];
              const present = on?.present ?? false;
              return (
                <button key={a.id} type="button" className={cx("agent-chip", present && "on")} onClick={() => setInstall(a)} title={present ? `${a.name} ${on?.version ?? ""}\n${on?.path ?? ""}\n点开可以登录` : `点击安装 ${a.name}`}>
                  <AgentMark id={a.id} name={a.name} size={15} />
                  {a.name}
                  {present ? <span className="dim">{on?.version ?? "已安装"}</span> : <Download size={11} />}
                </button>
              );
            })}
          </div>

          {p.gpus.length > 0 && <GpuTable gpus={p.gpus} />}
        </>
      ) : (
        <div className="server-facts dim">未探测</div>
      )}

      <ShellDialog server={server} open={shell} onOpenChange={setShell} />
      {notes && <NotesDialog server={server} onClose={() => setNotes(false)} />}
      {install && <InstallDialog server={server} agent={install} open onOpenChange={(v) => !v && setInstall(null)} />}
      <Confirm
        open={confirmDel}
        onOpenChange={setConfirmDel}
        title={`删除 ${server.alias}？`}
        body="只删除本机记录。"
        confirmLabel="删除"
        danger
        onConfirm={() =>
          void api
            .deleteServer(server.id)
            .then(() => dropServer(server.id))
            .catch(fail)
        }
      />
    </article>
  );
}

/** 每台服务器一份笔记，存在服务器的 ~/.bunsen/HOST.md，Agent 也能读写。 */
function NotesDialog({ server, onClose }: { server: Server; onClose: () => void }) {
  const fail = useApp((s) => s.fail);
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .notes(server.id)
      .then((n) => {
        setText(n.text);
        setSaved(n.text);
        if (!n.text.trim()) setMode("edit");
      })
      .catch((e) => {
        fail(e);
        onClose();
      });
  }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (text === null) return;
    setBusy(true);
    try {
      const n = await api.putNotes(server.id, text);
      setSaved(n.text);
      setText(n.text);
      setMode("view");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      size="lg"
      title={`主机笔记 · ${server.alias}`}
      description={<code>~/.bunsen/HOST.md</code>}
      footer={
        <>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "view", label: "预览" },
              { value: "edit", label: "编辑" },
            ]}
          />
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" loading={busy} disabled={text === null || text === saved} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      {text === null ? (
        <Empty title={<Spinner />} />
      ) : mode === "edit" ? (
        <textarea className="field mono notes-edit" value={text} spellCheck={false} autoFocus onChange={(e) => setText(e.target.value)} placeholder={"## 环境\n\n## 数据\n\n## 注意"} />
      ) : (
        <div className="notes-view">{text.trim() ? <Markdown text={text} images="link" /> : <Empty title="空" />}</div>
      )}
    </Modal>
  );
}

function ServerForm({ server, keys, onClose }: { server: Server | null; keys: KeyInfo[]; onClose: () => void }) {
  const setServer = useApp((s) => s.setServer);
  const fail = useApp((s) => s.fail);
  const [f, setF] = useState({
    alias: server?.alias ?? "",
    host: server?.host ?? "",
    user: server?.user ?? "",
    port: String(server?.port ?? 22),
    key: server?.key ?? "",
    proxy_jump: server?.proxy_jump ?? "",
    default_workdir: server?.default_workdir ?? "~",
    note: server?.note ?? "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  // 本机只能改别名、默认工作目录和备注；带上连接参数服务端会拒绝（契约第 1 节）。
  const local = isLocal(server);
  const port = Number(f.port);
  const valid = local ? f.alias.trim() : f.alias.trim() && f.host.trim() && f.user.trim() && Number.isInteger(port) && port > 0 && port < 65536;

  const save = async () => {
    setBusy(true);
    const common = { alias: f.alias.trim(), default_workdir: f.default_workdir.trim() || "~", note: f.note };
    const body: ServerInput = {
      ...common,
      host: f.host.trim(),
      user: f.user.trim(),
      port,
      key: f.key || null,
      proxy_jump: f.proxy_jump.trim() || null,
    };
    try {
      const saved = server ? await api.patchServer(server.id, local ? common : body) : await api.addServer(body);
      setServer(saved);
      onClose();
      // 存完顺手测一次，结果直接反映在卡片上。
      void api
        .testServer(saved.id, !isLocal(saved) && !saved.key)
        .then((r) => setServer(r.server))
        .catch(() => undefined);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={server ? `编辑 ${server.alias}` : "添加服务器"}
      description={local ? "本机不经 ssh，会话跑在这台电脑的 tmux 里；连接参数不用填。" : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void save()}>
            保存并测试
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="名称">
          <input className="field" value={f.alias} onChange={set("alias")} placeholder={local ? "local" : "gpu1"} autoFocus spellCheck={false} />
        </Field>
        {!local && (
          <>
            <Field label="用户">
              <input className="field" value={f.user} onChange={set("user")} placeholder="ubuntu" spellCheck={false} />
            </Field>
            <Field label="地址">
              <input className="field" value={f.host} onChange={set("host")} placeholder="192.168.1.20" spellCheck={false} />
            </Field>
            <Field label="端口">
              <input className="field" value={f.port} onChange={set("port")} inputMode="numeric" />
            </Field>
            <Field label="密钥" >
              <Picker
                variant="field"
                value={f.key || "__none"}
                onChange={(v) => setF((prev) => ({ ...prev, key: v === "__none" ? "" : v }))}
                placeholder="选择密钥"
                options={[{ value: "__none", label: "自动尝试" }, ...keys.map((k) => ({ value: k.name, label: k.name, hint: k.kind }))]}
              />
            </Field>
            <Field label="跳板机（可选）">
              <input className="field" value={f.proxy_jump} onChange={set("proxy_jump")} placeholder="user@host" spellCheck={false} />
            </Field>
          </>
        )}
        <Field label="默认工作目录">
          <input className="field" value={f.default_workdir} onChange={set("default_workdir")} spellCheck={false} />
        </Field>
        <Field label="备注（可选）" className={local ? "wide" : undefined}>
          <input className="field" value={f.note} onChange={set("note")} />
        </Field>
      </div>
    </Modal>
  );
}

function KeyList({ keys }: { keys: KeyInfo[] }) {
  const loadKeys = useApp((s) => s.loadKeys);
  const fail = useApp((s) => s.fail);
  const [del, setDel] = useState<KeyInfo | null>(null);
  return (
    <section className="keys">
      <h2>密钥</h2>
      <div className="key-list">
        {keys.map((k) => (
          <div key={k.name} className="key-row">
            <KeyRound size={14} className="dim" />
            <b>{k.name}</b>
            <span className="dim">{k.kind}</span>
            <span className="mono dim ellipsis">{k.fingerprint}</span>
            <span className="grow" />
            <span className="dim">{k.used_by.join(" · ")}</span>
            <button type="button" className="icon-btn" aria-label={`删除 ${k.name}`} disabled={k.used_by.length > 0} title={k.used_by.length > 0 ? "还有服务器在用" : "删除"} onClick={() => setDel(k)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <Confirm
        open={del !== null}
        onOpenChange={(v) => !v && setDel(null)}
        title={`删除密钥 ${del?.name ?? ""}？`}
        body="从 Bunsen 中删除这把私钥，不可恢复。~/.ssh 里的原件不受影响。"
        confirmLabel="删除"
        danger
        onConfirm={() => del && void api.deleteKey(del.name).then(loadKeys).catch(fail)}
      />
    </section>
  );
}
