import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { 
  getAuthUrl, 
  getTokensFromCode, 
  syncUserEmails, 
  sendEmail,
  syncAndGetFullThread
} from '../services/gmail.js';
import { 
  getEmbedding, 
  draftNewEmail, 
  draftReplyEmail, 
  askChatAgent, 
  deduplicateNewsletters,
  categorizeAndSummarizeEmail,
  summarizeThread
} from '../services/ai.js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env', override: true });

const router = express.Router();

// Initialize Supabase Client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Middleware: Verify user session cookie.
 */
async function requireAuth(req, res, next) {
  const userId = req.cookies?.user_session;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized. No active session.' });
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error || !profile) {
    return res.status(401).json({ error: 'Unauthorized. User session not found.' });
  }

  req.user = profile;
  next();
}

/**
 * Endpoint: Get OAuth Redirect URL
 */
router.get('/auth/google', (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint: Google OAuth Callback
 */
router.get('/auth/callback/google', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('OAuth callback code missing.');
  }

  try {
    const { tokens, email } = await getTokensFromCode(code);
    
    // Save or update user profile in Supabase
    const tokenExpiry = new Date(tokens.expiry_date).toISOString();
    
    const { data: profile, error } = await supabase
      .from('profiles')
      .upsert(
        {
          email,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || '', // refresh_token is only sent on first consent
          token_expiry: tokenExpiry,
          last_sync_at: null, // Reset sync timestamp on reconnect to trigger initial sync
          sync_status: 'idle'
        },
        { onConflict: 'email' }
      )
      .select()
      .single();

    if (error) {
      throw error;
    }

    // Set user session cookie (max age 30 days).
    // In production (HTTPS) the cookie is marked Secure; SameSite=Lax allows it to be set on the
    // top-level OAuth callback redirect while still being sent on same-origin API requests.
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('user_session', profile.id, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/'
    });

    // Redirect user back to the React app dashboard
    res.redirect(`${process.env.APP_URL || 'http://localhost:3000'}/`);
  } catch (error) {
    console.error('OAuth Callback Error:', error);
    res.status(500).send(`OAuth Callback failed: ${error.message}`);
  }
});

/**
 * Endpoint: Get Auth Status
 */
router.get('/auth/status', async (req, res) => {
  const userId = req.cookies?.user_session;
  if (!userId) {
    return res.json({ authenticated: false });
  }

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, sync_status, last_sync_at, sync_error')
      .eq('id', userId)
      .single();

    if (!profile) {
      return res.json({ authenticated: false });
    }

    res.json({ authenticated: true, user: profile });
  } catch (error) {
    res.json({ authenticated: false });
  }
});

/**
 * Endpoint: Logout
 */
router.get('/auth/logout', (req, res) => {
  res.clearCookie('user_session');
  res.json({ success: true });
});

/**
 * Endpoint: Trigger Inbox Sync
 */
router.post('/sync', requireAuth, async (req, res) => {
  try {
    // Check if there's already an active sync running
    const { data: latestProfile } = await supabase
      .from('profiles')
      .select('sync_status')
      .eq('id', req.user.id)
      .single();

    if (latestProfile && latestProfile.sync_status && latestProfile.sync_status.startsWith('syncing')) {
      return res.status(400).json({ error: 'Sync already in progress.' });
    }

    // Sync a bounded window of the most recent emails and fully AI-summarize + categorize EVERY one
    // of them (no per-sync AI cap). Bounding keeps the entire synced inbox at full AI quality while
    // staying within free-tier Gemini quotas. Raise SYNC_LIMIT if you have higher quota.
    const SYNC_LIMIT = 150;

    syncUserEmails(req.user, SYNC_LIMIT)
      .then((r) => console.log('Sync completed.', r))
      .catch((err) => console.error('Background sync failed:', err));

    res.json({ success: true, message: 'Sync started in background.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint: List Threads (filtered by category)
 */
router.get('/threads', requireAuth, async (req, res) => {
  const { category } = req.query;
  const limitNum = parseInt(req.query.limit, 10) || 100;
  const pageNum = parseInt(req.query.page, 10) || 1;
  const offset = (pageNum - 1) * limitNum;

  try {
    let queryBuilder = supabase
      .from('threads')
      .select('*', { count: 'exact' })
      .eq('user_id', req.user.id);

    if (category && category !== 'All') {
      queryBuilder = queryBuilder.eq('category', category);
    }

    // Order by most recently updated threads
    const { data: threads, count, error } = await queryBuilder
      .order('updated_at', { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (error) throw error;

    res.json({ threads, total: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint: Get Single Thread details and messages
 */
router.get('/threads/:gmailThreadId', requireAuth, async (req, res) => {
  const { gmailThreadId } = req.params;

  try {
    let messages = [];
    let threadDbId;
    
    try {
      // 1. Sync the full thread history from the Gmail API
      const syncResult = await syncAndGetFullThread(req.user, gmailThreadId);
      messages = syncResult.messages;
      threadDbId = syncResult.threadDbId;
    } catch (syncErr) {
      console.warn(`Failed to sync thread ${gmailThreadId} from Gmail API, falling back to local database:`, syncErr.message);
      // Fallback: get individual messages from local database
      const { data: dbMessages } = await supabase
        .from('emails')
        .select('*')
        .eq('user_id', req.user.id)
        .eq('gmail_thread_id', gmailThreadId)
        .order('sent_at', { ascending: true });
      messages = dbMessages || [];
    }

    // 2. Fetch the thread record details from the database
    let threadQuery = supabase
      .from('threads')
      .select('*')
      .eq('user_id', req.user.id);
      
    if (threadDbId) {
      threadQuery = threadQuery.eq('id', threadDbId);
    } else {
      threadQuery = threadQuery.eq('gmail_thread_id', gmailThreadId);
    }
    
    const { data: thread, error: threadError } = await threadQuery.single();

    if (threadError) {
      return res.status(404).json({ error: 'Thread not found.' });
    }

    // 3. Heal individual email summaries on-the-fly if needed.
    // A healthy record now has a natural-language prose summary AND a bullet AI Overview.
    // Legacy rows store old bullet-style text in `summary` (starts with •) and have no ai_overview.
    for (let msg of messages) {
      const needsEmailHealing = !msg.summary ||
                                msg.summary === 'Failed to generate email details.' ||
                                msg.summary.includes('[Heuristic Preview]') ||
                                !msg.ai_overview ||
                                msg.summary.trim().startsWith('•');

      if (needsEmailHealing) {
        console.log(`Email summary missing, failed, or legacy-style for message ${msg.gmail_message_id}. Generating on-the-fly...`);
        try {
          const aiDetails = await categorizeAndSummarizeEmail(
            msg.subject,
            msg.from_address,
            msg.body_text,
            msg.body_text.substring(0, 150)
          );
          if (aiDetails && aiDetails.summary !== 'Failed to generate email details.') {
            msg.summary = aiDetails.summary;
            msg.ai_overview = aiDetails.overview;
            await supabase
              .from('emails')
              .update({ summary: aiDetails.summary, ai_overview: aiDetails.overview })
              .eq('id', msg.id);
          }
        } catch (err) {
          console.error(`Failed to generate on-the-fly email summary:`, err.message);
        }
      }
    }

    // 4. Generate/Heal thread-level summary using the complete history if it's missing, failed, or legacy-style
    const needsThreadHealing = !thread.summary ||
                               thread.summary === 'Failed to generate thread-level summary.' ||
                               thread.summary.includes('[Heuristic Preview]') ||
                               !thread.ai_overview ||
                               thread.summary.trim().startsWith('•');

    if (needsThreadHealing) {
      console.log(`Thread summary missing, failed, or legacy-style. Generating from complete chronological history...`);
      try {
        const threadResult = await summarizeThread(thread.subject, messages);
        if (threadResult && threadResult.summary !== 'Failed to generate thread-level summary.') {
          thread.summary = threadResult.summary;
          thread.ai_overview = threadResult.overview;
          await supabase
            .from('threads')
            .update({ summary: threadResult.summary, ai_overview: threadResult.overview })
            .eq('id', thread.id);
        }
      } catch (err) {
        console.error('Failed to generate thread summary:', err.message);
      }
    }

    res.json({ thread, messages });
  } catch (error) {
    console.error('Get thread error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint: AI Email Drafting (Compose New & Reply)
 */
router.post('/messages/draft', requireAuth, async (req, res) => {
  const { prompt, gmailThreadId } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }

  try {
    if (gmailThreadId) {
      // Reply to thread - load full thread from Gmail to ensure complete chronological context
      let messages = [];
      try {
        const syncResult = await syncAndGetFullThread(req.user, gmailThreadId);
        messages = syncResult.messages;
      } catch (syncErr) {
        console.warn(`Failed to sync thread ${gmailThreadId} during reply drafting:`, syncErr.message);
        // Fallback to local database messages
        const { data: dbMessages } = await supabase
          .from('emails')
          .select('*')
          .eq('user_id', req.user.id)
          .eq('gmail_thread_id', gmailThreadId)
          .order('sent_at', { ascending: true });
        messages = dbMessages || [];
      }

      if (messages.length === 0) {
        return res.status(404).json({ error: 'Thread not found.' });
      }

      const body = await draftReplyEmail(messages, prompt);
      res.json({
        type: 'reply',
        subject: messages[0].subject,
        body,
        replyToMessageId: messages[messages.length - 1].gmail_message_id
      });
    } else {
      // Compose brand new email
      const draft = await draftNewEmail(prompt);
      res.json({
        type: 'new',
        subject: draft.subject,
        body: draft.body
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint: Send Email (handles threads and replies properly)
 */
router.post('/messages/send', requireAuth, async (req, res) => {
  const { to, subject, body, gmailThreadId, replyToMessageId } = req.body;
  
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Recipient (to), subject, and body are required.' });
  }

  try {
    const result = await sendEmail({
      userProfile: req.user,
      to,
      subject,
      body,
      threadId: gmailThreadId,
      replyToMessageId
    });

    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint: AI Chat Agent (RAG with source citations)
 */
router.post('/chat', requireAuth, async (req, res) => {
  const { query, history = [] } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query is required.' });
  }

  try {
    // ---------------------------------------------------------------------------------------
    // Context-aware "evidence / sources" follow-up handling.
    //
    // When the user asks which emails were used as evidence for the PREVIOUS answer, we must
    // NOT run a fresh semantic retrieval (that would surface unrelated emails as fake evidence).
    // Instead we report the citations actually stored with the immediately preceding assistant
    // answer. If that answer used no emails (e.g. it said "I cannot find..."), we say so plainly.
    // ---------------------------------------------------------------------------------------
    const q = query.toLowerCase();
    const mentionsEvidence = /\b(evidence|sources?|citations?|references?)\b/.test(q);
    const mentionsEmailsUsed =
      /\b(which|what)\b[^?]*\bemails?\b[^?]*\b(you|your)\b[^?]*\b(use|used|using|cite|cited|base|based|referenc)/.test(q) ||
      /\b(you|your)\b[^?]*\b(use|used|using|cite|cited|base|based|referenc)[^?]*\bemails?\b/.test(q);
    const refersToPrevious = /\b(previous|last|prior|that|above|earlier|answer|response|you|your|used|using)\b/.test(q);
    const isEvidenceFollowUp = (mentionsEvidence && refersToPrevious) || mentionsEmailsUsed;

    if (isEvidenceFollowUp) {
      console.log('Detected evidence/source follow-up. Reporting citations from the previous answer...');

      // Fetch the most recent assistant answer for this user (the "previous answer").
      const { data: lastAssistant } = await supabase
        .from('chat_messages')
        .select('content, sources, created_at')
        .eq('user_id', req.user.id)
        .eq('role', 'assistant')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const prettyDate = (d) =>
        d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown date';

      // Format a citation as a clean Subject / Sender / Date block.
      const formatCitation = (s) => `Subject: ${s.subject}\nSender: ${s.sender}\nDate: ${prettyDate(s.sent_at)}`;

      // Extract a specific entity/claim filter from the query, e.g. "...evidence for Coppergate?"
      // Everything that isn't a meta/stop word is treated as the entity the user is asking about.
      const STOP = new Set([
        'what', 'whats', 'which', 'who', 'whom', 'where', 'when', 'did', 'do', 'does', 'done',
        'you', 'your', 'yours', 'use', 'used', 'using', 'cite', 'cited', 'base', 'based', 'reference',
        'referenced', 'as', 'evidence', 'source', 'sources', 'citation', 'citations', 'reference', 'references',
        'for', 'the', 'a', 'an', 'previous', 'last', 'prior', 'answer', 'response', 'that', 'this', 'about',
        'regarding', 'me', 'my', 'mine', 'of', 'on', 'in', 'support', 'supporting', 'supported', 'claim',
        'claims', 'give', 'show', 'tell', 'is', 'was', 'were', 'to', 'with', 'from', 'and', 'any', 'please',
        'specific', 'specifically', 'email', 'emails', 'mail', 'mails', 'message', 'messages',
        // generic job/contact context words that are too broad to filter by on their own
        'role', 'roles', 'position', 'positions', 'job', 'jobs', 'recruiter', 'recruiters',
        'recruitment', 'company', 'companies', 'contact', 'contacted', 'sender', 'senders', 'people'
      ]);
      const entityTokens = q
        .replace(/[^a-z0-9\s&]/gi, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP.has(w));
      const entityPhrase = entityTokens.join(' ').trim();

      let answer;
      let sources = [];

      if (!lastAssistant) {
        answer = "There's no previous answer yet, so there are no evidence emails to show.";
      } else if (!lastAssistant.sources || lastAssistant.sources.length === 0) {
        answer = 'No evidence emails were used for the previous answer. That response was based on the absence of any matching email in your synced inbox, not on a specific message.';
      } else {
        const allSources = lastAssistant.sources;

        if (entityPhrase) {
          // Entity/claim-aware: narrow the previous answer's citations to those that actually
          // support THIS entity. Match tightest-first against subject + sender, then email bodies.
          const haystack = (s) => `${s.subject || ''} ${s.sender || ''}`.toLowerCase();

          let matched = allSources.filter((s) => haystack(s).includes(entityPhrase));
          if (matched.length === 0) {
            matched = allSources.filter((s) => entityTokens.every((t) => haystack(s).includes(t)));
          }

          // Fall back to the email bodies (the entity may only appear in the message text,
          // e.g. a recruiter name not present in the subject/sender headers).
          if (matched.length === 0) {
            const ids = allSources.map((s) => s.id);
            const { data: bodyEmails } = await supabase
              .from('emails')
              .select('gmail_message_id, subject, from_address, clean_text_content, body_text')
              .eq('user_id', req.user.id)
              .in('gmail_message_id', ids);

            if (bodyEmails && bodyEmails.length > 0) {
              const matchedIds = new Set(
                bodyEmails
                  .filter((e) => {
                    const h = `${e.subject || ''} ${e.from_address || ''} ${e.clean_text_content || e.body_text || ''}`.toLowerCase();
                    return entityTokens.every((t) => h.includes(t));
                  })
                  .map((e) => e.gmail_message_id)
              );
              matched = allSources.filter((s) => matchedIds.has(s.id));
            }
          }

          if (matched.length === 0) {
            answer = `I don't see an email specifically about "${entityPhrase}" among the sources used for the previous answer.`;
          } else {
            sources = matched;
            answer = `The previous answer used the following email${matched.length > 1 ? 's' : ''} as evidence for "${entityPhrase}":\n\n` +
                     matched.map(formatCitation).join('\n\n');
          }
        } else {
          // No specific entity — the user asked for ALL evidence behind the previous answer.
          sources = allSources;
          answer = `The previous answer was based on the following email${allSources.length > 1 ? 's' : ''}:\n\n` +
                   allSources.map((s, i) => `${i + 1}. "${s.subject}" from ${s.sender} (${prettyDate(s.sent_at)})`).join('\n');
        }
      }

      // Persist this meta exchange so the conversation history stays consistent.
      await supabase.from('chat_messages').insert([
        { user_id: req.user.id, role: 'user', content: query },
        { user_id: req.user.id, role: 'assistant', content: answer, sources }
      ]);

      return res.json({ answer, sources });
    }

    // ---------------------------------------------------------------------------------------
    // Category queries ("show me all Finance emails", "list my newsletters", "how many job emails").
    //
    // Answered by a structured query over threads.category across the ENTIRE dataset, NOT by the
    // capped semantic retrieval. The semantic path made "Show me all Finance emails" return
    // "I cannot find..." even though 127 Finance emails exist, because the category name never
    // appeared in any email body and the category regex didn't recognise the word "finance".
    // ---------------------------------------------------------------------------------------
    const CAT_WORD_TO_CATEGORY = {
      finance: 'Finance', financial: 'Finance',
      job: 'Job / Recruitment', jobs: 'Job / Recruitment', recruitment: 'Job / Recruitment',
      recruiter: 'Job / Recruitment', recruiters: 'Job / Recruitment', hiring: 'Job / Recruitment',
      notification: 'Notifications', notifications: 'Notifications',
      newsletter: 'Newsletters', newsletters: 'Newsletters',
      personal: 'Personal',
      work: 'Work / Professional', professional: 'Work / Professional'
    };
    // Require the category word to sit directly next to "emails/mails/messages" so we don't hijack
    // specific queries like "the job offer from Google" (that's "job offer", not "job emails").
    const catPhrase = q.match(
      /\b(finance|financial|jobs?|recruitment|recruiters?|hiring|notifications?|newsletters?|personal|work|professional)\s+(?:related\s+)?(?:emails?|mails?|messages?)\b/
    );
    const catCountIntent = /\b(how many|number of|count|total)\b/.test(q);
    const catSummaryIntent =
      /\b(summari[sz]e|summary|overview|recap|gist|tl;?dr|digest|brief|rundown)\b/.test(q) ||
      /what\s+are[^?]*\babout\b/.test(q) ||
      /\b(tell|give)\b[^?]*\babout\b/.test(q);
    const catListIntent = /\b(show|list|display|view|see)\b/.test(q) || /\ball\b/.test(q) || /what\s+are/.test(q);

    if (catPhrase && (catCountIntent || catSummaryIntent || catListIntent)) {
      const category = CAT_WORD_TO_CATEGORY[catPhrase[1]];
      // Precedence: count -> summary -> list (summary beats list so "summarize all my X emails" summarizes).
      const intent = catCountIntent ? 'count' : (catSummaryIntent ? 'summary' : 'list');
      console.log(`Detected category query. Category: ${category}, intent: ${intent}`);

      // Optional date window.
      let dateLimit = null;
      const DAY = 24 * 60 * 60 * 1000;
      const dDays = q.match(/last\s+(\d+)\s+days/);
      const dWeeks = q.match(/last\s+(\d+)\s+weeks/);
      const dMonths = q.match(/last\s+(\d+)\s+months/);
      if (dDays) dateLimit = new Date(Date.now() - parseInt(dDays[1], 10) * DAY).toISOString();
      else if (dWeeks) dateLimit = new Date(Date.now() - parseInt(dWeeks[1], 10) * 7 * DAY).toISOString();
      else if (dMonths) dateLimit = new Date(Date.now() - parseInt(dMonths[1], 10) * 30 * DAY).toISOString();
      else if (/last month|past month|30 days/.test(q)) dateLimit = new Date(Date.now() - 30 * DAY).toISOString();
      else if (/last week|past week|7 days/.test(q)) dateLimit = new Date(Date.now() - 7 * DAY).toISOString();

      const prettyDate = (d) =>
        d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown date';

      // All thread ids in this category for the user.
      const { data: catThreads } = await supabase
        .from('threads').select('gmail_thread_id')
        .eq('user_id', req.user.id).eq('category', category);
      const tids = (catThreads || []).map((t) => t.gmail_thread_id);

      // ---- Category SUMMARY branch ------------------------------------------------------------
      // "Summarize my Newsletter emails", "Give me an overview of my Finance emails", etc.
      // Pull a recent sample of the category's emails (WITH bodies) and let the chat agent write a
      // grounded, cited summary — instead of letting capped semantic retrieval fail with "cannot find".
      if (intent === 'summary') {
        if (tids.length === 0) {
          const answer = `You don't have any ${category} emails to summarize.`;
          await supabase.from('chat_messages').insert([
            { user_id: req.user.id, role: 'user', content: query },
            { user_id: req.user.id, role: 'assistant', content: answer, sources: [] }
          ]);
          return res.json({ answer, sources: [] });
        }

        // Gather a recent sample of category emails with bodies (chunk the IN() for large categories).
        let sample = [];
        for (let i = 0; i < tids.length; i += 150) {
          const chunk = tids.slice(i, i + 150);
          let sq = supabase.from('emails')
            .select('gmail_message_id, gmail_thread_id, subject, from_address, to_address, sent_at, clean_text_content, body_text')
            .eq('user_id', req.user.id).in('gmail_thread_id', chunk);
          if (dateLimit) sq = sq.gte('sent_at', dateLimit);
          const { data } = await sq.order('sent_at', { ascending: false }).limit(40);
          if (data) sample.push(...data);
        }
        sample.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
        sample = sample.slice(0, 35); // reasonable subset for a category-level summary

        if (sample.length === 0) {
          const answer = `You don't have any ${category} emails${dateLimit ? ' in the selected time period' : ''} to summarize.`;
          await supabase.from('chat_messages').insert([
            { user_id: req.user.id, role: 'user', content: query },
            { user_id: req.user.id, role: 'assistant', content: answer, sources: [] }
          ]);
          return res.json({ answer, sources: [] });
        }

        // Shape into the context format askChatAgent expects, tagging the known category.
        const contexts = sample.map((e) => ({
          gmail_message_id: e.gmail_message_id,
          gmail_thread_id: e.gmail_thread_id,
          from_address: e.from_address,
          to_address: e.to_address,
          sent_at: e.sent_at,
          subject: e.subject,
          category,
          body_text: e.clean_text_content || e.body_text || ''
        }));

        const summaryQuery =
          `Provide a clear, plain-English overview of my ${category} emails based on the ${sample.length} most recent ones provided. ` +
          `Group related items by sender or theme, highlight the key takeaways, and call out anything that needs action. Original request: "${query}"`;

        const chatResult = await askChatAgent(summaryQuery, history, contexts);

        await supabase.from('chat_messages').insert([
          { user_id: req.user.id, role: 'user', content: query },
          { user_id: req.user.id, role: 'assistant', content: chatResult.answer, sources: chatResult.sources }
        ]);
        return res.json({ answer: chatResult.answer, sources: chatResult.sources });
      }

      // Count the emails in those threads and collect the most recent ones. Chunk the IN() list so
      // large categories (e.g. hundreds of newsletter threads) don't blow the request URL length.
      let total = 0;
      let recent = [];
      for (let i = 0; i < tids.length; i += 150) {
        const chunk = tids.slice(i, i + 150);
        let cq = supabase.from('emails')
          .select('gmail_message_id, gmail_thread_id, subject, from_address, sent_at', { count: 'exact' })
          .eq('user_id', req.user.id).in('gmail_thread_id', chunk);
        if (dateLimit) cq = cq.gte('sent_at', dateLimit);
        const { data, count } = await cq.order('sent_at', { ascending: false }).limit(20);
        total += count || 0;
        if (data) recent.push(...data);
      }
      recent.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at));
      recent = recent.slice(0, 15);

      const sources = recent.map((e) => ({
        id: e.gmail_message_id,
        subject: e.subject,
        sender: e.from_address,
        sent_at: e.sent_at,
        thread_id: e.gmail_thread_id
      }));

      const windowText = dateLimit ? ' in the selected time period' : '';
      const line = (s) => `• "${s.subject}" — ${s.sender} (${prettyDate(s.sent_at)})`;
      let answer;
      if (total === 0) {
        answer = `You don't have any ${category} emails${windowText}.`;
      } else if (catCountIntent) {
        answer = `You have ${total} ${category} email${total === 1 ? '' : 's'}${windowText}.`;
        if (sources.length > 0) {
          answer += ` The most recent ${sources.length === 1 ? 'one is' : 'few are'}:\n` +
            sources.slice(0, 5).map(line).join('\n');
        }
      } else {
        answer = `You have ${total} ${category} email${total === 1 ? '' : 's'}${windowText}. ` +
          `Here ${total === 1 ? 'it is' : `are the ${sources.length} most recent`}:\n` +
          sources.map(line).join('\n') +
          (total > sources.length ? `\n…and ${total - sources.length} more.` : '');
      }

      await supabase.from('chat_messages').insert([
        { user_id: req.user.id, role: 'user', content: query },
        { user_id: req.user.id, role: 'assistant', content: answer, sources }
      ]);
      return res.json({ answer, sources });
    }

    // ---------------------------------------------------------------------------------------
    // Counting queries ("how many emails from X", "number of X emails", "how many emails total").
    //
    // These MUST be answered with a structured COUNT over the ENTIRE email table for this user,
    // NOT by counting whatever semantic/structured retrieval happened to surface. Vector search is
    // capped (match_count 8, structured limit 30, keyword limit 5), so letting the LLM "count" the
    // retrieved set silently undercounts — e.g. reporting 4 Unstop emails when 116 are stored.
    // ---------------------------------------------------------------------------------------
    const isCountingQuery =
      /\b(how many|number of|count of|count the|total number|how much)\b/.test(q) &&
      /\b(emails?|mails?|messages?)\b/.test(q);

    if (isCountingQuery) {
      console.log('Detected counting query. Running structured COUNT over the full inbox...');

      // Optional date window.
      let dateLimit = null;
      const dDays = q.match(/last\s+(\d+)\s+days/);
      const dWeeks = q.match(/last\s+(\d+)\s+weeks/);
      const dMonths = q.match(/last\s+(\d+)\s+months/);
      const DAY = 24 * 60 * 60 * 1000;
      if (dDays) dateLimit = new Date(Date.now() - parseInt(dDays[1], 10) * DAY).toISOString();
      else if (dWeeks) dateLimit = new Date(Date.now() - parseInt(dWeeks[1], 10) * 7 * DAY).toISOString();
      else if (dMonths) dateLimit = new Date(Date.now() - parseInt(dMonths[1], 10) * 30 * DAY).toISOString();
      else if (/last month|past month|30 days/.test(q)) dateLimit = new Date(Date.now() - 30 * DAY).toISOString();
      else if (/last week|past week|7 days/.test(q)) dateLimit = new Date(Date.now() - 7 * DAY).toISOString();
      else if (/yesterday/.test(q)) dateLimit = new Date(Date.now() - DAY).toISOString();

      // Extract the sender/entity being counted. Prefer an explicit "from X" clause.
      let entity = null;
      const fromMatch = q.match(
        /\bfrom\s+(.+?)(?:\s+(?:in|over|during|within|last|past|this|since|between|on|do|did|that|are|were|have|has|had)\b|[?.,!]|$)/
      );
      if (fromMatch) entity = fromMatch[1].trim();
      if (!entity) {
        const STOPC = new Set([
          'how', 'many', 'much', 'number', 'count', 'total', 'of', 'the', 'a', 'an', 'this', 'that',
          'email', 'emails', 'mail', 'mails', 'message', 'messages', 'did', 'do', 'does', 'done',
          'i', 'me', 'my', 'you', 'your', 'have', 'has', 'had', 'receive', 'received', 'get', 'got',
          'are', 'were', 'was', 'is', 'in', 'on', 'from', 'last', 'past', 'this', 'days', 'weeks',
          'months', 'day', 'week', 'month', 'find', 'found', 'there', 'about', 'with', 'and', 'sent',
          'inbox', 'total', 'all', 'any'
        ]);
        const toks = q.replace(/[^a-z0-9\s&]/gi, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOPC.has(w));
        entity = toks.join(' ').trim();
      }

      const prettyDate = (d) =>
        d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown date';
      const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
      const windowText = dateLimit ? ' in the selected time period' : '';

      // No entity -> total inbox count.
      if (!entity) {
        let cq = supabase.from('emails').select('*', { count: 'exact', head: true }).eq('user_id', req.user.id);
        if (dateLimit) cq = cq.gte('sent_at', dateLimit);
        const { count } = await cq;
        const answer = `You have ${count ?? 0} email${count === 1 ? '' : 's'} synced to this account${windowText}.`;
        await supabase.from('chat_messages').insert([
          { user_id: req.user.id, role: 'user', content: query },
          { user_id: req.user.id, role: 'assistant', content: answer, sources: [] }
        ]);
        return res.json({ answer, sources: [] });
      }

      const like = `%${entity}%`;

      // Count by sender first (the common case: "emails from Unstop").
      let cq = supabase.from('emails').select('*', { count: 'exact', head: true })
        .eq('user_id', req.user.id).ilike('from_address', like);
      if (dateLimit) cq = cq.gte('sent_at', dateLimit);
      let { count } = await cq;
      let matchedOnSubject = false;

      // If the sender match is empty, the entity may be a topic/company in the subject line.
      if (!count) {
        let cq2 = supabase.from('emails').select('*', { count: 'exact', head: true })
          .eq('user_id', req.user.id).ilike('subject', like);
        if (dateLimit) cq2 = cq2.gte('sent_at', dateLimit);
        const r2 = await cq2;
        if (r2.count) {
          count = r2.count;
          matchedOnSubject = true;
        }
      }

      // Pull a few of the most recent matches as grounded citations.
      const matchCol = matchedOnSubject ? 'subject' : 'from_address';
      let sampleQ = supabase.from('emails')
        .select('gmail_message_id, gmail_thread_id, subject, from_address, sent_at')
        .eq('user_id', req.user.id).ilike(matchCol, like)
        .order('sent_at', { ascending: false }).limit(3);
      if (dateLimit) sampleQ = sampleQ.gte('sent_at', dateLimit);
      const { data: samples } = await sampleQ;

      const sources = (samples || []).map((e) => ({
        id: e.gmail_message_id,
        subject: e.subject,
        sender: e.from_address,
        sent_at: e.sent_at,
        thread_id: e.gmail_thread_id
      }));

      const label = titleCase(entity);
      let answer;
      if (!count) {
        answer = `I couldn't find any emails from ${label}${windowText} in your synced inbox.`;
      } else {
        answer = `You have ${count} email${count === 1 ? '' : 's'} from ${label}${windowText}` +
          (matchedOnSubject ? ' (matched on the subject line)' : '') + '.';
        if (sources.length > 0) {
          answer += ` The most recent ${sources.length === 1 ? 'one is' : `${sources.length} are`}:\n` +
            sources.map((s) => `• "${s.subject}" (${prettyDate(s.sent_at)})`).join('\n');
        }
      }

      await supabase.from('chat_messages').insert([
        { user_id: req.user.id, role: 'user', content: query },
        { user_id: req.user.id, role: 'assistant', content: answer, sources }
      ]);
      return res.json({ answer, sources });
    }

    let retrievedEmails = [];
    const isLatestQuery = /latest\s+email|newest\s+email|most\s+recent\s+email|last\s+email\s+received/i.test(query);

    if (isLatestQuery) {
      console.log('Detected latest email query. Bypassing vector search...');
      const { data: newestEmails, error: newestErr } = await supabase
        .from('emails')
        .select('*')
        .eq('user_id', req.user.id)
        .order('sent_at', { ascending: false })
        .limit(1);

      if (!newestErr && newestEmails) {
        retrievedEmails = newestEmails;
      }
    } else {
      // 1. Detect user intent and date constraints from query metadata
      const parseQueryMetadata = (q) => {
        const lq = q.toLowerCase();
        let category = null;
        
        if (/recruiter|recruit|job|application|apply|applied|hiring|interview|rejection|reject|unsuccessful|placement|offer|career|resume|cv|internship|assessment/i.test(lq)) {
          category = 'Job / Recruitment';
        } else if (/finance|financial|invoice|receipt|payment|transaction|debit|credit|bank|wallet|refund|billing|salary|payroll|tax|stripe|paypal|bill|charge|statement/i.test(lq)) {
          category = 'Finance';
        } else if (/otp|verification|password|reset|security|login|alert|notification|account activity|verify|sign-in|order confirmation|delivery/i.test(lq)) {
          category = 'Notifications';
        } else if (/work|project|client|meeting|schedule|zoom|teams|contract|vendor|update|feedback|review|proposal|task|professional/i.test(lq)) {
          category = 'Work / Professional';
        } else if (/newsletter|digest|blog|article|webinar|weekly|monthly|subscribed|unsubscribe|bulletin/i.test(lq)) {
          category = 'Newsletters';
        } else if (/personal|friend|family/i.test(lq)) {
          category = 'Personal';
        }

        let dateLimit = null;
        const lastDaysMatch = lq.match(/last\s+(\d+)\s+days/i);
        const lastWeeksMatch = lq.match(/last\s+(\d+)\s+weeks/i);
        
        if (lastDaysMatch) {
          const days = parseInt(lastDaysMatch[1], 10);
          dateLimit = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        } else if (lastWeeksMatch) {
          const weeks = parseInt(lastWeeksMatch[1], 10);
          dateLimit = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
        } else if (lq.includes('last month') || lq.includes('past month') || lq.includes('30 days')) {
          dateLimit = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        } else if (lq.includes('last week') || lq.includes('past week') || lq.includes('7 days')) {
          dateLimit = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        } else if (lq.includes('yesterday')) {
          dateLimit = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        }

        return { category, dateLimit };
      };

      const { category, dateLimit } = parseQueryMetadata(query);
      let structuredEmails = [];

      // 2. Perform Structured Metadata Query first if category or date range is detected
      if (category || dateLimit) {
        console.log(`Structured retrieval triggered. Category: ${category}, Date Limit: ${dateLimit}`);
        let threadIds = [];
        
        if (category) {
          // Find all threads matching the classified category
          const { data: threads } = await supabase
            .from('threads')
            .select('gmail_thread_id')
            .eq('user_id', req.user.id)
            .eq('category', category);
            
          if (threads && threads.length > 0) {
            threadIds = threads.map(t => t.gmail_thread_id);
          }
        }

        let emailQuery = supabase
          .from('emails')
          .select('*')
          .eq('user_id', req.user.id);

        if (category) {
          if (threadIds.length > 0) {
            emailQuery = emailQuery.in('gmail_thread_id', threadIds);
          } else {
            // Category detected but no threads match - build an empty filter to avoid crossing categories
            emailQuery = emailQuery.eq('gmail_thread_id', 'non_existent_thread_id');
          }
        }

        if (dateLimit) {
          emailQuery = emailQuery.gte('sent_at', dateLimit);
        }

        // Retrieve latest emails matching the structured metadata
        const { data: matchedEmails } = await emailQuery
          .order('sent_at', { ascending: false })
          .limit(30);

        if (matchedEmails && matchedEmails.length > 0) {
          structuredEmails = matchedEmails;
        }
      }

      // 3. Perform Vector Semantic Search
      const queryEmbedding = await getEmbedding(query, true);
      const { data: matchedEmbeddings, error: matchError } = await supabase.rpc(
        'match_email_embeddings',
        {
          query_embedding: queryEmbedding,
          match_threshold: 0.3,
          match_count: 8,
          p_user_id: req.user.id
        }
      );

      let vectorEmails = [];
      if (!matchError && matchedEmbeddings && matchedEmbeddings.length > 0) {
        const emailIds = matchedEmbeddings.map((match) => match.email_id);
        const { data: emails } = await supabase
          .from('emails')
          .select('*')
          .in('id', emailIds);
        vectorEmails = emails || [];
      }

      // 4. Perform Hybrid Rejection Keyword Search if applicable
      let keywordRejectionEmails = [];
      const isRejectionQuery = /reject|unsuccessful|not\s+selected|not\s+moving\s+forward|will\s+not\s+proceed|position\s+has\s+been\s+filled|pursuing\s+other\s+applicants|selected\s+another\s+candidate|chosen\s+a\s+different\s+candidate|move\s+forward\s+with\s+other\s+candidates/i.test(query);

      if (isRejectionQuery) {
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
          (phrase) => `clean_text_content.ilike.%${phrase}%,body_text.ilike.%${phrase}%,subject.ilike.%${phrase}%`
        ).join(',');

        const { data: keywordMatched } = await supabase
          .from('emails')
          .select('*')
          .eq('user_id', req.user.id)
          .or(orConditions)
          .order('sent_at', { ascending: false })
          .limit(15);
          
        keywordRejectionEmails = keywordMatched || [];
      }

      // 5. Merge all retrieved emails (prioritizing structured metadata -> keyword rejection -> vector -> general fallback)
      const existingIds = new Set();
      
      structuredEmails.forEach(e => {
        if (!existingIds.has(e.gmail_message_id)) {
          retrievedEmails.push(e);
          existingIds.add(e.gmail_message_id);
        }
      });

      keywordRejectionEmails.forEach(e => {
        if (!existingIds.has(e.gmail_message_id)) {
          retrievedEmails.push(e);
          existingIds.add(e.gmail_message_id);
        }
      });

      vectorEmails.forEach(e => {
        if (!existingIds.has(e.gmail_message_id)) {
          retrievedEmails.push(e);
          existingIds.add(e.gmail_message_id);
        }
      });

      // 6. General Keyword Fallback Search (if total matched emails is very small)
      if (retrievedEmails.length < 3) {
        const keywords = query
          .replace(/emails?|summariz?e|from|show|find|list/gi, '')
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 3);

        if (keywords.length > 0) {
          const orConditions = keywords.map(
            (k) => `subject.ilike.%${k}%,from_address.ilike.%${k}%,clean_text_content.ilike.%${k}%,body_text.ilike.%${k}%`
          ).join(',');
          
          const { data: textMatched } = await supabase
            .from('emails')
            .select('*')
            .eq('user_id', req.user.id)
            .or(orConditions)
            .limit(5);

          if (textMatched && textMatched.length > 0) {
            textMatched.forEach((e) => {
              if (!existingIds.has(e.gmail_message_id)) {
                retrievedEmails.push(e);
                existingIds.add(e.gmail_message_id);
              }
            });
          }
        }
      }
    }

    // 7. Expand to full threads for complete thread-level reasoning and retrieve category mappings
    if (retrievedEmails.length > 0) {
      const threadIds = [...new Set(retrievedEmails.map((e) => e.gmail_thread_id))];
      
      // Fetch matching thread categories
      const { data: threads } = await supabase
        .from('threads')
        .select('gmail_thread_id, category')
        .in('gmail_thread_id', threadIds);

      const threadCategoryMap = new Map();
      if (threads) {
        threads.forEach(t => threadCategoryMap.set(t.gmail_thread_id, t.category));
      }

      const { data: threadEmails, error: threadEmailsError } = await supabase
        .from('emails')
        .select('*')
        .eq('user_id', req.user.id)
        .in('gmail_thread_id', threadIds)
        .order('sent_at', { ascending: true });

      if (!threadEmailsError && threadEmails && threadEmails.length > 0) {
        retrievedEmails = threadEmails.map(email => ({
          ...email,
          category: threadCategoryMap.get(email.gmail_thread_id) || 'Notifications'
        }));
      }
    }

    // 6. Send retrieved emails to the generative model for final RAG response
    const chatResult = await askChatAgent(query, history, retrievedEmails);

    // 6. Save messages to Chat History in database
    await supabase.from('chat_messages').insert([
      { user_id: req.user.id, role: 'user', content: query },
      { 
        user_id: req.user.id, 
        role: 'assistant', 
        content: chatResult.answer,
        sources: chatResult.sources
      }
    ]);

    res.json({
      answer: chatResult.answer,
      sources: chatResult.sources
    });

  } catch (error) {
    console.error('Chat API Error:', error);

    // Gracefully handle Gemini daily/rate quota so the UI shows a clear message instead of hanging.
    const isQuota = error.status === 429 ||
                    error.message?.includes('429') ||
                    error.message?.toLowerCase().includes('quota');
    if (isQuota) {
      return res.json({
        answer: '⚠️ The AI assistant has temporarily hit its daily request limit and can\'t answer right now. Please try again later (the quota resets every 24 hours).',
        sources: []
      });
    }

    res.status(500).json({ error: error.message });
  }
});

/**
 * Endpoint: Newsletter Deduplicated Digest
 */
router.get('/newsletter/digest', requireAuth, async (req, res) => {
  try {
    // 1. Fetch newsletter emails from the past 4 days
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    
    // Find threads in category 'Newsletters'
    const { data: newsletterThreads, error: threadErr } = await supabase
      .from('threads')
      .select('gmail_thread_id')
      .eq('user_id', req.user.id)
      .eq('category', 'Newsletters');

    if (threadErr) throw threadErr;

    if (!newsletterThreads || newsletterThreads.length === 0) {
      return res.json({ digest: 'No recent newsletters found to compile.' });
    }

    const threadIds = newsletterThreads.map((t) => t.gmail_thread_id);

    // Get emails linked to those threads sent within 4 days
    const { data: emails, error: emailsErr } = await supabase
      .from('emails')
      .select('from_address, subject, clean_text_content, body_text, sent_at')
      .in('gmail_thread_id', threadIds)
      .gte('sent_at', fourDaysAgo)
      .order('sent_at', { ascending: false });

    if (emailsErr) throw emailsErr;

    if (!emails || emails.length === 0) {
      return res.json({ digest: 'No newsletter items received in the last 4 days.' });
    }

    // 2. Generate deduplicated newsletter digest using Gemini
    const digest = await deduplicateNewsletters(emails);

    res.json({ digest });
  } catch (error) {
    console.error('Digest API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
