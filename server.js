const express = require('express');
const session = require('express-session');
const http = require('http');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const rateLimit = require('express-rate-limit');
const https = require('https');
require('dotenv').config();

const securityMiddleware = require('./security');

const app = express();
const server = http.createServer(app);

// Trust proxy for rate limiting behind Envoy
app.set('trust proxy', 1);

// Apply security middleware
securityMiddleware.forEach(middleware => app.use(middleware));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  proxyTrust: true
});
app.use('/api/', limiter);

// Middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
// Protect direct access to index file
app.use((req, res, next) => {
  if (req.path === '/index.html' && !req.isAuthenticated?.()) {
    return res.redirect('/login');
  }
  next();
});

// Serve static assets, but do NOT auto-serve /index.html at root (keeps auth gate on /)
app.use(express.static('public', { index: false }));

// Session config
const oidcEnabled = process.env.OIDC_ENABLED === 'true';
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    // OIDC auth redirects are cross-site; Strict drops session cookie on callback and causes loops.
    sameSite: oidcEnabled ? 'lax' : 'strict',
    maxAge: 24 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);

// Passport initialization
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Local Auth Strategy
if (process.env.OIDC_ENABLED !== 'true') {
  const localUsers = (process.env.LOCAL_USERS || 'admin:password123').split(',');
  const validUsers = localUsers.map(u => {
    const [user, pass] = u.split(':');
    return { user: user.trim(), pass: pass.trim() };
  });

  passport.use(new LocalStrategy(
    (username, password, done) => {
      const valid = validUsers.find(u => u.user === username && u.pass === password);
      if (valid) return done(null, { username });
      return done(null, false, { message: 'Invalid credentials' });
    }
  ));
} else {
  const providerUrl = (process.env.OIDC_PROVIDER_URL || '').trim();
  const providerIssuer = providerUrl
    ? providerUrl.replace(/\/\.well-known\/openid-configuration\/?$/, '/')
    : '';

  const issuer = providerIssuer || process.env.OIDC_ISSUER;

  // Authentik-compatible defaults (works with app-specific provider URL)
  const oidcOrigin = (() => {
    try {
      return new URL(process.env.OIDC_ISSUER || issuer).origin;
    } catch {
      return process.env.OIDC_ISSUER || issuer;
    }
  })();

  const authorizationURL =
    process.env.OIDC_AUTHORIZATION_URL || `${oidcOrigin}/application/o/authorize/`;
  const tokenURL = process.env.OIDC_TOKEN_URL || `${oidcOrigin}/application/o/token/`;
  const userInfoURL =
    process.env.OIDC_USERINFO_URL || `${oidcOrigin}/application/o/userinfo/`;

  passport.use('oidc', new (require('passport-openidconnect').Strategy)({
    issuer,
    authorizationURL,
    tokenURL,
    userInfoURL,
    clientID: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    callbackURL: process.env.OIDC_CALLBACK_URL || '/auth/oidc/callback',
    scope: ['openid', 'profile', 'email']
  },
  (issuer, profile, done) => {
    return done(null, { username: profile.displayName || profile.username, email: profile.emails?.[0]?.value });
  }
  ));
}

const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
};

// Login
app.get('/login', (req, res) => {
  if (process.env.OIDC_ENABLED === 'true') {
    return res.redirect('/auth/oidc');
  }
  return res.sendFile(__dirname + '/public/login.html');
});

app.post('/login', (req, res, next) => {
  if (process.env.OIDC_ENABLED === 'true') {
    return res.redirect('/auth/oidc');
  }
  return passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login?error=invalid',
  })(req, res, next);
});
app.get('/auth/oidc', passport.authenticate('oidc'));
app.get('/auth/oidc/callback', passport.authenticate('oidc', { successRedirect: '/', failureRedirect: '/login?error=oidc_failed' }));
app.post('/logout', (req, res) => {
  req.logout((logoutErr) => {
    if (logoutErr) {
      console.error('Logout error:', logoutErr.message || logoutErr);
    }

    req.session?.destroy(() => {
      res.clearCookie('connect.sid');
      if (process.env.OIDC_ENABLED === 'true' && process.env.OIDC_ISSUER) {
        return res.redirect(
          process.env.OIDC_ISSUER + '/logout/?next=' + encodeURIComponent(req.protocol + '://' + req.get('host') + '/login')
        );
      }
      return res.redirect('/login');
    });
  });
});

// Protected routes
app.get('/', isAuthenticated, (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/api/auth', (req, res) => res.json({ authenticated: req.isAuthenticated(), user: req.user, oidc: process.env.OIDC_ENABLED === 'true' }));
app.get('/api/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() }));

const CHAT_DISPLAY_NAME = process.env.CHAT_DISPLAY_NAME || process.env.ASSISTANT_NAME || 'Miso';
const APP_TITLE = process.env.APP_TITLE || `${CHAT_DISPLAY_NAME} Chat`;
const DEFAULT_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || process.env.MISO_CHAT_SESSION_KEY || 'agent:main:main';

app.get('/api/config', isAuthenticated, (req, res) => {
  res.json({
    title: APP_TITLE,
    assistantName: CHAT_DISPLAY_NAME,
    defaultSessionKey: DEFAULT_SESSION_KEY,
  });
});

// ============ GATEWAY HTTP API ============

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://openclaw.llm.svc.cluster.local:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.GATEWAY_AUTH_TOKEN || '';

// Helper to call gateway via HTTP
function gatewayInvoke(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tool, args });
    const url = new URL('/tools/invoke', GATEWAY_URL);
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${GATEWAY_TOKEN}`
      }
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) return resolve(json.result);
          return reject(new Error(json.error?.message || 'Gateway invoke failed'));
        } catch {
          return reject(new Error(`Invalid gateway response: ${String(data).slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function unwrapToolResult(result) {
  if (!result) return {};
  if (result.details && typeof result.details === 'object') return result.details;
  const text = result?.content?.find?.((x) => x?.type === 'text')?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return result;
}

function extractReplyText(reply) {
  if (!reply) return '';
  if (typeof reply === 'string') return reply;
  if (Array.isArray(reply)) {
    return reply.map((x) => extractReplyText(x)).filter(Boolean).join('\n');
  }
  if (typeof reply.text === 'string') return reply.text;
  if (typeof reply.message === 'string') return reply.message;
  if (typeof reply.content === 'string') return reply.content;
  if (Array.isArray(reply.content)) {
    return reply.content
      .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const ANNOUNCE_NOISE_MARKERS = ['ANNOUNCE_SKIP', 'Agent-to-agent announce step.'];

function isAnnounceNoiseLine(line) {
  const value = (line || '').trim();
  if (!value) return false;
  return ANNOUNCE_NOISE_MARKERS.some((marker) =>
    marker === 'ANNOUNCE_SKIP' ? value.includes(marker) : value === marker
  );
}

function sanitizeAssistantText(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) return '';

  const cleaned = value
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !isAnnounceNoiseLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

// GET /api/sessions - List all sessions via gateway
app.get('/api/sessions', isAuthenticated, async (req, res) => {
  try {
    const result = await gatewayInvoke('sessions_list', {
      limit: 50,
      includeLastMessage: true,
      includeDerivedTitles: true,
    });
    const payload = unwrapToolResult(result);
    const sessions = (payload?.sessions || []).map((s) => ({
      sessionKey: s.key || s.sessionKey || s.sessionId,
      displayName: s.displayName || s.key || s.sessionKey,
      updatedAt: s.updatedAt,
      kind: s.kind,
      channel: s.channel,
      lastMessage: s.lastMessage,
      title: s.derivedTitle || s.title,
    }));

    const deduped = [];
    const seen = new Set();
    for (const s of sessions) {
      if (!s?.sessionKey || seen.has(s.sessionKey)) continue;
      seen.add(s.sessionKey);
      deduped.push(s);
    }

    res.json({ sessions: deduped, defaultSessionKey: DEFAULT_SESSION_KEY });
  } catch (error) {
    console.error('Error listing sessions:', error.message);
    res.json({ sessions: [], error: error.message });
  }
});

// GET /api/sessions/:sessionKey/history - Get session history via gateway
app.get('/api/sessions/:sessionKey/history', isAuthenticated, async (req, res) => {
  try {
    const { sessionKey } = req.params;
    const result = await gatewayInvoke('sessions_history', { sessionKey, limit: 100 });
    const payload = unwrapToolResult(result);
    const raw = payload?.history || payload?.messages || [];
    const messages = raw
      .map((m) => {
        const role = m.role || 'assistant';
        const content =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
                  .filter(Boolean)
                  .join('\n')
              : m.content?.text || m.text || JSON.stringify(m.content || '');

        return {
          role,
          content: role === 'assistant' ? sanitizeAssistantText(content) : content,
          timestamp: m.timestamp,
        };
      })
      .filter((m) => typeof m.content === 'string' && m.content.trim().length > 0);
    res.json({ sessionKey, messages });
  } catch (error) {
    console.error('Error getting history:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sessions/:sessionKey/send - Send message via gateway
app.post('/api/sessions/:sessionKey/send', isAuthenticated, async (req, res) => {
  try {
    const requestedSessionKey = req.params.sessionKey;
    const sessionKey = requestedSessionKey && requestedSessionKey !== 'default'
      ? requestedSessionKey
      : DEFAULT_SESSION_KEY;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log(`Sending to ${sessionKey}:`, message);

    // Use sessions_send via gateway tools API (requires gateway.tools.allow override)
    const result = await gatewayInvoke('sessions_send', {
      sessionKey,
      message,
      timeoutSeconds: Number(process.env.SEND_TIMEOUT_SECONDS || 180),
    });

    const payload = unwrapToolResult(result);
    const responseText = extractReplyText(payload?.reply || payload?.response || payload?.details?.reply);
    const filteredResponseText = sanitizeAssistantText(responseText);

    res.json({ success: true, response: payload, responseText: filteredResponseText });
  } catch (error) {
    console.error('Error sending:', error.message);
    const msg = String(error.message || 'send failed');
    if (msg.includes('Tool not available')) {
      return res.status(500).json({
        error:
          'sessions_send is blocked by gateway.tools deny list. Add gateway.tools.allow: ["sessions_send"] in OpenClaw config.',
      });
    }
    res.status(500).json({ error: msg });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
🎉 ${APP_TITLE} server running on port ${PORT}
   
   Gateway: ${GATEWAY_URL}
   Default Session: ${DEFAULT_SESSION_KEY}
   Auth: ${process.env.OIDC_ENABLED === 'true' ? 'OIDC' : 'Local'}
   Node Env: ${process.env.NODE_ENV || 'development'}
   
   Login: http://localhost:${PORT}/login
   
   API:
   - GET  /api/sessions
   - GET  /api/sessions/:key/history
   - POST /api/sessions/:key/send
  `);
});
