import { z } from 'zod'

/** Zod at every route boundary (spec 2.6). */

/** A form sends one value as a string and many as an array. Normalise both. */
export const idList = z
  .union([z.string(), z.array(z.string()), z.undefined()])
  .transform((raw) => {
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
    return list
      .map((v) => Number.parseInt(v, 10))
      .filter((n) => Number.isInteger(n) && n > 0)
  })

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190),
  fullName: z.string().trim().min(2, 'Enter the person’s full name.').max(160),
  phone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  employeeId: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10)
      return Number.isInteger(n) && n > 0 ? n : null
    }),
  roleIds: idList,
})

export const statusSchema = z.object({
  status: z.enum(['active', 'suspended', 'inactive']),
})

/** Admin email change (DECISIONS 29.71): lower-cased at the boundary, same
 * ceiling as users.email VARCHAR(190). */
export const changeEmailSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190),
})

/** Name correction (29.72 edit screen). */
export const changeNameSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the person’s full name.').max(160),
})

/** Admin temporary password (29.71): no format rule beyond length — the
 * temporary value is generated server-side in the normal path, but an admin
 * may type one; strength is enforced by length + classes so "password1" is
 * refused. */
export const adminPasswordSchema = z
  .object({
    password: z
      .string()
      .min(12, 'The temporary password needs at least 12 characters.')
      .max(128)
      .refine(
        (v) => /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v),
        'Use upper case, lower case and a digit.'
      ),
  })
  .passthrough()

export const rolesSchema = z.object({
  roleIds: idList,
})

export const overrideSchema = z.object({
  permissionKey: z.string().trim().min(3).max(80),
  effect: z.enum(['grant', 'deny']),
  // A permission override without a reason is an unexplained privilege
  // change, which is the thing the audit log exists to prevent (spec 6.2).
  note: z.string().trim().min(10, 'Explain why this override is needed, in at least 10 characters.').max(500),
})

export const rolePermissionsSchema = z.object({
  permissionIds: idList,
})

export const enquiryStatusSchema = z.object({
  status: z.enum(['new', 'contacted', 'promoted', 'spam', 'closed']),
})

/** Employee code assignment (29.71): mirrors employees.employee_code
 * VARCHAR(20) and the NCC-### shape the seed uses, without hard-coding the
 * prefix — a future joiner outside the NCC sequence must not be blocked. */
export const employeeCodeSchema = z.object({
  employeeCode: z.string().trim().min(3, 'Enter the employee code.').max(20),
})

export const auditFilterSchema = z.object({
  userId: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10)
      return Number.isInteger(n) && n > 0 ? n : undefined
    }),
  action: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  entityType: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  page: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '1', 10)
      return Number.isInteger(n) && n > 0 ? n : 1
    }),
})

export const costHeadSchema = z.object({
  code: z.string().trim().min(2).max(20).toUpperCase(),
  name: z.string().trim().min(2).max(120),
  headType: z.enum(['material', 'labour', 'subcontract', 'equipment', 'statutory', 'overhead']),
  parentId: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10)
      return Number.isInteger(n) && n > 0 ? n : null
    }),
  isDirectCost: z
    .union([z.string(), z.undefined()])
    .transform((v) => (v === 'on' || v === '1' || v === 'true' ? 1 : 0)),
  sortOrder: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '', 10)
      return Number.isInteger(n) ? n : 0
    }),
})

export const unitSchema = z.object({
  code: z.string().trim().min(1).max(10),
  name: z.string().trim().min(2).max(40),
  decimalPlaces: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt(v ?? '0', 10)
      return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 0
    }),
})

export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Please check the form and try again.'
}
