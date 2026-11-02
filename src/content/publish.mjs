#!/usr/bin/env node
// Nap publish script. Publishes a folder or a single HTML file to Nap, for any size up to 1 GB.
// Nap serves this file at https://{{rootDomain}}/_nap/api/publish.mjs. Needs Node 20+.
//
// Usage:
//   node publish.mjs login [--client "Claude Code on my-mac"]
//   node publish.mjs <folder or file.html> [options]
//   node publish.mjs source <id> [--create]     Show a site's source repo, or create it.
//   node publish.mjs clone <id> [dir]           Clone a site's source repo with Git.
//   node publish.mjs run <id> -- <command...>   Run git or jj with access to the source repo.
//
// Native iOS apps (SwiftUI, built on a Mac; Nap signs them):
//   node publish.mjs app list
//   node publish.mjs app init <app> [dir] [--title "Name"]   Create an app from the template.
//   node publish.mjs app clone <app> [dir]
//   node publish.mjs app run <app> -- <command...>           git or jj with access to its repo.
//   node publish.mjs app publish <app> <build.zip> --target <target> --source <dir> [--notes "..."]
//                          Pushes HEAD of <dir> to main, uploads the unsigned build with that
//                          commit, and Nap signs it and makes it live. The app's
//                          scripts/publish runs this for you.
//
// Options:
//   --title "Name"         The name people see. Default: the page's <title>.
//   --site                 Make a site instead of an artifact.
//   --slug name            Make a site at <slug>.{{rootDomain}}.
//   --access who           New pages only: private, everyone, or selected. Default: {{defaultAccess}}.
//   --emails a@x,b@x       With --access selected: who can view it.
//   --update <id or URL>   Publish a new version of a page. Its URL and access stay the same.
//   --expected-version v   With --update: the live version you read. Required on pages
//                          someone else owns, so you never overwrite a change you have not seen.
//   --message "..."        What changed, for the version history.
//   --source <dir>         Sites: the Git repo you built from (a clean working tree, usually ".").
//                          Pushes its HEAD to main of the site's source repo on Nap and publishes
//                          the build with that commit. Creates the repo for a new site, or for
//                          your own site that has none. Adds the remote "nap" to <dir>.
//   --source-commit <sha>  Sites with a source repo, when you pushed yourself: the pushed commit
//                          you built. It must be the head of main.
//
// The token is NAP_TOKEN, or the file ~/.config/nap/{{rootDomain}}/token. Next to it, nap.json
// says which Nap it is for: { url, org, email }. `login` creates both: it prints a link
// for the user to approve and waits up to 10 minutes. NAP_URL overrides the Nap origin.
//
// The source repo commands get a Git token that lasts 15 minutes and pass it to git through the
// environment (GIT_CONFIG_*), so it is never written to disk. run asks for a new one every time.
//
// Exit codes: 0 published, 1 error, 3 not signed in (run login), 4 the user must open Nap first.

import { spawnSync } from "node:child_process";
import { openAsBlob, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, relative, sep } from "node:path";

const NAP_URL = (process.env.NAP_URL || "https://{{rootDomain}}").replace(/\/+$/, "");
// One folder per Nap, by its host, so tokens for several Naps do not overwrite each other.
const CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "nap",
  new URL(NAP_URL).host,
);
const TOKEN_FILE = join(CONFIG_DIR, "token");
const CONCURRENCY = 6;

class ExitError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const options = { _: [] };
  const flags = new Set(["site", "create"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options.command = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      options._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (name === "help" || name === "h") options.help = true;
    else if (flags.has(name)) options[name] = true;
    else if (i + 1 < argv.length) options[name] = argv[++i];
    else throw new ExitError(`${arg} needs a value`);
  }
  return options;
}

async function readToken() {
  if (process.env.NAP_TOKEN) return process.env.NAP_TOKEN.trim();
  try {
    return (await readFile(TOKEN_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

async function api(path, { token, body, method = "POST" } = {}) {
  const response = await fetch(`${NAP_URL}/_nap/api${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && token) {
    if (data.code === "inactive") throw new ExitError(data.error, 4);
    if (!process.env.NAP_TOKEN) await rm(TOKEN_FILE, { force: true });
    throw new ExitError("The Nap token is no longer valid. Run: node publish.mjs login", 3);
  }
  return { status: response.status, ok: response.ok, data };
}

async function login(options) {
  const client = options.client || `Agent on ${hostname().split(".")[0]}`;
  const start = await api("/auth/device", { body: { client } });
  if (!start.ok) throw new ExitError(`Could not start the sign-in: ${JSON.stringify(start.data)}`);
  const { device_code, user_code, verification_uri_complete } = start.data;
  let interval = (start.data.interval || 5) * 1000;
  console.log(`Ask the user to open this link and approve. The code must be ${user_code}:`);
  console.log(verification_uri_complete);
  console.log("Waiting for approval (up to 10 minutes)...");
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const polled = await api("/auth/token", { body: { device_code } });
    if (polled.data.token) {
      await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
      await writeFile(TOKEN_FILE, polled.data.token, { mode: 0o600 });
      // Which Nap this is, so agents can tell the user's Naps apart without the token.
      const about = { url: NAP_URL, org: "{{orgName}}", email: polled.data.email };
      await writeFile(join(CONFIG_DIR, "nap.json"), `${JSON.stringify(about, null, 2)}\n`);
      console.log(`Signed in as ${polled.data.email}. The token is in ${TOKEN_FILE}.`);
      return;
    }
    if (polled.data.error === "authorization_pending") continue;
    if (polled.data.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new ExitError(`Sign-in stopped: ${polled.data.error_description || polled.data.error}`);
  }
  throw new ExitError("The user did not approve in time. Run login again.");
}

/** Every file under the folder, with its path from the folder. Skips hidden files. */
async function listFiles(root) {
  const info = await stat(root).catch(() => null);
  if (!info) throw new ExitError(`Not found: ${root}`);
  if (info.isFile()) {
    return [
      {
        path: /\.html?$/i.test(root) ? "index.html" : root.split(sep).pop(),
        file: root,
        size: info.size,
      },
    ];
  }
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files.push({
          path: relative(root, full).split(sep).join("/"),
          file: full,
          size: (await stat(full)).size,
        });
      }
    }
  };
  await walk(root);
  if (!files.some((file) => file.path === "index.html")) {
    throw new ExitError(`${root} has no index.html at its root`);
  }
  return files;
}

async function putFile(target, source) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(target.url, {
        method: "PUT",
        headers: target.headers,
        body: await openAsBlob(source.file),
      });
      if (response.ok) return;
      const text = await response.text();
      // A 4xx (other than a timeout or rate limit) will not get better on a retry.
      if (response.status < 500 && response.status !== 408 && response.status !== 429) {
        throw new ExitError(
          `Upload of ${source.path} failed (${response.status}): ${text.slice(0, 300)}`,
        );
      }
      throw new Error(`Upload of ${source.path} failed (${response.status})`);
    } catch (error) {
      if (error instanceof ExitError) throw error;
      if (attempt >= 3) {
        throw new ExitError(
          `Upload of ${source.path} failed: ${error.cause?.code || error.message}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

function idFrom(value) {
  const match =
    value.match(/^https?:\/\/[^/]+\/artifact\/([a-z0-9-]+)/) ||
    value.match(/^https?:\/\/([a-z0-9-]+)\.[^/]*nap\./);
  return match ? match[1] : value;
}

async function publish(options) {
  const [input] = options._;
  if (!input) throw new ExitError("Give a folder or an HTML file. See --help.");
  if (options.update && (options.access || options.emails || options.slug || options.site)) {
    throw new ExitError(
      "--update keeps the page's URL and access. Leave out --access, --emails, --slug, and --site.",
    );
  }
  if (options.source && options["source-commit"]) {
    throw new ExitError("Use --source or --source-commit, not both.");
  }
  if (options.source && !options.update && !options.site && !options.slug) {
    throw new ExitError("Only sites keep their source on Nap. Add --site or --slug.");
  }
  const local = options.source ? localSource(options.source) : null;
  const token = await readToken();
  if (!token) throw new ExitError("Not signed in to Nap. Run: node publish.mjs login", 3);

  const files = await listFiles(input);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const body = {
    files: files.map((file) => ({ path: file.path, size: file.size })),
    title: options.title,
    message: options.message,
  };
  if (options.update) {
    body.id = idFrom(options.update);
    if (options["expected-version"]) body.expectedVersion = options["expected-version"];
    if (options["source-commit"]) body.sourceCommit = options["source-commit"];
    if (local) {
      pushSource(local, await sourceForUpdate(token, body.id), body.id);
      body.sourceCommit = local.head;
    }
  } else {
    if (options.site || options.slug) body.kind = "site";
    if (options.slug) body.slug = options.slug;
    if (options.access) body.access = options.access;
    if (options.emails) body.emails = options.emails;
    if (local) {
      body.createSource = true;
      body.sourceCommit = local.head;
    }
  }

  const started = await api("/uploads", { token, body });
  if (!started.ok)
    throw new ExitError(
      `Upload refused (${started.status}): ${started.data.error || JSON.stringify(started.data)}`,
    );
  const { uploadId, commitUrl } = started.data;
  // A new site: Nap created its repo with the upload. Push before the files go up.
  if (local && started.data.source) pushSource(local, started.data.source, started.data.id);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const queue = [...started.data.files];
  let done = 0;
  let sent = 0;
  let lastReport = 0;
  const worker = async () => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      const source = byPath.get(target.path);
      await putFile(target, source);
      done++;
      sent += source.size;
      if (Date.now() - lastReport > 2000 || done === files.length) {
        lastReport = Date.now();
        console.log(`Uploaded ${done}/${files.length} files (${mb(sent)} of ${mb(total)})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  const committed = await api(new URL(commitUrl).pathname.replace(/^\/_nap\/api/, ""), { token });
  if (!committed.ok) {
    throw new ExitError(
      `Publish failed (${committed.status}): ${committed.data.error || JSON.stringify(committed.data)} (upload ${uploadId})`,
    );
  }
  const nap = committed.data;
  // Tell the user who can see it with every link you hand over.
  const who = {
    everyone: "Everyone at {{orgName}} can see it and publish new versions.",
    selected: "The owner and the people they invited can see it and publish new versions.",
    private:
      "Only the owner can see it. Tell the user to share it with the Share button on the page before they send the link to anyone.",
  };
  console.log(nap.created ? "Published." : "Published a new version.");
  console.log(`Who can see it: ${who[nap.access] || who.private}`);
  console.log(`URL: ${nap.url}`);
  console.log(`Id (use --update ${nap.id} for the next version): ${nap.id}`);
  if (local) {
    console.log(
      `Source: built from ${local.head.slice(0, 7)}, pushed to main of the site's repo on Nap (remote "nap" in ${local.dir}).`,
    );
    console.log(
      `Next time: commit, then publish with --update ${nap.id} --source ${local.dir}. Pull first with: node publish.mjs run ${nap.id} -- git -C ${local.dir} pull nap main`,
    );
  }
}

/** The Git repo at dir: its HEAD, with a clean working tree. */
function localSource(dir) {
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  const top = git("rev-parse", "--show-toplevel");
  if (top.error) throw new ExitError(`Could not run git: ${top.error.message}`);
  if (top.status !== 0) throw new ExitError(`${dir} is not a Git repo. Run git init and commit.`);
  if (realpathSync(top.stdout.trim()) !== realpathSync(dir)) {
    throw new ExitError(
      `${dir} is a folder inside the Git repo at ${top.stdout.trim()}. A site's repo on Nap holds only the site's source. Give the folder a repo of its own, or split its history out (git subtree split --prefix=<folder> -b <branch>), push that branch with "node publish.mjs run", and publish with --source-commit.`,
    );
  }
  const status = git("status", "--porcelain");
  if (status.stdout.trim()) {
    throw new ExitError(
      `${dir} has changes that are not committed. Commit them (with jj: jj commit), keep build output out with .gitignore, build again, and publish.`,
    );
  }
  const head = git("rev-parse", "--verify", "HEAD");
  if (head.status !== 0) throw new ExitError(`${dir} has no commits yet. Commit the source first.`);
  return { dir, head: head.stdout.trim() };
}

/** Write access to an existing site's repo. Creates the repo when the site has none. */
async function sourceForUpdate(token, id) {
  const path = `/naps/${encodeURIComponent(id)}`;
  const info = await api(path, { token, method: "GET" });
  if (!info.ok) {
    throw new ExitError(
      `Could not read ${id} (${info.status}): ${info.data.error || JSON.stringify(info.data)}`,
    );
  }
  const access = info.data.nap.source
    ? await api(`${path}/source/token`, { token, body: { access: "write" } })
    : await api(`${path}/source`, { token });
  if (!access.ok) {
    throw new ExitError(
      `No access to the source repo (${access.status}): ${access.data.error || JSON.stringify(access.data)}`,
    );
  }
  if (!info.data.nap.source) console.log(`Created the source repo ${access.data.source.repo}.`);
  return access.data.source;
}

/** Pushes the local HEAD to main of the site's repo, and adds the remote "nap" for later. */
function pushSource(local, source, id) {
  const env = gitEnv(source);
  const remotes = spawnSync("git", ["-C", local.dir, "remote", "get-url", "nap"], {
    encoding: "utf8",
  });
  if (remotes.status !== 0) {
    spawnSync("git", ["-C", local.dir, "remote", "add", "nap", source.remote], {
      stdio: "ignore",
    });
  }
  console.log(`Pushing ${local.head.slice(0, 7)} to main of the repo on Nap...`);
  const pushed = spawnSync(
    "git",
    ["-C", local.dir, "push", source.remote, `${local.head}:refs/heads/${source.branch}`],
    { encoding: "utf8", env },
  );
  if (pushed.status === 0) return;
  if (/rejected|non-fast-forward|fetch first/.test(pushed.stderr)) {
    throw new ExitError(
      `main on Nap has commits you do not have. Pull them (node publish.mjs ${id.startsWith("app ") ? id : `run ${id}`} -- git -C ${local.dir} pull nap main), build again, and publish. Never force-push.`,
    );
  }
  throw new ExitError(`git push failed:\n${pushed.stderr.trim()}`);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function signedIn() {
  const token = await readToken();
  if (!token) throw new ExitError("Not signed in to Nap. Run: node publish.mjs login", 3);
  return token;
}

function napId(options) {
  const value = options._[1];
  if (!value) throw new ExitError("Give the site's id (or URL).");
  return encodeURIComponent(idFrom(value));
}

/** A Git token for the site's source repo, and git config that sends it. */
async function sourceAccess(token, id) {
  const access = await api(`/naps/${id}/source/token`, { token, body: { access: "write" } });
  if (!access.ok) {
    throw new ExitError(
      `No access to the source repo (${access.status}): ${access.data.error || JSON.stringify(access.data)}`,
    );
  }
  const { source } = access.data;
  return { source, env: gitEnv(source) };
}

/** The environment for git with the repo token as a header, never written to disk. */
function gitEnv(source) {
  const count = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: "http.extraHeader",
    [`GIT_CONFIG_VALUE_${count}`]: `Authorization: Bearer ${source.token}`,
    // No credential helper: the header is the credential, and a helper would open a login window.
    [`GIT_CONFIG_KEY_${count + 1}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${count + 1}`]: "",
    NAP_SOURCE_REMOTE: source.remote,
  };
}

function runCommand(command, env) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit", env });
  if (result.error) throw new ExitError(`Could not run ${command[0]}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function source(options) {
  const token = await signedIn();
  const id = napId(options);
  if (options.create) {
    const created = await api(`/naps/${id}/source`, { token });
    if (!created.ok) {
      throw new ExitError(
        `Could not create the source repo (${created.status}): ${created.data.error || JSON.stringify(created.data)}`,
      );
    }
    console.log(`Created the source repo ${created.data.source.repo}.`);
    console.log(`Remote: ${created.data.source.remote} (branch ${created.data.source.branch})`);
    const site = decodeURIComponent(id);
    console.log(`Next: git remote add nap ${created.data.source.remote}`);
    console.log(`Then: node publish.mjs run ${site} -- git push nap HEAD:main`);
    return;
  }
  const info = await api(`/naps/${id}/source`, { token, method: "GET" });
  if (!info.ok) {
    throw new ExitError(
      `No source repo (${info.status}): ${info.data.error || JSON.stringify(info.data)}`,
    );
  }
  console.log(JSON.stringify(info.data.source, null, 2));
}

async function clone(options) {
  const token = await signedIn();
  const id = napId(options);
  const { source, env } = await sourceAccess(token, id);
  runCommand(["git", "clone", source.remote, options._[2] || decodeURIComponent(id)], env);
}

async function run(options) {
  if (!options.command?.length)
    throw new ExitError("Give the command after --, for example: -- git push");
  const token = await signedIn();
  const { env } = await sourceAccess(token, napId(options));
  runCommand(options.command, env);
}

// ---- Apps ----

function appSlug(options, position = 2) {
  const value = options._[position];
  if (!value) throw new ExitError("Give the app's name.");
  return encodeURIComponent(value);
}

function failed(what, response) {
  return new ExitError(
    `${what} (${response.status}): ${response.data.error || JSON.stringify(response.data)}`,
  );
}

async function appSourceAccess(token, app) {
  const access = await api(`/apps/${app}/source/token`, { token, body: { access: "write" } });
  if (!access.ok) throw failed("No access to the app's repo", access);
  return access.data.source;
}

async function appCommand(options) {
  const command = options._[1];
  const token = await signedIn();
  if (command === "list") {
    const listed = await api("/apps", { token, method: "GET" });
    if (!listed.ok) throw failed("Could not list apps", listed);
    for (const app of listed.data.apps) {
      const targets = app.targets
        .map((t) => `${t.target}${t.live ? ` (build ${t.live.buildNumber})` : ""}`)
        .join(", ");
      console.log(`${app.slug}\t${app.title}\t${targets || "no builds"}`);
    }
    return;
  }
  if (command === "init") {
    const app = appSlug(options);
    const dir = options._[3] || decodeURIComponent(app);
    const created = await api("/apps", {
      token,
      body: { slug: decodeURIComponent(app), title: options.title || "" },
    });
    if (!created.ok) throw failed("Could not create the app", created);
    const slug = created.data.app.slug;
    const template = await api("/apps/template", { token, method: "GET" });
    if (!template.ok) throw failed("Could not read the template", template);
    await mkdir(dir, { recursive: true });
    if ((await readdir(dir)).length > 0) throw new ExitError(`${dir} is not empty.`);
    for (const file of template.data.files) {
      const path = join(dir, file.path);
      await mkdir(join(path, ".."), { recursive: true });
      const content =
        file.encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : file.content
              .replaceAll("{{app}}", slug)
              .replaceAll("{{title}}", created.data.app.title);
      await writeFile(path, content, { mode: file.executable ? 0o755 : 0o644 });
    }
    const git = (...args) => {
      const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new ExitError(`git ${args[0]} failed:\n${result.stderr}`);
      return result.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: start from the Nap app template");
    const head = git("rev-parse", "HEAD");
    pushSource({ dir, head }, created.data.source, `app run ${slug}`);
    console.log(`Created the app ${slug} in ${dir}. Its repo on Nap is the remote "nap".`);
    console.log(`Next: cd ${dir} && scripts/publish launcher "First build"`);
    return;
  }
  if (command === "clone") {
    const app = appSlug(options);
    const source = await appSourceAccess(token, app);
    const dir = options._[3] || decodeURIComponent(app);
    runCommand(["git", "clone", "-o", "nap", source.remote, dir], gitEnv(source));
    return;
  }
  if (command === "run") {
    if (!options.command?.length)
      throw new ExitError("Give the command after --, for example: -- git pull");
    const source = await appSourceAccess(token, appSlug(options));
    runCommand(options.command, gitEnv(source));
    return;
  }
  if (command === "publish") {
    const app = appSlug(options);
    const zip = options._[3];
    if (!zip) throw new ExitError("Give the zipped .app, for example build/launcher.zip.");
    if (!options.target)
      throw new ExitError("Give --target (launcher, or a standalone prototype).");
    if (!options.source) throw new ExitError("Give --source: the app's Git repo you built from.");
    const local = localSource(options.source);
    const source = await appSourceAccess(token, app);
    pushSource(local, source, `app run ${decodeURIComponent(app)}`);
    const size = (await stat(zip)).size;
    console.log(`Uploading ${options.target} (${mb(size)}). Nap signs it...`);
    const query = new URLSearchParams({
      target: options.target,
      sourceCommit: local.head,
      notes: options.notes || "",
    });
    const response = await fetch(`${NAP_URL}/_nap/api/apps/${app}/builds?${query}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/zip",
      },
      body: await openAsBlob(zip),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw failed("Publishing failed", { status: response.status, data });
    console.log(data.message);
    return;
  }
  throw new ExitError(
    "Usage: node publish.mjs app list | init | clone | run | publish. See --help.",
  );
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    const source = await readFile(new URL(import.meta.url), "utf8");
    const lines = source.split("\n").slice(1);
    const end = lines.findIndex((line) => !line.startsWith("//"));
    console.log(
      lines
        .slice(0, end)
        .map((line) => line.replace(/^\/\/ ?/, ""))
        .join("\n"),
    );
  } else if (options._[0] === "login") {
    await login(options);
  } else if (options._[0] === "source") {
    await source(options);
  } else if (options._[0] === "clone") {
    await clone(options);
  } else if (options._[0] === "run") {
    await run(options);
  } else if (options._[0] === "app") {
    await appCommand(options);
  } else {
    await publish(options);
  }
} catch (error) {
  console.error(error instanceof ExitError ? error.message : error);
  process.exit(error instanceof ExitError ? error.code : 1);
}
