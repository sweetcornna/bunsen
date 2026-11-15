import { Activity, Download, KeyRound, MoreHorizontal, NotebookPen, Pencil, Plus, ScanSearch, Server as ServerIcon, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Markdown } from "../components/Markdown";
import { ImportDrop } from "../components/ImportDrop";
import { InstallDialog, ShellDialog } from "../components/InstallDialog";
import { AgentMark, Badge, Button, Confirm, Dialog, Dot, Empty, Field, ICON, IconButton, Loading, Menu, Notice, Page, Picker, Row, Section, Segmented, Spinner, When } from "../components/ui";
import { api, type Agent, type KeyInfo, type Server, type ServerInput } from "../lib/api";
import { gb, serverAddr, serverStatus } from "../lib/format";
import { go } from "../lib/route";
import { isLocal, useApp } from "../lib/store";
import { GpuTable } from "../panels/OverviewPanel";

export function Servers() {
  const servers = useApp((s) => s.servers);
  const keys = useApp((s) => s.keys);
  const [editing, setEditing] = useState<Server | "new" | null>(null);

  return (
    <Page
      title="服务器"
      data-page="servers"
      actions={
        <Button variant="primary" icon={<Plus size={ICON.md} />} onClick={() => setEditing("new")}>
          添加服务器
        </Button>
      }
    >
      <ImportDrop compact={servers.length > 0} />

      {servers.length === 0 ? (
        <Empty icon={<ServerIcon size={ICON.lg} />} title="还没有服务器" hint="把 ~/.ssh/config 拖到上面导入，或者点“添加服务器”手动填写。" />
      ) : (
        <div className="card-list">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} onEdit={() => setEditing(s)} />
          ))}
        </div>
      )}

      {keys.length > 0 && <KeyList keys={keys} />}
      {editing && <ServerForm server={editing === "new" ? null : editing} keys={keys} onClose={() => setEditing(null)} />}
    </Page>
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

  // 一行元信息：系统 · 处理器 · 内存 · 磁盘 · tmux · 工具 · 检查时间。tmux 缺失是这一行唯一上色的字。
  const meta = p ? (
    <>
      {[p.os, p.arch, `${p.cpus} 核`, `内存 ${gb(p.mem_free_gb)} / ${gb(p.mem_total_gb)}`, p.disk_home && `磁盘 ${gb(p.disk_home.free_gb)} / ${gb(p.disk_home.total_gb)}`].filter(Boolean).join(" · ")}
      {" · "}
      {p.tmux.present ? `tmux ${p.tmux.version ?? ""}` : <span className="tone-err">没有 tmux</span>}
      {[p.tools.git && `git ${p.tools.git}`, p.tools.python && `python ${p.tools.python}`, p.tools.node && `node ${p.tools.node}`].filter(Boolean).map((t) => ` · ${t}`)}
      {live > 0 && ` · ${live} 个对话在运行`}
    </>
  ) : (
    <span className="muted">还没探测：在 ⋯ 菜单里点“探测”</span>
  );
  const addr = local ? serverAddr(server) : `${serverAddr(server)}${server.proxy_jump ? ` 经 ${server.proxy_jump}` : ""}`;

  return (
    <article className="surface-card server-entry" data-server={server.id}>
      <header className="card-head">
        <Dot tone={st.dot} label={st.label} />
        <span className="card-name">{server.alias}</span>
        <span className={local ? "card-addr" : "card-addr mono"} title={addr}>
          {addr}
        </span>
        {local && <Badge>本机</Badge>}
        <div className="card-actions">
          {busy && <Spinner size={ICON.sm} />}
          <Button size="sm" onClick={() => (setDraft({ server_id: server.id }), go("/"))}>
            新对话
          </Button>
          <Menu
            trigger={
              <IconButton label="更多" size="sm">
                <MoreHorizontal size={ICON.sm} />
              </IconButton>
            }
            items={[
              { label: "测试连接", icon: <Activity size={ICON.md} />, disabled: busy !== null, onSelect: () => void test() },
              { label: "探测", icon: <ScanSearch size={ICON.md} />, disabled: busy !== null, onSelect: () => void probe() },
              { label: "终端", icon: <SquareTerminal size={ICON.md} />, onSelect: () => setShell(true) },
              { label: "主机笔记", icon: <NotebookPen size={ICON.md} />, onSelect: () => setNotes(true) },
              "sep",
              { label: "编辑", icon: <Pencil size={ICON.md} />, onSelect: onEdit },
              // 本机删不掉（契约第 1 节）：不想要它就用 BUNSEN_NO_LOCAL=1 启动。
              ...(local ? [] : [{ label: "删除", icon: <Trash2 size={ICON.md} />, danger: true, onSelect: () => setConfirmDel(true) }]),
            ]}
          />
        </div>
      </header>

      {server.status === "offline" || server.status === "auth_failed" ? (
        <Notice tone={server.status === "offline" ? "err" : "warn"} raw={server.status_detail} hint={server.last_checked ? <When iso={server.last_checked} suffix=" 检查" /> : undefined}>
          {server.status === "offline" ? "连不上" : "认证失败：换一把密钥，或在服务器上把公钥加进 authorized_keys"}
        </Notice>
      ) : null}

      <div className="card-meta" title={typeof meta === "string" ? meta : undefined}>
        {meta}
        {!local && (
          <span className="muted">
            {" · "}
            {server.key ? (
              <>
                <KeyRound size={ICON.xs} /> {server.key}
              </>
            ) : (
              "未指定密钥"
            )}
          </span>
        )}
        {server.last_checked && server.status === "online" && (
          <span className="muted">
            {" · "}
            <When iso={server.last_checked} suffix=" 检查" />
          </span>
        )}
      </div>
      {server.note && <div className="card-note">{server.note}</div>}

      {p && (
        <div className="card-agents" aria-label="Agent">
          {agents.map((a) => {
            const on = p.agents[a.id];
            const present = on?.present ?? false;
            return (
              <Button
                key={a.id}
                size="xs"
                variant="ghost"
                icon={present ? <AgentMark id={a.id} name={a.name} /> : <Download size={ICON.xs} />}
                onClick={() => setInstall(a)}
                title={present ? `${a.name} ${on?.version ?? ""}\n${on?.path ?? ""}\n点开可以登录` : `点击安装 ${a.name}`}
              >
                {a.name}
                <span className="muted">{present ? (on?.version ?? "已安装") : "未安装"}</span>
              </Button>
            );
          })}
        </div>
      )}

      {p && p.gpus.length > 0 && <GpuTable gpus={p.gpus} />}

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
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      size="lg"
      title={`主机笔记 · ${server.alias}`}
      description={<code>~/.bunsen/HOST.md</code>}
      footer={
        <>
          <Segmented
            label="笔记显示方式"
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
        <Loading />
      ) : mode === "edit" ? (
        <textarea className="input mono notes-edit" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder={"## 环境\n\n## 数据\n\n## 注意"} />
      ) : (
        <div className="notes-view">{text.trim() ? <Markdown text={text} images="link" /> : <Empty title="还没有笔记" hint="点“编辑”记下这台机器的环境、数据位置和注意事项。" />}</div>
      )}
    </Dialog>
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
    <Dialog
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
          <input className="input" value={f.alias} onChange={set("alias")} placeholder={local ? "local" : "gpu1"} spellCheck={false} />
        </Field>
        {!local && (
          <>
            <Field label="用户">
              <input className="input" value={f.user} onChange={set("user")} placeholder="ubuntu" spellCheck={false} />
            </Field>
            <Field label="地址">
              <input className="input" value={f.host} onChange={set("host")} placeholder="192.168.1.20" spellCheck={false} />
            </Field>
            <Field label="端口">
              <input className="input" value={f.port} onChange={set("port")} inputMode="numeric" />
            </Field>
            <Field label="密钥">
              <Picker
                variant="field"
                value={f.key || "__none"}
                onChange={(v) => setF((prev) => ({ ...prev, key: v === "__none" ? "" : v }))}
                placeholder="选择密钥"
                options={[{ value: "__none", label: "自动尝试" }, ...keys.map((k) => ({ value: k.name, label: k.name, hint: k.kind }))]}
              />
            </Field>
            <Field label="跳板机（可选）">
              <input className="input" value={f.proxy_jump} onChange={set("proxy_jump")} placeholder="user@host" spellCheck={false} />
            </Field>
          </>
        )}
        <Field label="默认工作目录">
          <input className="input" value={f.default_workdir} onChange={set("default_workdir")} spellCheck={false} />
        </Field>
        <Field label="备注（可选）" className={local ? "wide" : undefined}>
          <input className="input" value={f.note} onChange={set("note")} />
        </Field>
      </div>
    </Dialog>
  );
}

function KeyList({ keys }: { keys: KeyInfo[] }) {
  const loadKeys = useApp((s) => s.loadKeys);
  const fail = useApp((s) => s.fail);
  const [del, setDel] = useState<KeyInfo | null>(null);
  return (
    <Section title="密钥" count={keys.length} data-section="keys">
      <div className="list">
        {keys.map((k) => (
          <Row
            key={k.name}
            data-key={k.name}
            lead={<KeyRound size={ICON.md} />}
            name={
              <>
                {k.name} <span className="muted">{k.kind}</span> <span className="mono muted t-meta">{k.fingerprint}</span>
              </>
            }
            meta={k.used_by.length > 0 ? `${k.used_by.join(" · ")} 在用` : "没有服务器在用"}
            tail={
              <IconButton label={k.used_by.length > 0 ? "还有服务器在用，不能删除" : `删除 ${k.name}`} size="sm" disabled={k.used_by.length > 0} onClick={() => setDel(k)}>
                <Trash2 size={ICON.sm} />
              </IconButton>
            }
          />
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
    </Section>
  );
}
