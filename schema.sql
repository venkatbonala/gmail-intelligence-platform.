-- Clean up any old conflicting tables and constraints from previous setups
drop table if exists public.email_embeddings cascade;
drop table if exists public.emails cascade;
drop table if exists public.threads cascade;
drop table if exists public.chat_messages cascade;
drop table if exists public.profiles cascade;

-- Enable pgvector extension
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
  summary text,      -- Natural-language summary of the whole conversation arc (assignment requirement)
  ai_overview text,  -- Optional complementary extraction layer: key facts/actions as bullet points
  category text, -- Newsletters, Job / Recruitment, Finance, Notifications, Personal, Work / Professional
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint unique_user_thread unique (user_id, gmail_thread_id)
);

create index idx_threads_category on public.threads(user_id, category);
create index idx_threads_gmail_thread_id on public.threads(gmail_thread_id);

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
  raw_html_content text,   -- Raw HTML body as received from Gmail
  raw_text_content text,   -- Raw plain-text body as received from Gmail
  clean_text_content text, -- Normalized/cleaned plain text used for RAG retrieval and search
  summary text,      -- Natural-language summary of this individual email (assignment requirement)
  ai_overview text,  -- Optional complementary extraction layer: key facts/actions as bullet points
  sent_at timestamp with time zone not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint unique_user_message unique (user_id, gmail_message_id)
);

create index idx_emails_thread_id on public.emails(gmail_thread_id);
create index idx_emails_sent_at on public.emails(sent_at desc);
create index idx_emails_gmail_message_id on public.emails(gmail_message_id);

-- Email Embeddings Table (pgvector 1024 dimensions for nvidia/nv-embedqa-e5-v5)
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

create index idx_embeddings_user_id on public.email_embeddings(user_id);

-- Chat Messages Table
create table public.chat_messages (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  sources jsonb, -- Array of sources used for the response
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index idx_chat_messages_user_id on public.chat_messages(user_id);

-- Cosine Similarity Matching Function
create or replace function match_email_embeddings (
  query_embedding vector(1024),
  match_threshold float,
  match_count int,
  p_user_id uuid
)
returns table (
  id uuid,
  email_id uuid,
  gmail_message_id text,
  thread_id uuid,
  content text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    ee.id,
    ee.email_id,
    ee.gmail_message_id,
    ee.thread_id,
    ee.content,
    1 - (ee.embedding <=> query_embedding) as similarity
  from public.email_embeddings ee
  where ee.user_id = p_user_id
    and 1 - (ee.embedding <=> query_embedding) > match_threshold
  order by ee.embedding <=> query_embedding
  limit match_count;
end;
$$;
