import publishScript from "~/content/publish.mjs?raw";
import skill from "../../skills/nap/SKILL.md?raw";
import { Effect, Predicate } from "effect";
import { napConfig } from "~/nap.config";
import { agentInstructionsFor } from "~/lib/agent-instructions";
import { serveClientTypes } from "~/lib/site-data-client";
import { DEFAULT_ACCESS, EVERYONE_LABEL, fillDeploymentText } from "~/lib/deployment-text";
import {
  authenticateAgent,
  exchangeDeviceCode,
  startDeviceLogin,
  type AgentIdentity,
} from "~/lib/agent-auth";
import { handleComments } from "~/lib/comments";
import { commitDirectUpload, startDirectUpload } from "~/lib/direct-uploads";
import { objectKey, slugify } from "~/lib/nap-server";
import { isLocalHostname, napUrl as placeUrl, type NapKind } from "~/lib/nap-urls";
import { publishFiles, type PublishedNap } from "~/lib/publish";
import {
  canViewSite,
  isSameEmail,
  isVisibility,
  normalizeEmail,
  type Visibility,
} from "~/lib/site-access";
import { isSafePath, normalizePath, readUpload, rejectLargeBody } from "~/lib/uploads";
import { createSource, describeSource, mintSourceToken, SOURCE_BRANCH } from "~/lib/sources";
import { listVersions, restoreVersion } from "~/lib/versions";
import { handleAppsApi } from "~/lib/apps";
import { handleSiteDataRequest } from "~/lib/site-data";
import { findPerson } from "~/lib/profiles";
import { peopleResponse } from "~/lib/welcome";
import { handleLiveRequest, publishChange } from "~/lib/site-live";
import { handleChannelRequest } from "~/lib/site-channel";
import { handleRtcRequest } from "~/lib/site-rtc";
import { handleSiteFetch } from "~/lib/site-fetch";
import { EXTENSIONS } from "~/lib/extension-registry";
import { handleExtensionRequest } from "~/lib/extensions";
import {
  handleNotifyRequest,
  notificationsOn,
  removeTarget,
  saveApnsTarget,
  readAppSlug,
  sendNotification,
  sendTest,
} from "~/lib/notifications";
import { Database } from "~/server/database";
import {
  fail,
  failNoStore,
  HttpError,
  json,
  noStore,
  readJsonObject,
  readParams,
} from "~/server/http";
import { RateLimiter, Settings } from "~/server/platform";
import { Storage } from "~/server/storage";

/**
 * The agent API at <root>/_nap/api/*. Access bypasses this path, so every route except
 * sign-in, the instructions, and the publish script needs an agent token. A token acts as the
 * person who signed it in, with less power: it can publish new naps (private unless it sets
 * `access`), publish and restore versions of any nap that person can view, and comment on
 * artifacts they can view. On a nap someone else owns, it must send the live version it read, so
 * it cannot overwrite a change it has not seen. It cannot change access, rename, or delete
 * anything. The owner does that in Nap.
 *
 * Sites can keep their source in a Nap source repo (see sources.ts). The agent gets a short-lived
 * Git token here, clones and pushes with Git, builds, and publishes with the commit it built.
 */

const PREFIX = "/_nap/api";

type NapRow = {
  slug: string;
  kind: "site" | "artifact";
  title: string;
  currentVersion: string;
  visibility: Visibility;
  listed: number;
  toolbar: number;
  sourceRepo: string | null;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
};

const NAP_COLUMNS = `slug, kind, title, current_version AS currentVersion, visibility, listed, toolbar,
  source_repo AS sourceRepo, created_by_email AS createdByEmail,
  created_at AS createdAt, updated_at AS updatedAt`;

const markdown = (text: string) =>
  new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8", ...noStore } });

/** 429 when this token uploaded too much in the last minute. */
const limitUploads = Effect.fnUntraced(function* (agent: AgentIdentity) {
  const limiter = yield* RateLimiter;
  if (!(yield* limiter.allow(`token:${agent.tokenId}`))) {
    return yield* fail(429, "Too many uploads. Wait a minute.");
  }
});

export const handleAgentApi = Effect.fn("handleAgentApi")(function* (request: Request) {
  const { rootDomain } = yield* Settings;
  const url = new URL(request.url);
  const path = url.pathname.slice(PREFIX.length).replace(/\/+$/, "") || "/";
  const method = request.method;

  const topic = /^\/instructions(?:\/([a-z]+))?$/.exec(path);
  if (topic && method === "GET") {
    const text = agentInstructionsFor(rootDomain, topic[1] ?? "index");
    if (text === null) return yield* failNoStore(404, "No such topic");
    return markdown(text);
  }
  // The agent skill (skills/nap/SKILL.md), for installing without GitHub.
  if (path === "/skill" && method === "GET") return markdown(skill);
  if (path === "/publish.mjs" && method === "GET") {
    return new Response(fillDeploymentText(publishScript, { ...napConfig, rootDomain }), {
      headers: { "content-type": "text/javascript; charset=utf-8", ...noStore },
    });
  }
  // The types of window.nap (/_nap/client.js), for sites written in TypeScript.
  if (path === "/client.d.ts" && method === "GET") return serveClientTypes();
  if (path === "/auth/device") return yield* startDeviceLogin(request, url);
  if (path === "/auth/token") return yield* exchangeDeviceCode(request, url);

  const agent = yield* authenticateAgent(request);
  const db = yield* Database;

  const place = { rootDomain, localOrigin: isLocalHostname(url.hostname) ? url.origin : null };
  const napUrl = (nap: { slug: string; kind: NapKind }) => placeUrl(nap, place);
  const describe = (row: NapRow) => ({
    id: row.slug,
    owner: row.createdByEmail,
    role: isSameEmail(row.createdByEmail, agent.email) ? "owner" : "editor",
    kind: row.kind,
    title: row.title,
    url: napUrl(row),
    currentVersion: row.currentVersion,
    access: row.visibility,
    listed: Boolean(row.listed),
    toolbar: Boolean(row.toolbar),
    source: row.sourceRepo ? { branch: SOURCE_BRANCH } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  if (path === "/me" && method === "GET") {
    // With the look (shape and color), like /_nap/me on a nap's host: NapKit's Nap.me().
    const person = yield* findPerson(agent.email, agent.name);
    return json({ ...person, email: agent.email, client: agent.client }, { headers: noStore });
  }

  // Everyone on Nap with their name and look, like /_nap/people on a nap's host. For native
  // apps that draw people the way their site does.
  if (path === "/people" && method === "GET") return yield* peopleResponse(request);

  // The person's own naps and naps shared with them by name. Naps shared with everyone are not
  // listed, but an agent can still read and update one by id.
  if (path === "/naps" && method === "GET") {
    const results = yield* db.all<NapRow>(
      `SELECT ${NAP_COLUMNS} FROM sites
       WHERE lower(created_by_email) = lower(?1)
          OR (visibility = 'selected' AND slug IN (
                SELECT site_slug FROM site_viewers WHERE lower(email) = lower(?1)))
       ORDER BY updated_at DESC LIMIT 500`,
      agent.email,
    );
    return json({ naps: results.map(describe) }, { headers: noStore });
  }

  if (path === "/naps" && method === "POST") {
    const nap = yield* publish(request, url, agent, null);
    return json({ ok: true, ...publishedBody(nap, napUrl) }, { status: 201, headers: noStore });
  }

  // Notifications from the app itself (NapKit's Nap.notify), to everyone else with the app or
  // notifications on: { title, body?, open?, app? }, where app is the app's folder in the
  // launcher, so a tap opens it.
  if (path === "/notify" && method === "GET") {
    return json({ enabled: notificationsOn() }, { headers: noStore });
  }
  if (path === "/notify" && method === "POST") {
    const body = yield* readJsonObject(request);
    const result = yield* sendNotification(
      { kind: "app", app: readAppSlug(body.app), place },
      agent,
      body,
    );
    return json(result, { headers: noStore });
  }
  // A test to the caller's own phones and browsers.
  if (path === "/push/test" && method === "POST") {
    return json(yield* sendTest(agent, place), { headers: noStore });
  }
  // A phone with the app: its APNs device token, so notifications reach it. DELETE turns it off.
  if (path === "/push/devices" && (method === "POST" || method === "DELETE")) {
    const body = yield* readJsonObject(request);
    const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64,200}$/.test(token))
      return yield* failNoStore(400, "Give the APNs device token, in hex");
    if (method === "DELETE") {
      yield* removeTarget(agent.email, token);
      return json({ ok: true }, { headers: noStore });
    }
    if (!notificationsOn()) {
      return yield* failNoStore(404, "Notifications are off on this Nap", {
        code: "notifications_off",
      });
    }
    yield* saveApnsTarget(
      agent.email,
      { token, environment: body.environment === "sandbox" ? "sandbox" : "production" },
      typeof body.label === "string" ? body.label : agent.client,
    );
    return json({ ok: true }, { headers: noStore });
  }

  // Native apps: the source repo, and builds per platform (iOS: signed for TestFlight). See apps.ts.
  if (path === "/apps" || path.startsWith("/apps/")) {
    if (path.match(/^\/apps\/[^/]+\/builds$/) && method === "POST") yield* limitUploads(agent);
    return yield* handleAppsApi(request, url, agent, path.slice("/apps".length));
  }

  // Direct uploads: presigned R2 URLs for large uploads. See direct-uploads.ts.
  if (path === "/uploads" && method === "POST") {
    return yield* startUpload(request, url, agent);
  }
  const commitMatch = path.match(/^\/uploads\/([0-9a-f-]{36})\/commit$/);
  if (commitMatch && method === "POST") {
    const published = yield* commitDirectUpload(agent, commitMatch[1], "agent");
    return json(
      { ok: true, ...publishedBody(published, napUrl) },
      { status: published.created ? 201 : 200, headers: noStore },
    );
  }

  const napMatch = path.match(/^\/naps\/([a-z0-9-]{1,32})(\/.*)?$/);
  if (!napMatch) return yield* failNoStore(404, "Not found");
  const slug = napMatch[1];
  const rest = napMatch[2] ?? "";

  // Agents see what the person can view. Everything else is "not found".
  const nap = yield* db.first<NapRow>(`SELECT ${NAP_COLUMNS} FROM sites WHERE slug = ?`, slug);
  if (!nap || !(yield* canViewSite(nap, agent.email))) return yield* failNoStore(404, "Not found");

  if (rest === "" && method === "GET") return json({ nap: describe(nap) }, { headers: noStore });

  // A nap's collections, live updates, channels, and ICE servers, for clients that cannot pass
  // Access, such as native apps: the same calls as /_nap/data, /_nap/live, /_nap/channel, and
  // /_nap/rtc on the nap's own host, as the token's person. WebSockets send the token in the Authorization
  // header. Like artifact frames, these requests do not count as using Nap.
  if (rest.startsWith("/data/")) {
    return yield* handleSiteDataRequest(nap.slug, request, rest.slice("/data/".length), {
      frameIdentity: agent,
      onChange: (collection, change) => publishChange(nap.slug, collection, change),
    });
  }
  if (rest === "/live") return yield* handleLiveRequest(nap.slug, request, agent);
  if (rest.startsWith("/channel/")) {
    return yield* handleChannelRequest(nap.slug, rest.slice("/channel/".length), request, agent);
  }
  if (rest === "/rtc") return yield* handleRtcRequest(nap.slug, request, agent);
  // The rest of what a page can do, for NapKit: nap.fetch, extensions, and nap.notify.
  if (rest === "/fetch") {
    return yield* handleSiteFetch(nap.slug, request, agent.email, {
      frame: nap.kind === "artifact",
    });
  }
  if (rest.startsWith("/ext/")) {
    return yield* handleExtensionRequest(
      EXTENSIONS,
      nap.slug,
      request,
      agent,
      rest.slice("/ext/".length),
      {
        frame: nap.kind === "artifact",
      },
    );
  }
  if (rest === "/notify") {
    return yield* handleNotifyRequest(nap.slug, request, agent, place, { token: true });
  }

  if (rest === "/versions" && method === "POST") {
    const published = yield* publish(request, url, agent, nap.slug);
    return json({ ok: true, ...publishedBody(published, napUrl) }, { headers: noStore });
  }

  if (rest === "/versions" && method === "GET") {
    return json({ versions: yield* listVersions(nap.slug) }, { headers: noStore });
  }

  if (rest === "/restore" && method === "POST") {
    const params = yield* readParams(request, url);
    return yield* restoreVersion(
      agent.email,
      nap.slug,
      {
        version: params.version,
        expectedCurrentVersion: params.expectedCurrentVersion ?? params.expected_version,
      },
      { requireExpectedVersion: true },
    );
  }

  // Source repo: GET describes it, POST creates it (owner only), POST /token gives Git access.
  if (rest === "/source" && method === "GET") {
    return json({ source: yield* describeSource(nap) }, { headers: noStore });
  }
  if (rest === "/source" && method === "POST") {
    if (nap.kind !== "site") {
      return yield* failNoStore(
        400,
        "Only sites have source repos. The owner can move an artifact to Sites.",
      );
    }
    if (!isSameEmail(nap.createdByEmail, agent.email)) {
      return yield* failNoStore(
        403,
        `Only the owner (${nap.createdByEmail}) can add a source repo`,
      );
    }
    if (nap.sourceRepo) {
      return yield* failNoStore(409, "This site already has a source repo", {
        code: "source_exists",
      });
    }
    const created = yield* createSource(nap);
    yield* logSourceAccess(agent, nap.slug, created.repo, "create");
    return json(
      {
        source: created,
        next: `Push the source to ${SOURCE_BRANCH}, build it, and publish with sourceCommit set to the pushed commit.`,
      },
      { status: 201, headers: noStore },
    );
  }
  if (rest === "/source/token" && method === "POST") {
    if (!nap.sourceRepo) {
      return yield* failNoStore(404, "This nap has no source repo", { code: "no_source_repo" });
    }
    const params = yield* readParams(request, url);
    const scope = params.access ?? "write";
    if (scope !== "read" && scope !== "write") {
      return yield* failNoStore(400, 'access must be "read" or "write"');
    }
    // Anyone who can publish a version may push. Publishing still checks the commit.
    const access = yield* mintSourceToken(nap.sourceRepo, scope);
    yield* logSourceAccess(agent, nap.slug, access.repo, scope);
    return json({ source: access }, { headers: noStore });
  }

  if (rest === "/comments" || rest.startsWith("/comments/")) {
    if (nap.kind !== "artifact") return yield* failNoStore(404, "Only artifacts have comments");
    return yield* handleComments(
      nap.slug,
      { email: agent.email, client: agent.client },
      request,
      rest.slice("/comments".length),
    );
  }

  if ((rest === "/files" || rest.startsWith("/files/")) && method === "GET") {
    const version = url.searchParams.get("version") || nap.currentVersion;
    const known = yield* db.first(
      "SELECT 1 FROM versions WHERE id = ? AND site_slug = ?",
      version,
      nap.slug,
    );
    if (!known) return yield* failNoStore(404, "Version not found");

    if (rest === "/files") return yield* listFiles(nap.slug, version);
    const filePath = normalizePath(decodeURIComponent(rest.slice("/files/".length)));
    if (!isSafePath(filePath)) return yield* fail(400, "Bad path");
    const storage = yield* Storage;
    const object = yield* storage.get(objectKey(nap.slug, version, filePath));
    if (!object) return yield* failNoStore(404, "File not found");
    const headers = new Headers(noStore);
    object.writeHttpMetadata(headers);
    headers.set("x-content-type-options", "nosniff");
    // Never let a browser run an uploaded page on the dashboard origin.
    headers.set("content-security-policy", "sandbox");
    return new Response(object.body, { headers });
  }

  return yield* failNoStore(404, "Not found");
});

const publish = Effect.fnUntraced(function* (
  request: Request,
  url: URL,
  agent: AgentIdentity,
  targetSlug: string | null,
) {
  yield* limitUploads(agent);
  yield* rejectLargeBody(request);

  const { files, fields } = yield* readUpload(request, url, [
    "title",
    "slug",
    "kind",
    "message",
    "expectedVersion",
    "access",
    "emails",
    "sourceCommit",
  ]);

  const access = yield* parseAccess(fields.access, fields.emails, targetSlug);
  const { kind, slug } = yield* napShape(fields.kind, fields.slug, targetSlug);

  return yield* publishFiles(agent, {
    files,
    targetSlug,
    requireExpectedVersion: true,
    expectedCurrentVersion: fields.expectedVersion || null,
    kind,
    slug: targetSlug ? "" : slug,
    title: fields.title,
    access: access ?? undefined,
    source: "agent",
    client: agent.client,
    message: fields.message,
    sourceCommit: fields.sourceCommit || null,
  });
});

/** The kind and URL of a new nap. A slug makes a site. */
const napShape = Effect.fnUntraced(function* (
  rawKind: string,
  rawSlug: string,
  targetSlug: string | null,
) {
  if (rawKind && rawKind !== "site" && rawKind !== "artifact") {
    return yield* failNoStore(400, 'kind must be "artifact" or "site"');
  }
  const slug = slugify(rawSlug);
  const kind: NapKind = rawKind === "site" || (!rawKind && slug) ? "site" : "artifact";
  if (!targetSlug && slug && kind === "artifact") {
    return yield* failNoStore(
      400,
      "A slug gives a nap its own host, which makes it a site. Leave out slug for an artifact.",
    );
  }
  return { kind, slug };
});

const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * POST /_nap/api/uploads with JSON:
 * { files: [{ path, size, type? }], title?, kind?, slug?, access?, emails?, id?, expectedVersion?,
 *   message?, sourceCommit? }
 * With id, a new version of that nap. Returns presigned PUT URLs and the commit URL.
 */
const startUpload = Effect.fnUntraced(function* (request: Request, url: URL, agent: AgentIdentity) {
  yield* limitUploads(agent);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return yield* failNoStore(415, "Send JSON");
  }
  const text = yield* Effect.promise(() => request.text());
  if (text.length > MAX_MANIFEST_BYTES) {
    return yield* failNoStore(413, "The file list is too large");
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return yield* failNoStore(400, "Invalid JSON");
  }
  const field = (name: string) => (Predicate.isString(body[name]) ? body[name] : "");
  const emails = Array.isArray(body.emails) ? body.emails.join(",") : field("emails");

  const targetSlug = slugify(field("id")) || null;
  const access = yield* parseAccess(field("access"), emails, targetSlug);
  const shape = yield* napShape(field("kind"), field("slug"), targetSlug);

  const started = yield* startDirectUpload(agent, {
    files: body.files,
    targetSlug,
    requireExpectedVersion: true,
    expectedCurrentVersion: field("expectedVersion") || null,
    kind: shape.kind,
    slug: targetSlug ? "" : shape.slug,
    title: field("title"),
    access,
    source: "agent",
    client: agent.client,
    message: field("message"),
    sourceCommit: field("sourceCommit") || null,
    createSource: body.createSource === true,
  });
  const data = (yield* Effect.promise(() => started.json())) as {
    uploadId: string;
    id: string;
    source?: { repo: string; branch: string };
  };
  if (data.source) yield* logSourceAccess(agent, data.id, data.source.repo, "create");
  return json(
    {
      ...data,
      commitUrl: `${url.origin}${PREFIX}/uploads/${data.uploadId}/commit`,
      next: data.source
        ? `Push sourceCommit to ${data.source.branch} of source.remote with source.token, PUT each file to its url with its headers, then POST to commitUrl.`
        : "PUT each file to its url with its headers, then POST to commitUrl.",
    },
    { status: 201, headers: noStore },
  );
});

/**
 * Access for a new nap: "private", "everyone" (everyone at the organisation), or
 * "selected" with comma-separated emails. Updates keep the access the owner chose.
 */
function parseAccess(
  rawAccess: string,
  rawEmails: string,
  targetSlug: string | null,
): Effect.Effect<{ visibility: Visibility; emails: Array<string> } | null, HttpError> {
  if (!rawAccess && !rawEmails) return Effect.succeed(null);
  if (targetSlug) {
    return failNoStore(
      400,
      "access can only be set when you create a nap. The owner changes it in Nap.",
    );
  }
  const visibility = rawAccess || DEFAULT_ACCESS;
  if (!isVisibility(visibility)) {
    return failNoStore(400, 'access must be "private", "everyone", or "selected"');
  }
  if (visibility !== "selected") {
    if (rawEmails) return failNoStore(400, 'emails only works with access="selected"');
    return Effect.succeed({ visibility, emails: [] });
  }
  const parts = rawEmails
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const emails = [...new Set(parts.map(normalizeEmail))];
  if (emails.length === 0 || emails.includes("")) {
    return failNoStore(
      400,
      'access="selected" needs emails: a comma-separated list of valid addresses',
    );
  }
  return Effect.succeed({ visibility, emails });
}

function publishedBody(
  nap: PublishedNap,
  napUrl: (nap: { slug: string; kind: NapKind }) => string,
) {
  return {
    id: nap.slug,
    kind: nap.kind,
    title: nap.title,
    url: napUrl(nap),
    version: nap.currentVersion,
    previousVersion: nap.previousVersion,
    created: nap.created,
    access: nap.visibility,
    message: nap.created
      ? `Published. ${ACCESS_NOTES[nap.visibility]} Update it with POST /_nap/api/naps/${nap.slug}/versions.`
      : `New version is live. ${ACCESS_NOTES[nap.visibility]}`,
  };
}

const ACCESS_NOTES: Record<Visibility, string> = {
  private:
    "Only the owner can see it. Tell the user to share it with the Share button on the page before they send the link to anyone.",
  selected: "The owner and the people they invited can see it and publish new versions.",
  everyone: `${EVERYONE_LABEL} can see it and publish new versions.`,
};

const listFiles = Effect.fnUntraced(function* (slug: string, version: string) {
  const storage = yield* Storage;
  const prefix = objectKey(slug, version, "");
  const files = (yield* storage.list(prefix)).map((item) => ({
    path: item.key.slice(prefix.length),
    size: item.size,
  }));
  return json({ version, files }, { headers: noStore });
});

/** An audit line for each Git token. Never logs the token. */
const logSourceAccess = (agent: AgentIdentity, slug: string, repo: string, action: string) =>
  Effect.logInfo("Source repo access").pipe(
    Effect.annotateLogs({
      action,
      slug,
      repo,
      email: agent.email,
      client: agent.client,
      tokenId: agent.tokenId,
    }),
  );
