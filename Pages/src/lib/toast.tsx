import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

interface ToastContextValue {
  showToast: (msg: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let toastFn: ((msg: string) => void) | null = null;

export function setToastFn(fn: ((msg: string) => void) | null) {
  toastFn = fn;
}

export function toast(msg: string) {
  toastFn?.(msg);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    setShow(true);
    timer.current = setTimeout(() => setShow(false), 2000);
  }, []);

  useEffect(() => {
    setToastFn(showToast);
    return () => setToastFn(null);
  }, [showToast]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-wrap">
        <div className={`toast${show ? " show" : ""}`}>{message}</div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (msg: string) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx.showToast;
}
