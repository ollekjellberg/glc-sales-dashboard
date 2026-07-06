// agents/generate-insights.js
//
// Runs AFTER extract.js has already written a fresh data.js + snapshot.json,
// and only when the sync actually produced a new commit (see weekly-sync.yml).
//
// This script's ONLY outputs are:
//   - commentary.js   (read by the dashboard, purely for display)
//   - CHANGELOG.md    (human-readable history, for your own reference)
//
// It NEVER writes to data.js or dashboard.html. If this script fails for any
// reason (bad API key, rate limit, malformed response), the workflow simply
// skips the commentary update — the data sync from extract.js has already
// succeeded and is unaffected either way.

import fs from 'fs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const OPUS_MODEL = 'claude-opus-4-8';

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — skipping commentary generation.');
  process.exit(0); // not a fatal error for the overall workflow
}

function loadJSON(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function callClaude(model, system, userText, maxTokens = 1000) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error (${model}): ${res.status} ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const textBlock = json.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error(`No text content returned by ${model}`);
  return textBlock.text.trim();
}

// Build a compact, token-light summary of what changed between the previous
// snapshot and the current one — this is what Haiku reads, not the full
// raw record dump, to keep the call fast and cheap.
function diffSnapshots(prev, curr) {
  const summary = {};
  const people = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const person of people) {
    const prevRecs = prev[person]?.records || [];
    const currRecs = curr[person]?.records || [];
    const prevIds = new Set(prevRecs.map(r => r.id));
    const currIds = new Set(currRecs.map(r => r.id));

    const added = currRecs.filter(r => !prevIds.has(r.id));
    const removed = prevRecs.filter(r => !currIds.has(r.id));
    const changed = [];
    const prevById = Object.fromEntries(prevRecs.map(r => [r.id, r]));
    for (const r of currRecs) {
      const old = prevById[r.id];
      if (!old) continue;
      const fieldsToCheck = ['co', 't', 'o', 'e', 'a', 'n', 'd'];
      const diffFields = fieldsToCheck.filter(f => old[f] !== r[f]);
      if (diffFields.length) {
        changed.push({ id: r.id, client: r.c, changes: diffFields.map(f => ({ field: f, from: old[f], to: r[f] })) });
      }
    }

    summary[person] = {
      totalBefore: prevRecs.length,
      totalAfter: currRecs.length,
      added: added.map(r => ({ client: r.c, cohort: r.co, week: r.w, actual: r.a })),
      removed: removed.map(r => ({ client: r.c, cohort: r.co, week: r.w })),
      changed,
    };
  }
  return summary;
}

async function main() {
  const prevSnapshot = loadJSON('/tmp/prev-snapshot.json', {});
  const currSnapshot = loadJSON('snapshot.json', {});
  const diff = diffSnapshots(prevSnapshot, currSnapshot);

  const hasAnyChange = Object.values(diff).some(
    d => d.added.length || d.removed.length || d.changed.length
  );
  if (!hasAnyChange) {
    console.log('No meaningful changes in this week\'s data — skipping commentary generation.');
    return;
  }

  // ---- Step 1: Haiku writes the changelog ----
  const changelogText = await callClaude(
    HAIKU_MODEL,
    `You write short, plain-English weekly changelog entries for a sales dashboard.
Input is a JSON diff between last week's and this week's data, per salesperson.
Write 3-8 bullet points total, plain English, no jargon, mentioning specific
client names and cohorts where relevant. No preamble, no headers, just bullets
starting with "-". Do not invent anything not present in the diff.`,
    JSON.stringify(diff),
    600
  );

  const today = new Date().toISOString().slice(0, 10);
  const changelogEntry = `\n## ${today}\n\n${changelogText}\n`;
  fs.appendFileSync('CHANGELOG.md', changelogEntry);
  console.log('Changelog written:\n' + changelogText);

  // ---- Step 2: Opus writes narrative insights from the new data + changelog ----
  const insightsRaw = await callClaude(
    OPUS_MODEL,
    `You write short narrative insights for a sales performance dashboard, read by
two salespeople (David Ives, Olle Kjellberg) and their manager.
You will be given this week's changelog and the current full dataset summary.
Write 3-5 insights about week-over-week shifts: conversion rate changes, stalled
clients, reschedule patterns, or diary intent mix. Each insight must be grounded
in the data provided — never invent figures.
Respond with ONLY a raw JSON array, no markdown fences, no preamble, in this
exact shape:
[{"title": "short title (max 8 words)", "body": "1-3 sentences, plain English",
  "scope": "David Ives" | "Olle Kjellberg" | "Team" }]
"scope" should match whichever salesperson the insight is about, or "Team" if
it compares both or applies to the business overall.`,
    JSON.stringify({ changelog: changelogText, diff }),
    1200
  );

  let items;
  try {
    const cleaned = insightsRaw.replace(/^```json\s*|\s*```$/g, '');
    items = JSON.parse(cleaned);
    if (!Array.isArray(items)) throw new Error('not an array');
  } catch (err) {
    console.error('Opus did not return valid JSON — skipping commentary.js update.', err.message);
    console.error('Raw response was:', insightsRaw.slice(0, 500));
    return;
  }

  const commentary = {
    generated: new Date().toISOString(),
    items,
  };
  fs.writeFileSync('commentary.js', `window.GLC_COMMENTARY = ${JSON.stringify(commentary)};\n`);
  console.log(`commentary.js written with ${items.length} insight(s).`);
}

main().catch(err => {
  console.error('Insight generation failed (non-fatal to the data sync):', err.message);
  process.exit(0); // never fail the overall workflow because of this step
});
