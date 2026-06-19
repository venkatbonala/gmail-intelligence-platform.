import { draftNewEmail, draftReplyEmail } from './src/services/ai.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testDrafting() {
  console.log('Testing draftNewEmail...');
  try {
    const draft = await draftNewEmail('Politely decline their job offer and ask them for a coffee next week');
    console.log('New Email Draft Result:', draft);
  } catch (err) {
    console.error('Error drafting new email:', err.message);
  }

  console.log('Testing draftReplyEmail...');
  try {
    // Fetch a thread with emails to use as context
    const { data: emails, error: eErr } = await supabase
      .from('emails')
      .select('*')
      .limit(3);

    if (eErr || !emails || emails.length === 0) {
      console.error('No emails found in DB to test reply drafting. Skipping reply test.');
      return;
    }

    const replyBody = await draftReplyEmail(emails, 'Say thank you and tell them I will get back to them tomorrow');
    console.log('Threaded Reply Draft Result:', replyBody);
  } catch (err) {
    console.error('Error drafting reply email:', err.message);
  }
}

testDrafting();
