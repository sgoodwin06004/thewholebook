/**
 * scraper.js — Automated book form filler for thewholebook.org
 *
 * Three phases per run:
 *   1. Discover  — browse ratedbooks.org catalog via Playwright, collect all
 *                  product-page URLs and save to progress.json (skipped on
 *                  subsequent runs unless --rediscover is passed)
 *   2. Scrape    — visit each ratedbooks.org book page and extract data
 *   3. Submit    — fill thewholebook.org/reviewer form, skipping books that
 *                  already exist in the Supabase database (deduplication)
 *
 * Usage:
 *   node scraper.js                     # process next 250 unfinished books
 *   BATCH=500 node scraper.js           # process next 500
 *   SCRAPE_ONLY=true node scraper.js    # scrape only, don't submit
 *   REDISCOVER=true node scraper.js     # re-run catalog discovery
 *   HEADLESS=false node scraper.js      # watch the browser
 *
 * Required env vars (for submit phase):
 *   TWB_EMAIL       – your thewholebook.org login email
 *   TWB_PASSWORD    – your thewholebook.org login password
 *
 * Install (one time in Codespaces):
 *   npm install playwright
 *   npx playwright install chromium
 */

'use strict';

require('dotenv').config();

const { chromium } = require('playwright');
const fs           = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────

const SITE_URL       = 'https://www.thewholebook.org';
const RATED_BASE     = 'https://www.ratedbooks.org';
const PROGRESS_FILE  = 'progress.json';

// Supabase — same values already in reviewer.html
const SUPABASE_URL      = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';

const BATCH_SIZE  = parseInt(process.env.BATCH      ?? '250', 10);
const HEADLESS    = process.env.HEADLESS    !== 'false';
const SCRAPE_ONLY = process.env.SCRAPE_ONLY === 'true';
const REDISCOVER  = process.env.REDISCOVER  === 'true';

const EMAIL    = process.env.TWB_EMAIL;
const PASSWORD = process.env.TWB_PASSWORD;

const DELAY_MIN_MS = 2000;
const DELAY_MAX_MS = 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => sleep(DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); }
  catch { return { discoveredUrls: [], books: {} }; }
}

function saveProgress(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

/** Convert a product-page slug to a best-guess title and author. */
function parseSlug(url) {
  const slug   = url.split('/product-page/').pop() ?? '';
  const parts  = slug.split('-by-');
  const title  = parts[0]?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? '';
  const author = parts.slice(1).join(' by ').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) ?? '';
  return { title, author };
}

/** Normalize a title for loose comparison (lowercase, strip punctuation). */
function normalizeTitle(t) {
  return (t ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Phase 1: Discover all book URLs ─────────────────────────────────────────

async function discoverBookUrls(page) {
  console.log('\nPhase 1: Discovering book URLs on ratedbooks.org…');
  const found = new Set();

  // ── Strategy A: sitemap ──
  try {
    await page.goto(`${RATED_BASE}/store-products-sitemap.xml`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const xml = await page.content();
    [...xml.matchAll(/<loc>(https:\/\/www\.ratedbooks\.org\/product-page\/[^<]+)<\/loc>/g)]
      .forEach(m => found.add(m[1].trim()));
    console.log(`  Sitemap: ${found.size} URLs`);
  } catch (e) {
    console.warn('  Sitemap fetch failed:', e.message);
  }

  // ── Strategy B: browse the catalog/index pages ──
  const catalogPages = [
    `${RATED_BASE}/indexproducts`,
    `${RATED_BASE}/showme`,
    `${RATED_BASE}/store`,
    `${RATED_BASE}`,
  ];

  for (const catalogUrl of catalogPages) {
    try {
      console.log(`  Browsing: ${catalogUrl}`);
      await page.goto(catalogUrl, { waitUntil: 'networkidle', timeout: 45000 });
      await sleep(3000);

      // Scroll + click "Load More" up to 60 times to surface all books
      let prevCount = 0;
      for (let attempt = 0; attempt < 60; attempt++) {
        // Collect any product-page links currently in DOM
        const links = await page.$$eval(
          'a[href*="/product-page/"]',
          els => els.map(a => a.href)
        );
        links.forEach(l => found.add(l.split('?')[0]));

        // Try clicking a "Load More" / "Show More" button
        const loadMore = await page.$('button:has-text("Load More"), button:has-text("Show More"), [data-hook="load-more-button"]');
        if (loadMore) {
          await loadMore.click().catch(() => {});
          await sleep(2000);
        } else {
          // Scroll to bottom to trigger infinite scroll
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await sleep(2000);
        }

        if (found.size === prevCount) break; // nothing new loaded
        prevCount = found.size;
      }
      console.log(`  After browsing ${catalogUrl}: ${found.size} total URLs`);
    } catch (e) {
      console.warn(`  Could not browse ${catalogUrl}: ${e.message}`);
    }
  }

  const urls = [...found].filter(u => u.includes('/product-page/'));
  console.log(`Discovery complete: ${urls.length} book URLs found.\n`);
  return urls;
}

// ─── Phase 2: Scrape a single ratedbooks.org book page ───────────────────────

async function scrapeBook(page, url) {
  const { title: slugTitle, author: slugAuthor } = parseSlug(url);

  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  await sleep(2000);

  // ── Title ──
  let title = '';
  for (const sel of ['[data-hook="product-title"]', '[data-testid="product-title"]', 'h1', '.product-title']) {
    try { title = await page.$eval(sel, el => el.textContent?.trim()); if (title) break; } catch {}
  }
  if (!title) title = slugTitle;

  // ── Author ──
  let author = '';
  for (const sel of ['[data-hook="product-subtitle"]', '[data-hook="description"] p:first-child', '.product-author']) {
    try { author = await page.$eval(sel, el => el.textContent?.trim()); if (author) break; } catch {}
  }
  if (!author) author = slugAuthor;

  // ── Full page text for rating + categories ──
  const bodyText = await page.evaluate(() => document.body.innerText);

  // ── Rating (1–5) ──
  let rating = '';
  for (const pat of [
    /\brating[:\s]+([1-5])\b/i,
    /\blevel[:\s]+([1-5])\b/i,
    /\b([1-5])\s*\/\s*5\b/,
    /^([1-5])\s*$/m,
  ]) {
    const m = bodyText.match(pat);
    if (m) { rating = m[1]; break; }
  }

  // ── Categories / flagged keywords ──
  let categories = '';
  const catMatch = bodyText.match(/(?:categories|flags|keywords|content|flagged)[:\s]+([^\n]+)/i);
  if (catMatch) {
    categories = catMatch[1].trim();
  } else {
    // Fall back: pick up common content-warning keywords mentioned on the page
    const flags = ['sexual content', 'language', 'violence', 'nudity', 'drug use', 'alcohol', 'profanity', 'self-harm', 'suicide', 'abuse'];
    const found = flags.filter(f => bodyText.toLowerCase().includes(f));
    categories = found.join(', ');
  }

  // ── Wix product info sections (may contain structured data) ──
  try {
    const infoItems = await page.$$eval(
      '[data-hook="info-section-description"], [data-hook="product-info-section-description"]',
      els => els.map(el => el.textContent?.trim()).filter(Boolean)
    );
    for (const item of infoItems) {
      if (!rating) { const m = item?.match(/^([1-5])$/); if (m) rating = m[1]; }
      if (!categories && item && item.length < 300) categories = item;
    }
  } catch {}

  if (!rating)     console.warn(`  ⚠  No rating found:     ${url}`);
  if (!categories) console.warn(`  ⚠  No categories found: ${url}`);

  return {
    url,
    title:      title      || slugTitle,
    author:     author     || slugAuthor,
    rating:     rating     || '',
    categories: categories || '',
    scraped:    true,
    submitted:  false,
    skipped:    false,
  };
}

// ─── Phase 3a: Load existing books from Supabase for deduplication ────────────

async function loadExistingTitles() {
  console.log('Loading existing books from thewholebook.org for deduplication…');
  const existing = new Set();
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/books?select=title&limit=${pageSize}&offset=${offset}`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) {
      console.warn('  Could not fetch existing books:', res.status, await res.text());
      break;
    }
    const rows = await res.json();
    if (!rows.length) break;
    rows.forEach(r => existing.add(normalizeTitle(r.title)));
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`  Found ${existing.size} existing books in the database.\n`);
  return existing;
}

// ─── Phase 3b: Log in to thewholebook.org ────────────────────────────────────

async function ensureLoggedIn(page) {
  await page.goto(`${SITE_URL}/reviewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (page.url().includes('login')) {
    console.log('Logging in…');
    await page.fill('#email',    EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('#loginBtn');
    await page.waitForURL(url => !url.includes('login'), { timeout: 15000 });
    console.log('Logged in.\n');
  } else {
    console.log('Already logged in.\n');
  }

  if (!page.url().includes('reviewer')) {
    await page.goto(`${SITE_URL}/reviewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  await page.waitForSelector('body.ready', { timeout: 15000 });
}

// ─── Phase 3c: Submit one book ────────────────────────────────────────────────

async function submitBook(page, book) {
  await page.goto(`${SITE_URL}/reviewer.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('body.ready', { timeout: 15000 });

  await page.fill('#b-title',  book.title);
  await page.fill('#b-author', book.author);
  if (book.rating)     await page.fill('#r-rating',     book.rating);
  if (book.categories) await page.fill('#r-flagged',    book.categories);
  await page.fill('#r-report-url', book.url);
  // r-excerpts intentionally left empty

  await page.click('#submitBtn');

  try {
    await page.waitForSelector('.toast.success.show', { timeout: 15000 });
    return true;
  } catch {
    const errMsg = await page.$eval('#toast-msg', el => el.textContent).catch(() => 'unknown error');
    throw new Error(`Submission failed: ${errMsg}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SCRAPE_ONLY && (!EMAIL || !PASSWORD)) {
    console.error('Error: TWB_EMAIL and TWB_PASSWORD are required.');
    console.error('  TWB_EMAIL=you@example.com TWB_PASSWORD=secret node scraper.js');
    process.exit(1);
  }

  const progress = loadProgress();
  if (!progress.discoveredUrls) progress.discoveredUrls = [];
  if (!progress.books)          progress.books = {};

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; thewholebook-importer/1.0)',
  });
  const page = await context.newPage();

  try {
    // ── Phase 1: Discover ─────────────────────────────────────────────────────
    if (REDISCOVER || progress.discoveredUrls.length === 0) {
      progress.discoveredUrls = await discoverBookUrls(page);
      saveProgress(progress);
    } else {
      console.log(`Skipping discovery — ${progress.discoveredUrls.length} URLs already saved.`);
      console.log('(Run with REDISCOVER=true to refresh the list.)\n');
    }

    const allUrls = progress.discoveredUrls;

    // ── Phase 2: Scrape (next BATCH_SIZE un-scraped books) ────────────────────
    const toScrape = allUrls
      .filter(u => !progress.books[u]?.scraped)
      .slice(0, BATCH_SIZE);

    if (toScrape.length === 0) {
      console.log('All discovered books already scraped.\n');
    } else {
      console.log(`Phase 2: Scraping ${toScrape.length} books (${BATCH_SIZE} per run)…`);
      for (const url of toScrape) {
        console.log(`  Scraping: ${url}`);
        try {
          const book = await scrapeBook(page, url);
          progress.books[url] = book;
          console.log(`    title="${book.title}" rating="${book.rating}" cats="${book.categories}"`);
        } catch (err) {
          console.error(`    Error: ${err.message}`);
          progress.books[url] = { url, scraped: false, submitted: false, skipped: false, error: err.message, ...parseSlug(url) };
        }
        saveProgress(progress);
        await randomDelay();
      }
    }

    if (SCRAPE_ONLY) {
      console.log('\nSCRAPE_ONLY mode — done.');
      return;
    }

    // ── Phase 3: Submit (with deduplication) ──────────────────────────────────
    const existingTitles = await loadExistingTitles();

    const toSubmit = allUrls
      .filter(u => progress.books[u]?.scraped && !progress.books[u]?.submitted && !progress.books[u]?.skipped)
      .slice(0, BATCH_SIZE);

    if (toSubmit.length === 0) {
      console.log('No books ready to submit in this batch.\n');
    } else {
      console.log(`Phase 3: Submitting up to ${toSubmit.length} books…`);
      await ensureLoggedIn(page);

      let submitted = 0, skipped = 0, failed = 0;

      for (const url of toSubmit) {
        const book = progress.books[url];

        // ── Deduplication check ──
        if (existingTitles.has(normalizeTitle(book.title))) {
          console.log(`  [SKIP] Already in database: "${book.title}"`);
          progress.books[url].skipped = true;
          saveProgress(progress);
          skipped++;
          continue;
        }

        console.log(`  [SUBMIT] "${book.title}" by ${book.author}`);
        try {
          await submitBook(page, book);
          progress.books[url].submitted = true;
          // Add to local set so duplicates within this batch are also caught
          existingTitles.add(normalizeTitle(book.title));
          saveProgress(progress);
          console.log(`    ✓ Done`);
          submitted++;
        } catch (err) {
          console.error(`    ✗ ${err.message}`);
          progress.books[url].submitError = err.message;
          saveProgress(progress);
          failed++;
        }

        await randomDelay();
      }

      // ── Run summary ──
      const totalDone    = Object.values(progress.books).filter(b => b.submitted).length;
      const totalSkipped = Object.values(progress.books).filter(b => b.skipped).length;
      const totalLeft    = allUrls.filter(u => !progress.books[u]?.submitted && !progress.books[u]?.skipped).length;

      console.log('\n── Summary ──────────────────────────────────────────');
      console.log(`  This run:   submitted ${submitted}, skipped ${skipped} duplicates, failed ${failed}`);
      console.log(`  All-time:   ${totalDone} submitted, ${totalSkipped} skipped`);
      console.log(`  Remaining:  ~${totalLeft} books left`);
      if (totalLeft > 0) {
        const daysAt250 = Math.ceil(totalLeft / 250);
        console.log(`  At 250/day: ~${daysAt250} more run${daysAt250 === 1 ? '' : 's'}`);
      }
      console.log('─────────────────────────────────────────────────────');
    }

  } finally {
    await browser.close();
    saveProgress(progress);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
