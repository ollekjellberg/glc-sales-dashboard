[README.md](https://github.com/user-attachments/files/29787817/README.md)
# GLC Sales Dashboard — automated weekly sync, insights, and email

A sales performance dashboard for David Ives and Olle Kjellberg, backed by
their Monday.com boards, kept up to date automatically with no manual steps.

If you're taking over this project from someone else, read **`HANDOVER.md`**
instead — it's the step-by-step ownership-transfer guide. This file is a
reference for how the system works day to day.

---

## What's in this repo

| File | What it is |
|---|---|
| `dashboard.html` | The dashboard itself. Pure code — never touched by automation. |
| `data.js` | The dashboard's data. **Rewritten automatically every week.** Never edit by hand. |
| `snapshot.json` | Last sync's data, kept for week-over-week change detection. Auto-managed. |
| `unmapped-values.json` | Only appears if Monday.com has a cohort/type/outcome value the dashboard doesn't recognise. Auto-created/deleted. |
| `rejected-records.json` | Only appears if a Monday.com row has no usable date. Auto-created/deleted. |
| `scripts/extract.js` | Pulls both Monday.com boards and rewrites `data.js`. Deterministic — no AI. |
| `scripts/build-standalone.js` | Bundles the dashboard + its data into one file for the weekly email attachment. |
| `agents/generate-insights.js` | The only AI step. Haiku writes a changelog and turns salespeople's notes into reminders; Opus writes narrative insights. Writes only `commentary.js`, `reminders.js`, and `CHANGELOG.md` — **never** `data.js` or `dashboard.html`. |
| `commentary.js` | Agent-written insights, shown in the dashboard's "Weekly commentary" card. Absent until the first successful agent run. |
| `reminders.js` | Agent-written follow-up reminders (from meeting notes), shown at the top of the Attention section. Rebuilt from scratch every run — delete a note on Monday.com and its reminder disappears on the next sync. |
| `.github/workflows/weekly-sync.yml` | The automation pipeline itself (see below). |
| `HANDOVER.md` | Full ownership-transfer instructions for a new owner. |

---

## How the pipeline runs, end to end

**The trigger is external, not GitHub's own scheduler.** GitHub Actions'
built-in cron proved unreliable for this repo — scheduled runs simply never
fired, even when correctly configured (best-effort scheduling is a known
GitHub limitation). The reliable fix in use now: a **cron-job.org** account
calls GitHub's API directly every **Monday at 10:00 Asia/Dubai**, using the
same `workflow_dispatch` mechanism as the manual "Run workflow" button — which
has a perfect track record. GitHub's own weekly cron is still present in the
workflow file as a harmless backup; if it ever starts working, the
`concurrency` block prevents it from racing the external trigger.

Each run does the following, in order:

1. **Preserve last week's snapshot** for comparison.
2. **Extract** — pull both boards from Monday.com, validate every value
   against the dashboard's known categories. Anything unrecognised is left
   blank and logged to `unmapped-values.json` rather than guessed at. Rows
   with no usable date are skipped and logged to `rejected-records.json`.
   Monday.com's API is fetched **twice, ~10 seconds apart, and merged** —
   their search index is eventually-consistent and can briefly under-report
   items right after an edit; this self-heals that within the same run.
3. **Sanity check** — if either person's record count moves by more than 50%
   since last week, or drops by more than 10%, the run aborts without writing
   anything. This catches a Monday.com glitch before it can silently corrupt
   the dashboard.
4. **Commit** `data.js` + `snapshot.json` — only if something actually
   changed. No change, no commit, no downstream steps run.
5. **Generate insights** (Haiku + Opus) — changelog, narrative insights, and
   note-based reminders. Skipped entirely if step 4 found nothing to commit.
   Non-fatal if it fails: the data sync above is already complete regardless.
6. **Commit** `commentary.js` / `reminders.js` / `CHANGELOG.md`.
7. **Build and email** a self-contained copy of the dashboard to the address
   list in the `MAIL_TO` secret, sent via a Gmail relay account. Also
   non-fatal if it fails.

If a week has no changes on either Monday.com board, the whole thing after
step 3 is a no-op — no commit, no AI calls, no email. That's intentional, not
a bug.

---

## The five secrets this depends on

Settings → Secrets and variables → Actions:

| Secret | What it's for |
|---|---|
| `MONDAY_API_KEY` | Reads both Monday.com boards |
| `ANTHROPIC_API_KEY` | Powers the Haiku/Opus insight generation |
| `MAIL_USERNAME` | The Gmail relay account's address |
| `MAIL_PASSWORD` | The Gmail relay's app password (not its login password) |
| `MAIL_TO` | Comma-separated recipient list for the weekly email |

The **external scheduler** (cron-job.org) holds one more credential, but it's
outside this repo: a separate, narrowly-scoped GitHub token with only
`Actions: Read and write` on this one repo, stored in the cron-job.org job's
settings. It expires roughly every 90 days and needs manual renewal (see
Maintenance, below).

---

## Board and column configuration

Both salespeople's board IDs and column mappings live near the top of
`scripts/extract.js`, clearly labelled. If a board is ever replaced (not just
edited — an entirely new board), its column IDs will change even if the
labels look identical, and need re-fetching:

```bash
curl -s -X POST https://api.monday.com/v2 \
  -H "Authorization: YOUR_MONDAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "query { boards(ids: NEW_BOARD_ID) { columns { id title } } }"}'
```

Match each returned `title` to the right field in `COLUMN_MAP_BY_PERSON` and
update the corresponding `boardId` in `BOARDS`.

**The cohort/type/outcome whitelist** in `extract.js` must match Monday.com's
actual labels exactly (e.g. `Investor/End client`, not `Investor / End
Client`). A mismatch doesn't break anything — it just nulls that field and
logs it to `unmapped-values.json` for review.

---

## The dashboard's tracking window

The dashboard's date range is **dynamic**, not hardcoded: it always starts
19 Jan 2026 and automatically extends to whichever meeting was most recently
logged across either board, recalculated every time the page loads. No manual
adjustment needed as new weeks accumulate.

---

## Testing changes manually

**Actions** tab → **Weekly Monday.com sync** → **Run workflow** → confirm
inside the dropdown that appears (it's a genuine two-click action; clicking
only the first button does nothing). Watch the run's steps for errors — the
log messages are generally specific about what went wrong (wrong column ID,
bad token, email auth failure, etc.).

---

## Maintenance

- **Every ~90 days**: the cron-job.org scheduler's GitHub token expires.
  GitHub emails a warning first. Renew it (Developer settings → Fine-grained
  tokens → generate a new one with the same `Actions: Read and write` scope)
  and paste it into the cron-job.org job's Authorization header.
- **If the weekly email stops arriving** but the dashboard itself is still
  updating: check the Gmail relay's app password hasn't been revoked, and
  check spam/junk on the recipient side.
- **Never edit `data.js`, `snapshot.json`, `commentary.js`, or
  `reminders.js` by hand** — all four are fully regenerated by the automation
  on every run that finds a change, and hand edits will just be overwritten.
- **`dashboard.html` is always safe to edit** — the automation never touches
  it.
