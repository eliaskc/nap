# Dashboards on Nap

A dashboard is a nap of type `dashboard`: one or more charts and numbers that people come back to, to see how something is going, sometimes left open on a wall screen. A report read once, a tool people work in, or a one-off analysis is a page. You write all of it as an ordinary nap; the type only tells Nap how to show and count it.

Publish with `--type dashboard` (`type=dashboard` in the API and for drafts). The owner can change the type in Nap, or by publishing a new version with `--type`. Everything in the `sites` topic still applies: it runs in Nap's frame below the Nap bar.

## Structure

A loose shape, not a template. Fit it to the question the dashboard answers.

- On top, the few numbers that matter most, each with its unit and what it compares to ("412 signups, +8% on last week").
- Below, charts grouped by the question they answer, each with a title that says what it shows ("Signups per day, last 30 days"), not what it is ("Chart 1").
- Always visible: the date range the numbers cover, and when the data was last updated.

## Data

Load the data in the page and draw from it; never bake numbers into the HTML. Where it can come from:

- Collections (`data` topic): documents the page, its people, or an agent write. A script or agent writes them with a Nap token through `https://{{rootDomain}}/_nap/api/naps/<id>/data/<collection>[/<doc id>]` (POST to add, PUT to replace by your own id, JSON body). `subscribe` updates the page when anything changes.
- Public APIs through `nap.fetch` (`fetch` topic), with their hosts in `nap.json`. GET responses are cached for about five minutes, so refreshing them more often gains nothing. Never put a secret in the page.
- This Nap's extensions, when the index lists one that has the data (`nap.<name>`, each with its own topic).
- A JSON file published with the nap (`fetch("data.json")`), for data that changes only when you publish a new version. Put the time it was made in the file and show it.

Nap has no scheduled jobs: data that must be collected on a timer comes from an API that already has it, or from something outside Nap that writes it into a collection.

Refresh in place on a timer (a minute or more, unless the data changes faster) without reloading the page, and skip the timer while `document.hidden` is true; refresh at once when the tab shows again. Every chart and number needs a loading state, an empty state ("No signups in this range"), and an error state that says what failed. When a refresh fails, keep the last numbers but say how old they are ("Updated 14 min ago, retrying"). Never show a stale number without its age.

## Charts

- If your skill provides a kit or design system with chart components, use them. Otherwise use a well-known charting library (such as Chart.js, ECharts, Vega-Lite, or Observable Plot), loaded from your bundle or a CDN. Nap has no chart components of its own.
- Draw to scale: bar charts start at zero, and axes do not break silently. Label axes and units, and show the time range.
- Prefer a few clear charts over many: a line for change over time, bars to compare, a big number for one value. No 3D, no pie charts with many slices.
- Follow light and dark mode like the rest of the page; charts drawn on a canvas need their colours set for both.

## Any screen

A dashboard should work on any screen, from a phone to a large display on a wall:

- A responsive layout: numbers and charts reflow into fewer columns on narrow screens, and nothing needs sideways scrolling.
- Readable from a distance when given the room: on a large screen, scale type and charts up and keep it to one screen of content.
- Nothing that only shows on hover: touch screens and wall displays have no pointer. Label the values that matter on the chart.
