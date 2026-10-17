"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { SettingsTabKey } from "./tabs";

/** The tabs the user may open (filtered on the server); each page checks again (SEC-10). */
export function SettingsNav({ tabs }: { tabs: { key: SettingsTabKey; href: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={t.settings.title} className="flex gap-1 overflow-x-auto border-b pb-2">
      {tabs.map((tab) => {
        const current = pathname === tab.href;
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
              current && "bg-muted font-medium text-foreground",
            )}
          >
            {t.settings.tabs[tab.key]}
          </Link>
        );
      })}
    </nav>
  );
}
