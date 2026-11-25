# Making a good nap

How to make a page people want to open: a report, a write-up, an explainer, a prototype. Dashboards have their own topic (`dashboards`).

## Start from the kit

For a page that is mostly content, start from this Nap's kit: a ready React project with components, charts, diagrams, and this Nap's look. Read the `kit` topic, then:

    node /tmp/nap-publish.mjs kit <dir> && cd <dir> && pnpm install   # npm install if pnpm is missing
    pnpm build                                                        # → dist/index.html

- The kit gives you parts and a look, not a layout. Arrange them for what the page has to do, and build your own components when the kit has nothing that fits. Add libraries when a page needs them.
- Plain HTML is fine without Node, and for a page that is a single canvas or a game. You may also skip the kit for a page that needs a look of its own.
- When you update a nap that was built another way, keep its approach unless the user wants it rebuilt.

## The page

1. Write for someone who opens the link cold, but do not explain what they already know.
2. Lead with what matters most. Let detail be found, behind disclosures, tabs, or a click, rather than pushed at the reader.
3. Show how things work, do not just name them: a flow, a mechanism, or a difference between options is usually a diagram, not a list. When the subject is physical or spatial, show it that way.
4. Every structure should say something true. Numbers, cards, colour, and motion carry meaning, or they go.
5. Use only real content. Mark anything derived or illustrative as such.
6. Readability and a clear hierarchy come first. The page is finished at rest, readable in light and dark, and on a phone.
7. Give the page character where seeing beats reading, and keep everything around it calm. Content is there when the page opens; motion shows a change.

## Themes

A Nap may have more than one theme, such as a plain one and a more expressive one. A page built from the kit's tokens works in all of them, and each viewer picks theirs in the Nap bar (`kit` topic, Theme). Leave a page switchable unless it has its own colours or art; then build it for one theme only.
