# Notifications on Nap (nap.notify)

A page or app tells the people on this Nap that something happened: "Elias wants to play", "Your turn", "The vote closes in an hour". They arrive on phones with the {{orgName}} app and in browsers where the person turned notifications on (the bell in the dashboard's bar).

- Load `<script src="/_nap/client.js"></script>`, then `await nap.notify({ title: "Elias wants to play", body: "Join the next round", open: "/" })`. It resolves with `{ sent }`, the number of people it went to.
- `title` is required (up to 80 characters); `body` is optional (up to 240). Write them as the message itself, short and specific; the page's title is shown with it.
- `open` is where a tap goes: a path on the page's own site (default its home page) or a URL on {{rootDomain}}. Links elsewhere are refused.
- It goes to everyone else who can see the page, never to the sender. There are no lists or subscriptions yet, so send only what most people who can see the page want to hear, and only when a person does something (a button press), never on a timer or on page load.
- Limits: 3 a minute and 50 a day per sender, and 6 a minute per page. Over them, nap.notify rejects with a NapError with status 429; tell the person to wait. A Nap without notifications rejects with status 404.
- Not every Nap has notifications: `await nap.canNotify()` says whether this one does. Show a button that sends one only when it is true.
- Put the person's name in the title when it is about them: get it from `await nap.me()`.
- Apps: native apps use the same call through Nap's API with their token (see the `apps` topic): POST /\_nap/api/naps/<id>/notify with `{ "title", "body", "open" }`, as the page with that id. An app without a site of its own posts to /\_nap/api/notify, which goes to everyone else on this Nap.
