import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash, verify, Algorithm } from '@node-rs/argon2'
import { UnprocessableError } from './errors.js'

/**
 * argon2id password hashing (spec 2.5) and the policy checks from the README
 * account lifecycle: minimum 12 characters, checked against the 10,000 most
 * common passwords, no composition rules, no forced rotation.
 *
 * Parameters: 19 MiB memory, 2 passes, 1 lane. This is the OWASP minimum
 * recommendation for argon2id and it is chosen for the platform rather than
 * something heavier because Hostinger shared hosting gives the process
 * limited memory and ten users hashing at login do not justify spending
 * 64 MiB per verify. A cold process handling a login must not swap.
 */
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export const MIN_PASSWORD_LENGTH = 12

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON_OPTIONS)
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, ARGON_OPTIONS)
  } catch {
    // A malformed or truncated hash in the column is a verification failure,
    // not a 500. It must not be distinguishable from a wrong password.
    return false
  }
}

/**
 * The dummy verify for the constant-time login path (spec 6.1): on an email
 * that does not exist, POST /login still spends one argon2 verify so response
 * time does not enumerate users. This is a real argon2id hash of a random
 * string; nothing can ever match it.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$YmFzZWxpbmVub25jZXNhbHQ$C4gQvxCTaJhV2xIQnBhKUuJ4rEGwHiKzWFmqBoWJvXo'

export async function burnVerify(plain: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, plain)
}

let commonPasswords: Set<string> | undefined

async function loadCommonPasswords(): Promise<Set<string>> {
  if (commonPasswords) return commonPasswords
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Resolved relative to the compiled file. tsc does not copy .txt, so the
  // build script copies src/lib/data into dist/lib/data.
  const file = path.join(here, 'data', 'common-passwords.txt')
  const text = await readFile(file, 'utf8')
  commonPasswords = new Set(
    text
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0)
  )
  return commonPasswords
}

/**
 * Returns the reasons a password is rejected, empty when acceptable. Returning
 * a list rather than throwing on the first problem means the change-password
 * screen can show every reason at once instead of one per submit.
 */
export async function checkPasswordPolicy(
  plain: string,
  context: { email?: string; fullName?: string } = {}
): Promise<string[]> {
  const problems: string[] = []

  if (plain.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  if (plain.length > 200) {
    problems.push('Use no more than 200 characters.')
  }
  if (plain.trim().length === 0) {
    problems.push('A password cannot be only spaces.')
  }

  const lower = plain.toLowerCase()
  const common = await loadCommonPasswords()
  if (common.has(lower)) {
    problems.push('This password appears in the list of the 10,000 most common passwords.')
  }

  // A password containing the account's own email local part or a name is
  // guessable from public information, which is a different failure from
  // being on a leak list.
  const localPart = context.email?.split('@')[0]?.toLowerCase()
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) {
    problems.push('Do not include your email address in your password.')
  }
  if (context.fullName) {
    for (const namePart of context.fullName.toLowerCase().split(/\s+/)) {
      if (namePart.length >= 4 && lower.includes(namePart)) {
        problems.push('Do not include your name in your password.')
        break
      }
    }
  }

  return problems
}

export async function assertPasswordPolicy(
  plain: string,
  context: { email?: string; fullName?: string } = {}
): Promise<void> {
  const problems = await checkPasswordPolicy(plain, context)
  if (problems.length > 0) {
    throw new UnprocessableError(problems.join(' '), { problems })
  }
}
