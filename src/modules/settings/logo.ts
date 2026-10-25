import { eq } from "drizzle-orm";
import { venues } from "@/db/schema";
import { IMAGE_TYPES, MAX_LOGO_BYTES } from "@/domain/files";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { readUpload, requireFiles, VIEW_LINK_SECONDS } from "@/modules/documents/service";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx } from "@/modules/shared/db";
import { AppError } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { assertAllowed } from "@/modules/users-rbac/authorize";

/**
 * The venue's logo (D-70, P9-06): an image of up to 1 MB in R2, shown on the printouts only.
 * The previous file is deleted when it is replaced or removed, last inside the transaction
 * (like a removed document — Q9-03).
 */

async function lockLogoKey(db: DbOrTx, venueId: string) {
  const [venue] = await db.select({ logoKey: venues.logoKey }).from(venues).where(eq(venues.id, venueId)).for("update");
  if (!venue) throw new AppError("NOT_FOUND", "venueNotSetUp");
  return venue.logoKey;
}

export async function setLogo(deps: ServiceDeps, actor: SessionUser, input: { file: Blob }) {
  assertAllowed(actor, "settings.manage");
  const files = requireFiles(deps);
  const { bytes, mimeType } = await readUpload(input.file, MAX_LOGO_BYTES, IMAGE_TYPES, {
    fileTooLarge: "logoTooLarge",
    fileTypeNotAllowed: "logoTypeNotAllowed",
  });
  const logoKey = `venues/${actor.venueId}/logo/${crypto.randomUUID()}`;
  await files.put(logoKey, bytes, mimeType);
  try {
    await runTransaction(deps.db, async (tx) => {
      const previous = await lockLogoKey(tx, actor.venueId);
      await tx.update(venues).set({ logoKey }).where(eq(venues.id, actor.venueId));
      await recordAudit(tx, {
        venueId: actor.venueId,
        actorId: actor.userId,
        action: "settings.logo_updated",
        entityType: "venue",
        entityId: actor.venueId,
        after: { mimeType, sizeBytes: bytes.byteLength },
      });
      if (previous) await files.delete(previous);
    });
  } catch (error) {
    await files.delete(logoKey).catch(() => console.error("orphan logo file left in R2"));
    throw error;
  }
}

export async function removeLogo(deps: ServiceDeps, actor: SessionUser) {
  assertAllowed(actor, "settings.manage");
  const files = requireFiles(deps);
  await runTransaction(deps.db, async (tx) => {
    const previous = await lockLogoKey(tx, actor.venueId);
    if (!previous) return;
    await tx.update(venues).set({ logoKey: null }).where(eq(venues.id, actor.venueId));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "settings.logo_removed",
      entityType: "venue",
      entityId: actor.venueId,
    });
    await files.delete(previous);
  });
}

/**
 * A short-lived link to the logo for a page being rendered (a printout or the settings tab),
 * or `null` without a logo or without storage — the printout then shows the name only.
 */
export async function venueLogoUrl(deps: Pick<ServiceDeps, "db" | "files">, venueId: string) {
  if (!deps.files) return null;
  const [venue] = await deps.db.select({ logoKey: venues.logoKey }).from(venues).where(eq(venues.id, venueId));
  return venue?.logoKey ? deps.files.signedGetUrl(venue.logoKey, VIEW_LINK_SECONDS) : null;
}
