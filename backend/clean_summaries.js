import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function cleanSummaries() {
  console.log('Cleaning up thread error summaries in Supabase...');
  const { data, error } = await supabase
    .from('threads')
    .update({ summary: null })
    .eq('summary', 'Failed to generate thread-level summary.')
    .select();

  if (error) {
    console.error('Error cleaning summaries:', error);
  } else {
    console.log(`Successfully reset summaries for ${data.length} threads.`);
  }
}

cleanSummaries();
