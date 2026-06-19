import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import apiRouter from './routes/api.js';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '../.env', override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { mode: 'manual' } }
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Trust the platform's TLS-terminating proxy (Railway/Render) so Express treats forwarded HTTPS
// requests as secure — required for Secure cookies to be honored behind the proxy.
app.set('trust proxy', 1);

// Setup CORS: Allow local development (Vite 5173, Express 3000) and production APP_URL
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  process.env.APP_URL
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://localhost:')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true
  })
);

// Standard Middlewares
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Mount API routes
app.use('/api', apiRouter);

// Basic health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Serve static assets from frontend build
app.use(express.static(path.join(__dirname, '../../frontend/dist')));

// Fallback all other routes to React SPA index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
});

// Reset any stuck syncing status
async function resetStuckSyncing() {
  try {
    const { error } = await supabase
      .from('profiles')
      .update({ sync_status: 'failed', sync_error: 'Sync was interrupted by server restart.' })
      .eq('sync_status', 'syncing');
    if (error) {
      console.error('Failed to reset stuck syncing profiles:', error);
    } else {
      console.log('Successfully reset any stuck syncing profiles.');
    }
  } catch (err) {
    console.error('Error resetting stuck syncing profiles:', err);
  }
}

// Fix existing threads updated_at ordering
async function fixExistingThreadsOrdering() {
  try {
    const { data: threads, error: threadsError } = await supabase
      .from('threads')
      .select('id, gmail_thread_id');
    
    if (threadsError) {
      console.error('Error fetching threads to fix ordering:', threadsError);
      return;
    }

    console.log(`Checking/fixing ordering for ${threads.length} threads...`);

    let updatedCount = 0;
    for (const thread of threads) {
      // Find the latest email for this thread
      const { data: latestEmail, error: emailError } = await supabase
        .from('emails')
        .select('sent_at')
        .eq('gmail_thread_id', thread.gmail_thread_id)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (emailError) {
        console.error(`Error fetching latest email for thread ${thread.id}:`, emailError);
        continue;
      }

      if (latestEmail && latestEmail.sent_at) {
        const { error: updateError } = await supabase
          .from('threads')
          .update({ updated_at: latestEmail.sent_at })
          .eq('id', thread.id);

        if (updateError) {
          console.error(`Error updating thread ${thread.id} updated_at:`, updateError);
        } else {
          updatedCount++;
        }
      }
    }

    console.log(`Successfully updated order timestamps for ${updatedCount} threads.`);
  } catch (err) {
    console.error('Error in fixExistingThreadsOrdering:', err);
  }
}

// Start Server and startup routines
app.listen(port, async () => {
  console.log(`========================================`);
  console.log(`  GMAIL INTELLIGENCE SERVER STARTED    `);
  console.log(`  Running on: http://localhost:${port}  `);
  console.log(`========================================`);
  
  // Run startup routines
  await resetStuckSyncing();
  await fixExistingThreadsOrdering();
});

