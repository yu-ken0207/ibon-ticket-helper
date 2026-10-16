// ibon 售票系統的整合規則（純函式，不碰網頁）：頁面分類、操作政策、活動資訊驗證、需求比對、結構快照的個資遮罩。
// 「已驗證」是在真站看過的（2026-10-15，活動 39972）；其他是推測，照實標出來，不當成已知。

/**
 * 網址 → ibon 頁面種類；不是 ibon 回 null。
 *   activity        活動頁 ticket.ibon.com.tw/ActivityInfo/Details/<數字>（已驗證）
 *   go-ticket       活動頁「線上購票」的轉址 /ActivityInfo/GoTicketURL（已驗證：真站資料裡的連結）
 *   purchase-entry  購票流程入口 orders.ibon.com.tw/application/UTK02/UTK0201_000.aspx（網址已驗證；頁面結構還沒看過）
 *   buyer-info      填寫購票資訊（流程第 4 步）orders.ibon.com.tw/application/UTK02/UTK0206_.aspx（2026-10-16 真站快照核對過）
 *   purchase        購票流程的其他頁 orders.ibon.com.tw/application/UTK02/…（推測）
 *   ticket-other、orders-other  同網域的其他頁
 */
export function ibonPageKind(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.hostname === 'ticket.ibon.com.tw') {
    if (/^\/ActivityInfo\/Details\/\d+\/?$/.test(u.pathname)) return 'activity';
    if (/^\/ActivityInfo\/GoTicketURL\/?$/i.test(u.pathname)) return 'go-ticket';
    return 'ticket-other';
  }
  if (u.hostname === 'orders.ibon.com.tw') {
    if (/^\/application\/UTK02\/UTK0201_000\.aspx$/i.test(u.pathname)) return 'purchase-entry';
    if (/^\/application\/UTK02\/UTK0206_\.aspx$/i.test(u.pathname)) return 'buyer-info';
    if (/^\/application\/UTK02\//i.test(u.pathname)) return 'purchase';
    return 'orders-other';
  }
  return null;
}

export const isIbonPage = (url) => ibonPageKind(url) != null;

/** 頁面種類給人看的名字，以及這種頁的結構有沒有在真站核對過 */
export const IBON_PAGE_INFO = {
  activity: { label: '活動頁', verified: true },
  'go-ticket': { label: '線上購票轉址', verified: true },
  'purchase-entry': { label: '購票流程入口（UTK0201）', verified: false },
  'buyer-info': { label: '填寫購票資訊（UTK0206，第 4 步）', verified: true },
  purchase: { label: '購票流程的其他頁', verified: false },
  'ticket-other': { label: 'ibon 售票網的其他頁', verified: false },
  'orders-other': { label: 'ibon 訂購網域的其他頁', verified: false },
};

/*
 * 操作政策：每種操作在 ibon 上怎麼處理。
 *   auto    助手可以自己做（只讀或只在擴充功能裡計算，不碰網站）
 *   manual  你自己在網站上做，助手只提示；要等 ibon 確認認可這類擴充功能才會評估自動化
 *   never   助手不做，也不提供任何繞過方式
 * basis 是依據（服務條款條次、購票須知原文），設定頁照實顯示。
 */
export const IBON_POLICY = [
  { action: 'read', label: '讀取你已經打開的頁面資訊', mode: 'auto', basis: '只讀頁面上看得到的內容，不送請求、不改變網站狀態' },
  { action: 'compare', label: '比對你的票區、張數需求', mode: 'auto', basis: '在擴充功能裡計算，不碰網站' },
  { action: 'snapshot', label: '記錄頁面結構快照（你按了才記）', mode: 'auto', basis: '只讀；遮掉 Email、電話、身分證、長數字，不記錄欄位內容' },
  { action: 'session', label: '點選場次（開賣時自動點你選的場次的「線上購票」一次）', mode: 'auto', basis: 'ibon 售票服務客服中心 2026-10-16 回覆：允許於自動讀取活動資訊、選擇場次、填寫訂購資料使用自動化工具；仍不得規避驗證、排隊、限購等機制' },
  { action: 'select', label: '點選票區', mode: 'auto', basis: 'ibon 售票服務客服中心 2026-10-16 第二封回覆：允許自動選擇區段、選取張數、點選下一頁、勾選同意約款（限個人購票使用）' },
  { action: 'quantity', label: '選張數', mode: 'auto', basis: '同上' },
  { action: 'submit', label: '按「下一步」、勾同意約款', mode: 'auto', basis: '同上；驗證碼由你輸入，付款由你本人親自操作' },
  { action: 'refresh', label: '開賣時自動重新整理（到點後一次、之後每秒一次、最多 30 次）', mode: 'auto', basis: 'ibon 客服 2026-10-16 第二封回覆：不設特定秒數限制，但異常頻繁的請求會被系統防護機制處理（如 IP 阻斷），請符合人類正常操作邏輯' },
  { action: 'confirm', label: '最後的確認／建立訂單', mode: 'manual', basis: '不可逆；助手不做，一定由你自己按' },
  { action: 'captcha', label: '驗證碼', mode: 'never', basis: '不繞過驗證機制，由你自己輸入' },
  { action: 'queue', label: '排隊、流量控管', mode: 'never', basis: '不繞過；購票須知：「出現流量控管中，請耐心等候重新再試」' },
  { action: 'limit', label: '超過限購（例如用其他帳號）', mode: 'never', basis: '服務條款第十一條(4) 重覆註冊帳號規避限制；購票須知「每位會員限購 N 張」' },
  { action: 'payment', label: '付款', mode: 'never', basis: '一律由你自己付款，不保存任何付款資料' },
];

const ibNorm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
/** 「2026-10-04T14:00」「2026-10-04」→ 本機時間的毫秒；看不懂回 NaN */
export function localTime(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)).getTime();
}
const ibDt = (iso) => String(iso || '').replace('T', ' ').replace(/-/g, '/');
const ibDays = (ms) => Math.floor(ms / 86400000);
/** 剩下多久：一天以上寫幾天，不到一天寫幾小時幾分（真站 39998：當天開賣原本寫成「還有 0 天」） */
const ibLeft = (ms) => {
  if (ms >= 86400000) return `${ibDays(ms)} 天`;
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `約 ${Math.floor(m / 60)} 小時 ${m % 60} 分` : `約 ${m} 分鐘`;
};

/**
 * 讀到的活動資訊做基本檢查 → [{ level: 'warn' | 'info', msg }]。只提示，不擋任何事。
 */
export function validateEventInfo(info, now = Date.now()) {
  const out = [];
  const i = info || {};
  const ss = Array.isArray(i.sessions) ? i.sessions : [];
  if (!i.title) out.push({ level: 'warn', msg: '沒有讀到活動名稱' });
  if (!ss.length) out.push({ level: 'warn', msg: '沒有讀到任何場次（可能還沒開放、已下架，或頁面結構改了）' });
  const noDate = ss.filter((s) => !s.date);
  if (noDate.length) out.push({ level: 'warn', msg: `${noDate.length} 個場次看不出日期` });
  if (ss.length && ss.every((s) => s.status === 'sold-out')) out.push({ level: 'info', msg: '所有場次都顯示已售完' });
  const ended = ss.filter((s) => s.saleEnd && localTime(s.saleEnd) <= now);
  if (ended.length) out.push({ level: 'info', msg: `${ended.length} 個場次已過販售截止時間` });
  const unknown = ss.filter((s) => s.status === 'unknown');
  if (unknown.length) out.push({ level: 'warn', msg: `${unknown.length} 個場次的狀態看不出來（按鈕上的字沒見過）` });
  const sale = (Array.isArray(i.saleTimes) ? i.saleTimes : []).map((x) => ({ ...x, t: localTime(x.at) })).filter((x) => Number.isFinite(x.t));
  if (!sale.length) out.push({ level: 'info', msg: '節目介紹裡沒有認得的開賣時間' });
  else {
    const next = sale.filter((x) => x.t > now).sort((a, b) => a.t - b.t)[0];
    if (next) out.push({ level: 'info', msg: `開賣時間 ${ibDt(next.at)}（還有 ${ibLeft(next.t - now)}）` });
    else out.push({ level: 'info', msg: `已經開賣（${ibDt(sale[0].at)}）` });
  }
  if (!(Array.isArray(i.prices) && i.prices.length)) out.push({ level: 'warn', msg: '節目介紹裡沒有認得的票價；實際票區與票價要在購票頁看' });
  return out;
}

/** 限購規定的原文 → 一般會員每次最多幾張（身障、陪同票的另外規定不算）；看不出來回 null */
export function memberLimit(limits) {
  const r = limitInfo(limits);
  return r ? r.n : null;
}

/** 同上，加上範圍：{ n, scope: '每位會員' | '每筆交易' | '' }；全形數字「限購４張」也認得（真站 39998 看過） */
export function limitInfo(limits) {
  let best = null;
  for (const raw of Array.isArray(limits) ? limits : []) {
    const line = String(raw).replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFF10 + 48));
    if (/身障|身心障礙|陪同|周邊|商品/.test(line)) continue;
    const m = line.match(/限購\s*(\d{1,2})\s*張/);
    if (!m) continue;
    const n = Number(m[1]);
    const scope = /每位會員|每人|每個帳號/.test(line) ? '每位會員' : /每筆/.test(line) ? '每筆交易' : '';
    if (!best || n < best.n) best = { n, scope };
  }
  return best;
}

/** 設定頁的需求（票區偏好一行一個、張數、最高單價）→ 整理過的格式 */
export function parseIbonPrefs(raw) {
  const r = raw || {};
  const areas = String(r.areas || '').split(/\n+/).map(ibNorm).filter(Boolean).slice(0, 10);
  const qty = Number.parseInt(r.qty, 10);
  const maxPrice = Number.parseInt(String(r.maxPrice || '').replace(/[,，\s]/g, ''), 10);
  return { areas, qty: Number.isInteger(qty) && qty > 0 ? qty : null, maxPrice: Number.isInteger(maxPrice) && maxPrice > 0 ? maxPrice : null };
}

const ibFold = (s) => ibNorm(s).toLowerCase().replace(/\s+/g, '');

/**
 * 需求 → 跟活動資訊比對（只計算，不碰網站）。
 * 票區只對得到節目介紹寫的票價表；實際能買的票區、剩餘數量要在購票頁看。
 * 回 { qty: { want, limit, ok, msg }, areas: [{ pref, hits, ok, msg }], onSale, msgs }
 */
export function matchIbonPrefs(info, prefsRaw) {
  const prefs = parseIbonPrefs(prefsRaw);
  const i = info || {};
  const prices = Array.isArray(i.prices) ? i.prices : [];
  const limit = memberLimit(i.limits);
  const qty = { want: prefs.qty, limit, ok: true, msg: '' };
  if (prefs.qty == null) { qty.ok = false; qty.msg = '還沒設定張數'; }
  else if (limit != null && prefs.qty > limit) { qty.ok = false; qty.msg = `${prefs.qty} 張超過限購 ${limit} 張：網站不會接受，助手也不會用其他帳號幫你繞過`; }
  else qty.msg = limit != null ? `${prefs.qty} 張，在限購 ${limit} 張以內` : `${prefs.qty} 張（購票須知裡沒有認得的限購規定）`;

  const areas = prefs.areas.map((pref) => {
    const words = pref.split(/\s+/).map(ibFold).filter(Boolean);
    const named = prices.filter((p) => p.name && words.every((w) => ibFold(p.name).includes(w)));
    const hits = prefs.maxPrice ? named.filter((p) => p.price <= prefs.maxPrice) : named;
    let msg;
    if (!named.length) msg = `「${pref}」：節目介紹的票價表裡沒有這個票區`;
    else if (!hits.length) msg = `「${pref}」：${named.map((p) => `${p.name} NT$${p.price}`).join('、')} 都超過你設定的最高單價 NT$${prefs.maxPrice}`;
    else msg = `「${pref}」：${hits.map((p) => `${p.name} NT$${p.price}`).join('、')}`;
    return { pref, hits, ok: hits.length > 0, msg };
  });
  const ss = Array.isArray(i.sessions) ? i.sessions : [];
  const onSale = ss.filter((s) => s.status === 'on-sale').length;
  const msgs = [];
  if (!prefs.areas.length) msgs.push('還沒設定票區偏好');
  if (prices.length && prefs.areas.length && !areas.some((a) => a.ok)) msgs.push('偏好的票區都對不到節目介紹的票價表，請確認名稱（照網站上的寫法）');
  if (ss.length && !onSale) msgs.push('目前沒有販售中的場次');
  return { qty, areas, onSale, msgs };
}

/**
 * 結構快照用：把可能是個資的文字遮掉（Email、手機、身分證字號、6 碼以上的連續數字如卡號、序號）。
 * 日期（2026-10-04、2026/10/04）、時間、有千分位的金額保留。姓名這類沒有固定格式的，遮不到，要請你自己看過再交出去。
 */
export function maskText(s, own = []) {
  let t = String(s == null ? '' : s);
  // 你自己在設定頁填的姓名、手機、Email：出現在哪裡都遮（只拿來比對，不會記下來）
  for (const w of own) if (w && String(w).length >= 2) t = t.split(String(w)).join('[你的資料]');
  return t
    // 「王小明 您好」「姓名：王小明」這類有固定說法的姓名
    .replace(/([^\s，,｜|:：／/()（）\[\]]{1,12})\s*(您好|你好|先生您好|小姐您好)/g, '[姓名] $2')
    .replace(/(姓名|會員|購票人|收件人|持票人|取票人|聯絡人)(\s*[:：]\s*)([^\s，,｜|／/()（）]{1,20})/g, '$1$2[姓名]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b[A-Za-z][12]\d{8}\b/g, '[身分證]')
    .replace(/(?:\+?886[-\s]?|\b0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/g, '[手機]')
    .replace(/\d[\d\s-]{4,}\d/g, (m) => (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(m) || /^\d{1,2}:\d{2}$/.test(m) ? m : '[數字]'));
}

/** 網址只留來源與路徑，查詢參數只留名稱（值可能是訂單、會員之類的編號） */
/**
 * 快照存檔前再掃一次：還看得到 Email、手機、身分證、6 碼以上的數字、你的資料，就回傳找到的種類（不回傳內容本身）。
 * 有找到就不存檔。
 */
export function leakCheck(text, own = []) {
  const t = String(text || '');
  const found = [];
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t)) found.push('Email');
  if (/(?:\+?886[-\s]?|\b0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/.test(t)) found.push('手機');
  if (/\b[A-Za-z][12]\d{8}\b/.test(t)) found.push('身分證字號');
  if ((t.match(/\d[\d\s-]{4,}\d/g) || []).some((m) => !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(m))) found.push('長數字');
  if (own.some((w) => w && String(w).length >= 2 && t.includes(String(w)))) found.push('你的資料');
  return found;
}

export function maskUrl(href, base) {
  try {
    const u = new URL(href, base);
    const keys = [...new Set(u.searchParams.keys())];
    return `${u.origin}${u.pathname}${keys.length ? `?${keys.map((k) => `${k}=…`).join('&')}` : ''}`;
  } catch (_) {
    return '';
  }
}

/**
 * 頁面上的文字 → 可能的狀態提示（只是提示，購票頁的結構還沒在真站看過，所以都標「未驗證」）。
 * 活動頁的狀態不靠這個：活動頁直接讀場次表的按鈕（已驗證）。
 */
const STATE_HINTS = [
  ['captcha', /驗證碼|captcha|請輸入圖形|機器人/i, '頁面上有驗證碼相關的字：由你自己處理'],
  ['queue', /排隊|等候室|流量控管|請耐心等候|人數眾多/, '頁面上有排隊或流量控管的字：請等候，不要重複整理'],
  ['sold-out', /已售完|售完|完售|額滿/, '頁面上有售完的字'],
  ['not-open', /尚未開賣|即將開賣|尚未開放|未開賣/, '頁面上有尚未開賣的字'],
  ['login', /請先登入|會員登入|登入逾時/, '頁面要求登入：請自己登入'],
  ['limit', /超過.{0,6}限購|購買上限|已達.{0,4}上限/, '頁面提到購買上限'],
  ['error', /系統忙碌|系統錯誤|發生錯誤|請稍後再試|Error|錯誤代碼/i, '頁面上有錯誤訊息'],
];
export function stateHints(text) {
  const t = String(text || '');
  return STATE_HINTS.filter(([, re]) => re.test(t)).map(([state, re, msg]) => ({ state, msg, evidence: ibNorm((t.match(re) || [''])[0]).slice(0, 20), verified: false }));
}


/* ───────────────────────── 填寫購票資訊（UTK0206，流程第 4 步） ─────────────────────────
 * 結構照 2026-10-16 的真站快照（一次、一個活動、全票 1 張、信用卡與 ibon 紙票）：
 *   上方步驟列 1 選擇活動/商品 → 2 選擇票區 → 3 座位/數量 → 4 填寫購票資訊 → 5 購票確認 → 6 訂票完成
 *   訂單表格的欄位用 data-title 標：名稱、活動時間、場地、區域/座位、票種（下拉，選項如「全票-NT$5,800」）、數量、價格(NT$)
 *   「總計(付款金額)」、保留倒數「剩餘時間 mm:ss」、訂購人基本資料（聯絡電話欄、電子郵件只顯示）、付款方式、取票方式、同意退票代辦的勾選框、
 *   按鈕「取消」「繼續選購」「下一步，核對資料」。這一頁沒看到驗證碼。
 * 頁面程式（src/info/20-adapter.js 的 readBuyerInfo）只把看到的字交過來；這裡整理成欄位。不收電話、Email 的內容，只收有沒有填。
 */
const ibMoney = (v) => {
  const m = String(v == null ? '' : v).replace(/[,，\s]/g, '').match(/\d+/);
  return m ? Number(m[0]) : null;
};

/** 票種下拉的選項「全票-NT$5,800」→ { name: '全票', price: 5800 }；認不得回 null */
export function parseTicketOption(text) {
  const m = ibNorm(text).match(/^(.+?)\s*[-－–]\s*NT\$\s*([\d,]+)$/);
  return m ? { name: m[1].trim(), price: ibMoney(m[2]) } : null;
}

/**
 * raw: { steps: [{ n, text, active }], title, rows: [{ name, time, venue, seat, type, qty, price }], total, countdown,
 *        discount, phoneFilled, emailShown, pay: [{ label, checked }], get: [{ label, checked }], agree, buttons: [字], captchaText }
 * 回整理好的內容；讀不到的項目是 null（不猜）。
 */
export function parseBuyerInfo(raw) {
  const r = raw || {};
  const steps = Array.isArray(r.steps) ? r.steps : [];
  const active = steps.find((s) => s && s.active);
  const rows = (Array.isArray(r.rows) ? r.rows : []).map((x) => {
    const t = parseTicketOption(x.type);
    const qty = Number.parseInt(String(x.qty == null ? '' : x.qty).trim(), 10);
    return {
      name: ibNorm(x.name) || null, time: ibNorm(x.time) || null, venue: ibNorm(x.venue) || null, seat: ibNorm(x.seat) || null,
      ticketType: t ? t.name : (ibNorm(x.type) || null), unitPrice: t ? t.price : null,
      qty: Number.isInteger(qty) && qty > 0 ? qty : null, price: ibMoney(x.price),
    };
  });
  const cd = String(r.countdown || '').match(/(\d{1,2}):(\d{2})/);
  const picked = (list) => {
    const l = Array.isArray(list) ? list : [];
    if (!l.length) return null;
    const c = l.find((x) => x && x.checked);
    const short = (t) => (ibNorm(t).replace(/\s*[（(].*$/, '') || ibNorm(t)).slice(0, 40);   // 「信用卡(可使用VISA…)」→「信用卡」
    return { options: l.map((x) => short(x.label)), chosen: c ? short(c.label) : null };
  };
  const buttons = (Array.isArray(r.buttons) ? r.buttons : []).map(ibNorm).filter(Boolean);
  return {
    step: active ? { n: Number(active.n) || null, text: ibNorm(active.text) } : null,
    title: ibNorm(r.title) || null,
    rows,
    total: ibMoney(r.total),
    holdLeft: cd ? { text: `${cd[1].padStart(2, '0')}:${cd[2]}`, seconds: Number(cd[1]) * 60 + Number(cd[2]) } : null,
    discount: ibNorm(r.discount) || null,
    phoneFilled: typeof r.phoneFilled === 'boolean' ? r.phoneFilled : null,
    emailShown: typeof r.emailShown === 'boolean' ? r.emailShown : null,
    pay: picked(r.pay), get: picked(r.get),
    agree: typeof r.agree === 'boolean' ? r.agree : null,
    next: buttons.find((b) => /下一步/.test(b)) || null,
    captcha: r.captchaText ? ibNorm(r.captchaText).slice(0, 20) : null,
  };
}

/** 「2026/11/14 15:30」跟活動頁場次文字「2026/11/14(六) 15:30 …」是不是同一個時間；有一邊看不出日期時間就回 null（不猜） */
export function sameSessionTime(a, b) {
  const key = (s) => {
    const t = String(s || '');
    const d = t.match(/(\d{4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})/);
    const h = t.match(/(\d{1,2}):(\d{2})/);
    return d && h ? `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')} ${h[1].padStart(2, '0')}:${h[2]}` : null;
  };
  const x = key(a), y = key(b);
  return x && y ? x === y : null;
}
