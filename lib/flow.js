// 一般票券購買流程的判斷：選時段、配票種張數、檢查購票人資料、網站錯誤該怎麼辦。只處理資料，不碰網頁，所以可以單獨測試。
// 網站的頁面怎麼讀、怎麼填，交給 src/generic/ 底下各網站的轉接程式；轉接把頁面讀成這裡用的格式：
//   時段 { id, text, status: available | limited | full | not-open | unknown, remaining: 數字或 null }
//   票種 { id, name, price }

const DASH = /[–—~～〜－-]/g;
const normDash = (s) => String(s).replace(DASH, '-');
const words = (line) => normDash(line).replace(/　/g, ' ').split(/\s+/).filter(Boolean);
const RANGE = /\d{1,2}:\d{2}-\d{1,2}:\d{2}/;

/** 一段關鍵字有沒有出現在時段文字裡。只寫一個時間（08:00）代表開始時間，不會對到 06:00–08:00 的結束時間 */
function wordHit(text, w) {
  if (/^\d{1,2}:\d{2}$/.test(w)) {
    const t = w.padStart(5, '0');
    if (RANGE.test(text)) return new RegExp(`(^|[^\\d])${t}-`).test(text);
    return text.includes(t);
  }
  return text.includes(w);
}
const hasAll = (text, line) => { const t = normDash(text); return words(line).every((w) => wordHit(t, w)); };

export const isBuyable = (s) => s.status === 'available' || s.status === 'limited';
/** 能不能買到 need 張：可以買，而且有寫剩幾張的話要夠 */
export const enoughFor = (s, need) => isBuyable(s) && (s.remaining == null || s.remaining >= need);

/**
 * 依偏好選時段。prefs 一行一組（空白分隔的每一段都要出現在時段文字裡），越上面越優先；skip 是這次已經試過買不到的時段。
 * 第一個比對得到的那一組決定結果：
 *   有能買而且剩餘夠的 → ok
 *   全部額滿、剩的不夠或已經試過 → 換下一組
 *   還沒開放 → not-open（等它開放，不跳去比較不想要的那組）
 * 每一組都沒結果時，開了遞補就從上往下選第一個能買的；否則 sold-out 或 no-match。
 */
export function pickSlot(slots, prefs, { need = 1, fallback = false, skip = [] } = {}) {
  const skipped = new Set(skip);
  const usable = (s) => !skipped.has(s.id) && enoughFor(s, need);
  const tried = [];
  for (const line of prefs || []) {
    if (!words(line).length) continue;
    const hits = slots.filter((s) => hasAll(s.text, line));
    if (!hits.length) continue;
    const ok = hits.find(usable);
    if (ok) return { kind: 'ok', slot: ok, line };
    if (hits.some((s) => s.status === 'not-open' || s.status === 'unknown')) return { kind: 'not-open', line, text: hits[0].text };
    tried.push(...hits);
  }
  if (fallback) {
    const any = slots.find(usable);
    if (any) return { kind: 'ok', slot: any, line: null, fallback: true };
    if (slots.some((s) => s.status === 'not-open' || s.status === 'unknown')) return { kind: 'not-open', line: null };
  }
  if (tried.length || (fallback && slots.length)) {
    const short = tried.find((s) => isBuyable(s) && s.remaining != null && s.remaining < need);
    return { kind: 'sold-out', names: [...new Set(tried.map((s) => s.text))], short: short ? { text: short.text, remaining: short.remaining } : null };
  }
  return { kind: 'no-match', names: slots.map((s) => s.text) };
}

/** 「全票 2」「兒童票 1」這種一行一筆的設定 → [{ name, qty }]；張數寫在最後，可以用空白或冒號隔開 */
export function parseTicketLines(input) {
  const lines = Array.isArray(input) ? input : String(input == null ? '' : input).split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const line = String(raw).replace(/　/g, ' ').trim();
    if (!line) continue;
    const m = line.match(/^(.*?)[\s:：×xX*]*(\d+)\s*(張)?$/);
    if (!m || !m[1].trim()) { out.push({ name: line, qty: NaN }); continue; }
    out.push({ name: m[1].trim(), qty: Number(m[2]) });
  }
  return out;
}

/**
 * 把設定的票種張數對到頁面上的票種。名稱完全相同優先，其次「頁面名稱包含設定的字」。
 * 回傳 { ok: true, plan: [{ id, name, qty, price }], total, amount } 或 { ok: false, msg }。
 */
export function planTickets(types, wanted, maxPerOrder = Infinity) {
  if (!wanted || !wanted.length) return { ok: false, msg: '還沒設定要買哪些票種、各幾張' };
  const plan = [];
  for (const w of wanted) {
    if (!Number.isInteger(w.qty) || w.qty < 0) return { ok: false, msg: `「${w.name}」的張數看不懂，請寫成「${w.name} 2」這樣` };
    if (w.qty === 0) continue;
    const t = types.find((x) => x.name === w.name) || types.find((x) => x.name.includes(w.name));
    if (!t) return { ok: false, msg: `頁面上沒有「${w.name}」這個票種。頁面上的票種有：${types.map((x) => x.name).join('、') || '（沒有）'}` };
    const same = plan.find((p) => p.id === t.id);
    if (same) same.qty += w.qty;
    else plan.push({ id: t.id, name: t.name, qty: w.qty, price: t.price });
  }
  const total = plan.reduce((a, p) => a + p.qty, 0);
  if (!total) return { ok: false, msg: '每個票種都是 0 張，請至少設定 1 張' };
  if (total > maxPerOrder) return { ok: false, msg: `一共 ${total} 張，超過每筆上限 ${maxPerOrder} 張` };
  const amount = plan.reduce((a, p) => a + (Number(p.price) || 0) * p.qty, 0);
  return { ok: true, plan, total, amount };
}

export const PROFILE_FIELDS = { name: '姓名', phone: '手機', email: 'Email' };
const PHONE = /^09\d{8}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 你提供的購票人資料：去掉多餘空白，手機拿掉空白與連字號 */
export function cleanProfile(p) {
  const v = (k) => String((p && p[k]) ?? '').replace(/　/g, ' ').trim();
  return { name: v('name'), phone: v('phone').replace(/[\s-]/g, ''), email: v('email'), note: v('note') };
}

/** 購票人資料是否完整、格式對不對。只檢查你提供的資料，網站送出後還會再檢查一次 */
export function checkProfile(p) {
  const c = cleanProfile(p);
  const missing = Object.keys(PROFILE_FIELDS).filter((k) => !c[k]);
  const bad = {};
  if (c.phone && !PHONE.test(c.phone)) bad.phone = '手機要是 09 開頭共 10 碼';
  if (c.email && !EMAIL.test(c.email)) bad.email = 'Email 格式不對';
  return { ok: !missing.length && !Object.keys(bad).length, missing, bad, profile: c };
}

export function describeProfileProblem(r) {
  const parts = [];
  if (r.missing.length) parts.push(`還沒填：${r.missing.map((k) => PROFILE_FIELDS[k]).join('、')}`);
  for (const [k, msg] of Object.entries(r.bad)) parts.push(`${PROFILE_FIELDS[k]}：${msg}`);
  return parts.join('；');
}

/**
 * 網站回的錯誤 → 助手該怎麼做：
 *   retry      暫時性的錯誤（忙碌、伺服器錯誤、逾時、連線中斷）：等一下再試，有次數上限
 *   next-slot  這個時段買不到（售完、剩餘不足）：換下一個偏好的時段
 *   wait       還沒開賣：等一下重新看
 *   restart    保留逾時、步驟對不上：回到時段列表重來
 *   reload     表單權杖過期：重新整理這一頁拿新的，再做一次
 *   gate       排隊、驗證碼、機器人檢查：停下來交給你
 *   duplicate  網站說重複送出：上一次其實已經送到了，不要再送
 *   stop       資料有問題或認不得的錯誤：停下來交給你
 */
export function classifyError(code, status = 0) {
  const c = String(code || '').toUpperCase();
  if (['TRANSIENT', 'INTERNAL', 'CLIENT_TIMEOUT', 'NETWORK', 'TIMEOUT', 'RATE_LIMITED'].includes(c)) return 'retry';
  if (['SOLD_OUT', 'INSUFFICIENT'].includes(c)) return 'next-slot';
  if (c === 'NOT_ON_SALE') return 'wait';
  if (['HOLD_EXPIRED', 'STEP_VIOLATION'].includes(c)) return 'restart';
  if (['TOKEN_EXPIRED', 'FORM_EXPIRED', 'CSRF'].includes(c)) return 'reload';
  if (/QUEUE|CAPTCHA|BOTCHECK|CHALLENGE/.test(c)) return 'gate';
  if (c === 'DUPLICATE_SUBMIT') return 'duplicate';
  if (!c && (status >= 500 || status === 429)) return 'retry';
  return 'stop';
}

export const listNames = (names) => (names.slice(0, 6).join('、') + (names.length > 6 ? '…' : '')) || '（沒有）';
const STATUS_TEXT = { available: '可購買', limited: '剩少量', full: '已額滿', 'not-open': '尚未開放', unknown: '狀態不明' };
/** 「可購買，剩 80 張」這種給人看的狀態 */
export const statusText = (s) => `${STATUS_TEXT[s.status] || s.status}${s.remaining != null && s.status !== 'full' ? `，剩 ${s.remaining} 張` : ''}`;

/** pickSlot 的結果 → 一句話；need 是要買的張數 */
export function describePick(p, need = 1) {
  if (p.kind === 'ok') return `選中「${p.slot.text}」（${statusText(p.slot)}）${p.fallback ? '。關鍵字都沒對到，照遞補設定選第一個能買的' : ''}`;
  if (p.kind === 'not-open') return p.line ? `「${p.line}」還沒開放` : '時段都還沒開放';
  if (p.kind === 'sold-out') return p.short ? `「${p.short.text}」只剩 ${p.short.remaining} 張，不夠 ${need} 張` : `已額滿：${listNames(p.names)}`;
  return `關鍵字對不到任何時段。頁面上的時段有：${listNames(p.names)}`;
}

/**
 * 預先比對（開賣前、檢查時段用）：只看時段文字，不管現在能不能買，告訴你開賣時會選哪一個。
 * 回傳 { kind: 'match', slot, line, count } 或 { kind: 'no-match', names }
 */
export function previewSlot(slots, prefs) {
  for (const line of prefs || []) {
    if (!words(line).length) continue;
    const hits = slots.filter((s) => hasAll(s.text, line));
    if (hits.length) return { kind: 'match', slot: hits[0], line, count: hits.length };
  }
  return { kind: 'no-match', names: slots.map((s) => s.text) };
}

export function describePreview(p, fallback = false) {
  if (p.kind === 'match') {
    let msg = `開賣時會選「${p.slot.text}」（目前${statusText(p.slot)}）`;
    if (p.count > 1) msg += `。這組關鍵字對到 ${p.count} 個時段，會選第一個能買的`;
    return msg;
  }
  return `關鍵字對不到任何時段。頁面上的時段有：${listNames(p.names)}${fallback ? '。你開了遞補，開賣時會改選第一個能買的時段' : '。請在開賣前修改關鍵字'}`;
}
