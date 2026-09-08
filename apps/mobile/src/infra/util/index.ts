/**
 * infra/util — small pure helpers (no I/O, no native). Public API barrel (§M3).
 */
export { toE164, regionFromE164 } from './phone';
export { yieldToEventLoop, mapYielding } from './scheduling';
