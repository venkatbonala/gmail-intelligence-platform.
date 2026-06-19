import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env', override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testRejectionQuery() {
  const rejectionPhrases = [
    'move forward with other candidates',
    'selected another candidate',
    'not moving forward',
    'will not proceed',
    'position has been filled',
    'pursuing other applicants',
    'application was not successful',
    'not selected',
    'chosen a different candidate',
    'reject'
  ];

  console.log('Testing rejection queries...');

  // Query database using Supabase OR filter
  const orConditions = rejectionPhrases.map(
    (phrase) => `body_text.ilike.%${phrase}%,subject.ilike.%${phrase}%`
  ).join(',');

  const { data: emails, error } = await supabase
    .from('emails')
    .select('id, subject, from_address, sent_at, body_text')
    .or(orConditions);

  if (error) {
    console.error('Error fetching rejection emails:', error);
  } else {
    console.log(`Found ${emails.length} rejection emails:`);
    emails.forEach((email) => {
      console.log(`- Subject: ${email.subject}`);
      console.log(`  From: ${email.from_address}`);
      console.log(`  Date: ${email.sent_at}`);
      console.log(`  Snippet: ${email.body_text.substring(0, 150)}...`);
      console.log('---');
    });
  }
}

testRejectionQuery();
