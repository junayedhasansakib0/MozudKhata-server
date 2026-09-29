import { z } from "zod";

/**
 * Auth/account request schemas (docs/api.md §Phase 02). The backend is the
 * authoritative validation boundary; the client mirrors these shapes.
 */

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

// Owner policy (2026-09-28): minimum 8 characters. Upper bound guards against
// denial-of-service via absurdly long inputs to the (memory-hard) hasher.
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(200, "Password must be at most 200 characters.");

export const nameSchema = z.string().trim().min(1).max(120);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: nameSchema.optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  // Never echo the password policy on login — accept any non-empty string.
  password: z.string().min(1).max(200),
});

export const updateProfileSchema = z.object({
  name: nameSchema.nullable(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
