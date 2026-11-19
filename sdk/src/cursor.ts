/**
 * History cursor tokens (issue #1070).
 *
 * A cursor is an opaque, URL-safe token (base64url alphabet) handed out by the backend. The client
 * validates it locally before building a request so a malformed or oversized value fails with a
 * clear error instead of a confusing contract invocation failure.
 */

/** Longest accepted cursor, in characters. */
export const MAX_CURSOR_LENGTH = 256;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

export class CursorValidationError extends Error {
  readonly code = "INVALID_CURSOR";

  constructor(message: string) {
    super(message);
    this.name = "CursorValidationError";
  }
}

/** Throws {@link CursorValidationError} unless `cursor` is a well-formed token. */
export function validateCursor(cursor: unknown): asserts cursor is string {
  if (typeof cursor !== "string") {
    throw new CursorValidationError(
      `cursor must be a string, got ${cursor === null ? "null" : typeof cursor}`,
    );
  }
  if (cursor.length === 0) {
    throw new CursorValidationError("cursor must not be empty (omit it to start from the beginning)");
  }
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new CursorValidationError(
      `cursor is ${cursor.length} characters, longer than the maximum of ${MAX_CURSOR_LENGTH}`,
    );
  }
  if (!CURSOR_PATTERN.test(cursor)) {
    throw new CursorValidationError(
      "cursor may only contain letters, digits, '-' and '_' (base64url); it looks corrupted or was not issued by the API",
    );
  }
}

export interface HistoryRequest {
  /** Omitted for the first page. */
  cursor?: string;
  limit: number;
}

/** Validates and encodes a history request as contract arguments `[cursor | null, limit]`. */
export function encodeHistoryRequest(request: HistoryRequest): [string | null, number] {
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new CursorValidationError(`limit must be a positive integer, got ${request.limit}`);
  }
  if (request.cursor !== undefined) validateCursor(request.cursor);
  return [request.cursor ?? null, request.limit];
}

/** Inverse of {@link encodeHistoryRequest}; used to prove cursors round-trip unchanged. */
export function decodeHistoryRequest(args: [string | null, number]): HistoryRequest {
  const [cursor, limit] = args;
  return cursor === null ? { limit } : { cursor, limit };
}
