import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env', override: true });

// Initialize Gemini SDK
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Call Gemini model with retry on rate limit (429).
 */
export async function callGeminiWithRetry(prompt, modelName = 'gemini-3.1-flash-lite', retries = 4, delayMs = 2500, config = {}) {
  const model = genAI.getGenerativeModel({ model: modelName });
  for (let i = 0; i < retries; i++) {
    try {
      const options = Object.keys(config).length > 0 
        ? { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: config }
        : prompt;
      const result = await model.generateContent(options);
      return result;
    } catch (error) {
      const isRateLimit = error.status === 429 || 
                          error.message?.includes('429') || 
                          error.message?.includes('Quota exceeded');
      
      const isTransient = error.status === 500 || error.status === 503 || error.status === 504 ||
                          error.message?.includes('500') || error.message?.includes('503') || error.message?.includes('504') ||
                          error.message?.toLowerCase().includes('temporary') || error.message?.toLowerCase().includes('service unavailable');
                          
      const isDailyQuotaExceeded = error.message?.includes('GenerateRequestsPerDay') ||
                                   error.message?.includes('requests_per_day');

      if (isDailyQuotaExceeded) {
        console.warn('Gemini daily free-tier quota exceeded. Failing fast.');
        throw error;
      }

      if ((isRateLimit || isTransient) && i < retries - 1) {
        let waitTime = delayMs * Math.pow(2, i) + Math.random() * 1000;
        
        try {
          if (error.errorDetails) {
            const retryInfo = error.errorDetails.find(
              (d) => d && (d['@type']?.includes('RetryInfo') || d.retryDelay)
            );
            if (retryInfo && retryInfo.retryDelay) {
              const seconds = parseFloat(retryInfo.retryDelay);
              if (!isNaN(seconds)) {
                waitTime = (seconds + 1.5) * 1000; // wait specified seconds + 1.5s buffer
              }
            }
          }
        } catch (parseErr) {
          // Fallback to exponential waitTime
        }
        
        console.warn(`Gemini API error (status ${error.status || 'unknown'}). Retrying in ${Math.round(waitTime)}ms... (Attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
}

/**
 * Categorize and summarize an email in a single Gemini call.
 *
 * Returns three distinct outputs:
 *  - category: one of the six canonical categories
 *  - summary:  a natural-language prose summary of the email (the assignment requirement)
 *  - overview: an optional complementary extraction layer (key facts/actions as bullet points)
 */
export async function categorizeAndSummarizeEmail(subject, from, body, snippet) {
  try {
    const prompt = `
      You are an email intelligence assistant and classification engine. Analyze the ENTIRE content of the email below and perform three tasks:
      1. Classify it into EXACTLY ONE of the defined categories, following the priority rules strictly.
      2. Write a natural-language SUMMARY: 1-3 plain-English sentences capturing what the email is about and why it matters.
      3. Write an AI OVERVIEW: a short list of bullet points extracting the key facts, actions, entities, dates and outcomes.

      ========================================
      CATEGORY DEFINITIONS
      ========================================
      Job / Recruitment:
      Hiring-related — recruiter outreach, job invitations, interview scheduling, offers, rejections, assessments.

      Finance:
      Financial/transactional — order confirmations, receipts, invoices, refunds, payment confirmations, subscription renewals, bank alerts, shipping/transaction emails.

      Notifications:
      System-generated alerts — OTPs, login alerts, security warnings, password resets.

      Work / Professional:
      Business communication unrelated to hiring — client communication, project discussions, meeting requests, partnership conversations.

      Newsletters:
      One-to-many broadcast — creator updates, weekly digests, community announcements, webinar/event invitations, marketing campaigns, educational content, product updates.

      Personal:
      ONLY genuine human-to-human communication — friends, family, individual conversations, personal invitations and follow-ups.

      ========================================
      CRITICAL CLASSIFICATION RULES
      ========================================
      1. Classify based on the PRIMARY PURPOSE of the email, not its tone, sender name, or whether it names/addresses the recipient.
      2. An email is NOT Personal just because it contains the recipient's name, was sent directly to them, or uses a friendly/conversational tone.
      3. Evaluate ALL other categories before assigning Personal. Personal is the fallback ONLY when no stronger category applies.
      4. Apply this priority order when more than one could fit:
         (1) Job / Recruitment
         (2) Finance
         (3) Notifications
         (4) Work / Professional
         (5) Newsletters
         (6) Personal

      CRITICAL INSTRUCTION: Do NOT generate the summary based only on the first paragraph or the opening sentences. You MUST analyze the entire email content to extract its true meaning, key takeaways, and action items.

      Content focus (applies to both the summary and the overview):
      - Main purpose: Identify the overall intent/subject of the email.
      - Action items: Highlight what the recipient needs to do next.
      - Dates/Deadlines: Extract any important deadlines, dates, or times.
      - Decisions/Requests: Highlight requests made by the sender.

      Email Type-Specific Focus:
      - Newsletter: Focus on the main lesson, key insights, recommended actions, and important announcements.
      - Job Invitation: Focus on the Company, Role, next action, and deadline.
      - Job Rejection: Focus on the Company, Role, decision (rejection/unsuccessful), and next steps if any.
      - Meeting: Focus on the Date, Time, participants, and requested action.
      - Billing/Invoice: Focus on the Amount, Due date, and required action.
      - General / Work / Personal: Focus on key takeaways and any actionable requests.

      SUMMARY constraints (natural language):
      - 1-3 complete sentences of plain English prose. NO bullet points, NO bullet symbols.
      - Read like a human one-line briefing of the email. Mention the sender/company and the core point.
      - Maximum ~45 words.

      AI OVERVIEW constraints (extraction layer):
      - 2-5 short bullet items. Return them as an array of strings WITHOUT any leading bullet symbol.
      - Each item is a key fact, action, entity, date or outcome. Maximum ~15 words per item.
      - Do NOT repeat the same information across items.

      Sender: ${from}
      Subject: ${subject}
      Email Content:
      ${(body || '').trim()}
    `;

    const schema = {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [
            'Job / Recruitment',
            'Finance',
            'Notifications',
            'Work / Professional',
            'Newsletters',
            'Personal'
          ],
          description: 'The classified category of the email strictly following definitions and priority order.'
        },
        summary: {
          type: 'string',
          description: 'Natural-language prose summary of the email. 1-3 plain-English sentences, no bullet points. Max ~45 words.'
        },
        overview: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional complementary extraction layer: 2-5 short bullet items (key facts, actions, entities, dates, outcomes), each without a leading bullet symbol.'
        }
      },
      required: ['category', 'summary', 'overview']
    };

    const result = await callGeminiWithRetry(prompt, 'gemini-3.1-flash-lite', 4, 2500, {
      responseMimeType: 'application/json',
      responseSchema: schema
    });

    const text = result.response.text().trim();
    const data = JSON.parse(text);

    return {
      category: data.category || 'Notifications',
      summary: data.summary || 'No summary available.',
      overview: formatOverviewBullets(data.overview)
    };
  } catch (error) {
    console.error('Categorize and Summarize Email Error:', error);
    return {
      category: 'Notifications',
      summary: 'Failed to generate email details.',
      overview: ''
    };
  }
}

/**
 * Normalize an AI Overview into a stored bullet string (one "• item" per line).
 * Accepts either an array of strings or an already-formatted string.
 */
export function formatOverviewBullets(overview) {
  if (!overview) return '';
  const items = Array.isArray(overview)
    ? overview
    : String(overview).split('\n');
  return items
    .map((item) => String(item).replace(/^[•\-\*\d+\.\s]+/, '').trim())
    .filter((item) => item.length > 0)
    .map((item) => `• ${item}`)
    .join('\n');
}


/**
 * Classification-only call: returns EXACTLY one of the six canonical categories.
 *
 * Unlike `categorizeEmail`/`categorizeAndSummarizeEmail`, this does NOT swallow errors with a
 * default category — it throws on API failure so the caller (e.g. the reclassifier) can decide
 * whether to fall back to the local heuristic. Uses a strict response enum so the returned value
 * is guaranteed to be a valid category.
 */
export const EMAIL_CATEGORIES = [
  'Job / Recruitment',
  'Finance',
  'Notifications',
  'Work / Professional',
  'Newsletters',
  'Personal'
];

export async function classifyEmailWithAI(subject, from, body) {
  const prompt = `
    You are an email classification engine. Classify the email into EXACTLY ONE category.

    Categories:
    - Job / Recruitment: hiring-related — recruiter outreach, job invitations, interview scheduling, offers, rejections, assessments.
    - Finance: financial/transactional — order confirmations, receipts, invoices, refunds, payment confirmations, subscription renewals, bank alerts, shipping/transaction emails.
    - Notifications: system-generated alerts — OTPs, login alerts, security warnings, password resets.
    - Work / Professional: business communication unrelated to hiring — client communication, project discussions, meeting requests, partnership/investor conversations.
    - Newsletters: one-to-many broadcast — creator updates, weekly digests, community announcements, webinar/event invitations, marketing campaigns, educational content, product updates.
    - Personal: ONLY genuine human-to-human communication — friends, family, individual conversations, personal invitations and follow-ups.

    Critical rules:
    1. Classify by the PRIMARY PURPOSE, not tone, sender name, or whether it addresses the recipient by name.
    2. An email is NOT Personal just because it contains the recipient's name, was sent directly to them, or uses a friendly tone.
    3. Evaluate ALL other categories before assigning Personal. Personal is the fallback ONLY when no stronger category applies.
    4. Priority when more than one could fit: (1) Job / Recruitment, (2) Finance, (3) Notifications, (4) Work / Professional, (5) Newsletters, (6) Personal.

    Sender: ${from}
    Subject: ${subject}
    Email Content:
    ${(body || '').trim().substring(0, 4000)}
  `;

  const schema = {
    type: 'object',
    properties: {
      category: { type: 'string', enum: EMAIL_CATEGORIES }
    },
    required: ['category']
  };

  const result = await callGeminiWithRetry(prompt, 'gemini-3.1-flash-lite', 4, 2500, {
    responseMimeType: 'application/json',
    responseSchema: schema
  });

  const data = JSON.parse(result.response.text().trim());
  if (!EMAIL_CATEGORIES.includes(data.category)) {
    throw new Error(`Model returned invalid category: ${data.category}`);
  }
  return data.category;
}

/**
 * Generate a 1024-dimension embedding for the given text using NVIDIA NIM.
 * @param {string} text - The content to embed.
 * @param {boolean} isQuery - True if this embedding is for a search query, false if it's for a database passage.
 * @returns {Promise<number[]>} The vector embedding.
 */
export async function getEmbedding(text, isQuery = false) {
  try {
    const response = await axios.post(
      `${process.env.NVIDIA_NIM_BASE_URL}/embeddings`,
      {
        input: [text],
        model: process.env.NVIDIA_NIM_EMBED_MODEL || 'nvidia/nv-embedqa-e5-v5',
        encoding_format: 'float',
        input_type: isQuery ? 'query' : 'passage'
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    if (response.data && response.data.data && response.data.data[0]) {
      return response.data.data[0].embedding;
    }
    throw new Error('Invalid embedding response from NVIDIA NIM API');
  } catch (error) {
    console.error('NVIDIA NIM Embedding Error:', error.response?.data || error.message);
    throw new Error(`NVIDIA NIM embedding failed: ${error.message}`);
  }
}

/**
 * Generate a concise summary for a single email.
 */
export async function summarizeEmail(subject, from, body) {
  try {
    const prompt = `
      You are an email intelligence assistant. Summarize the following email in a concise, bulleted Gmail-style format.
      
      Email Category Summarization Rules:
      - Job Invitation: Highlight Company, Role, and Required action.
      - Job Rejection: Highlight Company, Outcome, and Next step if any.
      - Meeting: Highlight Purpose, Time/date, and Required response.
      - Newsletter: Highlight Key takeaway and Important announcement.
      - Billing/Invoice: Highlight Amount, Due date, and Required action.
      - General: Highlight key information and action items.

      Constraints:
      - Use bullet points (start each line with a bullet symbol: •).
      - Output 2-5 bullet points.
      - Keep each bullet concise and scannable (maximum 20 words per bullet).
      - Remove unnecessary background information, long paragraphs, and repeated details.
      - Avoid mentioning dates or sender names unless important or critical.
      - Return only the bulleted summary, no explanations.
      
      From: ${from}
      Subject: ${subject}
      Body:
      ${body.substring(0, 4000)}
      
      Summary:
    `;

    const result = await callGeminiWithRetry(prompt, 'gemini-3.1-flash-lite');
    return result.response.text().trim();
  } catch (error) {
    console.error('Email Summarization Error:', error);
    return '• Failed to generate email summary.';
  }
}

/**
 * Format a list of emails into a chronological conversation transcript.
 */
export function formatThreadTranscript(emails) {
  // Sort emails chronologically by sent_at asc to ensure correct historical flow
  const sortedEmails = [...emails].sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
  
  return sortedEmails
    .map(
      (email, idx) => `Message #${idx + 1}
From: ${email.from_address}
To: ${email.to_address || 'User'}
Date: ${email.sent_at}
Subject: ${email.subject}
Content:
${email.clean_text_content || email.body_text || ''}`
    )
    .join('\n\n---\n\n');
}

/**
 * Generate a thread-level summary outlining the full conversation arc.
 *
 * Returns { summary, overview }:
 *  - summary:  natural-language prose summary of the ENTIRE conversation arc (context-aware —
 *              later replies are understood in the context of the whole thread, not in isolation)
 *  - overview: optional complementary extraction layer (key facts/actions as bullet points)
 */
export async function summarizeThread(subject, emails) {
  try {
    const emailChain = formatThreadTranscript(emails);

    const prompt = `
      You are an email intelligence assistant. Review the following email thread/conversation in full.
      The thread is in chronological order. Understand each message in the context of the whole
      conversation (a later reply must be interpreted relative to what came before it, not in isolation).

      Perform two tasks:
      1. SUMMARY: Write a natural-language prose summary of the overall conversation arc — how it
         started, how it progressed, and where it currently stands.
      2. AI OVERVIEW: Extract the key facts, decisions, action items and outcomes as bullet points.

      Category-aware focus:
      - Job Invitation: Company, Role, and Required action.
      - Job Rejection: Company, Outcome, and Next step if any.
      - Meeting: Purpose, Time/date, and Required response.
      - Newsletter: Key takeaway and Important announcement.
      - Billing/Invoice: Amount, Due date, and Required action.
      - General: key information and action items.

      SUMMARY constraints (natural language):
      - 2-4 complete sentences of plain English prose. NO bullet points, NO bullet symbols.
      - Describe the conversation arc and current status. Maximum ~70 words.

      AI OVERVIEW constraints (extraction layer):
      - 2-5 short bullet items, returned as an array of strings WITHOUT leading bullet symbols.
      - Each item is a key fact, decision, action item or outcome. Maximum ~15 words per item.

      Thread Subject: ${subject}
      Conversation history:
      ${emailChain}
    `;

    const schema = {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Natural-language prose summary of the whole conversation arc. 2-4 sentences, no bullet points.'
        },
        overview: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional complementary extraction layer: 2-5 short bullet items without leading bullet symbols.'
        }
      },
      required: ['summary', 'overview']
    };

    const result = await callGeminiWithRetry(prompt, 'gemini-3.1-flash-lite', 4, 2500, {
      responseMimeType: 'application/json',
      responseSchema: schema
    });

    const data = JSON.parse(result.response.text().trim());
    return {
      summary: data.summary || 'No summary available.',
      overview: formatOverviewBullets(data.overview)
    };
  } catch (error) {
    console.error('Thread Summarization Error:', error);
    return {
      summary: 'Failed to generate thread-level summary.',
      overview: ''
    };
  }
}

/**
 * Categorize an email into one of the 6 categories.
 */
export async function categorizeEmail(subject, from, snippet) {
  try {
    const prompt = `
      You are an email classification engine.

      Your task is to classify every email into EXACTLY ONE of the following categories:

      - Job / Recruitment: hiring-related — recruiter outreach, job invitations, interview scheduling, offers, rejections, assessments.
      - Finance: financial/transactional — order confirmations, receipts, invoices, refunds, payment confirmations, subscription renewals, bank alerts, shipping/transaction emails.
      - Notifications: system-generated alerts — OTPs, login alerts, security warnings, password resets.
      - Work / Professional: business communication unrelated to hiring — client communication, project discussions, meeting requests, partnership conversations.
      - Newsletters: one-to-many broadcast — creator updates, weekly digests, community announcements, webinar/event invitations, marketing campaigns, educational content, product updates.
      - Personal: ONLY genuine human-to-human communication — friends, family, individual conversations, personal invitations and follow-ups.

      Critical rules:
      1. An email is NOT Personal just because it contains the recipient's name, was sent directly to them, or uses a friendly tone.
      2. Evaluate ALL other categories before assigning Personal. Personal is the fallback ONLY when no stronger category applies.
      3. Apply this priority order when more than one could fit: (1) Job / Recruitment, (2) Finance, (3) Notifications, (4) Work / Professional, (5) Newsletters, (6) Personal.

      Classify based on the PRIMARY PURPOSE of the email, not its tone or whether it names the recipient.

      Sender: ${from}
      Subject: ${subject}
      Snippet: ${(snippet || '').substring(0, 1000)}

      Return only the single category name, exactly as written above, nothing else.
    `;

    const result = await callGeminiWithRetry(prompt, 'gemini-3.1-flash-lite');
    return result.response.text().trim();
  } catch (error) {
    console.error('Email Categorization Error:', error);
    return 'Notifications';
  }
}

/**
 * Draft a professional email based on a prompt.
 */
export async function draftNewEmail(promptText) {
  try {
    const prompt = `
      You are an AI assistant helping a user write an email. Based on the user's instructions, draft a complete, professional, and well-structured email. 
      Output ONLY the draft (with Subject: and Body: sections). Do not include any intro or outro text.

      User Instruction: "${promptText}"

      Draft:
    `;

    const result = await callGeminiWithRetry(prompt, 'gemini-3.1-flash-lite');
    const text = result.response.text().trim();
    
    let subject = 'Draft Email';
    let body = text;

    const subjectMatch = text.match(/Subject:\s*(.*)/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
      body = text.replace(/Subject:\s*(.*)/i, '').trim();
    }
    
    if (body.toLowerCase().startsWith('body:')) {
      body = body.substring(5).trim();
    }

    return { subject, body };
  } catch (error) {
    console.error('Draft New Email Error:', error);
    throw new Error('Failed to draft email.');
  }
}

/**
 * Draft a context-aware reply to a thread.
 */
export async function draftReplyEmail(emails, promptText) {
  try {
    const emailChain = formatThreadTranscript(emails);

    const prompt = `
      You are an AI assistant drafting a reply to an email thread on behalf of the user. 
      Analyze the thread history and draft a response based on the user's instruction prompt.
      Maintain a professional tone that is consistent with the conversation.
      Output ONLY the body of the reply. Do not add placeholders like "[Your Name]" if you can avoid it, or sign off naturally as the sender.

      Thread History:
      ${emailChain}

      User Reply Instruction: "${promptText}"

      Reply Body:
    `;

    const result = await callGeminiWithRetry(prompt, 'gemini-3.1-flash-lite');
    return result.response.text().trim();
  } catch (error) {
    console.error('Draft Reply Email Error:', error);
    throw new Error('Failed to draft reply email.');
  }
}

/**
 * Deduplicate news articles from newsletters.
 */
export async function deduplicateNewsletters(newsletters) {
  try {
    const newslettersDump = newsletters
      .map(
        (n, idx) => `
        Newsletter #${idx + 1}
        Source/Sender: ${n.from_address}
        Date: ${n.sent_at}
        Subject: ${n.subject}
        Content:
        ${(n.clean_text_content || n.body_text || '').substring(0, 3000)}
      `
      )
      .join('\n=======\n');

    const prompt = `
      You are an advanced news digest compiler. Below is a collection of newsletter emails received by the user recently.
      
      Tasks:
      1. Extract all significant news stories, tech updates, articles, or product announcements from all newsletters.
      2. Group and deduplicate stories that discuss the exact same news or event (using semantic clustering).
      3. For each unique news item, write a synthesized, clear summary (1-3 sentences) representing the facts.
      4. List all original source newsletters that carried this item so the user knows where it came from.
      5. Output the result in a clean, beautifully formatted markdown digest grouped by category (e.g. AI & Tech, Business, General).

      Newsletter Content:
      ${newslettersDump}

      Markdown Digest:
    `;

    const result = await callGeminiWithRetry(prompt, 'gemini-3.1-flash-lite');
    return result.response.text().trim();
  } catch (error) {
    console.error('Newsletter Deduplication Error:', error);
    throw new Error('Failed to deduplicate newsletters.');
  }
}

/**
 * Query the RAG chat agent.
 */
export async function askChatAgent(query, chatHistory, retrievedContexts) {
  try {
    const contextText = retrievedContexts
      .map(
        (ctx, idx) => `
        Context #${idx + 1}
        Email ID: ${ctx.gmail_message_id}
        Sender: ${ctx.from_address}
        To: ${ctx.to_address}
        Date: ${ctx.sent_at}
        Subject: ${ctx.subject}
        Category: ${ctx.category || 'Notifications'}
        Content:
        ${ctx.body_text?.substring(0, 3000) || ''}
      `
      )
      .join('\n---\n');

    const historyText = chatHistory
      .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n');

    const prompt = `
      You are the AI Chat Agent centerpiece of the Gmail Intelligence Platform. 
      You act as a knowledgeable assistant that has read all of the user's emails.
      
      Your goal is to answer the user's query using EXCLUSIVELY the email content provided below in the "Retrieved Email Contexts" section.
      
      Core Rules:
      1. Use **Plain English Format**: Your response must be in clean, plain, natural, conversational English prose. 
         - Do NOT use JSON, HTML, or any other structured code format.
         - Do NOT use Markdown formatting: do NOT use asterisks (*) or dashes (-) for bullet points, do NOT use double asterisks (**) for bolding, and do NOT use markdown links ([text](url)) or raw URLs.
         - If you need to list items, describe them in natural paragraphs or use plain text numbering (e.g., "1. First... 2. Second...").
      2. Maintain **Source Clarity**: In your answer, you MUST state which email (Sender, Subject, and Date) the information came from using simple plain English prose (e.g., "According to the email from PayPal on June 18, 2026, with the subject...").
      3. Handle **Cross-Email Reasoning**: If multiple emails discuss the topic, synthesize them into a single coherent answer, clearly attributing each fact to its source.
      4. **No Hallucinations**: If the retrieved contexts do not contain the information needed to answer the user's query, say clearly: "I cannot find any information about that in your synced emails." Do NOT make up facts.
      5. Maintain **Conversational Context**: Use the provided Chat History to understand follow-up questions.
      6. Job Rejections Formatting: If the query is about job application rejections or unsuccessful applications, for every rejection found, you MUST return the following details in a clean, natural, plain-text format (using plain text numbering, without markdown bolding, asterisks, or dashes):
         - Company Name: [Name of the company]
         - Position: [Name of the position applied for]
         - Date: [Date of the email]
         - Rejection Reason: [Reason for rejection as stated in the email]
         - Source Email: [Subject and Sender details]
      7. Recruiter / Hiring outreach formatting: When the user asks which recruiters contacted them, or asks about recruiter outreach, hiring-manager emails, direct job invitations, or who contacted them about jobs:

         CRITICAL DISTINCTION — Before answering, classify every retrieved Job / Recruitment email into one of two types:

         TYPE 1 — Direct Recruiter / Employer Outreach (this IS "recruiter contact"):
         • A human recruiter, hiring manager, staffing agency, or employer directly messaged the user
         • Contains a specific role invitation, interview request, application update, offer, or rejection
         • The email was sent specifically to the user, not as a mass blast or automated alert
         • The ACTUAL SENDER is the hiring company or a recruiter representing them (even if delivered via a platform like Naukri — "Coppergate via Naukri" counts as Coppergate outreach)
         • Examples: a staffing firm inviting the user to apply, a company scheduling an interview, an employer sending an offer or rejection

         TYPE 2 — Job Discovery / Recommendation (this is NOT "recruiter contact"):
         • Automated job recommendation alerts from job boards (Naukri Campus Jobs, LinkedIn, Unstop, Indeed, Internshala, etc.)
         • Weekly or daily job digest newsletters
         • Platform notifications about suggested job postings
         • Marketing or promotional emails about career opportunities (Udemy, Groww, career coaching, etc.)
         • Emails where the actual sender is the platform itself (LinkedIn notifications, Unstop newsletter, Naukri digest), not the hiring company

         THEN structure your answer in these plain-text sections (no markdown, no asterisks, no dashes for bullets — use "•" only):

         Summary: [How many Direct Recruiter Outreach (Type 1) emails were found in the requested time period]

         Direct Recruiter Outreach:
         [For each Type 1 email:]
         • [Company or Recruiter Name] — Recruiter Outreach
           Role: [specific role mentioned, if any]
           Date: [date of the email]
           Reason: [one sentence explaining why this is classified as direct recruiter contact]

         Excluded (Job Discovery / Recommendations):
         Do NOT list every excluded email individually. Instead, group them by source platform and give a single count per platform:
         • [Platform name] — [N] emails (automated job alerts / newsletters / notifications)
         Example: "• Unstop — 6 emails (automated job recommendation newsletter)"

         CRITICAL FALLBACK: If there are ZERO Type 1 emails among the retrieved contexts, respond with:
         "No direct recruiter or hiring-manager outreach was found in the selected time period."
         Then add ONE short paragraph (2-4 sentences max) summarizing what WAS found in aggregate — e.g., "The reviewed emails included LinkedIn notifications, Unstop job recommendation newsletters, and Naukri Campus job alerts. These are job-discovery and platform content, not direct recruiter contact." Do NOT enumerate every individual email. The user did not ask for that.

         ABSOLUTE RULE: Do NOT list newsletters, automated job alerts, platform notifications, or marketing emails as recruiter contact under any circumstances. Do NOT dump individual email subjects and dates unless the user explicitly asks to see the excluded emails.
      
      Retrieved Email Contexts:
      ${contextText || 'No relevant emails found.'}

      Chat History:
      ${historyText}

      User Query: "${query}"

      Answer:
    `;

    // The chat agent is the user-facing centerpiece, so it runs on a DIFFERENT model than the
    // bulk sync/classification/summarization jobs. Gemini's free-tier quota (500 req/day) is
    // enforced PER MODEL, so isolating chat onto its own model means heavy background processing
    // on gemini-3.1-flash-lite can't starve the chat of quota.
    const result = await callGeminiWithRetry(prompt, 'gemini-2.5-flash-lite');
    const answer = result.response.text().trim();

    // Parse out which emails were actually cited in the answer text.
    //
    // Robust matching is important here:
    //  - Empty subjects must NEVER count as a match. `answer.includes('')` is always true, which
    //    previously caused every empty-subject email to be falsely cited.
    //  - The model is instructed to write plain prose ("from PayPal on June 18..."), so it almost
    //    never echoes the full `"Name <email@host>"` string. Matching that whole string dropped
    //    real citations. We therefore also match the parsed sender display-name and bare email.
    const mentioned = (needle, minLen = 4) => {
      if (!needle) return false;
      const n = String(needle).trim();
      if (n.length < minLen) return false;
      return answer.includes(n);
    };

    const citedMessageIds = [];
    retrievedContexts.forEach((ctx) => {
      const fa = ctx.from_address || '';
      const nameMatch = fa.match(/^\s*"?([^"<]+?)"?\s*</);
      const senderName = nameMatch ? nameMatch[1].trim() : '';
      const emailMatch = fa.match(/<([^>]+)>/) || fa.match(/([^\s<>]+@[^\s<>]+)/);
      const senderEmail = emailMatch ? emailMatch[1].trim() : '';

      const cited =
        mentioned(ctx.subject) ||
        mentioned(senderName, 5) ||
        mentioned(senderEmail) ||
        (ctx.gmail_message_id && answer.includes(ctx.gmail_message_id));

      if (cited && !citedMessageIds.some((c) => c.id === ctx.gmail_message_id)) {
        citedMessageIds.push({
          id: ctx.gmail_message_id,
          sender: ctx.from_address,
          subject: ctx.subject,
          sent_at: ctx.sent_at,
          thread_id: ctx.gmail_thread_id
        });
      }
    });

    return { answer, sources: citedMessageIds };
  } catch (error) {
    console.error('Chat Agent Query Error:', error);
    throw new Error(`Chat agent failed: ${error.message}`);
  }
}
