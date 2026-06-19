import { summarizeThread } from './src/services/ai.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function regenerateSummaries() {
  console.log('Fetching threads that failed to summarize...');
  const { data: threads, error: tErr } = await supabase
    .from('threads')
    .select('id, gmail_thread_id, subject, summary')
    .or('summary.eq.Failed to generate thread-level summary.,summary.is.null');

  if (tErr) {
    console.error('Error fetching threads:', tErr);
    return;
  }

  console.log(`Found ${threads.length} threads needing summary regeneration.`);

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    console.log(`[${i + 1}/${threads.length}] Regenerating summary for thread: "${thread.subject}" (gmail_thread_id: ${thread.gmail_thread_id})...`);
    
    try {
      // Fetch all emails for this thread
      const { data: emails, error: eErr } = await supabase
        .from('emails')
        .select('from_address, body_text, sent_at')
        .eq('gmail_thread_id', thread.gmail_thread_id)
        .order('sent_at', { ascending: true });

      if (eErr) {
        console.error(`Error fetching emails for thread ${thread.gmail_thread_id}:`, eErr);
        continue;
      }

      if (!emails || emails.length === 0) {
        console.log(`No emails found for thread ${thread.gmail_thread_id}. Skipping.`);
        continue;
      }

      const summary = await summarizeThread(thread.subject, emails);
      console.log(`Generated summary: "${summary.substring(0, 60)}..."`);

      const { error: uErr } = await supabase
        .from('threads')
        .update({ summary })
        .eq('id', thread.id);

      if (uErr) {
        console.error(`Error updating summary in DB:`, uErr);
      } else {
        console.log(`Updated thread summary successfully.`);
      }

      // Wait 8 seconds to respect Gemini API rate limits and leave quota for user drafts
      await delay(8000);

    } catch (err) {
      console.error(`Failed to regenerate summary for thread ${thread.id}:`, err.message);
    }
  }

  console.log('Summary regeneration complete!');
}

regenerateSummaries();
