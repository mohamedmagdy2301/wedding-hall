import { changePasswordSchema } from "@/modules/auth/schemas";
import { changePassword, logout } from "@/modules/auth/service";
import { emptySchema } from "@/modules/users-rbac/schemas";
import { defineProtected } from "./define";

export const authSpecs = {
  /** S-02: also the only operation allowed while a temporary password is pending (SEC-05). */
  changePassword: defineProtected({
    schema: changePasswordSchema,
    requires: "authenticated",
    allowPendingPasswordChange: true,
    handler: (ctx, input) =>
      changePassword(
        ctx,
        ctx.actor,
        { currentPassword: input.currentPassword, newPassword: input.newPassword },
        ctx.requestMeta,
      ),
  }),
  logout: defineProtected({
    schema: emptySchema,
    requires: "authenticated",
    allowPendingPasswordChange: true,
    handler: (ctx) => logout(ctx, ctx.actor, ctx.sessionToken, ctx.requestMeta),
  }),
  /** Re-issues the cookie with the session's slid expiry (T-17); the database side slides on every check. */
  refreshSession: defineProtected({
    schema: emptySchema,
    requires: "authenticated",
    allowPendingPasswordChange: true,
    handler: async (ctx) => ({ token: ctx.sessionToken, expiresAt: ctx.actor.expiresAt }),
  }),
};
