# Publishing without a token (claim links)

When you cannot sign in (no shell, or the user does not want to connect you), upload a draft. The user opens its claim link, checks the preview, chooses who can see it, and clicks Publish.

1. Upload, with no token:
   - Artifact: `curl -sS https://{{rootDomain}}/_nap/drafts -H 'content-type: text/html' --data-binary @bundle.html --url-query 'title=Q3 report'`
   - Site: add `--url-query slug=team-map` (lowercase letters, numbers, hyphens, up to 32).
   - Several files: `-F 'title=Team map' -F slug=team-map -F 'files=@dist/index.html;filename=index.html' -F 'files=@dist/assets/app.js;filename=assets/app.js'`
2. The response has id and claimUrl. Give the claimUrl to the user and tell them to pick who can see it before they publish.
3. Keep the id. To update the same page, upload again with `--url-query replaces=<id of your latest draft>`. The user gets a new claim link that updates the page and keeps its access.

Drafts expire after 24 hours, and each claim link works once. Up to 25 MB and 1,000 files. Anyone with the claim link can see the draft, so never include secrets.
