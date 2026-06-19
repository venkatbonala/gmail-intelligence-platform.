import { syncUserEmails } from './src/services/gmail.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function runSync() {
  console.log('Fetching user profile...');
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', 'bonalavenkat06@gmail.com')
    .single();

  if (error || !profile) {
    console.error('Profile not found:', error);
    return;
  }

  console.log('Profile found, resetting last_sync_at to null to force full sync...');
  await supabase
    .from('profiles')
    .update({ last_sync_at: null, sync_status: 'idle' })
    .eq('id', profile.id);
  
  profile.last_sync_at = null; // update local object representation

  console.log('Launching syncUserEmails...');
  try {
    const result = await syncUserEmails(profile, 150); // limit to 150 to test pagination
    console.log('Sync completed! Synced count:', result.count);
  } catch (err) {
    console.error('Sync failed with error:', err);
  }
}

runSync();
