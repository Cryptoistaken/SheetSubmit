import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { AuthProvider } from "@/contexts/AuthContext";
import { ConfirmProvider } from "@/lib/confirm";
import { ToastProvider } from "@/lib/toast";
import { IS_TOUCH } from "@/lib/device";
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
}
