const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');
const rateLimit = require('express-rate-limit');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const UPSTREAM_URL = process.env.UPSTREAM_URL || '';
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '0', 10);
let UPSTREAM_HEADERS = {};
try { UPSTREAM_HEADERS = JSON.parse(process.env.UPSTREAM_HEADERS || '{}'); } catch {}

const db = new DatabaseSync(process.env.DB_PATH || './app.db');
db.exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, pass TEXT,
  api_key TEXT UNIQUE, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS usage(
  user_id INTEGER, day TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(user_id, day));`);

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const newKey = () => 'ffk_' + crypto.randomBytes(20).toString('hex');
const today = () => new Date().toISOString().slice(0, 10);

// ---- ক্যাশ + আপস্ট্রিম ----
const cache = new Map();
async function fetchPlayer(uid, region) {
  if (!UPSTREAM_URL) throw Object.assign(new Error('UPSTREAM_URL সেট করা হয়নি'), { code: 500 });
  const ck = region + ':' + uid;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.d;
  const url = UPSTREAM_URL.replace('{uid}', encodeURIComponent(uid)).replace('{region}', encodeURIComponent(String(region).toUpperCase()));
  const r = await fetch(url, { headers: UPSTREAM_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Object.assign(new Error('প্লেয়ার পাওয়া যায়নি বা আপস্ট্রিম এরর (' + r.status + ')'), { code: 404 });
  const d = await r.json();
  cache.set(ck, { t: Date.now(), d });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return d;
}
const validUid = u => /^\d{5,15}$/.test(u || '');

// ---- পাবলিক চেক (অ্যাকাউন্ট লাগে না, IP লিমিট) ----
const ipLimiter = rateLimit({ windowMs: 60_000, max: 30, message: { error: 'অনেক বেশি রিকোয়েস্ট, একটু পরে চেষ্টা করুন' } });
app.get('/api/lookup', ipLimiter, async (req, res) => {
  const { uid, region = 'bd' } = req.query;
  if (!validUid(uid)) return res.status(400).json({ error: 'সঠিক UID দিন (শুধু সংখ্যা)' });
  try { res.json({ success: true, data: await fetchPlayer(uid, region) }); }
  catch (e) { res.status(e.code || 502).json({ error: e.message }); }
});

// ---- অথ ----
const auth = (req, res, next) => {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    req.user = jwt.verify(t, JWT_SECRET); next();
  } catch { res.status(401).json({ error: 'লগইন করুন' }); }
};
const sign = u => jwt.sign({ id: u.id, email: u.email }, JWT_SECRET, { expiresIn: '30d' });

app.post('/api/register', rateLimit({ windowMs: 3600_000, max: 20 }), (req, res) => {
  const { email, password } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 6)
    return res.status(400).json({ error: 'সঠিক ইমেইল ও কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড দিন' });
  try {
    const info = db.prepare('INSERT INTO users(email,pass,api_key) VALUES(?,?,?)')
      .run(email.toLowerCase(), bcrypt.hashSync(password, 10), newKey());
    res.json({ token: sign({ id: info.lastInsertRowid, email }) });
  } catch { res.status(409).json({ error: 'এই ইমেইল আগে থেকেই আছে' }); }
});

app.post('/api/login', rateLimit({ windowMs: 600_000, max: 30 }), (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(password || '', u.pass)) return res.status(401).json({ error: 'ইমেইল বা পাসওয়ার্ড ভুল' });
  res.json({ token: sign(u) });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,email,api_key,created_at FROM users WHERE id=?').get(req.user.id);
  const us = db.prepare('SELECT count FROM usage WHERE user_id=? AND day=?').get(u.id, today());
  res.json({ ...u, usedToday: us ? us.count : 0, dailyLimit: DAILY_LIMIT });
});

app.post('/api/regenerate-key', auth, (req, res) => {
  const k = newKey();
  db.prepare('UPDATE users SET api_key=? WHERE id=?').run(k, req.user.id);
  res.json({ api_key: k });
});

// ---- পাবলিক API (key লাগবে) ----
app.get('/v1/player', async (req, res) => {
  const key = req.query.key || req.headers['x-api-key'];
  const u = key && db.prepare('SELECT id FROM users WHERE api_key=?').get(key);
  if (!u) return res.status(401).json({ error: 'সঠিক API key দিন' });
  const { uid, region = 'bd' } = req.query;
  if (!validUid(uid)) return res.status(400).json({ error: 'সঠিক UID দিন' });
  if (DAILY_LIMIT > 0) {
    const us = db.prepare('SELECT count FROM usage WHERE user_id=? AND day=?').get(u.id, today());
    if (us && us.count >= DAILY_LIMIT) return res.status(429).json({ error: 'আজকের লিমিট শেষ' });
  }
  try {
    const data = await fetchPlayer(uid, region);
    db.prepare(`INSERT INTO usage(user_id,day,count) VALUES(?,?,1)
      ON CONFLICT(user_id,day) DO UPDATE SET count=count+1`).run(u.id, today());
    res.json({ success: true, data });
  } catch (e) { res.status(e.code || 502).json({ error: e.message }); }
});

app.listen(PORT, () => console.log('Running on :' + PORT));
