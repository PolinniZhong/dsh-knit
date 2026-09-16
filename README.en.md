# Knit

> Your agent writes 20 documents a day. You can't find the one you just saw.
> Knit puts them next to the conversation — whatever you're talking about, the relevant doc is on top.

<img src="https://raw.githubusercontent.com/PolinniZhong/dsh-knit/main/docs/screenshot.png"
     alt="Screenshot from a real machine: the Knit sidebar listing the workspace documents, with a Markdown preview expanded in place"
     width="880">

*Screenshot from a real machine, not a mock-up: a workspace with 16 documents, the list plus an
inline preview. Note the top line — **before a session has any conversation to go on, it falls
back to newest-first and states its basis instead of pretending to rank.** Send a message and that
line switches to what you're currently talking about.*

Scans Markdown / images / video across the project folder · Order follows the conversation · No model calls, no network

```sh
dsh plugin --profile web add dsh-knit
```

---

## "Isn't this just a recent-files list?"

**Fair. Two differences:**

1. **Scope** — a recent-files list only remembers files you *opened*. Knit scans the
   **entire project folder**. Restart DSH, start a new session, come back tomorrow: it's all still there.
2. **Order** — that list sorts by time. Knit sorts by **what you're currently talking about**.

Three sentences on what it is:

1. Scans **every Markdown file in the project folder**, not just the ones from this turn —
   they survive restarts, new sessions, and days.
2. The order **follows the conversation**: talk about architecture and the architecture doc
   floats up; talk about competitors and the competitor analysis floats up.
3. **No model calls, no network egress**: plain local string matching — zero latency,
   zero cost, your documents never leave the machine.

---

## How "relevant" is computed

No magic, just string operations. Three steps:

**1. Read the conversation.** The host takes the last 6 user/assistant messages, and only
counts real user messages (`agent.inject()` synthetic context would drag the topic off course).
Newer messages weigh more: 3 / 2 / 1 / 1 …

**2. Extract keywords.**

- **ASCII words** — high value, one occurrence is enough (`chokidar`, `mtime`)
- **Chinese 2/3-grams** — either occurring twice, or appearing in the newest message
- stop-word filtering plus greedy de-overlap (picking「相关性排序」drops「相关性」and「排序」)

**3. Score the documents.** Weighted hits per keyword per document:

```
title ×4  +  summary ×2  +  first 2500 chars of body ×1
each keyword caps at 6 hits (so long docs can't farm score)
plus a 10% recency nudge (relevance still dominates)
```

All of it is string arithmetic — **no embeddings, no model calls**.

**And the honest boundary**: with only one or two messages there are too few keywords, so it
falls back to sorting by modification time and says so in the panel — it does not pretend to rank.

---

## Install

```sh
dsh plugin --profile web add dsh-knit
```

Then **restart DSH** and hard-refresh the browser (`Cmd + Shift + R`).

**How to open it:**

- The **Knit icon button in the session header** (right next to the sidebar toggle) — one click
- Or the right sidebar's tab bar「+」→「Knit recent docs」

**Optional**: if `dsh-better-sidebar` is installed, the panel also registers
as one of its tabs. Each host is an independent optional dependency; missing one doesn't affect the other.

---

## Features

| | |
|---|---|
| **Sorted by relevance to the current conversation** (local keyword matching, no model) | ✅ |
| One-click toggle between relevance / modification time (preference kept in localStorage) | ✅ |
| Scans `.md` in the session workspace (recursive, depth ≤ 6, skips `node_modules` / `.git` / `dist`) | ✅ |
| Each row shows H1 title (or filename) + relative time + first-paragraph summary | ✅ |
| Click to preview inline, click again to collapse | ✅ |
| Relative-path images actually render (`./img/a.png`, `../assets/b.png`) | ✅ |
| One-click switch between **Docs / Images & video / All** (remembered; defaults to Docs, unchanged); the selected tab is a **neutral grey fill**, with no coloured outline | ✅ |
| Images & video: square thumbnail grid — **at least 3 columns, more only as the pane gets wider**; cells start at 64px and the baseline is **8 per screen**; past 8 nothing is hidden, the whole grid scales down proportionally; videos auto-grab the first frame with a play glyph and duration badge (no deps, no transcoding) | ✅ |
| Click an image / video to preview **inline**: large image, playable & seekable video streamed over HTTP Range (no full download) | ✅ |
| The **All** view splits into **two stacked sections**: docs (max 4, with "View all →" when truncated) and images & video (**never truncated**, count only) | ✅ |
| Preview pane is height-draggable (20%–80%, remembered), fullscreen-able, `Esc` to exit | ✅ |
| Double-click opens in a new tab | ✅ |
| Filter box over title / summary / path | ✅ |
| **Click the workspace path** to open the project folder in your file manager | ✅ |
| **Hover the entry button to peek**: a read-only floating list of the 5 most recent docs; click to open the right sidebar (doesn't push the layout) | ✅ |
| Keyboard: `↑` `↓` move-and-preview, `Enter` toggle, `Esc` collapse | ✅ |
| Auto-refresh every 5s plus a manual button; docs changed in the last 2 min get 🆕 | ✅ |
| Bilingual (zh/en), follows the DSH language live — no plugin reload needed | ✅ |
| Zero model calls, zero network egress | ✅ |

> Relevance is deliberately **not visualised** (no percentages, no bars) — the ranking itself is
> the answer; position is relevance.

---

## What it reads, and what it doesn't

- Scans `.md`, images and video **inside the current session workspace** (anything resolving
  outside is rejected); for media it reads metadata only, never the pixels
- Reads only **the current session's** conversation events (used for ranking)
- **Makes no outbound network requests**: the client's `fetch` calls all point to
  the plugin's own same-origin routes
- **No install-time scripts** (no `install` / `postinstall`)
- **Zero dependencies** — nothing to build, no build-authorisation prompt
- The file-reading route only allows an **image/video-extension allowlist** (images ≤ 12MB,
  video ≤ 256MB), serves video over HTTP Range, and responds with
  `nosniff` plus `default-src 'none'; sandbox`

The relevance figure only affects ordering — it is **never displayed and never sent anywhere**.

---

## Known limitations

- **Short conversations degrade the ranking**: one or two messages give too few keywords, so it
  falls back to modification time and says so in the panel
- **Chinese segmentation is n-gram approximation**: no tokenizer dependency was added; good
  enough in practice, not linguistically precise
- **The right sidebar's default page becomes the guide**: DSH's rule is "if there's exactly one
  guide entry, open it directly"; the built-in Files entry takes that slot, so expanding the
  sidebar shows the guide first and Knit needs one more click on its pill
- **Media is limited to common formats and sizes**: images `png/jpg/jpeg/gif/webp/avif/bmp/ico/svg`,
  video `mp4/m4v/webm/mov/ogv`; images ≤ 12MB and video ≤ 256MB or they are not listed
- **Media matches relevance by filename only**: no visual/audio content is parsed — give
  screenshots and recordings searchable names
- **Right-sidebar state is memory-only**: a refresh or a new session collapses it again

---

## Development

```sh
git clone https://github.com/PolinniZhong/dsh-knit.git
cd dsh-knit

npm test          # 162 tests, zero dependencies, no npm install needed
```

**How changes take effect**: the host half (`src/host/`) **requires a DSH restart** (no hot reload);
the client half (`src/client/`) only needs a hard browser refresh.

**There is no build step**: the client half is a hand-written `window.__ModuleLoader__.load({...})`
using `React.createElement` instead of JSX, so there's no tsbuild / tsc. Static assets are inlined
too — changing the icon means editing both the `assets/` source and `KNIT_ICON_PATH` in
`src/client/client.js`; `test/icon.test.mjs` asserts the two are byte-identical.

```
knit/
├── package.json          # dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # the insert line mounted into the plugin tree
├── assets/               # icon source (path inlined into client.js)
├── src/
│   ├── host/index.js     # /knit/api/recent · /doc · /raw
│   ├── host/relevance.js # the relevance engine (pure functions)
│   └── client/client.js  # dual-host registration + panel UI
└── test/                 # 162 tests
```

Details and trade-offs live in the source comments; see [CONTRIBUTING.md](CONTRIBUTING.md)
for the contribution flow and [CHANGELOG.md](CHANGELOG.md) for the version history.

> Versioning: `0.x` means the feature set still moves and breaking changes are possible.
> `1.0.0` waits until **real retention is validated** — not merely "features are done".

## License

[MIT](LICENSE) © Polinni
