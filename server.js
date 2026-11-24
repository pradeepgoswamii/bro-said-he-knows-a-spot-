const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const nodemailer = require('nodemailer');
const { MongoClient, GridFSBucket } = require('mongodb');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { gzipSync, gunzipSync } = require('zlib');
const { AsyncLocalStorage } = require('async_hooks');

// Load local configuration without requiring a runtime dependency. Environment
// variables already provided by the host take precedence over .env values.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) return;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  });
}
// Persistent secret used to sign session tokens. Generate it once on first run.
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  try {
    fs.appendFileSync(envFile, `\nSESSION_SECRET="${process.env.SESSION_SECRET}"\n`, 'utf8');
  } catch (err) {
    console.warn('Could not persist SESSION_SECRET to .env:', err.message);
  }
}
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

if (process.env.MONGODB_DNS_SERVERS) {
  const dnsServers = process.env.MONGODB_DNS_SERVERS.split(',').map(server => server.trim()).filter(Boolean);
  if (dnsServers.length) dns.setServers(dnsServers);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(__dirname));

// Every API mutation is persisted to MongoDB before its response is sent.
const requestPersistence = new AsyncLocalStorage();
app.use((req, res, next) => {
  const context = { writes: [] };
  const sendJson = res.json.bind(res);
  res.json = payload => {
    if (!context.writes.length) return sendJson(payload);
    return Promise.all(context.writes).then(() => sendJson(payload)).catch(err => {
      console.error('MongoDB write failed:', err.message);
      if (res.headersSent) return res;
      res.statusCode = 503;
      return sendJson({ error: 'MongoDB could not save this change. Please retry.' });
    });
  };
  requestPersistence.run(context, next);
});

// ---------- Signed session tokens ----------
function issueSessionToken(user) {
  const payload = {
    uid: String(user.id),
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function readSessionToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match) return null;
  const [body, signature] = match[1].split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.uid || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

// Attach the authenticated user (if any) and make identity-derived fields
// authoritative. Clients can no longer act as another user by sending IDs.
app.use('/api', (req, res, next) => {
  const session = readSessionToken(req);
  if (session && dbCache) {
    const user = (dbCache.users || []).find(u => String(u.id) === session.uid);
    if (user) req.authUser = user;
  }
  if (req.authUser) {
    const u = req.authUser;
    // Personalised reads must reflect the token owner, not a query-string ID.
    // Express exposes `query` as a getter, so replace it with a fixed object.
    const safeQuery = { ...req.query };
    if (Object.prototype.hasOwnProperty.call(safeQuery, 'user_id')) {
      safeQuery.user_id = u.id;
    }
    Object.defineProperty(req, 'query', { value: safeQuery, writable: true, configurable: true });
    req.body = req.body || {};
    req.body.user_id = u.id;
    req.body.username = u.username;
    req.body.from_user_id = u.id;
    req.body.from_username = u.username;
    req.body.follower_id = u.id;
    req.body.reporter_id = u.id;
    req.body.id = u.id;
    if (Object.prototype.hasOwnProperty.call(req.body, 'is_verified_pro')) {
      req.body.is_verified_pro = !!u.is_verified_pro;
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.authUser) {
    return res.status(401).json({ error: 'Please log in to continue.' });
  }
  next();
}

// Mutations always need a session except for auth, public analytics and SOS.
const AUTH_FREE_PATHS = [/^\/auth\/(signup|signup\/verify|login)$/, /^\/dashboard\//, /^\/ai-planner$/, /^\/sos\/trigger$/];
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (AUTH_FREE_PATHS.some(pattern => pattern.test(req.path))) return next();
  return requireAuth(req, res, next);
});

// Chrome DevTools probe and Favicon handlers to eliminate 404 & CSP errors
app.all('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval'; connect-src *;");
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.status(200).json({});
});

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

const pendingSignups = new Map();
const signupSendLimits = new Map();
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_WAIT_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
let mongoClient = null;
let mongoDb = null;
let mongoBucket = null;
let dbCache = null;
let lastPersistedDb = null;
let persistenceQueue = Promise.resolve();

function emptyDatabase() {
  return {
    users: [], posts: [], comments: [], likes: [], follows: [], businesses: [],
    stories: [], saves: [], comment_likes: [], messages: [], reports: [],
    story_views: [], notification_reads: [], sos_alerts: []
  };
}

function streamToBuffer(readStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readStream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    readStream.on('error', reject);
    readStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function persistSnapshot(snapshot) {
  const state = mongoDb.collection('app_state');
  const previous = await state.findOne({ _id: 'primary' });
  const fileName = `app-state-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json.gz`;
  const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot)));
  const upload = mongoBucket.openUploadStream(fileName, {
    metadata: { contentType: 'application/gzip', purpose: 'application-state' }
  });
  await pipeline(Readable.from([compressed]), upload);
  await state.updateOne(
    { _id: 'primary' },
    { $set: { fileId: upload.id, updatedAt: new Date() } },
    { upsert: true }
  );
  if (previous?.fileId) {
    try { await mongoBucket.delete(previous.fileId); }
    catch (err) { console.warn('Old MongoDB snapshot cleanup skipped:', err.message); }
  }
}

async function connectMongoStore() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required. Add it to the local .env file; local JSON storage is disabled.');
  mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, appName: 'KnowASpot' });
  await mongoClient.connect();
  mongoDb = mongoClient.db(process.env.MONGODB_DB_NAME || undefined);
  await mongoDb.command({ ping: 1 });
  mongoBucket = new GridFSBucket(mongoDb, { bucketName: 'app_state_files' });

  const state = await mongoDb.collection('app_state').findOne({ _id: 'primary' });
  if (state?.fileId) {
    const compressed = await streamToBuffer(mongoBucket.openDownloadStream(state.fileId));
    dbCache = JSON.parse(gunzipSync(compressed).toString('utf8'));
  } else {
    dbCache = emptyDatabase();
    await persistSnapshot(dbCache);
  }
  lastPersistedDb = structuredClone(dbCache);
}

function readDB() {
  if (!dbCache) throw new Error('MongoDB storage has not finished connecting.');
  return structuredClone(dbCache);
}

function writeDB(data) {
  if (!mongoDb) throw new Error('MongoDB storage is unavailable.');
  const snapshot = structuredClone(data);
  dbCache = snapshot;
  const task = persistenceQueue.catch(() => undefined).then(async () => {
    await persistSnapshot(snapshot);
    lastPersistedDb = structuredClone(snapshot);
  }).catch(err => {
    if (dbCache === snapshot) dbCache = structuredClone(lastPersistedDb);
    throw err;
  });
  persistenceQueue = task;
  const context = requestPersistence.getStore();
  if (context) context.writes.push(task);
  return task;
}

// ---------- Shared helpers ----------
function ensureCollection(db, key) {
  if (!Array.isArray(db[key])) db[key] = [];
  return db[key];
}

function avatarFor(seed) {
  const words = String(seed || 'traveler').trim().replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || 'T').slice(0, 2)).replace(/[^a-z0-9]/gi, '').toUpperCase() || 'T';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="#2a3027"/><text x="48" y="56" text-anchor="middle" font-family="Arial,sans-serif" font-size="30" fill="#d2a35c">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function findUserByUsername(db, username) {
  if (!username) return null;
  const q = String(username).toLowerCase();
  return (db.users || []).find(u => (u.username || '').toLowerCase() === q) || null;
}

function findUserById(db, id) {
  if (id === undefined || id === null || id === '') return null;
  return (db.users || []).find(u => String(u.id) === String(id)) || null;
}

// A location that is only a map URL has no place name, so it is not a destination.
function cleanLocationName(loc) {
  if (!loc) return '';
  if (/^https?:\/\//i.test(loc)) return '';
  return String(loc).replace(/^📍\s*/, '').trim();
}

function extractHashtags(text) {
  if (!text) return [];
  const matches = String(text).match(/#[\p{L}\p{N}_]+/gu) || [];
  return matches.map(m => m.slice(1)).filter(Boolean);
}

function publicUser(user, db) {
  if (!user) return null;
  const follows = db.follows || [];
  const posts = db.posts || [];
  return {
    id: user.id,
    username: user.username,
    name: user.name || user.username,
    avatar: user.avatar || avatarFor(user.username),
    bio: user.bio || '',
    vibes: user.vibes || [],
    role: user.role || 'normal',
    is_verified_pro: !!user.is_verified_pro,
    posts_count: posts.filter(p => p.username === user.username).length,
    followers_count: follows.filter(f => f.following_username === user.username).length
  };
}

// AI Content Integrity Engine
const aiIntegrity = require('./aiIntegrityService');

// Auth Routes. An account is persisted only after its email address is verified.
async function sendSignupOtp(email, code) {
  const gmailUser = String(process.env.GMAIL_USER || '').trim();
  const gmailAppPassword = String(process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
  const text = `Your verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`;
  const html = `<div style="font-family:Arial,sans-serif;color:#17211b;max-width:520px;margin:auto;padding:28px"><p style="letter-spacing:.16em;text-transform:uppercase;color:#98703a;font-size:12px">Know a Spot</p><h1 style="font-size:24px">Verify your email</h1><p>Enter this code to finish creating your account:</p><p style="font-size:32px;font-weight:700;letter-spacing:.35em;padding:16px 0">${code}</p><p style="color:#667066">This code expires in 10 minutes. If you did not request it, ignore this email.</p></div>`;

  if (gmailUser || gmailAppPassword) {
    if (!gmailUser || !gmailAppPassword) {
      const err = new Error('Set both GMAIL_USER and GMAIL_APP_PASSWORD in .env to send signup codes through Gmail.');
      err.statusCode = 503;
      throw err;
    }
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailAppPassword }
    });
    try {
      await transporter.sendMail({
        from: { name: 'Know a Spot', address: gmailUser },
        to: email,
        subject: 'Your Know a Spot verification code',
        text,
        html
      });
    } catch (err) {
      if (err.code === 'EAUTH') {
        const smtpDetail = String(err.response || '').replace(/\s+/g, ' ').slice(0, 180);
        err.providerReason = smtpDetail
          ? `Gmail SMTP authentication failed (${err.responseCode || 'EAUTH'}): ${smtpDetail}`
          : 'Gmail rejected the credentials. Use a Google App Password, not your regular account password.';
      }
      throw err;
    }
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    const err = new Error('Signup email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env, then restart the server.');
    err.statusCode = 503;
    throw err;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: 'Your Know a Spot verification code',
      text,
      html
    })
  });

  if (!response.ok) {
    const providerError = await response.json().catch(() => ({}));
    const err = new Error('The verification email could not be sent. Check the email provider settings.');
    err.providerReason = providerError.message || providerError.error || providerError.name || `Resend returned HTTP ${response.status}`;
    err.statusCode = 502;
    throw err;
  }
}

function signupConflict(db, username, email) {
  return db.users.some(u =>
    ((u.username || '').toLowerCase() === username.toLowerCase() ||
      (u.email || '').toLowerCase() === email.toLowerCase()) &&
    !((u.email || '').toLowerCase() === email.toLowerCase() &&
      (u.username || '').toLowerCase() === username.toLowerCase() &&
      u.email_verified !== true)
  );
}

function findPendingLegacySignup(db, username, email) {
  return db.users.find(u =>
    (u.email || '').toLowerCase() === email.toLowerCase() &&
    (u.username || '').toLowerCase() === username.toLowerCase() &&
    u.email_verified !== true
  ) || null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('hex')}$${derived.toString('hex')}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  const [scheme, saltHex, hashHex] = String(storedHash || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return Promise.resolve(false);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, expected.length, (err, derived) => {
      if (err) return reject(err);
      resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
    });
  });
}

app.post('/api/auth/signup', async (req, res) => {
  const { name, username, email, password, role, avatar, bio, vibes } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanUsername = String(username || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanName || !cleanUsername || !cleanEmail || !password) {
    return res.status(400).json({ error: 'Name, username, email, and password are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const db = readDB();
  if (signupConflict(db, cleanUsername, cleanEmail)) {
    return res.status(409).json({ error: 'Username or email already exists.' });
  }

  const existing = pendingSignups.get(cleanEmail);
  if (existing && Date.now() - existing.sentAt < OTP_RESEND_WAIT_MS) {
    return res.status(429).json({ error: 'A code was just sent. Check your inbox or wait one minute before requesting another.' });
  }
  const sendWindow = signupSendLimits.get(cleanEmail) || { startedAt: Date.now(), count: 0 };
  if (Date.now() - sendWindow.startedAt > 60 * 60 * 1000) {
    sendWindow.startedAt = Date.now();
    sendWindow.count = 0;
  }
  if (sendWindow.count >= 5) {
    return res.status(429).json({ error: 'Too many code requests. Try again in an hour.' });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    await sendSignupOtp(cleanEmail, code);
  } catch (err) {
    console.error('Signup verification email failed:', err.providerReason || err.message);
    const isResendTestRecipientLimit = /only send testing emails to your own email address/i.test(err.providerReason || '');
    const message = isResendTestRecipientLimit
      ? 'Resend is still using its test sender, which can only deliver to the email address on the Resend account. Verify a sending domain and set RESEND_FROM_EMAIL to an address on that domain, then try again.'
      : err.code === 'EAUTH'
        ? 'Gmail rejected the credentials. Use a Google App Password, not your regular account password.'
        : err.message;
    return res.status(err.statusCode || 502).json({ error: message });
  }

  sendWindow.count++;
  signupSendLimits.set(cleanEmail, sendWindow);
  pendingSignups.set(cleanEmail, {
    user: {
      name: cleanName,
      username: cleanUsername,
      email: cleanEmail,
      password: String(password),
      avatar: avatar || avatarFor(cleanUsername),
      bio: bio || '',
      vibes: Array.isArray(vibes) ? vibes : [],
      role: role === 'professional' ? 'professional' : 'normal'
    },
    codeHash: crypto.createHash('sha256').update(`${cleanEmail}:${code}`).digest('hex'),
    expiresAt: Date.now() + OTP_TTL_MS,
    sentAt: Date.now(),
    attempts: 0
  });
  res.json({ status: 'verification_sent', email: cleanEmail, expires_in_seconds: OTP_TTL_MS / 1000 });
});

app.post('/api/auth/signup/verify', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const pending = pendingSignups.get(email);
  if (!pending) return res.status(400).json({ error: 'Request a new verification code to continue.' });
  if (Date.now() > pending.expiresAt) {
    pendingSignups.delete(email);
    return res.status(400).json({ error: 'That code expired. Request a new one.' });
  }
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the six-digit code from your email.' });
  pending.attempts++;
  const submittedHash = crypto.createHash('sha256').update(`${email}:${code}`).digest();
  const expectedHash = Buffer.from(pending.codeHash, 'hex');
  if (pending.attempts > OTP_MAX_ATTEMPTS) {
    pendingSignups.delete(email);
    return res.status(429).json({ error: 'Too many incorrect codes. Request a new one.' });
  }
  if (submittedHash.length !== expectedHash.length || !crypto.timingSafeEqual(submittedHash, expectedHash)) {
    return res.status(400).json({ error: 'That code is not correct. Check the email and try again.' });
  }

  const db = readDB();
  if (signupConflict(db, pending.user.username, email)) {
    pendingSignups.delete(email);
    return res.status(409).json({ error: 'Username or email already exists.' });
  }
  const passwordHash = await hashPassword(pending.user.password);
  let newUser = findPendingLegacySignup(db, pending.user.username, email);
  if (newUser) {
    Object.assign(newUser, pending.user, {
      password: passwordHash,
      email_verified: true,
      email_verified_at: new Date().toISOString()
    });
  } else {
    newUser = {
      id: Date.now(),
      ...pending.user,
      password: passwordHash,
      is_verified_pro: false,
      email_verified: true,
      email_verified_at: new Date().toISOString(),
      aadhaar_hash: null,
      followers_count: 0,
      created_at: new Date().toISOString()
    };
    db.users.push(newUser);
  }
  writeDB(db);
  pendingSignups.delete(email);
  res.json({
    id: newUser.id,
    name: newUser.name,
    username: newUser.username,
    email: newUser.email,
    avatar: newUser.avatar,
    bio: newUser.bio,
    vibes: newUser.vibes,
    role: newUser.role,
    is_verified_pro: newUser.is_verified_pro,
    email_verified: true,
    token: issueSessionToken(newUser)
  });
});

app.post('/api/auth/verify-professional', (req, res) => {
  const { user_id, username, aadhaar_no, face_scan_verified } = req.body || {};
  if (!user_id || !aadhaar_no || !face_scan_verified) {
    return res.status(400).json({ error: 'Valid Aadhaar number, Face Scan completion and a user session are required' });
  }

  const cleanAadhaar = String(aadhaar_no).replace(/\s+/g, '').trim();
  if (!/^\d{12}$/.test(cleanAadhaar)) {
    return res.status(400).json({ error: 'Aadhaar number must be a valid 12-digit number' });
  }
  const aadhaarHash = crypto.createHash('sha256').update(cleanAadhaar).digest('hex');

  const db = readDB();
  const targetUsername = (username || '').trim().toLowerCase();

  // Strict 1 Professional Account per Aadhaar enforcement. Only the account id
  // decides ownership, so a supplied username cannot bypass the check.
  const existingAadhaarOwner = db.users.find(u =>
    String(u.id) !== String(user_id) &&
    (u.aadhaar_hash === aadhaarHash || (u.aadhaar_no && u.aadhaar_no === cleanAadhaar))
  );
  if (existingAadhaarOwner) {
    return res.status(400).json({
      error: `Security Policy Violation: This Aadhaar number is already linked to professional account (@${existingAadhaarOwner.username}). Each user is restricted to 1 Professional Account.`
    });
  }

  const user = db.users.find(u => String(u.id) === String(user_id));
  if (!user) {
    return res.status(404).json({ error: 'User not found. Please log in or register before verifying.' });
  }
  if (targetUsername && (!user.username || user.username.toLowerCase() !== targetUsername)) {
    return res.status(403).json({ error: 'User session does not match the supplied username.' });
  }

  user.role = 'professional';
  user.is_verified_pro = true;
  user.aadhaar_hash = aadhaarHash;
  delete user.aadhaar_no;
  user.face_scan_verified = true;
  user.verified_at = new Date().toISOString();

  writeDB(db);

  const updatedUser = {
    id: user.id,
    name: user.name || user.username,
    username: user.username,
    email: user.email,
    avatar: user.avatar || avatarFor(user.username),
    bio: user.bio || '',
    vibes: user.vibes || [],
    role: 'professional',
    is_verified_pro: true
  };

  res.json({
    status: 'verified',
    username: user.username,
    role: 'professional',
    is_verified_pro: true,
    badge: '☑️ Verified Pro Creator',
    token: issueSessionToken(user),
    user: updatedUser
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const db = readDB();

  const cleanInput = (username || '').trim().toLowerCase();
  const user = db.users.find(u =>
    (u.username && u.username.toLowerCase() === cleanInput) ||
    (u.email && u.email.toLowerCase() === cleanInput)
  );
  if (!user || !await verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  res.json({
    id: user.id,
    name: user.name || user.username,
    username: user.username,
    email: user.email,
    avatar: user.avatar || avatarFor(user.username),
    bio: user.bio || '',
    vibes: user.vibes || [],
    role: user.role || 'normal',
    is_verified_pro: !!user.is_verified_pro,
    token: issueSessionToken(user)
  });
});

// Posts Routes with AI Alteration & Promotion Analysis
app.post('/api/posts', (req, res) => {
  const p = req.body || {};
  if (!p.username || !String(p.username).trim()) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!p.location || !String(p.location).trim()) {
    return res.status(400).json({ error: 'Spot location is required' });
  }
  if (!p.media && !(Array.isArray(p.carousel_media) && p.carousel_media.length)) {
    return res.status(400).json({ error: 'At least one media item is required' });
  }
  const db = readDB();

  const author = db.users.find(u => 
    (u.username && p.username && u.username.toLowerCase() === p.username.toLowerCase()) || 
    (p.user_id && String(u.id) === String(p.user_id))
  ) || {
    role: p.is_verified_pro ? 'professional' : 'normal',
    is_verified_pro: !!p.is_verified_pro
  };

  const userPastPosts = db.posts.filter(past => past.username === p.username || past.user_id === p.user_id);

  // Run AI Integrity Analysis
  const aiAudit = aiIntegrity.analyzePostIntegrity(p, userPastPosts, author);

  const newPost = {
    id: Date.now(),
    user_id: p.user_id,
    username: p.username,
    author_avatar: p.author_avatar || (author && author.avatar) || avatarFor(p.username),
    user_role: author.role || 'normal',
    is_verified_pro: !!author.is_verified_pro,
    author_badge: author.is_verified_pro ? '☑️ Verified Pro Creator' : '👤 Normal Member',
    location: p.location,
    media: p.media,
    carousel_media: Array.isArray(p.carousel_media) ? p.carousel_media : [],
    filter_css: p.filter_css || 'none',
    description: p.description,
    hotel_name: p.hotel_name,
    hotel_contact: p.hotel_contact,
    hotel_feedback: p.hotel_feedback,
    transport_type: p.transport_type,
    transport_price: p.transport_price,
    transport_contact: p.transport_contact,
    route_desc: p.route_desc,
    route_cost: p.route_cost,
    food_place: p.food_place,
    food_price: p.food_price,
    food_location: p.food_location,
    food_feedback: p.food_feedback,
    must_visit_name: p.must_visit_name,
    must_visit_transport: p.must_visit_transport,
    likes: 0,
    created_at: new Date().toISOString(),
    // AI Content Integrity Fields
    ai_trust_score: aiAudit.trustScore,
    is_ai_altered: aiAudit.isAiAltered,
    ai_alteration_note: aiAudit.alterationNote,
    promotion_status: aiAudit.promotionStatus,
    promotion_reason: aiAudit.promotionReason,
    ai_badge: aiAudit.badge,
    ai_badge_color: aiAudit.badgeColor
  };

  db.posts.push(newPost);
  writeDB(db);
  res.json({ id: newPost.id, ai_audit: aiAudit });
});

app.get('/api/posts', (req, res) => {
  const db = readDB();
  const userId = req.query.user_id;
  ensureCollection(db, 'saves');
  ensureCollection(db, 'likes');
  ensureCollection(db, 'follows');
  ensureCollection(db, 'comments');

  const posts = [...db.posts].reverse().map(post => {
    const author = findUserByUsername(db, post.username);
    const comments = db.comments.filter(c => c.post_id === post.id).map(c => {
      const commenter = findUserByUsername(db, c.username);
      return {
        ...c,
        avatar: c.avatar || (commenter && commenter.avatar) || avatarFor(c.username),
        likes: (db.comment_likes || []).filter(cl => cl.comment_id === c.id).length,
        isLiked: userId
          ? (db.comment_likes || []).some(cl => cl.comment_id === c.id && String(cl.user_id) === String(userId))
          : false
      };
    });

    return {
      ...post,
      // Carousel posts already include their primary image at index zero.
      // Omitting the duplicate base64 field keeps every feed response smaller.
      media: Array.isArray(post.carousel_media) && post.carousel_media.length ? undefined : post.media,
      author_avatar: post.author_avatar || (author && author.avatar) || avatarFor(post.username),
      author_name: (author && author.name) || post.username,
      comments,
      comment_count: comments.length,
      isLiked: userId ? db.likes.some(l => l.post_id === post.id && String(l.user_id) === String(userId)) : false,
      isSaved: userId ? db.saves.some(s => s.post_id === post.id && String(s.user_id) === String(userId)) : false,
      isFollowing: userId ? db.follows.some(f => String(f.follower_id) === String(userId) && f.following_username === post.username) : false,
      isOwner: userId
        ? (String(post.user_id) === String(userId) || (post.username && post.username === (findUserById(db, userId) || {}).username))
        : false
    };
  });
  res.json(posts);
});

// Update a post's media and description (author only).
app.put('/api/posts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const post = (db.posts || []).find(p => String(p.id) === String(id));
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const requester = findUserById(db, req.body && req.body.user_id) || findUserByUsername(db, req.body && req.body.username);
  const isOwner = requester && (String(post.user_id) === String(requester.id) || post.username === requester.username);
  if (!isOwner) return res.status(403).json({ error: 'You can only edit your own spots' });

  if (typeof req.body.media !== 'string' || !Array.isArray(req.body.carousel_media) || req.body.carousel_media.length === 0) {
    return res.status(400).json({ error: 'A main image and carousel images are required' });
  }
  post.media = req.body.media;
  post.carousel_media = req.body.carousel_media;
  if (typeof req.body.description === 'string') post.description = req.body.description;
  writeDB(db);
  res.json({ status: 'updated', id: post.id });
});

// Single post lookup — used by shared deep links (feed.html#post-<id>).
// Registered after /api/posts/saved so the literal path wins over the :id param.
function handleGetPost(req, res) {
  const id = parseInt(req.params.id);
  const db = readDB();
  const post = (db.posts || []).find(p => String(p.id) === String(id));
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const author = findUserByUsername(db, post.username);
  res.json({
    ...post,
    author_avatar: post.author_avatar || (author && author.avatar) || avatarFor(post.username),
    comments: (db.comments || []).filter(c => c.post_id === post.id)
  });
}

// Delete a post (author only). Removes its comments, likes and saves too.
app.delete('/api/posts/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const post = (db.posts || []).find(p => String(p.id) === String(id));
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const requester = findUserById(db, req.body && req.body.user_id) || findUserByUsername(db, req.body && req.body.username);
  const isOwner = requester && (String(post.user_id) === String(requester.id) || post.username === requester.username);
  if (!isOwner) return res.status(403).json({ error: 'You can only delete your own spots' });

  db.posts = db.posts.filter(p => String(p.id) !== String(id));
  db.comments = (db.comments || []).filter(c => String(c.post_id) !== String(id));
  db.likes = (db.likes || []).filter(l => String(l.post_id) !== String(id));
  db.saves = (db.saves || []).filter(s => String(s.post_id) !== String(id));
  db.reports = (db.reports || []).filter(r => String(r.post_id) !== String(id));
  writeDB(db);
  res.json({ status: 'deleted', id: post.id });
});

// Report a spot for review
app.post('/api/posts/:id/report', (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const post = (db.posts || []).find(p => String(p.id) === String(id));
  if (!post) return res.status(404).json({ error: 'Post not found' });

  ensureCollection(db, 'reports');
  const { user_id, username, reason } = req.body || {};
  const report = {
    id: Date.now(),
    post_id: id,
    post_username: post.username,
    reporter_id: user_id || null,
    reporter_username: username || null,
    reason: (reason || 'Suspicious review').slice(0, 400),
    status: 'pending',
    created_at: new Date().toISOString()
  };
  db.reports.push(report);
  writeDB(db);
  res.json({ status: 'reported', report });
});

app.post('/api/posts/:id/save', (req, res) => {
  const id = parseInt(req.params.id);
  const { user_id } = req.body;
  const db = readDB();
  if (!(db.posts || []).some(p => String(p.id) === String(id))) {
    return res.status(404).json({ error: 'Post not found' });
  }
  ensureCollection(db, 'saves');

  const saveIndex = db.saves.findIndex(s => String(s.post_id) === String(id) && String(s.user_id) === String(user_id));
  if (saveIndex !== -1) {
    db.saves.splice(saveIndex, 1);
    writeDB(db);
    res.json({ status: 'unsaved' });
  } else {
    db.saves.push({ post_id: id, user_id, saved_at: new Date().toISOString() });
    writeDB(db);
    res.json({ status: 'saved' });
  }
});

app.get('/api/posts/saved', (req, res) => {
  const userId = req.query.user_id;
  const db = readDB();
  if (!db.saves) db.saves = [];
  const userSaves = db.saves.filter(s => String(s.user_id) === String(userId)).map(s => s.post_id);
  const savedPosts = (db.posts || []).filter(p => userSaves.includes(p.id)).reverse().map(post => ({
    ...post,
    author_avatar: post.author_avatar || (findUserByUsername(db, post.username) || {}).avatar || avatarFor(post.username),
    comments: (db.comments || []).filter(c => c.post_id === post.id),
    isLiked: userId ? (db.likes || []).some(l => l.post_id === post.id && String(l.user_id) === String(userId)) : false,
    isSaved: true
  }));
  res.json(savedPosts);
});

// Registered after /api/posts/saved so the literal path is matched first.
app.get('/api/posts/:id', handleGetPost);

const STORY_TTL_MS = 24 * 60 * 60 * 1000;

app.get('/api/stories', (req, res) => {
  const db = readDB();
  const userId = req.query.user_id;
  const now = Date.now();

  // Stories live for 24 hours, then they are gone — exactly like field guide.
  const live = (db.stories || []).filter(s => {
    const created = new Date(s.created_at || s.time || 0).getTime();
    return !created || (now - created) < STORY_TTL_MS;
  });

  const views = db.story_views || [];
  res.json(live.map(s => ({
    ...s,
    isSeen: userId
      ? views.some(v => v.story_id === s.id && String(v.user_id) === String(userId))
      : false
  })));
});

app.post('/api/stories', (req, res) => {
  const s = req.body;
  if (!s.media || !s.username) {
    return res.status(400).json({ error: 'A story needs an image and an author' });
  }
  const db = readDB();
  if (!db.stories) db.stories = [];
  const newStory = {
    id: Date.now(),
    user_id: s.user_id || 0,
    username: s.username,
    name: s.name || s.username,
    avatar: s.avatar || avatarFor(s.username),
    is_verified_pro: !!s.is_verified_pro,
    spot: s.spot || '',
    media: s.media,
    caption: s.caption || '',
    created_at: new Date().toISOString(),
    time: 'Just now'
  };
  db.stories.unshift(newStory);
  writeDB(db);
  res.json(newStory);
});

// Mark a story as seen by a viewer
app.post('/api/stories/:id/view', (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  ensureCollection(db, 'story_views');
  const { user_id } = req.body || {};
  const already = db.story_views.some(v => v.story_id === id && String(v.user_id) === String(user_id));
  if (!already) {
    db.story_views.push({ story_id: id, user_id, viewed_at: new Date().toISOString() });
    writeDB(db);
  }
  res.json({ status: already ? 'already_seen' : 'seen' });
});

app.get('/api/users/suggestions', (req, res) => {
  const db = readDB();
  const userId = req.query.user_id;
  const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 5;
  const me = findUserById(db, userId);

  const suggestions = (db.users || [])
    .filter(u => String(u.id) !== String(userId))
    .map(u => ({
      id: u.id,
      username: u.username,
      name: u.name || u.username,
      role: u.role || 'normal',
      is_verified_pro: !!u.is_verified_pro,
      bio: u.bio || '',
      avatar: u.avatar || avatarFor(u.username),
      posts_count: (db.posts || []).filter(p => p.username === u.username).length,
      followers_count: (db.follows || []).filter(f => f.following_username === u.username).length,
      isFollowing: (db.follows || []).some(f => String(f.follower_id) === String(userId) && f.following_username === u.username),
      // People you already follow are not "suggestions" anymore.
      isSelf: me && u.username === me.username
    }))
    // Not-yet-followed people with more activity come first.
    .sort((a, b) => {
      if (a.isFollowing !== b.isFollowing) return a.isFollowing ? 1 : -1;
      if (b.posts_count !== a.posts_count) return b.posts_count - a.posts_count;
      return b.followers_count - a.followers_count;
    })
    .slice(0, limit);

  res.json(suggestions);
});

// Search people by username or display name
app.get('/api/users/search', (req, res) => {
  const db = readDB();
  const userId = req.query.user_id;
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  const results = (db.users || [])
    .filter(u => {
      if (String(u.id) === String(userId)) return false;
      const hay = `${u.username || ''} ${u.name || ''}`.toLowerCase();
      return hay.includes(q);
    })
    .map(u => ({
      id: u.id,
      username: u.username,
      name: u.name || u.username,
      bio: u.bio || '',
      role: u.role || 'normal',
      is_verified_pro: !!u.is_verified_pro,
      avatar: u.avatar || avatarFor(u.username),
      posts_count: (db.posts || []).filter(p => p.username === u.username).length,
      followers_count: (db.follows || []).filter(f => f.following_username === u.username).length,
      isFollowing: (db.follows || []).some(f => String(f.follower_id) === String(userId) && f.following_username === u.username)
    }))
    .slice(0, 10);

  res.json(results);
});

// Update your own profile (name, bio, avatar, vibes)
app.post('/api/users/profile', (req, res) => {
  const db = readDB();
  const { user_id, username, name, bio, avatar, vibes } = req.body || {};
  const user = findUserById(db, user_id) || findUserByUsername(db, username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const avatarValue = typeof avatar === 'string' ? avatar.trim() : '';
  if (avatarValue) {
    const inlineImage = avatarValue.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
    const isImageUrl = avatarValue.length <= 2048 && /^https?:\/\/\S+$/i.test(avatarValue);
    if (!inlineImage && !isImageUrl) {
      return res.status(400).json({ error: 'Profile photo must be a JPG, PNG or WebP image.' });
    }
    if (inlineImage && Buffer.byteLength(inlineImage[2], 'base64') > 2 * 1024 * 1024) {
      return res.status(413).json({ error: 'Profile photo is too large. Choose a smaller image.' });
    }
  }

  if (typeof name === 'string' && name.trim()) user.name = name.trim();
  if (typeof bio === 'string') user.bio = bio.trim();
  if (avatarValue) user.avatar = avatarValue;
  if (Array.isArray(vibes)) user.vibes = vibes;

  writeDB(db);
  res.json(publicUser(user, db));
});

// Trending hashtags and locations, computed from real posts only
app.get('/api/trending', (req, res) => {
  try {
    const db = readDB();
    const posts = db.posts || [];

    const tagCounts = new Map();
    const locCounts = new Map();

    posts.forEach(post => {
      extractHashtags(post.description).forEach(tag => {
        const key = tag.toLowerCase();
        tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
      });

      const loc = cleanLocationName(post.location);
      if (loc) {
        const key = loc.toLowerCase();
        locCounts.set(key, (locCounts.get(key) || 0) + 1);
      }
    });

    const tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([tag, count]) => ({ tag, count, label: `#${tag}` }));

    const locations = [...locCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([loc, count]) => ({ location: loc, count, label: loc }));

    res.json({ tags, locations, total_posts: posts.length });
  } catch (err) {
    console.error('Error computing trending:', err);
    res.status(500).json({ error: 'Failed to compute trending spots' });
  }
});

// Toggle a like on a comment
app.post('/api/comments/:id/like', (req, res) => {
  const id = parseInt(req.params.id);
  const { user_id } = req.body || {};
  const db = readDB();
  if (!(db.comments || []).some(c => String(c.id) === String(id))) {
    return res.status(404).json({ error: 'Comment not found' });
  }
  ensureCollection(db, 'comment_likes');

  const index = db.comment_likes.findIndex(cl => cl.comment_id === id && String(cl.user_id) === String(user_id));
  if (index !== -1) {
    db.comment_likes.splice(index, 1);
    writeDB(db);
    res.json({ status: 'unliked', likes: db.comment_likes.filter(cl => cl.comment_id === id).length });
  } else {
    db.comment_likes.push({ comment_id: id, user_id, liked_at: new Date().toISOString() });
    writeDB(db);
    res.json({ status: 'liked', likes: db.comment_likes.filter(cl => cl.comment_id === id).length });
  }
});

app.post('/api/posts/:id/like', (req, res) => {
  const id = parseInt(req.params.id);
  const { user_id } = req.body;
  const db = readDB();
  if (!(db.posts || []).some(p => String(p.id) === String(id))) {
    return res.status(404).json({ error: 'Post not found' });
  }
  ensureCollection(db, 'likes');

  const likeIndex = db.likes.findIndex(l => String(l.post_id) === String(id) && String(l.user_id) === String(user_id));
  const post = db.posts.find(p => String(p.id) === String(id));

  if (likeIndex !== -1) {
    db.likes.splice(likeIndex, 1);
    if (post) post.likes = Math.max(0, (post.likes || 0) - 1);
    writeDB(db);
    res.json({ status: 'unliked', likes: post ? post.likes : 0 });
  } else {
    db.likes.push({ post_id: id, user_id, liked_at: new Date().toISOString() });
    if (post) post.likes = (post.likes || 0) + 1;
    writeDB(db);
    res.json({ status: 'liked', likes: post ? post.likes : 0 });
  }
});

app.post('/api/posts/:id/comment', (req, res) => {
  const id = parseInt(req.params.id);
  const { username, text, user_id, avatar } = req.body;
  const db = readDB();
  ensureCollection(db, 'comments');

  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'Comment text is required' });
  }
  if (!(db.posts || []).some(p => String(p.id) === String(id))) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const author = findUserByUsername(db, username);
  const comment = {
    id: Date.now(),
    post_id: id,
    username,
    user_id: user_id || (author ? author.id : null),
    avatar: avatar || (author && author.avatar) || avatarFor(username),
    text: String(text).trim(),
    created_at: new Date().toISOString()
  };
  db.comments.push(comment);
  writeDB(db);

  res.json(comment);
});

app.get('/api/users/profile', (req, res) => {
  try {
    const db = readDB();
    const username = req.query.username;
    const user = findUserByUsername(db, username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const users = db.users || [];
    const followers = (db.follows || []).filter(f => f.following_username === username).length;
    const following = (db.follows || []).filter(f => {
      const follower = users.find(u => String(u.id) === String(f.follower_id));
      return follower && follower.username === username;
    }).length;
    const postsCount = (db.posts || []).filter(p => p.username === username).length;
    const savedCount = (db.saves || []).filter(s => {
      const saver = users.find(u => String(u.id) === String(s.user_id));
      return saver && saver.username === username;
    }).length;

    res.json({
      id: user.id,
      username: user.username,
      name: user.name || user.username,
      avatar: user.avatar || avatarFor(user.username),
      bio: user.bio || '',
      vibes: user.vibes || [],
      role: user.role || 'normal',
      is_verified_pro: !!user.is_verified_pro,
      followers_count: followers,
      following_count: following,
      posts_count: postsCount,
      saved_count: savedCount
    });
  } catch (err) {
    console.error('Error fetching user profile:', err);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

app.post('/api/users/follow', (req, res) => {
  const { follower_id, following_username } = req.body;
  const db = readDB();
  ensureCollection(db, 'follows');

  const followIndex = db.follows.findIndex(f =>
    String(f.follower_id) === String(follower_id) && f.following_username === following_username
  );

  if (followIndex !== -1) {
    db.follows.splice(followIndex, 1);
    syncFollowCounts(db);
    writeDB(db);
    res.json({ status: 'unfollowed', followers_count: countFollowers(db, following_username) });
  } else {
    db.follows.push({ follower_id, following_username, followed_at: new Date().toISOString() });
    syncFollowCounts(db);
    writeDB(db);
    res.json({ status: 'followed', followers_count: countFollowers(db, following_username) });
  }
});

function countFollowers(db, username) {
  return (db.follows || []).filter(f => f.following_username === username).length;
}

// Keep the denormalised counters on the user record in sync with the follow rows.
function syncFollowCounts(db) {
  (db.users || []).forEach(u => {
    u.followers_count = countFollowers(db, u.username);
  });
}

// AI Travel Planner Routes
const travelPlanner = require('./travelPlannerService');
const dashboardService = require('./dashboardService');

app.post('/api/dashboard/analyze-place', (req, res) => {
  try {
    const { location } = req.body;
    const db = readDB();
    const analytics = dashboardService.generatePlaceAnalytics(location, db);
    res.json(analytics);
  } catch (err) {
    console.error('Error in /api/dashboard/analyze-place:', err);
    res.status(500).json({ error: 'Failed to generate place analytics' });
  }
});

app.post('/api/ai-planner', async (req, res) => {
  try {
    const db = readDB();
    const plan = await travelPlanner.generateTravelPlan(req.body, db);
    res.json(plan);
  } catch (err) {
    console.error('Error in /api/ai-planner:', err);
    res.status(500).json({ error: err.message || 'Failed to generate itinerary' });
  }
});

app.get('/api/config/groq-key', (req, res) => {
  res.json(travelPlanner.getGroqKeyStatus());
});

app.post('/api/config/groq-key', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'Valid apiKey string required' });
  }
  travelPlanner.saveGroqKey(apiKey.trim());
  res.json({ status: 'saved', ...travelPlanner.getGroqKeyStatus() });
});

// Business Portal Routes
app.get('/api/businesses', (req, res) => {
  try {
    const db = readDB();
    let list = db.businesses || [];
    const { category, location, search } = req.query;

    if (category && category !== 'all') {
      list = list.filter(b => (b.category || '').toLowerCase() === category.toLowerCase());
    }

    if (location) {
      const locQ = location.toLowerCase();
      list = list.filter(b => (b.location || '').toLowerCase().includes(locQ));
    }

    if (search) {
      const sQ = search.toLowerCase();
      list = list.filter(b =>
        (b.name || '').toLowerCase().includes(sQ) ||
        (b.location || '').toLowerCase().includes(sQ) ||
        (b.description || '').toLowerCase().includes(sQ) ||
        (b.menu_items || '').toLowerCase().includes(sQ)
      );
    }

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

app.post('/api/businesses', (req, res) => {
  try {
    const b = req.body;
    if (!b.name || !b.category || !b.location) {
      return res.status(400).json({ error: 'Business name, category, and location are required' });
    }

    const db = readDB();
    if (!db.businesses) db.businesses = [];

    const newBusiness = {
      id: Date.now(),
      name: b.name.trim(),
      category: b.category.trim().toLowerCase(),
      location: b.location.trim(),
      website: b.website ? b.website.trim() : '',
      phone: b.phone ? b.phone.trim() : '',
      price_range: b.price_range ? b.price_range.trim() : '',
      image: b.image ? b.image.trim() : '',
      description: b.description ? b.description.trim() : '',
      menu_items: b.menu_items ? b.menu_items.trim() : '',
      created_at: new Date().toISOString()
    };

    db.businesses.unshift(newBusiness);
    writeDB(db);

    res.json(newBusiness);
  } catch (err) {
    console.error('Error adding business:', err);
    res.status(500).json({ error: 'Failed to add business listing' });
  }
});

app.delete('/api/businesses/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const db = readDB();
    if (!db.businesses) db.businesses = [];

    db.businesses = db.businesses.filter(b => b.id !== id);
    writeDB(db);
    res.json({ status: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete business' });
  }
});

// SOS Emergency Trigger Route
app.post('/api/sos/trigger', (req, res) => {
  try {
    const alertData = req.body;
    const db = readDB();
    
    if (!db.sos_alerts) db.sos_alerts = [];
    
    const newAlert = {
      id: Date.now(),
      username: alertData.username || 'Unknown',
      location: alertData.location,
      coordinates: alertData.coordinates,
      dangerScore: alertData.dangerScore,
      timestamp: alertData.timestamp || new Date().toISOString()
    };
    
    db.sos_alerts.push(newAlert);
    writeDB(db);
    
    // The alert is recorded with the reported location. There is no live
    // broadcast channel wired up yet, so the response does not claim one.
    res.json({ 
      status: 'success', 
      message: 'SOS alert received and recorded with the reported location.' 
    });
  } catch (err) {
    console.error('Error handling SOS trigger:', err);
    res.status(500).json({ error: 'Failed to process SOS alert' });
  }
});

// Keep registered users' profile details in sync with their active session.
app.post('/api/users/sync', (req, res) => {
  const db = readDB();
  const { id, username, name, email, avatar, bio, vibes, role, is_verified_pro } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username is required' });

  const user = (db.users || []).find(u =>
    (id && String(u.id) === String(id)) ||
    (u.username || '').toLowerCase() === String(username).toLowerCase()
  );

  if (!user) return res.status(404).json({ error: 'Registered account not found' });
  if (name) user.name = name;
  if (avatar) user.avatar = avatar;
  if (typeof bio === 'string') user.bio = bio;
  if (Array.isArray(vibes)) user.vibes = vibes;

  syncFollowCounts(db);
  writeDB(db);
  res.json(publicUser(user, db));
});

// Delete your own comment
app.delete('/api/comments/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const db = readDB();
  const comment = (db.comments || []).find(c => String(c.id) === String(id));
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  const requester = findUserById(db, req.body && req.body.user_id) || findUserByUsername(db, req.body && req.body.username);
  const isOwner = requester && (String(comment.user_id) === String(requester.id) || comment.username === requester.username);
  if (!isOwner) return res.status(403).json({ error: 'You can only delete your own comments' });

  db.comments = db.comments.filter(c => String(c.id) !== String(id));
  db.comment_likes = (db.comment_likes || []).filter(cl => String(cl.comment_id) !== String(id));
  writeDB(db);
  res.json({ status: 'deleted', id: comment.id });
});

// ---------- Notifications ----------
// Activity is derived from the real like/comment/follow/message rows so the
// drawer always reflects what actually happened on the platform.
app.get('/api/notifications', (req, res) => {
  try {
    const db = readDB();
    const userId = req.query.user_id;
    const me = findUserById(db, userId);
    if (!me) return res.json([]);

    const myUsernames = new Set([me.username]);
    const myPostIds = new Set((db.posts || []).filter(p => p.username === me.username).map(p => p.id));
    const items = [];

    (db.likes || []).forEach(like => {
      const post = (db.posts || []).find(p => String(p.id) === String(like.post_id));
      if (!post || !myPostIds.has(post.id)) return;
      const actor = findUserById(db, like.user_id);
      if (!actor || actor.username === me.username) return;
      const place = cleanLocationName(post.location);
      items.push({
        key: `like-${like.post_id}-${actor.id}`,
        type: 'like',
        actor_username: actor.username,
        actor_avatar: actor.avatar || avatarFor(actor.username),
        post_id: post.id,
        text: place ? `liked your spot at ${place}.` : 'liked your spot.',
        created_at: like.liked_at || post.created_at
      });
    });

    (db.comments || []).forEach(comment => {
      if (!myPostIds.has(comment.post_id)) return;
      const actor = findUserByUsername(db, comment.username);
      if (!actor || actor.username === me.username) return;
      const post = (db.posts || []).find(p => String(p.id) === String(comment.post_id));
      items.push({
        key: `comment-${comment.id}`,
        type: 'comment',
        actor_username: actor.username,
        actor_avatar: actor.avatar || avatarFor(actor.username),
        post_id: comment.post_id,
        text: `commented: "${comment.text}"`,
        created_at: comment.created_at
      });
    });

    (db.follows || []).forEach(follow => {
      const actor = findUserById(db, follow.follower_id);
      if (!actor || actor.username === me.username) return;
      if (follow.following_username !== me.username) return;
      items.push({
        key: `follow-${actor.id}`,
        type: 'follow',
        actor_username: actor.username,
        actor_avatar: actor.avatar || avatarFor(actor.username),
        post_id: null,
        text: 'started following you.',
        created_at: follow.followed_at
      });
    });

    (db.messages || []).forEach(msg => {
      if (msg.to_username !== me.username) return;
      items.push({
        key: `message-${msg.id}`,
        type: 'message',
        actor_username: msg.from_username,
        actor_avatar: (findUserByUsername(db, msg.from_username) || {}).avatar || avatarFor(msg.from_username),
        post_id: msg.post_id || null,
        text: `sent you a message: "${msg.text}"`,
        created_at: msg.created_at
      });
    });

    items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const readKeys = new Set(
      (db.notification_reads || [])
        .filter(r => String(r.user_id) === String(userId))
        .map(r => r.key)
    );

    res.json(items.map(item => ({ ...item, is_read: readKeys.has(item.key) })));
  } catch (err) {
    console.error('Error building notifications:', err);
    res.status(500).json({ error: 'Failed to build notifications' });
  }
});

app.post('/api/notifications/read', (req, res) => {
  const db = readDB();
  const { user_id, keys } = req.body || {};
  ensureCollection(db, 'notification_reads');
  const list = Array.isArray(keys) ? keys : [];
  list.forEach(key => {
    if (!db.notification_reads.some(r => r.key === key && String(r.user_id) === String(user_id))) {
      db.notification_reads.push({ key, user_id, read_at: new Date().toISOString() });
    }
  });
  writeDB(db);
  res.json({ status: 'ok', read: list.length });
});

// ---------- Direct Messages ----------
app.get('/api/messages/threads', (req, res) => {
  // Message list reads need only user and message metadata. Avoid cloning the
  // full app snapshot (including every base64 post image) on each inbox open.
  const db = dbCache;
  const userId = req.query.user_id;
  const me = findUserById(db, userId);
  if (!me) return res.json([]);

  const messages = db.messages || [];
  const peers = new Map();

  messages.forEach(msg => {
    let peer = null;
    if (msg.from_username === me.username) peer = msg.to_username;
    else if (msg.to_username === me.username) peer = msg.from_username;
    if (!peer) return;

    const existing = peers.get(peer);
    const isNewer = !existing || new Date(msg.created_at || 0) >= new Date(existing.last_message_at || 0);
    if (isNewer) {
      peers.set(peer, {
        peer_username: peer,
        peer_avatar: (findUserByUsername(db, peer) || {}).avatar || avatarFor(peer),
        peer_name: (findUserByUsername(db, peer) || {}).name || peer,
        last_message: msg.text,
        last_message_at: msg.created_at,
        unread: msg.to_username === me.username && !msg.read
      });
    } else if (msg.to_username === me.username && !msg.read) {
      existing.unread = true;
    }
  });

  const threads = [...peers.values()].sort(
    (a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)
  );
  res.json(threads);
});

app.get('/api/messages/thread', (req, res) => {
  // Keep this read path light too; only persist a full snapshot if unread flags
  // actually change when a conversation is opened.
  const db = dbCache;
  const { user_id, peer } = req.query;
  const me = findUserById(db, user_id);
  if (!me) return res.json([]);

  const messages = (db.messages || []).filter(m =>
    (m.from_username === me.username && m.to_username === peer) ||
    (m.to_username === me.username && m.from_username === peer)
  );

  // Opening a thread marks the incoming messages as read.
  let changed = false;
  messages.forEach(m => {
    if (m.to_username === me.username && !m.read) {
      m.read = true;
      m.read_at = new Date().toISOString();
      changed = true;
    }
  });
  res.json(messages);
  if (changed) {
    // Mark-read is a side effect of opening a thread; do not make the chat wait
    // for a full Mongo snapshot (which also contains large post images).
    setImmediate(() => {
      requestPersistence.run({ writes: [] }, () => {
        writeDB(dbCache).catch(err => {
          console.error('Could not persist message read state:', err.message);
        });
      });
    });
  }
});

app.post('/api/messages', (req, res) => {
  const db = readDB();
  const { from_user_id, from_username, to_username, text, post_id } = req.body || {};
  if (!to_username || !text || !String(text).trim()) {
    return res.status(400).json({ error: 'A recipient and message body are required' });
  }
  const recipient = findUserByUsername(db, to_username);
  if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

  ensureCollection(db, 'messages');
  const message = {
    id: Date.now(),
    from_user_id: from_user_id || null,
    from_username,
    to_username,
    text: String(text).trim(),
    post_id: post_id || null,
    read: false,
    created_at: new Date().toISOString()
  };
  db.messages.push(message);
  writeDB(db);
  res.json(message);
});

// ---------- Destinations ----------
// Derived from real posts: only places that actually have a spot attached.
app.get('/api/destinations', (req, res) => {
  try {
    const db = readDB();
    const counts = new Map();
    const seen = new Set();

    (db.posts || []).forEach(post => {
      const dest = cleanLocationName(post.location);
      if (!dest) return;
      const key = dest.toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!seen.has(key)) {
        seen.add(key);
        counts.set(key, counts.get(key));
      }
    });

    const destinations = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));

    res.json(destinations);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch destinations' });
  }
});

const PORT = process.env.PORT || 3000;
async function startServer() {
  try {
    await connectMongoStore();
    const server = app.listen(PORT, () => {
      console.log(`Server running at: http://localhost:${PORT}`);
      console.log(`Open in browser:  http://localhost:${PORT}/index.html`);
      console.log(`Persistent storage: MongoDB (${mongoDb.databaseName})`);
    });
    const shutdown = async () => {
      server.close();
      if (mongoClient) await mongoClient.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (err) {
    console.error('MongoDB startup failed:', err.message);
    if (mongoClient) await mongoClient.close().catch(() => {});
    process.exitCode = 1;
  }
}

startServer();
