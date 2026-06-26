import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface AdminUiContextValue {
  isAdmin: boolean;
}

const AdminUiContext = createContext<AdminUiContextValue>({ isAdmin: false });

export function AdminUiProvider({
  isAdmin,
  children,
}: {
  isAdmin: boolean;
  children: React.ReactNode;
}) {
  return (
    <AdminUiContext.Provider value={{ isAdmin }}>
      {children}
      {isAdmin && <AdminRoleTooltipLayer />}
    </AdminUiContext.Provider>
  );
}

export function useAdminUi() {
  return useContext(AdminUiContext);
}

export function getAdminRoleTip(isAdmin: boolean, role: string, _detail?: React.ReactNode) {
  if (!isAdmin) return undefined;
  return role;
}

type AdminRoleTipState = {
  text: string;
  anchor: HTMLElement;
  x: number;
  y: number;
};

function AdminRoleTooltipLayer() {
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<AdminRoleTipState | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    const getTipElement = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      return target.closest<HTMLElement>('[data-admin-role-tip]');
    };

    const placeTip = (anchor: HTMLElement) => {
      const text = anchor.dataset.adminRoleTip;
      if (!text) return;
      const rect = anchor.getBoundingClientRect();
      setTip({
        text,
        anchor,
        x: rect.left + rect.width / 2,
        y: rect.top - 8,
      });
    };

    const showTip = (event: PointerEvent | FocusEvent) => {
      const anchor = getTipElement(event.target);
      if (anchor) placeTip(anchor);
    };

    const hideTip = (event: PointerEvent | FocusEvent) => {
      const next = 'relatedTarget' in event ? getTipElement(event.relatedTarget) : null;
      if (!next) setTip(null);
    };

    const refreshTip = () => {
      setTip((current) => {
        if (!current || !document.contains(current.anchor)) return null;
        const rect = current.anchor.getBoundingClientRect();
        return {
          ...current,
          x: rect.left + rect.width / 2,
          y: rect.top - 8,
        };
      });
    };

    document.addEventListener('pointerover', showTip, true);
    document.addEventListener('pointerout', hideTip, true);
    document.addEventListener('focusin', showTip, true);
    document.addEventListener('focusout', hideTip, true);
    window.addEventListener('scroll', refreshTip, true);
    window.addEventListener('resize', refreshTip);

    return () => {
      document.removeEventListener('pointerover', showTip, true);
      document.removeEventListener('pointerout', hideTip, true);
      document.removeEventListener('focusin', showTip, true);
      document.removeEventListener('focusout', hideTip, true);
      window.removeEventListener('scroll', refreshTip, true);
      window.removeEventListener('resize', refreshTip);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip) return;
    const node = tipRef.current;
    if (!node) return;
    const width = node.offsetWidth;
    const margin = 10;
    setLeft(Math.min(Math.max(tip.x, width / 2 + margin), window.innerWidth - width / 2 - margin));
  }, [tip]);

  if (!tip) return null;

  return (
    <div
      ref={tipRef}
      className="admin-role-tooltip"
      style={{
        left,
        top: tip.y,
      }}
    >
      {tip.text}
    </div>
  );
}
