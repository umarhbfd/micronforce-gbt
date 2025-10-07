import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const app = express();

// ---------- CORS (allow custom admin header) ----------
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-admin','authorization']
}));
app.options('*', cors());
// ------------------------------------------------------

app.use(express.json({ limit: '2mb' }));

// ---------- Config & State ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ADMIN_BYPASS_TOKEN = process.env.ADMIN_BYPASS_TOKEN || '';
const PORT = process.env.PORT || 8080;

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

let settings = {
  model: process.env.CHAT_MODEL || 'gpt-4o-mini',
  tts_engine: process.env.TTS_ENGINE || 'openai',
  tts_voice: process.env.TTS_VOICE || 'alloy'
};

const logs = []; // in-memory; persists only while the server is running

// ---------- Helpers ----------
function nowISO(){ return new Date().toISOString().replace('T',' ').slice(0,19); }

function requireAdmin(req, res, next){
  if (!ADMIN_BYPASS_TOKEN) return res.status(401).json({ error:'admin_token_missing' });
  const token = req.header('x-admin');
  if (token !== ADMIN_BYPASS_TOKEN) return res.status(401).json({ error:'unauthorized' });
  next();
}

async function callChat(messages){
  const resp = await client.chat.completions.create({
    model: settings.model || 'gpt-4o-mini',
    temperature: 0.7,
    messages
  });
  return resp.choices?.[0]?.message?.content || '';
}

async function ttsBuffer(text, voice){
  // OpenAI TTS REST call (mp3)
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: voice || settings.tts_voice || 'alloy',
      input: text
    })
  });
  if (!r.ok) {
    const e = await r.text().catch(()=> '');
    throw new Error(`TTS failed: ${r.status} ${e}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

// ---------- Routes ----------
app.get('/api/health', (req,res)=> res.json({ ok: true }));

// Superadmin: settings
app.get('/api/super/settings', requireAdmin, (req, res)=>{
  res.json(settings);
});
app.put('/api/super/settings', requireAdmin, (req, res)=>{
  const { model, tts_engine, tts_voice } = req.body || {};
  if (model) settings.model = model;
  if (tts_engine) settings.tts_engine = tts_engine;
  if (tts_voice) settings.tts_voice = tts_voice;
  res.json(settings);
});

// Superadmin: chat
app.post('/api/super/chat', requireAdmin, async (req, res)=>{
  try{
    const { messages = [], admin_user = 'superadmin' } = req.body || {};
    const reply = await callChat(messages);
    logs.unshift({
      created_at: nowISO(),
      scope: 'super',
      actor: admin_user,
      messages: JSON.stringify(messages),
      reply
    });
    res.json({ reply });
  }catch(e){
    res.status(500).json({ error: 'chat_failed', detail: String(e) });
  }
});

// Superadmin: TTS
app.get('/api/super/tts', requireAdmin, async (req,res)=>{
  try{
    const { text = '', voice } = req.query;
    const buf = await ttsBuffer(String(text||''), voice);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  }catch(e){
    res.status(500).json({ error: 'tts_failed', detail: String(e) });
  }
});

// Superadmin: logs
app.get('/api/super/logs', requireAdmin, (req,res)=>{
  const q = (req.query.q || '').toString().toLowerCase();
  const filtered = q
    ? logs.filter(r => (r.reply||'').toLowerCase().includes(q) || (r.messages||'').toLowerCase().includes(q))
    : logs;
  res.json(filtered.slice(0,200)); // cap
});

// User chat
app.post('/api/chat/user/send', async (req, res)=>{
  try{
    const { messages = [] } = req.body || {};
    const reply = await callChat(messages);
    logs.unshift({
      created_at: nowISO(),
      scope: 'user',
      actor: 'user',
      messages: JSON.stringify(messages),
      reply
    });
    res.json({ reply });
  }catch(e){
    res.status(500).json({ error: 'chat_failed', detail: String(e) });
  }
});

// Public TTS for user (optional)
app.get('/api/tts', async (req,res)=>{
  try{
    const { text = '', voice } = req.query;
    const buf = await ttsBuffer(String(text||''), voice);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buf);
  }catch(e){
    res.status(500).json({ error: 'tts_failed', detail: String(e) });
  }
});

app.use((req,res)=> res.status(404).json({ error: 'not_found' }));

app.listen(PORT, ()=> {
  console.log('MicronForce GPT server on :'+PORT);
});
