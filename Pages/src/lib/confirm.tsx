import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

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
      <AlertDialog open={!!state} onOpenChange={(o) => { if (!o) close(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>{state?.message ?? ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => close(true)}>{state?.okText ?? "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (message: string, okText?: string) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within a ConfirmProvider");
  return ctx.confirm;
}
