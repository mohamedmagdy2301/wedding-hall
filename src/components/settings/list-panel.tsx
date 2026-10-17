"use client";

import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/lib/i18n";
import type { ListItem } from "@/modules/settings/lists";
import type { ListKind } from "@/modules/settings/schemas";
import {
  addSuggestedItemsAction,
  createListItemAction,
  moveListItemAction,
  setListItemActiveAction,
  updateListItemAction,
} from "@/server/actions/settings";

type Props = { kind: ListKind; items: ListItem[]; suggested: string[] };

function ItemDialog({
  kind,
  item,
  open,
  onOpenChange,
}: {
  kind: ListKind;
  item?: ListItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useServerAction(createListItemAction);
  const update = useServerAction(updateListItemAction);
  const { pending, error } = item ? update : create;
  const [isWedding, setIsWedding] = useState(item?.isWedding ?? false);
  const labels = t.settings.lists[kind];

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    const done = () => onOpenChange(false);
    const wedding = kind === "eventTypes" ? { isWedding } : {};
    if (item) update.run({ kind, id: item.id, name, ...wedding }, done);
    else create.run({ kind, name, ...wedding }, done);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? labels.editTitle : labels.add}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError error={error?.fieldErrors ? null : error} />
          <Field label={t.settings.name} name="name" defaultValue={item?.name} error={error?.fieldErrors?.name} />
          {kind === "eventTypes" && (
            <div className="flex items-center gap-2">
              <Checkbox id="is-wedding" checked={isWedding} onCheckedChange={(c) => setIsWedding(c === true)} />
              <Label htmlFor="is-wedding" className="font-normal">
                {t.settings.lists.eventTypes.isWedding}
              </Label>
            </div>
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

/** S-13 lists (D-30, D-31): add, edit, (de)activate, reorder, and the one-click suggestions (D-71). */
export function ListPanel({ kind, items, suggested }: Props) {
  const [dialog, setDialog] = useState<{ kind: "create" } | { kind: "edit" | "toggle"; item: ListItem } | null>(null);
  const setActive = useServerAction(setListItemActiveAction);
  const move = useServerAction(moveListItemAction);
  const addSuggested = useServerAction(addSuggestedItemsAction);
  const ordered = kind !== "expenseCategories";
  const existing = new Set(items.map((i) => i.name.toLowerCase()));
  const missingSuggestions = suggested.filter((name) => !existing.has(name.toLowerCase()));
  const close = () => setDialog(null);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus />
          {t.settings.lists[kind].add}
        </Button>
        {missingSuggestions.length > 0 && (
          <Button
            variant="outline"
            disabled={addSuggested.pending}
            onClick={() => addSuggested.run({ kind })}
            title={`${t.settings.lists.suggestedHint} ${missingSuggestions.join("، ")}`}
          >
            <Sparkles />
            {t.settings.lists.addSuggested}
          </Button>
        )}
      </div>
      {missingSuggestions.length > 0 && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t.settings.lists.suggestedHint} {missingSuggestions.join("، ")}
        </p>
      )}
      <FormError error={addSuggested.error ?? move.error} />

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.settings.name}</TableHead>
              <TableHead>{t.settings.status}</TableHead>
              <TableHead>
                <span className="sr-only">{t.common.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">
                  {t.settings.empty}
                </TableCell>
              </TableRow>
            )}
            {items.map((item, index) => (
              <TableRow key={item.id} data-testid="list-row">
                <TableCell className="font-medium">
                  <span className="flex flex-wrap items-center gap-2">
                    {item.name}
                    {item.isWedding && <Badge variant="secondary">{t.settings.lists.eventTypes.wedding}</Badge>}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={item.isActive ? "outline" : "destructive"}>
                    {item.isActive ? t.settings.active : t.settings.inactive}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {ordered && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t.settings.moveUp}: ${item.name}`}
                          disabled={index === 0 || move.pending}
                          onClick={() => move.run({ kind, id: item.id, direction: "up" })}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${t.settings.moveDown}: ${item.name}`}
                          disabled={index === items.length - 1 || move.pending}
                          onClick={() => move.run({ kind, id: item.id, direction: "down" })}
                        >
                          <ArrowDown />
                        </Button>
                      </>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${t.common.actions}: ${item.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", item })}>
                          {t.settings.edit}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "toggle", item })}>
                          {item.isActive ? t.settings.deactivate : t.settings.activate}
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

      {dialog?.kind === "create" && <ItemDialog kind={kind} open onOpenChange={close} />}
      {dialog?.kind === "edit" && <ItemDialog kind={kind} item={dialog.item} open onOpenChange={close} />}
      {dialog?.kind === "toggle" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`${dialog.item.isActive ? t.settings.deactivate : t.settings.activate}: ${dialog.item.name}`}
          description=""
          confirmLabel={dialog.item.isActive ? t.settings.deactivate : t.settings.activate}
          destructive={dialog.item.isActive}
          pending={setActive.pending}
          error={setActive.error}
          onConfirm={() => setActive.run({ kind, id: dialog.item.id, active: !dialog.item.isActive }, close)}
        />
      )}
    </div>
  );
}
