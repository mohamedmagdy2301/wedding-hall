import { sql } from "drizzle-orm";
import { rolePermissions, roles, users, venues } from "@/db/schema";
import { recordAudit } from "@/modules/audit/service";
import { parseLoginId } from "@/modules/auth/login-id";
import { passwordPolicyError } from "@/modules/auth/policy";
import type { ServiceDeps } from "@/modules/shared/context";
import { AppError, validationError } from "@/modules/shared/errors";
import { DEFAULT_ROLES } from "@/modules/users-rbac/permissions";

/** Default settings of a new venue (P1-01). No cancellation tiers: a mandatory setup step (D-60). */
export const VENUE_DEFAULTS = {
  bufferMinutes: 60,
  tentativeHoldHours: 48,
  minDepositType: "none",
  minDepositValue: 0,
  cancellationBasis: "deposit",
  postponeCreditMode: "refund",
} as const;

export type SetupVenueInput = {
  venueName: string;
  ownerName: string;
  ownerLogin: string;
  ownerTempPassword: string;
};

/**
 * UF-01 step 4: the venue, its owner (temporary password, forced change at first login),
 * the default roles and settings — in one transaction. Refuses to run if a venue exists.
 */
export async function setupVenue(deps: ServiceDeps, input: SetupVenueInput) {
  const venueName = input.venueName.trim();
  const ownerName = input.ownerName.trim();
  const login = parseLoginId(input.ownerLogin);
  const fieldErrors: Record<string, string> = {};
  if (!venueName) fieldErrors.venueName = "required";
  if (!ownerName) fieldErrors.ownerName = "required";
  if (!login) fieldErrors.ownerLogin = "loginInvalid";
  const policyError = passwordPolicyError(input.ownerTempPassword);
  if (policyError) fieldErrors.ownerTempPassword = policyError;
  if (Object.keys(fieldErrors).length > 0 || !login) throw validationError(fieldErrors);

  const passwordHash = deps.hasher.hash(input.ownerTempPassword);

  return deps.db.transaction(async (tx) => {
    // Serializes concurrent runs; the count check below then sees committed venues.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('setup-venue'))`);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(venues);
    if (n > 0) throw new AppError("BUSINESS_RULE_VIOLATION", "venueAlreadySetUp");

    const [venue] = await tx
      .insert(venues)
      .values({ name: venueName, ...VENUE_DEFAULTS })
      .returning({ id: venues.id });

    const roleIds: string[] = [];
    for (const role of DEFAULT_ROLES) {
      const [row] = await tx
        .insert(roles)
        .values({ venueId: venue.id, name: role.name, isSystem: true })
        .returning({ id: roles.id });
      await tx
        .insert(rolePermissions)
        .values(role.permissions.map((permissionKey) => ({ roleId: row.id, permissionKey })));
      roleIds.push(row.id);
    }

    const [owner] = await tx
      .insert(users)
      .values({
        venueId: venue.id,
        name: ownerName,
        login: login.value,
        passwordHash,
        isOwner: true,
        mustChangePassword: true,
      })
      .returning({ id: users.id });

    await recordAudit(tx, {
      venueId: venue.id,
      actorId: null,
      action: "venue.setup",
      entityType: "venue",
      entityId: venue.id,
      after: {
        venue: { name: venueName, ...VENUE_DEFAULTS },
        owner: { id: owner.id, name: ownerName, login: login.value },
        roles: DEFAULT_ROLES.map((r, i) => ({ id: roleIds[i], name: r.name, permissionKeys: r.permissions })),
      },
      meta: { source: "setup-venue" },
    });

    return { venueId: venue.id, ownerId: owner.id };
  });
}
