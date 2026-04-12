// Fetches missing book cover images from Open Library and Google Books.
// Usage: node scripts/fetch-covers.js          (dry run — search only, no DB changes)
//        node scripts/fetch-covers.js --apply  (save covers + re-publish books)

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
        // Follow one redirect manually (Open Library uses 302s)
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

// ── Cover lookup ──────────────────────────────────────────────────────────────
async function findCover(isbn, title) {
  // 1. Open Library — fast HEAD check, no API key needed
  const olUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;
  const olStatus = await headRequest(olUrl);
  if (olStatus === 200) {
    return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
  }

  await sleep(150);

  // 2. Google Books — JSON, no API key needed for basic queries
  const gbData = await getJson(
    `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&fields=items/volumeInfo/imageLinks&maxResults=1`
  );
  const links = gbData?.items?.[0]?.volumeInfo?.imageLinks;
  if (links) {
    const raw = links.extraLarge || links.large || links.medium || links.small || links.thumbnail;
    if (raw) {
      return raw
        .replace(/^http:\/\//, 'https://')   // force HTTPS
        .replace(/&edge=curl/g, '')           // remove curl effect
        .replace(/zoom=\d/, 'zoom=1');        // normalise zoom
    }
  }

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

  // Fetch all books without a cover
  const [{ data: nullCovers, error: e1 }, { data: emptyCovers, error: e2 }] = await Promise.all([
    sb.from('books').select('id, title, isbn').is('cover_url', null),
    sb.from('books').select('id, title, isbn').eq('cover_url', ''),
  ]);
  if (e1) { console.error('Fetch failed:', e1.message); process.exit(1); }
  if (e2) { console.error('Fetch failed:', e2.message); process.exit(1); }

  const all      = [...(nullCovers || []), ...(emptyCovers || [])];
  const withIsbn = all.filter(b => b.isbn && b.isbn.trim());
  const noIsbn   = all.filter(b => !b.isbn || !b.isbn.trim());

  console.log(`\nBooks without a cover image: ${all.length}`);
  console.log(`  With ISBN (searchable): ${withIsbn.length}`);
  console.log(`  Without ISBN (skipped): ${noIsbn.length}\n`);

  if (!withIsbn.length) { console.log('Nothing to search.\n'); process.exit(0); }

  // Search for each cover
  const found    = [];
  const notFound = [];

  for (let i = 0; i < withIsbn.length; i++) {
    const book = withIsbn[i];
    process.stdout.write(
      `\r  [${String(i + 1).padStart(4)}/${withIsbn.length}] ${book.title.slice(0, 45).padEnd(45)}`
    );

    const url = await findCover(book.isbn.trim(), book.title);
    if (url) found.push({ ...book, coverUrl: url });
    else     notFound.push(book);

    await sleep(250); // ~4 req/s — well within free-tier limits
  }

  console.log(`\n\n── Results ──────────────────────────────────────`);
  console.log(`  Covers found : ${found.length}`);
  console.log(`  Not found    : ${notFound.length}`);
  if (noIsbn.length) console.log(`  No ISBN      : ${noIsbn.length} (skipped)`);

  if (!apply) {
    console.log('\n── Sample (first 8 found) ───────────────────────');
    found.slice(0, 8).forEach(b => console.log(`  • ${b.title}\n    ${b.coverUrl}`));
    if (notFound.length) {
      console.log('\n── Not found (first 10) ─────────────────────────');
      notFound.slice(0, 10).forEach(b => console.log(`  • ${b.title} [ISBN: ${b.isbn}]`));
    }
    console.log('\nDry run — no changes made. Re-run with --apply to save covers and re-publish.\n');
    process.exit(0);
  }

  // Save cover URLs and re-publish in batches
  const BATCH = 50;
  let done = 0;
  for (let i = 0; i < found.length; i += BATCH) {
    const chunk = found.slice(i, i + BATCH);
    await Promise.all(chunk.map(b =>
      sb.from('books')
        .update({ cover_url: b.coverUrl, published: true })
        .eq('id', b.id)
    ));
    done += chunk.length;
    process.stdout.write(`\r  Saving ${done}/${found.length}…`);
  }

  console.log(`\n\n✓ ${found.length} books updated with cover images and re-published.`);
  if (notFound.length) {
    console.log(`  ${notFound.length} books still have no cover — may need manual lookup.`);
  }
  if (noIsbn.length) {
    console.log(`  ${noIsbn.length} books were skipped (no ISBN on file).`);
  }
  console.log();
})();
