import { IdentifierError } from "../services/identifier";

export type EndpointResponse = [number, string, string];

/**
 * Build a JSON endpoint response.
 *
 * @param status HTTP status code.
 * @param body Response payload.
 * @returns Zotero Local API response tuple.
 */
export function jsonResponse(status: number, body: unknown): EndpointResponse {
  return [status, "application/json", JSON.stringify(body)];
}

/**
 * Convert known workflow errors into the public API error model.
 *
 * @param error Caught endpoint error.
 * @returns Error response tuple.
 */
export function errorResponse(error: unknown): EndpointResponse {
  if (error instanceof IdentifierError) {
    const status = [
      "ITEM_NOT_FOUND",
      "COLLECTION_NOT_FOUND",
      "LOOKUP_FAILED",
    ].includes(error.code)
      ? 404
      : 400;
    return jsonResponse(status, {
      status: "error",
      code: error.code,
      message: error.message,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse(500, {
    status: "error",
    code: "INTERNAL_ERROR",
    message,
  });
}
