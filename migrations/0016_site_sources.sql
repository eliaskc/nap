-- Source repos. A site can keep its source in a Cloudflare Artifacts repo that Nap owns.
-- source_repo: the repo's name in the Worker's Artifacts namespace. It does not change when the
-- site is renamed. NULL for sites without source.
-- A site with a source repo only takes new versions built from the head of its main branch, so
-- the source and the live site stay in step. versions.source_commit records that commit.
ALTER TABLE sites ADD COLUMN source_repo TEXT;
ALTER TABLE uploads ADD COLUMN source_commit TEXT;

-- GitHub-managed sites end. They become ordinary sites; their owner adds a source repo and pushes
-- the history from GitHub. Old versions keep source 'github' and their commit.
DROP TRIGGER IF EXISTS protect_github_site_delete;
DROP TRIGGER IF EXISTS protect_github_site_slug;
UPDATE sites
SET management_type = 'direct', source_repository = NULL, source_directory = NULL
WHERE management_type = 'github';
DROP TABLE IF EXISTS site_deployments;
