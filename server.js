const express = require('express');
const session = require('express-session');
const http = require('http');
const WebSocket = require('ws');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const rateLimit = require('express-rate-limit');
const MemoryStore = require('memorystore')(session);

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ quiet: true });
}

// Import security middleware
const securityMiddleware = require('./security');

function validateConfig() {
  if (process.env.OIDC_ENABLED === 'true') {
    const required = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(`OIDC_ENABLED=true but missing required env vars: ${missing.join(', ')}`);
    }
  }
  if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.includes('change-this'))) {
    throw new Error('SESSION_SECRET must be set to a strong value in production');
  }
}

function buildSessionStore() {
  if (!process.env.REDIS_URL) {
    return new MemoryStore({ checkPeriod: 24 * 60 * 60 * 1000 });
  }
  try {
    // Optional dependency path
    const { RedisStore } = require('connect-redis');
    const { createClient } = require('redis');
    const redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.connect().catch((err) => console.error('Redis connect failed, falling back to MemoryStore:', err.message));
    console.log('Using Redis session store');
    return new RedisStore({ client: redisClient, prefix: 'miso-chat:' });
  } catch (err) {
    console.warn(`REDIS_URL set but Redis store init failed (${err.message}); using MemoryStore fallback`);
    return new MemoryStore({ checkPeriod: 24 * 60 * 60 * 1000 });
  }
}

validateConfig();

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Apply security middleware
securityMiddleware.forEach(middleware => app.use(middleware));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);


// Middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public', { index: false }));

// Session config
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  store: buildSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.SESSION_SAMESITE || 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
});
app.use(sessionMiddleware);

// Passport initialization
app.use(passport.initialize());
app.use(passport.session());

// Serialize/deserialize user
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
      if (valid) {
        return done(null, { username });
      }
      return done(null, false, { message: 'Invalid credentials' });
    }
  ));
} else {
  // OIDC Strategy
  const providerBase = process.env.OIDC_PROVIDER_URL
    ? process.env.OIDC_PROVIDER_URL.replace('/.well-known/openid-configuration', '')
    : null;
  const oidcIssuer = process.env.OIDC_EXPECTED_ISSUER || (providerBase ? `${providerBase}/` : process.env.OIDC_ISSUER);
  const publicIssuer = process.env.OIDC_ISSUER;
  passport.use('oidc', new (require('passport-openidconnect').Strategy)({
    issuer: oidcIssuer,
    authorizationURL: process.env.OIDC_AUTH_URL || (publicIssuer + '/application/o/authorize/'),
    tokenURL: process.env.OIDC_TOKEN_URL || (publicIssuer + '/application/o/token/'),
    userInfoURL: process.env.OIDC_USERINFO_URL || (publicIssuer + '/application/o/userinfo/'),
    clientID: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    callbackURL: process.env.OIDC_CALLBACK_URL || '/auth/oidc/callback',
    scope: ['profile', 'email']
  },
  (issuer, profile, done) => {
    return done(null, {
      username: profile.displayName || profile.username,
      email: profile.emails?.[0]?.value
    });
  }
  ));
}

// Auth middleware
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/login');
};

// Login page
app.get('/login', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.redirect('/');
  }

  // When OIDC is enabled, send users to SSO unless we're returning with an error.
  if (process.env.OIDC_ENABLED === 'true') {
    if (req.query?.error) {
      const reason = req.query.reason ? ` (${req.query.reason})` : '';
      return res.status(401).send(`OIDC login failed: ${req.query.error}${reason}. Check client ID, secret, and callback URL.`);
    }
    return res.redirect('/auth/oidc');
  }

  res.sendFile(__dirname + '/public/login.html');
});

// Login handler (local auth)
app.post('/login', 
  passport.authenticate('local', { 
    successRedirect: '/',
    failureRedirect: '/login?error=invalid'
  })
);

// OIDC auth routes
app.get('/auth/oidc', passport.authenticate('oidc'));

app.get('/auth/oidc/callback', (req, res, next) => {
  passport.authenticate('oidc', (err, user, info) => {
    if (err) {
      const reason = encodeURIComponent(err.message || 'auth_error');
      console.error('OIDC callback error:', err.message || err);
      return res.redirect(`/login?error=oidc_failed&reason=${reason}`);
    }
    if (!user) {
      const reason = encodeURIComponent(info?.message || 'no_user');
      console.error('OIDC callback rejected user:', info || 'no info');
      return res.redirect(`/login?error=oidc_failed&reason=${reason}`);
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        const reason = encodeURIComponent(loginErr.message || 'login_error');
        console.error('OIDC login session error:', loginErr.message || loginErr);
        return res.redirect(`/login?error=oidc_failed&reason=${reason}`);
      }
      return res.redirect('/');
    });
  })(req, res, next);
});

// Logout
app.post('/logout', (req, res) => {
  req.logout(() => {
    if (process.env.OIDC_ENABLED === 'true' && process.env.OIDC_ISSUER) {
      const logoutUrl = process.env.OIDC_ISSUER + '/logout/';
      return res.redirect(logoutUrl + '?next=' + encodeURIComponent(req.protocol + '://' + req.get('host') + '/login'));
    }
    res.redirect('/login');
  });
});

// Chat page (protected)
app.get('/', isAuthenticated, (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// API: Check auth status
app.get('/api/auth', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ 
    authenticated: req.isAuthenticated(), 
    user: req.user,
    oidc: process.env.OIDC_ENABLED === 'true'
  });
});

// API: Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// WebSocket upgrade handling (require authenticated session)
server.on('upgrade', (request, socket, head) => {
  sessionMiddleware(request, {}, () => {
    passport.initialize()(request, {}, () => {
      passport.session()(request, {}, () => {
        if (!request.isAuthenticated || !request.isAuthenticated()) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      });
    });
  });
});

// Gateway bridge via /tools/invoke (sessions_send)
const https = require('https');

const GATEWAY_RAW_URL = process.env.GATEWAY_URL || 'http://openclaw.llm.svc.cluster.local:18789';
const GATEWAY_HTTP_URL = GATEWAY_RAW_URL.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
const GATEWAY_TOKEN = process.env.GATEWAY_AUTH_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN || '';
const GATEWAY_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || process.env.MISO_CHAT_SESSION_KEY || 'agent:main:main';
const SEND_TIMEOUT_SECONDS = Number(process.env.SEND_TIMEOUT_SECONDS || 180);

function gatewayInvoke(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tool, args });
    const url = new URL('/tools/invoke', GATEWAY_HTTP_URL);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.ok) return resolve(json.result);
            return reject(new Error(json.error?.message || `Gateway invoke failed (${res.statusCode})`));
          } catch {
            return reject(new Error(`Invalid gateway response: ${String(data).slice(0, 200)}`));
          }
        });
      }
    );

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
  if (Array.isArray(reply)) return reply.map((r) => extractReplyText(r)).filter(Boolean).join('\n');
  if (typeof reply?.text === 'string') return reply.text;
  if (typeof reply?.message === 'string') return reply.message;
  if (typeof reply?.content === 'string') return reply.content;
  if (Array.isArray(reply?.content)) return reply.content.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).join('\n').trim();
  return '';
}

async function sendSessionMessage(message) {
  const result = await gatewayInvoke('sessions_send', {
    sessionKey: GATEWAY_SESSION_KEY,
    message,
    timeoutSeconds: SEND_TIMEOUT_SECONDS,
  });

  const payload = unwrapToolResult(result);
  const status = payload?.status;
  if (status && status !== 'ok' && status !== 'accepted') {
    throw new Error(payload?.error || `sessions_send returned status=${status}`);
  }

  const replyText = extractReplyText(payload?.reply || payload?.response || payload?.details?.reply);
  if (replyText) return replyText;

  if (status === 'accepted') {
    return 'Message accepted.';
  }

  if (payload?.error) throw new Error(payload.error);
  return '';
}

// Handle browser WebSocket connections
wss.on('connection', (ws) => {
  console.log('Client connected');

  const pendingMessages = [];
  let processing = false;

  const safeSend = (payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const processQueue = async () => {
    if (processing || pendingMessages.length === 0 || ws.readyState !== WebSocket.OPEN) return;

    processing = true;
    const msg = pendingMessages.shift();

    safeSend({ type: 'queue', pending: pendingMessages.length });
    safeSend({ type: 'typing', show: true });

    try {
      const reply = await sendSessionMessage(msg);
      if (reply) {
        safeSend({ content: reply });
      } else {
        safeSend({ error: 'No reply content returned.' });
      }
    } catch (err) {
      safeSend({ error: `Send failed: ${err.message}` });
    } finally {
      safeSend({ type: 'typing', show: false });
      processing = false;
      setImmediate(processQueue);
    }
  };

  if (!GATEWAY_TOKEN) {
    safeSend({ type: 'status', connected: false });
    safeSend({ error: 'Gateway auth token is missing.' });
  } else {
    safeSend({ type: 'status', connected: true });
  }

  ws.on('message', (message) => {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      return;
    }

    if (payload?.type !== 'message' || typeof payload?.content !== 'string') return;

    const msg = payload.content.trim();
    if (!msg) return;

    pendingMessages.push(msg);
    if (pendingMessages.length > 1 || processing) {
      safeSend({ type: 'queue', pending: pendingMessages.length });
    }

    processQueue();
  });

  ws.on('close', () => {
    pendingMessages.length = 0;
    console.log('Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('Client websocket error:', err.message);
  });
});

function start() {
  const PORT = process.env.PORT || 3000;
  return server.listen(PORT, () => {
    console.log(`
🎉 OpenClaw Chat Server running on port ${PORT}
   
   Gateway: ${GATEWAY_HTTP_URL}
   Session key: ${GATEWAY_SESSION_KEY}
   Auth: ${process.env.OIDC_ENABLED === 'true' ? 'OIDC' : 'Local'}
   Node Env: ${process.env.NODE_ENV || 'development'}
   
   Login at: http://localhost:${PORT}/login
  `);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, server, start, validateConfig };
