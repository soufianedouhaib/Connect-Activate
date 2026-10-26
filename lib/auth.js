'use strict';
/*
 * Accounts, roles and sessions.
 *
 * Roles
 *   coordinator  Order Coordinator: submits orders, sees their own orders and reports.
 *   desk         Fallout Desk: works held orders, records the resolution, sees all orders.
 *   admin        Everything, plus users, settings and the system page.
 *
 * Built-in demo accounts sign in by picking them on the sign-in page (when demo
 * sign-in is on). Added users sign in with an email and password.
 * Sessions are a signed cookie (HMAC-SHA256), so no session table is needed.
 */
const crypto = require('crypto');
const store = require('./store');

const ROLES = {
  coordinator: 'Order Coordinator',
  desk: 'Fallout Desk',
  admin: 'Admin'
};

const DEMO_USERS = [
  { id: 'u-coord', name: 'Liam Carter', email: 'liam.carter@orbittelecom.example', role: 'coordinator', demo: true },
  { id: 'u-desk', name: 'Aisha Noor', email: 'aisha.noor@orbittelecom.example', role: 'desk', demo: true },
  { id: 'u-admin', name: 'Daniel Okafor', email: 'daniel.okafor@orbittelecom.example', role: 'admin', demo: true }
];

const USERS_KEY = 'ca:users';
const COOKIE = 'ca_session';
const SESSION_HOURS = 12;

let SECRET = process.env.SESSION_SECRET || '';
const secretIsEphemeral = !SECRET;
if (!SECRET) SECRET = crypto.randomBytes(32).toString('hex');

function demoSignInEnabled() {
  return String(process.env.DEMO_SIGN_IN || 'on').toLowerCase() !== 'off';
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function checkPassword(pw, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(pw), salt, 64);
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

async function addedUsers() {
  const all = await store.hgetall(USERS_KEY);
  return Object.values(all || {}).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}
async function allUsers() {
  const added = await addedUsers();
  return DEMO_USERS.concat(added);
}
async function findUser(id) {
  const d = DEMO_USERS.find((u) => u.id === id);
  if (d) return d;
  const s = await store.hget(USERS_KEY, id);
  if (!s) return null;
  try { const u = JSON.parse(s); return u.disabled ? null : u; } catch (e) { return null; }
}
async function findByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return (await allUsers()).find((u) => u.email.toLowerCase() === e) || null;
}
async function saveUser(u) { await store.hset(USERS_KEY, u.id, JSON.stringify(u)); }
async function removeUser(id) { await store.hdel(USERS_KEY, id); }

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function setSession(res, user) {
  const token = sign({ uid: user.id, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  const secure = process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_HOURS * 3600 + secure);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

async function currentUser(req) {
  const p = verify(readCookie(req, COOKIE));
  if (!p) return null;
  const u = await findUser(p.uid);
  if (!u) return null;
  if (u.demo && !demoSignInEnabled()) return null;
  return u;
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLES[u.role] || u.role, demo: !!u.demo };
}

module.exports = {
  ROLES, DEMO_USERS, demoSignInEnabled, secretIsEphemeral,
  hashPassword, checkPassword, allUsers, addedUsers, findUser, findByEmail, saveUser, removeUser,
  setSession, clearSession, currentUser, publicUser
};
