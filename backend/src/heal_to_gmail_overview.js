import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { categorizeAndSummarizeEmail, summarizeThread } from './services/ai.js';

dotenv.config({ path: '../.env', override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function healToGmailOverview() {
  console.log('Fetching the TechNova email...');
  const { data: email, error } = await supabase
    .from('emails')
    .select('id, subject, from_address, body_text, gmail_thread_id, user_id')
    .eq('subject', 'Update on Your Software Engineer Application')
    .single();

  if (error || !email) {
    console.error('Failed to retrieve TechNova email:', error?.message || 'Not found');
    return;
  }

  console.log('1. Re-generating single email summary using new prompt...');
  const aiDetails = await categorizeAndSummarizeEmail(
    email.subject,
    email.from_address,
    email.body_text,
    email.body_text.substring(0, 150)
  );

  console.log('New Email Summary:');
  console.log(aiDetails.summary);

  console.log('Saving healed email summary...');
  await supabase
    .from('emails')
    .update({ summary: aiDetails.summary })
    .eq('id', email.id);

  console.log('2. Re-generating thread-level summary using new prompt...');
  // Fetch messages in thread
  const { data: threadEmails } = await supabase
    .from('emails')
    .select('*')
    .eq('gmail_thread_id', email.gmail_thread_id)
    .order('sent_at', { ascending: true });

  const threadSummary = await summarizeThread(email.subject, threadEmails);

  console.log('New Thread Summary:');
  console.log(threadSummary);

  console.log('Saving healed thread summary...');
  await supabase
    .from('threads')
    .update({ summary: threadSummary })
    .eq('gmail_thread_id', email.gmail_thread_id);

  console.log('Heal complete! View the thread in your app to see the difference.');
}

healToGmailOverview();
