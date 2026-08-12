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
    this._mockHistory = {};
  }

  async init() {
    if (!this.mock) {
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
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
    const titles = meta.data.sheets.map((s) => s.properties.title);
    const toCreate = [USERS_TAB, DEVICES_TAB, LOCATIONS_TAB].filter((t) => !titles.includes(t));
    if (toCreate.length) {
      await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.sheetId, requestBody: { requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })) } });
    }
    await this.#ensureHeader(USERS_TAB, USER_HEADERS);
    await this.#ensureHeader(DEVICES_TAB, DEVICE_HEADERS);
    await this.#ensureHeader(LOCATIONS_TAB, LOCATION_HEADERS);
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