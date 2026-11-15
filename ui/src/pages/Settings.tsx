import { ExternalLink, FlaskConical, Monitor, Moon, Pencil, RotateCcw, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentMark, Badge, Button, Dialog, EmptyLine, Fact, Facts, Field, ICON, IconButton, Page, Picker, Row, Section, Segmented, Tip } from "../components/ui";
import { api, type Agent, type Settings as SettingsT } from "../lib/api";
import { serverAddr } from "../lib/format";
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
    <Page title="设置" data-page="settings">
      <div className="sections">
        <Section title="外观">
          <div className="form-col">
            {/* 分段控件不放进 label：点标签文字会触发第一个选项 */}
            <div className="field-group">
              <span className="field-label">主题</span>
              <div>
                <Segmented<SettingsT["theme"]>
                  label="主题"
                  value={settings.theme}
                  onChange={(theme) => void save({ theme })}
                  options={[
                    { value: "dark", label: <><Moon size={ICON.sm} /> 深色</> },
                    { value: "light", label: <><Sun size={ICON.sm} /> 浅色</> },
                    { value: "system", label: <><Monitor size={ICON.sm} /> 跟随系统</> },
                  ]}
                />
              </div>
            </div>
          </div>
        </Section>

        <Section title="默认值">
          <div className="form-col">
            <Field label="服务器">
              <Picker
                variant="field"
                value={settings.default_server ?? "__last"}
                onChange={(v) => void save({ default_server: v === "__last" ? null : v })}
                placeholder="上次用的"
                options={[{ value: "__last", label: "上次用的" }, ...servers.map((s) => ({ value: s.id, label: s.alias, hint: serverAddr(s) }))]}
              />
            </Field>
            <Field label="Agent">
              <Picker
                variant="field"
                value={settings.default_agent ?? "__last"}
                onChange={(v) => void save({ default_agent: v === "__last" ? null : v })}
                placeholder="上次用的"
                options={[{ value: "__last", label: "上次用的" }, ...agents.map((a) => ({ value: a.id, label: a.name, hint: a.vendor, left: <AgentMark id={a.id} name={a.name} /> }))]}
              />
            </Field>
            <Field label="状态刷新间隔">
              <Picker
                variant="field"
                value={String(settings.status_interval_secs)}
                onChange={(v) => void save({ status_interval_secs: Number(v) })}
                placeholder="30 秒"
                options={[15, 30, 60, 120, 300].map((n) => ({ value: String(n), label: n < 60 ? `${n} 秒` : `${n / 60} 分钟` }))}
              />
            </Field>
          </div>
        </Section>

        <Section title="科研套件" count={plugins.length}>
          {plugins.length === 0 ? (
            <EmptyLine>没有插件</EmptyLine>
          ) : (
            <div className="list">
              {plugins.map((p) => (
                <Row
                  key={p.name}
                  data-plugin={p.name}
                  lead={<FlaskConical size={ICON.md} />}
                  title={[...p.skills, ...p.agents.map((a) => `@${a}`)].join(" · ")}
                  name={
                    <>
                      {p.name} <span className="muted">{p.version}</span> <Badge>{p.source === "bundled" ? "内置" : "本机"}</Badge>
                    </>
                  }
                  meta={`${p.skills.length} 个技能 · ${p.agents.length} 个子代理`}
                />
              ))}
            </div>
          )}
          <div className="form-col">
            <Field label="用本机目录覆盖内置的 research" hint="留空就用内置的。保存后重新读取插件。">
              <div className="row">
                <input className="input mono grow" value={pluginPath} spellCheck={false} placeholder="/Users/你/project/research_plugin" onChange={(e) => setPluginPath(e.target.value)} />
                <Button variant="primary" disabled={(pluginPath.trim() || null) === settings.research_plugin_path} onClick={() => void save({ research_plugin_path: pluginPath.trim() || null }).then(loadPlugins)}>
                  保存
                </Button>
              </div>
            </Field>
          </div>
        </Section>

        <Section
          title="Agent"
          count={agents.length}
          end={
            <Button size="sm" variant="ghost" onClick={() => setEditing({ id: "", name: "", vendor: "", description: "", detect: "", launch: "", launch_with_prompt: null, resume: null, yolo_flag: null, plugin_dir_flag: null, install: [], auth_hint: "", docs_url: "", builtin: false })}>
              添加 Agent
            </Button>
          }
        >
          <div className="list">
            {agents.map((a) => (
              <Row
                key={a.id}
                data-agent={a.id}
                lead={<AgentMark id={a.id} name={a.name} />}
                name={
                  <>
                    {a.name} <span className="muted">{a.vendor}</span>
                  </>
                }
                meta={<span className="mono">{a.launch}</span>}
                onClick={() => setEditing(a)}
                tail={
                  <>
                    {a.docs_url && (
                      <Tip label="文档">
                        <a className="icon-button" data-size="sm" href={a.docs_url} target="_blank" rel="noopener noreferrer" aria-label="文档">
                          <ExternalLink size={ICON.md} />
                        </a>
                      </Tip>
                    )}
                    <IconButton label={`编辑 ${a.name}`} size="sm" onClick={() => setEditing(a)}>
                      <Pencil size={ICON.sm} />
                    </IconButton>
                  </>
                }
              />
            ))}
          </div>
        </Section>

        {meta && (
          <Section title="关于">
            <Facts>
              <Fact label="版本">
                Bunsen {meta.version}
                {meta.dev ? "（开发模式）" : ""}
              </Fact>
              <Fact label="数据目录">
                <span className="mono">{meta.data_dir}</span>
              </Fact>
            </Facts>
          </Section>
        )}
      </div>
      {editing && <AgentForm agent={editing} onClose={() => setEditing(null)} />}
    </Page>
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
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      size="lg"
      title={isNew ? "添加 Agent" : a.name}
      description={a.description || undefined}
      footer={
        <>
          {!isNew && (
            // 危险色只用在确认框（设计稿第 2 节）：这里用 ghost，删除自定义 Agent 写在文字上
            <Button variant="ghost" icon={agent.builtin ? <RotateCcw size={ICON.md} /> : undefined} disabled={busy} onClick={() => void reset()}>
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
        <Field label="标识">
          <input className="input mono" {...text("id")} disabled={!isNew} placeholder="my-agent" />
        </Field>
        <Field label="名称">
          <input className="input" {...text("name")} />
        </Field>
        <Field label="可执行文件名">
          <input className="input mono" {...text("detect")} placeholder="claude" />
        </Field>
        <Field label="厂商">
          <input className="input" {...text("vendor")} />
        </Field>
        <Field label="启动命令">
          <input className="input mono" {...text("launch")} placeholder="claude" />
        </Field>
        <Field label="带初始提示启动">
          <input className="input mono" {...text("launch_with_prompt")} placeholder="claude {prompt}" />
        </Field>
        <Field label="接续上次对话">
          <input className="input mono" {...text("resume")} placeholder="claude --continue" />
        </Field>
        <Field label="免确认开关">
          <input className="input mono" {...text("yolo_flag")} placeholder="--dangerously-skip-permissions" />
        </Field>
        <Field label="插件目录开关">
          <input className="input mono" {...text("plugin_dir_flag")} placeholder="--plugin-dir {dir}" />
        </Field>
        <Field label="文档地址">
          <input className="input" {...text("docs_url")} />
        </Field>
      </div>
      <div className="stack">
      <Field label="安装方式" hint="名称 | 命令，每行一种">
        <textarea className="input mono" rows={3} value={install} spellCheck={false} onChange={(e) => setInstall(e.target.value)} placeholder="官方脚本 | curl -fsSL https://example.com/install.sh | bash" />
      </Field>
      <Field label="怎么登录">
        <textarea className="input" rows={2} {...text("auth_hint")} />
      </Field>
      </div>
    </Dialog>
  );
}
