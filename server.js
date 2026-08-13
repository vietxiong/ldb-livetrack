// server.js — v2: login (admin/controller), device pairing codes, ownership scoping.
//
// Phones do NOT log in. Flow:
//   controller/admin creates a device  -> server mints a pairing CODE
//   member enters that code in the app -> phone is bound to that device
//   phone POSTs /api/track with the code (no user auth)
//
// Visibility: admin sees all devices; controller sees only devices it owns.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SheetsDB } from './sheets.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const OFFLINE_AFTER = Number(process.env.OFFLINE_AFTER_SECONDS || 90);
const MOCK = process.env.MOCK_SHEETS === '1';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
// How long to keep location history (hours). 24 ≈ "just today". Older rows are auto-deleted.
const RETAIN_HOURS = Number(process.env.LOCATIONS_RETENTION_HOURS || 24);

const db = new SheetsDB({ mock: MOCK, sheetId: process.env.GOOGLE_SHEET_ID, serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE });

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Serve the built dashboard (copy the app's dist into backend/public before
// deploying). The dashboard uses hash routing, so static serving is enough.
app.use(express.static(path.join(__dirname, 'public')));

// ---- id / code helpers ----
function id(prefix) { return `${prefix}_${crypto.randomBytes(6).toString('hex')}`; }
function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let c = '';
  for (let i = 0; i < 6; i++) c += alphabet[crypto.randomInt(alphabet.length)];
  return c;
}

// ---- auth middleware ----
function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const p = token && verifyToken(token);
  const user = p && db.getUserById(p.id);
  if (!user) return res.status(401).json({ error: 'not authenticated' });
  req.user = { id: user.userId, username: user.username, role: user.role };
  next();
}
const requireRole = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'forbidden' });

// ---- scoping ----
function canSeeDevice(actor, d) {
  if (!d) return false;
  return actor.role === 'admin' || d.ownerId === actor.id;
}
function visibleDevices(actor) { return db.getDevices().filter((d) => canSeeDevice(actor, d)); }
function visibleUsers(actor) { return actor.role === 'admin' ? db.getUsers() : []; }

function decorateDevice(d) {
  const lastSeenMs = d.lastSeen ? Date.parse(d.lastSeen) : 0;
  const ageSec = lastSeenMs ? (Date.now() - lastSeenMs) / 1000 : Infinity;
  const owner = d.ownerId ? db.getUserById(d.ownerId) : null;
  const disabled = d.disabled === 'yes' || d.disabled === true;
  return {
    deviceId: d.deviceId, name: d.name, pairingCode: d.pairingCode, ownerId: d.ownerId,
    ownerName: owner ? owner.username : '', platform: d.platform, model: d.model,
    paired: d.paired === 'yes' || d.paired === true, disabled,
    createdAt: d.createdAt, lastSeen: d.lastSeen,
    lat: d.lat === '' ? undefined : d.lat, lng: d.lng === '' ? undefined : d.lng, accuracy: d.accuracy,
    // A disabled device is never shown as online/live.
    online: !disabled && ageSec <= OFFLINE_AFTER, ageSeconds: Number.isFinite(ageSec) ? Math.round(ageSec) : null,
  };
}
const publicUser = (u) => ({ userId: u.userId, username: u.username, role: u.role, createdBy: u.createdBy, createdAt: u.createdAt });

// ---- health ----
app.get('/health', (req, res) => res.json({ ok: true, mock: MOCK, users: db.getUsers().length, devices: db.getDevices().length }));

// ---- auth ----
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = username && db.getUserByUsername(username);
  if (!u || !verifyPassword(password || '', u.passwordHash)) return res.status(401).json({ error: 'invalid username or password' });
  res.json({ token: signToken(u), user: publicUser(u) });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

// ---- users (admin manages controllers) ----
app.get('/api/users', auth, (req, res) => res.json({ users: visibleUsers(req.user).map(publicUser) }));
app.post('/api/users', auth, requireRole('admin'), async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password, role required' });
  if (!['admin', 'controller'].includes(role)) return res.status(400).json({ error: 'role must be admin or controller' });
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'username already taken' });
  const u = await db.createUser({ userId: id('u'), username, passwordHash: hashPassword(password), role, createdBy: req.user.id, createdAt: new Date().toISOString() });
  res.json({ user: publicUser(u) });
});
app.delete('/api/users/:id', auth, requireRole('admin'), async (req, res) => {
  const t = db.getUserById(req.params.id);
  if (!t) return res.status(404).json({ error: 'user not found' });
  if (t.userId === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
  await db.deleteUser(t.userId);
  res.json({ ok: true });
});

// ---- devices (controller/admin manage; each has a pairing code) ----
app.get('/api/devices', auth, (req, res) => res.json({ devices: visibleDevices(req.user).map(decorateDevice) }));

app.post('/api/devices', auth, requireRole('admin', 'controller'), async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'device name required' });
  let code; do { code = pairingCode(); } while (db.getDeviceByCode(code));
  const d = await db.createDevice({
    deviceId: id('d'), name, pairingCode: code, ownerId: req.user.id, hardwareId: '',
    platform: '', model: '', paired: 'no', disabled: 'no', createdAt: new Date().toISOString(), lastSeen: '', lat: '', lng: '', accuracy: '',
  });
  res.json({ device: decorateDevice(d) });
});

// Admin/controller renames a device (member cannot).
app.post('/api/devices/:id/name', auth, requireRole('admin', 'controller'), async (req, res) => {
  const d = db.getDevice(req.params.id);
  if (!canSeeDevice(req.user, d)) return res.status(403).json({ error: 'forbidden' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  d.name = name;
  await db.saveDevice(d);
  broadcastDevice(d, 'location'); // refresh the label on the live map
  res.json({ device: decorateDevice(d) });
});

// Admin/controller enables or disables a device's sharing (member cannot).
app.post('/api/devices/:id/state', auth, requireRole('admin', 'controller'), async (req, res) => {
  const d = db.getDevice(req.params.id);
  if (!canSeeDevice(req.user, d)) return res.status(403).json({ error: 'forbidden' });
  d.disabled = req.body?.disabled ? 'yes' : 'no';
  await db.saveDevice(d);
  broadcastDevice(d, 'location');
  res.json({ device: decorateDevice(d) });
});

app.delete('/api/devices/:id', auth, requireRole('admin', 'controller'), async (req, res) => {
  const d = db.getDevice(req.params.id);
  if (!canSeeDevice(req.user, d)) return res.status(403).json({ error: 'forbidden' });
  await db.deleteDevice(d.deviceId);
  res.json({ ok: true });
});

app.get('/api/devices/:id/locations', auth, async (req, res) => {
  const d = db.getDevice(req.params.id);
  if (!canSeeDevice(req.user, d)) return res.status(403).json({ error: 'forbidden' });
  res.json({ deviceId: d.deviceId, locations: await db.getDeviceLocations(d.deviceId, Math.min(Number(req.query.limit || 100), 1000)) });
});

// ---- maintenance: admin can delete old history now ----
app.post('/api/maintenance/prune', auth, requireRole('admin'), async (req, res) => {
  const hours = Number(req.body?.hours ?? RETAIN_HOURS);
  try { const r = await db.pruneLocations(Number.isFinite(hours) ? hours : RETAIN_HOURS); res.json({ ok: true, deleted: r.deleted }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- pairing + tracking (phone side; auth is the pairing code) ----
app.post('/api/pair', async (req, res) => {
  const { code, platform, model, hardwareId } = req.body || {};
  const d = db.getDeviceByCode((code || '').toUpperCase().trim());
  if (!d) return res.status(404).json({ error: 'invalid device code' });
  d.paired = 'yes';
  if (platform) d.platform = platform;
  if (model) d.model = model;
  if (hardwareId) d.hardwareId = hardwareId;
  await db.saveDevice(d);
  broadcastDevice(d, 'register');
  res.json({ ok: true, deviceId: d.deviceId, name: d.name });
});

app.post('/api/track', async (req, res) => {
  const { code, lat, lng, accuracy } = req.body || {};
  const d = db.getDeviceByCode((code || '').toUpperCase().trim());
  if (!d) return res.status(404).json({ error: 'invalid device code' });
  if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat, lng required' });
  // If an admin/controller disabled this device, ignore updates (stay hidden).
  if (d.disabled === 'yes' || d.disabled === true) return res.json({ ok: true, disabled: true });
  await db.recordLocation(d, lat, lng, accuracy);
  broadcastDevice(d, 'location');
  res.json({ ok: true });
});

// ---- WebSocket (scoped) ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const p = verifyToken(new URL(req.url, 'http://localhost').searchParams.get('token') || '');
  const user = p && db.getUserById(p.id);
  if (!user) { ws.close(4001, 'unauthorized'); return; }
  ws.user = { id: user.userId, username: user.username, role: user.role };
  ws.send(JSON.stringify({ type: 'snapshot', devices: visibleDevices(ws.user).map(decorateDevice) }));
});
function broadcastDevice(d, type) {
  const dec = decorateDevice(d);
  wss.clients.forEach((c) => { if (c.readyState === 1 && c.user && canSeeDevice(c.user, d)) c.send(JSON.stringify({ type, device: dec })); });
}

// ---- start ----
async function seedAdmin() {
  if (db.getUsers().length === 0) {
    await db.createUser({ userId: id('u'), username: 'admin', passwordHash: hashPassword(DEFAULT_ADMIN_PASSWORD), role: 'admin', createdBy: '', createdAt: new Date().toISOString() });
    console.log(`[server] Seeded admin — username: admin  password: ${DEFAULT_ADMIN_PASSWORD}`);
  }
}
// Keep the Locations sheet from growing forever: prune on startup, then hourly.
function schedulePrune() {
  const run = () => db.pruneLocations(RETAIN_HOURS).catch((e) => console.error('[prune]', e.message));
  run();
  setInterval(run, 60 * 60 * 1000);
}

db.init().then(seedAdmin).then(schedulePrune).then(() => server.listen(PORT, () => console.log(`[server] Listening on http://localhost:${PORT} (mock=${MOCK}, keep ${RETAIN_HOURS}h history)`)))
  .catch((e) => {
    console.error('[server] Failed to start:', e.message);
    // Detailed Google API error (which call / field is invalid):
    if (e.response && e.response.data) console.error('[server] Google API said:', JSON.stringify(e.response.data, null, 2));
    if (e.errors) console.error('[server] errors:', JSON.stringify(e.errors, null, 2));
    console.error('[server] full error:', e);
    process.exit(1);
  });