// Fetches Google Alert RSS feeds and stores book-ban news articles in Supabase.
// Applies a relevance filter to drop noise (food bans, sports bans, etc.).
// Usage: node scripts/fetch-rss-news.js         (dry run — shows what would be saved)
//        node scripts/fetch-rss-news.js --apply  (save new articles to DB)

require('dotenv').config();
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL      || 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';

const FEEDS = [
  { url: 'https://www.google.com/alerts/feeds/00866925138509230325/5591207799340368795', name: 'Banned Books' },
  { url: 'https://www.google.com/alerts/feeds/00866925138509230325/672832266639637898',  name: 'Book Ban' },
  { url: 'https://www.google.com/alerts/feeds/00866925138509230325/3070822592170819576', name: 'Library Censorship / Book Removal' },
  { url: 'https://www.google.com/alerts/feeds/00866925138509230325/4083821401613923775', name: 'Book Challenge .edu/.gov' },
  { url: 'https://www.google.com/alerts/feeds/00866925138509230325/9026022860445592565', name: 'PEN America / ALA' },
];

// Entry must match at least one book term AND one ban/censorship term to pass,
// and must not match any noise pattern.
const BOOK_TERMS = ['book ban', 'banned book', 'book remov', 'book challeng', 'librar', 'reading list', 'literary censor', 'curriculum ban', 'pen america', 'ala book'];
const BAN_TERMS  = ['ban', 'censor', 'challeng', 'remov', 'restrict', 'prohibit', 'pulled', 'suppress'];

// If title or snippet contains any of these, drop the article outright.
const NOISE_PATTERNS = [
  'book an ad', 'book a table', 'book a room', 'book tickets',
  'social media ban', 'food ban', 'fried food', 'diet ban',
  'sports ban', 'fan ban', 'player ban', 'golf ban', 'nhl ban', 'nba ban', 'nfl ban',
  'protest ban', 'palestine action ban', 'demonstration ban',
  'travel ban', 'immigration ban', 'drug ban', 'alcohol ban',
  'meghan markle', 'royal family', 'prince harry', 'prince william',
];

const apply = process.argv.includes('--apply');
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheWholeBook/1.0)' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/<[^>]+>/g, '') // strip HTML tags from snippets
    .trim();
}

function extractRealUrl(googleUrl) {
  const match = googleUrl.match(/[?&]url=([^&]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { /* fall through */ }
  }
  return googleUrl;
}

function isRelevant(title, snippet) {
  const combined = (title + ' ' + snippet).toLowerCase();
  if (NOISE_PATTERNS.some(p => combined.includes(p))) return false;
  const hasBook = BOOK_TERMS.some(t => combined.includes(t));
  const hasBan  = BAN_TERMS.some(t => combined.includes(t));
  return hasBook && hasBan;
}

function parseAtomEntries(xml, alertName) {
  const entries = [];
  const entryBlocks = xml.match(/<entry>([\s\S]*?)<\/entry>/g) || [];

  for (const block of entryBlocks) {
    const idMatch      = block.match(/<id>([^<]+)<\/id>/);
    const titleMatch   = block.match(/<title[^>]*>([^<]+)<\/title>/);
    const linkMatch    = block.match(/<link[^>]*href="([^"]+)"/);
    const pubMatch     = block.match(/<published>([^<]+)<\/published>/);
    const contentMatch = block.match(/<content[^>]*>([\s\S]*?)<\/content>/);

    if (!idMatch || !titleMatch || !linkMatch) continue;

    const id          = idMatch[1].trim();
    const title       = decodeEntities(titleMatch[1]);
    const rawUrl      = linkMatch[1];
    const url         = extractRealUrl(rawUrl);
    const publishedAt = pubMatch ? pubMatch[1].trim() : null;
    const snippet     = contentMatch ? decodeEntities(contentMatch[1]).slice(0, 300) : '';

    entries.push({ id, title, url, snippet, publishedAt, alertName });
  }

  return entries;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${apply ? '🟢 APPLY MODE' : '🔵 DRY RUN'} — fetching ${FEEDS.length} feeds\n`);

  const allEntries = [];
  let totalFiltered = 0;

  for (const feed of FEEDS) {
    process.stdout.write(`  Fetching [${feed.name}]… `);
    let xml;
    try {
      xml = await fetchUrl(feed.url);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      continue;
    }

    const entries = parseAtomEntries(xml, feed.name);
    const relevant = entries.filter(e => isRelevant(e.title, e.snippet));
    totalFiltered += (entries.length - relevant.length);
    console.log(`${entries.length} entries → ${relevant.length} relevant`);
    allEntries.push(...relevant);
  }

  // Deduplicate by ID within this run (different feeds can pick up the same article)
  const seen = new Set();
  const unique = allEntries.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });

  console.log(`\n  Total: ${unique.length} unique relevant articles (${totalFiltered} filtered as noise)\n`);

  if (unique.length === 0) { console.log('  Nothing to save.\n'); return; }

  // Preview
  unique.forEach((e, i) => {
    console.log(`  ${i + 1}. [${e.alertName}] ${e.title}`);
    console.log(`     ${e.url.slice(0, 80)}`);
    if (e.snippet) console.log(`     "${e.snippet.slice(0, 100)}…"`);
    console.log();
  });

  if (!apply) {
    console.log('  Dry run — run with --apply to save to Supabase.\n');
    return;
  }

  // Upsert — existing entries are skipped (onConflict: id), so re-running is safe
  const rows = unique.map(e => ({
    id:           e.id,
    alert_name:   e.alertName,
    title:        e.title,
    url:          e.url,
    snippet:      e.snippet || null,
    published_at: e.publishedAt || null,
    published:    false,
    rejected:     false,
  }));

  const { error } = await sb.from('news_feed').upsert(rows, { onConflict: 'id', ignoreDuplicates: true });

  if (error) {
    console.error('  Supabase error:', error.message);
  } else {
    console.log(`  Saved ${rows.length} articles to news_feed (duplicates skipped).\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
