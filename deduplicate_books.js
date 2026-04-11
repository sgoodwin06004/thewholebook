'use strict';

require('dotenv').config();

const SUPABASE_URL = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SERVICE_KEY  = process.env.SERVICE_KEY;

if (!SERVICE_KEY) {
  console.error('Error: SERVICE_KEY not set in .env');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
if (DRY_RUN) console.log('*** DRY RUN — no changes will be made ***\n');

const h = {
  apikey:         SERVICE_KEY,
  Authorization:  `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer:         'return=minimal',
};

function normalize(t) {
  return (t ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchAllPages(path) {
  const results = [];
  let offset = 0;
  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${path}&limit=1000&offset=${offset}`,
      { headers: h }
    );
    if (!res.ok) throw new Error(`Fetch ${path}: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    results.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return results;
}

async function patch(table, id, body) {
  if (DRY_RUN) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: h, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${table} id=${id}: ${res.status} ${await res.text()}`);
}

async function del(table, id) {
  if (DRY_RUN) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE', headers: h,
  });
  if (!res.ok) throw new Error(`DELETE ${table} id=${id}: ${res.status} ${await res.text()}`);
}

// Pick the "winner" from a group of duplicate books.
// Prefers: has rated_reports > has author > has cover_url > oldest created_at
function pickWinner(books, ratedBookIds) {
  return [...books].sort((a, b) => {
    const aRated = ratedBookIds.has(a.id) ? 0 : 1;
    const bRated = ratedBookIds.has(b.id) ? 0 : 1;
    if (aRated !== bRated) return aRated - bRated;

    const aAuthor = a.author ? 0 : 1;
    const bAuthor = b.author ? 0 : 1;
    if (aAuthor !== bAuthor) return aAuthor - bAuthor;

    const aCover = a.cover_url ? 0 : 1;
    const bCover = b.cover_url ? 0 : 1;
    if (aCover !== bCover) return aCover - bCover;

    return new Date(a.created_at) - new Date(b.created_at); // oldest first
  })[0];
}

async function main() {
  console.log('Loading all books…');
  const books = await fetchAllPages('books?select=id,title,author,cover_url,created_at');
  console.log(`  ${books.length} books total.\n`);

  // Group by normalized title
  const groups = new Map();
  for (const b of books) {
    const key = normalize(b.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const dupeGroups = [...groups.values()].filter(g => g.length > 1);
  console.log(`Found ${dupeGroups.length} duplicate title groups.\n`);

  if (dupeGroups.length === 0) {
    console.log('No duplicates — nothing to do.');
    return;
  }

  // Load child tables so we know which books have related data
  console.log('Loading child tables…');
  const [rated, goodreads, proReviews, experiences, collabs] = await Promise.all([
    fetchAllPages('rated_reports?select=id,book_id'),
    fetchAllPages('goodreads?select=id,book_id'),
    fetchAllPages('pro_reviews?select=id,book_id'),
    fetchAllPages('reader_experiences?select=id,book_id'),
    fetchAllPages('book_collaborators?select=id,book_id'),
  ]);

  const ratedBookIds = new Set(rated.map(r => r.book_id));

  // Build lookup maps: book_id → [row ids]
  const childMap = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.book_id)) m.set(r.book_id, []);
      m.get(r.book_id).push(r.id);
    }
    return m;
  };

  const ratedMap    = childMap(rated);
  const grMap       = childMap(goodreads);
  const prMap       = childMap(proReviews);
  const expMap      = childMap(experiences);
  const collabMap   = childMap(collabs);

  const CHILD_TABLES = [
    { name: 'rated_reports',      map: ratedMap  },
    { name: 'goodreads',          map: grMap     },
    { name: 'pro_reviews',        map: prMap     },
    { name: 'reader_experiences', map: expMap    },
    { name: 'book_collaborators', map: collabMap },
  ];

  let totalMerged = 0, totalDeleted = 0, errors = 0;

  for (const group of dupeGroups) {
    const winner = pickWinner(group, ratedBookIds);
    const losers = group.filter(b => b.id !== winner.id);

    console.log(`DUPLICATE: "${group[0].title}"`);
    console.log(`  Keep  : ${winner.id} (author: ${winner.author || '—'}, rated: ${ratedBookIds.has(winner.id)})`);

    for (const loser of losers) {
      console.log(`  Remove: ${loser.id} (author: ${loser.author || '—'}, rated: ${ratedBookIds.has(loser.id)})`);

      // Re-point all child rows from loser → winner
      for (const { name, map } of CHILD_TABLES) {
        const childIds = map.get(loser.id) || [];
        for (const childId of childIds) {
          try {
            await patch(name, childId, { book_id: winner.id });
            console.log(`    → moved ${name} row ${childId} to winner`);
          } catch (err) {
            // Conflict: winner already has a row in this table (unique constraint)
            // Safe to just delete the loser's row instead
            console.log(`    → ${name} row ${childId} conflicts (winner already has one) — deleting`);
            try { await del(name, childId); } catch (e) { console.error(`      del failed: ${e.message}`); errors++; }
          }
        }
      }

      // Delete the loser book
      try {
        await del('books', loser.id);
        console.log(`  Deleted book ${loser.id}`);
        totalDeleted++;
      } catch (err) {
        console.error(`  Failed to delete book ${loser.id}: ${err.message}`);
        errors++;
      }
    }

    totalMerged++;
    console.log('');
  }

  console.log('── Summary ──────────────────────────────────');
  console.log(`  Duplicate groups : ${totalMerged}`);
  console.log(`  Books deleted    : ${totalDeleted}`);
  console.log(`  Errors           : ${errors}`);
  if (DRY_RUN) console.log('\n  (DRY RUN — nothing was changed)');
  console.log('─────────────────────────────────────────────');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
