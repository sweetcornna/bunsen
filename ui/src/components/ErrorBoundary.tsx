import { TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { go } from "../lib/route";
import { Button, Empty, Logo } from "./ui";

type Props = { children: ReactNode; page?: boolean };
type State = { error: Error | null };

/**
 * 渲染出错时不白屏，显示原因和出路。
 * - 最外层（main.tsx）：整个界面换成出错页，“重新载入”前把地址里的路由（# 后面）清掉，免得同一个坏地址再出错一次；
 *   令牌在 sessionStorage 里，不受影响。
 * - page：包住主区域的一页（App.tsx 里以路由为 key，换页就重置），出错时侧栏还在，可以“重试”这一页或回首页。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("界面出错", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const reason = error.message || String(error);
    if (this.props.page) {
      return (
        <div className="page center">
          <Empty icon={<TriangleAlert size={22} />} title="这一页出错了" hint={<span className="mono">{reason}</span>}>
            <Button onClick={() => this.setState({ error: null })}>重试</Button>
            <Button
              onClick={() => {
                this.setState({ error: null });
                go("/");
              }}
            >
              回到首页
            </Button>
          </Empty>
        </div>
      );
    }
    return (
      <div className="splash">
        <Logo size={28} />
        <h1>界面出错了</h1>
        <p className="mono">{reason}</p>
        <p>重新载入会回到首页；服务器上的对话不受影响。</p>
        <Button
          variant="primary"
          onClick={() => {
            history.replaceState(null, "", window.location.pathname + window.location.search);
            window.location.reload();
          }}
        >
          重新载入
        </Button>
      </div>
    );
  }
}
