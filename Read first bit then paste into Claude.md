You can paste this into Claude if you want it to have full understanding of how everything in the Dashboard works. This makes editing the Dashboard much easier

# Development Notes — GLC Sales Dashboard

This document captures the reasoning, bugs, and decisions behind this project
that aren't visible just from reading the code. If you're a new owner (or a
Claude conversation helping one), read this before changing anything —
several things in this codebase look like they could be simplified or removed,
and aren't, for reasons documented below.

This is not a memory transfer — no AI memory carries over between accounts.
This is a written record of what was learned, so it doesn't have to be
re-learned.

---

## Why the architecture looks the way it does

**Agents write data and prose; they never write code.** The dashboard's logic
(`dashboard.html`) is never touched by any automated process. Only
`data.js`, `snapshot.json`, `commentary.js`, `reminders.js`, and
`CHANGELOG.md` get rewritten automatically. This was a deliberate, early
decision: letting an LLM regenerate the whole dashboard file weekly would
eventually corrupt a chart function or drop a feature with no one noticing
until someone asked "why does this look wrong." Everything computed and
displayed (KPIs, cohort success rates, leaderboard, coaching cards) is
calculated **live in JavaScript** from whatever's in `data.js` — nothing is
pre-baked by an agent. The only genuinely AI-generated content that reaches
the dashboard is the changelog, narrative insights, and note-based reminders
— all clearly scoped, all with hard validation guards (see below).

**Why the tracking window is dynamic, not hardcoded.** It was hardcoded to
19 Jan–2 Jul initially. This required someone to remember to update it every
week, which is exactly the kind of manual step this whole project exists to
eliminate. It now recalculates from the latest logged meeting on every page
load — see `TRACK_TO_DATE` / `TRACK_TO_WEEK` near the top of the dashboard's
script.

**Why "successful meeting" = New lead created + Proposals issued + Deal
progression.** This definition is used consistently everywhere (cohort
success rates, the leaderboard, coaching cards, recurring-client tables) via
one shared constant, `SUCCESS_OUTCOMES`. It was originally just "New lead
created + Deal progression" (excluding Proposals) — changed on explicit
request. If this definition ever needs to change again, changing the
constant is sufficient; every dependent calculation reads from it.

---

## Bugs found during build — and why the fixes look the way they do

### 1. `git add` silently drops everything if one file is missing

**This was the single biggest time-sink in the whole project.** The original
commit step did:
```bash
git add data.js snapshot.json unmapped-values.json rejected-records.json
```
`rejected-records.json` and `unmapped-values.json` only exist when there's
something to report — most weeks, neither exists. Git's behaviour: if you
name several files in one `git add` and even one doesn't exist, **the whole
command fails and stages nothing at all** — not even the files that did
exist and did change. Combined with a `2>/dev/null || true` meant to handle
"nothing to report" gracefully, this silently swallowed a real failure. The
result: extraction would succeed, compute genuinely new data, and then the
commit step would report "No changes detected" — even though the data had
in fact changed. This looked exactly like a Monday.com sync failure and was
chased as one for a long time before being found. It was proven with a
sandboxed git repro (stage two changed files + one missing file named
explicitly → confirmed zero files staged), which is how the real cause was
finally pinned down.

**The fix, now in place:** every `git add` in the workflow adds files
individually, guarded by existence checks:
```bash
git add -- data.js snapshot.json
[ -f unmapped-values.json ] && git add -- unmapped-values.json
[ -f rejected-records.json ] && git add -- rejected-records.json
```
**If you ever add a new optional output file to the pipeline, add it to the
commit step the same way — never as part of a combined `git add` list.**

### 2. Monday.com's API is eventually consistent, not instant

`items_page` reads from a search index that lags slightly behind the real
board state. A row inserted at the very end of a board can be briefly
under-indexed — not just missing itself, but occasionally causing a handful
of *other*, older items to also drop out of the API response for a short
window. This was proven by a real experiment: adding a row mid-board
triggered a full reindex (everything showed up correctly); appending at the
tail intermittently returned an incomplete set, including dropping unrelated
existing rows.

**The fix:** `fetchBoard()` in `extract.js` calls the API twice, ~10 seconds
apart, and takes the union of both responses by item ID. This isn't a
theoretical fix — it was tested against a simulated version of the exact
failure (one fetch missing 4 tail items, a second fetch missing 2 different
items) and confirmed the merge recovers the complete, correct set.

**Consequence for testing:** if you manually add a Monday.com row and
immediately run curl or the workflow to check it landed, you may see
flickering, inconsistent results for a few seconds/minutes — this is
Monday.com's index catching up, not a bug in this pipeline. Don't chase it;
wait ~30 seconds and check again, or trust the pipeline's own retry.

### 3. GitHub Actions' built-in cron scheduler doesn't reliably fire

Confirmed via direct testing: a workflow with a valid `schedule:` trigger
(checked repeatedly, including at 5-minute intervals for an extended period)
never fired on its own, while manual `workflow_dispatch` triggers worked
100% of the time. This matches GitHub's own documentation, which explicitly
describes scheduled runs as best-effort and states they can be delayed or
dropped entirely under load, particularly at the top of the hour.

**The fix:** an external service (cron-job.org) calls GitHub's REST API
directly at the scheduled time, hitting the same `workflow_dispatch`
endpoint the manual button uses. GitHub's own `schedule:` trigger is left in
the workflow file as a harmless backup (a `concurrency` group prevents it
from ever racing the external trigger if it does fire).

**If email or data updates ever silently stop arriving**, check the
cron-job.org job's execution history first — the most common cause is its
GitHub token expiring (fine-grained tokens have a mandatory expiry, ~90
days), not a problem with the workflow itself.

### 4. Concurrent/overlapping runs can cause push conflicts

Discovered while testing with an artificially frequent cron (every 5
minutes for diagnostic purposes): two overlapping runs can each check out
the repo, both compute a commit, and only the first push succeeds — the
second fails with a non-fast-forward rejection. Real cause: this was purely
a side effect of the aggressive test cadence and effectively can't happen
under normal weekly-or-daily scheduling.

**The fix, present as defense-in-depth regardless:** a `concurrency` group
(`weekly-sync`, `cancel-in-progress: false`) makes GitHub queue overlapping
runs rather than let them race, and both commit steps retry with
`git pull --rebase` once if a push is rejected.

---

## The AI agents — what they do and how they're kept honest

`agents/generate-insights.js` runs three prompts, always with explicit
"never invent facts not present in the input" instructions, and — because
prompts alone weren't fully sufficient (see below) — hard validation
in code:

1. **Haiku — changelog.** Given a diff of last week vs. this week, writes
   3–8 plain-English bullets. **Caught hallucinating on two separate runs**:
   it twice invented a monetary figure ("David Ives' numbers remain
   unchanged at $275k") despite there being no monetary data anywhere in the
   pipeline. The prompt was tightened to explicitly state the data contains
   no monetary values and to ban mentioning any figure not literally present
   in the input. Worth spot-checking `CHANGELOG.md` occasionally for
   anything similarly invented — a tightened prompt reduces but doesn't
   provably eliminate this class of error.

2. **Opus — narrative insights.** Given the changelog + full diff, writes
   3–5 short insights (conversion shifts, stalled clients, etc.) as strict
   JSON, tagged with a `scope` (which salesperson, or "Team"). Output is
   parsed and, if it isn't valid JSON, the whole step is skipped rather than
   guessed at — a broken response never reaches the dashboard.

3. **Haiku — reminders.** Given every record that has a non-empty note,
   decides which imply something actionable and writes one short reminder
   each. **This one has the strictest guard of all three**, because it was
   built after the changelog hallucination was already known: every returned
   reminder must reference a record ID that was genuinely present in the
   input; anything with an invented ID, a duplicate ID, or empty text is
   dropped in code, not just discouraged in the prompt. This was verified
   with a mock test where a deliberately misbehaving response (including an
   invented "$500k deal" reminder tied to a fake ID) had the fake reminder
   correctly stripped before reaching `reminders.js`.

**`reminders.js` is fully rewritten every run, never appended to.** This is
what makes "delete the note on Monday.com → reminder disappears next sync"
work — there's no state being tracked and cleared; the whole file is just
regenerated fresh from whatever notes currently exist.

All three agent calls are wrapped so that **failure is non-fatal to the
whole pipeline** — a bad API key, a rate limit, or a malformed response
means that week's commentary/reminders don't update, but the actual data
sync (which already completed earlier in the same run) is never at risk.

---

## Practical gotchas worth knowing before you touch anything

- **GitHub's "Run workflow" button is two clicks, not one.** Click it once
  to open a dropdown, then click the second, inner "Run workflow" button to
  actually confirm. Clicking only the first button and looking away does
  nothing — this caused a lot of "why isn't this running" confusion during
  development.
- **"Re-run" and "Run workflow" are different.** Re-run replays an old run's
  code exactly as it was at that commit. Run workflow uses whatever's
  currently on `main`. If you've just pushed a fix and want to test it, use
  Run workflow, not Re-run on an old run.
- **Deleting old workflow runs deletes your own diagnostic evidence.**
  There's rarely a good reason to do this — GitHub doesn't charge for run
  history, and the run log (including which trigger fired it — manual vs.
  schedule) is often the only way to diagnose a "why didn't this update"
  question after the fact.
- **A large single-line minified file (like `data.js`) can be genuinely hard
  to search reliably in GitHub's web-based blob viewer**, and browser
  Ctrl+F can silently fail to search text that hasn't fully rendered.
  Resizing the browser window mid-scroll can also visually cut off terminal
  output in a way that looks like missing data but isn't. When in doubt,
  save API output to a file and open it in a plain text editor rather than
  trusting a live terminal/browser view.
- **A fine-grained GitHub token scoped to one repo with one permission**
  (Actions: Read and write) is the right credential for an external
  scheduler like cron-job.org — never the broad classic token used for
  local `git push` authentication. Different trust environments call for
  differently scoped credentials.

---

## If you're extending this project

- Adding a new dashboard feature: edit `dashboard.html` directly, verify any
  new calculation against the raw data in `data.js` before trusting it (a
  quick Node script reading the JSON and cross-checking totals catches most
  mistakes before they reach the actual page).
- Adding a new automated output file: make sure the commit step adds it with
  an existence guard (see Bug #1 above) — this is the single most likely
  mistake to repeat.
- Adding a new AI-generated field: give it the same treatment as the
  reminders feature — validate every piece of generated content against
  real input data in code, not just via prompt instructions, and make
  failure non-fatal to the rest of the pipeline.
