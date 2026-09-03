import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useModalA11y } from "@/hooks/useModalA11y";

interface ConfirmState {
  message: string;
  okText: string;
}

interface ConfirmRequest {
  message: string;
  okText: string;
  resolve: (v: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (message: string, okText?: string) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const queueRef = useRef<ConfirmRequest[]>([]);

  const close = useCallback((result: boolean) => {
    const next = queueRef.current.shift();
    next?.resolve(result);
    const head = queueRef.current[0];
    setState(head ? { message: head.message, okText: head.okText } : null);
  }, []);

  const modalRef = useModalA11y(!!state, () => close(false));

  const confirm = useCallback((message: string, okText?: string) => {
    return new Promise<boolean>((resolve) => {
      queueRef.current.push({ message, okText: okText || "Delete", resolve });
      const head = queueRef.current[0];
      if (head) setState({ message: head.message, okText: head.okText });
    });
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <div
        ref={modalRef}
        className={`modal-overlay${state ? " open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Confirmation"
        onClick={(e) => {
          if (e.target === e.currentTarget) close(false);
        }}
      >
        <div className="modal-box">
          <div className="modal-title">{state?.message ?? ""}</div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => close(false)}>
              Cancel
            </button>
            <button className="btn btn-danger" onClick={() => close(true)}>
              {state?.okText ?? "Delete"}
            </button>
          </div>
        </div>
      </div>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (message: string, okText?: string) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx.confirm;
}
