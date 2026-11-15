import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Agent, type Server } from "../lib/api";
import { useApp } from "../lib/store";
import { TerminalView } from "./Terminal";
import { Button, Dialog, ICON, Notice, Row, Segmented } from "./ui";

/** 在服务器上装一个 Agent，并顺手登录。安装跑在 tmux 里，关掉窗口也不会断。 */
export function InstallDialog({ server, agent, open, onOpenChange }: { server: Server; agent: Agent; open: boolean; onOpenChange: (v: boolean) => void }) {
  const setServer = useApp((s) => s.setServer);
  const toast = useApp((s) => s.toast);
  const fail = useApp((s) => s.fail);
  const [method, setMethod] = useState(0);
  const [phase, setPhase] = useState<"choose" | "run">("choose");
  const [tab, setTab] = useState<"install" | "login">("install");
  const [loginOpened, setLoginOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const present = server.probe?.agents[agent.id]?.present ?? false;

  useEffect(() => {
    if (open) {
      setPhase(present ? "run" : "choose");
      setTab(present ? "login" : "install");
      setLoginOpened(present);
      setMethod(0);
    }
  }, [open, present]);

  const start = async () => {
    setBusy(true);
    try {
      await api.installAgent(server.id, agent.id, method);
      setPhase("run");
      setTab("install");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    setBusy(true);
    try {
      const s = await api.probeServer(server.id);
      setServer(s);
      const a = s.probe?.agents[agent.id];
      toast(a?.present ? "ok" : "info", a?.present ? `${agent.name} 已就绪${a.version ? `（${a.version}）` : ""}` : `还没找到 ${agent.detect}，安装可能还在进行`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size={phase === "run" ? "lg" : "md"}
      title={present ? `${agent.name} · ${server.alias}` : `在 ${server.alias} 上安装 ${agent.name}`}
      footer={
        phase === "choose" ? (
          <>
            <Button variant="ghost" data-dialog-cancel="" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={agent.install.length === 0} onClick={() => void start()}>
              开始安装
            </Button>
          </>
        ) : (
          <>
            <div className="grow secondary t-dense">
              <span className="fw-medium">登录：</span>
              {agent.auth_hint}
            </div>
            <Button icon={<RefreshCw size={ICON.md} />} loading={busy} onClick={() => void recheck()}>
              重新探测
            </Button>
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          </>
        )
      }
    >
      {phase === "choose" ? (
        <div className="stack">
          {agent.install.length === 0 && <Notice tone="warn">没有登记安装命令，在设置里补上。</Notice>}
          <div className="list" role="radiogroup" aria-label="安装方式">
            {agent.install.map((m, i) => (
              <Row
                key={i}
                multi
                selected={method === i}
                onClick={() => setMethod(i)}
                role="radio"
                aria-checked={method === i}
                lead={<span className="status-dot" data-tone={method === i ? "new" : undefined} />}
                nameClass="wrap"
                name={
                  <>
                    <div className="fw-medium">{m.label}</div>
                    <div className="mono muted t-meta">{m.cmd}</div>
                  </>
                }
              />
            ))}
          </div>
          {agent.docs_url && (
            <a href={agent.docs_url} target="_blank" rel="noopener noreferrer">
              文档 <ExternalLink size={ICON.xs} />
            </a>
          )}
        </div>
      ) : (
        <div className="stack">
          <Segmented
            label="终端"
            value={tab}
            onChange={(v) => {
              setTab(v);
              if (v === "login") setLoginOpened(true);
            }}
            options={[
              { value: "install", label: "安装输出" },
              { value: "login", label: "登录终端" },
            ]}
          />
          <div className="dialog-term">
            {!present && (
              <div className={tab !== "install" ? "fill hidden" : "fill"}>
                <TerminalView target={{ server: server.id, pane: "install", agent: agent.id }} />
              </div>
            )}
            {present && tab === "install" && (
              <div className="fill">
                <Notice>已安装</Notice>
              </div>
            )}
            {loginOpened && (
              <div className={tab !== "login" ? "fill hidden" : "fill"}>
                <TerminalView target={{ server: server.id, pane: "shell" }} autoFocus />
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function ShellDialog({ server, open, onOpenChange }: { server: Server; open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title={`终端 · ${server.alias}`}>
      <div className="dialog-term" data-tall="">
        {open && <TerminalView target={{ server: server.id, pane: "shell" }} autoFocus />}
      </div>
    </Dialog>
  );
}
