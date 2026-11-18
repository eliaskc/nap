# Drafts the user publishes (claim links)

Publish directly when you can. Upload a draft instead when the user wants to check the nap before it goes live, or to choose who can see it themselves. They open its claim link, check the preview, choose who can see it, and click Publish.

Drafts need the user's token, like everything else (`api` topic for signing in and setting TOKEN). Only the person whose token uploaded a draft can open its claim link.

1. Upload:
   - One file: `curl -sS https://{{rootDomain}}/_nap/api/drafts -H "authorization: Bearer $TOKEN" -H 'content-type: text/html' --data-binary @bundle.html --url-query 'title=Q3 report'`
   - A name: add `--url-query name=team-map` (lowercase letters, numbers, hyphens, up to 32). The user can change it before they publish. Add `--url-query ownHost=true` only for a nap that needs its own host (`sites` topic).
   - Several files: `-F 'title=Team map' -F name=team-map -F 'files=@dist/index.html;filename=index.html' -F 'files=@dist/assets/app.js;filename=assets/app.js'`
2. The response has id and claimUrl. Give the claimUrl to the user and tell them to pick who can see it before they publish.
3. Keep the id. To update the same nap, upload again with `--url-query replaces=<id of your latest draft>`. The user gets a new claim link that updates the nap and keeps its access.

Drafts expire after 24 hours, and each claim link works once. Up to 25 MB and 1,000 files.
