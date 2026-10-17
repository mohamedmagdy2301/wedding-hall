"use client";

import { ArrowDown, ArrowUp, MoreHorizontal, Plus } from "lucide-react";
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
import { crossesMidnight, fullDay, isTimeOfDay, slotViolations, type SpaceSlotTimes } from "@/domain/slots";
import { t } from "@/lib/i18n";
import type { Space } from "@/modules/spaces/service";
import { createSpaceAction, moveSpaceAction, setSpaceActiveAction, updateSpaceAction } from "@/server/actions/settings";

const ts = t.settings.spaces;
const messages: Record<string, string> = t.errors.messages;

const DEFAULT_SLOTS: SpaceSlotTimes = {
  day: { start: "12:00", end: "17:00" },
  evening: { start: "19:00", end: "00:00" },
};

function SlotFields({
  kind,
  value,
  onChange,
  errors,
}: {
  kind: "day" | "evening";
  value: { start: string; end: string };
  onChange: (value: { start: string; end: string }) => void;
  errors?: Record<string, string>;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{ts[kind]}</legend>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={ts.start}
          type="time"
          dir="ltr"
          className="text-start"
          data-testid={`${kind}-start`}
          value={value.start}
          onChange={(e) => onChange({ ...value, start: e.target.value })}
          error={errors?.[`${kind}.start`]}
        />
        <Field
          label={ts.end}
          type="time"
          dir="ltr"
          className="text-start"
          data-testid={`${kind}-end`}
          value={value.end}
          onChange={(e) => onChange({ ...value, end: e.target.value })}
          error={errors?.[`${kind}.end`]}
        />
      </div>
    </fieldset>
  );
}

function SpaceDialog({
  space,
  bufferMinutes,
  onOpenChange,
}: {
  space?: Space;
  bufferMinutes: number;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useServerAction(createSpaceAction);
  const update = useServerAction(updateSpaceAction);
  const { pending, error } = space ? update : create;
  const [day, setDay] = useState(space?.day ?? DEFAULT_SLOTS.day);
  const [evening, setEvening] = useState(space?.evening ?? DEFAULT_SLOTS.evening);

  // Mirrors BR-01/BR-02 while typing; the server checks again under the venue lock.
  const complete = [day.start, day.end, evening.start, evening.end].every(isTimeOfDay);
  const slots = { day, evening };
  const live = complete ? slotViolations(slots, bufferMinutes) : [];
  const full = complete && live.length === 0 ? fullDay(slots) : null;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = { name: form.get("name"), capacityMax: form.get("capacityMax"), day, evening };
    const done = () => onOpenChange(false);
    if (space) update.run({ ...input, spaceId: space.id }, done);
    else create.run(input, done);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{space ? ts.editTitle : ts.add}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError error={error?.fieldErrors ? null : error} />
          <Field label={t.settings.name} name="name" defaultValue={space?.name} error={error?.fieldErrors?.name} />
          <Field
            label={ts.capacity}
            name="capacityMax"
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            defaultValue={space?.capacityMax ?? ""}
            hint={ts.capacityHint}
            error={error?.fieldErrors?.capacityMax}
          />
          <SlotFields kind="day" value={day} onChange={setDay} errors={error?.fieldErrors} />
          <SlotFields kind="evening" value={evening} onChange={setEvening} errors={error?.fieldErrors} />
          <div className="grid gap-1 text-xs text-muted-foreground" data-testid="slots-preview">
            <p>
              {ts.bufferNote} {bufferMinutes} {t.settings.timing.minutes}. {ts.slotsHint}
            </p>
            {complete && crossesMidnight(evening) && <p>{`${ts.evening}: ${ts.crossesMidnight}.`}</p>}
            {full && (
              <p>
                {ts.fullDayLength} {Math.round((full.minutes / 60) * 10) / 10} {ts.hours} ({full.start} – {full.end})
              </p>
            )}
            {live.map((v) => (
              <p key={v} className="text-destructive">
                {messages[v]}
              </p>
            ))}
          </div>
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

/** S-13 "الأماكن والفترات" (`catalog.manage`): each space with its day and evening slots (BR-01). */
export function SpacesPanel({ spaces, bufferMinutes }: { spaces: Space[]; bufferMinutes: number }) {
  const [dialog, setDialog] = useState<{ kind: "create" } | { kind: "edit" | "toggle"; space: Space } | null>(null);
  const setActive = useServerAction(setSpaceActiveAction);
  const move = useServerAction(moveSpaceAction);
  const close = () => setDialog(null);
  const slotText = (s: { start: string; end: string }) => `${s.start} – ${s.end}`;

  return (
    <div className="grid gap-3">
      <div>
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus />
          {ts.add}
        </Button>
      </div>
      <FormError error={move.error} />
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.settings.name}</TableHead>
              <TableHead>{ts.day}</TableHead>
              <TableHead>{ts.evening}</TableHead>
              <TableHead>{ts.capacity}</TableHead>
              <TableHead>{t.settings.status}</TableHead>
              <TableHead>
                <span className="sr-only">{t.common.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spaces.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  {t.settings.empty}
                </TableCell>
              </TableRow>
            )}
            {spaces.map((space, index) => (
              <TableRow key={space.id} data-testid="space-row">
                <TableCell className="font-medium">{space.name}</TableCell>
                <TableCell className="whitespace-nowrap">{slotText(space.day)}</TableCell>
                <TableCell className="whitespace-nowrap">{slotText(space.evening)}</TableCell>
                <TableCell>{space.capacityMax ?? ts.noCapacity}</TableCell>
                <TableCell>
                  <Badge variant={space.isActive ? "outline" : "destructive"}>
                    {space.isActive ? t.settings.active : t.settings.inactive}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t.settings.moveUp}: ${space.name}`}
                      disabled={index === 0 || move.pending}
                      onClick={() => move.run({ spaceId: space.id, direction: "up" })}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`${t.settings.moveDown}: ${space.name}`}
                      disabled={index === spaces.length - 1 || move.pending}
                      onClick={() => move.run({ spaceId: space.id, direction: "down" })}
                    >
                      <ArrowDown />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${t.common.actions}: ${space.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", space })}>
                          {t.settings.edit}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "toggle", space })}>
                          {space.isActive ? t.settings.deactivate : t.settings.activate}
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

      {dialog?.kind === "create" && <SpaceDialog bufferMinutes={bufferMinutes} onOpenChange={close} />}
      {dialog?.kind === "edit" && (
        <SpaceDialog space={dialog.space} bufferMinutes={bufferMinutes} onOpenChange={close} />
      )}
      {dialog?.kind === "toggle" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`${dialog.space.isActive ? ts.deactivateTitle : t.settings.activate}: ${dialog.space.name}`}
          description={dialog.space.isActive ? ts.deactivateDescription : ""}
          confirmLabel={dialog.space.isActive ? t.settings.deactivate : t.settings.activate}
          destructive={dialog.space.isActive}
          pending={setActive.pending}
          error={setActive.error}
          onConfirm={() => setActive.run({ spaceId: dialog.space.id, active: !dialog.space.isActive }, close)}
        />
      )}
    </div>
  );
}
