// 活動資訊的文字解析（A 類，只讀）：從活動頁上看得到的文字整理出場次、票價、開賣時間。
// 不碰網頁、不送任何請求，單元測試直接測；頁面程式（ibon-info.js）內嵌這個檔案。

const pad2 = (n) => String(n).padStart(2, '0');
const toNum = (s) => Number(String(s).replace(/[,，\s]/g, ''));
const oneLine = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();

/**
 * 日期時間文字 → { date: 'YYYY-MM-DD', time: 'HH:MM' | null }；看不懂回 null。
 * 認得「2026/11/14(六) 15:30」「2026 年 10 月 04 日 (日) 下午 14:00」「2026.10.04 下午 2:00」。
 * 時間要緊接在日期後面（中間只能有星期、上午／下午），不會抓到同一行更後面的別的時間。
 */
export function parseDateTime(text) {
  const t = oneLine(text);
  const d = t.match(/(\d{4})\s*(?:[/.\-]|年)\s*(\d{1,2})\s*(?:[/.\-]|月)\s*(\d{1,2})\s*日?/);
  if (!d) return null;
  const y = Number(d[1]), mo = Number(d[2]), da = Number(d[3]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const rest = t.slice(d.index + d[0].length);
  const tm = rest.match(/^\s*(?:[（(][^)）]{1,3}[)）])?\s*(上午|下午|中午|晚上|凌晨|早上)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/);
  let time = null;
  if (tm) {
    let h = Number(tm[2]);
    const mi = Number(tm[3]);
    if ((tm[1] === '下午' || tm[1] === '晚上') && h < 12) h += 12;
    if ((tm[1] === '上午' || tm[1] === '凌晨') && h === 12) h = 0;
    if (h <= 23 && mi <= 59) time = `${pad2(h)}:${pad2(mi)}`;
  }
  return { date: `${y}-${pad2(mo)}-${pad2(da)}`, time };
}

const isoOf = (dt) => (dt ? (dt.time ? `${dt.date}T${dt.time}` : dt.date) : null);

/**
 * 場次購票按鈕上的字 → { status, label }。只看按鈕，不看旁邊的備註（「12:00截止」是販售中場次的截止時間）。
 *   on-sale 販售中、sold-out 已售完、not-open 尚未開賣、closed 已停止販售、unknown 看不出來
 * 真站上核對過的只有「線上購票」「已售完」（2026-10-15，ibon 活動 39972）；其他字是照常見寫法推測的，還沒在真站看過。
 */
const STATUS_RULES = [
  [/已售完|售完|完售|額滿/, 'sold-out', '已售完'],
  [/尚未開賣|即將開賣|未開賣|尚未開放|即將開放|尚未開始/, 'not-open', '尚未開賣'],
  [/已截止|截止販售|已結束|停止販售|停售|暫停販售|銷售結束/, 'closed', '已停止販售'],
  [/線上購票|立即購買|立即購票|購票|購買/, 'on-sale', '販售中'],
];
export function sessionStatus(buttonText, disabled = false) {
  const t = oneLine(buttonText);
  for (const [re, status, label] of STATUS_RULES) {
    if (!re.test(t)) continue;
    if (status === 'on-sale' && disabled) return { status: 'unknown', label: `「${t}」按鈕目前不能按` };
    return { status, label };
  }
  return { status: 'unknown', label: t ? `看不出狀態（按鈕寫「${t}」）` : '看不出狀態' };
}

/** 場次旁的備註：「2026/11/13 12:00截止」→ { saleEnd }（真站看過）；「2026/10/20 12:00 開賣」→ { saleStart }（推測的寫法，真站還沒看過）；其他回 {} */
/** 台灣時間（ibon 寫的時間）「2026-10-16T12:00」→ 毫秒；只有日期回 NaN */
function twMs(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 8, Number(m[5])) : NaN;
}

export function parseSessionNote(note) {
  const t = oneLine(note);
  const iso = isoOf(parseDateTime(t));
  if (!iso) return {};
  if (/截止|結束/.test(t)) return { saleEnd: iso };
  if (/開賣|啟售|開始販售|開放購票|開始售票|開始購票/.test(t)) return { saleStart: iso };
  return {};
}

/**
 * 節目介紹裡寫開賣時間的行（售票時間、開賣時間、啟售時間、On Sale…）→ [{ at, text }]。
 * 一場活動可能有好幾個階段（會員預購、全面開賣），全部列出，原文一起附上給人核對。
 */
export function parseSaleTimes(text) {
  const out = [];
  for (const raw of String(text || '').split(/\n+/)) {
    const line = oneLine(raw);
    if (!/售票時間|開賣時間|啟售時間|開賣日期|售票日期|啟售日期|開始售票|On\s*Sale/i.test(line)) continue;
    const at = isoOf(parseDateTime(line));
    if (at && !out.some((x) => x.at === at && x.text === line)) out.push({ at, text: line });
  }
  return out;
}

/**
 * 節目介紹裡寫票價的行 → { lines: [原文], prices: [{ name, price }] }。
 * 認得「MVP $8000 | VIP區 $7000」「全票 NT$500、優待票 NT$250」「A區 3,880 元」；只有數字沒有名稱時 name 是空字串。
 * 票區名稱只是節目介紹裡寫的，實際能買的票區要進購票流程才看得到，這裡不進去。
 */
// 名稱：可以數字開頭（「2樓B區」），但不能全是數字
const NAME = '((?:\\d{1,2})?[^\\s\\d|｜/／、,，:：;；$＄()（）\\[\\]【】][^\\s|｜/／、,，:：;；$＄()（）\\[\\]【】]{0,15}?)';
const WITH_DOLLAR = new RegExp(`${NAME}\\s*[:：]?\\s*(?:NT|TWD)?\\s*[$＄]\\s*([\\d,]{2,7})`, 'gi');
const WITH_YUAN = new RegExp(`${NAME}\\s*[:：]?\\s*([\\d,]{3,7})\\s*元`, 'g');
const BARE = /(?:NT|TWD)?\s*[$＄]\s*([\d,]{2,7})|([\d,]{3,7})\s*元/gi;
const PRICE_LINE = /票價|Ticket\s*Price|售價|價格/i;
const NOT_A_NAME = /^(票價資訊|票價|Price|價格|售價|Ticket)$/i;

export function parsePrices(text) {
  const all = String(text || '').split(/\n+/).map(oneLine).filter(Boolean);
  const lines = [];
  const prices = [];
  const add = (name, price) => {
    const n = NOT_A_NAME.test(name) ? '' : name;
    if (!(price > 0) || prices.some((p) => p.name === n && p.price === price)) return;
    prices.push({ name: n, price });
  };
  for (let i = 0; i < all.length; i++) {
    if (!PRICE_LINE.test(all[i])) continue;
    let body = all[i];
    // 「票價：」後面沒有數字，票價寫在下一行
    if (!/\d/.test(body.replace(/^.*?(票價|Ticket\s*Price|售價|價格)/i, '')) && all[i + 1]) body += ' ' + all[i + 1];
    lines.push(body);
    // 加購條件（「單張最低票價達200-399元票價可加購高鐵單程票」，真站 39998）不是票價：整行不取金額
    if (/加購/.test(body)) continue;
    // 金額區間、門檻（「200-399元」「400元以上」）不是某個票區的價格
    body = body.replace(/\d[\d,]*\s*[-–~～至]\s*\d[\d,]*\s*元/g, ' ').replace(/\d[\d,]*\s*元?\s*(以上|以下|起)/g, ' ');
    for (const m of body.matchAll(WITH_DOLLAR)) add(m[1], toNum(m[2]));
    for (const m of body.matchAll(WITH_YUAN)) add(m[1], toNum(m[2]));
    // 沒有名稱的金額：上面沒抓到的才補上
    for (const m of body.matchAll(BARE)) {
      const price = toNum(m[1] || m[2]);
      if (!prices.some((x) => x.price === price)) add('', price);
    }
  }
  return { lines, prices };
}

/** 購票須知裡的限購規定（「每位會員限購4張」之類）→ 原文，最多 6 行 */
export function parseLimits(text) {
  const out = [];
  for (const raw of String(text || '').split(/\n+/)) {
    const line = oneLine(raw);
    if (/限購|每人限|每筆.{0,6}限|購買上限/.test(line) && !out.includes(line)) out.push(line);
  }
  return out.slice(0, 6);
}

/**
 * 頁面讀到的原始資料 → 給人看的活動資訊。raw 的每個欄位都是頁面上看得到的文字：
 *   { url, title, offers: [{ label, value }], sessions: [{ when, name, venue, button, disabled, note }], description, notice, fullText }
 * description 是節目介紹（票價、開賣時間從這裡找，找不到才用 fullText），notice 是購票須知（限購規定從這裡找，沒有才用 fullText）。
 */
export function buildEventInfo(raw, now = Date.now()) {
  const r = raw || {};
  const pick = (fn, empty) => { const x = fn(r.description); return empty(x) && r.fullText ? fn(r.fullText) : x; };
  const saleTimes = pick(parseSaleTimes, (x) => !x.length);
  const futureSale = saleTimes.map((x) => twMs(x.at)).filter((t) => t > now).sort((a, b) => a - b)[0];
  const sessions = (r.sessions || []).map((s) => {
    const dt = parseDateTime(s.when);
    let st = sessionStatus(s.button, !!s.disabled);
    const ownStart = parseSessionNote(s.note).saleStart;
    const startMs = ownStart ? twMs(ownStart) : futureSale;
    // 開賣前「線上購票」是灰的（真站 39998，2026-10-16 看過）：開賣時間還沒到才當成尚未開賣，照實寫是推斷的；時間過了還是灰的就維持看不出來
    if (st.status === 'unknown' && s.disabled && /線上購票/.test(oneLine(s.button)) && startMs > now) {
      st = { status: 'not-open', label: '尚未開賣（「線上購票」還不能按，開賣時間還沒到）', inferred: true };
    }
    return {
      when: oneLine(s.when), date: dt ? dt.date : null, time: dt ? dt.time : null,
      name: oneLine(s.name), venue: oneLine(s.venue),
      status: st.status, statusLabel: st.label, inferred: !!st.inferred, note: oneLine(s.note),
      ...parseSessionNote(s.note),
    };
  });
  const p = pick(parsePrices, (x) => !x.prices.length);
  return {
    url: r.url || '',
    title: oneLine(r.title),
    offers: (r.offers || []).map((o) => ({ label: oneLine(o.label), value: oneLine(o.value) })).filter((o) => o.label || o.value),
    sessions,
    prices: p.prices,
    priceLines: p.lines,
    saleTimes,
    limits: parseLimits(r.notice || r.fullText || r.description),
    readAt: now,
  };
}

/**
 * 頁面程式交回來的活動資訊不全信（它讀的是網站的內容）：只留認得的欄位，數量與長度都設上限，
 * 日期、狀態、金額不合格式就丟掉。設定頁也只用 textContent 顯示，不當 HTML。
 */
const STATUSES = ['on-sale', 'sold-out', 'not-open', 'closed', 'unknown'];
export function sanitizeInfo(info, now = Date.now()) {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const time = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v) ? v : null);
  const i = obj(info);
  return {
    title: str(i.title, 200),
    offers: arr(i.offers, 6).map(obj).map((o) => ({ label: str(o.label, 20), value: str(o.value, 100) })),
    sessions: arr(i.sessions, 50).map(obj).map((x) => ({
      when: str(x.when, 40), date: date(x.date), time: time(x.time), name: str(x.name, 120), venue: str(x.venue, 80),
      status: STATUSES.includes(x.status) ? x.status : 'unknown', statusLabel: str(x.statusLabel, 60), inferred: x.inferred === true, note: str(x.note, 80),
      saleEnd: iso(x.saleEnd), saleStart: iso(x.saleStart),
    })),
    prices: arr(i.prices, 30).map(obj).filter((x) => Number.isFinite(x.price) && x.price > 0 && x.price < 1e7)
      .map((x) => ({ name: str(x.name, 30), price: Math.round(x.price) })),
    priceLines: arr(i.priceLines, 10).map((l) => str(l, 300)).filter(Boolean),
    saleTimes: arr(i.saleTimes, 10).map(obj).map((x) => ({ at: iso(x.at), text: str(x.text, 300) })).filter((x) => x.at),
    limits: arr(i.limits, 6).map((l) => str(l, 200)).filter(Boolean),
    warnings: arr(i.warnings, 5).map((w) => str(w, 200)).filter(Boolean),
    login: i.login && typeof i.login === 'object'
      ? { state: ['logged-out', 'unknown'].includes(i.login.state) ? i.login.state : 'unknown', verified: i.login.verified === true, msg: str(i.login.msg, 200) }
      : null,
    readAt: Number.isFinite(i.readAt) ? i.readAt : now,
  };
}
