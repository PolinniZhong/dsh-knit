# Knit

> **Task-aware workspace context retrieval and lifecycle tracking for AI coding agents.**
>
> **面向 AI Coding Agent 的任务感知工作区上下文检索与生命周期追踪。**

Knit is the layer between **the task you are on** and **your whole workspace**: it finds the most
relevant documents, source files and media, organises them into **Primary / Supporting / Related**
context (the Context Pack) for both the panel and the agent, and keeps tracking **whether they were
read, and whether they changed after being read**.

**Find → Organise → Track**, all of it plain string work on your own machine — no model calls, no
network, no latency, nothing leaves the machine.

```text
                       Current task
                            │
                    Workspace retrieval
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
         Primary        Supporting        Related
            └───────────────┼───────────────┘
                            ▼
                      Context Pack ──►  the `knit_docs` tool (for the agent)
                            ▼
                        Agent reads
                            ▼
                 Read Evidence · Context Epoch
                            ▼
                    Workspace changes
                            ▼
                   Re-read · Lifecycle
```

> **It is not a smarter recent-files list, and it is not a code browser.**
> A recent-files list records what you happened to open and what is newest; Knit answers
> **which things in this project are worth looking at first for the task at hand — and what
> happened to them after they were read.**

![Screenshot from a real machine: the Knit sidebar left on the Code tab, ranking the workspace source files by relevance, with a code preview expanded in place](https://raw.githubusercontent.com/PolinniZhong/dsh-knit/main/docs/screenshot.png)

*Screenshot from a real machine, not a mock-up: the same workspace, this one left on the **Code tab** —
since v0.19 source files are first-class citizens, just like Markdown.*
*The "why" line under each row says how it matched: a direct hit on the task text, a path hit, or a
workspace hit.*
*Click a row to expand the preview **in place**: here `knit/src/host/classification.js`, with line
numbers; the preview header holds only the path and four actions (copy / full screen / open locally / close).*
*The header holds only the path, one count and two toggles; whether the list runs by
relevance or by newest-first is decided by that pair of tabs on the left.*
*Since v0.14 the list is always one column: the rank number sits in its own column on the far left
(vertically centred on the title's first line), then Primary dot + title + relative time (time on the
right), then the summary. **The path lives in the preview header only** — the directory collapses to a `…/` placeholder (hover the path for the full relative path); rows no longer repeat it.*

![Order follows the conversation: send a message and the sidebar re-ranks the document list by it](https://raw.githubusercontent.com/PolinniZhong/dsh-knit/main/docs/demo-reorder.gif)

*Order follows the conversation — same workspace, in a freshly opened session: before you have said
anything, the list runs newest-first; ask "how is BM25 weighted for the ranking?" and the next poll
swaps the top of the list, with the tier headings and the **continuous rank numbers across all
three tiers** appearing alongside a one-line "why" under each row (what matched, and how).*
*In this particular frame no document landed in the primary tier, so the groups start at "supporting".*
*⚠️ The panel polls **every 5 seconds**, so the re-rank lands **0–5 s** after the message rather than
instantly, and the GIF runs faster than real time.*

Scans Markdown / images / video across the project folder · Order follows the conversation · No model calls, no network

```sh
dsh plugin --profile web add dsh-knit
```

---

## Why it exists

> An agent produces 20 documents a day, and you cannot find the one from a minute ago.

That is the problem it started from: **output got faster than anyone can browse directories.**
DSH's built-in "recent files" only records what you opened; once a turn ends, the earlier ones sink
out of sight.

Knit asks a different question: **not "what is newest", but "what is relevant to what I am doing".**
It scans the **whole workspace** (not just what this turn produced) and ranks by what you are
talking about — restart DSH, open a new session, come back the next day, and it is still there.

Then the problem grew one step further: when you actually change a feature, the first thing worth
reading is usually not a document but **a few lines of source**. That is what v0.19 added. And after
that, "ranked first" stopped being enough — **of the things it ranked, did the agent actually read
them? Did they change afterwards?** v0.15–v0.18 filled in that layer.

Three words: **Find** (scan the workspace, rank by the current task) → **Organise** (three tiers,
each with its reason) → **Track** (read or not, changed or not).

---

## It is not a recent-files list, and not a code browser

Both comparisons catch one **surface** of Knit and miss the question it answers.

|  | Recent-files list | Code browser | **Knit** |
|---|---|---|---|
| Scope | What you happened to open | A directory tree | **The whole workspace**: documents / code / images / video |
| Order | Modified time | You scroll it yourself | **Relevance to the current task** (BM25 + IDF, computed locally) |
| Output | One flat list | The one file you opened | **Primary / Supporting / Related**, each saying why it is there |
| For whom | You | You | You **and** the agent — the same Context Pack, through `knit_docs` |
| Afterwards | Nothing | Nothing | **Was it read? Did it change after being read?** (Read Evidence + lifecycle) |

The three differences that matter:

1. **Scope**: a recent-files list only records the files you **opened**; Knit scans **the whole project
   folder** — restart DSH, open a new session, come back days later, and it is still there.
2. **Order**: it sorts by time; Knit sorts by **what you are talking about** — discuss architecture and
   the architecture docs rise; discuss a loader bug and `plugin-loader.ts` rises.
3. **It does not stop at finding**: after finding comes **organising** (three tiers, each with a
   verifiable reason) and **tracking** (which were really read, and whether they changed).

**No model calls, no network**: all plain string work, no latency, no cost, nothing leaves the machine.

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

**Upgrading**: same command as installing, and the same restart + hard-refresh afterwards.

---

## Features

| | |
|---|---|
| **Code Context** (v0.19): source files join the **same** retrieval pipeline as documents — classify, BM25, Context Pack, lifecycle. A dedicated classification layer decides what a file *is* and what it may do, so extension knowledge lives in exactly one place | ✅ |
| **Sorted by relevance to the current conversation** (BM25 + IDF, fully local, no model) | ✅ |
| **The `knit_docs` tool for the agent**: the model can look up this project's most relevant documents itself | ✅ |
| **Document lifecycle** (v0.17): each recommended document is shown as `Unread / Read / Updated after read / Re-read after update`, alongside the most recent read, how many reads fell outside the pack (expandable to which ones), and the latest context change | ✅ |
| One-click toggle between relevance / modification time (preference kept in localStorage) | ✅ |
| Scans **documents and code** in the session workspace (recursive, depth ≤ 6, skips `node_modules` / `.git` / `dist` / `build` / `out` / `coverage`) | ✅ |
| Each row shows H1 title (or filename) + relative time + first-paragraph summary | ✅ |
| The document list is **always one column** (v0.14 — the multi-column layout was deleted outright, not switched off); the **number sits in its own column on the far left** and is **vertically centred with the title line**, everything else stacks to its right starting with **one line: Primary dot + title + relative time** (the time is pushed to the right edge), then the summary. **The path is no longer shown in the list** — it duplicates the clickable **path** in the preview header, which is the one that stays | ✅ |
| Click to preview inline, click again to collapse | ✅ |
| Relative-path images actually render (`./img/a.png`, `../assets/b.png`) | ✅ |
| One-click switch between **Docs / Code / Media / All** (v0.19 adds Code; remembered, defaults to Docs); the selected tab is an **underline tab**, deliberately different from the list row's grey fill | ✅ |
| Images & video: square thumbnail grid — cells have a **fixed 104px baseline independent of the item count**, columns come from CSS `repeat(auto-fill, minmax(104px, 1fr))`, and **as many rows as there are items are laid out** (no max height, the grid never scrolls itself — scrolling belongs to the list); videos auto-grab the first frame with a play glyph and duration badge (no deps, no transcoding) | ✅ |
| **"Web preview" for `.html`** (v0.19): the preview header hands the file to DSH's own document-preview tab (`openResource`) instead of showing source; the inline preview still shows source, so the two do not duplicate. Knit itself sends no request | ✅ |
| Click an image / video to preview **inline**: large image, playable & seekable video streamed over HTTP Range (no full download) | ✅ |
| The **All** view splits into **three stacked sections**: docs (max 4, with "View all →" when truncated), **code** (max 4), then images & video (**never truncated**, count only) | ✅ |
| Preview pane is height-draggable (20%–80%, remembered), fullscreen-able, `Esc` to exit | ✅ |
| **"Open locally"** opens the document in your default app; the **path in the preview header is clickable** and now opens the system file manager with the file **selected** (`action:'reveal'`), and its tooltip carries the full relative path | ✅ |
| Double-click opens in a new tab (the official document preview, with its PDF renderer and renderer switching) | ✅ |
| Filter box over title / summary / path | ✅ |
| **Click the workspace path** to open the project folder in your file manager | ✅ |
| **Hover the entry button to peek**: a read-only floating list of the 5 most recent docs; click to open the right sidebar (doesn't push the layout; the popover is just header + list — no extra divider or hint line) | ✅ |
| Keyboard: `↑` `↓` move-and-preview, `Enter` toggle, `Esc` collapse (`←` `→` span rows in the **media grid only** — the document list is always one column, so they have no spatial meaning there) | ✅ |
| Auto-refresh every 5s plus a manual button; docs changed in the last 2 min get 🆕 | ✅ |
| Bilingual (zh/en), follows the DSH language live — no plugin reload needed | ✅ |
| Zero model calls, zero network egress | ✅ |
| **A `knit_docs` tool for the agent** — read-only, so the model can find this project's relevant docs itself | ✅ |

> Relevance is deliberately **not visualised** (no percentages, no bars) — the ranking itself is
> the answer; position is relevance.

### The other two views

![Screenshot of the Media tab: a square thumbnail grid, six columns at this panel width](https://raw.githubusercontent.com/PolinniZhong/dsh-knit/main/docs/screenshot-media.png)

*Media: square thumbnails, with the **column count following the panel width continuously** —
six columns at this width, cells about 110px. These are the workspace's real image and SVG files; this
particular workspace happens to hold several screenshots, one demo GIF and one single-colour SVG icon
(the solid black square is that icon, not a failed load). Videos get their first frame as a poster with
a play glyph and a duration badge — this workspace simply has no video, so none shows here.*

![Screenshot of the All tab: the documents section, the code section, and the media grid below](https://raw.githubusercontent.com/PolinniZhong/dsh-knit/main/docs/screenshot-all.png)

*All: the documents section shows at most 4, the **code section** shows at most 4 (each gets its own
"View all →" when truncated — here "4 / 19" and "4 / 17"), and the media grid comes last.*

⚠️ All three sections share the **same 40-item window** the host returns — a category that ranks past
40th by relevance drops out of the All view entirely. This screenshot uses the **Newest** sort: in this
workspace, under the default Relevance sort, media rank outside that window every time (at `limit=40`
those 40 rows are 34 documents + 6 code files). The **Media** and **Code** tabs are unaffected — they
request their own kind. A known defect, with reproduction and the fix recorded in
[`docs/README.md`](docs/README.md).*

---

## Current task context (v0.14)

Ranking answers "which documents look most like this conversation". But the question you
usually have is a different one:

> **For this task, what in the project should I read first?**

The Context Pack is the answer to that question, but it is a **data-layer structure**
(Primary / Supporting / Related, each entry carrying a deterministic reason) — **not a card of
its own**. So it lands directly in the document list: in relevance mode the document view goes
from one flat list to **three tier groups**, each group name followed by a very short hint.

```
┌─ Documents ──────────────────────────────┐
│ Primary          read first              │
│   01 ● Relevance ranking algorithm 5m ago│
│      title matches: ranking              │
│                                           │
│ Supporting       supporting              │
│   02  Ranking evaluation set       2h ago │
│      body matches: term counting         │
│                                           │
│ Related          background              │
│   03  CHANGELOG.md                 12d ago│
│      body matches: ranking               │
└───────────────────────────────────────────┘
```

> The sketch leaves out each entry's summary. **The real structure is: a number in its own column
> on the far left (vertically centred with the first line), and to its right a stack of one line —
> Primary dot + title + relative time (right-aligned) — then the summary** (**no path** — it is not
> shown in the list; the path lives in the preview header, with the directory collapsed to `…/`). And the list is
> **always one column** however wide the pane gets.

**No rules between groups**: hierarchy comes from 16px of space, the group name and type size,
never from separators. No scores, no percentages, no stars — "why is it here" states
deterministic facts only.

> **The right-hand "Current task context" panel has been removed** (2026-09-29). It said the same
> thing the three groups already say (the task sits in the quiet meta line above the list, the hit
> count duplicates the header total, and the three evidence kinds *are* the three group names), it
> added little visually, and it pushed Knit toward being an AI dashboard. Its
> resize / pull-out / snap-to-right-edge behaviour went with it — see `CHANGELOG.md`.

### The tiers are deterministic rules, not an AI judgement

| Tier | When a document enters it | Cap |
|---|---|---|
| **Primary** | It matched, **and** it is *grounded* (a topic term hits its title or summary), **and** its relevance is not background noise (≥ 30% of the top score) | 1 |
| **Supporting** | It has a **deep hit** on a *focus term* (that term is discussed in more than one document, and this document discusses it the most); **or** it is linked to a primary document (either direction, labelled separately) | 3 |
| **Related** | Everything else that matched, plus zero-hit link neighbours | 5 |

A cap is a **ceiling, not a quota**: primary is allowed to be empty (on real workspaces a fair
share of topics genuinely have no document that discusses them), and so is related. **If there
is no checkable reason, the document does not appear** — a document with zero hits and no link
is not "related to the current task"; the only caption it could carry is "this might help you",
which is exactly what this release refuses to print.

**"Why it is here"** is always a checkable fact:

| Reason | What it says |
|---|---|
| title / summary / body matches the topic: `term` | It really matched, and here is which term |
| referenced by a primary document | A path in the primary document points here |
| references a primary document | It mentions the primary document |

There is **no** "the AI thinks this matters" and **no** percentages, stars or confidence bars.

### Boundaries (stated, not oversold)

- **A link is not "more relevant".** Measured: the link graph does not close the vocabulary-mismatch
  gap. So a link can only place a document in supporting / related — **never** in primary.
- **The ranking engine is unchanged.** This release adds a projection layer *above* ranking;
  BM25 scoring and its evaluation (top-1 / MRR / trap cases) are untouched. If retrieval never
  surfaced the right document, tiering can only tier what was surfaced — it cannot fix recall.
- **No task understanding.** The "Current task" line in the panel holds the **verbatim text of the
  most recent user message**, not a summary of it — Knit does not interpret the sentence, it just
  puts it where you can see it. Actually summarising it would need a model, and Knit calls none.

---

## Code as context (v0.19)

Until v0.18 Knit understood Markdown, images and video. v0.19's product concept becomes
**documents / code / media** — not "a few more extensions", but letting Knit put the source files an
AI-coding task actually needs into the same Context Pack, on the same main line:

```text
Current task -> Workspace Retrieval -> Document + Code Candidates
   -> Primary / Supporting / Related -> Context Pack -> Agent Read
   -> Read Evidence -> File Changed -> Lifecycle -> Context Epoch / Delta -> Usage Lens
```

- **One classification layer, not scattered `if (ext === '.js')`** — `src/host/classification.js`
  turns a filename into `{ kind, language, previewable, searchable, contextual, generated,
  sourceMap }`. The scanner, retrieval, preview and UI all just read that verdict.
- **Supported in v0.19**: `.js .mjs .cjs .ts .tsx .jsx .py .json .html .htm .css .scss .yaml .yml
  .sh .bash .zsh`. **Not yet**: `.go .rs .java .kt .c .cpp .h .hpp .cs .php .rb .swift .sql`.
- **Code gets its own field weights** — filename x4, path x2, body (first 8 KB) x1, instead of the
  document weights (title x4 / summary x2 / body x1). A filename like `context-manager.ts` carries
  the task signal.
- **Generated files are not context**: `.map`, `*.min.js`, `*.min.css`, `*.bundle.js`,
  `*.generated.js`, `*.gen.js`, `*.lock` classify as `generated` — previewable, but never in
  retrieval, the Context Pack or the Usage Lens. When `app.js` and `app.js.map` both exist, the
  `app.js` preview offers one low-key **"Source map"** entry; the `.map` never shows up as a row.
  **Context eligibility is not file-system visibility** — the built-in file tree still opens them.
- **Bounded and capped**: at most `MAX_CODE = 300` code candidates and a head-limited body read, so
  a large repo cannot flood the Markdown corpus. Corpus pressure is the thing to watch in this
  version, not recall.
- **The type tabs become four**: `Docs / Code / Media / All`. The Code tab is **still driven by the
  current task** — it is not a file tree of the project.
- **No second engine**: no second retrieval path, no second lifecycle, no second store, no new
  dependencies, no AST, no LSP, no embedding, no model call, no network, no IDE.

---

## Also for the agent: the `knit_docs` tool

The same ranking that you see in the panel is also exposed to the model.

Once installed, the agent's tool list gains `knit_docs`: it can ask *"which documents in this
project are most relevant to what we're discussing?"* and get back **the same Context Pack** the
panel shows — the `primary` / `supporting` / `related` tiers, each item carrying its path, title,
summary, a **structured reason** (`direct` / `titleMatch` / `summaryMatch` / `bodyMatch` /
`linkTarget` / `linkSource` / `related`), its **project role** (`impl` / `test` / `config` /
`design` / `doc`) and the matching snippet — then open one of them with its own `read` tool.

**Why it helps**: to cite a document that already exists, an agent can only guess paths or glob
and `read` them one by one. Knit has **already computed that ranking** every refresh; this tool
just hands it over — what it removes is **the "which few are relevant?" guess** (measured: an
agent holding the Pack no longer globs for candidates).

**Read-only, and it stores nothing**: it reads the files that are already in the project — this is
not "memory". The difference from memory plugins is that **theirs start empty** (the agent has to
have saved something first), while Knit has the whole project's history from the moment you install it.

Three details:

- **No relevance score in the result.** It is a *relative* score (something is always 100%, and it
  may be a different document on the next refresh); shown to a model it reads as absolute confidence.
  **The order is the relevance** — the same rule the panel follows.
- **No document bodies.** The agent has its own `read` tool; Knit *finds*, it does not *carry*.
- **No workspace means an error, never a fallback.** The HTTP route falls back to the process cwd
  when a session can't be resolved (for older clients that send no session id); the tool has no such
  baggage — falling back would scan an unrelated project and return *its* documents.
  Better to fail than to return the wrong thing.

> ⚠️ **The cost, stated plainly**: the tool description goes into the **system prompt of every
> request**. Installing Knit costs a few extra tokens per session. That is the price of giving the
> agent the capability.

---

## Did it actually get used? (v0.16 → v0.17)

Knit orders "what to read first right now" — but **whether that order was right could only be felt,
never checked**. v0.15 added a layer of **verifiable usage feedback**: the files the agent really read,
matched against the context pack that was in effect **at the moment of the read**.
v0.16 nails that down: **attribution is settled and frozen at read time** — however the context
changes later, the historical numbers never change their story (in v0.15 a read could be
re-judged as "outside" by the present, which was a bug).

**Off by default.** There is a "Usage" toggle in the panel head; turning it on adds a lightweight
**lens** above the list (called the Usage Lens since v0.18 — see "reading the usage" below).
Its top line still reports facts only:

```
Usage                                         Epoch 5   ˄
174 reads · 28 outside the pack · context changed 3×
```

- **Context Epoch**: one **content-changed** context equals one epoch (identical content creates
  none, so polling cannot flood it). `Epoch 4` is a cumulative number, not "the 4th pack".
- **Two fact-only fields**: `continuedReadAfterExit` (it was still read after leaving this context)
  and `reEntry` (it left, came back into the pack, and was read again). They must **never** be read
  as "the agent rejected the new context" — that is inference, not fact.

It reports **facts only**: was the primary doc read, how many reads happened, how many fell outside
the pack, how often the context changed. **No score, no percentage, no progress bar** — these numbers
are counted, not estimated.

Three boundaries:

- **Off by default**: while it is off, Knit **counts nothing** (it subscribes to the host event
  stream, but the callback bails out on the first line for unaudited sessions — one Map lookup).
  That accounting is the user's call, not ours.
- **No duplicate of the DSH trajectory**: the only evidence source is the `tool/call` / `tool/result`
  events the session **already has** (successful `read`s). **No new event bus, no runtime trace,
  no event store.**
- **One backfill when you flip the toggle**: the subscription is the sole read-evidence source (the
  old `session.snapshotEvents()` is deprecated by DSH, and no new production call was added), so reads
  that happened before the gate opened were genuinely invisible to Knit. Since v0.17 the moment the
  toggle flips, the host **backfills once** the events this session already produced — which turns
  "Unread" into a claim with evidence behind it. ⚠️ Backfilled reads are attributed to the *earliest
  pack we know about* (earlier packs are unknowable).
- **Nothing is persisted**: the numbers live in kernel memory only and are gone after a DSH restart —
  do not treat them as long-term statistics.

Agents get the same thing optionally: `knit_docs` accepts `audit: true` (default `false`), which
appends one line, `Usage since the last pack: …` (a report on the **previous** pack).

To check offline: `node tools/context-feedback-eval.mjs` replays the latest real session log;
`--control` is the "deliver no pack at all" arm. ⚠️ It splits "outside the pack" in two —
**in Knit's index but not in the pack** (a real miss) versus **not in the index at all** (`.js` /
`.json`, which Knit never indexes). Without that split the outside ratio stays high and reads like
"the Context Pack is useless", when in fact **the wrong thing was measured**.

### v0.17: what state is a document in, after it has been read?

Turning "Usage" on adds two more things besides the counts: **a status on each recommended
document**, and "which one was read last / what was read outside the pack / how the context last
changed".

> ⚠️ The ASCII below is the **v0.17 shape** of this UI. v0.18 rebuilt it into the Usage Lens above
> the list (next section) — **the criteria, the four states and the data sources did not change**;
> this section is about the data and the judgement.

```
Context · Epoch 4
Recently read: SDD-v0.17.md · 12 min ago

Primary
01 ● SDD-v0.17.md        Read ×3
02   feedback.md         Unread

Supporting
03   context.md          Read
04   eval.md             Updated after read

Related
05   README.md           Re-read after update

Read outside the pack · 2        ← clickable: which ones
Context just changed             ← clickable: Entered / Left / Moved tier
```

All four states are **facts**, not scores:

| Label | The fact |
|---|---|
| Unread | No successful `read` in this session |
| Read / Read ×N | It was read successfully, and the file has not changed since the last successful read |
| Updated after read | The file's `mtimeMs` changed after the last successful read |
| Re-read after update | It changed and was then read successfully again (another change drops it back one state) |

- **The evidence is the file's `mtimeMs`** — which the workspace scan already collects — so nothing
  compares content, scans full text, or adds an index. When mtime is unavailable, **no claim is made**
  (it stays at "Read").
- `grep` / `glob` / `bash` do not count as reads, and neither does a failed `read`.
- "Recently read" is decided by event sequence number and is **never called "currently reading"**:
  Knit cannot prove the agent is still reading it. If it falls outside the Context Pack, it is still
  shown as-is.
- **Read outside the pack · N** expresses only "this document is not in the current pack, but the
  agent did successfully read it" — never "Knit missed it", and no recall rate, hit rate or
  context-quality number.
- **Context just changed** shows only the **single latest** delta (`+` entered / `-` left /
  `↔` moved tier; a changed task adds one line, "Task context updated") — **no timeline, no event
  explorer**.
- The status sits between the title and the time, and **the title stays the visual anchor**: no red
  or green, no score. With the toggle off, **none of it appears** (and nothing is counted).
- **The list no longer flickers** (requested 2026-10-03): a row that was just read fades in from
  below, a row squeezed out is wiped away **top-down**, several at once stagger by 45ms (6 steps at
  most), and a row that changed tier or rank **flies there from where it was** (FLIP, 340ms).
  Nothing is animated on first paint, when the kind / sort / query changes, or when the system asks
  for reduced motion. This is not a new feature — it only makes "who arrived, who left, who moved"
  visible. Indexing, ranking, tiers and the `knit_docs` output are unchanged.

### v0.18: reading the usage (Context Usage Lens)

v0.17 had all the information, but **crammed into one line and a few collapsed blocks** — you could
not read the structure: which tier got read, which document was read last, which of those twenty
outside documents were read over and over, whether the last change was an arrival or a departure.
v0.18 rebuilds it as a lightweight **lens above the list** — not a dialog, not a new page, and not a
dashboard:

```
Usage                                         Epoch 5   ˄
174 reads · 28 outside the pack · context changed 3×
Current context
  Primary  1 / 1        Supporting  2 / 3      Related  0 / 5
  ●                     ● ○                   ○ ○ ○ ○ ○
Recent read       docs/eval.md                  12 min ago  ›
Reads outside context                                      20  ›
Context changes                                      Latest  ›
```

- **Current-context coverage**: each tier gives "a state dot + `read / total in that tier`". Clicking
  a tier scrolls to that tier and **flashes it briefly** (no arrows, no rules — space says "here").
  **Facts only**: no progress bar, no percentage — Knit does not judge whether a context is "used up",
  and when there is no Primary the whole column is hidden rather than drawing a fake `0 / 0`.
- **Inline state dot**: unread = hollow circle / read = filled circle / updated after read = filled
  circle with an inner ring / re-read after update = `↻`, shown **alongside** the text (the dot states
  the state, the text states the count). Clicking it opens that document. No red/green, no badge.
  The coverage dots and this one share **the same tokens and the same 6px diameter** — one state language.
- **Recent read** is a clickable fact row (`file · relative time ›`) that opens that document directly
  and **does not refetch the list**. It is still "the **last successful read**" — never "currently reading".
- **Reads outside context** shows up to 10 by default plus "N more"; every row is clickable and carries
  its state, sorted by **most-read first** (`count DESC`) — a fact order, not a relevance score. You
  **cannot** promote a document into the context from here (V0.18 does no context control).
- **Context changes** is collapsed by default; expanding groups it into Entered / Left / Moved tier,
  at most 5 per group, and only the **latest** delta is shown.
- The lens itself expands / collapses. **Collapsing is not turning usage off** — collapsing means
  "counting, but I do not want the details"; switching the toggle off produces no usage DOM at all.
- On a short panel (< 420px) it degrades to summary + coverage + recent read; the change details are
  still one click away, and **scrolling always belongs to the list** — there is no second scroll
  container, so a narrow sidebar never gets scroll-inside-scroll.

Not one new fact was added: everything comes from the v0.17 `lifecycle / recentRead / outsideDocs /
latestDelta` fields plus the current `context` tiers, and coverage is **derived** from them (pure
functions `coverageOf` / `groupOutsideDocs` / `groupDelta`).

The `knit_docs` tool output **did not grow**: it still only finds context.

---

## How retrieval works (implementation, not the pitch)

> This section is **evidence**, not the sales pitch: it is what backs the claim "ranked by the
> current task". The product question is answered on the first screen; this answers "why is it
> any good at ranking".

No magic, just string operations. Three steps:

**1. Read the conversation.** The host takes the last 6 user/assistant messages, and only
counts real user messages (`agent.inject()` synthetic context would drag the topic off course).
Newer messages weigh more: 3 / 2 / 1 / 1 …

**2. Extract keywords.**

- **ASCII words** — high value, one occurrence is enough (`chokidar`, `mtime`)
- **Chinese 2/3-grams** — either occurring twice, or appearing in the newest message
- **Drop fragments that straddle a word boundary.** Chinese has no word boundaries, so
  n-grams glue the last character of one word to the first of the next (「图片和」, 「个插」,
  「的排」). They share one trait — **the first or last character is a pure function word** —
  and are dropped. Leave them in and they fill every candidate slot, pushing the real words
  (「图片」, 「排序」) out of the query entirely
- stop-word filtering plus greedy de-overlap (picking「相关性排序」drops「相关性」and「排序」)

**3. Score the documents — BM25.**

```
IDF per term first: rarer in the corpus means more valuable
                    ln(1 + (N - df + 0.5) / (df + 0.5))
then a weighted sum over fields: title ×4  +  summary ×2  +  first 2500 chars of body ×1
each field saturated and length-normalised (k1 = 1.2, b = 0.3 / 0.5 / 0.75)
plus a 10% recency nudge (relevance still dominates)
```

**Why BM25 and not "hits × weight"** (the original approach, since replaced):

- with no IDF, a term that appears **everywhere** (the project name) is worth as much as a
  rare one — so the frequent term discriminates nothing and dilutes the rare ones
- with no length normalisation, **a long document wins by piling up hits**
- capping hits at 6 was a hand-drawn knee; `k1` / `b` exist precisely for this

Measured on `test/eval/fixture.mjs` (21 cases, both engines on the same corpus):

| | top-1 | MRR |
|---|---|---|
| old (weighted hits) | 76.2% | 0.830 |
| **BM25** | **95.2%** | **0.976** |

That eval runs inside `npm test`, and the baseline is **recomputed each run** from the old
engine frozen in `test/eval/legacy.mjs` — so "the new engine must be clearly better" is
verified automatically rather than asserted against a hard-coded number.

**Against counting keywords yourself** (`knit/tools/scale-benchmark.mjs`, N = 20/60/180/540):
the corpus is built with a real trap — 12 short, focused topic documents, plus a pile of long
distractors that mention every topic five times without explaining any of them (which is what a
real project's CHANGELOG looks like). Half the topic documents have descriptive filenames, half
are opaque.

| Approach | Descriptive filenames | Opaque filenames | MRR vs. scale |
|---|---|---|---|
| **Knit (BM25)** | **100%** | **100%** | **1.000 (flat)** |
| `grep -c` keyword counting | 17% | **0%** | 0.313 → **0.089** |
| Filenames only | 100% | **0%** | 0.602 |

Three things: **the ranking beats counting keywords yourself** (so having the agent recompute it
is irrational); **filename matching only works when names describe content**, and Knit is the
only approach that scores 100% either way; and **self-counting degrades as the corpus grows**.

**About the "sorted by「xxx」" line**: it shows the **span of your own text** that the matched
terms cover, not the raw candidate tokens. Chinese has no word boundaries, so candidates always
include fragments that straddle two words (「项目文档」 yields `项目文` / `目文档`), and showing
those renders as gibberish — merging their spans and slicing the original text recovers `项目文档`.
The label is **your own wording**, so its casing is preserved (type `BM25`, see `BM25`).

All of it is string arithmetic — **no embeddings, no model calls**.

**And the honest boundaries**:

- **With only one or two messages** there are too few keywords, so it falls back to sorting by
  modification time and says so in the panel — it does not pretend to rank
- **With only three to five documents IDF barely does anything**: `df` only takes a few values,
  so its dynamic range collapses. The more documents, the better this ranking gets
- **It can only rank documents that share vocabulary with the conversation**: if no term matches,
  every document scores the same and the order degrades to time

---

## What it reads, and what it doesn't

- Scans Markdown, **supported code files** (see the v0.19 list above) and media **inside the current
  session workspace** (anything resolving outside is rejected); for media it reads metadata only,
  never the pixels, and for code it reads a **bounded head** of the body, never the whole file
- **Generated / noisy files are excluded from context** (`.map`, `*.min.*`, `*.bundle.*`,
  `*.generated.*`, `*.lock`): they classify as `generated`, so they never enter retrieval, the
  Context Pack or the Usage Lens — but `/knit/api/doc` still serves them when you open one on purpose
- Reads only **the current session's** conversation events (used for ranking)
- The `knit_docs` tool is **read-only**: it writes no files and persists no index
- v0.15 usage accounting is **off by default**: when enabled it reads only the **current session's
  existing** tool events (successful `read`s) — still no file writes, no persisted counters, gone on restart
- **Makes no outbound network requests**: the client's `fetch` calls all point to
  the plugin's own same-origin routes
- **No install-time scripts** (no `install` / `postinstall`)
- **Zero dependencies** — nothing to build, no build-authorisation prompt
- The media route only allows an **image/video-extension allowlist** (images ≤ 12MB,
  video ≤ 256MB), serves video over HTTP Range, and responds with
  `nosniff` plus `default-src 'none'; sandbox`; the **text route serves documents, code and
  generated artifacts**, and refuses media and unknown extensions

The relevance figure only affects ordering — it is **never displayed and never sent anywhere**.

> Every claim above is guarded by an automated check, listed one by one in
> **[SECURITY.md](SECURITY.md)** — each property points at a test that actually exists.
> `npm test` verifies that the table itself has not rotted.

---

## Known limitations

- **Short conversations degrade the ranking**: one or two messages give too few keywords, so it
  falls back to modification time and says so in the panel
- **Chinese segmentation is n-gram approximation**: no tokenizer dependency was added. Fragments
  that straddle two words are dropped when they start/end on a function character, and the
  remaining hits are **merged by their spans** back into real words — but an **isolated fragment**
  (like 「视频上」, with nothing overlapping to merge with) can still appear in the
  "sorted by「xxx」" line
- **The right sidebar's default page becomes the guide**: DSH's rule is "if there's exactly one
  guide entry, open it directly"; the built-in Files entry takes that slot, so expanding the
  sidebar shows the guide first and Knit needs one more click on its pill
- **Media is limited to common formats and sizes**: images `png/jpg/jpeg/gif/webp/avif/bmp/ico/svg`,
  video `mp4/m4v/webm/mov/ogv`; images ≤ 12MB and video ≤ 256MB or they are not listed
- **Media matches relevance by filename only**: no visual/audio content is parsed — give
  screenshots and recordings searchable names
- **What we measured is *locating*, not *saving work***: in the on-machine A/B (frozen protocol,
  four questions), an agent that could call `knit_docs` did **not** explore less — Control 4.75 →
  Treatment 6.0 total tool calls, and no single question went down. The Pack did replace the
  initial `glob` for candidates, but the **doubled `read` count** ate that back. It points
  attention at the right file; that is **not** the same as the agent reading fewer files
- **Right-sidebar state is memory-only**: a refresh or a new session collapses it again

---

## Feedback

**Right now this project is not about adding features — it's about finding out whether
"rank project docs by the current conversation" is something anyone actually uses.**
So the most valuable thing you can send is not "could you add X" but **how you work around
this today** — including "I installed it and never opened it", which is more useful than a
feature request.

- 💬 [Tell us when you actually open it](https://github.com/PolinniZhong/dsh-knit/issues/new?template=feature.yml) — two fields, thirty seconds
- 🐞 [Won't install / panel won't open / ranking looks wrong](https://github.com/PolinniZhong/dsh-knit/issues/new?template=bug.yml)
- 📖 Check [known limitations](#known-limitations) first — short conversations degrade to time order and Chinese uses n-gram approximation; those are deliberate trade-offs, not bugs

> A single issue is treated as a real signal. So far this plugin has **no trace of a single
> real user** — the npm download count is automated version enumeration, not people
> (only 14% of it is `latest`, and a human install only ever pulls `latest`). One human reply
> changes what gets built next.

---

## Development

```sh
git clone https://github.com/PolinniZhong/dsh-knit.git
cd dsh-knit

npm test          # 588 tests, zero dependencies, no npm install needed
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
│   ├── host/index.js     # /knit/api/recent · /doc · /raw · /links · /context
│   ├── host/relevance.js # the relevance engine: BM25 + keyword extraction
│   ├── host/links.js     # reference parsing (pure; never touches ranking)
│   ├── host/classification.js # v0.19 file classification: kind / language / searchable / contextual
│   ├── host/context.js   # context assembly: the three-tier Context Pack (pure, zero I/O)
│   ├── host/feedback.js  # usage feedback: read-time attribution / Context Epoch / delta (pure)
│   ├── host/tool.js      # the agent tool knit_docs (hand-written ToolDefinition)
│   └── client/client.js  # dual-host registration + panel UI
└── test/                 # 588 tests
    ├── eval/             # retrieval quality: corpus + cases + frozen v0.5.2 baseline
    └── context/          # context tiering: 24-doc corpus + 12 real-task cases
```

Details and trade-offs live in the source comments; see [CONTRIBUTING.md](CONTRIBUTING.md)
for the contribution flow and [CHANGELOG.md](CHANGELOG.md) for the version history.

> Versioning: `0.x` means the feature set still moves and breaking changes are possible.
> `1.0.0` waits until **real retention is validated** — not merely "features are done".

## License

[MIT](LICENSE) © Polinni
