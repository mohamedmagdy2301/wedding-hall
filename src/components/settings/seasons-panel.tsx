"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { findOverlap } from "@/domain/seasons";
import { t } from "@/lib/i18n";
import { formatIsoDate, isIsoDate } from "@/lib/time";
import type { Season } from "@/modules/settings/seasons";
import { createSeasonAction, setSeasonActiveAction, updateSeasonAction } from "@/server/actions/settings";

const ts = t.settings.seasons;

function SeasonDialog({
  season,
  seasons,
  onOpenChange,
}: {
  season?: Season;
  seasons: Season[];
  onOpenChange: (open: boolean) => void;
}) {
  const create = useServerAction(createSeasonAction);
  const update = useServerAction(updateSeasonAction);
  const { pending, error } = season ? update : create;
  const [startDate, setStartDate] = useState(season?.startDate ?? "");
  const [endDate, setEndDate] = useState(season?.endDate ?? "");

  // Names the season it would clash with (BR-31); `seasons_no_overlap` is the guarantee.
  const clash =
    (season?.isActive ?? true) && isIsoDate(startDate) && isIsoDate(endDate) && startDate <= endDate
      ? findOverlap({ id: season?.id, startDate, endDate }, seasons)
      : undefined;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    const done = () => onOpenChange(false);
    if (season) update.run({ seasonId: season.id, name, startDate, endDate }, done);
    else create.run({ name, startDate, endDate }, done);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{season ? ts.editTitle : ts.add}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError error={error?.fieldErrors ? null : error} />
          <Field label={t.settings.name} name="name" defaultValue={season?.name} error={error?.fieldErrors?.name} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label={ts.start}
              type="date"
              dir="ltr"
              className="text-start"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              error={error?.fieldErrors?.startDate}
            />
            <Field
              label={ts.end}
              type="date"
              dir="ltr"
              className="text-start"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              error={error?.fieldErrors?.endDate}
            />
          </div>
          <p className="text-xs text-muted-foreground">{ts.hint}</p>
          {clash && (
            <p className="text-xs text-destructive" data-testid="season-clash">
              {ts.overlapWith} {clash.name} ({formatIsoDate(clash.startDate)} – {formatIsoDate(clash.endDate)})
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t.common.saving : t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** S-13 "المواسم" (`catalog.manage`, D-66). */
export function SeasonsPanel({ seasons }: { seasons: Season[] }) {
  const [dialog, setDialog] = useState<{ kind: "create" } | { kind: "edit" | "toggle"; season: Season } | null>(null);
  const setActive = useServerAction(setSeasonActiveAction);
  const close = () => setDialog(null);

  return (
    <div className="grid gap-3">
      <div>
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus />
          {ts.add}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{ts.hint}</p>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.settings.name}</TableHead>
              <TableHead>{ts.range}</TableHead>
              <TableHead>{t.settings.status}</TableHead>
              <TableHead>
                <span className="sr-only">{t.common.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {seasons.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  {t.settings.empty}
                </TableCell>
              </TableRow>
            )}
            {seasons.map((season) => (
              <TableRow key={season.id} data-testid="season-row">
                <TableCell className="font-medium">{season.name}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatIsoDate(season.startDate)} – {formatIsoDate(season.endDate)}
                </TableCell>
                <TableCell>
                  <Badge variant={season.isActive ? "outline" : "destructive"}>
                    {season.isActive ? t.settings.active : t.settings.inactive}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${t.common.actions}: ${season.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", season })}>
                          {t.settings.edit}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "toggle", season })}>
                          {season.isActive ? t.settings.deactivate : t.settings.activate}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {dialog?.kind === "create" && <SeasonDialog seasons={seasons} onOpenChange={close} />}
      {dialog?.kind === "edit" && <SeasonDialog season={dialog.season} seasons={seasons} onOpenChange={close} />}
      {dialog?.kind === "toggle" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`${dialog.season.isActive ? t.settings.deactivate : t.settings.activate}: ${dialog.season.name}`}
          description=""
          confirmLabel={dialog.season.isActive ? t.settings.deactivate : t.settings.activate}
          destructive={dialog.season.isActive}
          pending={setActive.pending}
          error={setActive.error}
          onConfirm={() => setActive.run({ seasonId: dialog.season.id, active: !dialog.season.isActive }, close)}
        />
      )}
    </div>
  );
}
