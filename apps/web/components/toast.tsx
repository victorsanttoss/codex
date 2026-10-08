"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import t from "./toast.module.css";

/**
 * Toast leve do DS (contexto + portal): card escuro --ink-900, auto-dismiss 3s.
 * Uso: const toast = useToast(); toast("✓ Salvo").
 */
type ToastItem = { id: number; msg: string };
const ToastCtx = createContext<(msg: string) => void>(() => {});

export function useToast(): (msg: string) => void {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);
  const seq = useRef(0);
  useEffect(() => setMounted(true), []);

  const push = useCallback((msg: string) => {
    const id = ++seq.current;
    setToasts((prev) => [...prev, { id, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 3000);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {mounted &&
        createPortal(
          <div className={t.wrap} aria-live="polite">
            {toasts.map((item) => (
              <div key={item.id} className={t.toast}>{item.msg}</div>
            ))}
          </div>,
          document.body,
        )}
    </ToastCtx.Provider>
  );
}
