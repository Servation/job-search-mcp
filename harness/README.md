# Host harness

A local stand-in for Claude Desktop, for working on the review UI (`src/mcp-app.tsx`).

```bash
npm run harness      # builds the widget, then serves the harness on :5199
```

## Why this exists

The review UI is an MCP App: the host renders it inside a sandboxed iframe and everything
interesting flows over the `ui/*` bridge. Open `dist/mcp-app.html` in a browser tab and you get a
widget stuck on "Connecting…", because there is no host on the other end. So the parts most
likely to break are exactly the parts a plain tab cannot show you:

- **Links.** An `<a target="_blank">` inside the sandbox navigates nowhere. The widget has to ask
  the host via `ui/open-link`. The harness logs each request, so you can see it happen.
- **Theming.** `prefers-color-scheme` follows the OS, but Claude's light/dark setting is its own
  thing, so the host sends the real theme over the bridge. The **Toggle theme** button flips it,
  which is how you catch a light-on-light or dark-on-dark regression.
- **The post-mount refresh.** On remount the host replays a stale tool result and the widget
  re-reads `show_board` to correct it. That round trip needs a host to answer it.

## What it is (and is not)

It is a **host**, not a server. Tool calls are answered from an in-memory fixture in
`fixture.ts`, so the harness never touches your real job store on disk. The fixture jobs are
invented and chosen to exercise the widget's branches: every score-colour band and both sides of
each boundary, an unscored job, a job with no `matchReason` (the card falls back to the
description), and a job missing every optional field.

Triage is stateful: Applied / Save / Skip move jobs between the board and the tracker the way the
real server does, so the refresh round trip returns something truthful. The store lives in memory
for the life of the page, so a reload (including switching between the board and saved links)
starts from the seed again.

## Query flags

| Flag | Effect |
| --- | --- |
| `?view=saved` | Open the tracker instead of the board |
| `?theme=dark` | Start in dark, rather than toggling into it |
| `?sameorigin=1` | Add `allow-same-origin` to the iframe so the parent can read the widget's DOM |

The default sandbox is `allow-scripts` only, matching a real host. `?sameorigin=1` is the escape
hatch for asserting on what actually rendered, which a faithful sandbox deliberately prevents.

## Gotcha: auto-resize needs a visible tab

The widget reports its height through `ResizeObserver` plus `requestAnimationFrame`.
`requestAnimationFrame` does not fire in a backgrounded or non-compositing tab, so in a headless
or hidden browser you will see no `ui/notifications/size-changed` and the iframe will not resize.
That is the browser, not a bug in the widget. Bring the tab to the front before concluding
anything about resize behaviour.
