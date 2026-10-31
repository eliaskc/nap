# Source repos on Nap

A site can keep its source in a Git repo on Nap, one repo per site. The next agent, or a teammate's agent, changes the site there, with history. No GitHub account is needed: Nap gives Git tokens that last 15 minutes. You commit and push with git or jj, build on your machine, and publish the build with the commit you built. In the commands, `nap-publish.mjs` is `/tmp/nap-publish.mjs` (see the main instructions).

## When

- Give a new site a repo when its build is more than copying files (React, Vite, a framework, a bundler, TypeScript), or when it will live long or several people will work on it.
- Plain HTML/CSS/JS never needs one: the published files are the source. Artifacts do not have repos.

## Publish with a repo

- New site: keep the source in a Git repo of its own, commit, build, then
  `node nap-publish.mjs dist --title "Team map" --slug team-map --source .`
  It creates the repo, adds the remote "nap", pushes HEAD to main, and publishes the build with that commit. The working tree must be clean, with build output in .gitignore.
- Next change: commit, build, `node nap-publish.mjs dist --update <id> --source . --message "What changed"`. It pushes HEAD to main (never forced) and publishes.
- A site you own that has no repo: `--update <id> --source .` creates one. Only the owner can.
- Nap only takes builds of the head of main, and that head must contain the live version's commit. Dashboard uploads and claim links are off for sites with a repo.

## Change a site that has a repo

`GET /_nap/api/naps/<id>` has `"source": {"branch":"main"}` when there is a repo. Then never edit or upload its built files. Instead:

1. Get the source: `node nap-publish.mjs clone <id> [dir]`, or pull an existing clone: `node nap-publish.mjs run <id> -- git pull nap main`. Read its README and AGENTS.md.
2. Change it, build, and run its tests.
3. Commit with a message that says what changed.
4. Publish that commit with `--source` as above. If you pushed yourself, use `--source-commit <sha>` instead. Never force-push main.
5. 409 `source_not_head`: main moved after your push. Pull, build, and publish again. `source_commit_required`: you left out the commit.

`node nap-publish.mjs run <id> -- <git or jj command>` runs any command with a fresh token, passed through the environment and never written to a file. `GET /_nap/api/naps/<id>/source` shows the head of main, the live version's commit, and whether they are in sync.

## Rules

- Keep the repo self-contained: a lockfile, the build command in package.json, a .gitignore for node_modules and build output, and a short README that says how to build.
- Never commit secrets or .env files. Everyone who can view the site can read and push to the repo.
- Restoring an old version in Nap does not change the repo. To undo for good, revert in the repo and publish.
- A source folder inside a bigger repo: split it out (`git subtree split --prefix=<folder> -b <branch>`), create the repo with `node nap-publish.mjs source <id> --create`, push the branch to main with `run`, and publish with `--source-commit`.

## Without the script

- `POST /_nap/api/naps/<id>/source/token` with `{"access":"write"}` (or "read") returns `source.remote` and `source.token`. Send the token as a header, never in the URL or a file:
  `git -c http.extraHeader="Authorization: Bearer <token>" -c credential.helper= clone <remote>`
- A new site gets its repo with its first direct upload: add `"createSource": true` and `"sourceCommit"` to `POST /_nap/api/uploads`. The response has `source.remote` and `source.token`; push the commit to main, PUT the files, and POST to commitUrl. Send `sourceCommit` as a field with every publish.
