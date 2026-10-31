import publishScript from "~/content/publish.mjs?raw";
import skill from "../../skills/nap/SKILL.md?raw";
import { napConfig } from "~/nap.config";
import { agentInstructionsFor } from "~/lib/agent-instructions";
import { DEFAULT_ACCESS, EVERYONE_LABEL, fillDeploymentText } from "~/lib/deployment-text";
import {
  authenticateAgent,
  exchangeDeviceCode,
  readParams,
  startDeviceLogin,
  type AgentIdentity,
} from "~/lib/agent-auth";
import { handleComments } from "~/lib/comments";
import { commitDirectUpload, startDirectUpload, type DirectUploadEnv } from "~/lib/direct-uploads";
import { json, objectKey, slugify } from "~/lib/nap-server";
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
import { handleAppsApi, type AppsEnv } from "~/lib/apps";
import { handleSiteDataRequest } from "~/lib/site-data";
import { handleLiveRequest, publishChange, type SiteLive } from "~/lib/site-live";
import { handleChannelRequest, type SiteChannel } from "~/lib/site-channel";

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

type AgentEnv = DirectUploadEnv &
  AppsEnv & {
    DRAFT_LIMITER?: RateLimit;
    SOURCES?: unknown;
    LIVE?: DurableObjectNamespace<SiteLive>;
    CHANNELS?: DurableObjectNamespace<SiteChannel>;
  };

const PREFIX = "/_nap/api";
const noStore = { "cache-control": "no-store" };

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

export async function handleAgentApi(
  env: AgentEnv,
  request: Request,
  rootDomain: string,
  ctx?: ExecutionContext,
) {
  const url = new URL(request.url);
  const path = url.pathname.slice(PREFIX.length).replace(/\/+$/, "") || "/";
  const method = request.method;

  const topic = /^\/instructions(?:\/([a-z]+))?$/.exec(path);
  if (topic && method === "GET") {
    const text = agentInstructionsFor(rootDomain, topic[1] ?? "index");
    if (text === null) return json({ error: "No such topic" }, { status: 404, headers: noStore });
    return new Response(text, {
      headers: { "content-type": "text/markdown; charset=utf-8", ...noStore },
    });
  }
  // The agent skill (skills/nap/SKILL.md), for installing without GitHub.
  if (path === "/skill" && method === "GET") {
    return new Response(skill, {
      headers: { "content-type": "text/markdown; charset=utf-8", ...noStore },
    });
  }
  if (path === "/publish.mjs" && method === "GET") {
    return new Response(fillDeploymentText(publishScript, { ...napConfig, rootDomain }), {
      headers: { "content-type": "text/javascript; charset=utf-8", ...noStore },
    });
  }
  if (path === "/auth/device") return startDeviceLogin(env, request, url);
  if (path === "/auth/token") return exchangeDeviceCode(env, request, url);

  const agent = await authenticateAgent(env.DB, request);
  if (agent instanceof Response) return agent;

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
    return json(
      { email: agent.email, name: agent.name, client: agent.client },
      { headers: noStore },
    );
  }

  // The person's own naps and naps shared with them by name. Naps shared with everyone are not
  // listed, but an agent can still read and update one by id.
  if (path === "/naps" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT ${NAP_COLUMNS} FROM sites
       WHERE lower(created_by_email) = lower(?1)
          OR (visibility = 'selected' AND slug IN (
                SELECT site_slug FROM site_viewers WHERE lower(email) = lower(?1)))
       ORDER BY updated_at DESC LIMIT 500`,
    )
      .bind(agent.email)
      .all<NapRow>();
    return json({ naps: results.map(describe) }, { headers: noStore });
  }

  if (path === "/naps" && method === "POST") {
    return publish(env, request, url, agent, null, (nap) =>
      json({ ok: true, ...publishedBody(nap, napUrl) }, { status: 201, headers: noStore }),
    );
  }

  // Native apps: source repos, unsigned builds that Nap signs, install links. See apps.ts.
  if (path === "/apps" || path.startsWith("/apps/")) {
    if (path.match(/^\/apps\/[^/]+\/builds$/) && method === "POST" && env.DRAFT_LIMITER) {
      const { success } = await env.DRAFT_LIMITER.limit({ key: `token:${agent.tokenId}` });
      if (!success) return json({ error: "Too many uploads. Wait a minute." }, { status: 429 });
    }
    return handleAppsApi(env, request, url, agent, path.slice("/apps".length));
  }

  // Direct uploads: presigned R2 URLs for large uploads. See direct-uploads.ts.
  if (path === "/uploads" && method === "POST") {
    return startUpload(env, request, url, agent);
  }
  const commitMatch = path.match(/^\/uploads\/([0-9a-f-]{36})\/commit$/);
  if (commitMatch && method === "POST") {
    const published = await commitDirectUpload(env, agent, commitMatch[1], "agent");
    if (published instanceof Response) return published;
    return json(
      { ok: true, ...publishedBody(published, napUrl) },
      { status: published.created ? 201 : 200, headers: noStore },
    );
  }

  const napMatch = path.match(/^\/naps\/([a-z0-9-]{1,32})(\/.*)?$/);
  if (!napMatch) return json({ error: "Not found" }, { status: 404, headers: noStore });
  const slug = napMatch[1];
  const rest = napMatch[2] ?? "";

  // Agents see what the person can view. Everything else is "not found".
  const nap = await env.DB.prepare(`SELECT ${NAP_COLUMNS} FROM sites WHERE slug = ?`)
    .bind(slug)
    .first<NapRow>();
  if (!nap || !(await canViewSite(env.DB, nap, agent.email))) {
    return json({ error: "Not found" }, { status: 404, headers: noStore });
  }

  if (rest === "" && method === "GET") return json({ nap: describe(nap) }, { headers: noStore });

  // A nap's collections, live updates, and channels, for clients that cannot pass Access, such
  // as native apps: the same calls as /_nap/data, /_nap/live, and /_nap/channel on the
  // nap's own host, as the token's person. WebSockets send the token in the Authorization
  // header. Like artifact frames, these requests do not count as using Nap.
  if (rest.startsWith("/data/")) {
    return handleSiteDataRequest(env, nap.slug, request, rest.slice("/data/".length), {
      frameIdentity: agent,
      onChange: (collection, change) =>
        publishChange(env, ctx && ((p) => ctx.waitUntil(p)), nap.slug, collection, change),
    });
  }
  if (rest === "/live") return handleLiveRequest(env, nap.slug, request, agent);
  if (rest.startsWith("/channel/")) {
    return handleChannelRequest(env, nap.slug, rest.slice("/channel/".length), request, agent);
  }

  if (rest === "/versions" && method === "POST") {
    return publish(env, request, url, agent, nap.slug, (published) =>
      json({ ok: true, ...publishedBody(published, napUrl) }, { headers: noStore }),
    );
  }

  if (rest === "/versions" && method === "GET") {
    const versions = await listVersions(env.DB, nap.slug);
    return json({ versions }, { headers: noStore });
  }

  if (rest === "/restore" && method === "POST") {
    const params = await readParams(request, url);
    return restoreVersion(
      env.DB,
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
    const source = await describeSource(env, nap);
    return source instanceof Response ? source : json({ source }, { headers: noStore });
  }
  if (rest === "/source" && method === "POST") {
    if (nap.kind !== "site") {
      return json(
        { error: "Only sites have source repos. The owner can move an artifact to Sites." },
        { status: 400, headers: noStore },
      );
    }
    if (!isSameEmail(nap.createdByEmail, agent.email)) {
      return json(
        { error: `Only the owner (${nap.createdByEmail}) can add a source repo` },
        { status: 403, headers: noStore },
      );
    }
    if (nap.sourceRepo) {
      return json(
        { error: "This site already has a source repo", code: "source_exists" },
        { status: 409, headers: noStore },
      );
    }
    const created = await createSource(env, nap);
    if (created instanceof Response) return created;
    logSourceAccess(agent, nap.slug, created.repo, "create");
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
      return json(
        { error: "This nap has no source repo", code: "no_source_repo" },
        { status: 404, headers: noStore },
      );
    }
    const params = await readParams(request, url);
    const scope = params.access ?? "write";
    if (scope !== "read" && scope !== "write") {
      return json({ error: 'access must be "read" or "write"' }, { status: 400, headers: noStore });
    }
    // Anyone who can publish a version may push. Publishing still checks the commit.
    const access = await mintSourceToken(env, nap.sourceRepo, scope);
    if (access instanceof Response) return access;
    logSourceAccess(agent, nap.slug, access.repo, scope);
    return json({ source: access }, { headers: noStore });
  }

  if (rest === "/comments" || rest.startsWith("/comments/")) {
    if (nap.kind !== "artifact") {
      return json({ error: "Only artifacts have comments" }, { status: 404, headers: noStore });
    }
    return handleComments(
      env.DB,
      nap.slug,
      { email: agent.email, client: agent.client },
      request,
      rest.slice("/comments".length),
    );
  }

  if ((rest === "/files" || rest.startsWith("/files/")) && method === "GET") {
    const version = url.searchParams.get("version") || nap.currentVersion;
    const known = await env.DB.prepare("SELECT 1 FROM versions WHERE id = ? AND site_slug = ?")
      .bind(version, nap.slug)
      .first();
    if (!known) return json({ error: "Version not found" }, { status: 404, headers: noStore });

    if (rest === "/files") return listFiles(env.SITES, nap.slug, version);
    const filePath = normalizePath(decodeURIComponent(rest.slice("/files/".length)));
    if (!isSafePath(filePath)) return json({ error: "Bad path" }, { status: 400 });
    const object = await env.SITES.get(objectKey(nap.slug, version, filePath));
    if (!object) return json({ error: "File not found" }, { status: 404, headers: noStore });
    const headers = new Headers(noStore);
    object.writeHttpMetadata(headers);
    headers.set("x-content-type-options", "nosniff");
    // Never let a browser run an uploaded page on the dashboard origin.
    headers.set("content-security-policy", "sandbox");
    return new Response(object.body, { headers });
  }

  return json({ error: "Not found" }, { status: 404, headers: noStore });
}

async function publish(
  env: AgentEnv,
  request: Request,
  url: URL,
  agent: AgentIdentity,
  targetSlug: string | null,
  respond: (nap: PublishedNap) => Response,
) {
  if (env.DRAFT_LIMITER) {
    const { success } = await env.DRAFT_LIMITER.limit({ key: `token:${agent.tokenId}` });
    if (!success) return json({ error: "Too many uploads. Wait a minute." }, { status: 429 });
  }
  const tooLarge = rejectLargeBody(request);
  if (tooLarge) return tooLarge;

  const parsed = await readUpload(request, url, [
    "title",
    "slug",
    "kind",
    "message",
    "expectedVersion",
    "access",
    "emails",
    "sourceCommit",
  ]);
  if (parsed instanceof Response) return parsed;
  const { files, fields } = parsed;

  const access = parseAccess(fields.access, fields.emails, targetSlug);
  if (access instanceof Response) return access;
  const shape = napShape(fields.kind, fields.slug, targetSlug);
  if (shape instanceof Response) return shape;
  const { kind, slug } = shape;

  const published = await publishFiles(env, agent, {
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
  if (published instanceof Response) return published;
  return respond(published);
}

/** The kind and URL of a new nap. A slug makes a site. */
function napShape(rawKind: string, rawSlug: string, targetSlug: string | null) {
  if (rawKind && rawKind !== "site" && rawKind !== "artifact") {
    return json({ error: 'kind must be "artifact" or "site"' }, { status: 400, headers: noStore });
  }
  const slug = slugify(rawSlug);
  const kind: NapKind = rawKind === "site" || (!rawKind && slug) ? "site" : "artifact";
  if (!targetSlug && slug && kind === "artifact") {
    return json(
      {
        error:
          "A slug gives a nap its own host, which makes it a site. Leave out slug for an artifact.",
      },
      { status: 400, headers: noStore },
    );
  }
  return { kind, slug };
}

const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * POST /_nap/api/uploads with JSON:
 * { files: [{ path, size, type? }], title?, kind?, slug?, access?, emails?, id?, expectedVersion?,
 *   message?, sourceCommit? }
 * With id, a new version of that nap. Returns presigned PUT URLs and the commit URL.
 */
async function startUpload(env: AgentEnv, request: Request, url: URL, agent: AgentIdentity) {
  if (env.DRAFT_LIMITER) {
    const { success } = await env.DRAFT_LIMITER.limit({ key: `token:${agent.tokenId}` });
    if (!success) return json({ error: "Too many uploads. Wait a minute." }, { status: 429 });
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "Send JSON" }, { status: 415, headers: noStore });
  }
  const text = await request.text();
  if (text.length > MAX_MANIFEST_BYTES) {
    return json({ error: "The file list is too large" }, { status: 413, headers: noStore });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400, headers: noStore });
  }
  const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
  const emails = Array.isArray(body.emails) ? body.emails.join(",") : field("emails");

  const targetSlug = slugify(field("id")) || null;
  const access = parseAccess(field("access"), emails, targetSlug);
  if (access instanceof Response) return access;
  const shape = napShape(field("kind"), field("slug"), targetSlug);
  if (shape instanceof Response) return shape;

  const started = await startDirectUpload(env, agent, {
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
  if (!started.ok) return started;
  const data = (await started.json()) as {
    uploadId: string;
    id: string;
    source?: { repo: string; branch: string };
  };
  if (data.source) logSourceAccess(agent, data.id, data.source.repo, "create");
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
}

/**
 * Access for a new nap: "private", "everyone" (everyone at the organisation), or
 * "selected" with comma-separated emails. Updates keep the access the owner chose.
 */
function parseAccess(
  rawAccess: string,
  rawEmails: string,
  targetSlug: string | null,
): Response | { visibility: Visibility; emails: Array<string> } | null {
  if (!rawAccess && !rawEmails) return null;
  if (targetSlug) {
    return json(
      { error: "access can only be set when you create a nap. The owner changes it in Nap." },
      { status: 400, headers: noStore },
    );
  }
  const visibility = rawAccess || DEFAULT_ACCESS;
  if (!isVisibility(visibility)) {
    return json(
      { error: 'access must be "private", "everyone", or "selected"' },
      { status: 400, headers: noStore },
    );
  }
  if (visibility !== "selected") {
    if (rawEmails) {
      return json(
        { error: 'emails only works with access="selected"' },
        { status: 400, headers: noStore },
      );
    }
    return { visibility, emails: [] };
  }
  const parts = rawEmails
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  const emails = [...new Set(parts.map(normalizeEmail))];
  if (emails.length === 0 || emails.includes("")) {
    return json(
      { error: 'access="selected" needs emails: a comma-separated list of valid addresses' },
      { status: 400, headers: noStore },
    );
  }
  return { visibility, emails };
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

async function listFiles(bucket: R2Bucket, slug: string, version: string) {
  const prefix = objectKey(slug, version, "");
  const files: Array<{ path: string; size: number }> = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const item of listed.objects) {
      files.push({ path: item.key.slice(prefix.length), size: item.size });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return json({ version, files }, { headers: noStore });
}

/** An audit line for each Git token. Never logs the token. */
function logSourceAccess(agent: AgentIdentity, slug: string, repo: string, action: string) {
  console.log(
    JSON.stringify({
      message: "Source repo access",
      action,
      slug,
      repo,
      email: agent.email,
      client: agent.client,
      tokenId: agent.tokenId,
    }),
  );
}
