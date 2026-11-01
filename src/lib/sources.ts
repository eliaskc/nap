import { Effect, Predicate, Schema } from "effect";
import { SourceNamespaceBinding, type SourceNamespace, type SourceRepo } from "~/server/bindings";
import { Database } from "~/server/database";
import { failNoStore } from "~/server/http";

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

export type { SourceCommit, SourceNamespace, SourceRepo } from "~/server/bindings";

export type SourceAccess = {
  repo: string;
  remote: string;
  branch: string;
  scope: "read" | "write";
  token: string;
  expiresAt: string;
};

/** A call to the Artifacts binding failed. `code` is the binding's error code, if any. */
export class SourceRepoError extends Schema.TaggedError<SourceRepoError>()("SourceRepoError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {}

const toRepoError = (cause: unknown) =>
  new SourceRepoError({
    message: cause instanceof Error ? cause.message : String(cause),
    code:
      Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code)
        ? cause.code
        : undefined,
    cause,
  });

const tryRepo = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: toRepoError });

/** The namespace, or 503 when this Nap has no SOURCES binding. */
const namespace = Effect.gen(function* () {
  const ns = yield* SourceNamespaceBinding;
  if (!ns) {
    return yield* failNoStore(503, "Source repos are not set up on this Nap", {
      code: "sources_unavailable",
    });
  }
  return ns;
});

export const isCommitHash = (value: string) => COMMIT.test(value);

/** Opens a repo handle for `use`, and disposes of it afterwards. */
const withRepo = <A, E, R>(
  ns: SourceNamespace,
  name: string,
  use: (repo: SourceRepo) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    tryRepo(() => ns.get(name)),
    use,
    (repo) => Effect.sync(() => repo[Symbol.dispose]?.()),
  );

/** The head commit of main, or null for a repo nobody has pushed to. */
export const headCommit = (repo: SourceRepo) =>
  tryRepo(() => repo.log({ ref: SOURCE_BRANCH, limit: 1 })).pipe(
    Effect.map(([head]) => head?.hash ?? null),
  );

/**
 * Whether `ancestor` is in the history of `head` (or is `head`). Checks the first-parent line in
 * one call, then walks every parent, so merges count too.
 */
export const isAncestor = Effect.fnUntraced(function* (
  repo: SourceRepo,
  ancestor: string,
  head: string,
) {
  if (ancestor === head) return true;
  const line = yield* tryRepo(() => repo.log({ ref: head, limit: 1000 }));
  if (line.some((commit) => commit.hash === ancestor)) return true;
  const seen = new Set<string>();
  const queue = [head];
  while (queue.length > 0 && seen.size < MAX_ANCESTRY_COMMITS) {
    const hash = queue.shift()!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    if (hash === ancestor) return true;
    const commit = yield* tryRepo(() => repo.readCommit(hash));
    if (commit) queue.push(...commit.parents.filter((parent) => !seen.has(parent)));
  }
  return false;
});

const liveCommitOf = Effect.fnUntraced(function* (versionId: string) {
  const db = yield* Database;
  const live = yield* db.first<{ commitHash: string | null }>(
    "SELECT source_commit AS commitHash FROM versions WHERE id = ?",
    versionId,
  );
  return live?.commitHash ?? null;
});

/**
 * Checks the commit a new version says it was built from.
 * - A site without a source repo takes no commit.
 * - A site with one needs the head of main, and that commit must contain the live one.
 * Succeeds when the version may go live.
 */
export const checkSourceCommit = Effect.fn("checkSourceCommit")(function* (
  /** currentVersion is null for a new site whose repo was created with its first upload. */
  site: { slug: string; sourceRepo: string | null; currentVersion: string | null } | null,
  sourceCommit: string | null | undefined,
) {
  const commit = (sourceCommit ?? "").trim().toLowerCase();
  if (!site?.sourceRepo) {
    if (!commit) return;
    return yield* failNoStore(400, "sourceCommit only works for a site with a source repo", {
      code: "no_source_repo",
    });
  }
  if (!commit) {
    return yield* failNoStore(
      409,
      `This site's source is in a Nap source repo. Push your change to its ${SOURCE_BRANCH} branch, build that commit, and publish with sourceCommit set to it. Upload in the dashboard is off for this site.`,
      { code: "source_commit_required" },
    );
  }
  const liveCommit = site.currentVersion ? yield* liveCommitOf(site.currentVersion) : null;
  yield* checkRepoCommit(site.sourceRepo, commit, liveCommit);
});

/**
 * The commit rules, for any repo: `commit` must be the head of main and contain `liveCommit`, the
 * commit of whatever is live now. Sites pass their live version's commit; apps pass the live
 * build's commit of the target being published. Succeeds when the commit may go live.
 */
export const checkRepoCommit = Effect.fn("checkRepoCommit")(function* (
  repoName: string,
  commit: string,
  liveCommit: string | null,
) {
  if (!isCommitHash(commit)) {
    return yield* failNoStore(400, "sourceCommit must be a full 40-character commit hash", {
      code: "invalid_source_commit",
    });
  }
  const ns = yield* namespace;
  yield* withRepo(ns, repoName, (repo) =>
    Effect.gen(function* () {
      const head = yield* headCommit(repo);
      if (head !== commit) {
        return yield* failNoStore(
          409,
          head
            ? `${commit.slice(0, 7)} is not the head of ${SOURCE_BRANCH} (${head.slice(0, 7)}). Push it first. If someone else pushed, pull, merge, build again, and publish the new head.`
            : `Nothing is pushed to ${SOURCE_BRANCH} yet. Push first.`,
          { code: "source_not_head", head },
        );
      }
      if (liveCommit && !(yield* isAncestor(repo, liveCommit, commit))) {
        return yield* failNoStore(
          409,
          `The live version was built from ${liveCommit.slice(0, 7)}, which is not in the history of ${commit.slice(0, 7)}. A force-push dropped published work. Get it back into ${SOURCE_BRANCH} (fetch that commit and merge it), then publish again.`,
          { code: "source_not_descendant", liveCommit },
        );
      }
    }),
  );
});

/** Whether a repo's main contains `liveCommit`: for a build that went live while another signed. */
export const containsCommit = Effect.fn("containsCommit")(function* (
  repoName: string,
  commit: string,
  liveCommit: string,
) {
  const ns = yield* SourceNamespaceBinding;
  if (!ns) return false;
  return yield* withRepo(ns, repoName, (repo) => isAncestor(repo, liveCommit, commit));
});

/** A repo's remote and the head of main. */
export const repoHead = Effect.fn("repoHead")(function* (repoName: string) {
  const ns = yield* namespace;
  return yield* withRepo(ns, repoName, (repo) =>
    Effect.all({
      remote: tryRepo(() => repo.info()).pipe(Effect.map((info) => info.remote)),
      head: headCommit(repo),
    }).pipe(
      Effect.map(({ remote, head }) => ({ repo: repoName, remote, branch: SOURCE_BRANCH, head })),
    ),
  );
});

/** The repo, its main head, and the commit of the live version. */
export const describeSource = Effect.fn("describeSource")(function* (site: {
  sourceRepo: string | null;
  currentVersion: string;
}) {
  if (!site.sourceRepo) {
    return yield* failNoStore(404, "This nap has no source repo", { code: "no_source_repo" });
  }
  const ns = yield* namespace;
  const liveCommit = yield* liveCommitOf(site.currentVersion);
  const repoName = site.sourceRepo;
  const { remote, head } = yield* withRepo(ns, repoName, (repo) =>
    Effect.all({
      remote: tryRepo(() => repo.info()).pipe(Effect.map((info) => info.remote)),
      head: headCommit(repo),
    }),
  );
  return {
    repo: repoName,
    remote,
    branch: SOURCE_BRANCH,
    head,
    liveCommit,
    inSync: head !== null && head === liveCommit,
  };
});

/** A short-lived token for one repo. Read clones and fetches; write also pushes. */
export const mintSourceToken = Effect.fn("mintSourceToken")(function* (
  repoName: string,
  scope: "read" | "write",
) {
  const ns = yield* namespace;
  return yield* withRepo(ns, repoName, (repo) =>
    Effect.all(
      [
        tryRepo(() => repo.info()),
        tryRepo(() => repo.createToken(scope, SOURCE_TOKEN_TTL_SECONDS)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(
        ([info, token]): SourceAccess => ({
          repo: repoName,
          remote: info.remote,
          branch: SOURCE_BRANCH,
          scope,
          token: token.plaintext,
          expiresAt: token.expiresAt,
        }),
      ),
    ),
  );
});

/**
 * Creates the source repo for a site and returns a write token for the first push. The repo is
 * named after the site; a suffix is added when an old repo has that name.
 */
export const createSource = Effect.fn("createSource")(function* (site: {
  slug: string;
  title: string;
}) {
  const ns = yield* namespace;
  const created = yield* createRepo(ns, site);
  const db = yield* Database;
  const stored = yield* db.run(
    "UPDATE sites SET source_repo = ? WHERE slug = ? AND source_repo IS NULL",
    created,
    site.slug,
  );
  if (stored.changes !== 1) {
    // Another request added a repo first. Drop this empty one.
    yield* deleteSourceRepo(created);
    return yield* failNoStore(409, "This nap already has a source repo", { code: "source_exists" });
  }
  return yield* mintSourceToken(created, "write");
});

/**
 * Creates the source repo for a site that does not exist yet: its first upload holds the URL.
 * The upload records the repo, and the site gets it when the upload is committed. Returns a
 * write token for the first push.
 */
export const createUploadSource = Effect.fn("createUploadSource")(function* (site: {
  slug: string;
  title: string;
}) {
  const ns = yield* namespace;
  const created = yield* createRepo(ns, site);
  return yield* mintSourceToken(created, "write");
});

/** Creates an empty repo for something other than a site (an app). Returns its name. */
export const createNamedRepo = Effect.fn("createNamedRepo")(function* (
  name: string,
  description: string,
) {
  const ns = yield* namespace;
  return yield* createRepo(ns, { slug: name, title: description });
});

/** Deletes a repo that no site uses, such as the repo of an upload that never went live. */
export const deleteSourceRepo = Effect.fn("deleteSourceRepo")(function* (name: string) {
  const ns = yield* SourceNamespaceBinding;
  if (ns) yield* Effect.ignore(tryRepo(() => ns.delete(name)));
});

/** Creates an empty repo named after the site and returns its name. */
const createRepo = Effect.fnUntraced(function* (
  ns: SourceNamespace,
  site: { slug: string; title: string },
) {
  let created: { name: string; token: string } | null = null;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    const name = attempt === 0 ? site.slug : `${site.slug}-${randomSuffix()}`;
    created = yield* tryRepo(() =>
      ns.create(name, { description: site.title.slice(0, 200), setDefaultBranch: SOURCE_BRANCH }),
    ).pipe(
      Effect.catchIf(
        (error) => error.code === "ALREADY_EXISTS",
        () => Effect.succeed(null),
      ),
    );
  }
  if (!created) return yield* failNoStore(409, "Could not pick a free repo name. Try again.");

  // The token from create() lasts a day. Hand out a short one instead.
  const { name, token } = created;
  yield* Effect.ignore(withRepo(ns, name, (repo) => tryRepo(() => repo.revokeToken(token))));
  return name;
});

function randomSuffix() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes]
    .map((byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 6);
}
