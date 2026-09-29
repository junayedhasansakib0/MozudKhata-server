import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** Machine-readable error codes returned in the API error envelope. */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL";

const statusByCode: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export interface ErrorDetail {
  path: string;
  message: string;
}

/** Application error that maps to a known status code and safe client message. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "AppError";
  }

  get statusCode(): number {
    return statusByCode[this.code];
  }
}

/**
 * Registers the global error + not-found handlers so every failure leaves the
 * API as the standard envelope (see docs/api.md) and never leaks internals.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed.",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }

    // Framework-raised client errors (malformed JSON, unsupported media type,
    // payload too large, throttling, …) carry a 4xx `statusCode`. Map them to the
    // standard envelope with a safe, generic message instead of masking them as a
    // 500 — but never echo the framework's raw message (may leak internals).
    const status = typeof error.statusCode === "number" ? error.statusCode : undefined;
    if (status && status >= 400 && status < 500) {
      const clientError: Record<number, { code: ErrorCode; message: string }> = {
        400: { code: "VALIDATION_ERROR", message: "Invalid request." },
        401: { code: "UNAUTHORIZED", message: "Authentication required." },
        403: { code: "FORBIDDEN", message: "Forbidden." },
        404: { code: "NOT_FOUND", message: "Resource not found." },
        413: { code: "VALIDATION_ERROR", message: "Request payload too large." },
        415: { code: "VALIDATION_ERROR", message: "Unsupported media type." },
        429: { code: "RATE_LIMITED", message: "Too many requests." },
      };
      const mapped = clientError[status] ?? { code: "VALIDATION_ERROR" as ErrorCode, message: "Invalid request." };
      return reply.status(status).send({ error: { code: mapped.code, message: mapped.message } });
    }

    app.log.error(error);
    return reply
      .status(500)
      .send({ error: { code: "INTERNAL", message: "Internal server error." } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: "NOT_FOUND", message: "Resource not found." } });
  });
}
