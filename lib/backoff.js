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
