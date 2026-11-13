import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { captureToken } from "./lib/api";

// 先用上次的主题，免得设置读回来之前闪一下。
try {
  const t = localStorage.getItem("bunsen.theme");
  if (t) document.documentElement.dataset.theme = JSON.parse(t);
} catch {
  /* 用默认的深色 */
}

captureToken();
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
