/**
 * Pure grouping + date helpers for the chat message list (§F2). No React / RN imports so
 * the run-boundary logic — the error-prone part — is unit-tested in isolation.
 *
 * The list is NEWEST-FIRST (index 0 = newest) and rendered into a REVERSED FlashList, so
 * on screen the OLDER neighbour of `messages[i]` sits at `messages[i + 1]` (visually above).
 * Every boundary decision reads that older neighbour.
 */

/** Minimal shape the grouping needs — `Message` rows satisfy it structurally. */
export interface GroupableMsg {
  readonly createdAt: number;
  readonly senderId: string;
}

/** Local-midnight epoch for `ts` — the calendar-day bucket. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Same local calendar day? */
export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/**
 * Does `messages[i]` open a new calendar day when the list is read oldest→newest — i.e. is
 * it the OLDEST message of its day (the one a date separator sits above)? True when there
 * is no older neighbour (oldest message overall) or the older neighbour is a different day.
 */
export function startsNewDay(
  messages: readonly GroupableMsg[],
  i: number,
): boolean {
  const cur = messages[i];
  if (!cur) return false;
  const older = messages[i + 1];
  if (!older) return true;
  return !isSameDay(cur.createdAt, older.createdAt);
}

/**
 * Does `messages[i]` start a new same-sender run — the top bubble of its group, the one that
 * gets the tail? A run breaks on a sender change or a day change. True at the oldest message
 * overall, at a day boundary, or when the older neighbour is a different sender.
 */
export function startsNewRun(
  messages: readonly GroupableMsg[],
  i: number,
): boolean {
  const cur = messages[i];
  if (!cur) return false;
  if (startsNewDay(messages, i)) return true;
  const older = messages[i + 1];
  if (!older) return true;
  return older.senderId !== cur.senderId;
}

/**
 * Time-of-day token (12-hour, e.g. "9:05 AM") — the bubble timestamp and the header's
 * presence line share it. `toLocaleTimeString` is ICU over JNI on Hermes, so callers must
 * resolve this ONCE per DB emission, never per row per render (§R4). '' for an invalid ts.
 */
export function compactTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export type DayCategory = 'today' | 'yesterday' | 'other';

/** Classify `ts` relative to `now` for the date-separator label (DST-safe). */
export function dayCategory(ts: number, now: number): DayCategory {
  if (isSameDay(ts, now)) return 'today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(ts, yesterday.getTime())) return 'yesterday';
  return 'other';
}

/**
 * Compact last-seen token for the header presence line (§A15): time-of-day when it was today,
 * a caller-supplied localised "yesterday" word for yesterday, else a short date. Mirrors the
 * chat-list `timeLabel` buckets so the two surfaces read consistently. Empty string for an
 * invalid timestamp. The `chat.lastSeen` i18n string wraps this as its `{{time}}` param.
 */
export function presenceTimeLabel(
  ts: number,
  now: number,
  yesterdayLabel: string,
): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const cat = dayCategory(ts, now);
  if (cat === 'today') return compactTime(ts);
  if (cat === 'yesterday') return yesterdayLabel;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
