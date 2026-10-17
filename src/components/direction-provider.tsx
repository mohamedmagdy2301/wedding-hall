"use client";

import { Direction } from "radix-ui";

/** Radix menus, selects and dialogs read the reading direction from here (P1-05: RTL). */
export function DirectionProvider({ children }: { children: React.ReactNode }) {
  return <Direction.Provider dir="rtl">{children}</Direction.Provider>;
}
