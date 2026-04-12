// Rewrites flagged_categories text in rated_reports to avoid verbatim reproduction
// of potentially copyrighted source phrasing.
// Usage: node scripts/reword-flagged-categories.js [--apply]

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = 'https://cqslqfztgtuuidgdkyyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TBJdijzfEaYzBDBeqAy2CA_edJMKfgz';
const apply = process.argv.includes('--apply');

// ── Term substitution map ─────────────────────────────────────────────────────
// Keys are lowercase. Longer phrases must come before shorter sub-phrases.
const SUBSTITUTIONS = [
  // Specific branded / distinctive phrasings first
  ['aberrant sexual activities',              'explicit sexual content'],
  ['sexually obscene sexual activities',      'explicit sexual content'],
  ['explicit sexual activities/nudity',       'explicit sexual content and nudity'],
  ['sexual activities/nudity (minor)',        'sexual content and nudity involving a minor'],
  ['sexual activities/nudity',               'sexual content and nudity'],
  ['sexual activities',                       'sexual content'],
  ['sexual nudity',                           'sexual nudity'],
  ['non-sexual nudity',                       'non-sexual nudity'],
  ['alternate gender/sexual ideologies',      'gender and sexuality themes'],
  ['alternate sexualities',                   'LGBTQ+ themes'],
  ['controversial cultural, gender, racial and social commentary', 'cultural, gender, racial, and social themes'],
  ['controversial religious and gender commentary', 'religious and gender themes'],
  ['controversial religious commentary',      'religious themes'],
  ['controversial social commentary',         'social commentary themes'],
  ['controversial cultural',                  'cultural themes'],
  ['suicide commentary',                      'suicide themes'],
  ['suicide ideation',                        'suicidal ideation'],
  ['self-harm',                               'self-harm themes'],
  ['derogatory terms',                        'offensive language'],
  ['profanity and derogatory terms',          'strong and offensive language'],
  ['profanity (potentially pervasively vulgar)', 'strong language'],
  ['profanity',                               'strong language'],
  ['dubious consent',                         'non-consensual situations'],
  ['sadomasochism',                           'BDSM content'],
  ['animal body horror/gore',                 'animal body horror'],
  ['human body horror/gore',                  'human body horror'],
  ['body horror/gore',                        'body horror'],
  ['farming animal cruelty',                  'depictions of animal cruelty'],
  ['marital rape (graphic and multiple times)','marital sexual assault (graphic, repeated)'],
  ['marital rape',                            'marital sexual assault'],
  ['alcohol (excessive)',                     'heavy drinking'],
  ['alcohol/abuse (extreme)',                 'extreme problematic drinking'],
  ['alcohol abuse',                           'problematic drinking'],
  ['alcohol',                                 'alcohol use'],
  ['drug use',                                'drug use'],
  ['drugs',                                   'drug use'],
  ['smoking',                                 'tobacco use'],
  ['gore',                                    'graphic gore'],
  ['violence (excessive/graphic)',            'excessive graphic violence'],
  ['violence (excessive)',                    'excessive violence'],
  ['death (excessive-animals and humans)',    'excessive depictions of death (animal and human)'],
  ['toxic relationships (multiple)',          'multiple toxic relationships'],
  ['toxic relationships',                     'toxic relationship dynamics'],
  ['coercive control and emotional abuse (includes asphyxiation)', 'coercive control, emotional abuse, and asphyxiation'],
  ['tampering with evidence',                 'evidence tampering'],
  ['concealment of a dead body',              'concealment of a corpse'],
  ['deception (heavy)',                       'significant deception'],
  ['depression (severe)',                     'severe depression'],
  ['anxiety (severe)',                        'severe anxiety'],
  ['grief (severe)',                          'severe grief'],
  ['child abuse (severe/excessive)',          'severe child abuse'],
];

// ── Sentence-level cleanup ────────────────────────────────────────────────────
// Strip common preamble patterns used by the source site
const PREAMBLE = /^this book (?:has |aberrant |contains |includes )?/i;

function reword(raw) {
  if (!raw || !raw.trim()) return raw;

  let text = raw.trim();

  // 1. Remove trailing period so we control the ending
  text = text.replace(/\.\s*$/, '');

  // 2. Strip preamble (e.g. "This book has X; Y" → "X; Y")
  text = text.replace(PREAMBLE, '');

  // 3. Apply term substitutions (case-insensitive)
  for (const [from, to] of SUBSTITUTIONS) {
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    text = text.replace(re, to);
  }

  // 4. Normalise separators: semicolons → commas, clean up spacing
  text = text.replace(/\s*;\s*/g, ', ');
  text = text.replace(/\s*,\s*/g, ', ');
  text = text.replace(/,\s*and\s+/gi, ', and ');

  // 5. Capitalise first letter
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // 6. Add consistent prefix and closing period
  return 'Includes: ' + text + '.';
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { error: authErr } = await sb.auth.signInWithPassword({
    email:    process.env.TWB_EMAIL,
    password: process.env.TWB_PASSWORD,
  });
  if (authErr) { console.error('Auth failed:', authErr.message); process.exit(1); }

  const { data: records, error: fetchErr } = await sb
    .from('rated_reports')
    .select('id, flagged_categories')
    .not('flagged_categories', 'is', null)
    .neq('flagged_categories', '');
  if (fetchErr) { console.error('Fetch failed:', fetchErr.message); process.exit(1); }

  console.log(`\nFetched ${records.length} records with flagged_categories.\n`);

  // Build list of updates (only where text actually changes)
  const updates = records
    .map(r => ({ id: r.id, old: r.flagged_categories, newVal: reword(r.flagged_categories) }))
    .filter(u => u.old !== u.newVal);

  console.log(`Records that will be updated: ${updates.length}`);

  if (!apply) {
    console.log('\n── Sample rewrites (first 10) ──');
    updates.slice(0, 10).forEach(u => {
      console.log('\nBEFORE:', u.old);
      console.log('AFTER: ', u.newVal);
    });
    console.log('\nDry run — no changes made. Re-run with --apply to save.\n');
    process.exit(0);
  }

  // Apply in batches of 1 (upsert by id)
  const BATCH = 50;
  let done = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const chunk = updates.slice(i, i + BATCH);
    await Promise.all(chunk.map(u =>
      sb.from('rated_reports').update({ flagged_categories: u.newVal }).eq('id', u.id)
    ));
    done += chunk.length;
    process.stdout.write(`\r  Updated ${done}/${updates.length}…`);
  }

  console.log(`\n\n✓ ${updates.length} records reworded.\n`);
})();
