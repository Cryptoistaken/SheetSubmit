import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { configureBoneyard } from "boneyard-js/react";

import App from "./App";

configureBoneyard({
  animate: "shimmer",
  color: "#ececec",
  darkColor: "#262626",
  transition: 300,
  select: "viewport",
});
import { AuthProvider } from "@/contexts/AuthContext";
import { ConfirmProvider } from "@/lib/confirm";
import { ToastProvider } from "@/lib/toast";
import { IS_TOUCH } from "@/lib/device";
import "@/bones/registry";
import "./index.css";

document.body.classList.toggle("is-touch", IS_TOUCH);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  // stale chunk / M_ID crash after deploy → reload once (old chunk referencing deleted asset)
  const chunkErr = (msg: string) =>
    /M_ID|ChunkLoadError|Failed to fetch dynamically imported module|Loading chunk|200\.js/.test(msg);
  window.addEventListener("error", (e) => {
    if (chunkErr(e.message || "")) {
      if (!sessionStorage.getItem("ss_chunk_reload_sw")) {
        sessionStorage.setItem("ss_chunk_reload_sw", "1");
        location.reload();
      }
    }
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const m = String((e.reason as Error)?.message || e.reason || "");
    if (chunkErr(m)) {
      if (!sessionStorage.getItem("ss_chunk_reload_sw")) {
        sessionStorage.setItem("ss_chunk_reload_sw", "1");
        location.reload();
      }
    }
  });
}
