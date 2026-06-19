# Architecture & Design Document — Gmail Intelligence Platform

This document describes the architectural choices, database schemas, AI RAG models, and data synchronization patterns implemented in the AI-powered Gmail Intelligence Platform.

---

## 1. System Architecture

The platform uses a monolithic full-stack Node.js layout with a clear separation of concerns between client and server layers.

*   **Frontend Client (React + Vite)**: A premium glassmorphic Single Page Application (SPA) designed in raw, responsive CSS. It communicates with the backend via REST endpoints. In production, it builds to static assets served directly by the Express server on port `3000`.
*   **Backend Server (Express)**: Exposes APIs for OAuth authentication, manual/automatic inbox synchronization, smart reply compositions, and agent chat querying. It orchestrates the background sync loops.
*   **Database & Vector Store (Supabase)**: An instance of PostgreSQL. It stores user credentials, headers, email text, thread structures, and HSL categories, and uses the `pgvector` extension to serve nearest-neighbor similarity searches for RAG.
*   **Generative AI (Google Gemini)**: The primary reasoning and generation engine. Sync-time summarization, categorization and reply drafting run on `gemini-3.1-flash-lite`; the user-facing chat agent runs on `gemini-2.5-flash-lite` (isolating chat onto its own model so heavy background processing can't starve it of per-model free-tier quota). It provides email summaries, thread timelines, threaded replies, and answers user questions by synthesizing database facts.
*   **Semantic Embeddings (NVIDIA NIM)**: The `nvidia/nv-embedqa-e5-v5` model is used via the NVIDIA NIM API to generate 1024-dimensional dense vectors for all synced email records.

```
+--------------------------------------------------------------+
|                        User's Browser                        |
|   (React Single Page Application - Glassmorphic Dashboard)   |
+------------------------------+-------------------------------+
                               |
                               | (HTTP / Credentials Sharing)
                               v
+--------------------------------------------------------------+
|                 Backend Server (Express:3000)                |
|  +------------------+ +------------------+ +---------------+  |
|  |   Auth Service   | |   Sync Manager   | |  AI RAG API   |  |
|  +------------------+ +------------------+ +---------------+  |
+---------+--------------------+-------------------+-----------+
          |                    |                   |
          | (OAuth Tokens)     | (SQL / pgvector)  | (Embeddings & Generation)
          v                    v                   v
+------------------+   +---------------+   +-------------------+
|  Gmail API (v1)  |   |   Supabase    |   | AI Models:        |
|  - Sync Inbox    |   |  PostgreSQL   |   | - Google Gemini   |
|  - Send Drafts   |   |   + pgvector  |   | - NVIDIA NIM API  |
+------------------+   +---------------+   +-------------------+
```

---

## 2. Database Schema

The database design implements a traditional normalized relational structure, extended with vector types.

```sql
-- Enable Vector Extension
create extension if not exists vector;

-- Profiles Table (Local user credentials and sync state)
create table public.profiles (
  id uuid default gen_random_uuid() primary key,
  email text unique not null,
  access_token text not null,
  refresh_token text not null,
  token_expiry timestamp with time zone not null,
  last_sync_at timestamp with time zone,
  sync_status text default 'idle', -- 'idle', 'syncing', 'completed', 'failed'
  sync_error text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Threads Table
create table public.threads (
  id uuid default gen_random_uuid() primary key,
  gmail_thread_id text not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  subject text,
  summary text,      -- Natural-language summary of the whole conversation arc
  ai_overview text,  -- Optional bulleted extraction layer (key facts/actions)
  category text, -- Newsletters, Job / Recruitment, Finance, Notifications, Personal, Work / Professional
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint unique_user_thread unique (user_id, gmail_thread_id)
);

-- Emails Table
create table public.emails (
  id uuid default gen_random_uuid() primary key,
  gmail_message_id text not null,
  gmail_thread_id text not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  subject text,
  from_address text not null,
  to_address text not null,
  cc_address text,
  bcc_address text,
  body_text text,
  body_html text,
  raw_html_content text,   -- Raw HTML body as received
  raw_text_content text,   -- Raw plain-text body as received
  clean_text_content text, -- Normalized plain text used for RAG retrieval and search
  summary text,      -- Natural-language summary of this individual email
  ai_overview text,  -- Optional bulleted extraction layer (key facts/actions)
  sent_at timestamp with time zone not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint unique_user_message unique (user_id, gmail_message_id)
);

-- Email Embeddings Table (pgvector 1024 dimensions)
create table public.email_embeddings (
  id uuid default gen_random_uuid() primary key,
  email_id uuid references public.emails(id) on delete cascade not null,
  gmail_message_id text not null,
  thread_id uuid references public.threads(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  embedding vector(1024) not null,
  content text not null, -- The text chunk embedded
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Chat Messages Table (Stores conversation history)
create table public.chat_messages (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb, -- Array of cited sources
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);
```

### Data Modeling Decisions & `pgvector` Usage
*   **Threads as a First-Class Citizen**: Emails in Gmail belong to conversations (threads). To provide a cohesive UX, the `threads` table stores overall subject lines, category classifications, and thread-level summaries. This allows the frontend to group messages organically.
*   **Vector Database Choice (`pgvector`)**: We leverage PostgreSQL's native `vector` extension. The table `email_embeddings` maps an embedding vector of size `1024` (matching the output dimensions of the `nvidia/nv-embedqa-e5-v5` model) directly to an email record.
*   **What is Embedded and Why**: We embed a composite text block: `Subject: ... \n From: ... \n Date: ... \n Content: [first 500 chars of the body]`. Embedding the metadata (sender and subject) alongside the body guarantees that queries referring to dates, people, or subjects (e.g., "what did Venkat send last week?") score highly in cosine similarity searches, correcting standard semantic retrieval failures.

---

## 3. AI Design

### Email & Thread Summarization Strategy
1.  **Individual Summaries**: As emails sync, Gemini constructs a 1-3 sentence natural-language summary plus an optional bulleted AI Overview (key facts/actions). Every email in the bounded sync window is summarized — there is no per-sync AI cap; if the Gemini API signals quota exhaustion mid-sync, the remaining emails degrade gracefully to a local heuristic (snippet + keyword classification) rather than failing the sync.
2.  **Thread Timelines**: For multi-message threads we load all messages sorted chronologically and Gemini summarizes the conversation arc — who said what, chronological progression, resolutions, and next steps. Single-message threads are skipped (the per-email summary already covers them and there is no arc to summarize).
3.  **Context and Chunking Strategy**: The models feature large (up to 1-million-token) context windows, which removes the need for complex RAG chunking for individual thread views. We pass the complete, raw thread history in full detail, avoiding information loss.

### Hybrid RAG & Search Pipeline
To query the emails, the chat endpoint implements a **Hybrid Search Pipeline**:
1.  **Vector Search**: The user query is converted into a 1024-dimensional vector using `nvidia/nv-embedqa-e5-v5`. A Postgres stored procedure (`match_email_embeddings`) matches it against the database using cosine distance, retrieving the top 8 matches.
2.  **Structured Keyword Search**: Vector retrieval occasionally misses exact matches for short keywords or brand names (e.g. "Acme Corp"). To combat this, if vector search returns insufficient results, we execute a backup SQL `LIKE` query matching key query nouns against `sender`, `subject`, and `body`.
3.  **Synthesis**: The merged list of emails is provided as context to Gemini 2.5 Flash to construct the final response.

### Source Clarity & Attribution
We prevent mixing information and ensure source transparency by implementing two safeguards:
*   **Attribution Prompts**: Gemini is explicitly instructed: *"You MUST state which email (Sender, Subject, and Date) the information came from. Use markdown links or bold headers to cite the source email. If the context does not contain the answer, say you cannot find it."*
*   **Post-processing Verification**: The backend parses the LLM's response, comparing its output against the metadata of the retrieved context. If any sender email, subject, or message ID is cited, we extract it and append a structured `sources` array to the JSON response. The React UI renders these as interactive badges; clicking a badge automatically opens that specific email thread in the inbox panel.

### NVIDIA NIM Model Selection
We chose **`nvidia/nv-embedqa-e5-v5`** as our secondary model. It is a state-of-the-art text retrieval model optimized for semantic search and RAG contexts. Serving it via the high-performance NVIDIA NIM inference endpoints guarantees low-latency vector creation during the inbox synchronization loops.

---

## 4. Gmail API Strategy

### Bounded Sync & De-duplication
*   **Bounded Window**: Each sync fetches the most recent `SYNC_LIMIT` emails (default `150`) via the Gmail `in:inbox` query with cursor pagination. We fetch message details in concurrent batches (batch size `5`, delayed by `300ms`). Bounding the window lets us run *every* fetched email through Gemini for a full-quality summary/category within free-tier quota, instead of capping AI to a handful per run.
*   **De-duplication on Re-sync**: Before fetching a message's full body we check whether its `gmail_message_id` already exists for the user; healthy existing rows are skipped, so a re-sync only spends Gmail/Gemini calls on genuinely new mail. `profiles.last_sync_at` is recorded on completion for status display. (Note: the current build narrows by DB existence checks rather than a Gmail `after:` query — a server-side `after:last_sync_at` filter is a straightforward future optimization.)

### Pagination & Rate Limiting
*   **Cursor Pagination**: We handle large inboxes using Google's `nextPageToken` cursor.
*   **Exponential Backoff**: Every API query is wrapped in an execution loop. If Gmail returns a `429` (Rate Limited) or `403` (User Rate Limit Exceeded), the sync manager catches the error, pauses, and retries with a randomized delay calculated as `backoffMs * 2^attempt`.

---

## 5. Tool & Technology Decisions

*   **Vite + React (Frontend)**: React is ideal for building dynamic dashboards. Vite provides instant hot-module replacement in dev, compiling down to a single optimized static bundle served by Express in production.
*   **Node.js + Express (Backend)**: Choosing Express provides full access to standard Node library ecosystems (like the official `@google/generative-ai` and `googleapis` packages) and keeps OAuth cookies simple without Next.js server-side caching complexities.
*   **Supabase (Database + pgvector)**: Out of the box, Supabase provides PostgreSQL, pre-bundled vector extensions, and an administrative UI. This avoids the need to maintain separate databases for SQL records and vector embeddings.

---

## 6. Trade-offs & Limitations

*   **No background queue workers (e.g. BullMQ / Redis)**: Since this is designed to be easily run locally by a reviewer without configuring Redis, we process background syncs in standard Node.js promise chains. For massive enterprise-scale operations, a Redis-backed queue is recommended to handle syncing states.
*   **Local Session Cookie**: The session is stored in an HTTP-only cookie containing the Supabase profile ID. In production, this would be signed and encrypted using JSON Web Tokens (JWT) or session stores for stronger security.
