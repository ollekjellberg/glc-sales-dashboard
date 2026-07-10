

# GLC Sales Dashboard — Handover Document

This document transfers **complete ownership** of the GLC sales dashboard and
its automation to a new owner. When every step is done, the previous owner
(Charlie) has no remaining access, no credentials, and no ongoing
responsibilities — everything runs under your accounts.

Work through it top to bottom. Each numbered part ends with a ✅ check so you
know it worked before moving on. Parts 1–2 need Charlie (Although it will probably be Olle by the time you read this) present; the rest you
can do alone.

---

## What this system is (2-minute overview)

- **Monday.com** holds the source data: two boards, "Weekly Planner - David"
  and "Weekly Planner - Olle Kjellberg", in the Dubai Projects workspace.
- **A GitHub repository** holds the dashboard (`dashboard.html`), its data
  (`data.js`), and the automation scripts.
- **Every Monday at 10:00 Dubai time**, a scheduler at **cron-job.org** tells
  GitHub to run the sync workflow. The workflow:
  1. Pulls both Monday.com boards and rewrites `data.js`.
  2. If anything changed: two Claude AI agents write a plain-English changelog
     (`CHANGELOG.md`), narrative insights (`commentary.js`), and follow-up
     reminders from the salespeople's notes (`reminders.js`).
  3. Builds a single self-contained dashboard file and **emails it** to the
     team from a dedicated Gmail relay account.
- If nothing changed on the boards that week, the workflow quietly does
  nothing — no commit, no email.
- **Nothing runs on anyone's computer.** Monday.com, GitHub, cron-job.org and
  Gmail are all cloud services; laptops can be off.

---

## Accounts you will own by the end

| Account | What it does | How you get it |
|---|---|---|
| GitHub account | Owns the repo + automation | You create; repo is transferred to you |
| Monday.com token | Lets the sync read the boards | Generated from your existing Monday.com user |
| cron-job.org account | Fires the Monday 10:00 schedule | You create; one job, recreated in 10 min |
| Gmail relay (glc.dashboard.bot@gmail.com or similar) | Sends the weekly email | Charlie hands over the login; you change the password |
| Anthropic Console account | Pays for the AI agents (a few cents/week) | You create, add billing, generate a key |

---

## PART 1 — Create your accounts (do first, ~15 minutes)

1. **GitHub**: github.com → Sign up (free). Note your username.
2. **cron-job.org**: console.cron-job.org → Sign up (free).
3. **Anthropic Console**: platform.claude.com → Sign up →
   **Settings → Billing** → add a company payment method (usage is tiny —
   typically well under $1/month) → **Settings → API Keys → Create Key** →
   name it `glc-dashboard` → copy the key (shown once, starts `sk-ant-`).
   Keep it somewhere safe for Part 3.
4. **Monday.com token**: in Monday.com (your normal work login) → click your
   avatar (bottom-left) → **Admin** → **API** → copy your personal API token.
   ⚠️ First confirm you can open BOTH boards ("Weekly Planner - David" and
   "Weekly Planner - Olle Kjellberg") — if you can't see a board, the token
   won't be able to read it either; ask whoever manages Monday.com for access
   first.
5. **Gmail relay**: Charlie gives you the address + password for the relay
   account. Log in → myaccount.google.com → Security → **change the
   password** → then go to **App passwords** → delete the old app password
   and **generate a new one** (16 characters, name it `glc-dashboard`). Copy
   it for Part 3. (Changing both means Charlie's old credentials are dead.)

✅ Check: you have five things written down — GitHub username, Monday token,
Anthropic key, Gmail address, new Gmail app password.

---

## PART 2 — Repo transfer (Charlie/Olle does this, you accept)

1. **Charlie**: repo → Settings → scroll to **Danger Zone** →
   **Transfer ownership** → type the repo name to confirm → enter the new
   owner's GitHub username → confirm.
2. **You**: check the email inbox linked to your GitHub account — accept the
   transfer (the link expires after a day, so do it promptly).
3. The repo now lives at `github.com/YOUR-USERNAME/glc-sales-dashboard`,
   with full history intact.

⚠️ **Repository secrets do NOT transfer.** GitHub deliberately wipes them.
That's fine — Part 3 recreates all of them with YOUR credentials anyway.

✅ Check: the repo appears under your GitHub account, and
Settings → Secrets and variables → Actions shows an empty (or near-empty)
secrets list.

---

## PART 3 — Recreate the five secrets (~10 minutes)

In YOUR copy of the repo: **Settings → Secrets and variables → Actions →
New repository secret**, five times:

| Name (must match EXACTLY) | Value |
|---|---|
| `MONDAY_API_KEY` | Your Monday.com token (Part 1, step 4) |
| `ANTHROPIC_API_KEY` | Your Anthropic key (Part 1, step 3) |
| `MAIL_USERNAME` | The Gmail relay address |
| `MAIL_PASSWORD` | The NEW 16-character Gmail app password (no spaces) |
| `MAIL_TO` | Recipient list, comma-separated, e.g. `you@glc.com,david@glc.com,olle@glc.com` |

✅ Check: five secrets listed.

---

## PART 4 — Test the workflow manually

1. Repo → **Actions** tab → click **Weekly Monday.com sync** in the left
   sidebar.
2. Click **Run workflow** (right side) → a small panel opens → click the green
   **Run workflow** button INSIDE the panel. (Two clicks — the first alone
   does nothing. This catches everyone once.)
3. Wait ~1 minute, refresh. Click into the run.
4. Every step should show a green tick. Steps may show as "skipped" (grey) if
   the Monday.com data hasn't changed since the last sync — that is correct
   behaviour, not a failure.
5. To force a full end-to-end test: change anything small on one of the
   Monday.com boards (e.g. edit a note), run the workflow again, and confirm
   (a) a new commit appears on the repo, and (b) the email arrives.
   First email from the relay may land in Junk — mark it "not junk" once.

✅ Check: green run, new commit, email received.

---

## PART 5 — Recreate the scheduler on YOUR cron-job.org

The schedule fires GitHub's workflow every Monday morning. It needs a GitHub
token from YOUR account:

1. GitHub → your avatar → **Settings** → **Developer settings** →
   **Personal access tokens → Fine-grained tokens → Generate new token**:
   - Name: `cron-trigger-glc-dashboard`
   - Expiration: 90 days (see "Ongoing maintenance" below)
   - Repository access: **Only select repositories** → the dashboard repo
   - Permissions → Repository permissions → **Actions: Read and write**
     (leave everything else on No access)
   - Generate, copy the token (starts `github_pat_`, shown once).
2. cron-job.org → **Create cronjob**:
   - Title: `GLC dashboard weekly sync`
   - URL:
     `https://api.github.com/repos/YOUR-USERNAME/glc-sales-dashboard/actions/workflows/weekly-sync.yml/dispatches`
     (⚠️ replace YOUR-USERNAME — the old URL pointed at Charlie's account and
     is now wrong)
   - Schedule: every **Monday at 10:00**, timezone **Asia/Dubai**
     (timezone lives in account Settings — set it there first)
   - **Advanced** tab:
     - Request method: **POST**
     - Headers:
       - `Authorization` : `Bearer github_pat_XXXX...` (the word Bearer, a
         space, then your token)
       - `Accept` : `application/vnd.github+json`
     - Request body: `{"ref":"main"}`
   - Save.
3. Test: open the job → **TEST RUN** → **START TEST RUN** (two clicks again).
   Expect status **204**. Then check the repo's Actions tab — a new run
   should appear within ~15 seconds.

✅ Check: 204 response, run appeared on GitHub.

---

## PART 6 — Charlie's/Olle's exit checklist (Charlie/Olle does this last)

Once Parts 1–5 all check out:

- [ ] cron-job.org: **delete** the old cronjob (or the whole account) — it
      still holds an old GitHub token and would keep firing at a repo that
      moved.
- [ ] GitHub: Developer settings → Fine-grained tokens → **revoke**
      `cron-trigger-glc-dashboard`.
- [ ] GitHub: Developer settings → Tokens (classic) → revoke the old
      `dashboard-repo-push` token (it authorised pushes to the transferred
      repo).
- [ ] Anthropic Console: **disable/delete** the old API key (it was on
      Charlie's billing).
- [ ] Confirm the Gmail relay password + app password were changed in Part 1.
- [ ] Monday.com: nothing to do — the old token dies with the work account.

After this list, Charlie has zero access and zero obligations.

---

## Ongoing maintenance (the honest list)

- **Every ~90 days**: the fine-grained GitHub token expires (GitHub emails a
  warning first). Mint a new one (Part 5 step 1) and paste it into the
  cron-job.org job's Authorization header. 5 minutes. If the Monday email
  ever silently stops arriving, an expired token is the first thing to check.
- **If a salesperson's board is rebuilt/replaced**: the board ID and column
  IDs change. `scripts/extract.js` holds both (clearly labelled near the
  top); the README explains how to fetch new IDs with one API call.
- **If someone joins/leaves the email list**: edit the `MAIL_TO` secret.
  No code changes.
- **Weekly runs where "nothing happened"**: normal. No board changes → no
  commit → no email. Check the Actions tab if you want proof it ran.
- **Never edit `data.js` or `snapshot.json` by hand** — the automation owns
  them. `dashboard.html` is safe to edit (it's only code, never touched by
  the automation).

---

## If something breaks

1. Repo → **Actions** → click the most recent run → click the failed (red)
   step to expand its log. The error message is almost always explicit:
   - `Monday API` errors → token invalid/expired, or board access lost.
   - `535 Authentication unsuccessful` on the email step → Gmail app
     password wrong or revoked.
   - `401`/`404` from cron-job.org's test → GitHub token expired or URL
     username wrong.
2. An email failure never breaks the data sync — the dashboard still
   updates; only the attachment doesn't go out.
3. The AI steps are also non-fatal: if they fail, the data still syncs;
   only the commentary/reminders don't refresh that week.

# YOUR WELCOME :)
