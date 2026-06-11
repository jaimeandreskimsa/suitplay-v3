/*
 * SuitPlay Pro — servidor del producto (modo SaaS por suscripción).
 *
 * Stack: Node.js puro, CERO dependencias externas.
 *   - node:http       servidor web (estaticos + API JSON)
 *   - node:sqlite     base de datos (usuarios, sesiones, uso, pagos)
 *   - node:crypto     scrypt para contrasenas + tokens de sesion
 *
 * Arranque:   node --experimental-sqlite server.js        (puerto 8080)
 * Admin CLI:  node --experimental-sqlite server.js admin correo@x.com
 *                 -> convierte al usuario en super admin (panel /admin)
 *             node --experimental-sqlite server.js grant correo@x.com 30
 *                 -> regala 30 dias de suscripcion (cortesia/soporte)
 *
 * Modelo SaaS: al registrarse se activa una prueba de TRIAL_DAYS dias con
 * uso ilimitado. Despues, suscripcion Mensual o Anual (PLANS). Mientras la
 * suscripcion este activa el uso es ilimitado (no hay consumo por analisis;
 * cada analisis se registra solo como metrica).
 *
 * Pagos: Stripe Checkout en modo suscripcion. Activar con:
 *             set STRIPE_SECRET_KEY=sk_live_...
 * La renovacion se verifica de forma diferida: cuando una suscripcion
 * aparece vencida y hay stripe_sub, se consulta Stripe y se extiende.
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +(process.env.PORT || 8080);
const TRIAL_DAYS = 7;
const SESSION_DAYS = 30;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const DAY = 86400000;

const PLANS = [
  { id: 'mensual', name: 'Plan Mensual', usd: 9,  interval: 'month', label: '$9 / mes' },
  { id: 'anual',   name: 'Plan Anual',   usd: 79, interval: 'year',  label: '$79 / año' },
];

// ---------------------------------------------------------------- DB
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'suitplay.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'trial',
    sub_until INTEGER NOT NULL DEFAULT 0,
    stripe_sub TEXT DEFAULT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    combo TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    session_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    ts INTEGER NOT NULL
  );
`);

// ---------------------------------------------------------------- helpers
const scryptHash = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const now = () => Date.now();

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 64 * 1024) { reject(new Error('body grande')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  const c = req.headers.cookie || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function setSessionCookie(res, token, expires) {
  res.setHeader('Set-Cookie',
    `sp_session=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expires).toUTCString()}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie',
    'sp_session=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

// Modo abierto (sin login): por defecto la app es de acceso libre para poder
// probarla sin registrarse. Toda petición actúa como este usuario (admin, sin
// caducidad). Para activar el modo SaaS con cuentas: set AUTH_DISABLED=0
const AUTH_DISABLED = process.env.AUTH_DISABLED !== '0';
const LOCAL_USER = {
  id: 0, email: 'local@localhost', plan: 'local',
  sub_until: Number.MAX_SAFE_INTEGER, stripe_sub: null, is_admin: 1, created: 0,
};

function getUser(req) {
  if (AUTH_DISABLED) return LOCAL_USER;
  const token = getCookie(req, 'sp_session');
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s || s.expires < now()) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const rl = new Map();
function rateLimited(ip) {
  const t = now();
  const e = rl.get(ip) || { count: 0, reset: t + 60000 };
  if (t > e.reset) { e.count = 0; e.reset = t + 60000; }
  e.count++;
  rl.set(ip, e);
  return e.count > 12;
}

function isActive(u) { return u.sub_until > now(); }

function publicUser(u) {
  return {
    email: u.email,
    plan: u.plan,
    subUntil: u.sub_until,
    active: isActive(u),
    daysLeft: Math.max(0, Math.ceil((u.sub_until - now()) / DAY)),
    isAdmin: !!u.is_admin,
  };
}

// ---------------------------------------------------------------- Stripe
async function stripePost(pathname, params) {
  const r = await fetch('https://api.stripe.com' + pathname, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + STRIPE_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  return r.json();
}

async function stripeGet(pathname) {
  const r = await fetch('https://api.stripe.com' + pathname, {
    headers: { 'Authorization': 'Bearer ' + STRIPE_KEY },
  });
  return r.json();
}

/** Si la suscripcion local vencio pero hay stripe_sub, consulta Stripe y
 *  extiende hasta el fin del periodo vigente (renovacion diferida). */
async function refreshSubscription(u) {
  if (!STRIPE_KEY || !u.stripe_sub || isActive(u)) return u;
  try {
    const sub = await stripeGet('/v1/subscriptions/' + encodeURIComponent(u.stripe_sub));
    if (sub.status === 'active' || sub.status === 'trialing') {
      const until = (sub.current_period_end || 0) * 1000;
      if (until > u.sub_until) {
        db.prepare('UPDATE users SET sub_until = ? WHERE id = ?').run(until, u.id);
        return db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
      }
    }
  } catch { /* sin red: se reintenta en la proxima peticion */ }
  return u;
}

// ---------------------------------------------------------------- API
const routes = {

  'POST /api/register': async (req, res, body) => {
    if (rateLimited(req.socket.remoteAddress)) {
      return json(res, 429, { error: 'Demasiados intentos, espera un minuto.' });
    }
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Correo no válido.' });
    if (password.length < 8) return json(res, 400, { error: 'La contraseña necesita al menos 8 caracteres.' });
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      return json(res, 409, { error: 'Ese correo ya está registrado.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const info = db.prepare(
      `INSERT INTO users (email, pass_hash, salt, plan, sub_until, created)
       VALUES (?,?,?,?,?,?)`)
      .run(email, scryptHash(password, salt), salt, 'trial',
           now() + TRIAL_DAYS * DAY, now());
    const token = newToken();
    const expires = now() + SESSION_DAYS * DAY;
    db.prepare('INSERT INTO sessions (token, user_id, created, expires) VALUES (?,?,?,?)')
      .run(token, info.lastInsertRowid, now(), expires);
    setSessionCookie(res, token, expires);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    json(res, 200, { user: publicUser(u) });
  },

  'POST /api/login': async (req, res, body) => {
    if (rateLimited(req.socket.remoteAddress)) {
      return json(res, 429, { error: 'Demasiados intentos, espera un minuto.' });
    }
    const email = String(body.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u || scryptHash(String(body.password || ''), u.salt) !== u.pass_hash) {
      return json(res, 401, { error: 'Correo o contraseña incorrectos.' });
    }
    const token = newToken();
    const expires = now() + SESSION_DAYS * DAY;
    db.prepare('INSERT INTO sessions (token, user_id, created, expires) VALUES (?,?,?,?)')
      .run(token, u.id, now(), expires);
    setSessionCookie(res, token, expires);
    json(res, 200, { user: publicUser(await refreshSubscription(u)) });
  },

  'POST /api/logout': async (req, res) => {
    const token = getCookie(req, 'sp_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    clearSessionCookie(res);
    json(res, 200, { ok: true });
  },

  'GET /api/me': async (req, res) => {
    let u = getUser(req);
    if (!u) return json(res, 401, { error: 'no autenticado' });
    u = await refreshSubscription(u);
    json(res, 200, { user: publicUser(u) });
  },

  /** Registra un analisis (metrica). Requiere suscripcion activa. */
  'POST /api/log-use': async (req, res, body) => {
    let u = getUser(req);
    if (!u) return json(res, 401, { error: 'no autenticado' });
    u = await refreshSubscription(u);
    if (!isActive(u)) {
      return json(res, 402, { error: 'Suscripción no activa.' });
    }
    db.prepare('INSERT INTO usage (user_id, combo, ts) VALUES (?,?,?)')
      .run(u.id, String(body.combo || '').slice(0, 64), now());
    json(res, 200, { ok: true });
  },

  'GET /api/pricing': async (req, res) => {
    json(res, 200, {
      plans: PLANS.map(p => ({ id: p.id, name: p.name, usd: p.usd, label: p.label })),
      paymentsEnabled: !!STRIPE_KEY,
      trialDays: TRIAL_DAYS,
      authDisabled: AUTH_DISABLED,
    });
  },

  'POST /api/checkout': async (req, res, body) => {
    const u = getUser(req);
    if (!u) return json(res, 401, { error: 'no autenticado' });
    const plan = PLANS.find(p => p.id === body.plan);
    if (!plan) return json(res, 400, { error: 'plan desconocido' });
    if (!STRIPE_KEY) {
      return json(res, 200, {
        url: null,
        message: 'Los pagos aún no están configurados (falta STRIPE_SECRET_KEY). ' +
                 'Contacta al administrador para activar tu suscripción.',
      });
    }
    const origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;
    const session = await stripePost('/v1/checkout/sessions', {
      'mode': 'subscription',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'SuitPlay Pro — ' + plan.name,
      'line_items[0][price_data][unit_amount]': String(plan.usd * 100),
      'line_items[0][price_data][recurring][interval]': plan.interval,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': String(u.id),
      'metadata[plan]': plan.id,
      'subscription_data[metadata][user_id]': String(u.id),
      'success_url': origin + '/?pago={CHECKOUT_SESSION_ID}',
      'cancel_url': origin + '/',
    });
    if (!session.url) return json(res, 502, { error: 'Stripe: ' + (session.error?.message || '?') });
    json(res, 200, { url: session.url });
  },

  'POST /api/confirm-payment': async (req, res, body) => {
    const u = getUser(req);
    if (!u) return json(res, 401, { error: 'no autenticado' });
    if (!STRIPE_KEY) return json(res, 400, { error: 'pagos no configurados' });
    const sid = String(body.session_id || '');
    if (!sid) return json(res, 400, { error: 'falta session_id' });
    if (db.prepare('SELECT session_id FROM payments WHERE session_id = ?').get(sid)) {
      const me = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
      return json(res, 200, { user: publicUser(me), already: true });
    }
    const s = await stripeGet('/v1/checkout/sessions/' + encodeURIComponent(sid));
    if (s.payment_status !== 'paid' || String(s.metadata?.user_id) !== String(u.id)) {
      return json(res, 400, { error: 'pago no verificable' });
    }
    const plan = PLANS.find(p => p.id === s.metadata.plan);
    if (!plan) return json(res, 400, { error: 'plan desconocido' });
    // fin del periodo de la suscripcion (o aproximacion si no es accesible)
    let until = now() + (plan.interval === 'year' ? 365 : 31) * DAY;
    const subId = s.subscription || null;
    if (subId) {
      const sub = await stripeGet('/v1/subscriptions/' + encodeURIComponent(subId));
      if (sub.current_period_end) until = sub.current_period_end * 1000;
    }
    db.prepare('INSERT INTO payments (session_id, user_id, plan, amount_usd, ts) VALUES (?,?,?,?,?)')
      .run(sid, u.id, plan.id, (s.amount_total || plan.usd * 100) / 100, now());
    db.prepare('UPDATE users SET plan = ?, sub_until = ?, stripe_sub = ? WHERE id = ?')
      .run(plan.id, until, subId, u.id);
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    json(res, 200, { user: publicUser(me) });
  },

  // ------------------------------------------------ super admin
  'GET /api/admin/overview': async (req, res) => {
    const admin = getUser(req);
    if (!admin || !admin.is_admin) return json(res, 403, { error: 'solo admin' });
    const t = now();
    const users = db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM usage WHERE user_id = u.id) AS analyses,
        (SELECT MAX(ts) FROM usage WHERE user_id = u.id) AS last_use
      FROM users u ORDER BY u.created DESC`).all();
    const payments = db.prepare(`
      SELECT p.*, u.email FROM payments p
      JOIN users u ON u.id = p.user_id ORDER BY p.ts DESC LIMIT 500`).all();
    const stats = {
      totalUsers: users.length,
      activeSubs: users.filter(u => u.sub_until > t && u.plan !== 'trial').length,
      onTrial: users.filter(u => u.sub_until > t && u.plan === 'trial').length,
      expired: users.filter(u => u.sub_until <= t).length,
      revenueUsd: payments.reduce((a, p) => a + p.amount_usd, 0),
      paymentsCount: payments.length,
      analysesTotal: db.prepare('SELECT COUNT(*) AS c FROM usage').get().c,
      analyses30d: db.prepare('SELECT COUNT(*) AS c FROM usage WHERE ts > ?').get(t - 30 * DAY).c,
    };
    json(res, 200, {
      stats,
      users: users.map(u => ({
        email: u.email, plan: u.plan, subUntil: u.sub_until,
        active: u.sub_until > t, isAdmin: !!u.is_admin,
        created: u.created, analyses: u.analyses, lastUse: u.last_use,
      })),
      payments: payments.map(p => ({
        email: p.email, plan: p.plan, amountUsd: p.amount_usd,
        ts: p.ts, sessionId: p.session_id,
      })),
    });
  },

  'POST /api/admin/extend': async (req, res, body) => {
    const admin = getUser(req);
    if (!admin || !admin.is_admin) return json(res, 403, { error: 'solo admin' });
    const email = String(body.email || '').toLowerCase();
    const days = Math.max(-3650, Math.min(3650, +body.days || 0));
    const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!u) return json(res, 404, { error: 'usuario no encontrado' });
    const base = Math.max(u.sub_until, now());
    const until = base + days * DAY;
    db.prepare('UPDATE users SET sub_until = ?, plan = CASE WHEN plan = ? THEN ? ELSE plan END WHERE id = ?')
      .run(until, 'trial', 'cortesia', u.id);
    json(res, 200, { ok: true, subUntil: until });
  },
};

// ---------------------------------------------------------------- estáticos
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('no encontrado'); }
    const ext = path.extname(file).toLowerCase();
    // El código (HTML/JS) se revalida siempre para que una actualización del
    // motor llegue de inmediato (el worker carga engine.js con importScripts y
    // una copia cacheada serviría una versión vieja). Los recursos estáticos
    // (iconos, manifest) sí se cachean.
    const revalidate = ext === '.html' || ext === '.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  p = path.normalize(p).replace(/^([.\\/])+/, '');
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  serveFile(res, file);
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const handler = routes[req.method + ' ' + url.pathname];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      await handler(req, res, body);
    } catch (e) {
      json(res, 500, { error: 'error interno: ' + e.message });
    }
    return;
  }
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'no existe' });
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  // panel admin: protegido en el servidor
  if (url.pathname === '/admin' || url.pathname === '/admin.html') {
    const u = getUser(req);
    if (!u || !u.is_admin) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
  }
  serveStatic(req, res, url.pathname);
});

// ---------------------------------------------------------------- CLI
const [, , cmd, arg1, arg2] = process.argv;
if (cmd === 'admin') {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(arg1 || '').toLowerCase());
  if (!u) { console.error('usuario no encontrado:', arg1); process.exit(1); }
  db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
  console.log(`OK: ${u.email} ahora es super admin (panel en /admin)`);
  process.exit(0);
}
if (cmd === 'grant') {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(arg1 || '').toLowerCase());
  if (!u) { console.error('usuario no encontrado:', arg1); process.exit(1); }
  const days = +arg2 || 30;
  const until = Math.max(u.sub_until, now()) + days * DAY;
  db.prepare('UPDATE users SET sub_until = ? WHERE id = ?').run(until, u.id);
  console.log(`OK: ${u.email} con suscripción hasta ${new Date(until).toISOString().slice(0, 10)}`);
  process.exit(0);
}

setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(now());
}, 3600000).unref();

server.listen(PORT, () => {
  console.log(`SuitPlay Pro (SaaS) escuchando en http://localhost:${PORT}`);
  console.log(`Pagos Stripe: ${STRIPE_KEY ? 'ACTIVADOS' : 'no configurados (set STRIPE_SECRET_KEY=...)'}`);
});
