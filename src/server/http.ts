import { Effect, Predicate, Schema } from "effect";

/**
 * HTTP at the edges of Nap's Effect code.
 *
 * Handlers are `Effect<Response, HttpError | ...>`. Anything a client should see as an error
 * response (bad input, not found, a conflict) fails with `HttpError`; the runtime turns it into
 * the response. Infrastructure failures (D1, R2, Artifacts) keep their own tagged errors and
 * become a 500.
 */

export const noStore = { "cache-control": "no-store" } as const;

export function json(data: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

/**
 * An error response. `body` is sent as JSON, or as plain text when it is a string.
 */
export class HttpError extends Schema.TaggedError<HttpError>()("HttpError", {
  status: Schema.Number,
  body: Schema.Unknown,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {
  toResponse() {
    if (Predicate.isString(this.body)) {
      return new Response(this.body, { status: this.status, headers: this.headers });
    }
    return json(this.body, { status: this.status, headers: this.headers });
  }
}

/** Fails with `{ error, ...extra }` as JSON. */
export const fail = (
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
  headers?: Record<string, string>,
) => Effect.fail(new HttpError({ status, body: { error, ...extra }, headers }));

/** `fail`, with `cache-control: no-store`. */
export const failNoStore = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  fail(status, error, extra, noStore);

/** Fails with a plain-text body. */
export const failText = (status: number, text: string, headers?: Record<string, string>) =>
  Effect.fail(new HttpError({ status, body: text, headers }));

/** Turns an `HttpError` back into its response, so a handler always succeeds. */
export const recoverHttpError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(
    effect,
    (error): error is Extract<E, HttpError> => error instanceof HttpError,
    (error) => Effect.succeed(error.toResponse()),
  );

/** A JSON body forces a CORS preflight, which Nap never answers, so other origins cannot call. */
export function isCrossSite(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  return Boolean(site && site !== "same-origin" && site !== "none");
}

/** 403 for requests from another site. Forms need no preflight, so mutations check this. */
export const requireSameSite = (request: Request) =>
  isCrossSite(request) ? fail(403, "Forbidden") : Effect.void;

/** 415 unless the body says it is JSON. */
export const requireJsonBody = (request: Request, error = "Expected JSON") =>
  request.headers.get("content-type")?.includes("application/json")
    ? Effect.void
    : fail(415, error);

/** The body as a JSON object, or `{}` when it is missing or not JSON. */
export const readJsonObject = (request: Request) =>
  Effect.promise(() =>
    request.json().then(
      (value: unknown) =>
        (Predicate.isObject(value) && !Array.isArray(value) ? value : {}) as Record<
          string,
          unknown
        >,
      () => ({}) as Record<string, unknown>,
    ),
  );

/** The body as JSON, or null when it is not JSON. */
export const readJson = (request: Request) =>
  Effect.promise((): Promise<unknown> => request.json().catch(() => null));

/**
 * Decodes untrusted input with a schema and fails with this response when it does not match.
 */
export const decodeOr =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S, onError: () => HttpError) =>
  (input: unknown): Effect.Effect<S["Type"], HttpError> =>
    Effect.mapError(Schema.decodeUnknownEffect(schema)(input), onError) as Effect.Effect<
      S["Type"],
      HttpError
    >;

/** String fields from a JSON body, a form body, or the query string. Body fields win. */
export const readParams = (request: Request, url: URL) =>
  Effect.promise(async () => {
    const params: Record<string, string> = Object.fromEntries(url.searchParams);
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      for (const [key, value] of Object.entries(body ?? {})) {
        if (Predicate.isString(value)) params[key] = value;
      }
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await request.formData().catch(() => null);
      for (const [key, value] of form?.entries() ?? []) {
        if (Predicate.isString(value)) params[key] = value;
      }
    }
    return params;
  });

/** `value` when it is a string, else "". For lenient form-like JSON bodies. */
export const stringField = (value: unknown) => (Predicate.isString(value) ? value : "");

export function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location, "cache-control": "no-store" } });
}
