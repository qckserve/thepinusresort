// Errors with a stable code that the API turns into the right HTTP status.
const STATUS = { VALIDATION_ERROR: 422, NOT_FOUND: 404, CONFLICT: 409, SOLD_OUT: 409, UNAUTHORIZED: 401, FORBIDDEN: 403, RATE_LIMITED: 429, NOT_CONFIGURED: 503 };

export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.status = STATUS[code] || 500;
    this.details = details;
  }
}
