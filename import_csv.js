'use strict';

require('dotenv').config();

const { chromium } = require('playwright');
const fs = require('fs');

const SITE_URL = 'https://www.thewholebook.org';
const CSV_FILE = '/workspaces/thewholebook/ratedver2.csv';
const PROGRESS_FILE = '/workspaces/thewholebook/csv_progress.json';

const SUPABASE_URL      = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';

const EMAIL    = process.env.TWB_EMAIL;
const PASSWORD = process.env.TWB_PASSWORD;
const BATCH    = parseInt(process.env.BATCH ?? '250', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(2000 + Math.random() * 1000);

function normalizeTitle(t) {
  return (t ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function reverseAuthorName(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name; // single name, leave as-is
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return `${last}, ${first}`;
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { submitted: [], skipped: [] }; }
}

function saveProgress(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

function parseCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  // Skip the header row (first line)
  const books = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted fields
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '"') {
        inQuotes = !inQuotes;
      } else if (line[c] === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += line[c];
      }
    }
    fields.push(current.trim());

    const title  = fields[0] ?? '';
    const author = fields[1] ?? '';
    const rating = fields[2] ?? '';

    if (title) books.push({ title, author: reverseAuthorName(author), rating });
  }
  return books;
}

async function loadExistingTitles() {
  console.log('Loading existing books from database for deduplication...');
  const existing = new Set();
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/books?select=title&limit=${pageSize}&offset=${offset}`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) { console.warn('Could not fetch existing books:', res.status); break; }
    const rows = await res.json();
    if (!rows.length) break;
    rows.forEach(r => existing.add(normalizeTitle(r.title)));
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  console.log(`  Found ${existing.size} existing books.\n`);
  return existing;
}

async function ensureLoggedIn(page) {
  await page.goto(`${SITE_URL}/login.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#email', { timeout: 10000 });
  console.log('Logging in...');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#loginBtn');
  await page.waitForURL(u => !u.toString().includes('login'), { timeout: 15000 });
  console.log('Logged in.\n');
  await page.goto(`${SITE_URL}/reviewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('body.ready', { timeout: 15000 });
}

async function submitBook(page, book) {
  await page.goto(`${SITE_URL}/reviewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('body.ready', { timeout: 15000 });

  await page.fill('#b-title',  book.title);
  await page.fill('#b-author', book.author);
  if (book.rating) await page.fill('#r-rating', book.rating);

  await page.click('#submitBtn');

  try {
    await page.waitForSelector('.toast.success.show', { timeout: 15000 });
    return true;
  } catch {
    const errMsg = await page.$eval('#toast-msg', el => el.textContent).catch(() => 'unknown error');
    throw new Error(`Submission failed: ${errMsg}`);
  }
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error('Error: TWB_EMAIL and TWB_PASSWORD required in .env');
    process.exit(1);
  }

  const books    = parseCSV(CSV_FILE);
  const progress = loadProgress();
  const doneSet  = new Set([...progress.submitted, ...progress.skipped]);

  console.log(`CSV loaded: ${books.length} books`);
  console.log(`Already processed: ${doneSet.size}`);

  const existing = await loadExistingTitles();

  const todo = books.filter(b => !doneSet.has(normalizeTitle(b.title))).slice(0, BATCH);
  console.log(`This batch: ${todo.length} books\n`);

  if (todo.length === 0) {
    console.log('All done!');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    await ensureLoggedIn(page);

    let submitted = 0, skipped = 0, failed = 0;

    for (const book of todo) {
      const key = normalizeTitle(book.title);

      if (existing.has(key)) {
        console.log(`  [SKIP] Already exists: "${book.title}"`);
        progress.skipped.push(key);
        saveProgress(progress);
        skipped++;
        continue;
      }

      console.log(`  [SUBMIT] "${book.title}" by ${book.author} (rating: ${book.rating || 'none'})`);
      try {
        await submitBook(page, book);
        progress.submitted.push(key);
        existing.add(key);
        saveProgress(progress);
        console.log(`    ✓ Done`);
        submitted++;
      } catch (err) {
        console.error(`    ✗ ${err.message}`);
        failed++;
      }

      await randomDelay();
    }

    const remaining = books.length - progress.submitted.length - progress.skipped.length;
    console.log('\n── Summary ──────────────────────────────────');
    console.log(`  This run:  submitted ${submitted}, skipped ${skipped} duplicates, failed ${failed}`);
    console.log(`  Remaining: ~${remaining} books`);
    console.log('─────────────────────────────────────────────');

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
