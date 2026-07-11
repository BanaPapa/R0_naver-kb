import React, { useState, useEffect, useCallback } from 'react';

export type ToastType = 'info' | 'success' | 'error' | 'warning';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

let counter = 0;

function Toast({ id, message, type, onClose }: ToastItem & { onClose: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onClose(id), 3500);
    return () => clearTimeout(t);
  }, [id, onClose]);

  return (
    <div className={`toast ${type}`}>
      <span style={{ flex: 1 }}>{message}</span>
      <button
        onClick={() => onClose(id)}
        style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14, opacity: 0.6 }}
      >
        ✕
      </button>
    </div>
  );
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++counter;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const ToastContainer = useCallback(
    () => (
      <div className="toast-container">
        {toasts.map((t) => (
          <Toast key={t.id} {...t} onClose={removeToast} />
        ))}
      </div>
    ),
    [toasts, removeToast],
  );

  return { showToast, ToastContainer };
}
