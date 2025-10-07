import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fetch from 'node-fetch';
import multer from 'multer';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const {
  OPENAI_API_KEY,
  PORT = 8080,
  ADMIN_BYPASS_TOKEN,
  CHAT_MODEL = 'gpt-4o-mini',
  TTS_ENGINE = 'openai', // or 'browser'
  TTS_VOICE = 'alloy',
  AUTH_JWT_SECRET,
  AUTH_JWT_ISSUER
} = process.env;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

// === SQLite (local, in-house) ===
const db = new Database('./micronforce_gpt.sqlite');
db.pragma('journal_mode = WAL');
db.exec(`
  create table if not exists chat_settings (
    id integer primary key check (id = 1),
    model text default 'gpt-4o-mini',
    tts_engine text default 'openai',
    tts_voice text default 'alloy',
    system_prompt text default ''
  );
  insert into chat_settings (id) values (1) on conflict(id) do nothing;

  create table if not exists chat_logs (
    id integer primary key autoincrement,
    actor text, -- 'superadmin' or 'user:{id or ip}'
    scope text, -- 'super' or 'user'
    messages json not null,
    reply text not null,
    tokens_prompt integer,
    tokens_completion integer,
    created_at text default (datetime('now'))
  );
`);

// === Simple rate limiter (per IP) ===
const bucket = new Map();
function allow(ip, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const b = bucket.get(ip) || { count: 0, reset: now + windowMs };
  if (now > b.reset) {
    b.count = 0;
    b.reset = now + windowMs;
  }
  b.count++;
  bucket.set(ip, b);
  return b.count <= limit;
}
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (!allow(ip, limit, windowMs)) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

// === Auth middlewares ===
function getRoleFromCookie(req) {
  const token = req.cookies?.access;
  if (!token) return null;
  try {
    const decoded = AUTH_JWT_SECRET ? jwt.verify(token, AUTH_JWT_SECRET, AUTH_JWT_ISSUER ? { issuer: AUTH_JWT_ISSUER } : {}) : jwt.decode(token);
    return decoded?.role || null;
  } catch (_) {
    return null;
  }
}

function requireSuperadmin(req, res, next) {
  const role = getRoleFromCookie(req);
  if (role === 'superadmin') return next();
  if (ADMIN_BYPASS_TOKEN && req.header('x-admin') === ADMIN_BYPASS_TOKEN) return next();
  return res.status(401).json({ error: 'Superadmin required' });
}

function requireUser(req, res, next) {
  const role = getRoleFromCookie(req);
  if (role) return next();
  // Allow anonymous during integration. Swap for your real auth later.
  return next();
}

// === Settings (superadmin) ===
app.get('/api/super/settings', requireSuperadmin, (req, res) => {
  const row = db.prepare(`select model, tts_engine, tts_voice, system_prompt from chat_settings where id=1`).get();
  res.json(row);
});

app.put('/api/super/settings', requireSuperadmin, (req, res) => {
  const { model, tts_engine, tts_voice, system_prompt } = req.body || {};
  db.prepare(`
    update chat_settings set 
      model = coalesce(@model, model),
      tts_engine = coalesce(@tts_engine, tts_engine),
      tts_voice = coalesce(@tts_voice, tts_voice),
      system_prompt = coalesce(@system_prompt, system_prompt)
    where id=1
  `).run({ model, tts_engine, tts_voice, system_prompt });
  const row = db.prepare(`select model, tts_engine, tts_voice, system_prompt from chat_settings where id=1`).get();
  res.json(row);
});

// === Superadmin chat ===
app.post('/api/super/chat', rateLimit(60, 60_000), requireSuperadmin, async (req, res) => {
  try {
    const { messages = [], admin_user = 'superadmin' } = req.body || {};
    const settings = db.prepare(`select model, system_prompt from chat_settings where id=1`).get();
    const finalMessages = [];

    if (settings?.system_prompt?.trim()) {
      finalMessages.push({ role: 'system', content: settings.system_prompt });
    }
    for (const m of messages) finalMessages.push(m);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: settings?.model || CHAT_MODEL,
        messages: finalMessages,
        temperature: 0.7
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    const reply = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage || {};

    db.prepare(`
      insert into chat_logs (actor, scope, messages, reply, tokens_prompt, tokens_completion)
      values (@actor, 'super', @messages, @reply, @tp, @tc)
    `).run({
      actor: admin_user,
      messages: JSON.stringify(finalMessages),
      reply,
      tp: usage.prompt_tokens || null,
      tc: usage.completion_tokens || null
    });

    res.json({ reply, usage, created_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'chat_failed', detail: String(e) });
  }
});

// === Superadmin TTS ===
app.get('/api/super/tts', rateLimit(30, 60_000), requireSuperadmin, async (req, res) => {
  try {
    const { text = '', voice } = req.query;
    const settings = db.prepare(`select tts_engine, tts_voice from chat_settings where id=1`).get();
    const engine = (settings?.tts_engine || TTS_ENGINE).toLowerCase();
    if (engine === 'browser') return res.status(400).json({ error: 'browser_tts_enabled' });

    const v = voice || settings?.tts_voice || TTS_VOICE;
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: v, input: String(text) })
    });
    if (!r.ok) return res.status(500).send(await r.text());

    res.setHeader('Content-Type', 'audio/mpeg');
    r.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: 'tts_failed', detail: String(e) });
  }
});

// === Superadmin STT ===
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/super/stt', rateLimit(20, 60_000), requireSuperadmin, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const boundary = '----micron' + Math.random().toString(16).slice(2);
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\naudio-transcriptions-1\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      req.file.buffer,
      `\r\n--${boundary}--`
    ];

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)))
    });
    const data = await r.json();
    res.status(r.ok ? 200 : 500).json(data);
  } catch (e) {
    res.status(500).json({ error: 'stt_failed', detail: String(e) });
  }
});

// === Logs (superadmin) ===
app.get('/api/super/logs', requireSuperadmin, (req, res) => {
  const { q = '', limit = 50 } = req.query;
  const rows = q
    ? db.prepare(`select * from chat_logs where reply like ? or messages like ? order by id desc limit ?`).all(`%${q}%`, `%${q}%`, Number(limit))
    : db.prepare(`select * from chat_logs order by id desc limit ?`).all(Number(limit));
  res.json(rows);
});

// === USER ENDPOINTS ===

// Text chat for users
app.post('/api/chat/user/send', rateLimit(30, 60_000), requireUser, async (req, res) => {
  try {
    const { messages = [], user_id } = req.body || {};
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const actor = user_id ? `user:${user_id}` : `ip:${ip}`;

    const settings = db.prepare(`select model, system_prompt from chat_settings where id=1`).get();
    const finalMessages = [];

    if (settings?.system_prompt?.trim()) {
      finalMessages.push({ role: 'system', content: settings.system_prompt });
    }
    for (const m of messages) finalMessages.push(m);

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: settings?.model || CHAT_MODEL,
        messages: finalMessages,
        temperature: 0.7
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    const reply = data?.choices?.[0]?.message?.content ?? '';
    const usage = data?.usage || {};

    db.prepare(`
      insert into chat_logs (actor, scope, messages, reply, tokens_prompt, tokens_completion)
      values (@actor, 'user', @messages, @reply, @tp, @tc)
    `).run({
      actor,
      messages: JSON.stringify(finalMessages),
      reply,
      tp: usage.prompt_tokens || null,
      tc: usage.completion_tokens || null
    });

    res.json({ reply, usage, created_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'chat_failed', detail: String(e) });
  }
});

// TTS for users
app.get('/api/tts', rateLimit(30, 60_000), async (req, res) => {
  try {
    const { text = '', voice } = req.query;
    const settings = db.prepare(`select tts_engine, tts_voice from chat_settings where id=1`).get();
    const engine = (settings?.tts_engine || TTS_ENGINE).toLowerCase();
    if (engine === 'browser') return res.status(400).json({ error: 'browser_tts_enabled' });

    const v = voice || settings?.tts_voice || TTS_VOICE;
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: v, input: String(text) })
    });
    if (!r.ok) return res.status(500).send(await r.text());

    res.setHeader('Content-Type', 'audio/mpeg');
    r.body.pipe(res);
  } catch (e) {
    res.status(500).json({ error: 'tts_failed', detail: String(e) });
  }
});

// STT for users
app.post('/api/stt', rateLimit(20, 60_000), upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const boundary = '----micron' + Math.random().toString(16).slice(2);
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\naudio-transcriptions-1\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      req.file.buffer,
      `\r\n--${boundary}--`
    ];

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)))
    });
    const data = await r.json();
    res.status(r.ok ? 200 : 500).json(data);
  } catch (e) {
    res.status(500).json({ error: 'stt_failed', detail: String(e) });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.listen(Number(PORT), () => console.log(`MicronForce GPT server on :${PORT}`));
