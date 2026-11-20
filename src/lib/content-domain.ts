import { Effect } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { artifactPath, contentDomainOf, type NapPlace } from "~/lib/nap-urls";
import { findRedirect } from "~/lib/rekey";
import { Database } from "~/server/database";
import { failText, redirect } from "~/server/http";
import { Settings } from "~/server/platform";

/**
 * A separate content domain (napConfig.contentDomain): naps on their own host run at
 * <name>.<content>, a registrable domain of their own, so their cookies cannot reach the root's
 * site. The content domain has its own Cloudflare Access application, with its own audience.
 *
 * Nap reads the person from the header Access adds (getIdentity). On content hosts it first
 * checks the Access JWT that comes with it: signed by the team, for the content application's
 * audience. A session for the root's application is refused here, and content sessions never
 * reach the root (their cookie is for one content host).
 */

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The team's signing keys. jose caches them and refetches when a key id is new. */
function teamKeys(issuer: string) {
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  return keys;
}

const refuse = () => failText(403, "Sign in to open this nap.", { "cache-control": "no-store" });

/**
 * Checks that a request to a content host came through the content domain's Access application,
 * and returns it with the verified email in the identity header. Without a configured
 * application (local stages), it still requires the Access header, never the dev fallback.
 */
export const verifyContentAccess = Effect.fn("verifyContentAccess")(function* (request: Request) {
  const { contentAccess } = yield* Settings;
  const headerEmail = request.headers.get("cf-access-authenticated-user-email");
  if (!contentAccess) {
    if (!headerEmail) return yield* refuse();
    return withoutDevIdentity(request, headerEmail);
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return yield* refuse();
  const verified = yield* Effect.tryPromise(() =>
    jwtVerify(token, teamKeys(contentAccess.issuer), {
      issuer: contentAccess.issuer,
      audience: contentAccess.aud,
      algorithms: ["RS256"],
    }),
  ).pipe(
    Effect.tapError((error) =>
      Effect.logInfo("Refused a content domain request").pipe(
        Effect.annotateLogs({ reason: String(error.cause ?? error) }),
      ),
    ),
    Effect.catch(() => refuse()),
  );
  const email = verified.payload.email;
  if (typeof email !== "string" || !email) return yield* refuse();
  return withoutDevIdentity(request, email);
});

/** The request as Nap reads it: this email in the Access header, and no local dev header. */
function withoutDevIdentity(request: Request, email: string) {
  if (
    request.headers.get("cf-access-authenticated-user-email") === email &&
    !request.headers.has("x-nap-dev-email")
  ) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("cf-access-authenticated-user-email", email);
  headers.delete("x-nap-dev-email");
  return new Request(request, { headers });
}

/**
 * <name>.<root>/<path>?<query> on a deployment with a separate content domain. A nap on its own
 * host moved to <name>.<content>; a nap in the frame is at <root>/<name>. Old names follow
 * nap_redirects. Nothing is served here. Access protects <name>.<root> as before, so only
 * people who signed in learn whether a name exists.
 */
export const redirectFromOldHost = Effect.fn("redirectFromOldHost")(function* (
  slug: string,
  request: Request,
  place: NapPlace,
) {
  // A service worker that a nap installed here before the move, checking for its update. It
  // could keep serving the nap's old code on this host from its cache: give it no update, and
  // have the browser clear this origin, which unregisters it.
  if (request.headers.get("service-worker") === "script") {
    return new Response("Not found", {
      status: 404,
      headers: { "clear-site-data": '"storage"', "cache-control": "no-store" },
    });
  }
  const url = new URL(request.url);
  const db = yield* Database;
  const kindOf = (name: string) =>
    Effect.map(
      db.first<{ kind: string }>("SELECT kind FROM sites WHERE slug = ?", name),
      (row) => row?.kind ?? null,
    );
  let name = slug;
  let kind = yield* kindOf(name);
  let renamed = false;
  if (!kind) {
    const moved = yield* findRedirect(slug);
    if (moved) {
      name = moved;
      kind = yield* kindOf(moved);
      renamed = true;
    }
  }
  if (!kind) return yield* failText(404, "Nap not found", { "cache-control": "no-store" });

  const rest = url.pathname === "/" ? "" : url.pathname;
  const preserveMethod = request.method !== "GET" && request.method !== "HEAD";
  if (kind === "site") {
    const target = `https://${name}.${contentDomainOf(place)}${url.pathname}${url.search}`;
    // The name may move again or be taken by another nap: only a direct hit is permanent.
    if (renamed) return redirect(target, preserveMethod ? 307 : 302);
    return redirect(target, preserveMethod ? 308 : 301);
  }
  return redirect(
    `https://${place.rootDomain}${artifactPath(name)}${rest}${url.search}`,
    preserveMethod ? 307 : 302,
  );
});
