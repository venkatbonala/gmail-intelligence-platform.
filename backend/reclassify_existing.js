import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { classifyEmailHeuristically } from './src/services/gmail.js';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function reclassifyExistingThreads() {
  console.log('Fetching all threads from Supabase...');
  const { data: threads, error: tError } = await supabase
    .from('threads')
    .select('id, gmail_thread_id, subject, category');

  if (tError) {
    console.error('Error fetching threads:', tError);
    return;
  }

  console.log(`Found ${threads.length} threads. Reclassifying each...`);

  let updatedCount = 0;
  for (const thread of threads) {
    // Fetch the latest email for this thread to determine category
    const { data: latestEmail, error: eError } = await supabase
      .from('emails')
      .select('subject, from_address, body_text, raw_html_content, raw_text_content')
      .eq('gmail_thread_id', thread.gmail_thread_id)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (eError) {
      console.error(`Error fetching email for thread ${thread.id}:`, eError);
      continue;
    }

    if (latestEmail) {
      const category = classifyEmailHeuristically(
        latestEmail.subject || thread.subject,
        latestEmail.from_address,
        latestEmail.body_text,
        latestEmail.raw_html_content || latestEmail.raw_text_content
      );

      if (category !== thread.category) {
        console.log(`Updating "${thread.subject || '(No Subject)'}": "${thread.category || 'None'}" -> "${category}"`);
        const { error: updateError } = await supabase
          .from('threads')
          .update({ category })
          .eq('id', thread.id);

        if (updateError) {
          console.error(`Error updating thread ${thread.id}:`, updateError);
        } else {
          updatedCount++;
        }
      }
    } else {
      console.log(`No emails found for thread "${thread.subject}" (${thread.gmail_thread_id}). Skipping.`);
    }
  }

  console.log(`Completed reclassification! Updated ${updatedCount} threads.`);
}

reclassifyExistingThreads();
