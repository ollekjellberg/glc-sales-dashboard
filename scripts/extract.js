// scripts/extract.js
// Pulls both Monday.com boards, transforms them into the dashboard's data.js
// format, runs a sanity check against last week's snapshot, and writes:
//   - data.js              (consumed by dashboard.html)
//   - snapshot.json         (this week's extract, used for next week's diff)
//   - unmapped-values.json  (only written if some Monday.com values didn't
//                            match the dashboard's whitelist)
//
// Nothing in this file uses an LLM. It is a plain, deterministic transform.

import fs from 'fs';

const MONDAY_API = 'https://api.monday.com/v2';
const TOKEN = process.env.MONDAY_API_KEY;

if (!TOKEN) {
  console.error('MONDAY_API_KEY is not set. Aborting.');
  process.exit(1);
}

/* ============================================================
   1. FILL THESE IN — see README.md "Getting your board/column IDs"
   ============================================================ */

const BOARDS = {
  'David Ives': {
    boardId: '5029723892',
    role: 'Managing Director',
  },
  'Olle Kjellberg': {
    boardId: '5029723447',
    role: 'Business Development Manager',
  },
};

// Both boards use a single "Date" column (no separate "week commencing"
// column exists in Monday.com). The dashboard's week-start ('w') is
// calculated automatically from that date — see mondayOfWeek() below.
// Column IDs differ between the two boards, so each person has their own map.
const COLUMN_MAP_BY_PERSON = {
  'David Ives': {
    meetDate:  'date_mm50z5bq',
    client:    'text_mm508bxq',
    contact:   'text_mm5069qm',
    cohort:    'color_mm50zamn',
    type:      'color_mm50q8c7',
    objective: 'color_mm50kdz8',
    expected:  'color_mm50mm63',
    actual:    'color_mm509hrz',
    notes:     'text_mm50txsz',
  },
  'Olle Kjellberg': {
    meetDate:  'date_mm50hhq8',
    client:    'text_mm50bb8b',
    contact:   'text_mm50rf6p',
    cohort:    'color_mm50wrbr',
    type:      'color_mm50sj3e',
    objective: 'color_mm508m25',
    expected:  'color_mm50gb35',
    actual:    'color_mm50jk37',
    notes:     'text_mm50d031',
  },
};

/* ============================================================
   2. Whitelists — mirrors the values already used in the dashboard.
      Add to these ONLY if you also add matching chart/colour config
      in dashboard.html. Do not remove entries other code depends on.
   ============================================================ */

const COHORT_WHITELIST = [
  'Broker', 'Developer', 'Investor/End client', 'Holiday Homes', 'Other',
];
const TYPE_WHITELIST = [
  'Intro / first meeting', 'Existing client meeting', 'New client meeting',
  'Event', 'Site / showroom visit', 'Internal deal meeting',
];
const OUTCOME_WHITELIST = [
  'Introduce Global Living', 'Relationship advance', 'Qualify opportunity',
  'Deal progression', 'Proposals / Presentation', 'Proposals / Quotes Issuance',
  'New lead created', 'Send Brochure', 'Send Referral Agreement', 'Rescheduled',
];

/* ============================================================
   3. Monday.com fetch + transform
   ============================================================ */

async function fetchBoardOnce(boardId) {
  const query = `
    query {
      boards(ids: ${boardId}) {
        items_page(limit: 500) {
          items {
            id
            column_values {
              id
              text
            }
          }
        }
      }
    }`;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(MONDAY_API, {
        method: 'POST',
        headers: {
          'Authorization': TOKEN,
          'Content-Type': 'application/json',
          'API-Version': '2024-10',
        },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`Monday API HTTP ${res.status}`);
      const json = await res.json();
      if (json.errors) throw new Error('Monday API error: ' + JSON.stringify(json.errors));
      return json.data.boards[0].items_page.items;
    } catch (err) {
      lastErr = err;
      console.warn(`Fetch attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

const FETCH_SETTLE_DELAY_MS = 10000; // gap between the two fetches below
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// Monday.com's items_page reads from an eventually-consistent index. Items
// inserted at the very end of a board can be briefly under-indexed — not just
// missing themselves, but occasionally causing a handful of *other* existing
// items to also drop out of the result for a short window. Fetching twice,
// ~10s apart, and merging by item id gives the index a chance to catch up
// within the same run, so a transient gap self-heals instead of silently
// producing an incomplete dataset.
async function fetchBoard(boardId) {
  const first = await fetchBoardOnce(boardId);
  await sleep(FETCH_SETTLE_DELAY_MS);
  const second = await fetchBoardOnce(boardId);

  const byId = new Map();
  first.forEach(item => byId.set(item.id, item));
  second.forEach(item => byId.set(item.id, item)); // second pass wins on conflict (freshest data)

  const merged = Array.from(byId.values());
  if (merged.length !== first.length || merged.length !== second.length) {
    console.warn(
      `[fetchBoard] board ${boardId}: fetch 1 returned ${first.length} item(s), ` +
      `fetch 2 returned ${second.length}, merged total ${merged.length}. ` +
      `Monday.com's index likely hadn't fully settled — using the merged, more complete set.`
    );
  }
  return merged;
}

function colText(item, colId) {
  const c = item.column_values.find(c => c.id === colId);
  const t = c && c.text ? c.text.trim() : '';
  return t === '' ? null : t;
}

function whitelistOrNull(val, list, unmapped, label, itemId) {
  if (val === null) return null;
  if (list.includes(val)) return val;
  unmapped.push({ label, itemId, value: val });
  return null;
}

function toISODate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Given a meeting date, return the ISO date of the Monday that starts its week.
function mondayOfWeek(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = d.getUTCDay();               // 0 = Sun, 1 = Mon, ... 6 = Sat
  const diff = day === 0 ? -6 : 1 - day;    // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function buildRecordsForPerson(name, cfg, unmapped, rejected) {
  const COLUMN_MAP = COLUMN_MAP_BY_PERSON[name];
  const items = await fetchBoard(cfg.boardId);
  const records = [];

  for (const item of items) {
    const d = toISODate(colText(item, COLUMN_MAP.meetDate));
    const w = mondayOfWeek(d);
    if (!w) {
      rejected.push({ person: name, itemId: item.id, reason: 'missing/invalid date' });
      continue;
    }
    records.push({
      id: item.id, // Monday.com item ID — stable key used for diffing week to week
      w,           // derived: the Monday that starts the meeting's week
      d,
      c:  colText(item, COLUMN_MAP.client),
      p:  colText(item, COLUMN_MAP.contact),
      co: whitelistOrNull(colText(item, COLUMN_MAP.cohort), COHORT_WHITELIST, unmapped, `${name} cohort`, item.id),
      t:  whitelistOrNull(colText(item, COLUMN_MAP.type), TYPE_WHITELIST, unmapped, `${name} type`, item.id),
      o:  whitelistOrNull(colText(item, COLUMN_MAP.objective), OUTCOME_WHITELIST, unmapped, `${name} objective`, item.id),
      e:  whitelistOrNull(colText(item, COLUMN_MAP.expected), OUTCOME_WHITELIST, unmapped, `${name} expected`, item.id),
      a:  whitelistOrNull(colText(item, COLUMN_MAP.actual), OUTCOME_WHITELIST, unmapped, `${name} actual`, item.id),
      n:  colText(item, COLUMN_MAP.notes) || '',
    });
  }
  return records;
}

/* ============================================================
   4. Dashboard summary block (planTotal, planByType, etc.)
      This mirrors what the dashboard previously hand-authored in its
      data. Kept simple/conservative: "this week" = latest week present.
   ============================================================ */

function buildDashboardSummary(records) {
  const weeks = [...new Set(records.map(r => r.w))].sort();
  const thisWeek = weeks[weeks.length - 1] || null;
  const lastWeek = weeks[weeks.length - 2] || null;

  const countBy = (recs, key) => {
    const m = {};
    recs.forEach(r => { const v = r[key]; if (v) m[v] = (m[v] || 0) + 1; });
    return Object.entries(m).map(([k, v]) => ({ k, v }));
  };

  const thisWeekRecs = records.filter(r => r.w === thisWeek);
  const lastWeekRecs = records.filter(r => r.w === lastWeek);

  const planByType = TYPE_typesOrEmpty(thisWeekRecs);
  const expByOutcome = OUTCOME_WHITELIST
    .filter(k => k !== 'Rescheduled')
    .map(k => ({ k, v: thisWeekRecs.filter(r => r.e === k).length }));

  const lastWeekOutcomes = OUTCOME_WHITELIST
    .filter(k => k !== 'Rescheduled')
    .map(k => ({
      k,
      t: lastWeekRecs.filter(r => r.e === k).length,
      a: lastWeekRecs.filter(r => r.a === k).length,
      v: lastWeekRecs.filter(r => r.a === k).length - lastWeekRecs.filter(r => r.e === k).length,
    }));

  return {
    thisWeek,
    planTotal: thisWeekRecs.length,
    planByType,
    expByOutcome,
    lastWeek,
    lastWeekTotalActual: lastWeekRecs.filter(r => r.a && r.a !== '').length,
    lastWeekTotalTarget: lastWeekRecs.length,
    lastWeekOutcomes,
  };

  function TYPE_typesOrEmpty(recs) {
    return TYPE_WHITELIST.map(k => ({ k, v: recs.filter(r => r.t === k).length }));
  }
}

/* ============================================================
   5. Main
   ============================================================ */

async function main() {
  const unmapped = [];
  const rejected = [];
  const data = {};

  for (const [name, cfg] of Object.entries(BOARDS)) {
    const records = await buildRecordsForPerson(name, cfg, unmapped, rejected);
    data[name] = { role: cfg.role, records, dashboard: buildDashboardSummary(records) };
  }

  // Sanity check against last snapshot before writing anything.
  // Checked per-person (not just combined) so a drop on one board can't be
  // masked by growth on the other — this is what would catch a Monday.com
  // partial-index gap slipping through as a "small enough" combined change.
  let prevSnapshot = null;
  if (fs.existsSync('snapshot.json')) {
    const prevRaw = fs.readFileSync('snapshot.json', 'utf8').trim();
    if (prevRaw && prevRaw !== '{}') prevSnapshot = JSON.parse(prevRaw);
  }
  if (prevSnapshot) {
    for (const [name, cfg] of Object.entries(BOARDS)) {
      const prevN = prevSnapshot[name]?.records?.length;
      const newN = data[name].records.length;
      if (prevN == null || prevN === 0) continue;
      if (newN < prevN * 0.5 || newN > prevN * 1.5) {
        console.error(
          `Sanity check failed for ${name}: record count moved from ${prevN} to ${newN} ` +
          `(more than 50% change). Aborting without writing data.js.`
        );
        process.exit(1);
      }
      if (newN < prevN * 0.9) {
        console.error(
          `Sanity check failed for ${name}: record count dropped from ${prevN} to ${newN} ` +
          `(more than 10% fewer records than last week). This looks like a partial-index gap ` +
          `from Monday.com rather than a genuine deletion spree. Aborting without writing data.js — ` +
          `re-run the workflow; if the count is genuinely correct on a re-run, this was transient.`
        );
        process.exit(1);
      }
    }
  }
  const newCount = Object.values(data).reduce((s, p) => s + p.records.length, 0);

  fs.writeFileSync('data.js', `window.GLC_DATA = ${JSON.stringify(data)};\n`);
  fs.writeFileSync('snapshot.json', JSON.stringify(data, null, 2));

  if (unmapped.length) {
    fs.writeFileSync('unmapped-values.json', JSON.stringify(unmapped, null, 2));
    console.warn(`${unmapped.length} unmapped value(s) found — see unmapped-values.json`);
  } else if (fs.existsSync('unmapped-values.json')) {
    fs.unlinkSync('unmapped-values.json');
  }

  if (rejected.length) {
    fs.writeFileSync('rejected-records.json', JSON.stringify(rejected, null, 2));
    console.warn(`${rejected.length} record(s) skipped (no valid week date) — see rejected-records.json`);
  } else if (fs.existsSync('rejected-records.json')) {
    fs.unlinkSync('rejected-records.json');
  }

  console.log(`Done. ${newCount} records written across ${Object.keys(data).length} people.`);
}

main().catch(err => {
  console.error('Extraction failed:', err);
  process.exit(1);
});
