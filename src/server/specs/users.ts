import { createRole, deleteRole, updateRole } from "@/modules/users-rbac/roles";
import {
  createRoleSchema,
  createUserSchema,
  emptySchema,
  resetUserPasswordSchema,
  roleIdSchema,
  setUserActiveSchema,
  updateRoleSchema,
  updateUserSchema,
  userIdSchema,
} from "@/modules/users-rbac/schemas";
import {
  createUser,
  grantOwnership,
  renounceOwnership,
  resetUserPassword,
  setUserActive,
  updateUser,
} from "@/modules/users-rbac/users";
import { defineProtected } from "./define";

/** S-15 / UF-11 (API.md "Users & Roles"). */
export const userSpecs = {
  createUser: defineProtected({
    schema: createUserSchema,
    requires: "users.manage",
    handler: (ctx, input) => createUser(ctx, ctx.actor, input),
  }),
  updateUser: defineProtected({
    schema: updateUserSchema,
    requires: "users.manage",
    handler: (ctx, input) => updateUser(ctx, ctx.actor, input),
  }),
  setUserActive: defineProtected({
    schema: setUserActiveSchema,
    requires: "users.manage",
    handler: (ctx, input) => setUserActive(ctx, ctx.actor, input),
  }),
  resetUserPassword: defineProtected({
    schema: resetUserPasswordSchema,
    requires: "users.manage",
    handler: (ctx, input) => resetUserPassword(ctx, ctx.actor, input),
  }),
  grantOwnership: defineProtected({
    schema: userIdSchema,
    requires: "owner",
    handler: (ctx, input) => grantOwnership(ctx, ctx.actor, input),
  }),
  renounceOwnership: defineProtected({
    schema: emptySchema,
    requires: "owner",
    handler: (ctx) => renounceOwnership(ctx, ctx.actor),
  }),
  createRole: defineProtected({
    schema: createRoleSchema,
    requires: "users.manage",
    handler: (ctx, input) => createRole(ctx, ctx.actor, input),
  }),
  updateRole: defineProtected({
    schema: updateRoleSchema,
    requires: "users.manage",
    handler: (ctx, input) => updateRole(ctx, ctx.actor, input),
  }),
  deleteRole: defineProtected({
    schema: roleIdSchema,
    requires: "users.manage",
    handler: (ctx, input) => deleteRole(ctx, ctx.actor, input),
  }),
};
