[README.md](https://github.com/user-attachments/files/29701385/README.md)
# GLC Sales Dashboard — weekly Monday.com sync

This repo contains:

- `dashboard.html` — the dashboard itself. **You never need to edit this again.**
- `data.js` — the data the dashboard reads. Rewritten automatically every Monday.
- `snapshot.json` — last week's data, kept for change detection. Auto-managed.
- `scripts/extract.js` — the script that pulls Monday.com and rewrites `data.js`.
  No AI involved — plain, deterministic code.
- `.github/workflows/weekly-sync.yml` — tells GitHub to run `extract.js` every
  Monday at 07:00 Gulf time automatically.
- `agents/generate-insights.js` — runs only after a successful data sync.
  Haiku writes a plain-English changelog of what changed; Opus reads the new
  data and changelog and writes 3-5 narrative insights. **This step only ever
  writes `commentary.js` and `CHANGELOG.md` — it never touches `data.js` or
  `dashboard.html`.** If it fails for any reason, the data sync you already
  have is unaffected; the dashboard just won't show a commentary card that week.
- `commentary.js` — the agent-generated insights, read by the dashboard's
  "Weekly commentary" card. Absent until the first successful agent run.

There are only **two things you need to fill in** before this works. Everything
else is done.

---

## Step 1 — Create the repo (skip if you already have one)

1. Go to github.com → **New repository** → give it a name → **Create**.
2. On your computer, in the folder where these files are:
   ```bash
   git init
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git add .
   git commit -m "Initial dashboard + sync pipeline"
   git branch -M main
   git push -u origin main
   ```

If the repo already exists, just copy all these files into it, then `git add .`,
`git commit`, `git push`.

---

## Step 2 — Get a Monday.com API token

1. In Monday.com, click your avatar (bottom left) → **Admin** → **API**.
2. Generate a personal API token and copy it. Keep it secret — treat it like a password.

---

## Step 3 — Add the token to GitHub (as a secret, not in code)

1. In your repo on GitHub: **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret**.
   - Name: `MONDAY_API_KEY`
   - Value: paste the token from Step 2.
3. Save.

This lets the weekly workflow use the key without it ever appearing in your code
or commit history.

---

## Step 4 — Fill in your board IDs (thing #1 only you can get)

Open each board in Monday.com and look at the URL:

```
https://your-company.monday.com/boards/1234567890
                                        ^^^^^^^^^^ this number
```

Get this for both **"Weekly Planner: David"** and **"Weekly Planner: Olle"**.

Open `scripts/extract.js`, find this block near the top, and replace the
placeholders:

```js
const BOARDS = {
  'David Ives': {
    boardId: 'REPLACE_WITH_DAVID_BOARD_ID',   // <- paste David's board ID here
    role: 'Managing Director',
  },
  'Olle Kjellberg': {
    boardId: 'REPLACE_WITH_OLLE_BOARD_ID',    // <- paste Olle's board ID here
    role: 'Business Development Manager',
  },
};
```

---

## Step 5 — Fill in your column IDs (thing #2 only you can get)

Monday.com stores each board column under an internal ID (not the same as the
label you see on screen), so the script needs a one-time mapping.

**Easiest way to get it:** go to
[api.monday.com/v2/try](https://api.monday.com/v2/try) (Monday's built-in API
playground), paste in your token when prompted, and run this query
— once per board, using the board ID from Step 4:

```graphql
query {
  boards(ids: 1234567890) {
    columns {
      id
      title
    }
  }
}
```

You'll get back a list like:

```json
{ "id": "date4", "title": "Week Commencing" }
{ "id": "text_mkxyz", "title": "Client" }
{ "id": "status", "title": "Cohort" }
```

Match each `title` to the field it represents, then open `scripts/extract.js`
and fill in `COLUMN_MAP`:

```js
const COLUMN_MAP = {
  week:      'date4',       // the "Week Commencing" column's id
  meetDate:  'REPLACE_ME',  // meeting date column
  client:    'text_mkxyz',  // client / company name
  contact:   'REPLACE_ME',  // named contact
  cohort:    'status',      // Broker / Developer / Investor / Holiday Homes / Other
  type:      'REPLACE_ME',  // meeting type
  objective: 'REPLACE_ME',  // objective
  expected:  'REPLACE_ME',  // expected outcome
  actual:    'REPLACE_ME',  // actual outcome
  notes:     'REPLACE_ME',  // free text notes
};
```

> If David's and Olle's boards use different column layouts, tell me and I'll
> adjust the script to use two separate maps — right now it assumes both
> boards are laid out the same way.

**Important:** the whitelist values in `extract.js` (cohort names, meeting
types, outcome names) must match exactly what's typed into Monday.com's status
columns — e.g. `Investor/End client`, not `Investor / End Client`. If Monday.com
uses slightly different wording, either edit Monday.com's labels to match, or
tell me the exact wording and I'll update the whitelist to match instead.

---

## Step 6 — Push your changes

```bash
git add scripts/extract.js
git commit -m "Configure board and column IDs"
git push
```

---

## Step 7 — Test it manually before trusting the schedule

1. In your repo on GitHub, go to the **Actions** tab.
2. Click **Weekly Monday.com sync** in the left sidebar.
3. Click **Run workflow** → **Run workflow** (this button only appears because
   of the `workflow_dispatch` line in the YAML — it lets you trigger it on
   demand instead of waiting for Monday).
4. Watch the run. Green check = it worked, and you'll see a new commit appear
   with an updated `data.js`. Red X = click into the log; the error usually
   points straight at the problem (wrong column ID, bad token, etc.).

Once a manual run succeeds, the Monday 07:00 Gulf-time schedule takes over on
its own — nothing more to do.

---

## What happens automatically each week

1. GitHub triggers the workflow Monday morning.
2. `extract.js` pulls both Monday.com boards.
3. Every value is checked against the dashboard's known categories
   (cohorts, meeting types, outcomes). Anything unexpected is **not**
   invented or guessed — the field is set to blank and logged in
   `unmapped-values.json` for you to review.
4. A sanity check compares the new total record count to last week's. If it's
   moved by more than 50% in either direction, the run stops and **nothing is
   changed** — this protects you from a Monday.com outage or a broken column
   silently wiping your dashboard.
5. If everything checks out, `data.js` and `snapshot.json` are rewritten and
   committed automatically. The dashboard reflects the new data next time
   it's opened — no manual steps.

## What this does *not* do (yet)

- It does not write narrative commentary about what changed — that's the
  Haiku/Opus layer we discussed, which can be added on top of this once
  the sync itself is running reliably.
- `dashboard.html`'s code is never touched by automation — only `data.js`
  changes. This is intentional: it's the safest way to guarantee the chart
  logic, colours, and layout never silently break.
