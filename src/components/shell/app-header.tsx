"use client";

import { ChevronDown, LogOut, KeyRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { logoutAction } from "@/server/actions/auth";
import type { CurrentUserView } from "@/server/dal";

/** `permissions`: shown when the user holds any of them. */
type NavItem = { href: string; label: string; permissions?: string[] };

const NAV: NavItem[] = [
  { href: "/", label: t.shell.home },
  { href: "/calendar", label: t.shell.calendar, permissions: ["bookings.view"] },
  { href: "/bookings", label: t.shell.bookings, permissions: ["bookings.view"] },
  { href: "/customers", label: t.shell.customers, permissions: ["bookings.view"] },
  { href: "/settings", label: t.shell.settings, permissions: ["settings.manage", "catalog.manage"] },
  { href: "/staff", label: t.shell.staff, permissions: ["users.manage"] },
  { href: "/audit", label: t.shell.audit, permissions: ["audit.view"] },
];

const isCurrent = (pathname: string, href: string) =>
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

/** Hides links the user cannot open — convenience only; every page checks on the server (SEC-10). */
export function AppHeader({ user, venueName }: { user: CurrentUserView; venueName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const items = NAV.filter(
    (item) => !item.permissions || user.isOwner || item.permissions.some((p) => user.permissions.includes(p)),
  );

  function logout() {
    startTransition(async () => {
      await logoutAction();
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="font-bold">
          {venueName || t.app.name}
        </Link>
        <nav aria-label={t.shell.menu} className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
                isCurrent(pathname, item.href) && "bg-muted font-medium text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ms-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" data-testid="account-menu">
                {user.name}
                {user.isOwner && <Badge variant="secondary">{t.shell.owner}</Badge>}
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuLabel className="text-xs text-muted-foreground" dir="ltr">
                {user.login}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/change-password">
                  <KeyRound />
                  {t.shell.changePassword}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={pending} onSelect={logout}>
                <LogOut className="rtl:rotate-180" />
                {t.shell.logout}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
