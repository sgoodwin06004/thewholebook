'use strict';

require('dotenv').config();

const fs = require('fs');

const SUPABASE_URL = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SERVICE_KEY  = process.env.SERVICE_KEY;
const CSV_FILE     = '/workspaces/thewholebook/rated3.csv';

if (!SERVICE_KEY) {
  console.error('Error: SERVICE_KEY not set in .env');
  process.exit(1);
}

const headers = {
  apikey:         SERVICE_KEY,
  Authorization:  `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// "First Last" → "Last, First"
// Handles middle initials: "Rachel L. Thomas" → "Thomas, Rachel L."
// Skips names that already have a comma or contain " and " (multiple authors)
function reverseAuthorName(name) {
  if (!name) return name;
  const trimmed = name.trim();
  if (trimmed.includes(',')) return trimmed;          // already reversed
  if (/\band\b/i.test(trimmed)) return trimmed;       // multiple authors — leave as-is
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return trimmed;             // single name
  const last  = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return `${last}, ${first}`;
}

function normalize(t) {
  return (t ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function parseCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = [];
    let current = '', inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') { inQuotes = !inQuotes; }
      else if (line[c] === ',' && !inQuotes) { fields.push(current.trim()); current = ''; }
      else { current += line[c]; }
    }
    fields.push(current.trim());

    const title  = fields[1] ?? '';
    const author = fields[2] ?? '';
    const rating = parseInt(fields[3], 10) || null;
    const url    = fields[4] ? fields[4].trim() : null;

    if (title) rows.push({ title, author: reverseAuthorName(author), rating, url });
  }
  return rows;
}

async function fetchAllPages(path) {
  const results = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${path}&limit=${pageSize}&offset=${offset}`,
      { headers }
    );
    if (!res.ok) throw new Error(`Fetch failed (${path}): ${res.status} ${await res.text()}`);
    const rows = await res.json();
    results.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}

async function post(table, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`INSERT ${table} failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

async function main() {
  // ── Load existing data ──────────────────────────────────────────
  console.log('Loading books from database…');
  const existingBooks = await fetchAllPages('books?select=id,title,user_id');
  console.log(`  ${existingBooks.length} books in DB.`);

  const bookByNorm  = new Map();  // normalized title → { id, user_id }
  let fallbackUserId = null;
  for (const b of existingBooks) {
    bookByNorm.set(normalize(b.title), { id: b.id, userId: b.user_id });
    if (b.user_id) fallbackUserId = b.user_id;
  }

  console.log('Loading rated_reports…');
  const reports = await fetchAllPages('rated_reports?select=id,book_id');
  const reportByBook = new Map();
  for (const r of reports) reportByBook.set(r.book_id, r.id);
  console.log(`  ${reports.length} reports in DB.\n`);

  // ── Parse CSV ───────────────────────────────────────────────────
  const rows = parseCSV(CSV_FILE);
  console.log(`CSV rows: ${rows.length}`);

  const missing = rows.filter(r => !bookByNorm.has(normalize(r.title)));
  console.log(`Already in DB: ${rows.length - missing.length}`);
  console.log(`To insert: ${missing.length}\n`);

  let inserted = 0, failed = 0;

  for (const row of missing) {
    try {
      // 1. Insert book
      const [newBook] = await post('books', {
        title:   row.title,
        author:  row.author || null,
        user_id: fallbackUserId,
      });
      const bookId = newBook.id;

      // 2. Insert rated_reports row
      const reportPayload = { book_id: bookId };
      if (row.rating) reportPayload.rating = row.rating;
      if (row.url)    reportPayload.report_url = row.url;

      await post('rated_reports', reportPayload);

      console.log(`  [OK] "${row.title}" by ${row.author}`);
      inserted++;
    } catch (err) {
      console.error(`  [FAIL] "${row.title}": ${err.message}`);
      failed++;
    }
  }

  console.log('\n── Summary ──────────────────────────────────');
  console.log(`  Inserted : ${inserted}`);
  console.log(`  Failed   : ${failed}`);
  console.log(`  Skipped  : ${rows.length - missing.length} (already in DB)`);
  console.log('─────────────────────────────────────────────');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
