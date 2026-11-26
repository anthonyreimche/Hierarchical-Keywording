import type { ReactNode } from "react";
import { React, api } from "../runtime";
import type { ContextMenuItem } from "../safelight";

interface OpenMenu {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function useMenu(): {
  menu: ReactNode;
  openMenu(e: { clientX: number; clientY: number }, items: ContextMenuItem[]): void;
} {
  const [open, setOpen] = React.useState<OpenMenu | null>(null);

  const openMenu = React.useCallback((e: { clientX: number; clientY: number }, items: ContextMenuItem[]) => {
    setOpen({ x: e.clientX, y: e.clientY, items });
  }, []);
  const close = React.useCallback(() => setOpen(null), []);

  const { ContextMenu } = api.components;
  const menu = open ? <ContextMenu x={open.x} y={open.y} items={open.items} onClose={close} /> : null;

  return { menu, openMenu };
}
