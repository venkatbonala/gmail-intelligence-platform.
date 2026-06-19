# Gmail Intelligence Platform

An AI-powered Gmail automation and dashboard platform that securely syncs your email inbox, automatically generates thread-level timelines, classifies categories, creates deduplicated newsletter digests, and provides a RAG chat console with citation source attribution.

Built with **Google Gemini** (`gemini-3.1-flash-lite` for sync-time summarization/classification, `gemini-2.5-flash-lite` for the chat agent), **NVIDIA NIM** embeddings, **Supabase (PostgreSQL + pgvector)**, **Express**, and **React**.

---

## Folder Structure

```
├── backend/                  # Node.js Express Backend
│   ├── src/
│   │   ├── routes/
│   │   │   └── api.js        # Auth, Sync, Drafting, and Chat endpoints
│   │   ├── services/
│   │   │   ├── ai.js         # Google Gemini & NVIDIA NIM integrations
│   │   │   └── gmail.js      # Gmail sync pipelines & rate limit handlers
│   │   └── server.js         # Bootstrap server file
│   └── package.json
│
├── frontend/                 # React Single Page Application (Vite)
│   ├── src/
│   │   ├── App.jsx           # Core dashboard layout, chat agent, and composers
│   │   ├── index.css         # Glassmorphic design system styling
│   │   └── main.jsx
│   └── package.json
│
├── schema.sql                # Supabase PostgreSQL database schemas
├── Architecture.md           # Deep-dive system design document
└── .env.example              # Template for environment configurations
```

---

## Prerequisites

Ensure you have the following installed and set up:
1. **Node.js** (v22 or higher — Node 22 ships native WebSocket, which the Supabase client requires)
2. **NPM** (v9 or higher)
3. A **Supabase** account (Free tier is perfectly fine)
4. A **Google Cloud Developer Console** project

---

## Step 1: Database Setup (Supabase)

1. Create a new project in [Supabase](https://supabase.com/).
2. Navigate to the **SQL Editor** from the left-hand menu.
3. Open a new query tab and copy the contents of the `schema.sql` file in this repository.
4. Click **Run** to execute the script. This installs the `pgvector` extension and creates all the necessary tables, indexes, and cosine-similarity matching functions.

---

## Step 2: Google Cloud Console setup (Gmail API)

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project and search for the **Gmail API** in the library, then click **Enable**.
3. Set up the **OAuth Consent Screen**:
   - Select **External** user type.
   - Enter standard app information.
   - In the **Scopes** section, add the following scopes:
     - `https://www.googleapis.com/auth/gmail.readonly`
     - `https://www.googleapis.com/auth/gmail.compose`
     - `https://www.googleapis.com/auth/gmail.send`
     - `https://www.googleapis.com/auth/gmail.labels`
     - `https://www.googleapis.com/auth/userinfo.email`
   - **IMPORTANT**: In the **Test Users** section, add the Google email address you intend to login with. Since the app is in "Testing" status, only added test users can authorize.
4. Create **Credentials**:
   - Go to the **Credentials** tab, click **Create Credentials**, and select **OAuth client ID**.
   - Select **Web application** as the application type.
   - Under **Authorized redirect URIs**, add exactly:
     `http://localhost:3000/api/auth/callback/google`
   - Click **Create** and copy your **Client ID** and **Client Secret**.

---

## Step 3: Local Environment Setup

Create a `.env` file in the root directory and paste your credentials (matching the format in `.env.example`):

```sh
# Copy template
cp .env.example .env
```

Open `.env` and fill in the values:
*   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Your Google OAuth client credentials.
*   `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`: Found in Supabase project dashboard > Settings > API.
*   `GEMINI_API_KEY`: Your key from Google AI Studio.
*   `NVIDIA_NIM_API_KEY`: Your key from NVIDIA Build dashboard (for embeddings).

---

## Step 4: Installation & Running

Follow these steps to compile the application and launch the server:

### 1. Install Dependencies
Run this in the root of the workspace to install dependencies in both the backend and frontend folders:

```bash
# Install backend dependencies
cd backend && npm install

# Install frontend dependencies
cd ../frontend && npm install
```

### 2. Build the Frontend
Compile the React code into static production assets:

```bash
cd ../frontend
npm run build
```

This compiles the React files and puts them in `frontend/dist`. The Express backend is configured to automatically serve these compiled assets.

### 3. Start the Server
Start the Express server on port `3000`:

```bash
cd ../backend
npm start
```

Now, navigate to **`http://localhost:3000`** in your browser!

---

## Development Mode (Hot-Reloading)

If you wish to make changes and have them hot-reload instantly, you can run the backend and frontend separately in parallel:

1. In the `backend` folder, run:
   ```bash
   npm run dev
   ```
   This starts the API server on `http://localhost:3000` with nodemon.

2. In the `frontend` folder, run:
   ```bash
   npm run dev
   ```
   This starts Vite's dev server on `http://localhost:5173`. You can visit `http://localhost:5173` to test live UI edits.

---

## Quick Commands (from repo root)

A root `package.json` orchestrates both workspaces so platforms (and you) can build with one command:

```bash
npm run install:all   # installs backend + frontend dependencies
npm run build         # installs deps + builds the frontend into frontend/dist
npm start             # starts the Express server (serves API + built frontend)
```

---

## Production Deployment (Single Service — Railway / Render)

This app deploys as **one service**: the Express backend serves both the JSON API (`/api/*`) and the compiled React SPA from `frontend/dist`. There is no separate frontend host, so there are no cross-origin or cross-site-cookie concerns — the same domain serves everything.

### Build & start commands

| Setting        | Value                                  |
| -------------- | -------------------------------------- |
| Root directory | repository root (the folder with this README) |
| Build command  | `npm run build`                        |
| Start command  | `npm start`                            |
| Node version   | **22+** (enforced via `engines` in root `package.json` and `.nvmrc`; Node 22 ships native WebSocket, required by the Supabase client) |
| Health check   | `GET /health` → `{ "status": "ok" }`   |

The platform injects a `PORT` env var automatically; the server binds to it (`process.env.PORT`).

### Steps

1. Push this repository to GitHub (see the submission checklist below — never commit `.env`).
2. Create a new project on **Railway** (deploy from GitHub repo) or a new **Web Service** on **Render**.
3. Set the build/start commands and Node version per the table above.
4. Add **all environment variables** from the table in the "Environment Variables" section below.
5. Set `APP_URL` and `GOOGLE_REDIRECT_URI` to your **public service URL** (you get this after the first deploy — see "After You Click Deploy" below).
6. Deploy. Then update Google OAuth + Supabase as described next.

### After you click Deploy

1. Copy the public URL the platform assigns (e.g. `https://your-app.up.railway.app` or `https://your-app.onrender.com`).
2. In the service env vars, set:
   - `APP_URL = https://your-app.up.railway.app`
   - `GOOGLE_REDIRECT_URI = https://your-app.up.railway.app/api/auth/callback/google`
   - Then redeploy so the new values take effect.
3. In **Google Cloud Console → Credentials → your OAuth client → Authorized redirect URIs**, add the exact production callback URL:
   `https://your-app.up.railway.app/api/auth/callback/google`
   (Keep the localhost one too if you still develop locally.)
4. In **Supabase**, no network change is needed (the service role key bypasses RLS server-side), but confirm `schema.sql` has been run on the project.
5. Visit your public URL, click **Login with Google**, and authorize with a Google account that is listed as a **Test User** on your OAuth consent screen.

### Environment Variables

| Variable                        | Required | Notes |
| ------------------------------- | -------- | ----- |
| `GOOGLE_CLIENT_ID`              | ✅       | Google Cloud OAuth client ID |
| `GOOGLE_CLIENT_SECRET`          | ✅       | Google Cloud OAuth client secret |
| `GOOGLE_REDIRECT_URI`           | ✅       | Must exactly match an Authorized redirect URI in Google Cloud. Production: `https://<your-domain>/api/auth/callback/google` |
| `NEXT_PUBLIC_SUPABASE_URL`      | ✅       | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY`     | ✅       | Server-side key; bypasses RLS. **Secret — never expose to the browser.** |
| `GEMINI_API_KEY`                | ✅       | Google AI Studio key (summarization, classification, chat) |
| `NVIDIA_NIM_API_KEY`            | ✅       | NVIDIA Build key (embeddings for RAG) |
| `NVIDIA_NIM_BASE_URL`           | ✅       | `https://integrate.api.nvidia.com/v1` (no fallback in code) |
| `APP_URL`                       | ✅       | Public base URL; used for the post-login redirect and CORS. Production: `https://<your-domain>` |
| `NVIDIA_NIM_EMBED_MODEL`        | ⬜       | Defaults to `nvidia/nv-embedqa-e5-v5` if unset |
| `PORT`                          | ⬜       | Injected by the platform; defaults to `3000` locally |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ⬜       | Present in `.env.example` but **not used by the backend** in this single-service setup |

---

## Key Features

1. **Bounded Full-Quality Sync**: Each sync fetches the most recent window of emails (default 150, set by `SYNC_LIMIT`) and runs **every** email through Gemini for a natural-language summary, a category, and an AI overview, then generates NVIDIA NIM embeddings. Multi-message threads additionally get a conversation-arc summary. Bounding the window keeps the entire synced inbox at full AI quality within free-tier Gemini quotas. Re-syncs skip emails already stored (matched by `gmail_message_id`), so only new mail is processed. Raise `SYNC_LIMIT` if you have higher Gemini quota.
2. **Context-Aware Composer**: Let the AI compose new emails from scratch or write threaded replies that automatically inject `In-Reply-To` and `References` headers, preserving Gmail thread structures.
3. **Conversational Mail Agent**: The RAG chat agent lets you ask questions (e.g., "Summarize emails from Acme Corp this month"). It pulls emails using semantic and structured matches, cites source badges, and allows you to click on any source to open the corresponding thread in your inbox.
4. **Newsletter Digest Compiler**: Automatically retrieves newsletters from the past 4 days and compiles a deduplicated, clustered summary of news stories.
