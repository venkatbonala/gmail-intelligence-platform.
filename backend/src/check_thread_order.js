import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env', override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  console.log('Querying top 15 threads ordered by updated_at DESC...');
  const { data: threads, error } = await supabase
    .from('threads')
    .select('id, subject, category, updated_at, gmail_thread_id')
    .order('updated_at', { ascending: false })
    .limit(15);

  if (error) {
    console.error('Error:', error);
    return;
  }

  threads.forEach((t, i) => {
    console.log(`${i + 1}. [${t.updated_at}] Category: ${t.category} | Subject: ${t.subject} (Gmail Thread ID: ${t.gmail_thread_id})`);
  });
}

check();
