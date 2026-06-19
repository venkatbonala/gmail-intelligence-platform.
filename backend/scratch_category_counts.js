import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkCategories() {
  const { data: threads, error } = await supabase
    .from('threads')
    .select('id, subject, category, gmail_thread_id');

  if (error) {
    console.error('Error fetching threads:', error);
    return;
  }

  const counts = {};
  threads.forEach(t => {
    const cat = t.category || 'null';
    counts[cat] = (counts[cat] || 0) + 1;
  });

  console.log('Category Counts:', counts);
  console.log('Sample of Notifications threads:');
  const notificationSamples = threads.filter(t => t.category === 'Notifications').slice(0, 15);
  for (const t of notificationSamples) {
    console.log(`- Subject: "${t.subject}"`);
  }
}

checkCategories();
