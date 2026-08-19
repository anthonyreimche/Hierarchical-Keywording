// Minimal popover menu (core's ContextMenu isn't exposed to extensions).
// Fixed-positioned at the pointer, dismissed by backdrop click or Escape.
// Pointer coordinates are divided by the body zoom (interface scale) — under
// CSS zoom, clientX/Y are visual pixels while fixed positioning lays out in
// pre-zoom units.

import type { ReactElement, ReactNode } from "react";
import { React, ui } from "../runtime";

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}

interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

function uiZoom(): number {
  if (typeof getComputedStyle !== "function") return 1;
  const raw = (getComputedStyle(document.body) as CSSStyleDeclaration & { zoom?: string }).zoom;
  const zoom = parseFloat(raw ?? "1");
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

export function useMenu(): {
  menu: ReactNode;
  openMenu(e: { clientX: number; clientY: number }, items: MenuItem[]): void;
} {
  const [open, setOpen] = React.useState<OpenMenu | null>(null);

  const openMenu = React.useCallback((e: { clientX: number; clientY: number }, items: MenuItem[]) => {
    const zoom = uiZoom();
    setOpen({ x: e.clientX / zoom, y: e.clientY / zoom, items });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const menu = !open ? null : (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 60 }}
      onClick={() => setOpen(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(null);
      }}
    >
      <div
        style={{
          position: "fixed",
          left: open.x,
          top: open.y,
          minWidth: 160,
          padding: 4,
          background: ui.tokens.surface1,
          border: `1px solid ${ui.tokens.border}`,
          borderRadius: 6,
          boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {open.items.map((item) => (
          <MenuRow key={item.label} item={item} close={() => setOpen(null)} />
        ))}
      </div>
    </div>
  );

  return { menu, openMenu };
}

function MenuRow({ item, close }: { item: MenuItem; close(): void }): ReactElement {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        if (item.disabled) return;
        close();
        item.onClick();
      }}
      style={{
        padding: "5px 10px",
        borderRadius: 4,
        fontSize: 12,
        cursor: item.disabled ? "default" : "pointer",
        opacity: item.disabled ? 0.45 : 1,
        color: item.danger ? "#e5484d" : ui.tokens.textPrimary,
        background: hover && !item.disabled ? ui.tokens.surface2 : "transparent",
        userSelect: "none",
      }}
    >
      {item.label}
    </div>
  );
}
