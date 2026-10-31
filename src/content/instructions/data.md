# Collections on Nap (nap.db)

Each artifact and site has its own JSON document collections, stored by Nap. No schemas or migrations: the page owns the shape and validation of its documents. Never put a slug in the calls; storage is scoped to the page automatically. Who can read and write follows who can view the page.

Load the client with `<script src="/_nap/client.js"></script>`. It sets `window.nap`.

- `const posts = nap.db.collection("posts")`. Names start with a lowercase letter, then lowercase letters, numbers, `_`, or `-`.
- `await posts.create(data)`: Nap picks the id.
- `await posts.put(id, data)`: create or replace by your own id (up to 64 letters, numbers, `_`, `-`). Use your own ids for anything there should be one of (one answer per question, one settings document), so two people writing at once hit the same document.
- `await posts.get(id)`, and `await posts.list({ limit: 50, cursor })`, which returns `{ documents, nextCursor }`. Keep going while nextCursor is set.
- `await posts.update(id, data)` replaces a document that exists. `await posts.patch(id, { status: "done", draft: null })` changes only those fields; null removes one. Prefer patch when people edit different fields.
- `await posts.delete(id)`.
- A document is `{ id, data, version, createdBy, updatedBy, createdAt, updatedAt }`. Your fields are under `data`. `version` goes up by one on every write.
- `const stop = posts.subscribe((documents) => render(documents))` calls back with every document, newest first, now and on every change by anyone. Use it whenever several people use the page at once.
- Writes are last-write-wins. To avoid overwriting someone, pass the version you showed: `{ ifVersion: doc.version }` (update, put, patch, delete). If someone saved in between, it throws a NapError with status 409 and `error.document`, the current document. `put(id, data, { ifNew: true })` only creates.
- Documents are JSON objects up to 64 KiB. No secrets.

```html
<script src="/_nap/client.js"></script>
<script>
  const answers = nap.db.collection("answers");
  answers.subscribe((documents) => render(documents));
  async function save(question, text, shown) {
    try {
      await answers.put(question, { text }, shown ? { ifVersion: shown.version } : { ifNew: true });
    } catch (error) {
      if (error.status !== 409) throw error;
      alert(`${error.document.updatedBy} changed this answer. Save again to replace it.`);
    }
  }
</script>
```
