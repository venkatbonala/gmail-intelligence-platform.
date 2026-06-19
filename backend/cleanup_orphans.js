import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function cleanupOrphanedThreads() {
  console.log('Fetching all threads...');
  const { data: threads, error: tErr } = await supabase
    .from('threads')
    .select('id, gmail_thread_id, subject');
  
  if (tErr) {
    console.error('Error fetching threads:', tErr);
    return;
  }

  console.log('Fetching all emails...');
  const { data: emails, error: eErr } = await supabase
    .from('emails')
    .select('gmail_thread_id');

  if (eErr) {
    console.error('Error fetching emails:', eErr);
    return;
  }

  const emailThreadIds = new Set(emails.map(e => e.gmail_thread_id));
  const orphaned = threads.filter(t => !emailThreadIds.has(t.gmail_thread_id));

  console.log(`Total Threads: ${threads.length}`);
  console.log(`Orphaned Threads to delete: ${orphaned.length}`);

  if (orphaned.length === 0) {
    console.log('No orphaned threads found.');
    return;
  }

  const orphanedIds = orphaned.map(t => t.id);
  
  // Delete in batches of 100
  const batchSize = 100;
  for (let i = 0; i < orphanedIds.length; i += batchSize) {
    const batch = orphanedIds.slice(i, i + batchSize);
    const { error: dErr } = await supabase
      .from('threads')
      .delete()
      .in('id', batch);
      
    if (dErr) {
      console.error(`Error deleting batch starting at ${i}:`, dErr);
    } else {
      console.log(`Successfully deleted ${batch.length} orphaned threads.`);
    }
  }
}

cleanupOrphanedThreads();
