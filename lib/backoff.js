// 票種資料載入失敗後的重新整理間隔：連續失敗才逐步拉長，最長 3 秒一次；請求太多時至少 3 秒；連續失敗超過 5 分鐘就交給你。
export const LOAD_BACKOFF_MS = [500, 1000, 2000, 3000];
export const LOAD_FAIL_MAX_MS = 5 * 60000;

/** 第 streak+1 次連續失敗要等多久；status 是失敗的 HTTP 狀態碼，連線中斷是 0 */
export function loadDelay(streak, status) {
  let delayMs = LOAD_BACKOFF_MS[Math.min(Math.max(0, streak || 0), LOAD_BACKOFF_MS.length - 1)];
  if (status === 429) delayMs = Math.max(delayMs, 3000);   // 請求太多：別急著再要
  return delayMs;
}

/** 從 since 開始連續失敗，到 now 是否已經超過上限 */
export const loadGaveUp = (since, now) => !!since && now - since > LOAD_FAIL_MAX_MS;

/*
 * 請求太多（429）：讀取時照網站給的 Retry-After 等；沒給就逐步拉長間隔（2、4、8 秒）。
 * 不論有沒有給，連續最多重試 RATE_MAX_RETRIES 次；網站要等超過 RETRY_AFTER_MAX_MS 也不自己等，交給你。
 * 送出（選購、資料）遇到 429 不在這裡：一律不自動重送。
 */
export const RATE_BACKOFF_MS = [2000, 4000, 8000];
export const RATE_MAX_RETRIES = 3;
export const RETRY_AFTER_MAX_MS = 120000;
const RETRY_AFTER_MARGIN_MS = 250;   // 時間剛好到的那一刻再要，可能還算太早

/** Retry-After 標頭 → 要等幾毫秒：可以是秒數，也可以是 HTTP 日期；看不懂回 null（當成沒給） */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (!/[a-z]/i.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

/**
 * 第 attempt+1 次因為 429 重新讀取要等多久。retryAfterMs 是網站給的（沒給就 null）。
 * 回 { allow: true, delayMs, source: 'retry-after' | 'backoff' }，或 { allow: false, reason: 'limit' | 'too-long' }。
 */
export function rateLimitDelay(attempt, retryAfterMs) {
  if (attempt >= RATE_MAX_RETRIES) return { allow: false, reason: 'limit' };
  if (retryAfterMs != null) {
    if (retryAfterMs > RETRY_AFTER_MAX_MS) return { allow: false, reason: 'too-long', retryAfterMs };
    return { allow: true, delayMs: retryAfterMs + RETRY_AFTER_MARGIN_MS, source: 'retry-after' };
  }
  return { allow: true, delayMs: RATE_BACKOFF_MS[Math.min(attempt, RATE_BACKOFF_MS.length - 1)], source: 'backoff' };
}
