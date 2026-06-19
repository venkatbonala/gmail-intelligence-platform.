import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: '../.env', override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function searchAll() {
  console.log('Searching database for "Fallback Preview"...');
  
  const { data: emails, error: eError } = await supabase
    .from('emails')
    .select('id, subject, body_text, summary')
    .or('body_text.ilike.%Fallback Preview%,summary.ilike.%Fallback Preview%,subject.ilike.%Fallback Preview%');
    
  if (eError) {
    console.error('Error searching emails:', eError);
  } else {
    console.log(`Emails matching: ${emails.length}`);
    emails.forEach(e => {
      console.log(`- Email ID: ${e.id}`);
      console.log(`  Subject: ${e.subject}`);
      console.log(`  Summary: ${JSON.stringify(e.summary)}`);
      console.log(`  Body text snippet: ${e.body_text?.substring(0, 200)}`);
    });
  }

  const { data: threads, error: tError } = await supabase
    .from('threads')
    .select('id, subject, summary')
    .or('summary.ilike.%Fallback Preview%,subject.ilike.%Fallback Preview%');
    
  if (tError) {
    console.error('Error searching threads:', tError);
  } else {
    console.log(`Threads matching: ${threads.length}`);
    threads.forEach(t => {
      console.log(`- Thread ID: ${t.id}`);
      console.log(`  Subject: ${t.subject}`);
      console.log(`  Summary: ${JSON.stringify(t.summary)}`);
    });
  }
}

searchAll();
