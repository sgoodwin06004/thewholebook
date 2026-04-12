// One-off script: unpublish all books where cover_url is null or empty
// Usage: node scripts/unpublish-no-cover.js [--apply]
//   Without --apply it does a dry run and prints the count + titles only.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';

const apply = process.argv.includes('--apply');

(async () => {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // Authenticate as admin so RLS permits the update
  const { error: authErr } = await sb.auth.signInWithPassword({
    email:    process.env.TWB_EMAIL,
    password: process.env.TWB_PASSWORD,
  });
  if (authErr) { console.error('Auth failed:', authErr.message); process.exit(1); }

  // Find all published books with no cover_url (null or empty string)
  const [{ data: nullCovers, error: e1 }, { data: emptyCovers, error: e2 }] = await Promise.all([
    sb.from('books').select('id, title').eq('published', true).is('cover_url', null),
    sb.from('books').select('id, title').eq('published', true).eq('cover_url', ''),
  ]);
  if (e1) { console.error('Fetch failed:', e1.message); process.exit(1); }
  if (e2) { console.error('Fetch failed:', e2.message); process.exit(1); }

  const books = [...(nullCovers || []), ...(emptyCovers || [])];

  if (!books.length) { console.log('\nNo published books without a cover image. Nothing to do.\n'); process.exit(0); }

  console.log(`\nBooks published with no cover image: ${books.length}`);
  books.forEach(b => console.log(`  • [${b.id}] ${b.title}`));

  if (!apply) {
    console.log('\nDry run — no changes made. Re-run with --apply to unpublish these books.\n');
    process.exit(0);
  }

  const ids = books.map(b => b.id);
  const BATCH = 100;
  let updated = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const { error: updateErr } = await sb
      .from('books')
      .update({ published: false })
      .in('id', chunk);
    if (updateErr) { console.error(`Update failed on batch ${i}–${i + chunk.length}:`, updateErr.message); process.exit(1); }
    updated += chunk.length;
    process.stdout.write(`\r  Updated ${updated}/${ids.length}…`);
  }

  console.log(`\n\n✓ ${ids.length} book(s) unpublished.\n`);
})();
