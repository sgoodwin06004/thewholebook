'use strict';

require('dotenv').config();

const SUPABASE_URL      = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';
const SERVICE_KEY       = process.env.SERVICE_KEY;

function reverseAuthorName(name) {
  if (!name) return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name;
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return `${last}, ${first}`;
}

function alreadyReversed(name) {
  return name && name.includes(',');
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('Error: SERVICE_KEY env var required.');
    console.error('Run: read -s SERVICE_KEY && export SERVICE_KEY=$SERVICE_KEY');
    process.exit(1);
  }

  console.log('Fetching all books from database...');
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/books?select=id,title,author&limit=2000`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );

  if (!res.ok) {
    console.error('Failed to fetch books:', res.status, await res.text());
    process.exit(1);
  }

  const books = await res.json();
  console.log(`Found ${books.length} books.`);

  const toFix = books.filter(b => b.author && !alreadyReversed(b.author));
  console.log(`Need to fix: ${toFix.length} authors\n`);

  let fixed = 0, failed = 0;

  for (const book of toFix) {
    const newAuthor = reverseAuthorName(book.author);
    console.log(`  "${book.author}" → "${newAuthor}"`);

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/books?id=eq.${book.id}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ author: newAuthor }),
      }
    );

    if (r.ok) { fixed++; }
    else { console.error(`    Failed: ${r.status} ${await r.text()}`); failed++; }
  }

  console.log(`\nDone: ${fixed} fixed, ${failed} failed.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
