/**
 * Zero-dependency Google Sheets API client — service-account JWT auth via node:crypto, everything
 * else via the global `fetch` (Node 22 built-ins only, consistent with the rest of QA/lib/*).
 *
 * Auth flow (RFC 7523 JWT bearer grant): sign a short-lived JWT with the service account's private
 * key (RS256), exchange it at Google's token endpoint for an OAuth access token, use that as a
 * Bearer token against the Sheets REST API. Tokens are cached and refreshed a minute before expiry.
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
// `drive.file` (not full `drive`) — scoped to files this service account creates/opens itself,
// the minimum needed to create a spreadsheet and share it. It cannot see the user's other files.
const SCOPE =
  'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/** Sign a Google service-account JWT bearer assertion (RS256, RFC 7523). */
function signAssertion(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(credentials.private_key)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

export class SheetsClient {
  /** @param {object} credentials parsed service-account JSON (client_email + private_key). */
  constructor(credentials) {
    this.credentials = credentials;
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  static fromFile(path) {
    return new SheetsClient(JSON.parse(readFileSync(path, 'utf8')));
  }

  async _getToken() {
    if (this._token && Date.now() < this._tokenExpiresAt - 60_000) return this._token;
    const assertion = signAssertion(this.credentials);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    const body = await res.json();
    if (!res.ok)
      throw new Error(`Google token exchange failed: ${res.status} ${JSON.stringify(body)}`);
    this._token = body.access_token;
    this._tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this._token;
  }

  async _request(path, options = {}) {
    const token = await this._getToken();
    const res = await fetch(`${SHEETS_API}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        `Sheets API ${options.method ?? 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 400)}`,
      );
    return body;
  }

  /** Full spreadsheet metadata (tabs, their numeric ids, and their conditional-format rules). */
  async getMeta(spreadsheetId) {
    return this._request(`/${spreadsheetId}?fields=sheets(properties,conditionalFormats)`);
  }

  /** Run an arbitrary list of batchUpdate requests (formatting, banding, filters, ...). */
  async batchUpdate(spreadsheetId, requests) {
    if (!requests.length) return;
    return this._request(`/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  }

  /**
   * Create a tab if it doesn't already exist. Returns
   * `{ sheetId, created, hasFormatting }` — `sheetId` is the tab's NUMERIC id (needed for
   * formatting requests, distinct from the spreadsheet's own string id); `hasFormatting` tells the
   * caller whether conditional-format rules already exist so formatting is applied exactly once.
   */
  async ensureSheet(spreadsheetId, title) {
    const meta = await this.getMeta(spreadsheetId);
    const existing = meta.sheets?.find((s) => s.properties?.title === title);
    if (existing) {
      return {
        sheetId: existing.properties.sheetId,
        created: false,
        hasFormatting: (existing.conditionalFormats?.length ?? 0) > 0,
      };
    }
    const res = await this._request(`/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    });
    const sheetId = res.replies?.[0]?.addSheet?.properties?.sheetId;
    return { sheetId, created: true, hasFormatting: false };
  }

  /** Read a rectangular range as rows of cell values (empty cells as ''). */
  async getValues(spreadsheetId, range) {
    const q = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
    const body = await this._request(`/${spreadsheetId}/values/${encodeURIComponent(range)}?${q}`);
    return body.values ?? [];
  }

  /** Overwrite a rectangular range with `rows` (array of arrays). */
  async setValues(spreadsheetId, range, rows) {
    await this._request(
      `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        body: JSON.stringify({ range, majorDimension: 'ROWS', values: rows }),
      },
    );
  }

  /** Write a single cell (e.g. "Bugs!G5"). */
  async setCell(spreadsheetId, a1, value) {
    return this.setValues(spreadsheetId, a1, [[value]]);
  }

  /** Clear a range's contents without deleting the sheet. */
  async clearValues(spreadsheetId, range) {
    await this._request(`/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, {
      method: 'POST',
      body: '{}',
    });
  }

  /** Create a brand-new spreadsheet owned by this service account. Returns its id. */
  async createSpreadsheet(title) {
    const body = await this._request('', {
      method: 'POST',
      body: JSON.stringify({ properties: { title } }),
    });
    return body.spreadsheetId;
  }

  /** Grant a real Google account edit access to a file this service account owns (Drive API). */
  async shareWithUser(fileId, emailAddress, role = 'writer') {
    const token = await this._getToken();
    const res = await fetch(`${DRIVE_API}/files/${fileId}/permissions?sendNotificationEmail=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user', role, emailAddress }),
    });
    const respBody = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new Error(
        `Drive share failed: ${res.status} ${JSON.stringify(respBody).slice(0, 400)}`,
      );
    return respBody;
  }
}
