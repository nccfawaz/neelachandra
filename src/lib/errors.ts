/**
 * The application error taxonomy. Every service throws one of these and
 * src/middleware/errorHandler.ts maps them to a status and a page, so no
 * handler has to remember which HTTP code a rule violation is.
 */

export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: unknown

  constructor(message: string, status: number, code: string, detail?: unknown) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', detail?: unknown) {
    super(message, 400, 'bad_request', detail)
  }
}

export class UnauthorisedError extends AppError {
  constructor(message = 'Sign in required') {
    super(message, 401, 'unauthorised')
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that') {
    super(message, 403, 'forbidden')
  }
}

/**
 * Used for a record that exists but the caller must not learn about
 * (spec 4.4: an unassigned project returns 404, not 403, so a supervisor
 * cannot discover projects by probing IDs).
 */
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, 404, 'not_found')
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', detail?: unknown) {
    super(message, 409, 'conflict', detail)
  }
}

/**
 * A business rule refusal, distinct from a malformed request. Issuing more
 * cement than the store holds is a 422: the request was well formed and the
 * system is telling the user why it will not do it.
 */
export class UnprocessableError extends AppError {
  constructor(message = 'Cannot process', detail?: unknown) {
    super(message, 422, 'unprocessable', detail)
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number

  constructor(message = 'Too many attempts', retryAfterSeconds = 60) {
    super(message, 429, 'rate_limited')
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}
