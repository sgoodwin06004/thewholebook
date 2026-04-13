// Fetches Goodreads ratings from the UCSD Book Graph dataset.
// Downloads genre-specific subsets, matches by ISBN then title, updates DB.
// Usage: node scripts/fetch-goodreads-ratings.js          (dry run)
//        node scripts/fetch-goodreads-ratings.js --apply  (save to DB)

require('dotenv').config();
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const readline = require('readline');
const path    = require('path');
const fs      = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';
const apply = process.argv.includes('--apply');
const full  = process.argv.includes('--full');

const BASE = 'https://mcauleylab.ucsd.edu/public_datasets/gdrive/goodreads';
const FULL_FILE = `${BASE}/goodreads_books.json.gz`;

const GENRE_FILES = [
  `${BASE}/byGenre/goodreads_books_children.json.gz`,
  `${BASE}/byGenre/goodreads_books_young_adult.json.gz`,
  `${BASE}/byGenre/goodreads_books_comics_graphic.json.gz`,
  `${BASE}/byGenre/goodreads_books_fantasy_paranormal.json.gz`,
  `${BASE}/byGenre/goodreads_books_mystery_thriller_crime.json.gz`,
  `${BASE}/byGenre/goodreads_books_romance.json.gz`,
  `${BASE}/byGenre/goodreads_books_non_fiction.json.gz`,
  `${BASE}/byGenre/goodreads_books_history_biography.json.gz`,
  `${BASE}/byGenre/goodreads_books_poetry.json.gz`,
];

const CACHE_DIR = path.join(__dirname, '.goodreads-cache');

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizeTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'User-Agent': 'thewholebook/1.0' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return download(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', err => { fs.unlinkSync(destPath); reject(err); });
  });
}

// Stream a .json.gz file line-by-line, calling cb(parsedObject) for each line
function streamJsonGz(filePath, cb) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
      .pipe(zlib.createGunzip())
      .on('error', reject);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', line => {
      if (!line.trim()) return;
      try { cb(JSON.parse(line)); } catch {}
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// ── Build lookup maps ─────────────────────────────────────────────────────────
async function buildLookup() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

  const byIsbn  = new Map(); // isbn/isbn13 → {rating, url}
  const byTitle = new Map(); // normalizedTitle → {rating, url}

  let totalRecords = 0;

  const filesToProcess = full
    ? [...GENRE_FILES, FULL_FILE]
    : GENRE_FILES;

  for (const url of filesToProcess) {
    const fname = path.basename(url);
    const dest  = path.join(CACHE_DIR, fname);

    if (!fs.existsSync(dest)) {
      process.stdout.write(`  Downloading ${fname}…`);
      try {
        await download(url, dest);
        console.log(' done');
      } catch (err) {
        console.log(` FAILED (${err.message}) — skipping`);
        continue;
      }
    } else {
      console.log(`  Using cached ${fname}`);
    }

    let count = 0;
    await streamJsonGz(dest, rec => {
      const rating = parseFloat(rec.average_rating);
      const grUrl  = rec.url || rec.link;
      if (!grUrl || isNaN(rating) || rating === 0) return;

      const entry = { rating, url: grUrl };

      if (rec.isbn  && rec.isbn.trim())  byIsbn.set(rec.isbn.trim(),   entry);
      if (rec.isbn13 && rec.isbn13.trim()) byIsbn.set(rec.isbn13.trim(), entry);

      const nt = normalizeTitle(rec.title);
      if (nt && !byTitle.has(nt)) byTitle.set(nt, entry); // first-match wins
      count++;
    });

    console.log(`    → ${count.toLocaleString()} usable records`);
    totalRecords += count;
  }

  console.log(`\n  Total lookup entries: ${totalRecords.toLocaleString()}`);
  console.log(`  By ISBN: ${byIsbn.size.toLocaleString()}, By title: ${byTitle.size.toLocaleString()}\n`);
  return { byIsbn, byTitle };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n── Building Goodreads lookup from UCSD dataset ──────────────────\n');
  const { byIsbn, byTitle } = await buildLookup();

  // Auth + fetch books missing Goodreads data
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: authData, error: authErr } = await sb.auth.signInWithPassword({
    email: process.env.TWB_EMAIL, password: process.env.TWB_PASSWORD,
  });
  if (authErr) { console.error('Auth failed:', authErr.message); process.exit(1); }
  const userId = authData.user.id;

  const { data: grBooks } = await sb.from('goodreads').select('book_id');
  const grIds = new Set((grBooks || []).map(r => r.book_id));

  const { data: allBooks, error: bErr } = await sb.from('books')
    .select('id, title, isbn').order('title');
  if (bErr) { console.error('Fetch failed:', bErr.message); process.exit(1); }

  const missing = allBooks.filter(b => !grIds.has(b.id));
  console.log(`Books missing Goodreads data: ${missing.length}\n`);

  // Match each book
  const matched   = [];
  const unmatched = [];

  for (const book of missing) {
    let entry = null;

    // 1. Try ISBN
    if (book.isbn && book.isbn.trim()) {
      entry = byIsbn.get(book.isbn.trim());
    }

    // 2. Try normalized title
    if (!entry) {
      const nt = normalizeTitle(book.title);
      entry = byTitle.get(nt);
    }

    if (entry) {
      matched.push({ ...book, rating: entry.rating, grUrl: entry.url });
    } else {
      unmatched.push(book);
    }
  }

  console.log(`── Match results ──────────────────────────────────────`);
  console.log(`  Matched   : ${matched.length}`);
  console.log(`  Unmatched : ${unmatched.length}`);

  if (!apply) {
    console.log('\n── Sample matches (first 15) ─────────────────────────');
    matched.slice(0, 15).forEach(b =>
      console.log(`  • ${b.title}\n    ${b.rating} — ${b.grUrl}`)
    );
    console.log('\n── Unmatched (first 15) ──────────────────────────────');
    unmatched.slice(0, 15).forEach(b =>
      console.log(`  • ${b.title} [ISBN: ${b.isbn || 'none'}]`)
    );
    console.log('\nDry run — no changes made. Re-run with --apply to save.\n');
    process.exit(0);
  }

  // Write to DB in batches of 50
  const BATCH = 50;
  let done = 0;
  let errors = 0;

  for (let i = 0; i < matched.length; i += BATCH) {
    const chunk = matched.slice(i, i + BATCH);
    await Promise.all(chunk.map(async b => {
      const grRow = { book_id: b.id, user_id: userId, url: b.grUrl, average_rating: b.rating };
      const { error: grErr } = await sb.from('goodreads')
        .upsert(grRow, { onConflict: 'book_id' });
      if (grErr) { errors++; return; }
      await sb.from('books').update({ goodreads_rating: b.rating }).eq('id', b.id);
    }));
    done += chunk.length;
    process.stdout.write(`\r  Saving ${done}/${matched.length}…`);
  }

  console.log(`\n\n✓ ${done - errors} books updated. ${errors} errors.`);
  if (unmatched.length) {
    console.log(`  ${unmatched.length} books still unmatched — may need manual lookup or broader dataset.`);
    const unmatchedFile = path.join(__dirname, 'goodreads-unmatched.txt');
    fs.writeFileSync(unmatchedFile, unmatched.map(b => `${b.title}\t${b.isbn || ''}`).join('\n'));
    console.log(`  Unmatched list saved to: ${unmatchedFile}`);
  }
  console.log();
})();
