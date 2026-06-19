import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import { categorizeAndSummarizeEmail } from './src/services/ai.js';

dotenv.config({ path: './.env', override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function healFailedSummaries() {
  console.log('Fetching emails with failed summaries from Supabase...');
  const { data: emails, error } = await supabase
    .from('emails')
    .select('id, gmail_message_id, gmail_thread_id, subject, from_address, body_text')
    .eq('summary', 'Failed to generate email details.');

  if (error) {
    console.error('Error fetching emails:', error);
    return;
  }

  console.log(`Found ${emails.length} emails needing summary healing.`);
  if (emails.length === 0) {
    console.log('No failed summaries found. Database is healthy!');
    return;
  }

  let healedCount = 0;
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    console.log(`\n[${i + 1}/${emails.length}] Healing Email ID: ${email.id} (Subject: ${email.subject})`);
    
    try {
      const snippet = email.body_text?.substring(0, 150) || '';
      const aiDetails = await categorizeAndSummarizeEmail(
        email.subject,
        email.from_address,
        email.body_text,
        snippet
      );

      if (aiDetails && aiDetails.summary !== 'Failed to generate email details.') {
        // 1. Update email summary
        const { error: eUpdateError } = await supabase
          .from('emails')
          .update({
            summary: aiDetails.summary
          })
          .eq('id', email.id);

        if (eUpdateError) {
          console.error(`Failed to update email record for ${email.id}:`, eUpdateError);
          continue;
        }

        // 2. Update thread category to match
        const { error: tUpdateError } = await supabase
          .from('threads')
          .update({
            category: aiDetails.category
          })
          .eq('gmail_thread_id', email.gmail_thread_id);

        if (tUpdateError) {
          console.error(`Failed to update thread category for thread ${email.gmail_thread_id}:`, tUpdateError);
        }

        console.log(`Successfully healed. New Category: ${aiDetails.category}`);
        healedCount++;
      } else {
        console.warn('Gemini call succeeded but returned failure sentinel.');
      }
    } catch (err) {
      console.error(`Error healing email ${email.id}:`, err.message);
    }

    // Delay 4.5 seconds to respect Gemini 15 RPM free-tier limits
    if (i < emails.length - 1) {
      console.log('Waiting 4.5s for rate limits...');
      await delay(4500);
    }
  }

  console.log(`\nHealing complete! Successfully healed ${healedCount} of ${emails.length} emails.`);
}

healFailedSummaries();
