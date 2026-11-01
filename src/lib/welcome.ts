import { Effect } from "effect";
import { getIdentity, type Identity } from "~/lib/nap-server";
import { findPerson, listPeople, needsWelcome } from "~/lib/profiles";
import { json, noStore, redirect } from "~/server/http";

export const WELCOME_PATH = "/welcome";

/**
 * Sends people without a name to the welcome page on a page visit, with the page they wanted as
 * `next`. Only top-level navigations by people Access let in: frames, scripts, fetches, and
 * prefetches pass, and so do paths Access bypasses (those never reach this).
 */
export const welcomeRedirect = Effect.fn("welcomeRedirect")(function* (
  request: Request,
  dashboardOrigin: string,
  isLocal: boolean,
) {
  if (request.method !== "GET") return null;
  if (request.headers.get("sec-fetch-dest") !== "document") return null;
  if (request.headers.get("sec-purpose") || request.headers.get("purpose")) return null;
  if (!isLocal && !request.headers.get("cf-access-authenticated-user-email")) return null;
  const url = new URL(request.url);
  if (url.origin === dashboardOrigin && url.pathname === WELCOME_PATH) return null;
  if (!(yield* needsWelcome(getIdentity(request).email))) return null;
  const target = new URL(WELCOME_PATH, dashboardOrigin);
  target.searchParams.set("next", url.href);
  return redirect(target.href);
});

/** GET /_nap/me: the person viewing the page, with their name and look. */
export const meResponse = Effect.fn("meResponse")(function* (identity: Identity) {
  const person = yield* findPerson(identity.email, identity.name);
  return json({ ...person, email: identity.email }, { headers: noStore });
});

/** GET /_nap/people[?emails=a,b]: everyone on Nap, or these people, with names and looks. */
export const peopleResponse = Effect.fn("peopleResponse")(function* (request: Request) {
  const emails = new URL(request.url).searchParams.get("emails");
  const people = yield* listPeople(
    emails
      ? emails
          .split(",")
          .map((email) => email.trim())
          .filter(Boolean)
          .slice(0, 500)
      : undefined,
  );
  return json({ people }, { headers: { "cache-control": "private, max-age=30" } });
});
