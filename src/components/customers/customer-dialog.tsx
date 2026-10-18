"use client";

import { Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import type { Customer } from "@/modules/customers/service";
import { createCustomerAction, updateCustomerAction } from "@/server/actions/bookings";

const tc = t.customers;

/** S-08 add or edit a customer (`customers.manage`, D-106). Mobiles are normalized by the server (D-52). */
export function CustomerDialog({ customer }: { customer?: Customer }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const create = useServerAction(createCustomerAction);
  const update = useServerAction(updateCustomerAction);
  const { pending, error } = customer ? update : create;
  const fieldErrors = error?.fieldErrors ?? {};

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields = {
      name: form.get("name"),
      phone: form.get("phone"),
      altPhone: form.get("altPhone"),
      notes: form.get("notes"),
    };
    const done = () => {
      setOpen(false);
      router.refresh();
    };
    if (customer) update.run({ ...fields, customerId: customer.id }, done);
    else create.run(fields, done);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {customer ? (
          <Button variant="outline" size="sm">
            <Pencil />
            {tc.edit}
          </Button>
        ) : (
          <Button>
            <Plus />
            {tc.add}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{customer ? tc.editTitle : tc.add}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <Field label={tc.name} name="name" defaultValue={customer?.name} error={fieldErrors.name} />
          <Field
            label={tc.phone}
            name="phone"
            dir="ltr"
            inputMode="tel"
            defaultValue={customer?.phone}
            error={fieldErrors.phone}
          />
          <Field
            label={tc.altPhone}
            name="altPhone"
            dir="ltr"
            inputMode="tel"
            defaultValue={customer?.altPhone ?? ""}
            error={fieldErrors.altPhone}
          />
          <Field label={tc.notes} name="notes" defaultValue={customer?.notes ?? ""} error={fieldErrors.notes} />
          <FormError error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
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
