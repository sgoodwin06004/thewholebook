// Generates AI Review Summary entries for books that have no professional reviews.
// Uses the Claude API to produce structured markdown summaries matching existing entries.
// Usage: node scripts/generate-ai-reviews.js [--limit N]   (dry run, shows N samples)
//        node scripts/generate-ai-reviews.js --apply       (generates + saves all)
//        node scripts/generate-ai-reviews.js --apply --limit 20  (save first 20 only)

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';

const apply = process.argv.includes('--apply');
const limitIdx = process.argv.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1]) : null;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\nError: ANTHROPIC_API_KEY is not set in your .env file.\n');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Prompt ────────────────────────────────────────────────────────────────────
function buildPrompt(title, author, isbn, year) {
  return `You are writing an AI Review Summary for a book that has been challenged or banned in U.S. schools or libraries. Your summary will appear on thewholebook.org, a counter-database that documents book banning and defends literary freedom.

Write a structured critical reception summary for:
Title: ${title}
Author: ${author}${isbn ? `\nISBN: ${isbn}` : ''}${year ? `\nYear: ${year}` : ''}

The summary should follow this exact structure and tone (use markdown):

1. Opening paragraph — A 2-3 sentence overview of the book's critical reception and its place in the censorship landscape.

2. ### 1. Professional & Critical Reception
   - Bullet points covering how major review outlets (Publishers Weekly, Kirkus, School Library Journal, Booklist, NYT, etc.) received the book
   - Note any awards or distinctions
   - Note the target audience and why critics value it

3. ### 2. Censorship & Challenges
   - Specific documented challenges, bans, or removals (school districts, states, years where known)
   - Organizations behind the challenges (Moms for Liberty, PEN America reports, ALA data, etc.)
   - Grounds cited for challenges

4. ### 3. Critical Data Summary
   A markdown table with these rows:
   | Aspect | Reception Summary |
   | Goodreads Score | approximate score / 5 |
   | Critical View | one-line summary |
   | Status | Challenged / Banned / Frequently Challenged |
   | Key Theme | what makes this book significant |

5. **Final Takeaway:** — 2-3 sentences summarising why the book matters and what the challenges reveal about the broader censorship movement.

Keep the tone factual, journalistic, and sympathetic to intellectual freedom. Do not include conversational sign-offs or offers to help further. Do not fabricate specific dates or court cases — use hedged language ("reportedly", "in several districts", "according to PEN America") if uncertain. Length should be 400-600 words.`;
}

// ── Generate one review ───────────────────────────────────────────────────────
async function generateReview(title, author, isbn, year) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: buildPrompt(title, author, isbn, year) }],
  });
  return msg.content[0].text.trim();
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { error: authErr } = await sb.auth.signInWithPassword({
    email:    process.env.TWB_EMAIL,
    password: process.env.TWB_PASSWORD,
  });
  if (authErr) { console.error('Auth failed:', authErr.message); process.exit(1); }

  // Find books with no pro reviews at all
  const { data: allBooks }   = await sb.from('books').select('id, title, author, isbn, publication_year, user_id');
  const { data: allReviews } = await sb.from('pro_reviews').select('book_id');
  const reviewedIds = new Set((allReviews || []).map(r => r.book_id));
  let books = (allBooks || []).filter(b => !reviewedIds.has(b.id));

  if (limit) books = books.slice(0, limit);

  console.log(`\nBooks needing AI reviews: ${books.length}${limit ? ` (limited to ${limit})` : ''}\n`);
  if (!books.length) { console.log('Nothing to do!\n'); process.exit(0); }

  if (!apply) {
    // Dry run — generate and show 2 samples only
    console.log('── Dry run: generating 2 sample reviews ────────────────\n');
    for (const book of books.slice(0, 2)) {
      console.log(`Generating: ${book.title} — ${book.author}`);
      try {
        const summary = await generateReview(book.title, book.author, book.isbn, book.publication_year);
        console.log('\n' + summary.slice(0, 600) + '...\n');
        console.log('─'.repeat(60) + '\n');
      } catch(e) {
        console.error('  Error:', e.message);
      }
      await sleep(1000);
    }
    console.log('Dry run complete. Re-run with --apply to generate and save all.\n');
    process.exit(0);
  }

  // Generate and save
  let done = 0, errors = 0;

  for (const book of books) {
    process.stdout.write(
      `\r  [${String(done + 1).padStart(4)}/${books.length}] ${book.title.slice(0, 50).padEnd(50)}`
    );

    try {
      const summary = await generateReview(book.title, book.author, book.isbn, book.publication_year);

      const { error: insertErr } = await sb.from('pro_reviews').insert({
        book_id:   book.id,
        user_id:   book.user_id,
        source:    'AI Review Summary',
        summary,
        published: false,   // requires manual review before going live
        url:       null,
        award:     null,
      });

      if (insertErr) {
        errors++;
        process.stdout.write(` ✗ ${insertErr.message}`);
      } else {
        done++;
      }
    } catch(e) {
      errors++;
      // On rate limit, back off and retry once
      if (e.status === 429) {
        await sleep(10000);
        try {
          const summary = await generateReview(book.title, book.author, book.isbn, book.publication_year);
          await sb.from('pro_reviews').insert({
            book_id: book.id, user_id: book.user_id,
            source: 'AI Review Summary', summary, published: false, url: null, award: null,
          });
          done++; errors--;
        } catch(e2) { /* skip */ }
      }
    }

    // ~1 req/sec to stay within Claude API rate limits
    await sleep(1100);
  }

  console.log(`\n\n✓ ${done} AI reviews generated and saved (unpublished).`);
  if (errors) console.log(`  ${errors} errors — re-run to retry.`);
  console.log('  Reviews are saved with published=false — publish them individually via the admin panel.\n');
})();
