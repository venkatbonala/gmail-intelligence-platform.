import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { classifyEmailWithAI } from './src/services/ai.js';
import { classifyEmailHeuristically } from './src/services/gmail.js';

dotenv.config({ path: '../.env', override: true });

/**
 * AI-based reclassification of stored threads.
 *
 * Re-runs threads through the Gemini classifier (primary) with the local heuristic as a fallback
 * when the API fails or the daily quota is exhausted. Rate-limited to respect the free-tier RPM.
 *
 * Usage:
 *   node reclassify_ai.js                 # reclassify all threads currently labelled "Personal"
 *   node reclassify_ai.js "Job / Recruitment"
 *   node reclassify_ai.js ALL             # reclassify every thread (slow / quota-heavy)
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TARGET = process.argv[2] || 'Personal';
const DELAY_MS = 4500; // ~13 req/min, under the 15 RPM free-tier limit
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalise legacy / inconsistent labels to the canonical set.
function normalizeLegacy(category) {
  if (category === 'Newsletter') return 'Newsletters';
  return category;
}

async function fetchTargetThreads() {
  const out = [];
  const pageSize = 1000;
  let from = 0;
  // Supabase caps rows at 1000 per request — paginate explicitly.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = supabase
      .from('threads')
      .select('id, gmail_thread_id, subject, category')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (TARGET !== 'ALL') query = query.eq('category', TARGET);

    const { data, error } = await query;
    if (error) throw error;
    out.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function reclassify() {
  console.log(`Fetching threads (target: ${TARGET})...`);
  const threads = await fetchTargetThreads();
  console.log(`Found ${threads.length} threads to reclassify.\n`);

  let updated = 0;
  let aiUsed = 0;
  let heuristicUsed = 0;
  let quotaExhausted = false;

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];

    const { data: latestEmail, error: eError } = await supabase
      .from('emails')
      .select('subject, from_address, body_text, raw_html_content, raw_text_content')
      .eq('gmail_thread_id', thread.gmail_thread_id)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (eError) {
      console.error(`[${i + 1}/${threads.length}] Error fetching email for "${thread.subject}":`, eError.message);
      continue;
    }
    if (!latestEmail) {
      console.log(`[${i + 1}/${threads.length}] No email for "${thread.subject}" — skipping.`);
      continue;
    }

    let category;
    let via;

    if (!quotaExhausted) {
      try {
        category = await classifyEmailWithAI(
          latestEmail.subject || thread.subject,
          latestEmail.from_address,
          latestEmail.body_text || latestEmail.raw_text_content || ''
        );
        via = 'AI';
        aiUsed++;
        await delay(DELAY_MS); // rate limit only when we actually hit the API
      } catch (err) {
        const isDailyQuota =
          err.message?.includes('GenerateRequestsPerDay') ||
          err.message?.includes('requests_per_day');
        if (isDailyQuota) {
          console.warn('\n⚠️  Gemini daily quota exhausted — switching to heuristic for the rest.\n');
          quotaExhausted = true;
        } else {
          console.warn(`[${i + 1}/${threads.length}] AI failed (${err.message?.slice(0, 80)}). Using heuristic.`);
        }
        category = null;
      }
    }

    if (!category) {
      category = classifyEmailHeuristically(
        latestEmail.subject || thread.subject,
        latestEmail.from_address,
        latestEmail.body_text,
        latestEmail.raw_html_content || latestEmail.raw_text_content
      );
      via = 'heuristic';
      heuristicUsed++;
    }

    const current = normalizeLegacy(thread.category);
    if (category !== current) {
      const { error: updErr } = await supabase
        .from('threads')
        .update({ category })
        .eq('id', thread.id);
      if (updErr) {
        console.error(`[${i + 1}/${threads.length}] Update failed:`, updErr.message);
      } else {
        updated++;
        console.log(`[${i + 1}/${threads.length}] (${via}) "${(thread.subject || '(no subject)').slice(0, 55)}"  ${thread.category} -> ${category}`);
      }
    } else {
      console.log(`[${i + 1}/${threads.length}] (${via}) "${(thread.subject || '(no subject)').slice(0, 55)}"  kept ${category}`);
    }
  }

  console.log(`\nDone. Reclassified ${updated}/${threads.length} threads (AI: ${aiUsed}, heuristic: ${heuristicUsed}).`);
}

reclassify().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
