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
  Prefer:         'return=minimal',
};

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

    const title = fields[1] ?? '';
    const url   = fields[4] ?? '';
    if (title && url) rows.push({ title, url });
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
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    results.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}

async function main() {
  console.log('Loading books from database…');
  const books = await fetchAllPages('books?select=id,title');
  console.log(`  ${books.length} books loaded.`);

  // Build lookup map: normalized title → book id
  const bookMap = new Map();
  for (const b of books) {
    bookMap.set(normalize(b.title), b.id);
  }

  console.log('Loading existing rated_reports…');
  const reports = await fetchAllPages('rated_reports?select=id,book_id');
  const reportMap = new Map(); // book_id → report id
  for (const r of reports) reportMap.set(r.book_id, r.id);
  console.log(`  ${reports.length} reports loaded.\n`);

  const rows = parseCSV(CSV_FILE);
  console.log(`CSV rows with URLs: ${rows.length}\n`);

  let updated = 0, inserted = 0, noMatch = 0;

  for (const { title, url } of rows) {
    const bookId = bookMap.get(normalize(title));
    if (!bookId) {
      console.log(`  [NO MATCH] "${title}"`);
      noMatch++;
      continue;
    }

    const reportId = reportMap.get(bookId);

    if (reportId) {
      // Update existing report_url
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/rated_reports?id=eq.${reportId}`,
        { method: 'PATCH', headers, body: JSON.stringify({ report_url: url }) }
      );
      if (!res.ok) {
        console.error(`  [FAIL] PATCH "${title}": ${res.status} ${await res.text()}`);
      } else {
        console.log(`  [UPDATE] "${title}"`);
        updated++;
      }
    } else {
      // Insert new rated_reports row with just the URL
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/rated_reports`,
        { method: 'POST', headers, body: JSON.stringify({ book_id: bookId, report_url: url }) }
      );
      if (!res.ok) {
        console.error(`  [FAIL] INSERT "${title}": ${res.status} ${await res.text()}`);
      } else {
        console.log(`  [INSERT] "${title}"`);
        inserted++;
      }
    }
  }

  console.log('\n── Summary ──────────────────────────────────');
  console.log(`  Updated : ${updated}`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  No match: ${noMatch}`);
  console.log('─────────────────────────────────────────────');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
