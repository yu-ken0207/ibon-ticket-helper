// 這個檔案由 tools/build.mjs 從 src/info/、src/agent/05-dom.js 和 lib/eventinfo.js、lib/ibon.js 產生，請改那些地方，不要直接改這裡。
/*
 * ibon-info.js —— 活動資訊讀取程式（A 類，只讀），跑在 ISOLATED world
 *
 * 載入到 ibon 的活動頁（https://ticket.ibon.com.tw/ActivityInfo/Details/*）與購票頁（https://orders.ibon.com.tw/application/UTK02/*），
 * 只有背景程式要它讀時才讀（IbonAdapter，20-adapter.js）：活動頁讀標題、場次表、節目介紹裡的票價與開賣時間；
 * 任何一頁都可以讀頁面種類、登入狀態、狀態提示，或在你按了之後記錄結構快照。整理後交給背景程式，顯示在設定頁。
 *
 * 這支程式不點任何按鈕、不填任何欄位、不送出任何東西，也不發任何網路請求；購票按鈕只讀上面的字和能不能按。
 * 自動選購的程式（agent.js）不會載入到 ibon 的頁面。
 */
(() => {
  'use strict';

  if (window.__ITH_INFO__) return;
  window.__ITH_INFO__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return el.getClientRects().length > 0;
  }

  /** 元素裡的文字，保留換行：段落、清單、<br> 換成換行（收合起來看不到的區塊也讀得到） */
  const BLOCK = new Set(['P', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'HR']);
  function blockText(root) {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) { out.push(n.nodeValue); return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (tag === 'BR') { out.push('\n'); return; }
      const block = BLOCK.has(tag);
      if (block) out.push('\n');
      for (const c of n.childNodes) walk(c);
      if (block) out.push('\n');
    };
    if (root) walk(root);
    return out.join('').split('\n').map((l) => l.replace(/[ \t　]+/g, ' ').trim()).filter(Boolean).join('\n');
  }


  /* ───── 內嵌 lib/eventinfo.js ───── */
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
  function parseDateTime(text) {
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
  function sessionStatus(buttonText, disabled = false) {
    const t = oneLine(buttonText);
    for (const [re, status, label] of STATUS_RULES) {
      if (!re.test(t)) continue;
      if (status === 'on-sale' && disabled) return { status: 'unknown', label: `「${t}」按鈕目前不能按` };
      return { status, label };
    }
    return { status: 'unknown', label: t ? `看不出狀態（按鈕寫「${t}」）` : '看不出狀態' };
  }

  /** 場次旁的備註：「2026/11/13 12:00截止」→ { saleEnd }（真站看過）；「2026/10/20 12:00 開賣」→ { saleStart }（推測的寫法，真站還沒看過）；其他回 {} */
  function parseSessionNote(note) {
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
  function parseSaleTimes(text) {
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

  function parsePrices(text) {
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
  function parseLimits(text) {
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
  function buildEventInfo(raw, now = Date.now()) {
    const r = raw || {};
    const sessions = (r.sessions || []).map((s) => {
      const dt = parseDateTime(s.when);
      const st = sessionStatus(s.button, !!s.disabled);
      return {
        when: oneLine(s.when), date: dt ? dt.date : null, time: dt ? dt.time : null,
        name: oneLine(s.name), venue: oneLine(s.venue),
        status: st.status, statusLabel: st.label, note: oneLine(s.note),
        ...parseSessionNote(s.note),
      };
    });
    const pick = (fn, empty) => { const x = fn(r.description); return empty(x) && r.fullText ? fn(r.fullText) : x; };
    const p = pick(parsePrices, (x) => !x.prices.length);
    return {
      url: r.url || '',
      title: oneLine(r.title),
      offers: (r.offers || []).map((o) => ({ label: oneLine(o.label), value: oneLine(o.value) })).filter((o) => o.label || o.value),
      sessions,
      prices: p.prices,
      priceLines: p.lines,
      saleTimes: pick(parseSaleTimes, (x) => !x.length),
      limits: parseLimits(r.notice || r.fullText || r.description),
      readAt: now,
    };
  }

  /**
   * 頁面程式交回來的活動資訊不全信（它讀的是網站的內容）：只留認得的欄位，數量與長度都設上限，
   * 日期、狀態、金額不合格式就丟掉。設定頁也只用 textContent 顯示，不當 HTML。
   */
  const STATUSES = ['on-sale', 'sold-out', 'not-open', 'closed', 'unknown'];
  function sanitizeInfo(info, now = Date.now()) {
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
        status: STATUSES.includes(x.status) ? x.status : 'unknown', statusLabel: str(x.statusLabel, 60), note: str(x.note, 80),
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

  /* ───── 內嵌 lib/ibon.js ───── */
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
  function ibonPageKind(url) {
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

  const isIbonPage = (url) => ibonPageKind(url) != null;

  /** 頁面種類給人看的名字，以及這種頁的結構有沒有在真站核對過 */
  const IBON_PAGE_INFO = {
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
  const IBON_POLICY = [
    { action: 'read', label: '讀取你已經打開的頁面資訊', mode: 'auto', basis: '只讀頁面上看得到的內容，不送請求、不改變網站狀態' },
    { action: 'compare', label: '比對你的票區、張數需求', mode: 'auto', basis: '在擴充功能裡計算，不碰網站' },
    { action: 'snapshot', label: '記錄頁面結構快照（你按了才記）', mode: 'auto', basis: '只讀；遮掉 Email、電話、身分證、長數字，不記錄欄位內容' },
    { action: 'select', label: '點選場次、票區', mode: 'manual', basis: '服務條款第十一條：不得以「非本公司認可之方式」使用本系統；第五條：請依照螢幕上程序操作' },
    { action: 'quantity', label: '選張數', mode: 'manual', basis: '同上' },
    { action: 'submit', label: '按「下一步」、送出訂單', mode: 'manual', basis: '同上；送出是不可逆的操作，一定由你自己按' },
    { action: 'refresh', label: '開賣時自動重新整理', mode: 'manual', basis: '服務條款開頭敬告（不得以不正方式利用電腦程式搶購）、第十二條(4) 異常大量交易' },
    { action: 'captcha', label: '驗證碼', mode: 'never', basis: '不繞過驗證機制，由你自己輸入' },
    { action: 'queue', label: '排隊、流量控管', mode: 'never', basis: '不繞過；購票須知：「出現流量控管中，請耐心等候重新再試」' },
    { action: 'limit', label: '超過限購（例如用其他帳號）', mode: 'never', basis: '服務條款第十一條(4) 重覆註冊帳號規避限制；購票須知「每位會員限購 N 張」' },
    { action: 'payment', label: '付款', mode: 'never', basis: '一律由你自己付款，不保存任何付款資料' },
  ];

  const ibNorm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
  /** 「2026-10-04T14:00」「2026-10-04」→ 本機時間的毫秒；看不懂回 NaN */
  function localTime(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
    if (!m) return NaN;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)).getTime();
  }
  const ibDt = (iso) => String(iso || '').replace('T', ' ').replace(/-/g, '/');
  const ibDays = (ms) => Math.floor(ms / 86400000);

  /**
   * 讀到的活動資訊做基本檢查 → [{ level: 'warn' | 'info', msg }]。只提示，不擋任何事。
   */
  function validateEventInfo(info, now = Date.now()) {
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
      if (next) out.push({ level: 'info', msg: `開賣時間 ${ibDt(next.at)}（還有 ${ibDays(next.t - now)} 天）` });
      else out.push({ level: 'info', msg: `已經開賣（${ibDt(sale[0].at)}）` });
    }
    if (!(Array.isArray(i.prices) && i.prices.length)) out.push({ level: 'warn', msg: '節目介紹裡沒有認得的票價；實際票區與票價要在購票頁看' });
    return out;
  }

  /** 限購規定的原文 → 一般會員每次最多幾張（身障、陪同票的另外規定不算）；看不出來回 null */
  function memberLimit(limits) {
    let min = null;
    for (const line of Array.isArray(limits) ? limits : []) {
      if (/身障|身心障礙|陪同|周邊|商品/.test(line)) continue;
      const m = String(line).match(/限購\s*(\d{1,2})\s*張/);
      if (m) min = min == null ? Number(m[1]) : Math.min(min, Number(m[1]));
    }
    return min;
  }

  /** 設定頁的需求（票區偏好一行一個、張數、最高單價）→ 整理過的格式 */
  function parseIbonPrefs(raw) {
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
  function matchIbonPrefs(info, prefsRaw) {
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
  function maskText(s, own = []) {
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
  function leakCheck(text, own = []) {
    const t = String(text || '');
    const found = [];
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t)) found.push('Email');
    if (/(?:\+?886[-\s]?|\b0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/.test(t)) found.push('手機');
    if (/\b[A-Za-z][12]\d{8}\b/.test(t)) found.push('身分證字號');
    if ((t.match(/\d[\d\s-]{4,}\d/g) || []).some((m) => !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(m))) found.push('長數字');
    if (own.some((w) => w && String(w).length >= 2 && t.includes(String(w)))) found.push('你的資料');
    return found;
  }

  function maskUrl(href, base) {
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
  function stateHints(text) {
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
  function parseTicketOption(text) {
    const m = ibNorm(text).match(/^(.+?)\s*[-－–]\s*NT\$\s*([\d,]+)$/);
    return m ? { name: m[1].trim(), price: ibMoney(m[2]) } : null;
  }

  /**
   * raw: { steps: [{ n, text, active }], title, rows: [{ name, time, venue, seat, type, qty, price }], total, countdown,
   *        discount, phoneFilled, emailShown, pay: [{ label, checked }], get: [{ label, checked }], agree, buttons: [字], captchaText }
   * 回整理好的內容；讀不到的項目是 null（不猜）。
   */
  function parseBuyerInfo(raw) {
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
  function sameSessionTime(a, b) {
    const key = (s) => {
      const t = String(s || '');
      const d = t.match(/(\d{4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})/);
      const h = t.match(/(\d{1,2}):(\d{2})/);
      return d && h ? `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')} ${h[1].padStart(2, '0')}:${h[2]}` : null;
    };
    const x = key(a), y = key(b);
    return x && y ? x === y : null;
  }

  /* ───────────────────────── 語意定位 ─────────────────────────
   * 真實網站不會給程式用的固定錨點，class、id、欄位名稱也可能每次不同。這裡用「人看得到、網站也不太會改」的線索找元素：
   * 看得到的文字、標籤與欄位的對應（<label for> 或包住欄位，標準的 label.control）、表單欄位、ARIA 屬性、網址。
   * 封閉的 Shadow DOM 用擴充功能才有的 chrome.dom.openOrClosedShadowRoot 讀；網頁自己的程式拿不到，擴充功能可以。 */

  /** 元素的 shadow root：開放或封閉都拿得到；不是 shadow host 就是 null */
  function shadowOf(el) {
    try {
      if (typeof chrome !== 'undefined' && chrome.dom && chrome.dom.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el) || null;
    } catch (_) { /* 不是 HTMLElement 之類 */ }
    return el.shadowRoot || null;
  }

  /** 連同所有 Shadow DOM（包括封閉的）一起找 */
  function deepAll(selector, root = document) {
    const out = [];
    const walk = (node) => {
      out.push(...node.querySelectorAll(selector));
      for (const el of node.querySelectorAll('*')) {
        const sr = shadowOf(el);
        if (sr) walk(sr);
      }
    };
    walk(root);
    return out;
  }

  const textOf = (el) => norm(el ? (el.innerText || el.textContent) : '');
  const hit = (t, match) => (match instanceof RegExp ? match.test(t) : t.includes(match));

  /** 看得到、文字符合的元素（字串＝包含，或正規表示式） */
  function byText(selector, match, root = document) {
    return deepAll(selector, root).filter((el) => isVisible(el) && hit(textOf(el), match));
  }

  /** 照按鈕上的字找按鈕（button、role=button、連結） */
  function buttonByText(match, root = document) {
    return byText('button, [role="button"], a, input[type="submit"], input[type="button"]', match, root)[0] || null;
  }

  /** 照標籤文字找欄位：完全相同優先，再來是開頭相同，最後是正規表示式 */
  function fieldByLabel(match, root = document) {
    const labels = deepAll('label', root);
    const pick = (ok) => {
      for (const label of labels) {
        if (!ok(textOf(label))) continue;
        const c = label.control || label.querySelector('input, select, textarea');
        if (c) return c;
      }
      return null;
    };
    if (match instanceof RegExp) return pick((t) => match.test(t));
    return pick((t) => t === match) || pick((t) => t.startsWith(match));
  }

  /** 欄位旁邊的錯誤訊息：同一個欄位容器裡看得到的 role=alert */
  function alertNear(control) {
    const box = control && control.closest('div');
    const el = box ? [...box.querySelectorAll('[role="alert"]')].find((a) => !a.hidden && isVisible(a) && textOf(a)) : null;
    return el ? textOf(el) : '';
  }

  /** 按鈕那一列正上方的訊息（表單層級的錯誤通常放在送出按鈕上面） */
  function alertAbove(button) {
    const row = button && button.parentElement;
    const prev = row && row.previousElementSibling;
    return prev && prev.getAttribute('role') === 'alert' && !prev.hidden && isVisible(prev) ? textOf(prev) : '';
  }
  /* ───────────────────────── 讀 ibon 活動頁（只讀） ─────────────────────────
   * 頁面上看得到的東西：
   *   標題        <h1>
   *   售票平台    「售票平台：」「票券型態：」這類清單
   *   場次表      <app-game> 的封閉 Shadow DOM 裡：表頭（演出 / 銷售日期、場次名稱、場地 / 地區）和每一列；
   *               每列最後一格是購票按鈕（「線上購票」「已售完」…）和截止時間之類的小字
   *   節目介紹    票價、售票時間寫在這裡的文字裡（各活動寫法不同，lib/eventinfo.js 盡量認，原文也一起給你看）
   * 場次表比頁面其他部分晚出現，要等一下。等不到就照實回報「沒讀到場次表」，不猜。 */

  /** 場次表的表頭：找寫著「場次名稱」的那一格，回傳整列各格的文字；沒有就 null */
  function sessionHeader() {
    const cell = deepAll('p, th, span, div').find((el) => el.children.length === 0 && /場次名稱/.test(textOf(el) || el.textContent));
    if (!cell || !cell.parentElement) return null;
    return [...cell.parentElement.children].map((c) => norm(c.textContent));
  }

  /** 表頭各欄 → 日期、名稱、場地在第幾格；沒有表頭就照常見的順序 */
  function columnsOf(header) {
    const find = (re, dflt) => { const i = header ? header.findIndex((h) => re.test(h)) : -1; return i >= 0 ? i : dflt; };
    return { when: find(/日期|時間/, 0), name: find(/場次|名稱/, 1), venue: find(/場地|地區|地點/, 2) };
  }

  /** 場次表的每一列 */
  function sessionRows() {
    return deepAll('#GameInfoList .tr');
  }

  /** 一列 → { when, name, venue, button, disabled, note }：只讀文字和按鈕能不能按 */
  function readRow(row, col) {
    const cells = [...row.children];
    const cellText = (i) => (cells[i] ? norm(cells[i].textContent) : '');
    const btn = row.querySelector('button, a[role="button"], a.btn');
    const btnText = btn ? norm(btn.textContent) : '';
    const actionCell = btn ? cells.find((c) => c.contains(btn)) : cells[cells.length - 1];
    const note = actionCell ? norm(actionCell.textContent.replace(btn ? btn.textContent : '', '')) : '';
    const disabled = !!btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.hasAttribute('disabled'));
    return { when: cellText(col.when), name: cellText(col.name), venue: cellText(col.venue), button: btnText, disabled, note };
  }

  /** 頁面上方「售票平台：ibon機台、線上購票」「票券型態：ibon紙券」；說明區塊裡的同名字句（例如加購高鐵的取票方式）不算 */
  function offers() {
    const detail = document.getElementById('detail');
    return deepAll('li')
      .filter((li) => !(detail && detail.contains(li)))
      .map((li) => norm(li.textContent))
      .filter((t) => /^(售票平台|票券型態)\s*[:：]/.test(t))
      .map((t) => { const i = t.search(/[:：]/); return { label: t.slice(0, i).trim(), value: t.slice(i + 1).trim() }; });
  }

  /** 說明區塊：標題（「節目介紹」「購票須知」…）下面那一段的文字；找不到回空字串 */
  function sectionText(title) {
    const head = $$('#detail *, body *').find((el) => el.children.length === 0 && norm(el.textContent) === title);
    const body = head ? (head.nextElementSibling || (head.parentElement && head.parentElement.nextElementSibling)) : null;
    return body ? blockText(body) : '';
  }

  /**
   * 說明文字（保留換行）：
   *   intro   「節目介紹」：票價、開賣時間從這裡找（免得把退票規則裡的「票價 10%」當成票價）
   *   notice  「購票須知」：限購規定從這裡找（免得混進周邊商品的限購）
   *   all     所有說明區塊；上面兩段找不到時才用。說明區塊也找不到就讀整頁。
   */
  function description() {
    const detail = document.getElementById('detail');
    return { intro: sectionText('節目介紹'), notice: sectionText('購票須知'), all: blockText(detail || document.body) };
  }

  /** 等場次表出現（最多 maxMs），再把整頁讀一次 */
  async function readIbonActivity(maxMs = 15000) {
    const t0 = Date.now();
    const warnings = [];
    let rows = sessionRows();
    while (!rows.length && Date.now() - t0 < maxMs) {
      await sleep(300);
      rows = sessionRows();
    }
    if (!rows.length) warnings.push(`等了 ${Math.round(maxMs / 1000)} 秒還沒看到場次表（可能還沒開放、已下架，或頁面結構改了）`);
    const header = sessionHeader();
    if (rows.length && !header) warnings.push('場次表沒有表頭，欄位照常見順序（日期、名稱、場地）讀');
    const col = columnsOf(header);
    const h1 = $$('h1').find((h) => isVisible(h) && norm(h.textContent)) || $('h1');
    const d = description();
    if (!d.intro) warnings.push('找不到「節目介紹」區塊，票價與開賣時間改從整頁的文字找');
    return {
      url: location.href,
      title: h1 ? norm(h1.textContent) : norm(document.title),
      offers: offers(),
      sessions: rows.map((r) => readRow(r, col)),
      description: d.intro,
      notice: d.notice,
      fullText: d.all,
      warnings,
    };
  }

  /* ───────────────────────── IbonAdapter（只讀） ─────────────────────────
   * ibon 的頁面轉接，跟模擬站的 POOL（src/agent/10-pool.js）分開。
   * 這裡只有讀取：頁面種類、活動資訊、登入狀態、狀態提示、這一頁助手能做什麼、結構快照。
   * 沒有任何點擊、填值、送出的函式：網站上的操作照 lib/ibon.js 的 IBON_POLICY，一律由你自己做。 */

  /** 看得到的文字，連同 Shadow DOM（包括封閉的）裡的文字；innerText 本身不會進到 Shadow DOM */
  function visibleText() {
    const parts = [document.body ? document.body.innerText : ''];
    for (const host of deepAll('*')) {
      const sr = shadowOf(host);
      if (sr) for (const c of sr.children) if (c.innerText) parts.push(c.innerText);
    }
    return parts.join('\n');
  }

  /**
   * 結構快照（你按了才記）：標籤、id、class、角色、欄位名稱、按鈕與標籤上的字、下拉選單的選項，連同封閉的 Shadow DOM。
   * 也記看不看得見（hidden）、選項有沒有被選（checked、selected）、data-* 屬性：之後要核對「你選了哪一個」。
   * 不記錄欄位裡填的內容；文字經過 maskText（遮 Email、手機、身分證、長數字、「XXX 您好」「姓名：XXX」，以及 own＝你在設定頁填的姓名、手機、Email），
   * 網址只留路徑與參數名稱。沒有固定說法的姓名還是可能遮不到，交出去之前請自己看過。
   */
  const SNAP = { nodes: 5000, depth: 45, text: 80 };
  function snapshotStructure(own = []) {
    let count = 0;
    const m = (v, n) => maskText(v, own).slice(0, n);
    const attr = (el, out) => {
      for (const a of ['name', 'type', 'role', 'aria-label', 'for', 'title', 'placeholder', 'value']) {
        if (a === 'value' && !['radio', 'checkbox', 'submit', 'button'].includes(el.type)) continue;   // 文字欄位的值不記
        if (el.hasAttribute(a)) out[a] = m(el.getAttribute(a), 40);
      }
      const data = [...el.attributes].filter((x) => x.name.startsWith('data-') && !x.name.startsWith('data-ng')).slice(0, 6);
      if (data.length) out.data = Object.fromEntries(data.map((x) => [x.name, m(x.value, 30)]));
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
      if (el.checked) out.checked = true;
      if (!isVisible(el)) out.hidden = true;
    };
    const walk = (el, depth) => {
      if (count >= SNAP.nodes || depth > SNAP.depth) return null;
      count++;
      const tag = el.tagName.toLowerCase();
      const out = { t: tag };
      if (el.id) out.id = maskText(el.id).slice(0, 40);
      const cls = [...el.classList].slice(0, 4);
      if (cls.length) out.c = cls.join(' ');
      attr(el, out);
      if (tag === 'a' && el.getAttribute('href')) out.href = maskUrl(el.getAttribute('href'), location.href);
      if (tag === 'form' && el.getAttribute('action')) out.action = maskUrl(el.getAttribute('action'), location.href);
      if (tag === 'img') { out.alt = maskText(el.alt).slice(0, 40); if (el.getAttribute('src')) out.src = maskUrl(el.getAttribute('src'), location.href); }
      if (tag === 'input' || tag === 'textarea') { if (el.value && !['radio', 'checkbox', 'submit', 'button'].includes(el.type)) out.filled = true; return out; }   // 只記「有沒有填」，不記內容
      if (tag === 'select') { out.options = [...el.options].slice(0, 30).map((o) => m(norm(o.text), 40)); out.selected = el.selectedIndex; return out; }
      if (tag === 'iframe') { out.src = maskUrl(el.getAttribute('src') || '', location.href); return out; }
      if (tag === 'canvas') { out.size = `${el.width}x${el.height}`; return out; }
      if (['script', 'style', 'noscript', 'svg', 'template', 'canvas', 'video'].includes(tag)) return out;
      const txt = norm([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join(' '));
      if (txt) out.x = m(txt, SNAP.text);
      const kids = [];
      const sr = shadowOf(el);
      if (sr) kids.push({ t: '#shadow-root', mode: el.shadowRoot ? 'open' : 'closed', k: [...sr.children].map((c) => walk(c, depth + 1)).filter(Boolean) });
      for (const c of el.children) { const w = walk(c, depth + 1); if (w) kids.push(w); }
      if (kids.length) out.k = kids;
      return out;
    };
    const tree = document.body ? walk(document.body, 0) : null;
    return {
      kind: ibonPageKind(location.href), url: maskUrl(location.href), title: m(document.title, 100),
      takenAt: Date.now(), nodes: count, truncated: count >= SNAP.nodes, tree,
    };
  }

  /**
   * 填寫購票資訊（UTK0206，流程第 4 步）：照 2026-10-16 的真站快照讀，只讀看得到的字，整理交給 lib/ibon.js 的 parseBuyerInfo。
   * 用頁面上的字與 data-title 找位置，不靠 ASP.NET 產生的 id。聯絡電話、Email 只回「有沒有」，不讀內容。
   */
  function readBuyerInfo() {
    const vis = (el) => isVisible(el);
    const cardBody = (title) => {
      const h = $$('.card-header, h5').find((el) => norm(el.textContent) === title);
      return h ? (h.closest('.card') || h.parentElement) : null;
    };
    const radios = (root) => (root ? $$('input[type=radio]', root) : []).map((r) => {
      const lab = r.id ? root.querySelector(`label[for="${CSS.escape(r.id)}"]`) : null;
      return { label: norm((lab || r.parentElement || {}).textContent || ''), checked: r.checked };
    }).filter((x) => x.label);
    const steps = $$('.step-grid').map((g) => ({
      n: norm(($('.step-circle', g) || {}).textContent || ''), text: norm(($('.text', g) || {}).textContent || ''), active: g.classList.contains('active'),
    }));
    const table = $$('table').find((t) => $$('th', t).some((th) => norm(th.textContent) === '區域/座位'));
    const cell = (tr, title) => {
      const td = $$('td', tr).find((c) => norm(c.getAttribute('data-title')) === title);
      if (!td) return null;
      const sel = $('select', td);
      if (sel) return norm((sel.selectedOptions[0] || {}).textContent || '');
      const shown = $$('span', td).filter(vis);
      return norm(shown.length ? shown.map((x) => x.textContent).join(' ') : td.textContent);
    };
    const rows = table ? $$('tbody tr', table).filter((tr) => $$('td[data-title]', tr).length).map((tr) => ({
      name: cell(tr, '名稱'), time: cell(tr, '活動時間'), venue: cell(tr, '場地'), seat: cell(tr, '區域/座位'),
      type: cell(tr, '票種'), qty: cell(tr, '數量'), price: cell(tr, '價格(NT$)'),
    })) : [];
    const totalLabel = $$('div').find((el) => norm(el.textContent) === '總計(付款金額)');
    const totalEl = totalLabel && totalLabel.parentElement ? $('.total', totalLabel.parentElement) : null;
    const countdown = $$('span').filter(vis).map((el) => norm(el.textContent)).find((t) => /^剩餘時間\s*\d{1,2}:\d{2}$/.test(t)) || null;
    const field = (labelText) => {
      const lab = $$('label').find((l) => norm(l.textContent).replace(/^\*/, '') === labelText);
      return lab ? (lab.closest('.form-group') || lab.parentElement) : null;
    };
    const phoneBox = field('聯絡電話：');
    const phoneInput = phoneBox ? $('input', phoneBox) : null;
    const emailBox = field('電子郵件：');
    const emailShown = emailBox ? !!norm(($('.col-sm-10', emailBox) || emailBox).textContent).replace('電子郵件：', '') : null;
    const agreeBox = $$('input[type=checkbox]').find((c) => {
      const l = c.id ? $(`label[for="${CSS.escape(c.id)}"]`) : null;
      return l && /同意/.test(l.textContent);
    });
    const discount = cardBody('請選擇折扣');
    const text = visibleText();
    const cap = text.match(/驗證碼|請輸入圖形|圖形驗證/);
    return {
      steps, title: norm(($('#order-wrap h1') || {}).textContent || '') || null, rows,
      total: totalEl ? norm(totalEl.textContent) : null, countdown,
      discount: discount ? norm(($('.card-body', discount) || discount).textContent) : null,
      phoneFilled: phoneInput ? norm(phoneInput.value) !== '' : null, emailShown,
      pay: radios(cardBody('選擇付款方式')), get: radios(cardBody('取票方式')),
      agree: agreeBox ? agreeBox.checked : null,
      buttons: deepAll('a, button, input[type=submit]').filter(vis).map((b) => norm(b.textContent || b.value)).filter((t) => t && t.length <= 12),
      captchaText: cap ? cap[0] : null,
    };
  }

  const IbonAdapter = {
    id: 'ibon',

    /** 頁面種類（lib/ibon.js 的 ibonPageKind：照網址） */
    pageKind: () => ibonPageKind(location.href),

    /** 活動頁：活動、場次、票價、開賣時間（真站核對過，活動 39972） */
    readActivity: readIbonActivity,

    /** 登入狀態：頁首看得到「快速登入」＝沒登入（真站看過）；看不到就說看不出來（登入後的頁首還沒在真站核對過） */
    loginState() {
      const link = deepAll('a, button').find((el) => norm(el.textContent) === '快速登入' && isVisible(el));
      if (!link && IbonAdapter.pageKind() === 'buyer-info' && deepAll('a, button').some((el) => norm(el.textContent) === '登出' && isVisible(el))) {
        return { state: 'logged-in', verified: true, msg: '頁首有「登出」：已經登入（購票流程頁，2026-10-16 真站快照看過）' };
      }
      return link
        ? { state: 'logged-out', verified: true, msg: '頁首有「快速登入」：目前沒有登入。購票前請先登入（購票須知也這樣要求）' }
        : { state: 'unknown', verified: false, msg: '頁首沒看到「快速登入」，可能已經登入（登入後的頁首還沒在真站核對過）' };
    },

    /**
     * 這一頁的狀態：頁面種類、登入、狀態提示。
     * 活動頁的場次狀態要讀場次表（readActivity）；購票頁還沒有真站結構，只照頁面上的字給提示，一律標「未驗證」。
     */
    readState() {
      const kind = IbonAdapter.pageKind();
      const page = IBON_PAGE_INFO[kind] || { label: '不是 ibon 的頁面', verified: false };
      const hints = kind === 'activity' ? [] : stateHints(visibleText());
      return { kind, label: page.label, verified: page.verified, login: IbonAdapter.loginState(), hints, policy: IBON_POLICY };
    },

    /** 填寫購票資訊（UTK0206）：訂單內容、保留時間、要你自己填選的項目（只讀） */
    readBuyerInfo: () => parseBuyerInfo(readBuyerInfo()),

    /** 這一頁助手能做什麼、要你自己做什麼（lib/ibon.js 的 IBON_POLICY） */
    supportedActions: () => IBON_POLICY,

    /** 結構快照：給開發真實購票頁的唯讀解析用 */
    snapshot: (own) => snapshotStructure(own),
  };

  /* ───────────────────────── 啟動 ─────────────────────────
   * 載入時問背景程式：這個分頁是不是它開來讀資訊的？是才讀。你自己開著的活動頁，背景程式也可以直接要它讀一次。
   * 兩種情況都只讀，讀完把整理好的資訊交回去。 */

  async function readAndBuild() {
    if (IbonAdapter.pageKind() !== 'activity') return { ok: false, error: '這一頁不是活動頁' };
    const raw = await IbonAdapter.readActivity(15000);
    const login = IbonAdapter.loginState();
    return { ok: true, info: { ...buildEventInfo(raw, Date.now()), warnings: raw.warnings, login } };
  }

  /** 人工操作模式：活動頁讀活動資訊，其他頁讀頁面狀態（都只讀） */
  async function guideRead() {
    const kind = IbonAdapter.pageKind();
    if (kind === 'activity') {
      const r = await readAndBuild();
      return r.ok ? { ok: true, kind, info: r.info } : { ok: false, kind, error: r.error };
    }
    if (kind === 'buyer-info') return { ok: true, kind, state: IbonAdapter.readState(), detail: IbonAdapter.readBuyerInfo() };
    return { ok: true, kind, state: IbonAdapter.readState() };
  }

  /* 背景程式要的東西（只接受擴充功能自己送來的）：
   *   info-read      讀活動頁的資訊
   *   page-state     這一頁的種類、登入、狀態提示、操作政策
   *   page-snapshot  結構快照 */
  const HANDLERS = {
    'info-read': readAndBuild,
    'page-state': async () => ({ ok: true, state: IbonAdapter.readState() }),
    'guide-read': guideRead,
    'page-snapshot': async (msg) => ({ ok: true, snapshot: IbonAdapter.snapshot(Array.isArray(msg.own) ? msg.own : []) }),
  };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const fn = msg && HANDLERS[msg.type];
    if (!fn || sender.id !== chrome.runtime.id) return false;
    fn(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  (async () => {
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: 'info-hello', payload: { url: location.href } }); } catch (_) { return; }
    if (!r || !r.read) {
      // 人工操作模式綁著這個分頁：每次換頁都讀一次交給背景程式核對
      let g = null;
      try { g = await chrome.runtime.sendMessage({ type: 'guide-hello', payload: { url: location.href } }); } catch (_) { return; }
      if (g && g.guide) {
        const out = await guideRead().catch((e) => ({ ok: false, error: String(e) }));
        try { await chrome.runtime.sendMessage({ type: 'guide-report', payload: out }); } catch (_) { /* 背景程式不在了 */ }
      }
      return;   // 不是要讀資訊的分頁：其他什麼都不做
    }
    let out;
    try { out = await readAndBuild(); } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
    try { await chrome.runtime.sendMessage({ type: 'info-result', payload: out }); } catch (_) { /* 背景程式不在了 */ }
  })();
})();
