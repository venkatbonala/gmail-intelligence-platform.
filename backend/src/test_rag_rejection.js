import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { getEmbedding, askChatAgent } from './services/ai.js';

dotenv.config({ path: '../.env', override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testRagRejection() {
  const query = "Which companies rejected my job application?";
  console.log(`User Query: "${query}"`);

  let retrievedEmails = [];

  // 1. Generate query embedding
  const queryEmbedding = await getEmbedding(query, true);

  // 2. Perform vector search
  const { data: matchedEmbeddings, error: matchError } = await supabase.rpc(
    'match_email_embeddings',
    {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: 8,
      p_user_id: 'd39bd1c2-cb5c-4cde-a325-9090416ffee7'
    }
  );

  if (matchedEmbeddings && matchedEmbeddings.length > 0) {
    const emailIds = matchedEmbeddings.map((match) => match.email_id);
    const { data: emails } = await supabase
      .from('emails')
      .select('*')
      .in('id', emailIds);
    retrievedEmails = emails || [];
  }

  console.log(`Vector search retrieved: ${retrievedEmails.length} emails.`);

  // 3. Perform rejection-specific keyword search
  const isRejectionQuery = /reject|unsuccessful|not\s+selected|not\s+moving\s+forward|will\s+not\s+proceed|position\s+has\s+been\s+filled|pursuing\s+other\s+applicants|selected\s+another\s+candidate|chosen\s+a\s+different\s+candidate|move\s+forward\s+with\s+other\s+candidates/i.test(query);

  if (isRejectionQuery) {
    console.log('Rejection query detected. Performing hybrid keyword search...');
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

    const orConditions = rejectionPhrases.map(
      (phrase) => `body_text.ilike.%${phrase}%,subject.ilike.%${phrase}%`
    ).join(',');

    const { data: keywordMatched } = await supabase
      .from('emails')
      .select('*')
      .eq('user_id', 'd39bd1c2-cb5c-4cde-a325-9090416ffee7')
      .or(orConditions)
      .order('sent_at', { ascending: false })
      .limit(15);

    if (keywordMatched && keywordMatched.length > 0) {
      console.log(`Keyword search found ${keywordMatched.length} emails containing rejection terms.`);
      const existingIds = new Set(retrievedEmails.map((e) => e.gmail_message_id));
      keywordMatched.forEach((e) => {
        if (!existingIds.has(e.gmail_message_id)) {
          retrievedEmails.push(e);
        }
      });
    }
  }

  console.log(`Total retrieved emails for context: ${retrievedEmails.length}`);
  
  // Expand to full threads
  if (retrievedEmails.length > 0) {
    const threadIds = [...new Set(retrievedEmails.map((e) => e.gmail_thread_id))];
    const { data: threadEmails } = await supabase
      .from('emails')
      .select('*')
      .eq('user_id', 'd39bd1c2-cb5c-4cde-a325-9090416ffee7')
      .in('gmail_thread_id', threadIds)
      .order('sent_at', { ascending: true });
    
    if (threadEmails && threadEmails.length > 0) {
      retrievedEmails = threadEmails;
    }
  }
  console.log(`Total retrieved emails after thread expansion: ${retrievedEmails.length}`);

  // Test callGemini
  const chatResult = await askChatAgent(query, [], retrievedEmails);
  console.log('\nAI Response:');
  console.log(chatResult.answer);
  console.log('\nSources cited:');
  console.log(JSON.stringify(chatResult.sources, null, 2));
}

testRagRejection();
