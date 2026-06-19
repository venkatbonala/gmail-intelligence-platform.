import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function runDiagnostics() {
  console.log('Connecting to Supabase:', process.env.NEXT_PUBLIC_SUPABASE_URL);
  
  const { data: profiles, error: pError } = await supabase.from('profiles').select('id, email, sync_status, last_sync_at');
  if (pError) {
    console.error('Error fetching profiles:', pError);
  } else {
    console.log('Profiles Count:', profiles.length);
    console.log('Profiles:', profiles);
  }

  const { count: threadsCount, error: tError } = await supabase.from('threads').select('*', { count: 'exact', head: true });
  if (tError) console.error('Error counting threads:', tError);
  else console.log('Threads Count:', threadsCount);

  const { count: emailsCount, error: eError } = await supabase.from('emails').select('*', { count: 'exact', head: true });
  if (eError) console.error('Error counting emails:', eError);
  else console.log('Emails Count:', emailsCount);
}

runDiagnostics();
