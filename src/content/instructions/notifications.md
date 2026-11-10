# Notifications on Nap (nap.notify)

A page or app tells the people on this Nap that something happened: "Elias wants to play", "Your turn", "The vote closes in an hour". They arrive on phones with the {{orgName}} app and in browsers where the person turned notifications on (the bell in the dashboard's bar).

- Load `<script src="/_nap/client.js"></script>`, then `await nap.notify({ title: "Elias wants to play", body: "Join the next round", open: "/" })`. It resolves with `{ sent }`, the number of people it went to.
- `title` is required (up to 80 characters); `body` is optional (up to 240). Write them as the message itself, short and specific; the page's title is shown with it.
- `open` is where a tap goes: a path on the page's own site (default its home page) or a URL on {{rootDomain}}. Links elsewhere are refused.
- It goes to everyone else who can see the page, never to the sender. `skip: ["ann@example.com", …]` leaves people out too, such as the others who were there for what it is about (a team's own "We solved it"). There are no lists or subscriptions yet, so send only what most people who can see the page want to hear, and only when a person does something (a button press), never on a timer or on page load.
- `only: [emails]` sends to those people alone (still never the sender, and only if they can see the page), such as "Ann beat your score" to the people Ann beat. An empty list sends to nobody.
- `tag: "wordle-2026-11-10"` (up to 64 letters, digits, `.`, `_`, `:`, `-`) makes a newer notification from this page with the same tag replace the older one on every phone and browser, instead of piling up: one notification a game a day that says who has played so far. `quiet: true` sends it without a sound or a banner, only into the list, such as later updates of a tagged one.
- Limits: 5 a minute and 80 a day per sender, and 12 a minute per page. Over them, nap.notify rejects with a NapError with status 429; tell the person to wait. A Nap without notifications rejects with status 404.
- Not every Nap has notifications: `await nap.canNotify()` says whether this one does. Show a button that sends one only when it is true.
- Put the person's name in the title when it is about them: get it from `await nap.me()`.
- Apps: native apps use the same call through Nap's API with their token (see the `apps` topic): POST /\_nap/api/naps/<id>/notify with `{ "title", "body", "open", "skip", "only", "tag", "quiet" }`, as the page with that id. An app without a site of its own posts to /\_nap/api/notify, which goes to everyone else on this Nap.
