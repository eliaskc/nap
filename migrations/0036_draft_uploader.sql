-- Drafts need a Nap token now. Only the person whose token uploaded a draft may see or publish
-- it. Drafts from before have no uploader, so nobody can claim them; they expire within a day.
ALTER TABLE drafts ADD COLUMN created_by_email TEXT;
