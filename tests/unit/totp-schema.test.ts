import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/**
 * Isolates the shape of the recovery-code acceptance regex (29.46's finding)
 * without the app's imports: the schema as written in
 * src/modules/auth/schemas.ts:18.
 */
const totpSchema = z.object({
  code: z
    .string()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => /^\d{6}$/.test(v) || /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i.test(v), {
      message: 'Enter the 6 digit code, or a recovery code',
    }),
})

describe('the totp code schema accepts exactly what it should (29.46)', () => {
  it('accepts a 6 digit TOTP code', () => {
    const r = totpSchema.safeParse({ code: '123456' })
    expect(r.success).toBe(true)
  })

  it('accepts a dashed recovery code in dashed form — the dashes must survive the transform', () => {
    // generateRecoveryCodes emits xxxx-xxxx-xxxx-xxxx. The schema strips
    // dashes and spaces BEFORE the refine, so the dashed alternative can
    // only match if the input carries a DIFFERENT separator — the shipped
    // format fails its own schema. This is 29.46's defect: recovery codes
    // are unenterable through POST /2fa/verify as formatted.
    const dashed = 'abcd-efgh-ijkl-mnop'
    const r = totpSchema.safeParse({ code: dashed })
    // Documenting the shipped behaviour: the transform strips the dashes,
    // then the dashed regex cannot match the stripped 16-char string.
    expect(r.success).toBe(false)
  })

  it('accepts a recovery code only when typed without its dashes', () => {
    const r = totpSchema.safeParse({ code: 'abcdefghijklmnop' })
    // Still false: 16 chars matches neither alternative. Every shape fails
    // except 6 digits — the schema's dashed alternative is unreachable for
    // the shipped code format.
    expect(r.success).toBe(false)
  })
})
