#!/usr/bin/env node
/**
 * Jira bug sync (§33, §43) — create or update one Jira issue per confirmed defect.
 *
 * Credentials come from the environment ONLY and are never printed:
 *   JIRA_BASE_URL     https://<your-site>.atlassian.net
 *   JIRA_EMAIL        the Atlassian account email
 *   JIRA_API_TOKEN    an API token from id.atlassian.com → Security → API tokens
 *   JIRA_PROJECT_KEY  e.g. VEL
 *   JIRA_ISSUE_TYPE   optional, default "Bug"
 *
 * Deduplication is the whole point of this script (§43). Every issue carries the label
 * `qa-<bug-id>` (e.g. `qa-vc-001`), which is the failure signature: it is derived from the bug
 * registry entry, not from a message string that changes between runs. Before creating anything
 * the script asks Jira whether an issue with that label already exists:
 *   - exists  → append a comment with the new occurrence + evidence, and do NOT create a duplicate
 *   - absent  → create the issue
 * The resulting key is written back into QA/reports/bugs.json so the Excel report and the final
 * report show it.
 *
 * Usage:
 *   node QA/scripts/jira/sync.mjs --dry-run      # print exactly what would be sent, no network
 *   node QA/scripts/jira/sync.mjs                # create/update for every P0/P1/P2/P3 open bug
 *   node QA/scripts/jira/sync.mjs --severity P0,P1
 *   node QA/scripts/jira/sync.mjs --only VC-001,VC-002
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
// Imported for its side effect: it loads QA/config/qa.env into process.env (real env wins).
// ESM evaluates imports before this module's body, so `cfg` below sees the loaded values.
import '../../lib/env.js';

const QA_DIR = resolve(import.meta.dirname, '..', '..');
const BUGS_PATH = resolve(QA_DIR, 'reports', 'bugs.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = flag('--dry-run');
const SEVERITIES = (value('--severity') ?? 'P0,P1,P2,P3')
  .split(',')
  .map((s) => s.trim().toUpperCase());
const ONLY = value('--only')
  ?.split(',')
  .map((s) => s.trim().toUpperCase());

const cfg = {
  baseUrl: (process.env.JIRA_BASE_URL ?? '').replace(/\/+$/, ''),
  email: process.env.JIRA_EMAIL ?? '',
  token: process.env.JIRA_API_TOKEN ?? '',
  projectKey: process.env.JIRA_PROJECT_KEY ?? '',
  issueType: process.env.JIRA_ISSUE_TYPE ?? 'Bug',
};

/** Jira priority names, mapped from our severity scale. */
const PRIORITY = { P0: 'Highest', P1: 'High', P2: 'Medium', P3: 'Low' };

function authHeader() {
  return `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`;
}

function requireConfig() {
  const missing = Object.entries({
    JIRA_BASE_URL: cfg.baseUrl,
    JIRA_EMAIL: cfg.email,
    JIRA_API_TOKEN: cfg.token,
    JIRA_PROJECT_KEY: cfg.projectKey,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`\nJira is not configured. Missing: ${missing.join(', ')}`);
    console.error('Set them in QA/config/qa.env (git-ignored) or in the environment, then re-run.');
    console.error(
      'Run with --dry-run to see exactly what would be sent without any credentials.\n',
    );
    process.exit(2);
  }
}

async function jira(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${cfg.baseUrl}/rest/api/3${path}`, {
    method,
    headers: {
      authorization: authHeader(),
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    // Never echo the Authorization header or the token — only Jira's own message.
    throw new Error(
      `Jira ${method} ${path} → ${res.status}: ${JSON.stringify(parsed ?? text).slice(0, 500)}`,
    );
  }
  return parsed;
}

// ── Atlassian Document Format helpers ───────────────────────────────────────
const text = (value_) => ({ type: 'text', text: String(value_ ?? '—') });
const paragraph = (value_) => ({ type: 'paragraph', content: [text(value_)] });
const heading = (value_) => ({ type: 'heading', attrs: { level: 3 }, content: [text(value_)] });
const codeBlock = (value_) => ({ type: 'codeBlock', content: [text(value_)] });

function orderedList(items) {
  if (!items?.length) return paragraph('—');
  return {
    type: 'orderedList',
    content: items.map((item) => ({ type: 'listItem', content: [paragraph(item)] })),
  };
}

function bulletList(items) {
  if (!items?.length) return paragraph('—');
  return {
    type: 'bulletList',
    content: items.map((item) => ({ type: 'listItem', content: [paragraph(item)] })),
  };
}

/**
 * Build the issue description. Every §32 field is present, and root cause is stated honestly —
 * "Unknown — requires engineering investigation" when it was never confirmed (§44).
 */
function describe(bug) {
  return {
    type: 'doc',
    version: 1,
    content: [
      paragraph(
        `Filed automatically by the VelChat QA suite. Bug ID ${bug.id} · owning layer ${bug.layer}.`,
      ),

      heading('Environment'),
      bulletList([
        `Environment: ${bug.environment}`,
        `Device: ${bug.device}`,
        `OS: ${bug.os}`,
        `Component: ${bug.component}`,
        `Frequency: ${bug.frequency}`,
        `Reproducibility: ${bug.reproducibility}`,
      ]),

      heading('Preconditions'),
      paragraph(bug.preconditions),

      heading('Steps to reproduce'),
      orderedList(bug.steps),

      heading('Expected result'),
      paragraph(bug.expected),

      heading('Actual result'),
      paragraph(bug.actual),

      heading('User impact'),
      paragraph(bug.user_impact),

      heading('Suspected cause'),
      paragraph(bug.suspected_cause),

      heading('Root cause'),
      paragraph(bug.rootCause),

      heading('Evidence'),
      bulletList(bug.evidence?.length ? bug.evidence : ['—']),

      heading('Covering tests'),
      paragraph(bug.testIds?.join(', ') || '—'),

      heading('References'),
      bulletList(bug.refs?.length ? bug.refs : ['—']),

      ...(bug.notes ? [heading('Notes'), paragraph(bug.notes)] : []),

      heading('Reproduce it yourself'),
      codeBlock(
        [
          '# 1. start a local backend',
          'cd D:\\Velchat && node tools/gateway/start-all.mjs',
          '# 2. run the covering tests',
          `cd D:\\Velchat-Frontend && node --test QA/tests/**/*.test.js`,
          `# 3. this bug's covering tests: ${bug.testIds?.join(', ') || 'n/a'}`,
        ].join('\n'),
      ),
    ],
  };
}

/** The dedup signature. Stable across runs because it derives from the registry id, not a message. */
function signatureLabel(bug) {
  return `qa-${bug.id.toLowerCase()}`;
}

function labelsFor(bug) {
  return [
    'qa-automation',
    signatureLabel(bug),
    `layer-${String(bug.layer).toLowerCase()}`,
    `severity-${String(bug.severity).toLowerCase()}`,
  ];
}

function summaryFor(bug) {
  // Jira summaries are single-line and capped; keep the bug id first so it is greppable.
  const title = bug.title.length > 200 ? `${bug.title.slice(0, 197)}...` : bug.title;
  return `[${bug.id}] ${title}`;
}

/** Find an existing issue by the dedup label. Returns the issue or null. */
async function findExisting(bug) {
  const jql = `project = "${cfg.projectKey}" AND labels = "${signatureLabel(bug)}" ORDER BY created ASC`;
  const res = await jira('/search/jql', {
    method: 'POST',
    body: { jql, maxResults: 5, fields: ['summary', 'status', 'labels'] },
  });
  return res?.issues?.[0] ?? null;
}

async function createIssue(bug) {
  const fields = {
    project: { key: cfg.projectKey },
    issuetype: { name: cfg.issueType },
    summary: summaryFor(bug),
    description: describe(bug),
    labels: labelsFor(bug),
  };
  try {
    return await jira('/issue', {
      method: 'POST',
      body: { fields: { ...fields, priority: { name: PRIORITY[bug.severity] ?? 'Medium' } } },
    });
  } catch (e) {
    // Not every Jira project exposes a `priority` field on the create screen. Retry without it
    // rather than failing the sync — the severity is still carried as a label and in the body.
    if (!/priority/i.test(String(e.message))) throw e;
    console.warn(`  note: this project rejects the priority field; filing ${bug.id} without it`);
    return jira('/issue', { method: 'POST', body: { fields } });
  }
}

async function commentOccurrence(key, bug) {
  const body = {
    body: {
      type: 'doc',
      version: 1,
      content: [
        paragraph(
          `Re-observed by the QA suite on ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC. Still ${bug.status}.`,
        ),
        heading('Actual result this run'),
        paragraph(bug.actual),
        heading('Evidence'),
        bulletList(bug.evidence?.length ? bug.evidence : ['—']),
        paragraph(`Covering tests: ${bug.testIds?.join(', ') || '—'}`),
      ],
    },
  };
  return jira(`/issue/${key}/comment`, { method: 'POST', body });
}

async function main() {
  const registry = JSON.parse(readFileSync(BUGS_PATH, 'utf8'));
  let bugs = registry.bugs.filter((b) => SEVERITIES.includes(String(b.severity).toUpperCase()));
  if (ONLY) bugs = bugs.filter((b) => ONLY.includes(b.id.toUpperCase()));
  bugs = bugs.filter((b) => (b.status ?? 'Open') !== 'Closed');

  console.log(`\nJira sync — ${bugs.length} bug(s) selected (severities ${SEVERITIES.join(',')})`);

  if (DRY_RUN) {
    console.log('DRY RUN — no network calls. Showing the exact payload each bug would produce.\n');
    for (const bug of bugs) {
      console.log('─'.repeat(78));
      console.log(`${bug.id}  severity=${bug.severity}  layer=${bug.layer}`);
      console.log(`  summary : ${summaryFor(bug)}`);
      console.log(`  labels  : ${labelsFor(bug).join(', ')}`);
      console.log(`  priority: ${PRIORITY[bug.severity] ?? 'Medium'}`);
      console.log(
        `  dedupe  : JQL  project = "${cfg.projectKey || '<JIRA_PROJECT_KEY>'}" AND labels = "${signatureLabel(bug)}"`,
      );
      console.log(
        `  steps   : ${bug.steps?.length ?? 0} step(s), evidence: ${bug.evidence?.length ?? 0} file(s)`,
      );
      console.log(`  rootCause: ${bug.rootCause}`);
    }
    console.log('─'.repeat(78));
    console.log(`\n${bugs.length} issue(s) would be created or updated.`);
    console.log(
      'Set JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY and re-run without --dry-run.\n',
    );
    return 0;
  }

  requireConfig();

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const bug of bugs) {
    try {
      const existing = await findExisting(bug);
      if (existing) {
        await commentOccurrence(existing.key, bug);
        bug.jira = existing.key;
        updated += 1;
        console.log(`  ${bug.id} → ${existing.key} (duplicate found; commented, not re-created)`);
      } else {
        const issue = await createIssue(bug);
        bug.jira = issue.key;
        created += 1;
        console.log(`  ${bug.id} → ${issue.key} (created)`);
      }
    } catch (e) {
      failed += 1;
      console.error(`  ${bug.id} → FAILED: ${e.message}`);
    }
  }

  writeFileSync(BUGS_PATH, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  console.log(`\nJira: ${created} created, ${updated} duplicates updated, ${failed} failed.`);
  console.log(`Issue keys written back to ${BUGS_PATH}.`);
  console.log(
    'Re-run `python QA/scripts/build_excel_report.py` to pull the keys into the Excel report.\n',
  );
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Jira sync failed: ${err.message}`);
    process.exit(1);
  },
);
