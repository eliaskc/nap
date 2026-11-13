import { Effect } from "effect";
import { slackChannel } from "~/lib/access-slack";
import { ensureProfile, type Identity } from "~/lib/nap-server";
import { napUrl, type NapKind, type NapPlace } from "~/lib/nap-urls";
import { canViewSite, isSameEmail, type Visibility } from "~/lib/site-access";
import { napConfig } from "~/nap.config";
import { Database, sql } from "~/server/database";
import { fail, failNoStore, HttpError, json, noStore, readParams, redirect } from "~/server/http";
import { inBackground, type Settings } from "~/server/platform";
import { randomString } from "~/server/tokens";

/**
 * Access requests (napConfig.accessRequests). Someone opens a nap that is not shared with them
 * and asks for it on the no-access page. Nap tells the owner through the instance's channels
 * (such as a Slack message with buttons), and the owner answers there or on /requests/<id>:
 * invite them, share the nap with everyone, or deny. Every answer goes through
 * decideAccessRequest, the one place that checks that the person answering owns the nap.
 * The page polls /_nap/access/status and opens the nap once they are let in.
 */

export type AccessDecision = "add" | "everyone" | "deny";
export const isAccessDecision = (value: unknown): value is AccessDecision =>
  value === "add" || value === "everyone" || value === "deny";

/** A pending request counts for a week. After that the person may ask again. */
const PENDING_DAYS = 7;
/** One request per person and nap a day, so a denied person cannot keep asking. */
const REQUEST_EVERY_HOURS = 24;
/** Requests one person may send a day, across every nap. */
const DAILY_LIMIT = 20;

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/** A request as channels and the dashboard see it. */
export type AccessRequestInfo = {
  id: string;
  slug: string;
  kind: NapKind;
  title: string;
  visibility: Visibility;
  requesterEmail: string;
  requesterName: string | null;
  ownerEmail: string;
  ownerName: string | null;
  status: "pending" | "approved" | "denied";
  decision: AccessDecision | null;
  decidedByEmail: string | null;
  createdAt: string;
  /** The nap itself. */
  napUrl: string;
  /** Where the owner answers on the dashboard. */
  answerUrl: string;
};

type ChannelRef = Record<string, unknown>;

/**
 * Somewhere Nap tells owners about requests. `send` returns what it needs to find its message
 * again, or null when it could not reach the owner. `answered` updates that message once the
 * request is answered, wherever that happened. Neither fails: they log what goes wrong.
 */
export type AccessRequestChannel = {
  name: string;
  /** How the page names it: "Nap sent Elias a message on Slack". */
  label: string;
  send(request: AccessRequestInfo): Effect.Effect<ChannelRef | null, never, Settings>;
  answered(request: AccessRequestInfo, ref: ChannelRef): Effect.Effect<void, never, Settings>;
};

let channelOverride: ReadonlyArray<AccessRequestChannel> | null = null;

/** Tests: use these channels instead of the instance's. null goes back to the instance's. */
export function useAccessRequestChannels(channels: ReadonlyArray<AccessRequestChannel> | null) {
  channelOverride = channels;
}

/** The channels this instance turned on. None means access requests are off. */
export function accessRequestChannels(): ReadonlyArray<AccessRequestChannel> {
  if (channelOverride) return channelOverride;
  const all: Record<string, AccessRequestChannel> = { slack: slackChannel };
  return (napConfig.accessRequests?.channels ?? []).flatMap((name) => all[name] ?? []);
}

type Row = {
  id: string;
  slug: string;
  kind: NapKind;
  title: string;
  visibility: Visibility;
  requesterEmail: string;
  requesterName: string | null;
  ownerEmail: string;
  ownerName: string | null;
  status: AccessRequestInfo["status"];
  decision: AccessDecision | null;
  decidedByEmail: string | null;
  createdAt: string;
  channelRefs: string;
};

const SELECT_REQUEST = `
  SELECT r.id, r.site_slug AS slug, sites.kind, sites.title, sites.visibility,
         r.email AS requesterEmail, requester.display_name AS requesterName,
         sites.created_by_email AS ownerEmail, owner.display_name AS ownerName,
         r.status, r.decision, r.decided_by_email AS decidedByEmail, r.created_at AS createdAt,
         r.channel_refs AS channelRefs
  FROM access_requests r
  JOIN sites ON sites.slug = r.site_slug
  LEFT JOIN profiles requester ON lower(requester.email) = lower(r.email)
  LEFT JOIN profiles owner ON lower(owner.email) = lower(sites.created_by_email)`;

const loadRow = Effect.fn("loadAccessRequest")(function* (id: string) {
  const db = yield* Database;
  return yield* db.first<Row>(`${SELECT_REQUEST} WHERE r.id = ?`, id);
});

function toInfo(row: Row, place: NapPlace): AccessRequestInfo {
  const { channelRefs: _, ...rest } = row;
  const dashboard = place.localOrigin || `https://${place.rootDomain}`;
  return {
    ...rest,
    napUrl: napUrl({ slug: row.slug, kind: row.kind }, place),
    answerUrl: `${dashboard}/requests/${encodeURIComponent(row.id)}`,
  };
}

function readRefs(value: string): Record<string, ChannelRef> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, ChannelRef>) : {};
  } catch {
    return {};
  }
}

/** Where this person's request for a nap stands, for the no-access page. */
export type VisitorRequestState =
  | { state: "off" }
  | { state: "none"; canRequest: boolean; channel: string }
  | { state: "pending"; notified: boolean; channel: string }
  | { state: "denied"; canRequest: boolean; channel: string };

export const visitorRequestState = Effect.fn("visitorRequestState")(function* (
  slug: string,
  email: string,
): Effect.fn.Return<VisitorRequestState, never, Database> {
  const channels = accessRequestChannels();
  if (!channels.length) return { state: "off" };
  const channel = channels[0].label;
  const db = yield* Database;
  const latest = yield* db
    .first<{ status: string; createdAt: string; channelRefs: string }>(
      `SELECT status, created_at AS createdAt, channel_refs AS channelRefs FROM access_requests
       WHERE site_slug = ? AND lower(email) = lower(?) ORDER BY created_at DESC LIMIT 1`,
      slug,
      email,
    )
    .pipe(Effect.orDie);
  if (!latest) return { state: "none", canRequest: true, channel };
  if (latest.status === "pending" && latest.createdAt > ago(PENDING_DAYS * 24)) {
    return {
      state: "pending",
      notified: Object.keys(readRefs(latest.channelRefs)).length > 0,
      channel,
    };
  }
  const canRequest = latest.createdAt < ago(REQUEST_EVERY_HOURS);
  // Approved but shut out again since, or a pending request that ran out.
  return latest.status === "denied"
    ? { state: "denied", canRequest, channel }
    : { state: "none", canRequest, channel };
});

/** Asks the owner of a nap for access to it, through every channel. */
export const createAccessRequest = Effect.fn("createAccessRequest")(function* (
  identity: Identity,
  slug: string,
  place: NapPlace,
) {
  const channels = accessRequestChannels();
  if (!channels.length) return yield* fail(404, "Access requests are off on this Nap");
  const db = yield* Database;
  const site = yield* db.first<{ slug: string; visibility: Visibility; createdByEmail: string }>(
    "SELECT slug, visibility, created_by_email AS createdByEmail FROM sites WHERE slug = ?",
    slug,
  );
  if (!site) return yield* fail(404, "Not found");
  if (yield* canViewSite(site, identity.email)) return { status: "allowed" as const };

  const current = yield* visitorRequestState(slug, identity.email);
  if (current.state === "pending") return { status: "pending" as const };
  if (current.state !== "off" && !current.canRequest) {
    return yield* fail(429, "You asked today. You can ask again tomorrow.");
  }
  const today = yield* db.first<{ count: number }>(
    "SELECT count(*) AS count FROM access_requests WHERE lower(email) = lower(?) AND created_at > ?",
    identity.email,
    ago(24),
  );
  if ((today?.count ?? 0) >= DAILY_LIMIT) {
    return yield* fail(429, "That's all the access requests you can send today.");
  }

  yield* ensureProfile(identity);
  const id = randomString(12);
  yield* db.run(
    "INSERT INTO access_requests (id, site_slug, email) VALUES (?, ?, ?)",
    id,
    slug,
    identity.email,
  );
  const row = yield* loadRow(id);
  if (!row) return yield* fail(404, "Not found");
  const info = toInfo(row, place);

  const refs: Record<string, ChannelRef> = {};
  for (const channel of channels) {
    const ref = yield* channel.send(info);
    if (ref) refs[channel.name] = ref;
  }
  if (Object.keys(refs).length) {
    yield* db.run(
      "UPDATE access_requests SET channel_refs = ? WHERE id = ?",
      JSON.stringify(refs),
      id,
    );
  }
  yield* Effect.logInfo("Access requested").pipe(
    Effect.annotateLogs({ slug, id, notified: Object.keys(refs).join(",") }),
  );
  return { status: "pending" as const };
});

/**
 * Answers a request. Only the nap's owner may: `email` is whoever answers, from Access, an app
 * token, or a channel that proved who clicked. Answering an answered request changes nothing.
 * Sharing with everyone answers every pending request for the nap.
 */
export const decideAccessRequest = Effect.fn("decideAccessRequest")(function* (
  email: string,
  id: string,
  decision: AccessDecision,
  place: NapPlace,
) {
  const row = yield* loadRow(id);
  if (!row) return yield* fail(404, "Request not found");
  if (!isSameEmail(row.ownerEmail, email)) {
    return yield* fail(403, `Only the owner of ${row.title} can answer this request`);
  }
  if (row.status !== "pending") return { request: toInfo(row, place), changed: false };

  const db = yield* Database;
  const owner = row.ownerEmail.toLowerCase();
  const status = decision === "deny" ? "denied" : "approved";
  const answer = (where: string, ...params: Array<unknown>) =>
    sql(
      `UPDATE access_requests
       SET status = ?, decision = ?, decided_by_email = ?,
           decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'pending' AND ${where}`,
      status,
      decision,
      email,
      ...params,
    );
  // Each statement checks the owner again, so an owner change in between changes nothing.
  const isOwner = "EXISTS (SELECT 1 FROM sites WHERE slug = ?1 AND lower(created_by_email) = ?2)";

  const pendingIds =
    decision === "everyone"
      ? (yield* db.all<{ id: string }>(
          "SELECT id FROM access_requests WHERE site_slug = ? AND status = 'pending'",
          row.slug,
        )).map((r) => r.id)
      : [id];

  if (decision === "add") {
    yield* db.batch([
      // A private nap has no invited people; drop leftovers before it starts inviting.
      sql(
        `DELETE FROM site_viewers WHERE site_slug = ?1 AND ${isOwner}
           AND EXISTS (SELECT 1 FROM sites WHERE slug = ?1 AND visibility = 'private')`,
        row.slug,
        owner,
      ),
      sql(
        `UPDATE sites SET visibility = 'selected'
         WHERE slug = ?1 AND lower(created_by_email) = ?2 AND visibility = 'private'`,
        row.slug,
        owner,
      ),
      sql(
        `INSERT OR IGNORE INTO site_viewers (site_slug, email)
         SELECT ?1, ?3 WHERE ${isOwner}
           AND NOT EXISTS (SELECT 1 FROM site_viewers WHERE site_slug = ?1 AND lower(email) = lower(?3))`,
        row.slug,
        owner,
        row.requesterEmail,
      ),
      answer("id = ?", id),
    ]);
  } else if (decision === "everyone") {
    yield* db.batch([
      sql(
        `UPDATE sites SET visibility = 'everyone' WHERE slug = ? AND lower(created_by_email) = ?`,
        row.slug,
        owner,
      ),
      answer("site_slug = ?", row.slug),
    ]);
  } else {
    yield* db.run(
      `UPDATE access_requests
       SET status = 'denied', decision = 'deny', decided_by_email = ?,
           decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE status = 'pending' AND id = ?`,
      email,
      id,
    );
  }
  yield* Effect.logInfo("Access request answered").pipe(
    Effect.annotateLogs({ slug: row.slug, id, decision }),
  );

  // Every channel's message about these requests says how they were answered.
  yield* inBackground(updateChannels(pendingIds, place), "Updating access request messages failed");

  const updated = yield* loadRow(id);
  return { request: toInfo(updated ?? row, place), changed: true };
});

const updateChannels = Effect.fn("updateAccessRequestChannels")(function* (
  ids: ReadonlyArray<string>,
  place: NapPlace,
) {
  const channels = accessRequestChannels();
  for (const id of ids) {
    const row = yield* loadRow(id);
    if (!row) continue;
    const refs = readRefs(row.channelRefs);
    for (const channel of channels) {
      const ref = refs[channel.name];
      if (ref) yield* channel.answered(toInfo(row, place), ref);
    }
  }
});

/** A request for its owner, for /requests/<id>. Nobody else may see it. */
export const describeAccessRequest = Effect.fn("describeAccessRequest")(function* (
  email: string,
  id: string,
  place: NapPlace,
) {
  const row = yield* loadRow(id);
  if (!row) return yield* fail(404, "Request not found");
  if (!isSameEmail(row.ownerEmail, email)) {
    return yield* fail(403, "Only the owner can see this request");
  }
  return toInfo(row, place);
});

/**
 * `/_nap/access/request` and `/_nap/access/status` on a nap's host (and the artifact page). The
 * person comes through Access. `request` is a form post from the no-access page, which goes back
 * to `back`; `status` is what the page polls.
 */
export const handleVisitorAccessRequest = Effect.fn("handleVisitorAccessRequest")(function* (
  slug: string,
  action: "request" | "status",
  request: Request,
  identity: Identity,
  place: NapPlace,
) {
  if (action === "status") {
    if (request.method !== "GET") return yield* failNoStore(405, "Method not allowed");
    const db = yield* Database;
    const site = yield* db.first<{ slug: string; visibility: Visibility; createdByEmail: string }>(
      "SELECT slug, visibility, created_by_email AS createdByEmail FROM sites WHERE slug = ?",
      slug,
    );
    if (!site) return yield* failNoStore(404, "Not found");
    if (yield* canViewSite(site, identity.email)) {
      return json({ allowed: true, state: "allowed" }, { headers: noStore });
    }
    const state = yield* visitorRequestState(slug, identity.email);
    return json({ allowed: false, state: state.state }, { headers: noStore });
  }

  if (request.method !== "POST") return yield* failNoStore(405, "Method not allowed");
  // Only the no-access page on this origin: other naps on sibling hosts are same-site, not
  // same-origin, and must not ask in someone's name.
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return yield* failNoStore(403, "Forbidden");
  const url = new URL(request.url);
  const params = yield* readParams(request, url);
  const back = /^\/(?!\/)/.test(params.back ?? "") ? params.back : "/";
  const result = yield* createAccessRequest(identity, slug, place).pipe(
    // The page shows where the request stands, so a refusal also goes back to it.
    Effect.catchIf(
      (error): error is HttpError => error instanceof HttpError && error.status === 429,
      () => Effect.succeed({ status: "limited" as const }),
    ),
  );
  if (request.headers.get("accept")?.includes("application/json")) {
    return json(result, { headers: noStore });
  }
  return redirect(back, 303);
});
