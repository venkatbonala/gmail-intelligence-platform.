import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { cleanEmailContent } from './services/cleaner.js';
import { getEmbedding } from './services/ai.js';

dotenv.config({ path: '../.env', override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runMigration() {
  console.log('Starting migration check...');
  
  // 1. Verify if columns exist
  const { data: firstEmail, error: fetchErr } = await supabase
    .from('emails')
    .select('*')
    .limit(1)
    .maybeSingle();
    
  if (fetchErr) {
    console.error('Error fetching columns check:', fetchErr.message);
    return;
  }
  
  if (!firstEmail) {
    console.log('No emails in database to migrate. Please run sync first.');
    return;
  }
  
  const hasRawHtml = 'raw_html_content' in firstEmail;
  const hasRawText = 'raw_text_content' in firstEmail;
  const hasCleanText = 'clean_text_content' in firstEmail;
  
  if (!hasRawHtml || !hasRawText || !hasCleanText) {
    console.log('\n==================================================================');
    console.log('CRITICAL: Database columns are missing. Please execute the following');
    console.log('SQL command in your Supabase SQL Editor first:');
    console.log('------------------------------------------------------------------');
    console.log('ALTER TABLE public.emails');
    console.log('ADD COLUMN raw_html_content text,');
    console.log('ADD COLUMN raw_text_content text,');
    console.log('ADD COLUMN clean_text_content text;');
    console.log('==================================================================\n');
    return;
  }
  
  console.log('All required columns exist. Fetching unmigrated emails...');
  
  let fetchMore = true;
  let totalProcessed = 0;
  
  while (fetchMore) {
    // Fetch a batch of up to 1000 unmigrated emails where clean_text_content is null
    const { data: emails, error: emailsErr } = await supabase
      .from('emails')
      .select('id, subject, from_address, sent_at, body_text, body_html, gmail_thread_id, gmail_message_id, user_id')
      .is('clean_text_content', null)
      .limit(1000);
      
    if (emailsErr) {
      console.error('Failed to fetch emails:', emailsErr.message);
      return;
    }
    
    if (!emails || emails.length === 0) {
      console.log('No remaining unmigrated emails found.');
      fetchMore = false;
      break;
    }
    
    console.log(`Found ${emails.length} unmigrated emails to migrate in this batch.`);
    
    // Process emails in batches of 5 to respect NVIDIA NIM and Gemini limits
    const batchSize = 5;
    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, i + batchSize);
      console.log(`Processing sub-batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(emails.length / batchSize)} of currently retrieved emails...`);
      
      await Promise.all(batch.map(async (email) => {
        try {
          // Run cleaning pipeline
          const cleanText = cleanEmailContent(email.body_html, email.body_text);
          
          // Update email record
          await supabase
            .from('emails')
            .update({
              raw_html_content: email.body_html || null,
              raw_text_content: email.body_text || '',
              clean_text_content: cleanText,
              body_text: cleanText // Update legacy body_text to maintain backwards compatibility
            })
            .eq('id', email.id);
            
          // Regenerate and update embedding
          const embeddingText = `
            Subject: ${email.subject}
            From: ${email.from_address}
            Date: ${email.sent_at}
            Content: ${cleanText.substring(0, 500)}
          `.trim();
          
          const embeddingVector = await getEmbedding(embeddingText, false);
          
          // Fetch thread db id
          const { data: thread } = await supabase
            .from('threads')
            .select('id')
            .eq('gmail_thread_id', email.gmail_thread_id)
            .maybeSingle();
            
          if (thread) {
            // Fetch existing embedding
            const { data: existingEmbedding } = await supabase
              .from('email_embeddings')
              .select('id')
              .eq('email_id', email.id)
              .maybeSingle();
  
            const embeddingPayload = {
              email_id: email.id,
              gmail_message_id: email.gmail_message_id || '',
              thread_id: thread.id,
              user_id: email.user_id,
              embedding: embeddingVector,
              content: embeddingText
            };
  
            if (existingEmbedding) {
              embeddingPayload.id = existingEmbedding.id;
            }
  
            await supabase.from('email_embeddings').upsert(embeddingPayload);
          }
        } catch (err) {
          console.error(`Failed to migrate email ${email.id}:`, err.message);
        }
      }));
      
      // Throttle NVIDIA NIM calls
      await delay(300);
    }
    
    totalProcessed += emails.length;
    console.log(`Processed ${totalProcessed} emails in this session.`);
  }
  
  console.log('Migration successfully completed!');
}

runMigration();
