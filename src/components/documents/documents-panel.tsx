"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { SelectField } from "@/components/forms/select-field";
import { useServerAction } from "@/components/forms/use-server-action";
import { DialogShell } from "@/components/payments/payments-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fill, t } from "@/lib/i18n";
import { formatCairoDateTime } from "@/lib/time";
import type { BookingDocument } from "@/modules/documents/service";
import type { ActionError } from "@/server/action-core";
import { documentViewUrlAction, removeDocumentAction, uploadDocumentAction } from "@/server/actions/documents";
import { prepareImage } from "./prepare-image";

const td = t.documents;
type Kind = BookingDocument["kind"];

/** S-07 "المستندات" (BR-90, Q9-02, Q9-03): list, upload, open by a 5-minute link, remove with a reason. */
export function DocumentsPanel(props: {
  booking: { id: string; bookingNo: string };
  documents: BookingDocument[];
  canUpload: boolean;
}) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState<BookingDocument | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<ActionError | null>(null);

  async function open(doc: BookingDocument) {
    // The tab is opened now, inside the click, so the browser does not block it as a pop-up.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    setOpening(doc.id);
    const result = await documentViewUrlAction({ documentId: doc.id });
    setOpening(null);
    if (result.ok) {
      setOpenError(null);
      if (tab) tab.location.assign(result.data.url);
      else window.location.assign(result.data.url);
    } else {
      tab?.close();
      setOpenError(result.error);
    }
  }

  return (
    <Card className="py-4">
      <CardContent className="grid gap-3 px-4" data-testid="documents-panel">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">{td.title}</h2>
          {props.canUpload && (
            <Button size="sm" className="ms-auto" onClick={() => setUploading(true)} data-testid="upload-document">
              {td.upload}
            </Button>
          )}
        </div>
        {props.documents.length === 0 && <p className="text-sm text-muted-foreground">{td.empty}</p>}
        <ul className="grid gap-2 text-sm">
          {props.documents.map((doc) => (
            <li
              key={doc.id}
              className="flex flex-wrap items-center gap-2 border-b pb-2 last:border-b-0"
              data-testid="document-row"
              data-kind={doc.kind}
            >
              <span className="font-medium">{td.kinds[doc.kind]}</span>
              <span className="text-muted-foreground">
                {fill(td.uploadedBy, { name: doc.uploadedByName, at: formatCairoDateTime(doc.createdAt) })}
              </span>
              <span className="ms-auto flex gap-2">
                {doc.canView ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={opening === doc.id}
                    onClick={() => open(doc)}
                    data-testid="open-document"
                  >
                    {opening === doc.id ? td.opening : td.open}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground" data-testid="document-hidden">
                    {td.hidden}
                  </span>
                )}
                {doc.canRemove && (
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(doc)} data-testid="remove-document">
                    {td.remove}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {props.documents.some((d) => d.canView) && <p className="text-xs text-muted-foreground">{td.linkNote}</p>}
        <FormError error={openError} />
      </CardContent>

      {uploading && (
        <UploadDialog
          booking={props.booking}
          onClose={() => setUploading(false)}
          onDone={() => {
            setUploading(false);
            router.refresh();
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          doc={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

function UploadDialog(props: { booking: { id: string; bookingNo: string }; onClose: () => void; onDone: () => void }) {
  const action = useServerAction(uploadDocumentAction);
  const inputId = useId();
  const [kind, setKind] = useState<Kind>("national_id");
  const [file, setFile] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const errors = action.error?.fieldErrors ?? {};

  async function submit() {
    if (!file) return setLocalError(t.errors.messages.fileRequired);
    setLocalError(null);
    setPreparing(true);
    let body: Blob;
    try {
      body = await prepareImage(file);
    } catch {
      setPreparing(false);
      return setLocalError(td.imageFailed);
    }
    setPreparing(false);
    action.run({ bookingId: props.booking.id, kind, file: body }, props.onDone);
  }

  const busy = preparing || action.pending;
  return (
    <DialogShell
      testId="upload-document-dialog"
      title={fill(td.uploadTitle, { no: props.booking.bookingNo })}
      description={td.uploadHint}
      onClose={props.onClose}
      footer={
        <Button disabled={busy} onClick={submit} data-testid="upload-document-submit">
          {busy ? td.uploading : td.upload}
        </Button>
      }
    >
      <SelectField label={td.kind} value={kind} onChange={setKind} options={td.kinds} testId="document-kind" />
      <div className="grid gap-1.5">
        <Label htmlFor={inputId}>{td.file}</Label>
        <Input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          aria-invalid={errors.file || localError ? true : undefined}
          data-testid="document-file"
        />
        {(localError ?? errors.file) && <p className="text-xs text-destructive">{localError ?? errors.file}</p>}
      </div>
      <FormError error={action.error} />
    </DialogShell>
  );
}

function RemoveDialog(props: { doc: BookingDocument; onClose: () => void; onDone: () => void }) {
  const action = useServerAction(removeDocumentAction);
  const [reason, setReason] = useState("");
  return (
    <DialogShell
      testId="remove-document-dialog"
      title={fill(td.removeTitle, { kind: td.kinds[props.doc.kind] })}
      description={td.removeDescription}
      onClose={props.onClose}
      footer={
        <Button
          variant="destructive"
          disabled={action.pending}
          onClick={() => action.run({ documentId: props.doc.id, reason }, props.onDone)}
          data-testid="remove-document-submit"
        >
          {action.pending ? t.common.saving : td.removeConfirm}
        </Button>
      }
    >
      <Field
        label={td.removeReason}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={action.error?.fieldErrors?.reason}
        maxLength={300}
        data-testid="remove-document-reason"
      />
      <FormError error={action.error} />
    </DialogShell>
  );
}
