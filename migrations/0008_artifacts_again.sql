-- `kind` is read again: sites and artifacts are separate. 0007 called it unused.
-- While it was unused, agent drafts without a slug became kind = 'site'. Before and after that
-- time, such a draft makes an artifact. A draft that replaces another one updates an existing
-- site or artifact and keeps its kind, so it is left out.
UPDATE sites
SET kind = 'artifact'
WHERE kind = 'site'
  AND management_type = 'direct'
  AND slug IN (
    SELECT site_slug FROM drafts
    WHERE slug = '' AND replaces_draft_id IS NULL AND site_slug IS NOT NULL
  );
