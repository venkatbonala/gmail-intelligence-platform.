import React, { useState, useEffect, useRef } from 'react';
import { 
  Inbox, 
  MessageSquare, 
  Newspaper, 
  Send, 
  RefreshCw, 
  Sparkles, 
  Mail, 
  User, 
  ChevronRight, 
  ArrowLeft, 
  AlertCircle, 
  CheckCircle,
  FileText,
  LogOut,
  Paperclip
} from 'lucide-react';

// In production (single-service) the API is same-origin, so default to a relative
// "/api". For local dev the Vite proxy (vite.config.js) forwards /api to :3000.
// Override with VITE_API_BASE if the API is hosted on a different origin.
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const getCleanSummaryText = (summaryText) => {
  if (!summaryText) return '';
  try {
    let cleaned = summaryText.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim();
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim();
    }
    let data = JSON.parse(cleaned);
    if (data.threadSummary) {
      data = data.threadSummary;
    }
    const rawText = data.summary || data.purpose || summaryText;
    return rawText.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch (e) {
    return summaryText.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  }
};

const renderChatContent = (content) => {
  if (!content) return '';
  
  // 1. If it happens to look like JSON, try to parse and extract the human response
  try {
    let cleaned = content.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.replace(/^```json/, '').replace(/```$/, '').trim();
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```/, '').replace(/```$/, '').trim();
    }
    const data = JSON.parse(cleaned);
    if (data.answer) {
      content = data.answer;
    } else if (data.summary) {
      content = data.summary;
    } else if (data.response) {
      content = data.response;
    } else if (typeof data === 'string') {
      content = data;
    }
  } catch (e) {
    // Not JSON, keep as is
  }

  // 2. Clean up common markdown elements if they are still output by the model or exist in history
  let cleanText = content;
  
  // Convert markdown links [Text](Url) to "Text"
  cleanText = cleanText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '"$1"');
  
  // Remove markdown bolding (**)
  cleanText = cleanText.replace(/\*\*/g, '');
  
  // Remove markdown italic (*)
  cleanText = cleanText.replace(/\*/g, '');
  
  // Remove any backticks (`)
  cleanText = cleanText.replace(/`/g, '');
  
  return cleanText;
};

function App() {
  const [auth, setAuth] = useState({ authenticated: false, loading: true, user: null });
  const [activeTab, setActiveTab] = useState('inbox'); // 'inbox', 'chat', 'digest'
  const [selectedCategory, setSelectedCategory] = useState('All');
  
  // Threads & Messages
  const [threads, setThreads] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState(null);
  const [selectedThread, setSelectedThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsPage, setThreadsPage] = useState(1);
  const [totalThreads, setTotalThreads] = useState(0);
  const THREADS_PER_PAGE = 25;
  
  // Compose / Reply Drawer
  const [isComposing, setIsComposing] = useState(false);
  const [composerData, setComposerData] = useState({ to: '', subject: '', body: '', prompt: '', sending: false });
  const [replyPrompt, setReplyPrompt] = useState('');
  const [draftingReply, setDraftingReply] = useState(false);
  
  // Chat Agent
  const [chatMessages, setChatMessages] = useState([]);
  const [chatQuery, setChatQuery] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // Newsletter Deduplication
  const [digest, setDigest] = useState('');
  const [digestLoading, setDigestLoading] = useState(false);

  // Global Notification
  const [notification, setNotification] = useState(null);

  // Fetch Auth Status
  const checkAuthStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/status`, { credentials: 'include' });
      const data = await res.json();
      setAuth({ authenticated: data.authenticated, loading: false, user: data.user || null });
    } catch (err) {
      setAuth({ authenticated: false, loading: false, user: null });
    }
  };

  useEffect(() => {
    checkAuthStatus();
  }, []);

  // Poll sync status if user is syncing
  useEffect(() => {
    if (!auth.authenticated || !auth.user) return;
    
    let interval = null;
    if (auth.user.sync_status === 'syncing') {
      interval = setInterval(async () => {
        const res = await fetch(`${API_BASE}/auth/status`, { credentials: 'include' });
        const data = await res.json();
        if (data.authenticated && data.user) {
          setAuth(prev => ({ ...prev, user: data.user }));
          if (data.user.sync_status !== 'syncing') {
            showNotification('Sync finished!', 'success');
            setThreadsPage(1);
            fetchThreads(1);
            clearInterval(interval);
          }
        }
      }, 3000);
    }
    return () => clearInterval(interval);
  }, [auth.authenticated, auth.user?.sync_status]);

  // Reset page to 1 when category changes
  useEffect(() => {
    setThreadsPage(1);
  }, [selectedCategory]);

  // Fetch threads when active category changes or page changes
  useEffect(() => {
    if (auth.authenticated && activeTab === 'inbox') {
      fetchThreads(threadsPage);
    }
  }, [auth.authenticated, selectedCategory, activeTab, threadsPage]);

  // Scroll to bottom of chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, chatLoading]);

  const showNotification = (message, type = 'info') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  const loginWithGoogle = async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/google`);
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      showNotification('Failed to start login flow.', 'danger');
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, { credentials: 'include' });
      setAuth({ authenticated: false, loading: false, user: null });
      showNotification('Logged out successfully.', 'info');
    } catch (err) {
      showNotification('Logout failed.', 'danger');
    }
  };

  const triggerSync = async () => {
    try {
      const res = await fetch(`${API_BASE}/sync`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 150 }),
        credentials: 'include' 
      });
      const data = await res.json();
      if (data.success) {
        showNotification('Sync started in background...', 'info');
        setAuth(prev => ({
          ...prev,
          user: { ...prev.user, sync_status: 'syncing' }
        }));
      }
    } catch (err) {
      showNotification('Sync trigger failed.', 'danger');
    }
  };

  const fetchThreads = async (page = 1) => {
    setThreadsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/threads?category=${selectedCategory}&page=${page}&limit=${THREADS_PER_PAGE}`, { credentials: 'include' });
      const data = await res.json();
      setThreads(data.threads || []);
      setTotalThreads(data.total || 0);
    } catch (err) {
      showNotification('Failed to fetch inbox threads.', 'danger');
    } finally {
      setThreadsLoading(false);
    }
  };

  const selectThread = async (gmailThreadId) => {
    if (!gmailThreadId || gmailThreadId === 'undefined') {
      showNotification('Invalid thread ID.', 'danger');
      setSelectedThread(null);
      return;
    }
    setSelectedThreadId(gmailThreadId);
    setThreadLoading(true);
    try {
      const res = await fetch(`${API_BASE}/threads/${gmailThreadId}`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to load thread details');
      }
      setSelectedThread(data);
    } catch (err) {
      showNotification(err.message || 'Failed to load thread details.', 'danger');
      setSelectedThread(null);
    } finally {
      setThreadLoading(false);
    }
  };

  const handleDraftAIDraft = async () => {
    if (!composerData.prompt) return;
    setComposerData(prev => ({ ...prev, sending: true }));
    try {
      const res = await fetch(`${API_BASE}/messages/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: composerData.prompt }),
        credentials: 'include'
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Server error');
      }
      setComposerData(prev => ({
        ...prev,
        subject: data.subject,
        body: data.body,
        sending: false
      }));
      showNotification('AI Draft generated!', 'success');
    } catch (err) {
      showNotification(`AI drafting failed: ${err.message}`, 'danger');
      setComposerData(prev => ({ ...prev, sending: false }));
    }
  };

  const handleDraftReplyAIDraft = async () => {
    if (!replyPrompt || !selectedThread) return;
    setDraftingReply(true);
    try {
      const res = await fetch(`${API_BASE}/messages/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: replyPrompt, 
          gmailThreadId: selectedThread.thread.gmail_thread_id 
        }),
        credentials: 'include'
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Server error');
      }
      // Populate reply composer details
      setComposerData({
        to: selectedThread.messages[selectedThread.messages.length - 1].from_address,
        subject: data.subject,
        body: data.body,
        prompt: '',
        sending: false
      });
      setReplyPrompt('');
      setIsComposing(true); // Open compose view as a drawer loaded with the draft
      showNotification('AI Threaded Reply generated!', 'success');
    } catch (err) {
      showNotification(`AI reply drafting failed: ${err.message}`, 'danger');
    } finally {
      setDraftingReply(false);
    }
  };

  const handleSendEmail = async () => {
    if (!composerData.to || !composerData.subject || !composerData.body) {
      showNotification('Please fill in all email fields.', 'warning');
      return;
    }
    setComposerData(prev => ({ ...prev, sending: true }));
    try {
      const isReply = selectedThread && isComposing && composerData.subject.toLowerCase().includes('re:');
      
      const payload = {
        to: composerData.to,
        subject: composerData.subject,
        body: composerData.body,
        gmailThreadId: isReply ? selectedThread.thread.gmail_thread_id : null,
        replyToMessageId: isReply ? selectedThread.messages[selectedThread.messages.length - 1].gmail_message_id : null
      };

      const res = await fetch(`${API_BASE}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include'
      });
      const data = await res.json();
      if (data.success) {
        showNotification('Email sent successfully!', 'success');
        setIsComposing(false);
        setComposerData({ to: '', subject: '', body: '', prompt: '', sending: false });
        // Reload current thread if it was a reply
        if (isReply) {
          selectThread(selectedThread.thread.gmail_thread_id);
        }
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      showNotification(`Failed to send email: ${err.message}`, 'danger');
    } finally {
      setComposerData(prev => ({ ...prev, sending: false }));
    }
  };

  const handleSendChat = async (e) => {
    e?.preventDefault();
    if (!chatQuery.trim()) return;

    const userMsg = { role: 'user', content: chatQuery };
    setChatMessages(prev => [...prev, userMsg]);
    setChatQuery('');
    setChatLoading(true);

    // Abort the request if the server takes too long, so the UI never hangs indefinitely.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const history = chatMessages.map(m => ({ role: m.role, content: m.content }));

      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userMsg.content, history }),
        credentials: 'include',
        signal: controller.signal
      });

      const data = await res.json().catch(() => ({}));

      // Surface server-side errors (e.g. quota) as a readable assistant reply instead of a blank bubble.
      const content = data.answer
        || (res.ok ? null : data.error)
        || 'Sorry, I couldn\'t get a response. Please try again in a moment.';

      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content,
        sources: data.sources || []
      }]);

      if (!res.ok && !data.answer) {
        showNotification(data.error || 'Chat failed to respond.', 'danger');
      }
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? 'The assistant took too long to respond and the request timed out. Please try again.'
        : 'Chat failed to respond. Please check your connection and try again.';
      setChatMessages(prev => [...prev, { role: 'assistant', content: msg, sources: [] }]);
      showNotification(msg, 'danger');
    } finally {
      clearTimeout(timeoutId);
      setChatLoading(false);
    }
  };

  const fetchNewsletterDigest = async () => {
    setDigestLoading(true);
    setActiveTab('digest');
    try {
      const res = await fetch(`${API_BASE}/newsletter/digest`, { credentials: 'include' });
      const data = await res.json();
      setDigest(data.digest);
    } catch (err) {
      showNotification('Failed to generate newsletter digest.', 'danger');
    } finally {
      setDigestLoading(false);
    }
  };

  if (auth.loading) {
    return (
      <div className="auth-container">
        <div className="glass-panel auth-card" style={{ padding: '30px' }}>
          <RefreshCw className="syncing-spinner" style={{ color: 'var(--color-primary)', width: '40px', height: '40px' }} />
          <p style={{ marginTop: '16px', color: 'var(--text-secondary)' }}>Loading Gmail Intelligence...</p>
        </div>
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="auth-container">
        <div className="glass-panel auth-card">
          <div className="logo-icon" style={{ width: '48px', height: '48px', margin: '0 auto 24px auto' }}>
            <Sparkles style={{ width: '24px', height: '24px', color: 'white' }} />
          </div>
          <h1 className="auth-title">Repeatless Gmail</h1>
          <p className="auth-subtitle">
            Securely sync your inbox, auto-summarize threads, compile newsletter digests, and chat with your inbox using Google Gemini and NVIDIA NIM.
          </p>
          <button className="google-login-btn" onClick={loginWithGoogle}>
            <svg style={{ width: '18px', height: '18px' }} viewBox="0 0 24 24">
              <path fill="currentColor" d="M21.35,11.1H12v2.7h5.38c-0.24,1.28 -0.96,2.37 -2.04,3.1v2.58h3.3c1.93,-1.78 3.04,-4.4 3.04,-7.49C21.68,11.96 21.56,11.51 21.35,11.1z" />
              <path fill="currentColor" d="M12,20.7c2.62,0 4.82,-0.87 6.42,-2.37L15.12,15.75c-0.89,0.6 -2.02,0.96 -3.12,0.96c-2.4,0 -4.43,-1.63 -5.16,-3.81H3.45v2.66c1.62,3.23 4.97,5.43 8.55,5.43z" />
              <path fill="currentColor" d="M6.84,12.9c-0.18,-0.54 -0.29,-1.11 -0.29,-1.7c0,-0.59 0.11,-1.16 0.29,-1.7V6.84H3.45C2.82,8.1 2.46,9.51 2.46,11c0,1.49 0.36,2.9 0.99,4.16l3.39,-2.26z" />
              <path fill="currentColor" d="M12,5.29c1.42,0 2.7,0.49 3.71,1.45l2.78,-2.78C16.82,2.32 14.62,1.35 12,1.35C8.42,1.35 5.07,3.55 3.45,6.78l3.39,2.66C7.57,7.26 9.6,5.29 12,5.29z" />
            </svg>
            Connect Google Account
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Toast Notification */}
      {notification && (
        <div style={{
          position: 'fixed',
          top: '24px',
          right: '24px',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 20px',
          borderRadius: 'var(--radius-md)',
          background: notification.type === 'success' ? 'rgba(16, 185, 129, 0.95)' : 
                      notification.type === 'danger' ? 'rgba(239, 68, 68, 0.95)' : 'rgba(59, 130, 246, 0.95)',
          border: '1px solid rgba(255,255,255,0.1)',
          backdropFilter: 'blur(10px)',
          color: 'white',
          boxShadow: 'var(--shadow-premium)'
        }}>
          {notification.type === 'success' && <CheckCircle size={18} />}
          {notification.type === 'danger' && <AlertCircle size={18} />}
          <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>{notification.message}</span>
        </div>
      )}

      {/* Sidebar Navigation */}
      <aside className="glass-panel sidebar">
        <div>
          <div className="logo-container">
            <div className="logo-icon">
              <Sparkles size={18} color="white" />
            </div>
            <span className="logo-text">Repeatless AI</span>
          </div>

          <ul className="nav-menu">
            <li 
              className={`nav-item ${activeTab === 'inbox' ? 'active' : ''}`}
              onClick={() => { setActiveTab('inbox'); setSelectedThreadId(null); setSelectedThread(null); }}
            >
              <Inbox size={18} />
              Inbox Explorer
            </li>
            <li 
              className={`nav-item ${activeTab === 'chat' ? 'active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              <MessageSquare size={18} />
              AI Chat Agent
            </li>
            <li 
              className={`nav-item ${activeTab === 'digest' ? 'active' : ''}`}
              onClick={fetchNewsletterDigest}
            >
              <Newspaper size={18} />
              Newsletter Digest
            </li>
          </ul>
        </div>

        <div>
          <button 
            className="sync-btn" 
            onClick={() => { setIsComposing(true); setComposerData({ to: '', subject: '', body: '', prompt: '', sending: false }); }}
            style={{ width: '100%', marginBottom: '16px', background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))' }}
          >
            <Sparkles size={16} />
            Compose Draft
          </button>
          
          <div className="user-profile-widget" style={{ marginBottom: '10px' }}>
            <div className="avatar">
              {auth.user.email[0].toUpperCase()}
            </div>
            <div style={{ overflow: 'hidden' }}>
              <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {auth.user.email}
              </p>
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {auth.user.sync_status === 'syncing' ? 'Syncing...' : 'Connected'}
              </p>
            </div>
          </div>

          <button 
            onClick={handleLogout}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              width: '100%',
              padding: '10px',
              background: 'transparent',
              border: '1px solid var(--border-light)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '0.85rem'
            }}
          >
            <LogOut size={14} />
            Logout
          </button>
        </div>
      </aside>

      {/* Main Workspace Panel */}
      <main className="main-content">
        <header className="glass-panel top-header">
          <div className="header-title-container">
            {activeTab === 'inbox' && (
              <>
                <h1>Inbox Intelligence</h1>
                <p>Categorized threads and automated summary analytics</p>
              </>
            )}
            {activeTab === 'chat' && (
              <>
                <h1>AI Chat Console</h1>
                <p>Ask questions and perform cross-email reasoning with citations</p>
              </>
            )}
            {activeTab === 'digest' && (
              <>
                <h1>Newsletter Digest</h1>
                <p>Semantic deduplication of recent newsletter stories</p>
              </>
            )}
          </div>

          <div className="header-actions">
            <button 
              className="sync-btn" 
              onClick={triggerSync} 
              disabled={auth.user?.sync_status === 'syncing'}
              style={{ background: auth.user?.sync_status === 'syncing' ? 'var(--bg-active)' : 'var(--color-primary)' }}
            >
              <RefreshCw size={16} className={auth.user?.sync_status === 'syncing' ? 'syncing-spinner' : ''} />
              {auth.user?.sync_status === 'syncing' ? 'Syncing...' : 'Sync Inbox'}
            </button>
          </div>
        </header>

        {/* Dynamic View Swapper */}
        <section style={{ height: '100%', overflow: 'hidden' }}>
          
          {/* INBOX VIEW */}
          {activeTab === 'inbox' && (
            <div className="dashboard-grid">
              
              {/* Left Column: Thread Explorer List */}
              <div className="glass-panel threads-sidebar">
                {/* Horizontal scroll category filter */}
                <div style={{
                  display: 'flex',
                  gap: '6px',
                  padding: '16px',
                  borderBottom: '1px solid var(--border-light)',
                  overflowX: 'auto'
                }}>
                  {['All', 'Newsletters', 'Job / Recruitment', 'Finance', 'Notifications', 'Personal', 'Work / Professional'].map(cat => (
                    <button
                      key={cat}
                      onClick={() => setSelectedCategory(cat)}
                      style={{
                        padding: '6px 12px',
                        borderRadius: '9999px',
                        border: '1px solid var(--border-light)',
                        background: selectedCategory === cat ? 'var(--color-primary-glow)' : 'transparent',
                        color: selectedCategory === cat ? 'var(--color-primary)' : 'var(--text-secondary)',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        cursor: 'pointer'
                      }}
                    >
                      {cat === 'All' ? 'All Inbox' : cat}
                    </button>
                  ))}
                </div>

                <div className="threads-list">
                  {threadsLoading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
                      <RefreshCw className="syncing-spinner" style={{ color: 'var(--text-muted)' }} />
                    </div>
                  ) : threads.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
                      <Mail size={32} style={{ marginBottom: '12px' }} />
                      <p style={{ fontSize: '0.85rem' }}>No threads found.</p>
                    </div>
                  ) : (
                    threads.map(t => (
                      <div 
                        key={t.id} 
                        className={`glass-panel thread-list-item ${selectedThreadId === t.gmail_thread_id ? 'active' : ''}`}
                        onClick={() => selectThread(t.gmail_thread_id)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                          <span className={`badge badge-${t.category?.toLowerCase().replace(/ \/ /g, '-').replace(/\s+/g, '') || 'notifications'}`}>
                            {t.category || 'Notification'}
                          </span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            {new Date(t.updated_at).toLocaleDateString()}
                          </span>
                        </div>
                        <h4 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {t.subject || '(No Subject)'}
                        </h4>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                          {getCleanSummaryText(t.summary) || 'Fetching thread history summary...'}
                        </p>
                      </div>
                    ))
                  )}
                </div>

                {/* Sidebar Pagination Controls */}
                {totalThreads > THREADS_PER_PAGE && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '12px 16px',
                    borderTop: '1px solid var(--border-light)',
                    background: 'rgba(255, 255, 255, 0.02)',
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)'
                  }}>
                    <button
                      disabled={threadsPage === 1}
                      onClick={() => setThreadsPage(prev => Math.max(1, prev - 1))}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-light)',
                        background: threadsPage === 1 ? 'transparent' : 'rgba(255, 255, 255, 0.05)',
                        color: threadsPage === 1 ? 'var(--text-muted)' : 'var(--text-primary)',
                        cursor: threadsPage === 1 ? 'not-allowed' : 'pointer',
                        transition: 'var(--transition-smooth)',
                        fontWeight: 600
                      }}
                    >
                      Previous
                    </button>
                    <span>
                      Page <strong>{threadsPage}</strong> of <strong>{Math.ceil(totalThreads / THREADS_PER_PAGE)}</strong>
                    </span>
                    <button
                      disabled={threadsPage >= Math.ceil(totalThreads / THREADS_PER_PAGE)}
                      onClick={() => setThreadsPage(prev => prev + 1)}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--border-light)',
                        background: threadsPage >= Math.ceil(totalThreads / THREADS_PER_PAGE) ? 'transparent' : 'rgba(255, 255, 255, 0.05)',
                        color: threadsPage >= Math.ceil(totalThreads / THREADS_PER_PAGE) ? 'var(--text-muted)' : 'var(--text-primary)',
                        cursor: threadsPage >= Math.ceil(totalThreads / THREADS_PER_PAGE) ? 'not-allowed' : 'pointer',
                        transition: 'var(--transition-smooth)',
                        fontWeight: 600
                      }}
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>

              {/* Right Column: Detailed Reader and Thread Composer */}
              <div className="glass-panel details-pane">
                {threadLoading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <RefreshCw className="syncing-spinner" style={{ color: 'var(--color-primary)', width: '32px', height: '32px' }} />
                    <p style={{ marginTop: '12px', color: 'var(--text-secondary)' }}>Loading thread detail...</p>
                  </div>
                ) : !selectedThreadId ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                    <Sparkles size={40} style={{ marginBottom: '16px', color: 'var(--text-muted)' }} />
                    <h3>Select an email thread from the panel</h3>
                    <p style={{ fontSize: '0.85rem' }}>Automated summaries and actions will be shown here.</p>
                  </div>
                ) : (!selectedThread || !selectedThread.thread || !selectedThread.messages) ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                    <AlertCircle size={40} style={{ marginBottom: '16px', color: 'var(--text-muted)' }} />
                    <h3>Email not found</h3>
                    <p style={{ fontSize: '0.85rem' }}>The requested email thread could not be retrieved.</p>
                  </div>
                ) : (
                  <>
                    <div className="thread-header">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                        <h2 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                          {selectedThread.thread.subject || '(No Subject)'}
                        </h2>
                        <span className={`badge badge-${selectedThread.thread.category?.toLowerCase().replace(/ \/ /g, '-').replace(/\s+/g, '') || 'notifications'}`}>
                          {selectedThread.thread.category}
                        </span>
                      </div>

                      {/* Thread-level summary — only shown for multi-message threads, where a
                          conversation arc actually exists. Single emails rely on their own summary below. */}
                      {selectedThread.messages.length > 1 && selectedThread.thread.summary && (
                        <div style={{
                          background: 'rgba(138, 43, 226, 0.05)',
                          border: '1px solid rgba(138, 43, 226, 0.15)',
                          borderRadius: 'var(--radius-md)',
                          padding: '16px',
                          marginTop: '12px'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', color: 'var(--color-secondary)' }}>
                            <FileText size={16} />
                            <span style={{ fontSize: '0.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Thread Summary</span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 500 }}>
                              · {selectedThread.messages.length} messages
                            </span>
                          </div>
                          <p style={{ fontSize: '0.9rem', lineHeight: 1.6, color: 'var(--text-primary)', margin: 0 }}>
                            {getCleanSummaryText(selectedThread.thread.summary)}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="thread-messages-scroller">
                      {selectedThread.messages.map((msg, idx) => (
                        <div key={msg.id} className="message-card">
                          <div className="message-meta">
                            <div>
                              <strong style={{ color: 'var(--text-primary)' }}>{msg.from_address}</strong>
                              <span style={{ margin: '0 8px' }}>→</span>
                              <span>{msg.to_address}</span>
                            </div>
                            <span>{new Date(msg.sent_at).toLocaleString()}</span>
                          </div>

                          {/* Per-email natural-language summary */}
                          {msg.summary && (
                            <div style={{
                              background: 'rgba(96, 165, 250, 0.06)',
                              border: '1px solid rgba(96, 165, 250, 0.15)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '10px 12px',
                              margin: '8px 0 12px'
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', color: '#60a5fa' }}>
                                <Sparkles size={13} />
                                <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Summary</span>
                              </div>
                              <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: 'var(--text-secondary)', margin: 0 }}>
                                {getCleanSummaryText(msg.summary)}
                              </p>
                            </div>
                          )}

                          <div className="message-body" style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', lineHeight: 1.6 }}>
                            {msg.clean_text_content || msg.body_text}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Thread Context Aware Reply Drafting */}
                    <div className="action-composer">
                      <h4 style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <Sparkles size={14} style={{ color: 'var(--color-primary)' }} />
                        Smart Thread Reply Composer
                      </h4>
                      <div className="composer-input-row">
                        <textarea
                          className="composer-textarea"
                          placeholder="Tell the AI what to reply... (e.g. 'Politely decline their request and invite them to coffee next week')"
                          value={replyPrompt}
                          onChange={(e) => setReplyPrompt(e.target.value)}
                        />
                        <button 
                          className="chat-send-btn" 
                          onClick={handleDraftReplyAIDraft}
                          disabled={draftingReply}
                          style={{ alignSelf: 'flex-end', height: '80px', background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))' }}
                        >
                          {draftingReply ? <RefreshCw className="syncing-spinner" size={18} /> : <Sparkles size={18} />}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* AI CHAT VIEW */}
          {activeTab === 'chat' && (
            <div className="glass-panel chat-container">
              <div className="chat-messages-area">
                {chatMessages.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                    <Sparkles size={48} style={{ color: 'var(--color-secondary)', marginBottom: '16px' }} />
                    <h3>Conversational Mail Agent</h3>
                    <p style={{ fontSize: '0.85rem', maxWidth: '400px', textAlign: 'center', marginTop: '8px' }}>
                      I can query, search, and perform cross-email reasoning over your synced database.
                    </p>
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      marginTop: '24px',
                      width: '100%',
                      maxWidth: '400px'
                    }}>
                      {[
                        "Summarize all emails from Acme Corp",
                        "Which companies rejected my applications?",
                        "What is discussed about the data migration project?",
                        "Give me an overview of Kubernetes in my inbox"
                      ].map((q, i) => (
                        <button
                          key={i}
                          onClick={() => { setChatQuery(q); }}
                          style={{
                            padding: '10px 16px',
                            background: 'rgba(255,255,255,0.02)',
                            border: '1px solid var(--border-light)',
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--text-secondary)',
                            textAlign: 'left',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            transition: 'var(--transition-smooth)'
                          }}
                          onMouseEnter={(e) => { e.target.style.background = 'var(--bg-hover)'; e.target.style.color = 'var(--text-primary)'; }}
                          onMouseLeave={(e) => { e.target.style.background = 'rgba(255,255,255,0.02)'; e.target.style.color = 'var(--text-secondary)'; }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  chatMessages.map((msg, idx) => (
                    <div key={idx} className={`chat-bubble ${msg.role}`}>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{renderChatContent(msg.content)}</div>
                      
                      {/* CITED SOURCES BADGES */}
                      {msg.sources && msg.sources.length > 0 && (
                        <div className="sources-list">
                          {msg.sources.map((src, sIdx) => (
                            <div 
                              key={sIdx} 
                              className="source-badge"
                              onClick={() => {
                                setActiveTab('inbox');
                                selectThread(src.thread_id);
                              }}
                            >
                              <Mail size={12} />
                              <span>{src.sender.split('<')[0].trim()} - {src.subject.substring(0, 25)}...</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
                
                {chatLoading && (
                  <div className="chat-bubble assistant" style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <div className="syncing-spinner" style={{ marginRight: '6px' }}><Sparkles size={16} /></div>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Thinking and reasoning over emails...</span>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <form className="chat-input-area" onSubmit={handleSendChat}>
                <input
                  type="text"
                  className="chat-input"
                  placeholder="Ask a question about your emails..."
                  value={chatQuery}
                  onChange={(e) => setChatQuery(e.target.value)}
                  disabled={chatLoading}
                />
                <button type="submit" className="chat-send-btn" disabled={chatLoading}>
                  <Send size={18} />
                </button>
              </form>
            </div>
          )}

          {/* DEDUPLICATED DIGEST VIEW */}
          {activeTab === 'digest' && (
            <div className="glass-panel details-pane" style={{ overflowY: 'auto' }}>
              {digestLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <RefreshCw className="syncing-spinner" style={{ color: 'var(--color-primary)', width: '32px', height: '32px' }} />
                  <p style={{ marginTop: '12px', color: 'var(--text-secondary)' }}>Extracting newsletter news items and clustering duplicates...</p>
                </div>
              ) : !digest ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
                  <Newspaper size={40} style={{ marginBottom: '16px' }} />
                  <h3>No News Digest Loaded</h3>
                  <button onClick={fetchNewsletterDigest} className="sync-btn" style={{ marginTop: '16px' }}>
                    Compile Digest
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--color-primary)', marginBottom: '20px' }}>
                    <Sparkles size={20} />
                    <h3 style={{ textTransform: 'uppercase', fontSize: '0.9rem', letterSpacing: '0.5px' }}>Deduplicated News Compile (Last 4 Days)</h3>
                  </div>
                  <div 
                    style={{
                      background: 'rgba(255, 255, 255, 0.01)',
                      border: '1px solid var(--border-light)',
                      borderRadius: 'var(--radius-lg)',
                      padding: '24px',
                      lineHeight: 1.7,
                      fontSize: '0.95rem'
                    }}
                    className="markdown-body"
                  >
                    {digest.split('\n').map((line, idx) => {
                      if (line.startsWith('# ')) {
                        return <h1 key={idx} style={{ marginTop: '20px', marginBottom: '10px', fontFamily: 'var(--font-display)', fontSize: '1.4rem' }}>{line.replace('# ', '')}</h1>;
                      } else if (line.startsWith('## ')) {
                        return <h2 key={idx} style={{ marginTop: '18px', marginBottom: '8px', fontFamily: 'var(--font-display)', fontSize: '1.2rem', color: 'var(--color-primary)' }}>{line.replace('## ', '')}</h2>;
                      } else if (line.startsWith('### ')) {
                        return <h3 key={idx} style={{ marginTop: '14px', marginBottom: '6px', fontFamily: 'var(--font-body)', fontSize: '1.05rem', color: 'var(--text-primary)' }}>{line.replace('### ', '')}</h3>;
                      } else if (line.startsWith('- ') || line.startsWith('* ')) {
                        return <li key={idx} style={{ marginLeft: '20px', marginBottom: '4px', color: 'var(--text-secondary)' }}>{line.substring(2)}</li>;
                      } else if (line.trim() === '') {
                        return <div key={idx} style={{ height: '8px' }} />;
                      } else {
                        return <p key={idx} style={{ marginBottom: '8px', color: 'var(--text-secondary)' }}>{line}</p>;
                      }
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

        </section>
      </main>

      {/* FULL PANEL COMPOSE DRAWERS */}
      {isComposing && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
          zIndex: 999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <div className="glass-panel" style={{
            width: '600px',
            padding: '30px',
            position: 'relative'
          }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkles style={{ color: 'var(--color-secondary)' }} size={18} />
              AI Draft Composer
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Recipient (To)</label>
                <input 
                  type="email" 
                  className="chat-input"
                  style={{ width: '100%', padding: '10px' }}
                  value={composerData.to} 
                  onChange={(e) => setComposerData(prev => ({ ...prev, to: e.target.value }))}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Subject</label>
                <input 
                  type="text" 
                  className="chat-input"
                  style={{ width: '100%', padding: '10px' }}
                  value={composerData.subject} 
                  onChange={(e) => setComposerData(prev => ({ ...prev, subject: e.target.value }))}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>AI Composer Prompt</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input 
                    type="text" 
                    className="chat-input"
                    placeholder="Write a prompt for AI to construct the email..."
                    style={{ flex: 1, padding: '10px' }}
                    value={composerData.prompt}
                    onChange={(e) => setComposerData(prev => ({ ...prev, prompt: e.target.value }))}
                  />
                  <button 
                    onClick={handleDraftAIDraft} 
                    className="sync-btn"
                    style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-secondary))', flexShrink: 0 }}
                  >
                    Draft
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>Email Content (Editable)</label>
                <textarea 
                  className="composer-textarea"
                  style={{ width: '100%', height: '180px', padding: '12px', fontSize: '0.9rem' }}
                  value={composerData.body}
                  onChange={(e) => setComposerData(prev => ({ ...prev, body: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button 
                onClick={() => setIsComposing(false)}
                style={{
                  padding: '10px 16px',
                  background: 'transparent',
                  border: '1px solid var(--border-light)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '0.9rem'
                }}
              >
                Cancel
              </button>
              <button 
                onClick={handleSendEmail} 
                disabled={composerData.sending}
                className="sync-btn"
              >
                {composerData.sending ? <RefreshCw className="syncing-spinner" size={16} /> : <Send size={16} />}
                Send Email
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
