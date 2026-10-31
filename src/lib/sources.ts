/**
 * Source repos: a site's source in a Cloudflare Artifacts repo, one repo per site.
 *
 * Nap never runs Git. Agents clone and push with plain Git over HTTPS, using short-lived tokens
 * scoped to one repo that Nap mints after it checks the agent's Nap token. Agents build locally
 * and publish the static output as usual, naming the commit they built. Nap accepts that build
 * only if the commit is the head of the repo's main branch and contains the live version's commit,
 * so the live site always matches the source and nobody publishes over work they have not pulled.
 * A force-push that drops published commits therefore cannot go live.
 */

export const SOURCE_BRANCH = "main";
/** Token lifetime. Long enough to clone, build, and push; agents ask again when it runs out. */
export const SOURCE_TOKEN_TTL_SECONDS = 15 * 60;
/** How far back the ancestry check walks before it gives up. */
const MAX_ANCESTRY_COMMITS = 2000;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The parts of the Artifacts binding Nap uses. workers-types lags behind the runtime here: a repo
 * handle has no metadata properties at runtime, only info().
 */
export type SourceCommit = { hash: string; parents: Array<string>; message?: string };
export type SourceRepo = {
  info(): Promise<{ name: string; remote: string; defaultBranch: string }>;
  createToken(
    scope?: "read" | "write",
    ttl?: number,
  ): Promise<{ plaintext: string; expiresAt: string }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  log(options?: { ref?: string; limit?: number; offset?: number }): Promise<Array<SourceCommit>>;
  readCommit(hash: string): Promise<SourceCommit | null>;
  [Symbol.dispose]?: () => void;
};
export type SourceNamespace = {
  create(
    name: string,
    options?: { description?: string; setDefaultBranch?: string },
  ): Promise<{ name: string; remote: string; token: string }>;
  get(name: string): Promise<SourceRepo>;
  delete(name: string): Promise<boolean>;
};

export type SourceEnv = { DB: D1Database; SOURCES?: unknown };

export type SourceAccess = {
  repo: string;
  remote: string;
  branch: string;
  scope: "read" | "write";
  token: string;
  expiresAt: string;
};

const noStore = { "cache-control": "no-store" };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, ...extra }, { status, headers: noStore });

function namespace(env: SourceEnv): SourceNamespace | null {
  return (env.SOURCES as SourceNamespace | undefined) ?? null;
}

const unavailable = () =>
  fail(503, "Source repos are not set up on this Nap", { code: "sources_unavailable" });

export const isCommitHash = (value: string) => COMMIT.test(value);

async function withRepo<T>(
  ns: SourceNamespace,
  name: string,
  use: (repo: SourceRepo) => Promise<T>,
) {
  const repo = await ns.get(name);
  try {
    return await use(repo);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

/** The head commit of main, or null for a repo nobody has pushed to. */
export async function headCommit(repo: SourceRepo) {
  const [head] = await repo.log({ ref: SOURCE_BRANCH, limit: 1 });
  return head?.hash ?? null;
}

/**
 * Whether `ancestor` is in the history of `head` (or is `head`). Checks the first-parent line in
 * one call, then walks every parent, so merges count too.
 */
export async function isAncestor(repo: SourceRepo, ancestor: string, head: string) {
  if (ancestor === head) return true;
  const line = await repo.log({ ref: head, limit: 1000 });
  if (line.some((commit) => commit.hash === ancestor)) return true;
  const seen = new Set<string>();
  const queue = [head];
  while (queue.length > 0 && seen.size < MAX_ANCESTRY_COMMITS) {
    const hash = queue.shift()!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (hash === ancestor) return true;
    const commit = await repo.readCommit(hash);
    if (commit) queue.push(...commit.parents.filter((parent) => !seen.has(parent)));
  }
  return false;
}

/**
 * Checks the commit a new version says it was built from.
 * - A site without a source repo takes no commit.
 * - A site with one needs the head of main, and that commit must contain the live one.
 * Returns null when the version may go live, or the error response.
 */
export async function checkSourceCommit(
  env: SourceEnv,
  /** currentVersion is null for a new site whose repo was created with its first upload. */
  site: { slug: string; sourceRepo: string | null; currentVersion: string | null } | null,
  sourceCommit: string | null | undefined,
): Promise<Response | null> {
  const commit = (sourceCommit ?? "").trim().toLowerCase();
  if (!site?.sourceRepo) {
    if (!commit) return null;
    return fail(400, "sourceCommit only works for a site with a source repo", {
      code: "no_source_repo",
    });
  }
  if (!commit) {
    return fail(
      409,
      `This site's source is in a Nap source repo. Push your change to its ${SOURCE_BRANCH} branch, build that commit, and publish with sourceCommit set to it. Upload in the dashboard is off for this site.`,
      { code: "source_commit_required" },
    );
  }
  const live = site.currentVersion
    ? await env.DB.prepare("SELECT source_commit AS commitHash FROM versions WHERE id = ?")
        .bind(site.currentVersion)
        .first<{ commitHash: string | null }>()
    : null;
  return checkRepoCommit(env, site.sourceRepo, commit, live?.commitHash ?? null);
}

/**
 * The commit rules, for any repo: `commit` must be the head of main and contain `liveCommit`, the
 * commit of whatever is live now. Sites pass their live version's commit; apps pass the live
 * build's commit of the target being published. Returns null when the commit may go live.
 */
export async function checkRepoCommit(
  env: SourceEnv,
  repoName: string,
  commit: string,
  liveCommit: string | null,
): Promise<Response | null> {
  if (!isCommitHash(commit)) {
    return fail(400, "sourceCommit must be a full 40-character commit hash", {
      code: "invalid_source_commit",
    });
  }
  const ns = namespace(env);
  if (!ns) return unavailable();
  return withRepo(ns, repoName, async (repo) => {
    const head = await headCommit(repo);
    if (head !== commit) {
      return fail(
        409,
        head
          ? `${commit.slice(0, 7)} is not the head of ${SOURCE_BRANCH} (${head.slice(0, 7)}). Push it first. If someone else pushed, pull, merge, build again, and publish the new head.`
          : `Nothing is pushed to ${SOURCE_BRANCH} yet. Push first.`,
        { code: "source_not_head", head },
      );
    }
    if (liveCommit && !(await isAncestor(repo, liveCommit, commit))) {
      return fail(
        409,
        `The live version was built from ${liveCommit.slice(0, 7)}, which is not in the history of ${commit.slice(0, 7)}. A force-push dropped published work. Get it back into ${SOURCE_BRANCH} (fetch that commit and merge it), then publish again.`,
        { code: "source_not_descendant", liveCommit },
      );
    }
    return null;
  });
}

/** Whether a repo's main contains `liveCommit`: for a build that went live while another signed. */
export async function containsCommit(
  env: SourceEnv,
  repoName: string,
  commit: string,
  liveCommit: string,
) {
  const ns = namespace(env);
  if (!ns) return false;
  return withRepo(ns, repoName, (repo) => isAncestor(repo, liveCommit, commit));
}

/** A repo's remote and the head of main. */
export async function repoHead(env: SourceEnv, repoName: string) {
  const ns = namespace(env);
  if (!ns) return unavailable();
  return withRepo(ns, repoName, async (repo) => ({
    repo: repoName,
    remote: (await repo.info()).remote,
    branch: SOURCE_BRANCH,
    head: await headCommit(repo),
  }));
}

/** The repo, its main head, and the commit of the live version. */
export async function describeSource(
  env: SourceEnv,
  site: { sourceRepo: string | null; currentVersion: string },
) {
  if (!site.sourceRepo) return fail(404, "This nap has no source repo", { code: "no_source_repo" });
  const ns = namespace(env);
  if (!ns) return unavailable();
  const live = await env.DB.prepare("SELECT source_commit AS commitHash FROM versions WHERE id = ?")
    .bind(site.currentVersion)
    .first<{ commitHash: string | null }>();
  const repoName = site.sourceRepo;
  const { remote, head } = await withRepo(ns, repoName, async (repo) => ({
    remote: (await repo.info()).remote,
    head: await headCommit(repo),
  }));
  return {
    repo: repoName,
    remote,
    branch: SOURCE_BRANCH,
    head,
    liveCommit: live?.commitHash ?? null,
    inSync: head !== null && head === (live?.commitHash ?? null),
  };
}

/** A short-lived token for one repo. Read clones and fetches; write also pushes. */
export async function mintSourceToken(
  env: SourceEnv,
  repoName: string,
  scope: "read" | "write",
): Promise<Response | SourceAccess> {
  const ns = namespace(env);
  if (!ns) return unavailable();
  return withRepo(ns, repoName, async (repo) => {
    const [info, token] = await Promise.all([
      repo.info(),
      repo.createToken(scope, SOURCE_TOKEN_TTL_SECONDS),
    ]);
    return {
      repo: repoName,
      remote: info.remote,
      branch: SOURCE_BRANCH,
      scope,
      token: token.plaintext,
      expiresAt: token.expiresAt,
    };
  });
}

/**
 * Creates the source repo for a site and returns a write token for the first push. The repo is
 * named after the site; a suffix is added when an old repo has that name.
 */
export async function createSource(
  env: SourceEnv,
  site: { slug: string; title: string },
): Promise<Response | SourceAccess> {
  const ns = namespace(env);
  if (!ns) return unavailable();
  const created = await createRepo(ns, site);
  if (created instanceof Response) return created;
  const stored = await env.DB.prepare(
    "UPDATE sites SET source_repo = ? WHERE slug = ? AND source_repo IS NULL",
  )
    .bind(created, site.slug)
    .run();
  if (stored.meta.changes !== 1) {
    // Another request added a repo first. Drop this empty one.
    await ns.delete(created).catch(() => false);
    return fail(409, "This nap already has a source repo", { code: "source_exists" });
  }
  return mintSourceToken(env, created, "write");
}

/**
 * Creates the source repo for a site that does not exist yet: its first upload holds the URL.
 * The upload records the repo, and the site gets it when the upload is committed. Returns a
 * write token for the first push.
 */
export async function createUploadSource(
  env: SourceEnv,
  site: { slug: string; title: string },
): Promise<Response | SourceAccess> {
  const ns = namespace(env);
  if (!ns) return unavailable();
  const created = await createRepo(ns, site);
  if (created instanceof Response) return created;
  return mintSourceToken(env, created, "write");
}

/** Creates an empty repo for something other than a site (an app). Returns its name. */
export async function createNamedRepo(
  env: SourceEnv,
  name: string,
  description: string,
): Promise<Response | string> {
  const ns = namespace(env);
  if (!ns) return unavailable();
  return createRepo(ns, { slug: name, title: description });
}

/** Deletes a repo that no site uses, such as the repo of an upload that never went live. */
export async function deleteSourceRepo(env: SourceEnv, name: string) {
  const ns = namespace(env);
  if (ns) await ns.delete(name).catch(() => false);
}

/** Creates an empty repo named after the site and returns its name. */
async function createRepo(
  ns: SourceNamespace,
  site: { slug: string; title: string },
): Promise<Response | string> {
  let created: { name: string; token: string } | null = null;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    const name = attempt === 0 ? site.slug : `${site.slug}-${randomSuffix()}`;
    try {
      created = await ns.create(name, {
        description: site.title.slice(0, 200),
        setDefaultBranch: SOURCE_BRANCH,
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
    }
  }
  if (!created) return fail(409, "Could not pick a free repo name. Try again.");

  // The token from create() lasts a day. Hand out a short one instead.
  const { name, token } = created;
  await withRepo(ns, name, (repo) => repo.revokeToken(token)).catch(() => false);
  return name;
}

function randomSuffix() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes]
    .map((byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 6);
}
