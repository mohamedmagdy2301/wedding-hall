import { z } from "zod";
import { MAX_PASSWORD_LENGTH, PASSWORD_MIN_LENGTH } from "./policy";

// Messages are i18n keys (errors.messages), translated by the action wrapper.

export const loginSchema = z.object({
  login: z.string().trim().min(1, "required").max(64, "loginInvalid"),
  // Not trimmed: spaces are valid password characters.
  password: z.string().min(1, "required").max(MAX_PASSWORD_LENGTH, "passwordTooLong"),
});

export const newPasswordField = z
  .string()
  .min(PASSWORD_MIN_LENGTH, "passwordTooShort")
  .max(MAX_PASSWORD_LENGTH, "passwordTooLong");

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "required").max(MAX_PASSWORD_LENGTH, "passwordTooLong"),
    newPassword: newPasswordField,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"], message: "passwordMismatch" });
