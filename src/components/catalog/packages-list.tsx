"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { useServerAction } from "@/components/forms/use-server-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { lowestRegularPrice } from "@/domain/catalog";
import { formatPiasters } from "@/domain/money";
import { t } from "@/lib/i18n";
import type { PackageListRow } from "@/modules/packages/service";
import { setPackageActiveAction } from "@/server/actions/catalog";

const tp = t.settings.packages;

/** S-13 "الباكيجات" (`catalog.manage`): grouped by space, with the slots each is bookable on (D-56). */
export function PackagesList({ packages }: { packages: PackageListRow[] }) {
  const [toggling, setToggling] = useState<PackageListRow | null>(null);
  const setActive = useServerAction(setPackageActiveAction);
  const close = () => {
    setToggling(null);
    setActive.clearError();
  };
  const groups = new Map<string, { name: string; active: boolean; rows: PackageListRow[] }>();
  for (const p of packages) {
    const group = groups.get(p.spaceId) ?? { name: p.spaceName, active: p.spaceActive, rows: [] };
    group.rows.push(p);
    groups.set(p.spaceId, group);
  }

  return (
    <div className="grid gap-4">
      <div>
        <Button asChild>
          <Link href="/settings/packages/new">
            <Plus />
            {tp.add}
          </Link>
        </Button>
      </div>
      {packages.length === 0 && <p className="text-sm text-muted-foreground">{t.settings.empty}</p>}
      {[...groups].map(([spaceId, group]) => (
        <section key={spaceId} className="grid gap-2" data-testid="package-group">
          <h2 className="flex items-center gap-2 font-semibold">
            {group.name}
            {!group.active && <Badge variant="destructive">{tp.spaceInactive}</Badge>}
          </h2>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  {/* Same widths in every space's table so the columns line up. */}
                  <TableHead className="w-1/4">{t.settings.name}</TableHead>
                  <TableHead className="w-1/4">{tp.bookable}</TableHead>
                  <TableHead className="w-1/6">{tp.fromPrice}</TableHead>
                  <TableHead className="w-1/8">{tp.itemCount}</TableHead>
                  <TableHead className="w-1/8">{t.settings.status}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t.common.actions}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.rows.map((p) => {
                  const from = lowestRegularPrice(p.prices);
                  return (
                    <TableRow key={p.id} data-testid="package-row">
                      <TableCell className="font-medium">
                        <Link href={`/settings/packages/${p.id}`} className="underline-offset-4 hover:underline">
                          {p.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {p.bookableSlots.length > 0
                          ? p.bookableSlots.map((k) => tp.slotKinds[k]).join("، ")
                          : tp.notBookable}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {from === null ? t.common.none : formatPiasters(from)}
                      </TableCell>
                      <TableCell>{p.itemCount}</TableCell>
                      <TableCell>
                        <Badge variant={p.isActive ? "outline" : "destructive"}>
                          {p.isActive ? t.settings.active : t.settings.inactive}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`${t.common.actions}: ${p.name}`}>
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem asChild>
                                <Link href={`/settings/packages/${p.id}`}>{t.settings.edit}</Link>
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => setToggling(p)}>
                                {p.isActive ? t.settings.deactivate : t.settings.activate}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}

      {toggling && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`${toggling.isActive ? tp.deactivateTitle : t.settings.activate}: ${toggling.name}`}
          description={toggling.isActive ? tp.deactivateDescription : tp.activateDescription}
          confirmLabel={toggling.isActive ? t.settings.deactivate : t.settings.activate}
          destructive={toggling.isActive}
          pending={setActive.pending}
          error={setActive.error}
          onConfirm={() =>
            setActive.run({ packageId: toggling.id, version: toggling.version, active: !toggling.isActive }, close)
          }
        />
      )}
    </div>
  );
}
