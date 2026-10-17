import { z } from "zod";
import { newPasswordField } from "@/modules/auth/schemas";
import { parseLoginId } from "@/modules/auth/login-id";

// Messages are i18n keys (errors.messages), translated by the action wrapper.

const name = z.string().trim().min(1, "required").max(100, "tooLong");
const login = z
  .string()
  .trim()
  .min(1, "required")
  .refine((v) => parseLoginId(v) !== null, "loginInvalid");
const id = z.uuid("invalidId");
const roleIds = z.array(id).max(50);

export const createUserSchema = z.object({ name, login, tempPassword: newPasswordField, roleIds });
export const updateUserSchema = z.object({ userId: id, name, login, roleIds });
export const setUserActiveSchema = z.object({ userId: id, active: z.boolean() });
export const resetUserPasswordSchema = z.object({ userId: id, tempPassword: newPasswordField });
export const userIdSchema = z.object({ userId: id });
export const emptySchema = z.object({}).strict();

const permissionKeys = z.array(z.string().max(64)).max(100);
export const createRoleSchema = z.object({ name, permissionKeys });
export const updateRoleSchema = z.object({ roleId: id, name, permissionKeys });
export const roleIdSchema = z.object({ roleId: id });
