#!/usr/bin/env node
/**
 * One-off: create a fresh Google Sheet owned by the service account, share it with a real Google
 * account (Editor), and write the resulting id into QA/config/qa.env — so the very next
 * `npm run qa:sync` has everything it needs.
 *
 * Usage: node QA/scripts/sync/create-sheet.mjs <email-to-share-with> [title]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../../lib/env.js';
import { SheetsClient } from './sheets-client.mjs';

const email = process.argv[2];
const title = process.argv[3] ?? 'VelChat QA Report';
if (!email) {
  console.error('Usage: node QA/scripts/sync/create-sheet.mjs <email-to-share-with> [title]');
  process.exit(2);
}

const QA_DIR = resolve(import.meta.dirname, '..', '..');
const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
if (!keyPath) {
  console.error('Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH in QA/config/qa.env first.');
  process.exit(2);
}
const resolvedKeyPath =
  keyPath.startsWith('/') || /^[A-Za-z]:/.test(keyPath) ? keyPath : resolve(QA_DIR, '..', keyPath);

const client = SheetsClient.fromFile(resolvedKeyPath);

const spreadsheetId = await client.createSpreadsheet(title);
console.log(`Created "${title}" — id ${spreadsheetId}`);

await client.shareWithUser(spreadsheetId, email, 'writer');
console.log(`Shared with ${email} (Editor).`);

const envPath = resolve(QA_DIR, 'config', 'qa.env');
const contents = readFileSync(envPath, 'utf8');
const updated = /^GOOGLE_SHEET_ID=.*$/m.test(contents)
  ? contents.replace(/^GOOGLE_SHEET_ID=.*$/m, `GOOGLE_SHEET_ID=${spreadsheetId}`)
  : `${contents}\nGOOGLE_SHEET_ID=${spreadsheetId}\n`;
writeFileSync(envPath, updated, 'utf8');
console.log('QA/config/qa.env updated.');

console.log(`\nOpen it: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
