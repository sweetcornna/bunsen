import { ExternalLink, FlaskConical, Monitor, Moon, Pencil, RotateCcw, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentMark, Button, Field, Modal, Picker, Segmented } from "../components/ui";
import { api, type Agent, type Settings as SettingsT } from "../lib/api";
import { useApp } from "../lib/store";

export function Settings() {
  const settings = useApp((s) => s.settings);
  const meta = useApp((s) => s.meta);
  const servers = useApp((s) => s.servers);
  const agents = useApp((s) => s.agents);
  const plugins = useApp((s) => s.plugins);
  const loadPlugins = useApp((s) => s.loadPlugins);
  const save = useApp((s) => s.saveSettings);
  const [pluginPath, setPluginPath] = useState(settings?.research_plugin_path ?? "");
  const [editing, setEditing] = useState<Agent | null>(null);

  useEffect(() => setPluginPath(settings?.research_plugin_path ?? ""), [settings?.research_plugin_path]);
  if (!settings) return null;

  return (
    <div className="page">
      <div className="page-inner narrow">
        <header className="page-head">
          <div>
            <h1>设置</h1>
          </div>
        </header>

        <section className="card">
          <h3>外观</h3>
          <div className="setting">
            <div>
              <b>主题</b>
            </div>
            <Segmented<SettingsT["theme"]>
              value={settings.theme}
              onChange={(theme) => void save({ theme })}
              options={[
                { value: "dark", label: <><Moon size={12} /> 深色</> },
                { value: "light", label: <><Sun size={12} /> 浅色</> },
                { value: "system", label: <><Monitor size={12} /> 跟随系统</> },
              ]}
            />
          </div>
        </section>

        <section className="card">
          <h3>默认值</h3>
          <div className="setting">
            <div>
              <b>服务器</b>
            </div>
            <Picker
              variant="field"
              value={settings.default_server ?? "__last"}
              onChange={(v) => void save({ default_server: v === "__last" ? null : v })}
              placeholder="上次用的"
              options={[{ value: "__last", label: "上次用的" }, ...servers.map((s) => ({ value: s.id, label: s.alias, hint: `${s.user}@${s.host}` }))]}
            />
          </div>
          <div className="setting">
            <div>
              <b>Agent</b>
            </div>
            <Picker
              variant="field"
              value={settings.default_agent ?? "__last"}
              onChange={(v) => void save({ default_agent: v === "__last" ? null : v })}
              placeholder="上次用的"
              options={[{ value: "__last", label: "上次用的" }, ...agents.map((a) => ({ value: a.id, label: a.name, hint: a.vendor, left: <AgentMark id={a.id} name={a.name} /> }))]}
            />
          </div>
          <div className="setting">
            <div>
              <b>状态刷新间隔</b>
            </div>
            <Picker
              variant="field"
              value={String(settings.status_interval_secs)}
              onChange={(v) => void save({ status_interval_secs: Number(v) })}
              placeholder="30 秒"
              options={[15, 30, 60, 120, 300].map((n) => ({ value: String(n), label: n < 60 ? `${n} 秒` : `${n / 60} 分钟` }))}
            />
          </div>
        </section>

        <section className="card">
          <h3>科研套件</h3>
          <div className="agent-table">
            {plugins.map((p) => (
              <div key={p.name} className="agent-row">
                <FlaskConical size={16} className="c-accent" />
                <div className="agent-row-main">
                  <div>
                    <b>{p.name}</b> <span className="dim">{p.version}</span> <span className="tag">{p.source === "bundled" ? "内置" : "本机"}</span>
                  </div>
                  <code className="ellipsis">{[...p.skills, ...p.agents.map((a) => `@${a}`)].join(" · ")}</code>
                </div>
              </div>
            ))}
            {plugins.length === 0 && <div className="agent-row dim">没有插件</div>}
          </div>
          <div className="setting col">
            <div>
              <b>用本机目录覆盖内置的 research</b>
            </div>
            <div className="row">
              <input className="field mono grow" value={pluginPath} spellCheck={false} placeholder="/Users/你/project/research_plugin" onChange={(e) => setPluginPath(e.target.value)} />
              <Button variant="primary" disabled={(pluginPath.trim() || null) === settings.research_plugin_path} onClick={() => void save({ research_plugin_path: pluginPath.trim() || null }).then(loadPlugins)}>
                保存
              </Button>
            </div>
          </div>
        </section>

        <section className="card">
          <h3>Agent</h3>
          <div className="agent-table">
            {agents.map((a) => (
              <div key={a.id} className="agent-row">
                <AgentMark id={a.id} name={a.name} size={22} />
                <div className="agent-row-main">
                  <div>
                    <b>{a.name}</b> <span className="dim">{a.vendor}</span>
                  </div>
                  <code className="ellipsis">{a.launch}</code>
                </div>
                {a.docs_url && (
                  <a className="icon-btn" href={a.docs_url} target="_blank" rel="noopener noreferrer" aria-label="文档">
                    <ExternalLink size={13} />
                  </a>
                )}
                <button type="button" className="icon-btn" aria-label={`编辑 ${a.name}`} onClick={() => setEditing(a)}>
                  <Pencil size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="row">
            <Button onClick={() => setEditing({ id: "", name: "", vendor: "", description: "", detect: "", launch: "", launch_with_prompt: null, resume: null, yolo_flag: null, plugin_dir_flag: null, install: [], auth_hint: "", docs_url: "", builtin: false })}>
              添加 Agent
            </Button>
          </div>
        </section>

        {meta && (
          <section className="card">
            <h3>关于</h3>
            <dl className="facts">
              <dt>版本</dt>
              <dd>Outpost {meta.version}{meta.dev ? "（开发模式）" : ""}</dd>
              <dt>数据目录</dt>
              <dd className="mono">{meta.data_dir}</dd>
            </dl>
          </section>
        )}
      </div>
      {editing && <AgentForm agent={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AgentForm({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const loadAgents = useApp((s) => s.loadAgents);
  const fail = useApp((s) => s.fail);
  const isNew = agent.id === "";
  const [a, setA] = useState<Agent>(agent);
  const [install, setInstall] = useState(agent.install.map((m) => `${m.label} | ${m.cmd}`).join("\n"));
  const [busy, setBusy] = useState(false);
  const text = (k: keyof Agent) => ({
    value: (a[k] as string | null) ?? "",
    onChange: (e: { target: { value: string } }) => setA((p) => ({ ...p, [k]: e.target.value })),
    spellCheck: false,
  });
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(a.id) && a.name.trim() && a.detect.trim() && a.launch.trim();

  const save = async () => {
    setBusy(true);
    const nullable = (s: string | null) => (s && s.trim() ? s.trim() : null);
    try {
      await api.putAgent({
        ...a,
        launch_with_prompt: nullable(a.launch_with_prompt),
        resume: nullable(a.resume),
        yolo_flag: nullable(a.yolo_flag),
        plugin_dir_flag: nullable(a.plugin_dir_flag),
        install: install
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf("|");
            return i < 0 ? { label: "安装", cmd: l } : { label: l.slice(0, i).trim(), cmd: l.slice(i + 1).trim() };
          }),
      });
      await loadAgents();
      onClose();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api.deleteAgent(a.id);
      await loadAgents();
      onClose();
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
      title={isNew ? "添加 Agent" : a.name}
      description={a.description || undefined}
      footer={
        <>
          {!isNew && (
            <Button variant={agent.builtin ? "default" : "danger"} icon={agent.builtin ? <RotateCcw size={13} /> : undefined} disabled={busy} onClick={() => void reset()}>
              {agent.builtin ? "还原默认" : "删除"}
            </Button>
          )}
          <span className="grow" />
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!valid} loading={busy} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="标识" >
          <input className="field mono" {...text("id")} disabled={!isNew} placeholder="my-agent" />
        </Field>
        <Field label="名称">
          <input className="field" {...text("name")} />
        </Field>
        <Field label="可执行文件名">
          <input className="field mono" {...text("detect")} placeholder="claude" />
        </Field>
        <Field label="厂商">
          <input className="field" {...text("vendor")} />
        </Field>
        <Field label="启动命令">
          <input className="field mono" {...text("launch")} placeholder="claude" />
        </Field>
        <Field label="带初始提示启动">
          <input className="field mono" {...text("launch_with_prompt")} placeholder="claude {prompt}" />
        </Field>
        <Field label="接续上次对话">
          <input className="field mono" {...text("resume")} placeholder="claude --continue" />
        </Field>
        <Field label="免确认开关">
          <input className="field mono" {...text("yolo_flag")} placeholder="--dangerously-skip-permissions" />
        </Field>
        <Field label="插件目录开关">
          <input className="field mono" {...text("plugin_dir_flag")} placeholder="--plugin-dir {dir}" />
        </Field>
        <Field label="文档地址">
          <input className="field" {...text("docs_url")} />
        </Field>
      </div>
      <Field label="安装方式" hint="名称 | 命令，每行一种">
        <textarea className="field mono" rows={3} value={install} spellCheck={false} onChange={(e) => setInstall(e.target.value)} placeholder="官方脚本 | curl -fsSL https://example.com/install.sh | bash" />
      </Field>
      <Field label="怎么登录">
        <textarea className="field" rows={2} {...text("auth_hint")} />
      </Field>
    </Modal>
  );
}
