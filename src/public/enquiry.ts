import { z } from 'zod'
import type { Db } from '../db/kysely.js'
import { enforce, RULES } from '../lib/ratelimit.js'
import { enquiryNotificationEmail, send } from '../lib/mailer.js'

/**
 * The website enquiry, which is the one write path the public site has
 * (spec 1.4, 6.5 rule 1).
 *
 * The three things the legacy site got wrong and this does not:
 *
 *  1. It persists. The live PHP called mail() and kept no record, so every
 *     enquiry existed only in one Gmail inbox. The row is written first and
 *     the email is sent after; if SMTP is down the enquiry is still captured,
 *     which is the opposite of the old failure mode.
 *  2. It is rate limited, by IP, five per hour (RULES.enquiryByIp).
 *  3. It has a honeypot and a time trap, both lifted from the good
 *     enquiry-handler.php that was never wired up on this domain.
 *
 * A bot that trips the honeypot gets a normal success response. Telling a
 * spam bot it was detected just teaches the operator to fix their script.
 */

export const enquirySchema = z.object({
  // maxlength on the inputs is 256, so the server bound matches the markup
  // rather than being generous with what the form itself refuses to send.
  name: z.string().trim().min(2, 'Please enter your name.').max(256),
  email: z.string().trim().max(256).email('Please enter a valid email address.').optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  city: z.string().trim().max(120).optional().or(z.literal('')),
  subject: z.string().trim().max(256).optional().or(z.literal('')),
  budget: z.string().trim().max(256).optional().or(z.literal('')),
  message: z.string().trim().min(5, 'Please tell us a little about the work.').max(5000),
  // The honeypot field name and the timestamp field name are the ones the
  // legacy handler used, so any bot already trained on this site still trips.
  nc_website: z.string().optional(),
  nc_started: z.string().optional(),
})

export type EnquiryInput = z.infer<typeof enquirySchema>

export interface EnquiryOutcome {
  ok: boolean
  /** Set when ok is false and a field is at fault. */
  message?: string
  /** True when the submission was silently discarded as spam. */
  discarded?: boolean
}

const MIN_FILL_SECONDS = 3

function blank(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * The service interest column is an open string, and the two live forms carry
 * different fields: /contact-us has no subject, the homepage has subject and
 * budget. Both are folded into one value rather than losing whichever the
 * page did not ask for.
 */
function serviceInterest(input: EnquiryInput): string | null {
  const parts: string[] = []
  const subject = blank(input.subject)
  const budget = blank(input.budget)
  if (subject) parts.push(subject)
  if (budget) parts.push(`Budget: ${budget}`)
  return parts.length === 0 ? null : parts.join(' | ')
}

export async function submitEnquiry(
  db: Db,
  raw: Record<string, unknown>,
  meta: { ip: string | null; userAgent: string | null; sourcePage: string; notifyTo: string | null }
): Promise<EnquiryOutcome> {
  // Rate limit before validation. Validating first would let an attacker
  // spend our CPU on Zod for free by sending garbage.
  await enforce(
    db,
    RULES.enquiryByIp(meta.ip ?? 'unknown'),
    'Too many enquiries from this connection. Please try again later, or call us directly.'
  )

  const parsed = enquirySchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, message: first?.message ?? 'Please check the form and try again.' }
  }
  const input = parsed.data

  // Honeypot: a hidden field a human never sees and never fills.
  if (blank(input.nc_website) !== null) {
    return { ok: true, discarded: true }
  }

  // Time trap: a human cannot read the page and write a message in under
  // three seconds. Absent or unparseable means the form was served before
  // this field existed, which must not reject a real person.
  const started = Number(input.nc_started)
  if (Number.isFinite(started) && started > 0) {
    const elapsed = (Date.now() - started) / 1000
    if (elapsed < MIN_FILL_SECONDS) return { ok: true, discarded: true }
  }

  const email = blank(input.email)
  const phone = blank(input.phone)

  // One of the two has to be usable or the enquiry cannot be answered, and an
  // unanswerable enquiry is worse than a rejected one because it looks
  // delivered to the person who sent it. The live forms only collect email,
  // so this is effectively "email required" there.
  if (email === null && phone === null) {
    return { ok: false, message: 'Please give us an email address or a phone number so we can reply.' }
  }

  // phone is NOT NULL in the schema because every enquiry the sales team
  // actually works has one. The published forms do not ask for it, so an
  // empty string records "not given" rather than inventing a number.
  const inserted = await db
    .insertInto('enquiries')
    .values({
      name: input.name,
      phone: phone ?? '',
      email,
      city: blank(input.city),
      service_interest: serviceInterest(input),
      message: input.message,
      source_page: meta.sourcePage.slice(0, 255),
      ip: meta.ip ? Buffer.from(meta.ip, 'utf8') : null,
      user_agent: (meta.userAgent ?? '').slice(0, 255) || null,
      status: 'new',
    })
    .executeTakeFirst()

  const enquiryId = Number(inserted.insertId ?? 0) || null

  // Email is best effort and deliberately after the insert. send() writes its
  // own email_log row and returns rather than throwing, so a dead SMTP
  // credential cannot turn a captured enquiry into a 500 for the visitor.
  if (meta.notifyTo) {
    const built = enquiryNotificationEmail({
      name: input.name,
      phone: phone ?? 'not given',
      email,
      city: blank(input.city),
      serviceInterest: serviceInterest(input),
      message: input.message,
      sourcePage: meta.sourcePage,
    })
    await send(db, {
      to: meta.notifyTo,
      subject: built.subject,
      text: built.text,
      templateKey: 'public.enquiry_notification',
      entityType: 'enquiry',
      entityId: enquiryId,
      ...(email ? { replyTo: email } : {}),
    })
  }

  return { ok: true }
}
