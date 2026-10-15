// 這個檔案由 tools/build.mjs 從 src/info/、src/agent/05-dom.js 和 lib/eventinfo.js 產生，請改那些地方，不要直接改這裡。
/*
 * ibon-info.js —— 活動資訊讀取程式（A 類，只讀），跑在 ISOLATED world
 *
 * 只在 ibon 的活動頁（https://ticket.ibon.com.tw/ActivityInfo/Details/*）載入，而且只有背景程式要它讀時才讀：
 * 讀標題、售票平台、場次表、節目介紹裡的票價與開賣時間，整理後交給背景程式，顯示在擴充功能的設定頁。
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
      readAt: Number.isFinite(i.readAt) ? i.readAt : now,
    };
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

  /* ───────────────────────── 啟動 ─────────────────────────
   * 載入時問背景程式：這個分頁是不是它開來讀資訊的？是才讀。你自己開著的活動頁，背景程式也可以直接要它讀一次。
   * 兩種情況都只讀，讀完把整理好的資訊交回去。 */

  async function readAndBuild() {
    const raw = await readIbonActivity(15000);
    return { ok: true, info: { ...buildEventInfo(raw, Date.now()), warnings: raw.warnings } };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'info-read' || sender.id !== chrome.runtime.id) return false;
    readAndBuild().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  (async () => {
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: 'info-hello', payload: { url: location.href } }); } catch (_) { return; }
    if (!r || !r.read) return;   // 不是要讀的分頁：什麼都不做
    let out;
    try { out = await readAndBuild(); } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
    try { await chrome.runtime.sendMessage({ type: 'info-result', payload: out }); } catch (_) { /* 背景程式不在了 */ }
  })();
})();
