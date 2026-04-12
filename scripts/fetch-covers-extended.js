// Extended cover search for books that fetch-covers.js couldn't find.
// Tries: Open Library title search, Google Books title search, Bookcover.zone
// Usage: node scripts/fetch-covers-extended.js          (dry run)
//        node scripts/fetch-covers-extended.js --apply  (save + re-publish)

require('dotenv').config();
const https  = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';
const apply = process.argv.includes('--apply');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function headRequest(url) {
  return new Promise(resolve => {
    try {
      const req = https.request(url, { method: 'HEAD' }, res => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          return headRequest(res.headers.location).then(resolve);
        }
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.setTimeout(8000, () => { req.destroy(); resolve(0); });
      req.end();
    } catch { resolve(0); }
  });
}

function getJson(url) {
  return new Promise(resolve => {
    try {
      https.get(url, { headers: { 'User-Agent': 'thewholebook/1.0' } }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    } catch { resolve(null); }
  });
}

function enc(str) { return encodeURIComponent((str || '').trim()); }

// ── Source 1: Open Library search by title + author ───────────────────────────
async function tryOpenLibraryTitle(title, author) {
  const q = author ? `title=${enc(title)}&author=${enc(author)}` : `title=${enc(title)}`;
  const data = await getJson(
    `https://openlibrary.org/search.json?${q}&fields=cover_i&limit=1`
  );
  const coverId = data?.docs?.[0]?.cover_i;
  if (!coverId) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`;
}

// ── Source 2: Google Books search by title + author ───────────────────────────
async function tryGoogleBooksTitle(title, author) {
  const q = author
    ? `intitle:${enc(title)}+inauthor:${enc(author)}`
    : `intitle:${enc(title)}`;
  const data = await getJson(
    `https://www.googleapis.com/books/v1/volumes?q=${q}&fields=items/volumeInfo/imageLinks&maxResults=1`
  );
  const links = data?.items?.[0]?.volumeInfo?.imageLinks;
  if (!links) return null;
  const raw = links.extraLarge || links.large || links.medium || links.small || links.thumbnail;
  if (!raw) return null;
  return raw.replace(/^http:\/\//, 'https://').replace(/&edge=curl/g, '').replace(/zoom=\d/, 'zoom=1');
}

// ── Source 3: Bookcover.zone by ISBN ─────────────────────────────────────────
async function tryBookcoverZone(isbn) {
  if (!isbn) return null;
  const url = `https://bookcover.zone/api?ean=${enc(isbn)}`;
  const data = await getJson(url);
  // Returns { url: "..." } or { error: ... }
  if (data?.url && !data.error) {
    const status = await headRequest(data.url);
    if (status === 200) return data.url;
  }
  return null;
}

// ── Source 4: Open Library by ISBN with title fallback variation ──────────────
async function tryOpenLibraryIsbn10(isbn) {
  if (!isbn || isbn.length !== 13) return null;
  // Convert ISBN-13 to ISBN-10 (first 9 digits after 978/979 prefix + check digit)
  const digits = isbn.replace(/[^0-9]/g, '');
  if (digits.length !== 13) return null;
  const core = digits.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * parseInt(core[i]);
  const check = (11 - (sum % 11)) % 11;
  const isbn10 = core + (check === 10 ? 'X' : check);
  const url = `https://covers.openlibrary.org/b/isbn/${isbn10}-L.jpg?default=false`;
  const status = await headRequest(url);
  if (status === 200) return `https://covers.openlibrary.org/b/isbn/${isbn10}-L.jpg`;
  return null;
}

// ── Combined lookup ───────────────────────────────────────────────────────────
async function findCoverExtended(isbn, title, author) {
  // Try ISBN-10 conversion first (fast)
  const ol10 = await tryOpenLibraryIsbn10(isbn);
  if (ol10) return { url: ol10, source: 'Open Library (ISBN-10)' };

  await sleep(150);

  // Open Library title search
  const olTitle = await tryOpenLibraryTitle(title, author);
  if (olTitle) return { url: olTitle, source: 'Open Library (title)' };

  await sleep(150);

  // Google Books title search
  const gbTitle = await tryGoogleBooksTitle(title, author);
  if (gbTitle) return { url: gbTitle, source: 'Google Books (title)' };

  await sleep(150);

  // Bookcover.zone
  const bcz = await tryBookcoverZone(isbn);
  if (bcz) return { url: bcz, source: 'Bookcover.zone' };

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { error: authErr } = await sb.auth.signInWithPassword({
    email:    process.env.TWB_EMAIL,
    password: process.env.TWB_PASSWORD,
  });
  if (authErr) { console.error('Auth failed:', authErr.message); process.exit(1); }

  // Only books still missing a cover
  const [{ data: nullCovers, error: e1 }, { data: emptyCovers, error: e2 }] = await Promise.all([
    sb.from('books').select('id, title, author, isbn').is('cover_url', null),
    sb.from('books').select('id, title, author, isbn').eq('cover_url', ''),
  ]);
  if (e1 || e2) { console.error('Fetch failed:', (e1||e2).message); process.exit(1); }

  const books = [...(nullCovers||[]), ...(emptyCovers||[])];
  console.log(`\nBooks still without a cover: ${books.length}\n`);

  if (!books.length) { console.log('Nothing to do!\n'); process.exit(0); }

  const found    = [];
  const notFound = [];
  const sourceCounts = {};

  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    process.stdout.write(
      `\r  [${String(i + 1).padStart(4)}/${books.length}] ${book.title.slice(0, 45).padEnd(45)}`
    );

    const result = await findCoverExtended(book.isbn, book.title, book.author);
    if (result) {
      found.push({ ...book, coverUrl: result.url, source: result.source });
      sourceCounts[result.source] = (sourceCounts[result.source] || 0) + 1;
    } else {
      notFound.push(book);
    }

    await sleep(300);
  }

  console.log(`\n\n── Results ──────────────────────────────────────`);
  console.log(`  Covers found : ${found.length}`);
  console.log(`  Not found    : ${notFound.length}`);
  console.log(`\n── By source ────────────────────────────────────`);
  Object.entries(sourceCounts).forEach(([s, n]) => console.log(`  ${s}: ${n}`));

  if (!apply) {
    console.log('\n── Sample (first 8 found) ───────────────────────');
    found.slice(0, 8).forEach(b => console.log(`  • ${b.title} [${b.source}]\n    ${b.coverUrl}`));
    if (notFound.length) {
      console.log('\n── Still not found (first 10) ───────────────────');
      notFound.slice(0, 10).forEach(b => console.log(`  • ${b.title} [ISBN: ${b.isbn||'none'}]`));
    }
    console.log('\nDry run — no changes made. Re-run with --apply to save.\n');
    process.exit(0);
  }

  // Save in batches
  const BATCH = 50;
  let done = 0;
  for (let i = 0; i < found.length; i += BATCH) {
    const chunk = found.slice(i, i + BATCH);
    await Promise.all(chunk.map(b =>
      sb.from('books').update({ cover_url: b.coverUrl, published: true }).eq('id', b.id)
    ));
    done += chunk.length;
    process.stdout.write(`\r  Saving ${done}/${found.length}…`);
  }

  console.log(`\n\n✓ ${found.length} more books updated with cover images and re-published.`);
  if (notFound.length) console.log(`  ${notFound.length} books still have no cover.`);
  console.log();
})();
