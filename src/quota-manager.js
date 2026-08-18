// ============================================================
// QUOTA MANAGER
//
// Tracks and enforces Twelve Data's free-tier limits so the
// engine never gets hard-blocked mid-day:
//   - 8 requests per minute
//   - 800 requests per day
//
// FIX (Aug 2026): the previous version reserved the MINUTE quota
// first, then the DAY quota. If the day quota was already
// exhausted, the minute credit had already been spent and was
// never refunded — silently burning the minute allowance on
// failed attempts. Fixed by checking BOTH windows before
// reserving either one.
// ============================================================
import { quotaUsed, reserveQuota, releaseQuota } from "./db.js";

export function minuteKey() {
  return new Date().toISOString().slice(0, 16); // e.g. "2026-08-17T14:32"
}

export function dayKey() {
  return new Date().toISOString().slice(0, 10); // e.g. "2026-08-17"
}

export async function reserveTwelveData(db, cfg, credits = 1) {
  const mKey = minuteKey();
  const dKey = dayKey();

  // Check both windows have room BEFORE committing either reservation.
  const minuteState = await quotaUsed(db, "twelvedata", "minute", mKey);
  const dayState = await quotaUsed(db, "twelvedata", "day", dKey);

  const minuteRoom = minuteState.used + credits <= cfg.twelveMinuteQuota;
  const dayRoom = dayState.used + credits <= cfg.twelveDailyQuota;

  if (!minuteRoom || !dayRoom) return false;

  // Reserve minute quota; if it fails (race condition with another
  // concurrent run), stop — nothing to roll back yet.
  const minuteOk = await reserveQuota(db, "twelvedata", "minute", mKey, cfg.twelveMinuteQuota, credits);
  if (!minuteOk) return false;

  // Reserve day quota; if THIS fails, refund the minute credit we
  // just spent so it isn't lost.
  const dayOk = await reserveQuota(db, "twelvedata", "day", dKey, cfg.twelveDailyQuota, credits);
  if (!dayOk) {
    await releaseQuota(db, "twelvedata", "minute", mKey, credits);
    return false;
  }

  return true;
}

