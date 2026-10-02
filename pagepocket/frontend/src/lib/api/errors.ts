export class AuthenticationError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class PermissionError extends Error {
  constructor(message = "Permission denied") {
    super(message);
    this.name = "PermissionError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message = "Resource conflict") {
    super(message);
    this.name = "ConflictError";
  }
}

export class QuotaExceededError extends Error {
  constructor(message = "Quota exceeded") {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Rate limited — try again in ${retryAfterSeconds}s`);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ValidationError extends Error {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("Validation failed");
    this.name = "ValidationError";
    this.fields = fields;
  }
}

export class ApiContractError extends Error {
  readonly route: string;
  readonly issues: string;
  constructor(route: string, issues: string) {
    super(`API contract error on ${route}`);
    this.name = "ApiContractError";
    this.route = route;
    this.issues = issues;
  }
}

export class NetworkError extends Error {
  constructor(message = "Network error") {
    super(message);
    this.name = "NetworkError";
  }
}

export function throwForStatus(status: number, body: Record<string, unknown>): never {
  // The API gateway returns errors as `detail` (FastAPI convention); some
  // responses use `error`. Surface whichever is present.
  const message = (body.error ?? body.detail)?.toString();
  switch (status) {
    case 400: {
      const fields = (body.fields ?? {}) as Record<string, string>;
      throw new ValidationError(fields);
    }
    case 401:
      throw new AuthenticationError(message);
    case 402:
      throw new QuotaExceededError(message);
    case 403:
      throw new PermissionError(message);
    case 404:
      throw new NotFoundError(message);
    case 409:
      throw new ConflictError(message);
    case 429: {
      const retryAfter = Number(body.retry_after ?? 60);
      throw new RateLimitError(retryAfter);
    }
    default:
      throw new Error(`API error ${status}: ${message ?? "Unknown"}`);
  }
}
