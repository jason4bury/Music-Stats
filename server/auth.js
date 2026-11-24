// Sign-in: one username and password from .env, and a signed cookie (no session store needed).
// SIGN_IN=off turns it off for a dashboard that is only reachable on your home network.
const crypto = require('crypto');

const COOKIE = 'ms_session';
const DAYS = 30;
const signInOff = /^(off|false|no|0)$/i.test(String(process.env.SIGN_IN || '').trim());

function settingsProblems() {
  if (signInOff) return [];
  const placeholders = new Set(['', 'change-me', 'your-username', 'change-this-to-a-long-random-string']);
  const problems = [];
  if (placeholders.has((process.env.APP_USERNAME || '').trim())) problems.push('APP_USERNAME is not set');
  if (placeholders.has((process.env.APP_PASSWORD || '').trim())) problems.push('APP_PASSWORD is not set (or is still "change-me")');
  const secret = (process.env.SESSION_SECRET || '').trim();
  if (placeholders.has(secret)) problems.push('SESSION_SECRET is not set (or is still the example value)');
  else if (secret.length < 32) problems.push('SESSION_SECRET is shorter than 32 characters');
  return problems;
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('base64url');
}

function sameText(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return '';
}

function signedIn(req) {
  if (signInOff) return true;
  const [user, until, mac] = readCookie(req).split('.');
  if (!user || !until || !mac) return false;
  if (Number(until) < Date.now()) return false;
  return sameText(mac, sign(`${user}.${until}`)) && sameText(Buffer.from(user, 'base64url').toString(), process.env.APP_USERNAME);
}

// 10 wrong passwords from one address in 15 minutes locks that address out for 15 minutes.
const failures = new Map();
function lockedOut(ip) {
  const f = failures.get(ip);
  return f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000;
}

function login(req, res) {
  const ip = req.ip;
  if (signInOff) return res.json({ ok: true });
  if (lockedOut(ip)) return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
  const { username = '', password = '' } = req.body || {};
  if (sameText(username, process.env.APP_USERNAME) && sameText(password, process.env.APP_PASSWORD)) {
    failures.delete(ip);
    const user = Buffer.from(String(username)).toString('base64url');
    const until = Date.now() + DAYS * 24 * 60 * 60 * 1000;
    const secure = req.secure ? '; Secure' : '';
    res.set('Set-Cookie', `${COOKIE}=${user}.${until}.${sign(`${user}.${until}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure}`);
    return res.json({ ok: true });
  }
  if (failures.size > 1000) for (const [k, v] of failures) if (Date.now() - v.first > 15 * 60 * 1000) failures.delete(k);
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60 * 1000) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
  return res.status(401).json({ error: 'Wrong username or password.' });
}

function logout(_req, res) {
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

function requireAuth(req, res, next) {
  if (signedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect('/login');
}

module.exports = { settingsProblems, requireAuth, login, logout, signedIn, signInOff };
