'use strict';
/**
 * Import Top 100 Most Frequently Challenged Books (ALA 2010–2019 list)
 * plus the most-banned titles from 2020–2024.
 *
 * DRY RUN by default — pass --run to actually insert.
 *
 *   node scripts/import_top100.js          # dry run (safe, shows what would be added)
 *   node scripts/import_top100.js --run    # inserts new books into Supabase
 *
 * Books already in the database (matched by normalised title) are skipped.
 * ISBNs are the most widely cited edition; verify before using as canonical.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY
  || 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz'; // falls back to anon key

const DRY_RUN = !process.argv.includes('--run');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── BOOK DATA ─────────────────────────────────────────────────────────────────
// Source: ALA Top 100 Most Frequently Challenged Books 2010–2019
//         + ALA/PEN America most-challenged 2020–2024
// For series, the first volume is listed.
// ISBN = most commonly cited paperback/first-edition ISBN-13.
// null ISBN = no single canonical ISBN (anthology, series, or holy text).
// ─────────────────────────────────────────────────────────────────────────────
const BOOKS = [
  // ── ALA 2010-2019 TOP 100 ──────────────────────────────────────────────────
  { title: 'The Absolutely True Diary of a Part-Time Indian', author: 'Sherman Alexie',                    isbn: '978-0-316-01368-0', publication_year: 2007 },
  { title: 'Captain Underpants: The First Epic Novel',        author: 'Dav Pilkey',                        isbn: '978-0-590-84627-9', publication_year: 1997 },
  { title: 'Thirteen Reasons Why',                            author: 'Jay Asher',                         isbn: '978-1-59514-188-0', publication_year: 2007 },
  { title: 'Looking for Alaska',                              author: 'John Green',                        isbn: '978-0-525-47506-4', publication_year: 2005 },
  { title: 'Melissa',                                         author: 'Alex Gino',                         isbn: '978-0-545-81217-5', publication_year: 2015 },
  { title: 'And Tango Makes Three',                           author: 'Justin Richardson & Peter Parnell', isbn: '978-0-689-87845-3', publication_year: 2005 },
  { title: 'Drama',                                           author: 'Raina Telgemeier',                  isbn: '978-0-545-32698-8', publication_year: 2012 },
  { title: 'Fifty Shades of Grey',                            author: 'E.L. James',                        isbn: '978-0-345-80355-2', publication_year: 2011 },
  { title: 'ttyl',                                            author: 'Lauren Myracle',                    isbn: '978-0-525-47299-5', publication_year: 2004 },
  { title: 'The Bluest Eye',                                  author: 'Toni Morrison',                     isbn: '978-0-14-028036-3', publication_year: 1970 },
  { title: 'The Kite Runner',                                 author: 'Khaled Hosseini',                   isbn: '978-1-59448-000-3', publication_year: 2003 },
  { title: 'The Hunger Games',                                author: 'Suzanne Collins',                   isbn: '978-0-439-02348-1', publication_year: 2008 },
  { title: 'I Am Jazz',                                       author: 'Jazz Jennings & Jessica Herthel',   isbn: '978-0-8037-4072-5', publication_year: 2014 },
  { title: 'The Perks of Being a Wallflower',                 author: 'Stephen Chbosky',                   isbn: '978-1-47113-306-7', publication_year: 1999 },
  { title: 'To Kill a Mockingbird',                           author: 'Harper Lee',                        isbn: '978-0-06-112008-4', publication_year: 1960 },
  { title: 'Bone: Out from Boneville',                        author: 'Jeff Smith',                        isbn: '978-0-439-70623-1', publication_year: 1991 },
  { title: 'The Glass Castle',                                author: 'Jeannette Walls',                   isbn: '978-0-7432-4753-5', publication_year: 2005 },
  { title: 'Two Boys Kissing',                                author: 'David Levithan',                    isbn: '978-0-307-93190-6', publication_year: 2013 },
  { title: 'A Day in the Life of Marlon Bundo',               author: 'Jill Twiss',                        isbn: '978-1-452-17373-7', publication_year: 2018 },
  { title: 'Sex Is a Funny Word',                             author: 'Cory Silverberg',                   isbn: '978-1-58270-528-8', publication_year: 2015 },
  { title: 'The Agony of Alice',                              author: 'Phyllis Reynolds Naylor',           isbn: '978-0-689-81672-1', publication_year: 1985 },
  { title: "It's Perfectly Normal",                           author: 'Robie H. Harris',                   isbn: '978-0-7636-3518-9', publication_year: 1994 },
  { title: 'Nineteen Minutes',                                author: 'Jodi Picoult',                      isbn: '978-0-7434-9672-4', publication_year: 2007 },
  { title: 'Scary Stories to Tell in the Dark',               author: 'Alvin Schwartz',                    isbn: '978-0-06-443107-9', publication_year: 1981 },
  { title: 'Speak',                                           author: 'Laurie Halse Anderson',             isbn: '978-0-374-37152-0', publication_year: 1999 },
  { title: 'Brave New World',                                 author: 'Aldous Huxley',                     isbn: '978-0-06-085052-4', publication_year: 1932 },
  { title: 'Beyond Magenta: Transgender Teens Speak Out',     author: 'Susan Kuklin',                      isbn: '978-0-7636-5584-2', publication_year: 2014 },
  { title: 'Of Mice and Men',                                 author: 'John Steinbeck',                    isbn: '978-0-14-028335-7', publication_year: 1937 },
  { title: "The Handmaid's Tale",                             author: 'Margaret Atwood',                   isbn: '978-0-385-49081-8', publication_year: 1985 },
  { title: 'The Hate U Give',                                 author: 'Angie Thomas',                      isbn: '978-0-06-249853-3', publication_year: 2017 },
  { title: 'Fun Home: A Family Tragicomic',                   author: 'Alison Bechdel',                    isbn: '978-0-618-87171-3', publication_year: 2006 },
  { title: "It's a Book",                                     author: 'Lane Smith',                        isbn: '978-1-59643-606-9', publication_year: 2010 },
  { title: 'The Adventures of Huckleberry Finn',              author: 'Mark Twain',                        isbn: '978-0-14-028329-6', publication_year: 1884 },
  { title: 'The Things They Carried',                         author: "Tim O'Brien",                       isbn: '978-0-618-70641-5', publication_year: 1990 },
  { title: "What My Mother Doesn't Know",                     author: 'Sonya Sones',                       isbn: '978-0-689-83220-3', publication_year: 2001 },
  { title: 'A Child Called "It"',                             author: 'Dave Pelzer',                       isbn: '978-1-55874-366-4', publication_year: 1995 },
  { title: 'Bad Kitty Gets a Bath',                           author: 'Nick Bruel',                        isbn: '978-0-7636-3413-7', publication_year: 2008 },
  { title: 'Crank',                                           author: 'Ellen Hopkins',                     isbn: '978-1-4169-8024-5', publication_year: 2004 },
  { title: 'Nickel and Dimed',                                author: 'Barbara Ehrenreich',                isbn: '978-0-8050-8838-1', publication_year: 2001 },
  { title: 'Persepolis',                                      author: 'Marjane Satrapi',                   isbn: '978-0-375-71457-3', publication_year: 2000 },
  { title: 'The Adventures of Super Diaper Baby',             author: 'Dav Pilkey',                        isbn: '978-0-439-37605-1', publication_year: 2002 },
  { title: 'This Day in June',                                author: 'Gayle E. Pitman',                   isbn: '978-1-4338-1566-1', publication_year: 2014 },
  { title: 'This One Summer',                                 author: 'Mariko Tamaki',                     isbn: '978-1-59643-774-5', publication_year: 2014 },
  { title: 'A Bad Boy Can Be Good for a Girl',                author: 'Tanya Lee Stone',                   isbn: '978-0-439-49600-0', publication_year: 2006 },
  { title: 'Beloved',                                         author: 'Toni Morrison',                     isbn: '978-1-4000-3341-6', publication_year: 1987 },
  { title: 'Goosebumps: Welcome to Dead House',               author: 'R.L. Stine',                        isbn: '978-0-590-41900-7', publication_year: 1992 },
  { title: "In Our Mothers' House",                           author: 'Patricia Polacco',                  isbn: '978-0-399-25076-9', publication_year: 2009 },
  { title: 'Lush',                                            author: 'Natasha Friend',                    isbn: '978-0-439-85346-1', publication_year: 2003 },
  { title: 'The Catcher in the Rye',                          author: 'J.D. Salinger',                     isbn: '978-0-316-76948-0', publication_year: 1951 },
  { title: 'The Color Purple',                                author: 'Alice Walker',                      isbn: '978-0-15-619153-3', publication_year: 1982 },
  { title: 'The Curious Incident of the Dog in the Night-Time', author: 'Mark Haddon',                    isbn: '978-1-4000-3271-6', publication_year: 2003 },
  { title: 'The Holy Bible',                                  author: null,                                isbn: null,                publication_year: null },
  { title: 'This Book Is Gay',                                author: 'Juno Dawson',                       isbn: '978-1-4814-3330-0', publication_year: 2014 },
  { title: 'Eleanor & Park',                                  author: 'Rainbow Rowell',                    isbn: '978-1-250-01257-3', publication_year: 2013 },
  { title: 'Extremely Loud & Incredibly Close',               author: 'Jonathan Safran Foer',              isbn: '978-0-618-32970-3', publication_year: 2005 },
  { title: 'Gossip Girl',                                     author: 'Cecily von Ziegesar',               isbn: '978-0-316-91021-4', publication_year: 2002 },
  { title: 'House of Night: Marked',                          author: 'P.C. Cast',                         isbn: '978-0-312-36026-0', publication_year: 2007 },
  { title: "My Mom's Having a Baby!",                         author: 'Dori Hillestad Butler',             isbn: '978-0-8075-5344-1', publication_year: 2005 },
  { title: 'Neonomicon',                                      author: 'Alan Moore',                        isbn: '978-1-59276-974-3', publication_year: 2011 },
  { title: 'The Dirty Cowboy',                                author: 'Amy Timberlake',                    isbn: '978-0-374-31825-6', publication_year: 2003 },
  { title: 'The Giver',                                       author: 'Lois Lowry',                        isbn: '978-0-544-33606-1', publication_year: 1993 },
  { title: 'Anne Frank: The Diary of a Young Girl',           author: 'Anne Frank',                        isbn: '978-0-553-29698-7', publication_year: 1947 },
  { title: 'Bless Me, Ultima',                                author: 'Rudolfo Anaya',                     isbn: '978-0-446-60025-8', publication_year: 1972 },
  { title: 'Draw Me a Star',                                  author: 'Eric Carle',                        isbn: '978-0-399-21877-6', publication_year: 1992 },
  { title: 'Dreaming in Cuban',                               author: 'Cristina Garcia',                   isbn: '978-0-345-38143-9', publication_year: 1992 },
  { title: 'Fade',                                            author: 'Lisa McMann',                       isbn: '978-1-4231-0347-3', publication_year: 2008 },
  { title: 'The Family Book',                                 author: 'Todd Parr',                         isbn: '978-0-316-73896-0', publication_year: 2003 },
  { title: 'Feed',                                            author: 'M.T. Anderson',                     isbn: '978-0-7636-1726-9', publication_year: 2002 },
  { title: 'Go the F**k to Sleep',                            author: 'Adam Mansbach',                     isbn: '978-1-617-75106-0', publication_year: 2011 },
  { title: 'Habibi',                                          author: 'Craig Thompson',                    isbn: '978-0-375-42414-3', publication_year: 2011 },
  { title: 'The House of the Spirits',                        author: 'Isabel Allende',                    isbn: '978-0-553-38380-3', publication_year: 1982 },
  { title: "Jacob's New Dress",                               author: 'Sarah Hoffman & Ian Hoffman',       isbn: '978-0-8075-3077-0', publication_year: 2014 },
  { title: 'Lolita',                                          author: 'Vladimir Nabokov',                  isbn: '978-0-679-72020-1', publication_year: 1955 },
  { title: 'Monster',                                         author: 'Walter Dean Myers',                 isbn: '978-0-06-440731-5', publication_year: 1999 },
  { title: "Nasreen's Secret School",                         author: 'Jeanette Winter',                   isbn: '978-1-60060-360-0', publication_year: 2009 },
  { title: 'Saga, Vol. 1',                                    author: 'Brian K. Vaughan',                  isbn: '978-1-60706-601-9', publication_year: 2012 },
  { title: 'Stuck in the Middle',                             author: 'Ariel Schrag',                      isbn: '978-0-06-114066-8', publication_year: 2007 },
  { title: 'The Kingdom of Little Wounds',                    author: 'Susann Cokal',                      isbn: '978-0-7636-5784-6', publication_year: 2013 },
  { title: '1984',                                            author: 'George Orwell',                     isbn: '978-0-451-52493-5', publication_year: 1949 },
  { title: 'A Clockwork Orange',                              author: 'Anthony Burgess',                   isbn: '978-0-393-31283-8', publication_year: 1962 },
  { title: 'Almost Perfect',                                  author: 'Brian Katcher',                     isbn: '978-0-8027-2010-2', publication_year: 2010 },
  { title: 'The Awakening',                                   author: 'Kate Chopin',                       isbn: '978-0-87745-432-4', publication_year: 1899 },
  { title: 'Burned',                                          author: 'Ellen Hopkins',                     isbn: '978-1-4169-3372-7', publication_year: 2006 },
  { title: "Ender's Game",                                    author: 'Orson Scott Card',                  isbn: '978-0-7653-2836-9', publication_year: 1985 },
  { title: 'Fallen Angels',                                   author: 'Walter Dean Myers',                 isbn: '978-0-590-40942-9', publication_year: 1988 },
  { title: 'Glass',                                           author: 'Ellen Hopkins',                     isbn: '978-1-4169-4090-9', publication_year: 2007 },
  { title: 'Heather Has Two Mommies',                         author: 'Lesléa Newman',                     isbn: '978-0-7636-2155-6', publication_year: 1989 },
  { title: 'I Know Why the Caged Bird Sings',                 author: 'Maya Angelou',                      isbn: '978-0-345-51408-3', publication_year: 1969 },
  { title: 'Madeline and the Gypsies',                        author: 'Ludwig Bemelmans',                  isbn: '978-0-670-44585-7', publication_year: 1959 },
  { title: 'My Princess Boy',                                 author: 'Cheryl Kilodavis',                  isbn: '978-1-4424-1272-5', publication_year: 2010 },
  { title: 'Prince and Knight',                               author: 'Daniel Haack',                      isbn: '978-0-316-55199-1', publication_year: 2018 },
  { title: 'Revolutionary Voices: A Multicultural Queer Youth Anthology', author: 'Amy Sonnie',            isbn: '978-1-55583-522-7', publication_year: 2000 },
  { title: 'Skippyjon Jones',                                 author: 'Judith Byron Schachner',            isbn: '978-0-525-47134-9', publication_year: 2003 },
  { title: 'So Far from the Bamboo Grove',                    author: 'Yoko Kawashima Watkins',            isbn: '978-0-14-032385-6', publication_year: 1986 },
  { title: 'The Color of Earth',                              author: 'Kim Dong Hwa',                      isbn: '978-1-58234-720-8', publication_year: 2009 },
  { title: 'The Librarian of Basra',                          author: 'Jeanette Winter',                   isbn: '978-0-15-205445-7', publication_year: 2005 },
  { title: 'The Walking Dead, Vol. 1: Days Gone Bye',         author: 'Robert Kirkman',                    isbn: '978-1-58240-358-8', publication_year: 2004 },
  { title: 'Tricks',                                          author: 'Ellen Hopkins',                     isbn: '978-1-4169-5007-6', publication_year: 2009 },
  { title: "Uncle Bobby's Wedding",                           author: 'Sarah S. Brannen',                  isbn: '978-0-399-25190-2', publication_year: 2008 },
  { title: 'Year of Wonders',                                 author: 'Geraldine Brooks',                  isbn: '978-0-14-200050-3', publication_year: 2001 },

  // ── MOST-CHALLENGED 2020–2024 (not already on ALA 2010-2019 list) ──────────
  { title: 'Gender Queer: A Memoir',                          author: 'Maia Kobabe',                       isbn: '978-1-62010-636-5', publication_year: 2019 },
  { title: 'All Boys Aren\'t Blue',                           author: 'George M. Johnson',                 isbn: '978-0-374-31228-5', publication_year: 2020 },
  { title: 'Flamer',                                          author: 'Mike Curato',                       isbn: '978-1-62672-398-5', publication_year: 2020 },
  { title: 'Lawn Boy',                                        author: 'Jonathan Evison',                   isbn: '978-1-250-30469-7', publication_year: 2018 },
  { title: 'Out of Darkness',                                 author: 'Ashley Hope Pérez',                 isbn: '978-1-4521-6512-3', publication_year: 2015 },
  { title: 'The Bluest Eye',                                  author: 'Toni Morrison',                     isbn: '978-0-14-028036-3', publication_year: 1970 }, // duplicate guard will catch if already present
];

// ── HELPERS ───────────────────────────────────────────────────────────────────
function normalise(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Import Top 100 Banned Books — ${DRY_RUN ? 'DRY RUN' : 'LIVE INSERT'}`);
  console.log(`${'─'.repeat(60)}\n`);

  // 1. Fetch existing books
  const { data: existing, error: fetchErr } = await sb
    .from('books')
    .select('id, title');

  if (fetchErr) {
    console.error('Failed to fetch existing books:', fetchErr.message);
    process.exit(1);
  }

  const existingTitles = new Set((existing || []).map(b => normalise(b.title)));
  console.log(`Existing books in database: ${existingTitles.size}\n`);

  // 2. Dedupe input list by normalised title (some entries appear in both sections)
  const seen = new Set();
  const dedupedBooks = [];
  for (const book of BOOKS) {
    const key = normalise(book.title);
    if (!seen.has(key)) {
      seen.add(key);
      dedupedBooks.push(book);
    }
  }

  // 3. Split into skip / insert
  const toSkip   = dedupedBooks.filter(b => existingTitles.has(normalise(b.title)));
  const toInsert = dedupedBooks.filter(b => !existingTitles.has(normalise(b.title)));

  console.log(`Books to skip (already in DB): ${toSkip.length}`);
  if (toSkip.length) toSkip.forEach(b => console.log(`  SKIP  ${b.title}`));

  console.log(`\nBooks to insert: ${toInsert.length}`);
  toInsert.forEach(b => console.log(`  ADD   ${b.title}  (${b.author || 'n/a'}, ${b.publication_year || 'n/a'})`));

  if (DRY_RUN) {
    console.log('\n⚠  DRY RUN — nothing written. Re-run with --run to insert.\n');
    return;
  }

  if (toInsert.length === 0) {
    console.log('\n✓ All books already in database. Nothing to do.\n');
    return;
  }

  // 4. Insert in batches of 25
  const BATCH = 25;
  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH).map(b => ({
      title:            b.title,
      author:           b.author   || null,
      isbn:             b.isbn     || null,
      publication_year: b.publication_year || null,
      published:        false,
    }));

    const { error } = await sb.from('books').insert(batch);
    if (error) {
      console.error(`  ✗ Batch ${i / BATCH + 1} failed:`, error.message);
      failed += batch.length;
    } else {
      inserted += batch.length;
      console.log(`  ✓ Inserted batch ${i / BATCH + 1} (${batch.length} books)`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Done — ${inserted} inserted, ${failed} failed, ${toSkip.length} skipped`);
  console.log(`${'─'.repeat(60)}\n`);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
