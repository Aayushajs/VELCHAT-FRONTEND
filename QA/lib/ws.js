/**
 * QA realtime client (§23) — a scripted WebSocket peer for the realtime gateway `/ws`.
 *
 * Uses Node 22's built-in global `WebSocket` (no dependency). It speaks the documented frame
 * envelope `{kind,type,data}` (`docs/backend-integration-reference.md` §4) and records EVERY frame
 * in both directions to an evidence log, because realtime defects are only diagnosable from the
 * frame trace.
 *
 * Deliberate design choices:
 *   - It never auto-reconnects. Reconnect is the thing under test, so the test drives it.
 *   - `expect()` resolves from a BUFFER of already-received frames as well as future ones, so a
 *     frame that arrives before the assertion is registered is not a lost race (a classic source of
 *     flaky realtime tests).
 *   - Every wait is bounded and names its condition — no bare sleeps (§45).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';

const CLOSE_DEAD = 4000;
export const WS_CODE_UNAUTHORIZED = 4001;

function evidencePath() {
  const dir = join(env.evidenceDir, 'websocket');
  mkdirSync(dir, { recursive: true });
  return join(dir, `ws-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

export class QaRealtimeClient {
  /**
   * @param {object} opts
   * @param {string} opts.token   access JWT (rides `?token=` exactly as the app does)
   * @param {string} [opts.label] name used in the evidence trace ("deviceA")
   * @param {string} [opts.url]   override the base ws URL
   * @param {boolean} [opts.sendToken] set false to connect with NO token (negative test)
   */
  constructor({ token, label = 'client', url = env.wsBaseUrl, sendToken = true, testId = null }) {
    this.label = label;
    this.testId = testId;
    this.frames = [];
    this.sent = [];
    this.waiters = [];
    this.closed = null;
    this.opened = false;
    this.ws = null;
    this._url =
      sendToken && token
        ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
        : url;
  }

  _trace(direction, payload, extra = {}) {
    appendFileSync(
      evidencePath(),
      JSON.stringify({
        at: new Date().toISOString(),
        testId: this.testId,
        client: this.label,
        direction,
        type: payload?.type ?? null,
        kind: payload?.kind ?? null,
        payload,
        ...extra,
      }) + '\n',
      'utf8',
    );
  }

  /** Open the socket. Resolves on `open`, rejects on a close that happens before open. */
  connect({ timeoutMs = env.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[${this.label}] ws open timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      let settled = false;

      this.ws = new WebSocket(this._url);

      this.ws.addEventListener('open', () => {
        this.opened = true;
        this._trace('open', null);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(this);
        }
      });

      this.ws.addEventListener('message', (ev) => {
        let frame;
        try {
          frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          frame = { __unparsed: String(ev.data) };
        }
        this.frames.push({ at: Date.now(), frame });
        this._trace('rx', frame);
        // Answer server heartbeats so the registry entry stays warm during a long test.
        if (frame?.type === 'ping') this.send('pong', {});
        this._drainWaiters();
      });

      this.ws.addEventListener('close', (ev) => {
        this.closed = { code: ev.code, reason: ev.reason ?? '' };
        this._trace('close', null, { code: ev.code, reason: ev.reason ?? '' });
        this._drainWaiters();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            Object.assign(new Error(`[${this.label}] ws closed before open: ${ev.code}`), {
              code: ev.code,
            }),
          );
        }
      });

      this.ws.addEventListener('error', () => {
        this._trace('error', null);
      });
    });
  }

  /** Connect but tolerate an immediate close — used by negative/auth tests. */
  async connectExpectingClose({ timeoutMs = env.timeoutMs } = {}) {
    try {
      await this.connect({ timeoutMs });
    } catch (e) {
      if (this.closed) return this.closed;
      throw e;
    }
    // Opened — wait for the close the test expects.
    return this.waitForClose({ timeoutMs });
  }

  get isOpen() {
    return this.ws?.readyState === 1;
  }

  /** Send a durable/ephemeral `{kind,type,data}` frame (server→client envelope shape). */
  send(type, data) {
    const kind = type === 'typing' || type === 'ping' || type === 'pong' ? 'ephemeral' : 'durable';
    const frame = { kind, type, data };
    this.sent.push(frame);
    this._trace('tx', frame);
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /**
   * Send a FLAT ephemeral control frame — the gateway's inbound router reads control fields at the
   * top level and does not unwrap `data` for inbound frames (see `infra/realtime/socket.ts:176`).
   */
  sendEphemeral(type, fields) {
    const frame = { kind: 'ephemeral', type, ...fields };
    this.sent.push(frame);
    this._trace('tx', frame);
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /** Send a raw string — for malformed-payload tests (§23). */
  sendRaw(raw) {
    this.sent.push({ raw });
    this._trace('tx', { raw: String(raw).slice(0, 400) });
    if (!this.isOpen) return false;
    this.ws.send(raw);
    return true;
  }

  _drainWaiters() {
    for (const w of [...this.waiters]) {
      const hit = this.frames.slice(w.cursor).find(({ frame }) => w.match(frame));
      if (hit) {
        this.waiters = this.waiters.filter((x) => x !== w);
        clearTimeout(w.timer);
        w.resolve(hit.frame);
      } else if (this.closed && w.rejectOnClose) {
        this.waiters = this.waiters.filter((x) => x !== w);
        clearTimeout(w.timer);
        w.reject(
          Object.assign(new Error(`[${this.label}] socket closed while awaiting ${w.label}`), {
            closed: this.closed,
          }),
        );
      }
    }
  }

  /**
   * Resolve with the first frame matching `match`, searching already-buffered frames first.
   * `from` lets a test ignore frames received before a known point (default: the whole buffer).
   */
  expect(
    match,
    { timeoutMs = env.eventTimeoutMs, label = 'frame', from = 0, rejectOnClose = true } = {},
  ) {
    const predicate = typeof match === 'string' ? (f) => f?.type === match : match;
    const buffered = this.frames.slice(from).find(({ frame }) => predicate(frame));
    if (buffered) return Promise.resolve(buffered.frame);

    return new Promise((resolve, reject) => {
      const waiter = { match: predicate, resolve, reject, label, cursor: from, rejectOnClose };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== waiter);
        reject(
          Object.assign(
            new Error(`[${this.label}] timed out after ${timeoutMs}ms awaiting ${label}`),
            {
              received: this.frames.slice(from).map((f) => f.frame?.type),
            },
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
      this._drainWaiters();
    });
  }

  /** Collect every frame of `type` received so far (after optional cursor). */
  collect(type, from = 0) {
    return this.frames
      .slice(from)
      .filter(({ frame }) => frame?.type === type)
      .map(({ frame }) => frame);
  }

  /** Current frame-buffer length — pass as `from` to scope a later assertion. */
  mark() {
    return this.frames.length;
  }

  waitForClose({ timeoutMs = env.eventTimeoutMs } = {}) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[${this.label}] no close within ${timeoutMs}ms`)),
        timeoutMs,
      );
      const check = setInterval(() => {
        if (this.closed) {
          clearInterval(check);
          clearTimeout(timer);
          resolve(this.closed);
        }
      }, 100);
    });
  }

  /** Owner-initiated teardown. Every waiter is settled and every timer cleared (§M7). */
  close() {
    for (const w of this.waiters) clearTimeout(w.timer);
    this.waiters = [];
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
  }
}

export { CLOSE_DEAD };
