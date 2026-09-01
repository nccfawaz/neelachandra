import { z } from 'zod'

/**
 * Zod-validated environment (spec 2.12: 16 keys, fail fast on boot).
 *
 * The loader is deliberately dumb: read process.env once, parse once, export
 * a frozen object. Anything missing or malformed stops the process before
 * the server accepts a single request. Secrets live in hPanel environment
 * variables in production and .env locally; this module never reads the file
 * itself (tsx and the start script load it).
 */

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))

const envSchema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),

  // 32 bytes encoded base64 is 44 chars; accept anything at least that
  // strong. The key derivation in lib/crypto uses scrypt on this value.
  SESSION_SECRET: z.string().min(44),

  CRON_SECRET: z.string().min(32),

  SMTP_HOST: z.string().min(1).default('smtp.hostinger.com'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),

  UPLOAD_PUBLIC_DIR: z.string().min(1).default('./uploads/public'),
  UPLOAD_PRIVATE_DIR: z.string().min(1).default('./uploads/private'),

  // Public by design: served verbatim at /<key>.txt for IndexNow.
  INDEXNOW_KEY: z.string().regex(/^[0-9a-f]{32}$/, 'INDEXNOW_KEY must be the 32 hex chars of the key file'),

  APP_BASE_URL: z
    .string()
    .url()
    .refine((v) => !v.endsWith('/'), 'APP_BASE_URL must not end with a slash'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    // eslint-disable-next-line no-console
    console.error(`Invalid or missing environment variables:\n${issues}`)
    throw new Error('Environment validation failed')
  }
  return Object.freeze(parsed.data)
}

export const env: Env = loadEnv()

export const isProd = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
