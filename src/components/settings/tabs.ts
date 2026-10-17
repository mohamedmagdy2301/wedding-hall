import type { Requirement } from "@/modules/users-rbac/authorize";

/** S-13 tabs in order, each with the permission its page checks on the server (D-66). */
export const SETTINGS_TABS = [
  { key: "venue", href: "/settings/venue", requires: "settings.manage" },
  { key: "spaces", href: "/settings/spaces", requires: "catalog.manage" },
  { key: "timing", href: "/settings/timing", requires: "settings.manage" },
  { key: "seasons", href: "/settings/seasons", requires: "catalog.manage" },
  { key: "services", href: "/settings/services", requires: "catalog.manage" },
  { key: "packages", href: "/settings/packages", requires: "catalog.manage" },
  { key: "eventTypes", href: "/settings/event-types", requires: "settings.manage" },
  { key: "paymentMethods", href: "/settings/payment-methods", requires: "settings.manage" },
  { key: "policies", href: "/settings/policies", requires: "settings.manage" },
  { key: "expenseCategories", href: "/settings/expense-categories", requires: "settings.manage" },
] as const satisfies ReadonlyArray<{ key: string; href: string; requires: Requirement }>;

export type SettingsTabKey = (typeof SETTINGS_TABS)[number]["key"];

export const SETTINGS_REQUIREMENTS: Requirement[] = ["settings.manage", "catalog.manage"];
