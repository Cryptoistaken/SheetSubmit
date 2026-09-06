import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
      <Dialog open={!!state} onOpenChange={(o) => { if (!o) close(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{state?.message ?? ""}</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => close(true)}>{state?.okText ?? "Delete"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (message: string, okText?: string) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx.confirm;
}
