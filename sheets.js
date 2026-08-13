// sheets.js — Google Sheets data layer (v2: pairing-code devices).
//
// Tabs:
//   Users     -> admin / controller accounts (login)
//   Devices   -> tracked phones; each has a pairing code and an owner (controller/admin)
//   Locations -> append-only history
//
// The phone never logs in. A controller creates a device (which mints a pairing
// code), gives the code to the member, and the phone pairs with that code.

import { google } from 'googleapis';
import fs from 'node:fs';

const USERS_TAB = 'Users';
const DEVICES_TAB = 'Devices';
const LOCATIONS_TAB = 'Locations';

const USER_HEADERS = ['userId', 'username', 'passwordHash', 'role', 'createdBy', 'createdAt'];
const DEVICE_HEADERS = [
  'deviceId', 'name', 'pairingCode', 'ownerId', 'hardwareId', 'platform', 'model',
  'paired', 'disabled', 'createdAt', 'lastSeen', 'lat', 'lng', 'accuracy',
];
const LOCATION_HEADERS = ['deviceId', 'timestamp', 'lat', 'lng', 'accuracy'];
const DEVICE_COL_END = 'N'; // 14 columns

export class SheetsDB {
  constructor({ mock = false, sheetId = '', serviceAccountFile = '' } = {}) {
    this.mock = mock;
    this.sheetId = sheetId;
    this.serviceAccountFile = serviceAccountFile;
    this.sheets = null;
    this.userCache = new Map();
    this.deviceCache = new Map();
    this.sheetIds = {}; // tab title -> numeric sheetId (needed to delete rows)
    this._mockHistory = {};
  }

  async init() {
    if (!this.mock) {
      // Strip any accidental spaces/newlines/quotes from the pasted Sheet ID.
      this.sheetId = String(this.sheetId || '').trim().replace(/^["']|["']$/g, '');
      console.log('[sheets] Using sheetId =', JSON.stringify(this.sheetId), '(length', this.sheetId.length + ')');
      if (!this.sheetId) throw new Error('GOOGLE_SHEET_ID is not set');
      const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
      // Use the explicit JWT client (token-exchange flow). This avoids the
      // "self-signed JWT" that GoogleAuth uses by default, which the Sheets API
      // rejects with 400 INVALID_ARGUMENT on some setups.
      let creds;
      if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      } else {
        if (!fs.existsSync(this.serviceAccountFile)) throw new Error('Service account file not found. Set MOCK_SHEETS=1 to test without Google, or set GOOGLE_SERVICE_ACCOUNT_JSON.');
        creds = JSON.parse(fs.readFileSync(this.serviceAccountFile, 'utf8'));
      }
      const authClient = new google.auth.JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes,
      });
      await authClient.authorize();
      this.sheets = google.sheets({ version: 'v4', auth: authClient });
      await this.#ensureTabs();
      await this.#loadCaches();
    } else {
      console.log('[sheets] MOCK mode — in-memory only.');
    }
  }

  // ---- Users ----
  getUsers() { return [...this.userCache.values()]; }
  getUserById(id) { return this.userCache.get(id) || null; }
  getUserByUsername(name) { return [...this.userCache.values()].find((u) => u.username.toLowerCase() === String(name).toLowerCase()) || null; }
  async createUser(u) {
    this.userCache.set(u.userId, u);
    if (!this.mock) await this.#append(USERS_TAB, USER_HEADERS.map((h) => u[h]));
    return u;
  }
  async deleteUser(id) {
    this.userCache.delete(id);
    if (!this.mock) await this.#clearRow(USERS_TAB, id);
  }

  // ---- Devices ----
  getDevices() { return [...this.deviceCache.values()]; }
  getDevice(id) { return this.deviceCache.get(id) || null; }
  getDeviceByCode(code) { return [...this.deviceCache.values()].find((d) => d.pairingCode === code) || null; }

  async createDevice(d) {
    this.deviceCache.set(d.deviceId, d);
    if (!this.mock) await this.#append(DEVICES_TAB, DEVICE_HEADERS.map((h) => d[h]));
    return d;
  }
  async saveDevice(d) {
    this.deviceCache.set(d.deviceId, d);
    if (!this.mock) await this.#updateDeviceRow(d);
    return d;
  }
  async deleteDevice(id) {
    this.deviceCache.delete(id);
    if (!this.mock) await this.#clearRow(DEVICES_TAB, id);
  }

  async recordLocation(device, lat, lng, accuracy) {
    const timestamp = new Date().toISOString();
    device.lat = lat; device.lng = lng; device.accuracy = accuracy ?? '';
    device.lastSeen = timestamp;
    this.deviceCache.set(device.deviceId, device);
    if (!this.mock) {
      this.#append(LOCATIONS_TAB, [device.deviceId, timestamp, lat, lng, accuracy ?? '']).catch((e) => console.error('[sheets] history:', e.message));
      await this.#updateDeviceRow(device);
    } else {
      (this._mockHistory[device.deviceId] ||= []).push({ deviceId: device.deviceId, timestamp, lat, lng, accuracy });
    }
    return device;
  }

  async getDeviceLocations(deviceId, limit = 100) {
    if (this.mock) return (this._mockHistory[deviceId] || []).slice(-limit).reverse();
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `${LOCATIONS_TAB}!A2:E` });
    return (res.data.values || []).filter((r) => r[0] === deviceId).slice(-limit).reverse()
      .map((r) => ({ deviceId: r[0], timestamp: r[1], lat: Number(r[2]), lng: Number(r[3]), accuracy: r[4] }));
  }

  // ---- private ----
  async #ensureTabs() {
    let meta;
    try {
      meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId, fields: 'sheets.properties.title' });
    } catch (e) {
      // Translate Google's error into a plain-English verdict so the log tells
      // you EXACTLY what to fix, instead of a raw 400/403/404.
      const status = e.code || e.response?.status;
      const saEmail = this._serviceAccountEmail || '(the service account)';
      let verdict;
      if (status === 400) {
        verdict = `The Sheets API cannot open GOOGLE_SHEET_ID "${this.sheetId}". `
          + `This means that ID is NOT a native Google Sheet — it is either a wrong/incomplete ID, or it points to an uploaded Excel file, a Google Doc, or a Drive folder (those give 400). `
          + `FIX: go to https://sheets.google.com, click "Blank spreadsheet", copy the new ID from the URL (between /d/ and /edit), share it with the service account as Editor, and set that as GOOGLE_SHEET_ID.`;
      } else if (status === 403) {
        verdict = `The sheet exists but is NOT shared with the service account. `
          + `Open the sheet -> Share -> add "${saEmail}" as Editor -> Send.`;
      } else if (status === 404) {
        verdict = `No spreadsheet has ID "${this.sheetId}". The ID is wrong or the sheet was deleted. Copy the ID again from the real sheet's URL.`;
      } else {
        verdict = `Could not open the sheet (status ${status}): ${e.message}`;
      }
      const err = new Error('SHEET ACCESS PROBLEM -> ' + verdict);
      err.friendly = true;
      throw err;
    }
    const titles = meta.data.sheets.map((s) => s.properties.title);
    const toCreate = [USERS_TAB, DEVICES_TAB, LOCATIONS_TAB].filter((t) => !titles.includes(t));
    if (toCreate.length) {
      await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.sheetId, requestBody: { requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })) } });
    }
    await this.#ensureHeader(USERS_TAB, USER_HEADERS);
    await this.#ensureHeader(DEVICES_TAB, DEVICE_HEADERS);
    await this.#ensureHeader(LOCATIONS_TAB, LOCATION_HEADERS);
    // Capture each tab's numeric sheetId (needed for deleting rows when pruning).
    const ids = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId, fields: 'sheets.properties(title,sheetId)' });
    this.sheetIds = {};
    ids.data.sheets.forEach((s) => { this.sheetIds[s.properties.title] = s.properties.sheetId; });
  }

  // Delete Locations rows older than `retentionHours` (keeps recent history so
  // the sheet doesn't grow forever). Rows are appended oldest-first, so the old
  // ones are a contiguous block at the top — we delete them in one call.
  async pruneLocations(retentionHours = 24) {
    const cutoff = Date.now() - retentionHours * 3600 * 1000;
    if (this.mock) {
      for (const id of Object.keys(this._mockHistory)) {
        this._mockHistory[id] = (this._mockHistory[id] || []).filter((r) => Date.parse(r.timestamp) >= cutoff);
      }
      return { deleted: 0 };
    }
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `${LOCATIONS_TAB}!B2:B` });
    const rows = res.data.values || [];
    let k = 0;
    for (const r of rows) {
      const t = Date.parse(r[0]);
      if (!Number.isNaN(t) && t < cutoff) k++; else break; // stop at first row we keep
    }
    if (k <= 0) return { deleted: 0 };
    const sheetId = this.sheetIds[LOCATIONS_TAB];
    if (sheetId == null) return { deleted: 0 };
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.sheetId,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1 + k } } }] },
    });
    console.log(`[sheets] Pruned ${k} location row(s) older than ${retentionHours}h.`);
    return { deleted: k };
  }
  async #ensureHeader(tab, headers) {
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `${tab}!A1:A1` });
    if (!(res.data.values && res.data.values[0] && res.data.values[0][0])) {
      await this.sheets.spreadsheets.values.update({ spreadsheetId: this.sheetId, range: `${tab}!A1`, valueInputOption: 'RAW', requestBody: { values: [headers] } });
    }
  }
  async #loadCaches() {
    const u = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `${USERS_TAB}!A2:F` });
    (u.data.values || []).forEach((r) => { const o = {}; USER_HEADERS.forEach((h, i) => o[h] = r[i] ?? ''); if (o.userId) this.userCache.set(o.userId, o); });
    const d = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `${DEVICES_TAB}!A2:${DEVICE_COL_END}` });
    (d.data.values || []).forEach((r) => { const o = {}; DEVICE_HEADERS.forEach((h, i) => o[h] = r[i] ?? ''); if (o.lat !== '') o.lat = Number(o.lat); if (o.lng !== '') o.lng = Number(o.lng); if (o.deviceId) this.deviceCache.set(o.deviceId, o); });
    console.log(`[sheets] Loaded ${this.userCache.size} user(s), ${this.deviceCache.size} device(s).`);
  }
  async #append(tab, values) {
    await this.sheets.spreadsheets.values.append({ spreadsheetId: this.sheetId, range: `${tab}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [values] } });
  }
  async #updateDeviceRow(d) {
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `${DEVICES_TAB}!A2:A` });
    const idx = (res.data.values || []).map((r) => r[0]).indexOf(d.deviceId);
    if (idx === -1) { await this.#append(DEVICES_TAB, DEVICE_HEADERS.map((h) => d[h])); return; }
    const row = idx + 2;
    await this.sheets.spreadsheets.values.update({ spreadsheetId: this.sheetId, range: `${DEVICES_TAB}!A${row}:${DEVICE_COL_END}${row}`, valueInputOption: 'RAW', requestBody: { values: [DEVICE_HEADERS.map((h) => d[h])] } });
  }
  async #clearRow(tab, id) {
    const res = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.sheetId, range: `${tab}!A2:A` });
    const idx = (res.data.values || []).map((r) => r[0]).indexOf(id);
    if (idx === -1) return;
    await this.sheets.spreadsheets.values.clear({ spreadsheetId: this.sheetId, range: `${tab}!A${idx + 2}:Z${idx + 2}` });
  }
}