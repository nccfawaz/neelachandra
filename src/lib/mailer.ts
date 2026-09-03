import { createTransport, type Transporter } from 'nodemailer'
import type { Queryable } from '../db/kysely.js'
import { env, isProd } from '../env.js'

/**
 * Nodemailer over authenticated Hostinger SMTP, with every send logged to
 * email_log (spec 2.8), so a delivery dispute is answerable from the
 * database rather than from someone's memory.
 *
 * When SMTP_USER is empty the transport is not created and every send is
 * recorded as failed with a clear reason and the body written to the process
 * log. This is the development and pre-configuration path: an invite link
 * that appears in the log is testable, whereas a mailer that throws on boot
 * makes the whole application unstartable because email is not set up yet.
 */

let transporter: Transporter | undefined
let transportUnavailableReason: string | undefined

function getTransport(): Transporter | undefined {
  if (transporter) return transporter
  if (transportUnavailableReason) return undefined

  if (!env.SMTP_USER || !env.SMTP_PASSWORD) {
    transportUnavailableReason = 'SMTP_USER and SMTP_PASSWORD are not set'
    return undefined
  }

  transporter = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Port 465 is implicit TLS. Anything else is STARTTLS.
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  })
  return transporter
}

export interface SendOptions {
  to: string
  subject: string
  text: string
  html?: string
  templateKey: string
  entityType?: string | null
  entityId?: number | null
  replyTo?: string
}

export interface SendResult {
  sent: boolean
  error?: string
}

export async function send(db: Queryable, opts: SendOptions): Promise<SendResult> {
  const transport = getTransport()

  if (!transport) {
    const reason = transportUnavailableReason ?? 'No SMTP transport'
    await logEmail(db, opts, 'failed', null, reason)
    // Deliberately visible: during setup this is how an invite link is
    // retrieved. It is a development affordance, not a production path.
    if (!isProd) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mailer] Not sent (${reason}). To: ${opts.to} Subject: ${opts.subject}\n${opts.text}`
      )
    }
    return { sent: false, error: reason }
  }

  try {
    const info = await transport.sendMail({
      from: `"Neelachandra Construction and Interiors" <${env.SMTP_USER}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      replyTo: opts.replyTo,
    })
    await logEmail(db, opts, 'sent', {
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    })
    return { sent: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logEmail(db, opts, 'failed', null, message)
    return { sent: false, error: message }
  }
}

async function logEmail(
  db: Queryable,
  opts: SendOptions,
  status: 'sent' | 'failed',
  response: unknown,
  errorMessage?: string
): Promise<void> {
  try {
    await db
      .insertInto('email_log')
      .values({
        template_key: opts.templateKey.slice(0, 80),
        recipient: opts.to.slice(0, 190),
        entity_type: opts.entityType ?? null,
        entity_id: opts.entityId ?? null,
        status,
        response_json: response === null || response === undefined ? null : JSON.stringify(response),
        error_message: errorMessage ? errorMessage.slice(0, 500) : null,
      })
      .execute()
  } catch {
    // A failure to log must not turn a delivered email into a 500. The send
    // already happened, and losing the log row is the lesser loss.
  }
}

const APP = 'Neelachandra Construction and Interiors'

export function inviteEmail(opts: { fullName: string; link: string; hours: number }) {
  const text = [
    `Hello ${opts.fullName},`,
    '',
    `An account has been created for you on the ${APP} staff platform.`,
    '',
    'Set your password using the link below. Nobody else has seen or set a',
    'password for this account.',
    '',
    opts.link,
    '',
    `The link works once and expires in ${opts.hours} hours. If it expires, ask an`,
    'administrator to reissue it.',
    '',
    'If you were not expecting this, ignore it and tell the sender.',
  ].join('\n')
  return { subject: `Set your password for the ${APP} platform`, text }
}

export function resetEmail(opts: { fullName: string; link: string; hours: number }) {
  const text = [
    `Hello ${opts.fullName},`,
    '',
    'A password reset was requested for your account.',
    '',
    opts.link,
    '',
    `The link works once and expires in ${opts.hours} hours. Using it signs you out`,
    'of every device, which is deliberate.',
    '',
    'If you did not request this, no action is needed and your current password',
    'still works.',
  ].join('\n')
  return { subject: `Password reset for the ${APP} platform`, text }
}

export function lockoutAlertEmail(opts: { email: string; attempts: number; windowLabel: string }) {
  const text = [
    'A staff account has been locked after repeated failed sign-ins.',
    '',
    `Account: ${opts.email}`,
    `Failed attempts: ${opts.attempts} in ${opts.windowLabel}`,
    '',
    'If this was not the account holder mistyping a password, treat it as an',
    'attempted break-in and review the audit log.',
  ].join('\n')
  return { subject: 'Staff account locked after failed sign-ins', text }
}

export function enquiryNotificationEmail(opts: {
  name: string
  phone: string
  email: string | null
  city: string | null
  serviceInterest: string | null
  message: string | null
  sourcePage: string | null
}) {
  const text = [
    'A new enquiry arrived from the website.',
    '',
    `Name: ${opts.name}`,
    `Phone: ${opts.phone}`,
    `Email: ${opts.email ?? 'not given'}`,
    `City: ${opts.city ?? 'not given'}`,
    `Interested in: ${opts.serviceInterest ?? 'not stated'}`,
    `Page: ${opts.sourcePage ?? 'not recorded'}`,
    '',
    'Message:',
    opts.message ?? '(none)',
    '',
    'This enquiry is also recorded in the platform at /app/admin/enquiries.',
  ].join('\n')
  return { subject: `Website enquiry from ${opts.name}`, text }
}

/**
 * The quote a client receives (spec 6.7 routes: "Emails the PDF-printable link,
 * stamps sent_at").
 *
 * The figures are in the body, not only behind the link, because the link is
 * /api/crm/quotes/:id/print and that route is guarded by crm.lead_view — a
 * permission a client does not hold. The spec asks for the link and the link is
 * sent, but a client clicking it reaches the sign-in page, so an email carrying
 * nothing but the link would tell them nothing. Recorded in DECISIONS.md: there
 * is no public quote-view token anywhere in the schema, and minting signed
 * public URLs for price documents is a feature and an attack surface nobody
 * asked for. Until one exists, the practical path is the exec printing to PDF
 * and attaching it.
 */
export function quoteEmail(opts: {
  contactName: string
  quoteNo: string
  revision: number
  totalLabel: string
  validUntil: string
  link: string
  senderName: string
}) {
  const text = [
    `Dear ${opts.contactName},`,
    '',
    `Thank you for your interest in building with ${APP}.`,
    '',
    `Quote ${opts.quoteNo}${opts.revision > 1 ? ` revision ${opts.revision}` : ''}`,
    `Total including GST: ${opts.totalLabel}`,
    `Valid until: ${opts.validUntil}`,
    '',
    'The full quote sets out the specification, what is included, what is',
    'excluded and the payment schedule. Please read the exclusions: they are the',
    'part clients most often need to plan for separately.',
    '',
    opts.link,
    '',
    'Any question about a line in it is worth asking before you sign. Reply to',
    'this email or call us.',
    '',
    opts.senderName,
    APP,
  ].join('\n')
  return {
    subject: `Your quote ${opts.quoteNo} from ${APP}`,
    text,
  }
}
