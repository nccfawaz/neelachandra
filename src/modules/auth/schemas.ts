import { z } from 'zod'

/**
 * Request shapes for the auth module (spec 6.1).
 *
 * The login schema is deliberately loose on password: min 1, not min 12. The
 * policy applies when a password is SET, not when one is offered. A min 12
 * here would tell an attacker that a short guess is not even worth checking,
 * and it would lock out any legacy account.
 */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
  next: z.string().optional(),
})

export const totpSchema = z.object({
  // Spaces stripped because authenticator apps display "123 456".
  code: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => /^\d{6}$/.test(v) || /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i.test(v), {
      message: 'Enter the 6 digit code, or a recovery code',
    }),
})

export const forgotSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
})

/** New password twice. The confirm field catches a typo before the reset is spent. */
export const setPasswordSchema = z
  .object({
    password: z.string().min(1, 'Enter a new password'),
    confirm: z.string().min(1, 'Repeat the new password'),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'The two passwords do not match',
    path: ['confirm'],
  })

export const changePasswordSchema = z
  .object({
    current: z.string().optional(),
    password: z.string().min(1, 'Enter a new password'),
    confirm: z.string().min(1, 'Repeat the new password'),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'The two passwords do not match',
    path: ['confirm'],
  })

/**
 * ?next= validation (spec 6.1). Only a same-origin absolute path is allowed.
 * Without this, /login?next=https://evil.example is an open redirect that
 * looks like it came from the company's own login page.
 */
export function safeNext(raw: string | undefined | null, fallback = '/app'): string {
  if (!raw) return fallback
  if (!raw.startsWith('/')) return fallback
  // Protocol-relative //host is a URL, not a path, and browsers follow it.
  if (raw.startsWith('//')) return fallback
  if (raw.includes('\\')) return fallback
  // Sending someone back to /login or /logout after signing in is a loop.
  if (raw === '/login' || raw === '/logout') return fallback
  return raw
}

/** Flattens Zod issues to one message per field for the form components. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_'
    if (!out[key]) out[key] = issue.message
  }
  return out
}
