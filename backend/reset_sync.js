import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function resetSync() {
  console.log('Resetting sync status for bonalavenkat06@gmail.com...');
  const { data, error } = await supabase
    .from('profiles')
    .update({ 
      sync_status: 'completed',
      last_sync_at: new Date().toISOString(),
      sync_error: null
    })
    .eq('email', 'bonalavenkat06@gmail.com')
    .select();

  if (error) {
    console.error('Error resetting sync status:', error);
  } else {
    console.log('Sync status reset successfully:', data);
  }
}

resetSync();
