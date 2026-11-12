import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Agent, type Server } from "../lib/api";
import { useApp } from "../lib/store";
import { TerminalView } from "./Terminal";
import { Button, cx, Modal, Segmented } from "./ui";

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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size={phase === "run" ? "xl" : "md"}
      title={present ? `${agent.name} · ${server.alias}` : `在 ${server.alias} 上安装 ${agent.name}`}
      footer={
        phase === "choose" ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="primary" loading={busy} disabled={agent.install.length === 0} onClick={() => void start()}>
              开始安装
            </Button>
          </>
        ) : (
          <>
            <div className="foot-note">
              <b>登录：</b>
              {agent.auth_hint}
            </div>
            <Button icon={<RefreshCw size={13} />} loading={busy} onClick={() => void recheck()}>
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
        <div className="install-choose">
          {agent.install.length === 0 && <div className="note warn">没有登记安装命令，在设置里补上。</div>}
          {agent.install.map((m, i) => (
            <label key={i} className={cx("radio-card", method === i && "on")}>
              <input type="radio" name="install-method" checked={method === i} onChange={() => setMethod(i)} />
              <div>
                <b>{m.label}</b>
                <code>{m.cmd}</code>
              </div>
            </label>
          ))}
          {agent.docs_url && (
            <a className="link" href={agent.docs_url} target="_blank" rel="noopener noreferrer">
              文档 <ExternalLink size={12} />
            </a>
          )}
        </div>
      ) : (
        <div className="install-run">
          <Segmented
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
          <div className="install-term">
            {!present && (
              <div className={cx("fill", tab !== "install" && "hidden")}>
                <TerminalView target={{ server: server.id, pane: "install", agent: agent.id }} />
              </div>
            )}
            {present && tab === "install" && <div className="note">已安装</div>}
            {loginOpened && (
              <div className={cx("fill", tab !== "login" && "hidden")}>
                <TerminalView target={{ server: server.id, pane: "shell" }} autoFocus />
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function ShellDialog({ server, open, onOpenChange }: { server: Server; open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} size="xl" title={`终端 · ${server.alias}`} >
      <div className="install-term tall">{open && <TerminalView target={{ server: server.id, pane: "shell" }} autoFocus />}</div>
    </Modal>
  );
}
