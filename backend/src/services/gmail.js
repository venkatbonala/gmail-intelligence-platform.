import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { 
  getEmbedding, 
  summarizeEmail, 
  categorizeEmail, 
  summarizeThread,
  categorizeAndSummarizeEmail
} from './ai.js';
import { cleanEmailContent } from './cleaner.js';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env', override: true });

// Initialize Supabase Client (Service Role for admin backend capabilities)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// File Logging Helper to bypass stream buffering
function logDebug(message) {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync('debug.log', `[${timestamp}] ${message}\n`);
  } catch (err) {
    console.error('Failed to write to debug.log:', err);
  }
}

// Setup OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Gmail Scopes required
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/userinfo.email'
];

/**
 * Generate the Google OAuth authorization URL.
 */
export function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

/**
 * Exchange auth code for tokens and retrieve user's email.
 */
export async function getTokensFromCode(code) {
  const { tokens } = await oauth2Client.getToken(code);
  
  // Set credentials to fetch email
  const tempAuth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  tempAuth.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: tempAuth });
  const userInfo = await oauth2.userinfo.get();
  
  return {
    tokens,
    email: userInfo.data.email
  };
}

/**
 * Helper to get authenticated Gmail client, automatically refreshing expired tokens.
 */
export async function getGmailClient(userProfile) {
  const userOAuth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  userOAuth2.setCredentials({
    access_token: userProfile.access_token,
    refresh_token: userProfile.refresh_token,
    expiry_date: new Date(userProfile.token_expiry).getTime()
  });

  // Check if token needs refresh (within 5 minutes of expiry)
  const isExpired = new Date(userProfile.token_expiry).getTime() - Date.now() < 5 * 60 * 1000;
  if (isExpired) {
    console.log(`Refreshing access token for user: ${userProfile.email}`);
    logDebug(`Refreshing access token for user: ${userProfile.email}`);
    try {
      const { credentials } = await userOAuth2.refreshAccessToken();
      
      // Update tokens in Supabase
      const expiryDate = new Date(credentials.expiry_date).toISOString();
      await supabase
        .from('profiles')
        .update({
          access_token: credentials.access_token,
          token_expiry: expiryDate
        })
        .eq('id', userProfile.id);

      userOAuth2.setCredentials(credentials);
    } catch (error) {
      console.error('Error refreshing token:', error);
      logDebug(`Token refresh error: ${error.message}`);
      throw new Error('OAuth token refresh failed. Please re-authenticate.');
    }
  }

  return google.gmail({ version: 'v1', auth: userOAuth2 });
}

/**
 * Helper: Delay execution with Exponential Backoff
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes a Gmail API call, handling rate limits with exponential backoff.
 */
async function callGmailApiWithRetry(apiFn, retries = 5, backoffMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await apiFn();
    } catch (error) {
      const status = error.status || error.code || (error.response && error.response.status);
      if ((status === 429 || status === 403) && attempt < retries) {
        const sleepTime = backoffMs * Math.pow(2, attempt) + Math.random() * 500;
        console.warn(`Gmail API Rate Limited (status ${status}). Attempt ${attempt}/${retries}. Retrying in ${Math.round(sleepTime)}ms...`);
        logDebug(`Gmail API Rate Limited (status ${status}). Attempt ${attempt}/${retries}. Retrying in ${Math.round(sleepTime)}ms...`);
        await delay(sleepTime);
      } else {
        throw error;
      }
    }
  }
}

/**
 * Parse Gmail message payload to extract details and body.
 */
function parseGmailMessage(message) {
  const headers = message.payload.headers;
  
  const getHeader = (name) => {
    const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return found ? found.value : '';
  };

  const subject = getHeader('subject');
  const from = getHeader('from');
  const to = getHeader('to');
  const cc = getHeader('cc');
  const bcc = getHeader('bcc');
  const dateStr = getHeader('date');
  const sentAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

  // Extract body parts recursively
  let bodyText = '';
  let bodyHtml = '';

  function extractParts(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
    } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
      bodyHtml += Buffer.from(part.body.data, 'base64').toString('utf8');
    } else if (part.parts) {
      part.parts.forEach(extractParts);
    }
  }

  if (message.payload.parts) {
    message.payload.parts.forEach(extractParts);
  } else if (message.payload.body && message.payload.body.data) {
    const text = Buffer.from(message.payload.body.data, 'base64').toString('utf8');
    if (message.payload.mimeType === 'text/html') {
      bodyHtml = text;
    } else {
      bodyText = text;
    }
  }

  // If we only have HTML, strip tags for a basic text version
  if (!bodyText && bodyHtml) {
    bodyText = bodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const cleanText = cleanEmailContent(bodyHtml, bodyText);

  return {
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId,
    subject,
    from_address: from,
    to_address: to,
    cc_address: cc || null,
    bcc_address: bcc || null,
    body_text: cleanText, // Keep legacy body_text updated with clean content for safe fallback compatibility
    body_html: bodyHtml || null, // Keep legacy body_html updated with raw HTML
    raw_html_content: bodyHtml || null,
    raw_text_content: bodyText || '',
    clean_text_content: cleanText,
    sent_at: sentAt,
    snippet: message.snippet || ''
  };
}

/**
 * Local keyword/regex-based heuristic email classifier.
 * Categorizes an email into one of the 6 categories:
 * 'Newsletters', 'Job / Recruitment', 'Finance', 'Notifications', 'Work / Professional', 'Personal'.
 */
export function classifyEmailHeuristically(subject, from, body, rawBodyOrHtml = '') {
  const s = (subject || '').toLowerCase();
  const f = (from || '').toLowerCase();
  const b = (body || '').toLowerCase();
  const r = (rawBodyOrHtml || '').toLowerCase();

  const hasUnsubscribe = b.includes('unsubscribe') || (r && (
    r.includes('unsubscribe') ||
    r.includes('view in browser') ||
    r.includes('view online') ||
    r.includes('manage preferences') ||
    r.includes('manage subscriptions') ||
    r.includes('email preferences') ||
    r.includes('opt out') || r.includes('opt-out')
  ));

  // Automated / bulk-mailer senders are never a human writing personally. Used both as a
  // Newsletters signal and, critically, to STOP unmatched mail from falling through to Personal.
  const isAutomatedSender =
    f.includes('noreply') || f.includes('no-reply') || f.includes('no_reply') ||
    f.includes('donotreply') || f.includes('do-not-reply') || f.includes('do_not_reply') ||
    f.includes('notification') || f.includes('notifications@') || f.includes('alert') ||
    f.includes('mailer') || f.includes('mailing') || f.includes('newsletter') || f.includes('news@') ||
    f.includes('updates@') || f.includes('update@') || f.includes('marketing@') || f.includes('campaign') ||
    f.includes('digest') || f.includes('community') || f.includes('team@') || f.includes('hello@') ||
    f.includes('hi@') || f.includes('info@') || f.includes('support@') || f.includes('automated') ||
    f.includes('bounce') || f.includes('post@') || f.includes('substack') || f.includes('beehiiv') ||
    f.includes('mailchimp') || f.includes('sendgrid') || f.includes('mailgun');

  // 1. Job / Recruitment
  if (
    s.includes('job') || s.includes('career') || s.includes('interview') || s.includes('recruitment') ||
    s.includes('application') || s.includes('hiring') || s.includes('offer letter') || s.includes('resume') ||
    s.includes('recruit') || s.includes('rejection') || s.includes('hired') || s.includes('intern') ||
    s.includes('placement') || s.includes('referral') || s.includes('assessment') ||
    b.includes('interview schedule') || b.includes('application status') || b.includes('candidate')
  ) {
    return 'Job / Recruitment';
  }

  // 2. Finance — financial/transactional. Receipts, orders and purchases often lack the exact
  // phrase "order confirmation", so match the natural wording shoppers actually receive.
  if (
    s.includes('invoice') || s.includes('receipt') || s.includes('payment') || s.includes('bill') ||
    s.includes('transaction') || s.includes('statement') || s.includes('charge') || s.includes('refund') ||
    s.includes('stripe') || s.includes('paypal') || s.includes('bank') || s.includes('credit card') ||
    s.includes('payroll') || s.includes('salary') || s.includes('debit') || s.includes('credit') ||
    s.includes('order') || s.includes('purchase') || s.includes('shipment') || s.includes('shipped') ||
    s.includes('shipping') || s.includes('delivery') || s.includes('delivered') || s.includes('out for delivery') ||
    s.includes('tracking') || s.includes('on its way') || s.includes('subscription') || s.includes('renewal') ||
    s.includes('renewed') || s.includes('your plan') || s.includes('billed') || s.includes('paid') ||
    b.includes('amount due') || b.includes('amount paid') || b.includes('total paid') || b.includes('paid successfully') ||
    b.includes('payment received') || b.includes('payment successful') || b.includes('payment confirmation') ||
    b.includes('invoice details') || b.includes('payment receipt') || b.includes('your receipt') ||
    b.includes('order confirmation') || b.includes('order number') || b.includes('order #') ||
    b.includes('your order') || b.includes('thank you for your order') || b.includes('thanks for your order') ||
    b.includes('thank you for your purchase') || b.includes('your purchase') ||
    b.includes('shipping confirmation') || b.includes('has shipped') || b.includes('tracking number') ||
    b.includes('purchase confirmation') || b.includes('subscription has been') || b.includes('has been renewed')
  ) {
    return 'Finance';
  }

  // 3. Notifications
  if (
    !hasUnsubscribe && (
      s.includes('otp') || s.includes('verify') || s.includes('verification') || s.includes('security code') ||
      s.includes('password reset') || s.includes('reset your password') || s.includes('notification') ||
      s.includes('alert') || s.includes('login') || s.includes('log in') || s.includes('sign-in') ||
      s.includes('sign in') || s.includes('one-time') || s.includes('two-factor') || s.includes('2fa') ||
      s.includes('security') || s.includes('system') ||
      b.includes('one-time password') || b.includes('verification code') || b.includes('security code') ||
      b.includes('reset your password') || b.includes('new sign-in') || b.includes('new login')
    )
  ) {
    return 'Notifications';
  }

  // 4. Work / Professional — genuine 1:1 business mail. Stay gated behind !hasUnsubscribe and a
  // non-automated sender so broadcast "product update" / "weekly review" blasts don't land here.
  if (
    !hasUnsubscribe && !isAutomatedSender && (
      s.includes('project') || s.includes('meeting') || s.includes('schedule') || s.includes('feedback') ||
      s.includes('review') || s.includes('proposal') || s.includes('contract') ||
      s.includes('client') || s.includes('task') || s.includes('action required') ||
      b.includes('regards,') || b.includes('best,') || b.includes('thanks,')
    )
  ) {
    return 'Work / Professional';
  }

  // 5. Newsletters — one-to-many broadcast. Any bulk signal (unsubscribe link, automated sender)
  // or broadcast wording lands here. Covers creator updates, digests, webinars, marketing, etc.
  if (
    hasUnsubscribe || isAutomatedSender ||
    s.includes('newsletter') || s.includes('digest') || s.includes('weekly') || s.includes('monthly') ||
    s.includes('daily') || s.includes('subscribed') || s.includes('unsubscribe') || s.includes('bulletin') ||
    s.includes('webinar') || s.includes('workshop') || s.includes('masterclass') || s.includes('mastermind') ||
    s.includes('event') || s.includes('rsvp') || s.includes("you're invited") || s.includes('you are invited') ||
    s.includes('invitation') || s.includes('join us') || s.includes('save the date') || s.includes('register') ||
    s.includes('community') || s.includes('announcement') || s.includes('announcing') || s.includes('launch') ||
    s.includes('new feature') || s.includes('product update') || s.includes('release') || s.includes('edition') ||
    s.includes('recap') || s.includes('roundup') || s.includes('round-up') || s.includes("this week's") ||
    s.includes('update') || s.includes('% off') || s.includes('discount') || s.includes('sale') ||
    s.includes('deal') || s.includes('offer') || s.includes('promo') || s.includes('free class') ||
    s.includes('register now') ||
    f.includes('newsletter') || f.includes('news') || f.includes('digest') ||
    b.includes('unsubscribe') || b.includes('view in browser')
  ) {
    return 'Newsletters';
  }

  // 6. Personal — fallback ONLY for genuine human-to-human mail. An automated/bulk sender that
  // reaches this point is treated as broadcast, never Personal.
  if (isAutomatedSender || hasUnsubscribe) {
    return 'Newsletters';
  }
  return 'Personal';
}

/**
 * Build email details (category, summary, overview) WITHOUT calling Gemini.
 * Used when the Gemini quota is exhausted or the per-sync call cap is reached.
 *
 * The natural-language summary falls back to the email's snippet (Gmail's own preview text,
 * which reads as a sentence), and the AI Overview falls back to a single bullet of that snippet.
 */
function buildHeuristicEmailDetails(parsed) {
  const category = classifyEmailHeuristically(
    parsed.subject,
    parsed.from_address,
    parsed.body_text,
    parsed.raw_html_content || parsed.raw_text_content
  );
  const snippetText = parsed.snippet || (parsed.body_text || '').substring(0, 150) || 'No summary available.';
  return {
    category,
    summary: snippetText,
    overview: `• ${snippetText}`
  };
}

/**
 * Core Sync Engine: Synchronize inbox messages, categorizes, builds embeddings.
 */
export async function syncUserEmails(userProfile, limit = 150) {
  // Default to a bounded window so every synced email can be fully AI-processed within free-tier
  // quota. Pass an explicit higher number (or null) only if you have the Gemini quota to back it.
  if (limit === null) limit = 150;
  console.log(`Starting email sync for: ${userProfile.email} (Limit: ${limit})`);
  logDebug(`Starting email sync for: ${userProfile.email} (Limit: ${limit})`);
  
  // Set initial sync status
  await supabase
    .from('profiles')
    .update({ sync_status: 'syncing', sync_error: null })
    .eq('id', userProfile.id);

  try {
    const gmail = await getGmailClient(userProfile);
    
    let query = 'in:inbox';
    console.log(`Syncing inbox messages (Query: ${query}, Limit: ${limit || 'Unlimited'})`);
    logDebug(`Syncing inbox messages (Query: ${query}, Limit: ${limit || 'Unlimited'})`);

    // Pagination configuration
    let nextPageToken = null;
    let totalProcessed = 0;
    let successCount = 0;
    let pageNum = 1;
    const PAGE_SIZE = 100; // Configurable page size (100-500 emails per request)

    let totalDiscovered = 0;
    let emailsSkipped = 0;
    let emailsInserted = 0;
    let errorCount = 0;

    const updatedThreadIds = new Set();
    const threadSubjects = new Map();

    // AI summarization/classification is applied to EVERY email in the bounded sync window so the
    // whole synced inbox stays at full AI quality. We only stop calling Gemini if the API actually
    // signals quota exhaustion mid-sync, in which case we degrade gracefully to the local heuristic
    // for the remaining emails instead of failing the entire sync.
    let geminiCallsCount = 0;
    let geminiQuotaExhausted = false;

    // Do-while loop: requests pages sequentially until no nextPageToken remains or limit is hit
    do {
      // Calculate limit for this page request to respect the global sync limit cap
      const currentLimit = limit ? Math.min(PAGE_SIZE, limit - totalProcessed) : PAGE_SIZE;
      if (currentLimit <= 0) break;

      console.log(`Fetching page ${pageNum} (Limit for this page: ${currentLimit}, Page token: ${nextPageToken || 'none'})`);
      logDebug(`Fetching page ${pageNum} (Limit for this page: ${currentLimit}, Page token: ${nextPageToken || 'none'})`);

      // Update sync progress in Supabase (surfaces current page & total processed to UI)
      const nextAvailableString = nextPageToken ? 'Yes' : 'No';
      const statusText = `syncing: Page ${pageNum}, Discovered: ${totalDiscovered}, Skipped: ${emailsSkipped}, Inserted: ${emailsInserted}, Errors: ${errorCount}`;
      await supabase
        .from('profiles')
        .update({ 
          sync_status: statusText
        })
        .eq('id', userProfile.id);

      // Fetch list of messages for this page from the Gmail API
      const res = await callGmailApiWithRetry(() =>
        gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: currentLimit,
          pageToken: nextPageToken
        })
      );

      const pageMessages = res.data.messages || [];
      nextPageToken = res.data.nextPageToken;
      totalDiscovered += pageMessages.length;

      console.log(`Page ${pageNum} returned ${pageMessages.length} messages (Cumulative Discovered: ${totalDiscovered}).`);
      logDebug(`Page ${pageNum} returned ${pageMessages.length} messages (Cumulative Discovered: ${totalDiscovered}).`);

      if (pageMessages.length === 0) {
        break;
      }

      // Process the messages on the current page in batches of 5 to avoid API throttling
      const batchSize = 5;
      for (let i = 0; i < pageMessages.length; i += batchSize) {
        const batch = pageMessages.slice(i, i + batchSize);
        
        // Optimize: Check if messages in this batch already exist in our database before calling Gmail API
        const batchIds = batch.map((m) => m.id);
        const { data: existingEmails } = await supabase
          .from('emails')
          .select('gmail_message_id, summary')
          .eq('user_id', userProfile.id)
          .in('gmail_message_id', batchIds);

        const existingMap = new Map(existingEmails?.map((e) => [e.gmail_message_id, e.summary]) || []);

        const batchDetails = await Promise.all(
          batch.map(async (msg) => {
            const summary = existingMap.get(msg.id);
            const exists = existingMap.has(msg.id);
            const needsHealing = exists && (
              !summary || 
              summary === 'Failed to generate email details.' ||
              summary.includes('[Heuristic Preview]')
            );

            if (exists && !needsHealing) {
              // Mark as already exists and healthy to skip Gmail API fetch
              return { id: msg.id, threadId: msg.threadId, exists: true };
            }

            try {
              const detail = await callGmailApiWithRetry(() =>
                gmail.users.messages.get({
                  userId: 'me',
                  id: msg.id,
                  format: 'full'
                })
              );
              return detail.data;
            } catch (err) {
              console.error(`Failed to fetch message details for ${msg.id}:`, err.message);
              return null;
            }
          })
        );

        // Process details for each email message incrementally
        for (const rawMsg of batchDetails) {
          if (!rawMsg) continue;
          
          if (rawMsg.exists) {
            logDebug(`Email ${rawMsg.id} already exists and is healthy. Skipping API fetch.`);
            emailsSkipped++;
            successCount++;
            continue;
          }
          
          try {
            const parsed = parseGmailMessage(rawMsg);
            parsed.user_id = userProfile.id;

            // Check if this email already exists in the database
            const { data: existingEmail } = await supabase
              .from('emails')
              .select('id, summary')
              .eq('user_id', userProfile.id)
              .eq('gmail_message_id', parsed.gmail_message_id)
              .maybeSingle();

            const needsHealing = existingEmail && (
              !existingEmail.summary || 
              existingEmail.summary === 'Failed to generate email details.' ||
              existingEmail.summary.includes('[Heuristic Preview]')
            );

            if (existingEmail && !needsHealing) {
              logDebug(`Email ${parsed.gmail_message_id} already exists and is healthy. Skipping.`);
              emailsSkipped++;
              successCount++;
              continue;
            }

            if (existingEmail && needsHealing) {
              logDebug(`Email ${parsed.gmail_message_id} exists but has failed or heuristic summary. Retrying/healing...`);
            }

            // 1. Thread Handling (Insert or check thread)
            const { data: existingThread } = await supabase
              .from('threads')
              .select('id, updated_at, category')
              .eq('user_id', userProfile.id)
              .eq('gmail_thread_id', parsed.gmail_thread_id)
              .maybeSingle();

            let threadData;
            if (existingThread) {
              threadData = existingThread;
              const currentUpdatedAt = new Date(existingThread.updated_at).getTime();
              const newSentAt = new Date(parsed.sent_at).getTime();
              if (newSentAt > currentUpdatedAt) {
                const { data: updatedThread } = await supabase
                  .from('threads')
                  .update({ updated_at: parsed.sent_at })
                  .eq('id', existingThread.id)
                  .select()
                  .single();
                if (updatedThread) {
                  threadData = updatedThread;
                }
              }
            } else {
              const { data: newThread, error: threadError } = await supabase
                .from('threads')
                .insert({
                  gmail_thread_id: parsed.gmail_thread_id,
                  user_id: userProfile.id,
                  subject: parsed.subject,
                  updated_at: parsed.sent_at
                })
                .select()
                .single();

              if (threadError) {
                console.error('Database thread insert error:', threadError);
                logDebug(`Database thread insert error: ${JSON.stringify(threadError)}`);
                continue;
              }
              threadData = newThread;
            }

            logDebug(`Upserted thread successfully. DB Thread ID: ${threadData?.id || 'null'} (gmail_thread_id: ${parsed.gmail_thread_id})`);

            // Track thread ID and subject for post-sync summarization
            updatedThreadIds.add(parsed.gmail_thread_id);
            threadSubjects.set(parsed.gmail_thread_id, parsed.subject);

            // 2. Email Categorization & Summarization (hybrid AI/heuristic)
            let aiDetails;
            if (!geminiQuotaExhausted) {
              aiDetails = await categorizeAndSummarizeEmail(
                parsed.subject,
                parsed.from_address,
                parsed.body_text,
                parsed.snippet
              );
              geminiCallsCount++;

              if (aiDetails.summary === 'Failed to generate email details.') {
                console.warn('Gemini API call failed or quota exhausted. Bypassing Gemini for remaining emails.');
                logDebug('Gemini API call failed or quota exhausted. Bypassing Gemini for remaining emails.');
                geminiQuotaExhausted = true;

                // Fall back to heuristic classification and summary for this email
                aiDetails = buildHeuristicEmailDetails(parsed);
                logDebug(`[Heuristic Fallback] Categorized as: ${aiDetails.category}`);
              } else {
                logDebug(`[Gemini #${geminiCallsCount}] Categorized as: ${aiDetails.category}`);
                // Wait 4.5 seconds to respect the 15 RPM Gemini free-tier rate limit
                await delay(4500);
              }
            } else {
              // Local heuristic fallback
              aiDetails = buildHeuristicEmailDetails(parsed);
              logDebug(`[Heuristic] Categorized as: ${aiDetails.category} (Gemini call limit reached or quota exhausted)`);
            }

            // Update category of thread (DO NOT set updated_at here!)
            await supabase
              .from('threads')
              .update({ category: aiDetails.category })
              .eq('id', threadData.id);

            parsed.summary = aiDetails.summary;
            parsed.ai_overview = aiDetails.overview;

            // 4. Save Email Details to Database
            const emailDbPayload = { ...parsed };
            delete emailDbPayload.snippet;

            logDebug(`Upserting email gmail_message_id: ${parsed.gmail_message_id}`);

            const { data: emailData, error: emailError } = await supabase
              .from('emails')
              .upsert(emailDbPayload, { onConflict: 'user_id, gmail_message_id' })
              .select()
              .single();

            if (emailError) {
              console.error('Database email upsert error:', emailError);
              logDebug(`Database email upsert error: ${JSON.stringify(emailError)}`);
              errorCount++;
              continue;
            }

            logDebug(`Upserted email successfully. DB Email ID: ${emailData?.id || 'null'}`);
            emailsInserted++;

            // 5. Generate Vector Embedding using NVIDIA NIM
            try {
              const embeddingText = `
                Subject: ${parsed.subject}
                From: ${parsed.from_address}
                Date: ${parsed.sent_at}
                Content: ${parsed.body_text.substring(0, 500)}
              `.trim();

              const embeddingVector = await getEmbedding(embeddingText, false);
              logDebug(`NVIDIA NIM embedding generated successfully (${embeddingVector.length} dims)`);

              // Save embedding to DB
              await supabase.from('email_embeddings').upsert({
                email_id: emailData.id,
                gmail_message_id: parsed.gmail_message_id,
                thread_id: threadData.id,
                user_id: userProfile.id,
                embedding: embeddingVector,
                content: embeddingText
              });
              logDebug('Upserted embedding vector successfully.');
            } catch (embedErr) {
              console.error('Embedding generation failed, skipping embedding but preserving email record:', embedErr.message);
              logDebug(`Embedding generation failed: ${embedErr.message}`);
            }

            successCount++;
          } catch (err) {
            console.error(`Error processing synced email details:`, err);
            logDebug(`Error processing synced email details: ${err.message}\nStack: ${err.stack}`);
            errorCount++;
          }
        }

        // Delay slightly between batches to be nice to quotas
        await delay(300);
      }

      totalProcessed += pageMessages.length;
      pageNum++;

      // Stop page fetching if the global sync limit cap is reached
      if (limit && totalProcessed >= limit) {
        console.log(`Reached limit of ${limit} messages. Stopping page pagination.`);
        logDebug(`Reached limit of ${limit} messages. Stopping page pagination.`);
        break;
      }

    } while (nextPageToken);

    // If no emails were found/processed during the pagination loops, conclude the sync
    if (successCount === 0) {
      await supabase
        .from('profiles')
        .update({
          sync_status: 'completed',
          last_sync_at: new Date().toISOString(),
          sync_error: null
        })
        .eq('id', userProfile.id);
      return { count: 0 };
    }

    // Defer thread-level summarization to the end of sync to optimize Gemini rate limits.
    // Query emails from DB instead of re-fetching from Gmail to avoid extra API calls.
    console.log(`Generating thread-level summaries for ${updatedThreadIds.size} threads...`);
    logDebug(`Generating thread-level summaries for ${updatedThreadIds.size} threads...`);

    let threadSummariesCount = 0;

    for (const threadId of updatedThreadIds) {
      try {
        const { data: threadEmails, error: threadEmailsErr } = await supabase
          .from('emails')
          .select('*')
          .eq('user_id', userProfile.id)
          .eq('gmail_thread_id', threadId)
          .order('sent_at', { ascending: true });

        if (threadEmailsErr || !threadEmails || threadEmails.length === 0) continue;

        const subject = threadSubjects.get(threadId);

        let threadSummary;
        let threadOverview;

        // Single-message threads have no conversation arc to summarize, so we don't spend a Gemini
        // call on them — the thread summary simply IS that one email's summary. We still populate
        // thread.summary so the inbox list card shows real text instead of a "Fetching..." spinner.
        if (threadEmails.length < 2) {
          const onlyEmail = threadEmails[0];
          threadSummary = onlyEmail.summary || 'No summary available.';
          threadOverview = onlyEmail.ai_overview || (threadSummary ? `• ${threadSummary}` : '');
          await supabase
            .from('threads')
            .update({ summary: threadSummary, ai_overview: threadOverview })
            .eq('gmail_thread_id', threadId)
            .eq('user_id', userProfile.id);
          continue;
        }

        if (!geminiQuotaExhausted) {
          const result = await summarizeThread(subject, threadEmails);
          threadSummariesCount++;

          if (result.summary.includes('Failed to generate thread-level summary')) {
            console.warn('Gemini thread summary call failed or quota exhausted. Bypassing Gemini for remaining threads.');
            logDebug('Gemini thread summary call failed or quota exhausted. Bypassing Gemini for remaining threads.');
            geminiQuotaExhausted = true;

            // Fall back to heuristic: reuse the latest email's summary + overview
            const latestEmail = threadEmails[threadEmails.length - 1];
            threadSummary = latestEmail.summary || 'No summary available.';
            threadOverview = latestEmail.ai_overview || `• ${threadSummary}`;
            logDebug(`[Heuristic Thread Fallback] Reused latest email summary.`);
          } else {
            threadSummary = result.summary;
            threadOverview = result.overview;
            logDebug(`[Gemini Thread #${threadSummariesCount}] Generated thread summary.`);
            // Wait 4.5 seconds to respect the 15 RPM Gemini free-tier rate limit
            await delay(4500);
          }
        } else {
          // Heuristic thread summary: reuse the latest email's summary + overview (no extra API call)
          const latestEmail = threadEmails[threadEmails.length - 1];
          threadSummary = latestEmail.summary || 'No summary available.';
          threadOverview = latestEmail.ai_overview || `• ${threadSummary}`;
          logDebug(`[Heuristic Thread] Reused latest email summary (Gemini limit reached or quota exhausted).`);
        }

        await supabase
          .from('threads')
          .update({ summary: threadSummary, ai_overview: threadOverview })
          .eq('gmail_thread_id', threadId)
          .eq('user_id', userProfile.id);

        logDebug(`Updated thread-level summary for gmail_thread_id ${threadId} successfully.`);
      } catch (sumErr) {
        console.error(`Failed to update summary for thread ${threadId}:`, sumErr.message);
        logDebug(`Failed to update summary for thread ${threadId}: ${sumErr.message}`);
      }
    }

    console.log(`Sync completed. Discovered: ${totalDiscovered}, Processed: ${totalProcessed}, Inserted: ${emailsInserted}, Skipped: ${emailsSkipped}, Errors: ${errorCount}`);
    logDebug(`Sync completed. Discovered: ${totalDiscovered}, Processed: ${totalProcessed}, Inserted: ${emailsInserted}, Skipped: ${emailsSkipped}, Errors: ${errorCount}`);

    // Set sync state back to completed
    await supabase
      .from('profiles')
      .update({
        sync_status: 'completed',
        last_sync_at: new Date().toISOString(),
        sync_error: errorCount > 0 ? `Completed with ${errorCount} errors.` : null
      })
      .eq('id', userProfile.id);

    return { count: successCount };

  } catch (error) {
    console.error('Email Sync Pipeline Failed:', error);
    await supabase
      .from('profiles')
      .update({
        sync_status: 'failed',
        sync_error: error.message
      })
      .eq('id', userProfile.id);
    throw error;
  }
}

/**
 * Send an email using Gmail API, preserving threading if replying.
 */
export async function sendEmail({ userProfile, to, subject, body, threadId = null, replyToMessageId = null }) {
  const gmail = await getGmailClient(userProfile);
  
  let rawMessage = '';
  
  if (threadId && replyToMessageId) {
    // Formatting reply email with required headers to keep thread intact
    rawMessage = [
      `To: ${to}`,
      `Subject: ${subject.startsWith('Re:') ? subject : 'Re: ' + subject}`,
      `In-Reply-To: ${replyToMessageId}`,
      `References: ${replyToMessageId}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      body
    ].join('\r\n');
  } else {
    // Send standard email
    rawMessage = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      'MIME-Version: 1.0',
      '',
      body
    ].join('\r\n');
  }

  const encodedMessage = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const resource = {
    raw: encodedMessage
  };

  if (threadId) {
    resource.threadId = threadId;
  }

  const res = await callGmailApiWithRetry(() =>
    gmail.users.messages.send({
      userId: 'me',
      requestBody: resource
    })
  );

  return res.data;
}

/**
 * Load the full thread from Gmail API, parse and store/upsert all messages into the database,
 * and return the chronological list of messages.
 */
export async function syncAndGetFullThread(userProfile, gmailThreadId, gmailInstance = null) {
  const gmail = gmailInstance || await getGmailClient(userProfile);
  
  console.log(`Fetching full thread from Gmail API: ${gmailThreadId}`);
  logDebug(`Fetching full thread from Gmail API: ${gmailThreadId}`);

  // Fetch full thread with all message details
  const res = await callGmailApiWithRetry(() =>
    gmail.users.threads.get({
      userId: 'me',
      id: gmailThreadId,
      format: 'full'
    })
  );

  const gmailMessages = res.data.messages || [];
  console.log(`Gmail thread ${gmailThreadId} has ${gmailMessages.length} messages.`);
  logDebug(`Gmail thread ${gmailThreadId} has ${gmailMessages.length} messages.`);

  // 1. Ensure the thread record exists in the threads table
  const { data: existingThread } = await supabase
    .from('threads')
    .select('id, updated_at')
    .eq('user_id', userProfile.id)
    .eq('gmail_thread_id', gmailThreadId)
    .maybeSingle();

  // Find the latest message date to set thread updated_at
  const parsedMessages = gmailMessages.map(msg => parseGmailMessage(msg));
  parsedMessages.forEach(m => { m.user_id = userProfile.id; });
  
  // Sort messages chronologically by sent_at asc
  parsedMessages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));

  const latestMessage = parsedMessages[parsedMessages.length - 1];
  const subject = parsedMessages[0]?.subject || '(No Subject)';

  let threadDbId;
  if (existingThread) {
    threadDbId = existingThread.id;
    // Update thread subject / updated_at if needed
    await supabase
      .from('threads')
      .update({
        subject,
        updated_at: latestMessage.sent_at
      })
      .eq('id', existingThread.id);
  } else {
    const { data: newThread, error: threadError } = await supabase
      .from('threads')
      .insert({
        gmail_thread_id: gmailThreadId,
        user_id: userProfile.id,
        subject,
        updated_at: latestMessage.sent_at
      })
      .select()
      .single();

    if (threadError) {
      throw new Error(`Failed to create thread record: ${threadError.message}`);
    }
    threadDbId = newThread.id;
  }

  // 2. Process and upsert each email message in the thread
  const upsertedEmails = [];
  for (const parsed of parsedMessages) {
    // Check if email already exists
    const { data: existingEmail } = await supabase
      .from('emails')
      .select('id, summary, ai_overview')
      .eq('user_id', userProfile.id)
      .eq('gmail_message_id', parsed.gmail_message_id)
      .maybeSingle();

    const needsHealing = existingEmail && (
      !existingEmail.summary ||
      existingEmail.summary === 'Failed to generate email details.' ||
      existingEmail.summary.includes('[Heuristic Preview]')
    );

    let emailDbId = existingEmail?.id;
    let summary = existingEmail?.summary;
    let aiOverview = existingEmail?.ai_overview;

    if (!existingEmail || needsHealing) {
      // Categorize and summarize this email (using heuristics to save rate limits)
      const heuristic = buildHeuristicEmailDetails(parsed);
      const category = heuristic.category;
      summary = heuristic.summary;
      aiOverview = heuristic.overview;

      parsed.summary = summary;
      parsed.ai_overview = aiOverview;

      const emailDbPayload = { ...parsed };
      delete emailDbPayload.snippet;

      const { data: emailData, error: emailError } = await supabase
        .from('emails')
        .upsert(emailDbPayload, { onConflict: 'user_id, gmail_message_id' })
        .select()
        .single();

      if (emailError) {
        console.error('Failed to upsert message from thread sync:', emailError);
        continue;
      }
      
      emailDbId = emailData.id;

      // Update thread category to match the first email's category if thread category is null
      const { data: threadRec } = await supabase
        .from('threads')
        .select('category')
        .eq('id', threadDbId)
        .single();
      if (threadRec && !threadRec.category) {
        await supabase
          .from('threads')
          .update({ category })
          .eq('id', threadDbId);
      }

      // Generate embedding
      try {
        const embeddingText = `
          Subject: ${parsed.subject}
          From: ${parsed.from_address}
          Date: ${parsed.sent_at}
          Content: ${parsed.body_text.substring(0, 500)}
        `.trim();

        const embeddingVector = await getEmbedding(embeddingText, false);
        await supabase.from('email_embeddings').upsert({
          email_id: emailDbId,
          gmail_message_id: parsed.gmail_message_id,
          thread_id: threadDbId,
          user_id: userProfile.id,
          embedding: embeddingVector,
          content: embeddingText
        });
      } catch (embErr) {
        console.error('Failed embedding in thread sync:', embErr.message);
      }
    }

    upsertedEmails.push({
      ...parsed,
      id: emailDbId,
      summary,
      ai_overview: aiOverview
    });
  }

  // Sort upsertedEmails chronologically
  upsertedEmails.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
  return { threadDbId, messages: upsertedEmails };
}
