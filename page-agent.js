// 這個檔案由 tools/build.mjs 從 src/agent/ 和 lib/ 產生，請改那兩個地方，不要直接改這裡。
/*
 * page-agent.js —— 跑在 ISOLATED world（擴充功能自己的環境，可以直接用 chrome.runtime）
 *
 * 為什麼是 ISOLATED：ibon 活動頁的場次表在封閉的 Shadow DOM 裡，只有擴充功能的 chrome.dom.openOrClosedShadowRoot 讀得到。
 * 網站用 alert() 回報結果，這個環境接不到，由 MAIN world 的 alert-hook.js 轉成訊息送過來。
 *
 * 模式（由 background 依任務狀態決定，頁面每次載入都會重新問一次）：
 *   countdown  活動頁：對時 → 倒數到開賣時間 → 通知 background → 重新整理
 *   run        依頁面種類動作：
 *                活動頁   找你選的場次，「線上購票」可按就點；還不能按就照尚未開賣重試
 *                選票區頁 照關鍵字、排除字選票區
 *                座位/數量頁 選票區價格、選張數、按下一步；有驗證碼就停手交給你
 *                填購票資訊頁 勾同意、按下一步
 *   success    進到購票確認頁代表名額已保留；只顯示提示，不按任何東西
 *   check      「讀取活動」「檢查」按鈕：在背景分頁讀場次、開賣時間、票價，回報後由 background 關掉分頁
 *   health     「健檢」按鈕：檢查活動頁還是不是助手認得的樣子
 * 驗證碼、排隊、付款一律交給你；最後的確認、付款也不碰。
 */
(() => {
  'use strict';

  if (window.__ITH_AGENT__) return;
  window.__ITH_AGENT__ = true;

  const state = {
    clockOffset: 0,       // 伺服器時間 - 本機時間（毫秒）
    clockReliable: false, // 有沒有在前景完成過一次對時
    syncing: false,
    resyncArmed: false,
    aborted: false,
    running: false,
    alerts: [],           // MAIN world 的 alert-hook.js 轉來的網站訊息
    netStarts: [],        // 頁面自己還沒回來的網路請求的開始時間（alert-hook.js 轉來的）
    leaving: false,       // 頁面開始離開了（按了換頁的東西）：舊頁面上的助手不要再動作
    panel: null,
    mode: null,
  };

  /* ───────────────────────── 基礎工具 ───────────────────────── */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now() + state.clockOffset;
  const norm = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function domReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }

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

  /** 頁面自己的背景更新還在跑嗎：5 秒內開始、還沒回來的請求才算（太久沒回的多半是常駐連線，不是這次的更新） */
  const NET_BUSY_MS = 5000;
  function netBusy() {
    const t = Date.now();
    return state.netStarts.some((s) => t - s < NET_BUSY_MS);
  }

  /** 這一頁從開始載入到現在多久（毫秒），寫在紀錄裡看每一步花多少時間 */
  const pageAge = () => `這一頁載入後 ${Math.round(performance.now())} ms`;

  /** 頁面種類（判讀寫在 lib/urls.js） */
  function pageKind() {
    return pageKindOf(location.href);
  }

  /* ───────────────────────── 與背景程式溝通 ───────────────────────── */

  /** 送出不等回覆 */
  function send(type, payload) {
    try { chrome.runtime.sendMessage({ type, payload, url: location.href }, () => void chrome.runtime.lastError); } catch (_) { /* 擴充功能剛重新載入 */ }
  }

  /** 送出並等回覆；逾時或失敗回 null */
  function call(type, payload, timeout = 1500) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      try {
        chrome.runtime.sendMessage({ type, payload, url: location.href }, (res) => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(res === undefined ? null : res);
        });
      } catch (_) { clearTimeout(timer); resolve(null); }
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.cmd === 'ping') { sendResponse({ ok: true, kind: pageKind() }); return; }   // 背景程式問「助手還在不在」
    if (msg && msg.cmd) onCommand(msg);
  });

  // MAIN world 的 alert-hook.js 把網站的 alert / confirm 轉成 postMessage
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (d && d.__ith === 'net' && Array.isArray(d.starts)) { state.netStarts = d.starts.filter(Number.isFinite); return; }
    if (!d || d.__ith !== 'alert' || typeof d.msg !== 'string') return;
    const msg = d.msg.slice(0, 300);
    state.alerts.push(msg);
    // 等結果的那幾秒 alert-hook.js 接管了對話框，沒有跳出來：寫進面板讓你知道 ibon 說了什麼
    if (d.kind === 'confirm' && d.caught) log(`ibon 詢問「${msg.slice(0, 60)}」，助手按了${d.answer ? '確定' : '否'}`, 'warn');
    else if (d.caught) log(`ibon 訊息：「${msg.slice(0, 80)}」`, 'warn');
  });

  // 按了換頁的東西（下一步、__doPostBack）：頁面開始離開時舊頁面還能操作一陣子，這段時間不要再動作
  window.addEventListener('beforeunload', () => { state.leaving = true; });
  window.addEventListener('pagehide', () => { state.leaving = true; });
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) state.leaving = false; });

  function log(msg, level = 'info') {
    send('log', { msg: String(msg), level });
    panelLog(String(msg), level);
  }

  /* ───────────────────────── 啟動 ───────────────────────── */

  let helloState = 'pending';   // pending → inflight → done
  async function hello() {
    if (helloState !== 'pending') return;
    helloState = 'inflight';
    const res = await call('hello', { kind: pageKind(), url: location.href }, 1500);
    if (!res) { helloState = 'pending'; return; }
    helloState = 'done';
    handleDirective(res);
  }

  /* ───── 內嵌 lib/format.js ───── */
  // 共用的小工具：補零與日期時間格式。背景程式直接 import，頁面程式由 tools/build.mjs 內嵌。
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /** 毫秒時間戳記 → 「10/15 13:00:00」 */
  function fmt(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** 轉成整數並限制在 min～max 之間；看不懂就用預設值 */
  function int(v, def, min, max) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  /* ───── 內嵌 lib/urls.js ───── */
  // ibon 網址的判讀：活動頁、購票流程各步驟頁，以及不會自己恢復的頁面。只處理字串，不碰網頁。
  // 購票流程各頁（orders.ibon.com.tw/application/UTK02/）：
  //   UTK0201_0    驗證問題頁（網址帶 rn=，要你自己作答；網址取自 tickets_hunter）
  //   UTK0201_000  第 2 步 選擇票區（2026-10-16 截圖看過；表格在封閉 Shadow DOM 裡，每列 4 格，參考 tickets_hunter）
  //                有些活動這一頁直接出現張數下拉（票區與張數同一頁）
  //   UTK0202_     第 3 步 座位/數量（2026-10-16 真站快照核對過）
  //   UTK0206_     第 4 步 填寫購票資訊（2026-10-16 真站快照核對過）
  //   UTK0207_     第 5 步 購票確認，接著就是付款（網址取自 tickets_hunter，它也刻意不碰這一步；2026-10-16 實測走得到）
  // 名額在第 4 步就保留了：填寫購票資訊頁開始倒數「剩餘時間」。

  const ACTIVITY_HOST = 'ticket.ibon.com.tw';
  const ORDERS_HOST = 'orders.ibon.com.tw';

  /** 活動頁網址（整理過）。看不懂回傳 null */
  function activityUrl(input) {
    let u;
    try { u = new URL(String(input || '').trim()); } catch (_) { return null; }
    if (u.protocol !== 'https:' || u.hostname !== ACTIVITY_HOST) return null;
    const m = u.pathname.match(/^\/ActivityInfo\/Details\/(\d+)\/?$/);
    return m ? `https://${ACTIVITY_HOST}/ActivityInfo/Details/${m[1]}` : null;
  }

  /** 網址裡的活動編號 */
  function eventSlug(url) {
    try {
      const m = new URL(url).pathname.match(/^\/ActivityInfo\/Details\/(\d+)/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  function isIbonHost(url) {
    try {
      const h = new URL(url).hostname;
      return h === ACTIVITY_HOST || h === ORDERS_HOST;
    } catch (_) { return false; }
  }

  /**
   * 網址 → 頁面種類：
   *   event 活動頁、transit 活動頁按「線上購票」的轉址、verify 驗證問題、area 選票區、qty 座位/數量、buyer 填購票資訊、
   *   confirm 購票確認以後（名額已保留）、orders 購票流程的其他頁、other 其他
   */
  function pageKindOf(url) {
    let u;
    try { u = new URL(url); } catch (_) { return 'other'; }
    if (u.protocol !== 'https:') return 'other';
    if (u.hostname === ACTIVITY_HOST) {
      if (/^\/ActivityInfo\/Details\/\d+\/?$/.test(u.pathname)) return 'event';
      if (/^\/ActivityInfo\/GoTicketURL\/?$/i.test(u.pathname)) return 'transit';
      return 'other';
    }
    if (u.hostname === ORDERS_HOST) {
      const p = u.pathname;
      if (/^\/application\/UTK02\/UTK0201_0\.aspx$/i.test(p)) return 'verify';
      if (/^\/application\/UTK02\/UTK0201_000\.aspx$/i.test(p)) return 'area';
      if (/^\/application\/UTK02\/UTK0202_\.aspx$/i.test(p) || /^\/application\/UTK02\/UTK0201_001\.aspx$/i.test(p)) return 'qty';
      if (/^\/application\/UTK02\/UTK0206_\.aspx$/i.test(p)) return 'buyer';
      if (/^\/application\/UTK02\/UTK020[7-9]_?\.aspx$/i.test(p)) return 'confirm';
      if (/^\/application\/UTK02\//i.test(p)) return 'orders';
    }
    return 'other';
  }

  /** ibon 上不會自己恢復、助手也管不到的頁面：登入頁、持卡人優先購的驗證頁（ibon 網址自己拼成 Vaildate，tickets_hunter）、錯誤頁、首頁（被踢回首頁），其他回傳 null */
  function offTrackKind(url) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    if (u.hostname === 'huiwan.ibon.com.tw' && /UserLogin/i.test(u.pathname)) return 'sign-in';
    if (!isIbonHost(url)) return null;
    if (u.hostname === ACTIVITY_HOST && /^\/vaildate\//i.test(u.pathname)) return 'card-validate';
    if (/^\/(error|500|404)/i.test(u.pathname)) return 'error-page';
    // 被踢回首頁（tickets_hunter 認的兩個網址）：kktix 助手也會把分頁帶回去
    if (u.hostname === ACTIVITY_HOST && /^\/(index\/entertainment)?\/?$/i.test(u.pathname)) return 'home';
    return null;
  }

  /** 購票流程的頁面（任務進行時助手要接手的那幾頁；verify 是通知你作答） */
  const FLOW_KINDS = ['verify', 'area', 'qty', 'buyer'];

  /* ───── 內嵌 lib/areas.js ───── */
  // 場次與票區的比對。只處理文字，不碰網頁；頁面程式和背景程式共用。
  // 規則同 kktix 助手的票種比對：關鍵字一行一組、越上面越優先，同一行用空格隔開表示每一段都要出現；
  // 排除字一律不選；關鍵字都對不到時，fallback 打開才改選第一個還能買的（一樣套用排除字）。

  const DEFAULT_EXCLUDE = ['輪椅', '身障', '身心', '障礙', '愛心', 'Restricted View', '燈柱遮蔽', '視線不完整'];

  const nz = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
  const lc = (s) => nz(s).toLowerCase();
  const SOLD_OUT_RE = /已售完|售完|已額滿|額滿|暫無|無法購買|已截止|選購一空|尚無票/;

  /** 一行一個，也接受逗號、頓號分隔 */
  function parseList(v) {
    return (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\r\n,，、]+/))
      .map((x) => nz(x))
      .filter(Boolean);
  }

  /** 關鍵字：一行一組 */
  function parseKeywords(v) {
    return (Array.isArray(v) ? v : String(v == null ? '' : v).split(/\r?\n/)).map(nz).filter(Boolean);
  }

  /** 演出時間「2026/10/24(六) 13:00」→「2026/10/24 13:00」：場次的唯一識別，去掉星期 */
  function sessionKey(text) {
    return nz(text).replace(/\s*[(（][^)）]*[)）]/g, '');
  }

  /**
   * 在選項裡挑一個。options：[{ text, unavailable }]（票區列、下拉選項都用這個格式）。
   * unavailable 為真表示頁面標了不能買（例如票區列的 class 有 disabled、剩下的張數不夠），當成賣完處理。
   * 回傳 { kind, index, text, names, excluded }：
   *   match 關鍵字對到、fallback 沒對到但依遞補設定選了第一個、
   *   sold-out 對到的都賣完了、blocked 對到的都在排除清單、no-match 一個都沒對到
   */
  function pickOption(options, cfg) {
    const list = (options || []).map((o, index) => ({ index, text: nz(o.text), unavailable: o.unavailable === true })).filter((o) => o.text);
    const exclude = (cfg.exclude === undefined ? DEFAULT_EXCLUDE : parseList(cfg.exclude)).map(lc);
    const isEx = (o) => exclude.some((x) => lc(o.text).includes(x));
    const isSold = (o) => o.unavailable || SOLD_OUT_RE.test(o.text);
    const keywords = parseKeywords(cfg.keywords);
    const names = list.map((o) => o.text);
    const excludedCount = list.filter(isEx).length;
    const usable = list.filter((o) => !isEx(o) && !isSold(o));

    let blocked = [];
    let sold = [];
    for (const line of keywords) {
      const terms = line.split(' ').map(lc);
      const hits = list.filter((o) => terms.every((t) => lc(o.text).includes(t)));
      if (!hits.length) continue;
      const ok = hits.filter((o) => !isEx(o) && !isSold(o));
      if (ok.length) return { kind: 'match', index: ok[0].index, text: ok[0].text, names, excluded: excludedCount };
      blocked = blocked.concat(hits.filter(isEx));
      sold = sold.concat(hits.filter((o) => !isEx(o) && isSold(o)));
    }
    if (cfg.fallback === true && usable.length) {
      return { kind: 'fallback', index: usable[0].index, text: usable[0].text, names, excluded: excludedCount };
    }
    if (sold.length) return { kind: 'sold-out', names: sold.map((o) => o.text), excluded: excludedCount };
    if (blocked.length) return { kind: 'blocked', names: blocked.map((o) => o.text), excluded: excludedCount };
    return { kind: 'no-match', names, excluded: excludedCount };
  }

  /** 表單檢查：沒設定場次、沒有關鍵字（也沒開遞補）就不開跑，不會自己亂選 */
  function validateCfg(cfg) {
    if (!cfg.regUrl) return '活動網址看不懂，請貼 ibon 活動頁網址（https://ticket.ibon.com.tw/ActivityInfo/Details/…）';
    if (!cfg.sessionWhen) return '請先按「讀取活動」，再選一個場次';
    if (!parseKeywords(cfg.keywords).length && cfg.fallback !== true) {
      return '請至少填一組票區關鍵字，或勾選「關鍵字對不到就選第一個」。沒有關鍵字時不會自己亂選票區';
    }
    return null;
  }

  /* ───── 內嵌 lib/clock.js ───── */
  // 對時的計算：從 HEAD 請求的送出時間 t0、收到時間 t1 和伺服器 Date 的秒數 sec，推算「伺服器 − 本機」毫秒數。

  /** 假設伺服器在請求來回的正中間產生 Date */
  const probeOffset = (p) => Math.round(p.sec - (p.t1 - (p.t1 - p.t0) / 2));

  /** 第二段對時：同時送出的探測裡，找第一個跨到下一秒的那一個。沒有跨秒就回傳 null */
  function crossingOffset(probes) {
    const got = (probes || []).filter(Boolean).sort((a, b) => a.t0 - b.t0);
    if (!got.length) return null;
    const firstSec = got[0].sec;
    const cross = got.findIndex((p) => p.sec > firstSec);
    return cross > 0 ? probeOffset(got[cross]) : null;
  }

  /* ───── 內嵌 lib/health.js ───── */
  // 健檢結果的整理：最嚴重的等級，以及給人看的一句話摘要。

  /** fail 最嚴重，其次 warn，都沒有就是 ok（skip 不算問題） */
  function worstOf(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.some((i) => i.status === 'fail')) return 'fail';
    if (list.some((i) => i.status === 'warn')) return 'warn';
    return 'ok';
  }

  /** p：頁面回報的健檢結果；fp：跟上次記下的 ibon 活動頁程式檔比對的結果 */
  function summarizeHealth(p, fp) {
    if (p.error) return p.error;
    const items = Array.isArray(p.items) ? p.items : [];
    const bad = items.filter((i) => i.status === 'fail').map((i) => i.label);
    const warn = items.filter((i) => i.status === 'warn').map((i) => i.label);
    let s = bad.length ? `有問題：${bad.join('、')}` : warn.length ? `大致正常，要注意：${warn.join('、')}` : '全部正常';
    if (fp && fp.changed) s += `。ibon 活動頁程式在上次檢查（${fmt(fp.changed.at)}）之後更新過`;
    else if (fp && fp.first) s += '。已記下 ibon 活動頁程式的版本，下次會比對有沒有更新';
    else if (fp && fp.same) s += '。ibon 活動頁程式和上次一樣';
    return s;
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
  /** 台灣時間（ibon 寫的時間）「2026-10-16T12:00」→ 毫秒；只有日期回 NaN */
  function twMs(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 8, Number(m[5])) : NaN;
  }

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

  /* ───────────────────────── 找元素 ─────────────────────────
   * ibon 的場次表、票區表在封閉的 Shadow DOM 裡，用擴充功能才有的 chrome.dom.openOrClosedShadowRoot 讀；
   * 網頁自己的程式拿不到，擴充功能可以。 */

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


  /* ───────────────────────── 登入、頁面狀態 ───────────────────────── */

  /** 登入狀態：頁首看得到「快速登入」＝沒登入；購票流程頁看得到「登出」＝已登入（2026-10-16 真站快照）；其他看不出來 */
  function loginState() {
    const link = deepAll('a, button').find((el) => norm(el.textContent) === '快速登入' && isVisible(el));
    if (link) return 'logged-out';
    if (deepAll('a, button').some((el) => norm(el.textContent) === '登出' && isVisible(el))) return 'logged-in';
    return 'unknown';
  }

  /** 看得到的文字，連同 Shadow DOM（包括封閉的）裡的文字；innerText 本身不會進到 Shadow DOM */
  function visibleText() {
    const parts = [document.body ? document.body.innerText : ''];
    for (const host of deepAll('*')) {
      const sr = shadowOf(host);
      if (sr) for (const c of sr.children) if (c.innerText) parts.push(c.innerText);
    }
    return parts.join('\n');
  }

  /** 排隊、流量控管、機器人檢查的字樣（只辨識有沒有，不處理） */
  function blockerText() {
    const m = visibleText().match(/流量控管|排隊|請稍候|機器人|驗證碼|Just a moment/i);
    return m ? m[0] : null;
  }

  /**
   * ibon 的「正在驗證您是否是人類」檢查頁（2026-10-16 看過：網址不變，頁面換成檢查頁，通過後自己重新載入）。
   * 助手不處理、不繞過，只是在這段時間不要重新整理，免得打斷檢查。
   */
  function challengeText() {
    const m = visibleText().match(/正在驗證您是否是人類|驗證您是否是人類|Checking your browser|Just a moment/i);
    return m ? m[0] : null;
  }

  /**
   * 點元素。href 是 javascript: 的連結（ibon 的「下一步」）在擴充功能的環境裡點會被擴充功能自己的 CSP 擋掉，
   * 所以標記起來，請 MAIN world 的 alert-hook.js 在頁面自己的環境代點（跟你手動按一樣）。
   * 它沒回應（沒載入）就不得已自己點。
   */
  function pageClick(el) {
    const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
    if (!/^\s*javascript:/i.test(href)) { el.click(); return; }
    const token = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    el.setAttribute('data-ith-click', token);
    window.postMessage({ __ith: 'click', token }, location.origin);
    setTimeout(() => { if (el.getAttribute('data-ith-click') === token) { el.removeAttribute('data-ith-click'); el.click(); } }, 500);
  }

  /**
   * 照 tickets_hunter 的做法點元素：捲到畫面中間，點「它正中央那一點上最裡層的元素」，事件從那裡一路往外傳。
   * 直接對 <tr> 呼叫 click()，事件只發給 <tr> 本身；ibon 如果把處理掛在列裡面的元素上，就等於沒點到
   * （2026-10-16 活動 39978：點了票區 30 秒都沒反應）。點到的是連結就交給 pageClick（javascript: 連結要在頁面環境點）。
   * 回傳實際點到的元素。
   */
  function pointClick(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* 捲不動就照目前位置 */ }
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const root = el.getRootNode ? el.getRootNode() : document;
    let target = null;
    try { target = root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y); } catch (_) { target = null; }
    if (!target || !(target === el || el.contains(target))) target = el;   // 被別的東西蓋住、或在畫面外：還是點它本身
    const link = target.closest ? target.closest('a') : null;
    if (link && el.contains(link)) { pageClick(link); return link; }
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
    } catch (_) {
      target.click();
    }
    return target;
  }

  /**
   * 先跟購票網站建好連線（DNS、TCP、TLS）：開賣後從活動頁跳到 orders.ibon.com.tw 時，第一次連線不用再握手。
   * 只是給瀏覽器的提示（<link rel="preconnect">），不送任何請求內容。Chrome 閒置的預先連線大約十秒會關掉，
   * 所以在開賣前幾秒、和開賣後活動頁一載入時各加一次。
   */
  function preconnectOrders() {
    try {
      const head = document.head || document.documentElement;
      for (const rel of ['dns-prefetch', 'preconnect']) {
        const old = head.querySelector(`link[rel="${rel}"][data-ith]`);
        if (old) old.remove();   // 拿掉再加，瀏覽器才會再建一次連線
        const l = document.createElement('link');
        l.rel = rel;
        l.href = 'https://orders.ibon.com.tw';
        l.setAttribute('data-ith', '1');
        head.appendChild(l);
      }
    } catch (_) { /* 加不了就算了，只是少了加速 */ }
  }

  /** 在下拉裡設值並通知網頁（ASP.NET 的 onchange 會跟著動） */
  function setSelect(sel, value) {
    sel.value = String(value);
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value === String(value);
  }
  /* ───────────────────────── 畫面面板 ───────────────────────── */

  const PANEL_CSS = `
    .box { font: 13px/1.5 system-ui, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
           color: #111; background: #fff; border: 2px solid #0a7d55; border-radius: 10px;
           box-shadow: 0 6px 24px rgba(0,0,0,.18); width: 300px; overflow: hidden; }
    .hd { display: flex; align-items: center; justify-content: space-between; gap: 8px;
          background: #0a7d55; color: #fff; padding: 6px 10px; font-weight: 700; }
    .hd button { font: inherit; font-size: 12px; font-weight: 600; background: #fff; color: #0a7d55;
                 border: 0; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    .hd button:disabled { opacity: .5; cursor: default; }
    .st { padding: 8px 10px 2px; font-weight: 600; }
    .st.ok { color: #0a7d55; } .st.warn { color: #b45309; } .st.err { color: #b91c1c; }
    .cd { padding: 0 10px; font-size: 26px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .cd:empty { display: none; }
    ol { list-style: none; margin: 4px 0 8px; padding: 0 10px; max-height: 132px; overflow: auto;
         font-size: 12px; color: #444; }
    li.warn { color: #b45309; } li.err { color: #b91c1c; } li.ok { color: #0a7d55; }
  `;

  function panel() {
    if (state.panel) return state.panel;
    const host = document.createElement('div');
    host.setAttribute('data-ith', 'panel');
    host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    // 樣式用 constructable stylesheet：不受網站 CSP 的 style-src 限制；舊瀏覽器才退回 <style>
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PANEL_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (_) {
      const st = document.createElement('style');
      st.textContent = PANEL_CSS;
      root.appendChild(st);
    }
    // 用 createElement 組畫面，不用 innerHTML（網站若啟用 Trusted Types，innerHTML 會被擋）
    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const box = mk('div', 'box');
    const hd = mk('div', 'hd');
    const btn = mk('button', '', '取消任務');
    btn.type = 'button';
    hd.append(mk('span', '', 'ibon 訂票助手'), btn);
    const p = { host, st: mk('div', 'st'), cd: mk('div', 'cd'), lg: mk('ol'), btn };
    box.append(hd, p.st, p.cd, p.lg);
    root.appendChild(box);
    p.btn.addEventListener('click', () => {
      p.btn.disabled = true;
      stopLocal('已取消');
      send('abort-request', {});
    });
    const attach = () => (document.body || document.documentElement).appendChild(host);
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
    state.panel = p;
    return p;
  }

  function setStatus(text, cls = '') {
    const p = panel();
    p.st.textContent = text;
    p.st.className = 'st ' + cls;
  }

  function setCountdown(ms) {
    const p = panel();
    if (ms == null) { p.cd.textContent = ''; return; }
    const left = Math.max(0, ms);
    if (left < 10000) { p.cd.textContent = (left / 1000).toFixed(2) + ' 秒'; return; }
    const s = Math.floor(left / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    p.cd.textContent = (h ? h + ':' + two(m) : String(m)) + ':' + two(sec);
  }

  function clock() {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  function panelLog(msg, level = 'info') {
    if (!state.panel) return;
    const li = document.createElement('li');
    li.className = level;
    li.textContent = `${clock()} ${msg}`;
    state.panel.lg.appendChild(li);
    while (state.panel.lg.children.length > 8) state.panel.lg.firstChild.remove();
    state.panel.lg.scrollTop = 1e6;
  }

  /* ───────────────────────── 對時 ───────────────────────── */

  /**
   * HTTP Date header 只有「秒」精度，直接拿會有 ±500ms 誤差，所以抓伺服器「跨秒」的那一瞬間。分兩段：
   *   第一段：每 140ms 探一次，抓到跨秒。這樣算出來的時間只會偏慢（0～140ms），不會偏快。
   *   第二段：預測下一次跨秒，在那附近每 20ms 同時送出探測，把誤差壓到約 20ms。
   * 第二段失敗就沿用第一段的結果。
   */
  async function headDate(url) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
      const t1 = Date.now();
      const sec = new Date(res.headers.get('Date') || '').getTime();
      return Number.isFinite(sec) ? { t0, t1, sec } : null;
    } catch (_) { return null; }
  }

  /**
   * 跟 ibon 伺服器對時，回傳 { offset, reliable }，失敗回傳 null。
   * 網頁在背景時，Chrome 會把計時器對齊到整秒，跨秒的時間點會量偏將近一秒（2026-10-15 在一台 Windows 電腦量到「本機快 947 ms」）。
   * 所以對時期間只要網頁進過背景、或任何一次等待被拖長，這次結果就不採用，維持原本的值，等網頁回到前景再對。
   */
  async function syncClock(maxProbe = 15) {
    if (state.syncing) return null;
    state.syncing = true;
    const before = state.clockOffset;
    let throttled = document.hidden;
    const onVis = () => { if (document.hidden) throttled = true; };
    document.addEventListener('visibilitychange', onVis);
    const nap = async (ms) => {
      const t = Date.now();
      await sleep(ms);
      if (Date.now() - t > ms + 250) throttled = true;
    };
    // 一發現被拖慢就放棄這次，不硬做完：背景時每次等待都會被拉長到一秒，做完要二十幾秒，結果還是不準
    const bail = () => {
      state.clockOffset = before;   // 沒對過就是本機時間，對過就沿用上一次可靠的結果
      return { offset: before, reliable: false };
    };
    try {
      const url = location.origin + '/assets/favicon.ico';
      let prev = null;
      let coarse = null;
      for (let i = 0; i < maxProbe && !coarse; i++) {
        if (state.aborted) return null;
        if (throttled) return bail();
        const p = await headDate(url);
        if (!p) return null;
        if (prev && p.sec > prev.sec) {
          coarse = { offset: probeOffset(p), boundaryLocal: p.t1 - (p.t1 - p.t0) / 2 };
        } else {
          prev = p;
          await nap(140);
        }
      }
      if (!coarse) return null;
      let offset = coarse.offset;

      // 第二段：真正的跨秒落在估計值之前 0～140ms，下一次跨秒就在 +860～+1000ms 之間
      const startAt = coarse.boundaryLocal + 1000 - 170;
      await nap(Math.max(0, startAt - Date.now()));
      if (throttled) return bail();
      const probes = [];
      for (let i = 0; i < 12 && !throttled; i++) {
        probes.push(headDate(url));
        await nap(20);
      }
      if (throttled) return bail();
      const fine = crossingOffset(await Promise.all(probes));   // 計算寫在 lib/clock.js
      if (fine !== null) offset = fine;
      if (throttled) return bail();
      state.clockOffset = offset;
      state.clockReliable = true;
      return { offset, reliable: true };
    } finally {
      document.removeEventListener('visibilitychange', onVis);
      state.syncing = false;
    }
  }

  /** 對時並寫紀錄、回報背景程式；量不準時不採用 */
  async function doSync(label) {
    const r = await syncClock();
    if (!r) {
      log(`${label}失敗，先用${state.clockReliable ? '上一次對時的結果' : '本機時間'}`, 'warn');
      return;
    }
    if (!r.reliable) {
      log(`${label}時網頁在背景，Chrome 會拖慢計時，這次量的不準，不採用。網頁回到前景時會再對一次`, 'warn');
      return;
    }
    log(`${label}：本機${r.offset >= 0 ? '慢' : '快'} ${Math.abs(r.offset)} ms`);
    send('clock', { offset: r.offset, reliable: true, at: Date.now() });
  }

  /** 對時一直量不準：網頁回到前景時再對一次，離開賣不到 3 秒就不對了，免得拖到重新整理 */
  function resyncWhenVisible(fireAt) {
    if (state.resyncArmed) return;
    state.resyncArmed = true;
    const onVis = async () => {
      if (document.hidden || state.aborted || state.syncing) return;
      if (state.clockReliable || fireAt - now() < 3000) {
        document.removeEventListener('visibilitychange', onVis);
        return;
      }
      await doSync('網頁回到前景，重新對時');
    };
    document.addEventListener('visibilitychange', onVis);
    if (!document.hidden) onVis();   // 已經在前景了：不用等下一次切換，現在就重對
  }

  /** 等到伺服器時間 ts。遠的時候省電輪詢，越接近越密，最後 60ms 每 4ms 檢查一次。 */
  async function waitUntil(ts) {
    let lastHiddenWarn = 0;
    for (;;) {
      if (state.aborted) return false;
      const left = ts - now();
      setCountdown(left);
      if (left <= 0) return true;
      if (document.hidden && left < 20000 && Date.now() - lastHiddenWarn > 5000) {
        lastHiddenWarn = Date.now();
        setStatus('這個分頁不在前景，瀏覽器可能拖慢計時！請把它切到前景', 'warn');
        send('warn', { kind: 'hidden', msg: '選票頁被切到背景或最小化了，開賣時可能晚好幾秒。請讓它保持在前景。' });
      }
      if (left > 3000) await sleep(200);
      else if (left > 60) await sleep(16);
      else await sleep(4);   // 最後 60ms 每 4ms 看一次。不用 requestAnimationFrame：分頁不在前景時畫面不更新，它會整個停住
    }
  }

  /* ───────────────────────── 流程：共用的工具與分派 ─────────────────────────
   * 各頁的動作分在 61～67：61-countdown 活動頁倒數、62-event 活動頁點場次、63-verify 驗證問題頁、
   * 64-area 選票區頁、65-qty 座位/數量頁、66-buyer 填購票資訊頁、67-check 讀取活動。 */

  /** 把你要接手的元素框起來 */
  function handToUser(el) {
    if (!el) return;
    try {
      el.style.outline = '3px solid #d97706';
      el.style.outlineOffset = '2px';
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) { /* 看不到就算了 */ }
  }

  async function finish(ok, kind, msg, extra = {}) {
    const cls = ok ? 'ok' : (extra.handOff ? 'warn' : 'err');
    setStatus(msg, cls);
    setCountdown(null);
    panelLog(msg, cls);
    if (!ok) blackbox(kind, msg);
    await call('result', { ok, kind, msg, url: location.href, handOff: !!extra.handOff }, 1500);
  }

  /**
   * 等到 cond() 回傳真值，回傳那個值；逾時、取消或頁面開始離開回 null。
   * 頁面一有變動就馬上再看一次（MutationObserver，同一批變動只看一次）；封閉 Shadow DOM 裡的變動觀察不到
   * （ibon 的場次表、票區表都在裡面），所以另外每 50 毫秒看一次。
   * slow() 是比較重的檢查（找排隊、人類驗證的字樣要讀整頁文字），每 slowEvery 毫秒才看一次，回傳真值也會結束等待。
   */
  function waitFor(cond, maxMs, slow = null, slowEvery = 500) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let done = false;
      let timer = 0;
      let queued = false;
      let slowAt = 0;
      const obs = new MutationObserver(() => {
        if (queued || done) return;
        queued = true;
        setTimeout(() => { queued = false; check(); }, 0);
      });
      const stop = (v) => {
        if (done) return;
        done = true;
        obs.disconnect();
        clearTimeout(timer);
        resolve(v);
      };
      function check() {
        if (done) return;
        if (state.aborted || state.leaving) { stop(null); return; }
        const v = cond();
        if (v) { stop(v); return; }
        if (slow && Date.now() - slowAt >= slowEvery) {
          slowAt = Date.now();
          const w = slow();
          if (w) { stop(w); return; }
        }
        if (Date.now() - t0 >= maxMs) stop(null);
      }
      obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
      const tick = () => { check(); if (!done) timer = setTimeout(tick, 50); };
      tick();
    });
  }

  /** 等場次表出現（最多 maxMs），回傳列 */
  async function waitSessions(maxMs) {
    const rows = await waitFor(() => { const r = sessionRows(); return r.length ? r : null; }, maxMs);
    return rows || [];
  }

  /** 重新整理再試一次：次數與間隔由背景程式決定 */
  async function retry(reason, msg, gotoUrl) {
    const r = await call('retry', { reason, msg }, 1500);
    if (!r || !r.allow) {
      const used = r && r.max != null ? `（已重試 ${r.count || 0}/${r.max} 次）` : '';
      return finish(false, reason === 'not-open' ? 'not-open-limit' : 'fail-limit', `${msg}，重試次數用完了${used}`, { handOff: true });
    }
    const action = gotoUrl ? '再前往' : '重新整理';
    setStatus(`${msg}，${(r.delayMs / 1000).toFixed(1)} 秒後${action}（${r.count}/${r.max}）`, 'warn');
    log(`${msg}，${action}（${r.count}/${r.max}）`, 'warn');
    await sleep(r.delayMs);
    if (state.aborted) return undefined;
    if (gotoUrl) location.href = gotoUrl;
    else location.reload();
    return undefined;
  }

  /** 頁面載入不出來（沒有場次表之類）：重新整理，間隔連續失敗才逐步拉長，最長 3 秒；連續失敗超過 5 分鐘交給你 */
  async function loadRetry(why) {
    const ask = () => call('retry', { reason: 'load', status: 0, msg: why }, 1500);
    let r = await ask();
    if (!r) { await sleep(1000); r = await ask(); }
    if (!r) { setStatus(`${why}。背景程式沒有回應，先停下來，請自己重新整理`, 'err'); return undefined; }
    if (!r.allow && r.count == null) { setStatus(`${why}。任務已經結束，不再重新整理`, 'err'); return undefined; }
    if (!r.allow) {
      const n = r.count ? `，已重新整理 ${r.count} 次` : '';
      return finish(false, 'load-limit', `${why}${n}。連續 5 分鐘都沒有恢復，先停下來，請自己重新整理看看`, { handOff: true });
    }
    setStatus(`${why}。${(r.delayMs / 1000).toFixed(1)} 秒後重新整理（第 ${r.count} 次）`, 'warn');
    log(`${why}，重新整理（第 ${r.count} 次）`, 'warn');
    await sleep(r.delayMs);
    if (state.aborted) return undefined;
    location.reload();
    return undefined;
  }

  /**
   * 等 ibon 的背景更新做完：選了張數、勾了同意之後，ibon 可能在背景送請求更新頁面（重算金額、重畫表格）。
   * 更新到一半就按下一步，兩個請求可能撞在一起（2026-10-16 選張數到按下一步只隔 4 毫秒時一直轉圈）。
   * 做完的條件：頁面自己的網路請求都回來了（alert-hook.js 數的）、而且連續 quietMs 毫秒沒有畫面變動；
   * 至少等 minMs，讓網頁的 change 事件有時間把請求送出去。最多等 maxMs。頁面開始離開就馬上結束。
   * 0.9.4 以前是固定至少等 0.8 秒，這裡改成看請求，通常幾百毫秒就好。
   */
  function settle(quietMs = 150, maxMs = 8000, minMs = 250) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let last = Date.now();
      const obs = new MutationObserver(() => { last = Date.now(); });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const tick = () => {
        const t = Date.now();
        const quiet = t - t0 >= minMs && t - last >= quietMs && !netBusy();
        if (quiet || state.leaving || state.aborted || t - t0 >= maxMs) { obs.disconnect(); resolve(t - t0); return; }
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  /** 按下去之後等結果：網站用 alert 回報就接到；換頁成功時這個頁面已經卸載，由新頁面接手 */
  async function watchAfterClick(alertBefore, maxMs = 45000, label = '處理中') {
    const t0 = Date.now();
    let shown = 0;
    while (Date.now() - t0 < maxMs && !state.aborted) {
      if (state.alerts.length > alertBefore) return { kind: 'alert', msg: state.alerts[state.alerts.length - 1] };
      if (state.leaving) return { kind: 'leaving' };   // 換頁了：由新頁面接手
      const sec = Math.floor((Date.now() - t0) / 1000);
      if (sec >= 3 && sec !== shown) { shown = sec; setStatus(`ibon ${label}，已等 ${sec} 秒…先不要重新整理`, 'ok'); }
      await sleep(200);
    }
    return { kind: 'timeout' };
  }

  /**
   * ibon 的「正在驗證您是否是人類」檢查頁：等它自己通過（通過後頁面會重新載入，由新頁面接手），
   * 這段時間不重新整理、不點任何東西。過了 maxMs 還在就回 false。
   */
  async function waitChallenge(maxMs = 60000) {
    const t0 = Date.now();
    while (challengeText() && Date.now() - t0 < maxMs && !state.aborted) {
      setStatus(`ibon 正在驗證您是否是人類，請等它通過（已等 ${Math.floor((Date.now() - t0) / 1000)} 秒；助手不處理，也不重新整理）`, 'warn');
      await sleep(500);
    }
    return !challengeText();
  }

  /**
   * 按下去並等結果。等的這段時間請 alert-hook.js 接管對話框：alert 不跳出來（不然頁面會停住、要你按確定），
   * 照 kktix 助手「只在等結果的那幾秒接管」的做法，等完就交還。換頁成功時這個頁面已經卸載，新頁面一開始就不接管。
   */
  async function clickAndWatch(el, maxMs, label, clicker = pageClick) {
    const before = state.alerts.length;
    window.postMessage({ __ith: 'catch', ms: maxMs + 2000 }, location.origin);
    clicker(el);
    try {
      return await watchAfterClick(before, maxMs, label);
    } finally {
      window.postMessage({ __ith: 'catch', ms: 0 }, location.origin);
    }
  }

  /* 售完的票區：記在背景程式的任務裡，回到選區頁時跳過，改選下一個（tickets_hunter 也是售完就回選區頁換別區）。 */
  const SOLD_OUT_MSG = /已售完|售完|選購一空|尚無票|額滿|已無票|No tickets available|Sold out/i;

  /** 這個票區是不是之前售完過：記的可能是「1F 鐵粉席 1,000」或只有「鐵粉席」，互相包含就算 */
  function isFailedArea(name, failed) {
    const n = norm(name);
    return !!n && (failed || []).some((f) => { const x = norm(f); return !!x && (x.includes(n) || n.includes(x)); });
  }

  async function markAreaFailed(text) {
    if (!text) return;
    log(`票區「${text}」賣完了，之後跳過它`, 'warn');
    await call('area-failed', { text }, 1500);
  }

  /**
   * alert 的結果：登入問題交給你；說售完而且知道是哪個票區 → 記下來，回選區頁（或重新整理這頁）換下一個；
   * 其他算被拒絕，照額度重試。opts：{ areaText 這次選的票區, areaUrl 選區頁網址（在座位/數量頁才有） }
   */
  async function handleAlert(out, label, opts = {}) {
    if (/登入|sign in|log in/i.test(out.msg)) return finish(false, 'guest', `ibon 要求登入：「${out.msg}」`, { handOff: true });
    blackbox('rejected', `ibon 回覆「${out.msg}」`);
    if (SOLD_OUT_MSG.test(out.msg) && opts.areaText) {
      await markAreaFailed(opts.areaText);
      return retry('fail', `${label}時 ibon 回覆「${out.msg}」，換別的票區`, opts.areaUrl);
    }
    return retry('fail', `${label}時 ibon 回覆「${out.msg}」`);
  }

  /* ───────────────────────── 分派 ───────────────────────── */

  async function runFlow(d) {
    if (state.running) return;
    state.running = true;
    state.aborted = false;
    const cfg = d.cfg || {};
    panel();
    setCountdown(null);
    try {
      await domReady();
      const kind = pageKind();
      if (kind === 'event') await runEvent(cfg, d);
      else if (kind === 'verify') await runVerify(cfg);
      else if (kind === 'area') await runArea(cfg, d);
      else if (kind === 'qty') await runQty(cfg, d);
      else if (kind === 'buyer') await runBuyer(cfg);
    } catch (e) {
      await finish(false, 'error', '程式錯誤：' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
    }
  }

  function showSuccess(d) {
    panel();
    const took = d.since ? `從開賣到保留花了 ${((Date.now() - d.since) / 1000).toFixed(1)} 秒。` : '';
    setStatus(`已保留名額！${took}請確認訂單後自己付款，保留有時間限制。`, 'ok');
    panelLog('助手到這裡就停手，不會替你確認訂單或付款', 'ok');
  }

  function stopLocal(reason) {
    state.aborted = true;
    state.mode = 'idle';
    if (state.panel) {
      setStatus(reason, 'err');
      setCountdown(null);
    }
  }

  function onCommand(c) {
    if (c.cmd === 'abort') { stopLocal(c.reason || '已取消'); return; }
    if (c.cmd === 'run') {
      state.aborted = false;
      state.mode = 'run';
      runFlow({ cfg: c.cfg || {}, since: c.since });
    }
  }

  function handleDirective(d) {
    state.mode = (d && d.mode) || 'idle';
    switch (d && d.mode) {
      case 'countdown': return runCountdown(d);
      case 'run': return runFlow(d);
      case 'check': return runCheck(d);
      case 'health': return runHealth(d);
      case 'success': return showSuccess(d);
      default: return undefined;   // 沒有任務：什麼都不做
    }
  }
  /* ───────────────────────── 活動頁：倒數 ─────────────────────────
   * 開賣前在活動頁：檢查你選的場次、健檢、對時，倒數到開賣時間再重新整理。 */
  async function runCountdown(d) {
    const cfg = d.cfg || {};
    const fireAt = d.targetTs + (cfg.fireOffsetMs == null ? 30 : cfg.fireOffsetMs);
    panel();
    setStatus('已排程，等待開賣', 'ok');
    await domReady();
    const rows = await waitSessions(15000);
    if (!rows.length && challengeText()) {
      // 檢查頁通過後會自己重新載入，載入後由新頁面接著倒數
      setStatus('ibon 正在驗證您是否是人類，請等它通過（助手不處理，也不重新整理）', 'warn');
      send('warn', { kind: 'challenge', msg: 'ibon 顯示「正在驗證您是否是人類」。請讓它自己通過，通過後助手會照常倒數。' });
    }
    if (loginState() === 'logged-out') {
      setStatus('還沒登入 ibon！請先登入，登入後回到這一頁', 'err');
      send('warn', { kind: 'guest', msg: '活動頁顯示你還沒登入。請在開賣前登入，否則時間到也買不了票。' });
    }
    // 開賣前場次就看得到：先檢查你選的場次有沒有，選錯現在就會發現，不用等到開賣
    if (rows.length) {
      const col = columnsOf(sessionHeader());
      const hit = rows.filter((r) => sessionKey(readRow(r, col).when) === sessionKey(cfg.sessionWhen));
      if (hit.length === 1) log(`找到場次：${sessionKey(cfg.sessionWhen)}`, 'ok');
      else {
        const msg = hit.length ? `有多列相同演出時間「${sessionKey(cfg.sessionWhen)}」，助手不知道該選哪一個` : `活動頁上找不到你選的場次「${sessionKey(cfg.sessionWhen)}」`;
        log(msg, 'warn');
        send('warn', { kind: 'session', msg });
      }
      const h = healthItems(cfg);
      send('health', { context: 'preopen', worst: h.worst, items: h.items, bundles: h.bundles });
    } else {
      log('現在還讀不到場次表，開賣時重新整理會再試', 'warn');
    }
    if (cfg.syncClock !== false) {
      await doSync('已與 ibon 伺服器對時');
      if (!state.clockReliable) resyncWhenVisible(fireAt);
      if (fireAt - now() > 45000) {
        if (!(await waitUntil(fireAt - 30000))) return;
        await doSync('開賣前再對時一次');
      }
    }
    // 頁面本身就是在開賣之後才載入的（例如視窗開晚了）
    const loadedAt = performance.timeOrigin + state.clockOffset;
    if (loadedAt >= fireAt) {
      await call('fired', { at: Date.now(), drift: Math.round(now() - fireAt) }, 800);
      return runFlow({ cfg, since: Date.now() });
    }
    // 開賣前 3 秒先跟 orders.ibon.com.tw 建好連線，開賣後跳到購票頁時省掉握手時間
    if (!(await waitUntil(fireAt - 3000))) return;
    preconnectOrders();
    // 開賣前 0.3 秒先跟背景程式報備「要重新整理了」，等它回覆；到點時就不用再等，重新整理可以立刻發出
    if (!(await waitUntil(fireAt - 300))) return;
    await call('fired', { at: Date.now(), drift: null }, 800);
    if (!(await waitUntil(fireAt))) return;
    const drift = Math.round(now() - fireAt);
    setStatus('開賣時間到，重新整理…', 'ok');
    send('fired-drift', { drift });   // 只是紀錄誤差，不等回覆
    location.reload();
  }

  /* ───────────────────────── 活動頁：點場次 ───────────────────────── */

  /** 活動頁：找你選的場次，「線上購票」可按就點；還不能按就照尚未開賣重試 */
  async function runEvent(cfg, d) {
    setStatus('找場次中…', 'ok');
    preconnectOrders();   // 等場次表的同時先跟購票網站建好連線
    let rows = await waitSessions(15000);
    if (state.aborted) return;
    if (!rows.length && challengeText()) {
      if (!(await waitChallenge(60000))) return finish(false, 'challenge', 'ibon 的「正在驗證您是否是人類」一分鐘還沒通過，請你自己看畫面', { handOff: true });
      rows = await waitSessions(15000);
      if (state.aborted) return;
    }
    if (!rows.length) return loadRetry('ibon 活動頁沒有出現場次表');
    if (d && d.loadFail) send('load-ok', {});
    if (loginState() === 'logged-out') {
      return finish(false, 'guest', '目前沒有登入 ibon，所以沒有動作。請登入後在擴充功能按「立即執行」', { handOff: true });
    }
    const col = columnsOf(sessionHeader());
    const hit = rows.filter((r) => sessionKey(readRow(r, col).when) === sessionKey(cfg.sessionWhen));
    if (hit.length !== 1) {
      const names = rows.map((r) => sessionKey(readRow(r, col).when)).join('、');
      return finish(false, 'no-session', hit.length
        ? `有多列相同演出時間「${sessionKey(cfg.sessionWhen)}」，不知道該選哪一個`
        : `找不到場次「${sessionKey(cfg.sessionWhen)}」。頁面上的場次有：${names}`, { handOff: true });
    }
    const info = readRow(hit[0], col);
    const st = sessionStatus(info.button, info.disabled);
    const btn = hit[0].querySelector('button, a[role="button"], a.btn');
    if (st.status === 'sold-out') return finish(false, 'sold-out', `場次「${sessionKey(cfg.sessionWhen)}」已售完`);
    if (st.status === 'closed') return finish(false, 'closed', `場次「${sessionKey(cfg.sessionWhen)}」已截止`);
    if (!btn || st.status !== 'on-sale') {
      return retry('not-open', `場次「${sessionKey(cfg.sessionWhen)}」還不能買（按鈕：${info.button || '沒有'}${info.disabled ? '，灰的' : ''}）`);
    }
    log(`場次「${sessionKey(cfg.sessionWhen)}」可以買了，按下「${info.button}」（${pageAge()}）`);
    setStatus('按下線上購票…', 'ok');
    const out = await clickAndWatch(btn, 20000, '正在進入購票流程');
    if (out.kind === 'alert') return handleAlert(out, '按下線上購票');
    if (out.kind === 'timeout') return retry('fail', '按下線上購票後 20 秒頁面沒有反應');
    return undefined;
  }

  /* ───────────────────────── 驗證問題頁（UTK0201_0.aspx?rn=…） ─────────────────────────
   * 有些活動要先回答驗證問題（例如會員資格）。助手不代答，通知你作答；你送出後進到下一頁，助手接著動作。 */

  async function runVerify() {
    const input = deepAll('#content input[type="text"], #content input:not([type]), div.editor-box input[type="text"]').find(isVisible);
    if (input) handToUser(input);
    return finish(false, 'verify', 'ibon 要你先回答驗證問題。請自己作答並送出，之後的步驟助手會接著做', { handOff: true });
  }
  /* ───────────────────────── 選票區頁（UTK0201_000，第 2 步） ─────────────────────────
   * 2026-10-16 截圖：表格欄位「顏色、票區、票價(NT$)、空位」，空位寫「熱賣中」、「已售完」或剩下的張數。
   * tickets_hunter 的 ibon.py：表格在封閉的 Shadow DOM 裡；每列 4 格（[0] 顏色 [1] 票區 [2] 票價 [3] 空位），
   * 表頭在 THEAD；不能買的列 class 帶 disabled；「座位已被選擇」「座位已售出」「舞台區域」是圖例不是票區；點的是整列。
   * 0.9.2 實測：點整列可以進到座位/數量頁。 */
  const AREA_LEGEND = /^(座位已被選擇|座位已售出|舞台區域)$/;

  function areaCells(r) {
    return [...r.children].filter((c) => c.tagName === 'TD');
  }

  function areaRows() {
    return deepAll('tr').filter((r) => {
      if (!isVisible(r) || (r.parentElement && r.parentElement.tagName === 'THEAD')) return false;
      const tds = areaCells(r);
      return tds.length >= 4 && /\d/.test(norm(tds[2].textContent)) && !AREA_LEGEND.test(norm(r.textContent));
    });
  }

  /** 一列 → { text, name, price, seat, left, unavailable }：空位是數字就是剩下的張數，不夠你要的張數就當成不能買 */
  function areaInfo(r, qty) {
    const tds = areaCells(r);
    const name = norm(tds[1].textContent);
    const price = norm(tds[2].textContent);
    const seat = norm(tds[3].textContent);
    const left = /^\d+$/.test(seat) ? Number(seat) : null;
    const unavailable = /(^|\s)disabled(\s|$)/i.test(r.className || '') || (left != null && left < qty);
    return { text: `${name} ${price} ${seat}`, name, price, seat, left, unavailable };
  }

  /** 這個元素看起來是不是「已選」：radio 勾了，或 class / aria 標了選取 */
  const looksSelected = (el) => !!(el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true'
    || /(^|\s)(active|selected|checked|on|current)(\s|$)/i.test(el.className || ''));

  /** radio 的說明文字：<label for>、包著它的 <label>、或緊接在後面的字 */
  function radioLabel(input) {
    const byFor = input.id ? deepAll(`label[for="${CSS.escape(input.id)}"]`)[0] : null;
    const wrap = input.closest ? input.closest('label') : null;
    const next = input.nextElementSibling || (input.parentElement && input.parentElement.nextElementSibling);
    return norm((byFor || wrap || next || {}).textContent || '');
  }

  /**
   * 購票方式可以選「自行選位」或「電腦配位」時（2026-10-16 活動 39978：「購票方式： 自行選位 電腦配位」），先選電腦配位：
   * 助手的流程是選張數讓 ibon 配位，不會替你點座位圖。只點看起來點得動的（radio、label、按鈕、連結、滑鼠會變手指的），純文字不動。
   * 回傳 'selected' 選了、'already' 本來就是、null 找不到可以點的。
   */
  async function chooseComputerSeat() {
    for (const input of deepAll('input[type="radio"]')) {
      if (!/電腦配位/.test(radioLabel(input))) continue;
      if (input.checked) return 'already';
      const target = isVisible(input) ? input : (input.id && deepAll(`label[for="${CSS.escape(input.id)}"]`)[0]) || input.closest('label') || input;
      pageClick(target);
      await settle(150, 3000, 150);
      return 'selected';
    }
    const clickable = deepAll('button, a, label, [role="radio"], [role="tab"], [onclick], .btn, li, span, div').filter((el) => isVisible(el)
      && norm(el.textContent) === '電腦配位' && (/^(BUTTON|A|LABEL)$/.test(el.tagName) || el.hasAttribute('onclick') || el.getAttribute('role')
        || /(^|\s)btn(\s|$)/.test(el.className || '') || getComputedStyle(el).cursor === 'pointer'));
    const el = clickable[clickable.length - 1];   // 最裡層的那一個
    if (!el) return null;
    if (looksSelected(el)) return 'already';
    pointClick(el);
    await settle(150, 3000, 150);
    return 'selected';
  }

  /** 選票區頁：照關鍵字、排除字選票區；之前售完過的票區（d.failedAreas）跳過 */
  async function runArea(cfg, d = {}) {
    setStatus('選票區中…', 'ok');
    const deadline = Date.now() + 20000;
    let rows = [];
    for (;;) {
      const got = await waitFor(() => {
        // 有些活動票區與張數在同一頁：直接照座位/數量頁的做法
        if (qtyPrice() || qtySelects().length) return { kind: 'qty' };
        const r = areaRows();
        return r.length ? { kind: 'rows', rows: r } : null;
      }, Math.max(0, deadline - Date.now()), () => {
        if (challengeText()) return { kind: 'challenge' };
        const b = blockerText();
        return b ? { kind: 'blocker', text: b } : null;
      });
      if (!got) break;
      if (got.kind === 'qty') { log('這一頁直接出現張數，票區與張數在同一頁'); return runQty(cfg, d); }
      if (got.kind === 'rows') { rows = got.rows; break; }
      if (got.kind === 'blocker') return finish(false, 'blocked-page', `頁面出現「${got.text}」，助手不處理，請你自己操作`, { handOff: true });
      if (!(await waitChallenge(60000))) return finish(false, 'challenge', 'ibon 的「正在驗證您是否是人類」一分鐘還沒通過，請你自己看畫面', { handOff: true });
    }
    if (state.aborted || state.leaving) return;
    if (!rows.length) return finish(false, 'no-area-table', '票區頁一直沒有出現票區表格。可能是 ibon 改版了，請直接看畫面', { handOff: true });
    const qty = Math.max(1, Math.min(Number(cfg.qty) || 1, 10));
    const failed = d.failedAreas || [];
    const infos = rows.map((r) => areaInfo(r, qty)).map((x) => (isFailedArea(x.name, failed) ? { ...x, unavailable: true } : x));
    const texts = infos.map((x) => x.text);
    // 記下這場的票區名稱，彈出視窗下次讀取這個活動時當成關鍵字的參考
    send('areas-seen', { names: infos.map((x) => `${x.name} ${x.price}`) });
    if (failed.length) log(`跳過之前售完的票區：${failed.join('、')}`);
    const pick = pickOption(infos, cfg);
    if (pick.kind === 'sold-out') return finish(false, 'sold-out', `對到的票區都賣完了，或剩下的張數不夠 ${qty} 張：${pick.names.join('、')}`);
    if (pick.kind === 'blocked') return finish(false, 'blocked', `對到的票區都在排除清單裡：${pick.names.join('、')}`, { handOff: true });
    if (pick.kind === 'no-match') {
      const ex = pick.excluded ? `（另有 ${pick.excluded} 個票區在排除清單裡）` : '';
      return finish(false, 'no-match', `關鍵字比對不到任何票區。頁面上的票區有：${texts.join(' ／ ')}${ex}。請自己選`, { handOff: true });
    }
    if (pick.kind === 'fallback') log(`關鍵字都沒比對到，照遞補設定改選第一個還能買的：${pick.text}`, 'warn');
    else log(`選中票區：${pick.text}（${pageAge()}）`);
    const pageText = visibleText();
    if (/自行選位/.test(pageText) && /電腦配位/.test(pageText)) {
      const how = await chooseComputerSeat();
      if (state.aborted || state.leaving) return undefined;
      if (how === 'selected') log('購票方式改選「電腦配位」（助手不會替你點座位圖）');
      else if (!how) log('頁面有「自行選位」和「電腦配位」，但找不到可以點的電腦配位選項，照原本的方式選票區', 'warn');
    }
    const row = rows[pick.index];
    const out = await clickAndWatch(row, 30000, '正在處理票區', pointClick);
    if (out.kind === 'alert') return handleAlert(out, '選票區', { areaText: infos[pick.index].name });
    if (out.kind === 'timeout') {
      const seatMap = /選擇座位|座位圖|請點選座位|請選擇您的座位|已選座位/.test(visibleText());
      return finish(false, 'no-advance', seatMap
        ? '點了票區之後 ibon 出現座位圖，要你自己點座位（助手不會替你選座位）。請直接在畫面上選'
        : '選了票區但等了 30 秒頁面沒有進到下一步，請自己看畫面', { handOff: true });
    }
    return undefined;
  }

  /* ───────────────────────── 座位/數量頁（UTK0202_、UTK0201_001，第 3 步，2026-10-16 真站快照） ─────────────────────────
   * 「票區價格」下拉（#ctl00_ContentPlaceHolder1_PRICE，多票區才有），再有「購買數量」表格（#…_DataGrid）。
   * 選了票區價格，ibon 會回傳重畫整頁；「下一步」是 #ctl00_ContentPlaceHolder1_AddShopingCart，
   * href 是 javascript:__doPostBack(...)，要用 pageClick 由頁面環境代點。
   * 驗證碼（#…_CHK，tickets_hunter）出現就停手交給你。舊版頁面的數量下拉是 table.table 裡的 select[name*="AMOUNT_DDL"]。 */
  const QTY = {
    price: '#ctl00_ContentPlaceHolder1_PRICE',
    grid: '#ctl00_ContentPlaceHolder1_DataGrid',
    next: '#ctl00_ContentPlaceHolder1_AddShopingCart',
    captcha: '#ctl00_ContentPlaceHolder1_CHK, input[id*="CHK"]',
  };
  const qtyPrice = () => { const s = $(QTY.price); return s && isVisible(s) ? s : null; };
  const qtyGrid = () => $(QTY.grid) || $('table.rwdtable') || deepAll('table.table').find((t) => t.querySelector('select')) || null;
  const qtySelects = () => {
    const grid = qtyGrid();
    return grid ? deepAll('select.form-control-sm, select[name*="AMOUNT_DDL"]', grid).filter(isVisible) : [];
  };
  const qtyNext = () => $(QTY.next) || $('a[id*="AddShopingCart"]') || $('#ctl00_ContentPlaceHolder1_A2')
    || deepAll('a.btn.btn-primary.btn-block').find((b) => isVisible(b) && /下一步/.test(b.textContent)) || null;
  const qtyCaptcha = () => deepAll(QTY.captcha).find(isVisible) || null;
  // 「接受不連號座位」（tickets_hunter：div.not-consecutive > div.custom-control > span > input[type=checkbox]）
  const qtyNonAdjacent = () => deepAll('div.not-consecutive input[type="checkbox"]').find(isVisible) || null;

  /** 這一頁現在選的票區（記售完用）：票區價格下拉選中的那一項，沒有就用數量表格第一格 */
  function qtyAreaText() {
    const p = qtyPrice();
    if (p && p.selectedIndex > 0) return norm(p.options[p.selectedIndex].text);
    const grid = qtyGrid();
    const td = grid && grid.querySelector('td');
    return td ? norm(td.textContent) : '';
  }

  /**
   * 這個票區賣完了沒（照 tickets_hunter）：有數量下拉時，看有沒有大於 0 的選項；
   * 沒有數量下拉時，看張數欄（AMOUNT_STR）或數量表格寫著售完。只看表格，不看整頁：票區下拉會列出別的票區「(已售完)」。
   */
  function qtySoldOut() {
    const sels = qtySelects();
    if (sels.length) return sels.every((s) => ![...s.options].some((o) => !o.disabled && Number(o.value) > 0));
    const grid = qtyGrid();
    return deepAll('span[id*="AMOUNT_STR"]').some((s) => SOLD_OUT_MSG.test(norm(s.textContent)))
      || (!!grid && SOLD_OUT_MSG.test(norm(grid.innerText || grid.textContent)));
  }

  /** 選「票區價格」下拉（多票區才有）：照關鍵字、排除字挑，之前售完的跳過。選好回 true；挑不到（已經回報結果）回 false */
  async function qtyPickPrice(cfg, price, failed, curArea) {
    if (curArea) log(`「${curArea}」賣完了，改選別的票區`, 'warn');
    const opts = [...price.options].slice(1).map((o) => ({ text: o.text, value: o.value, unavailable: isFailedArea(o.text, failed) }));
    send('areas-seen', { names: opts.map((o) => norm(o.text)) });
    const pick = pickOption(opts, cfg);
    let stop = null;
    if (pick.kind === 'sold-out') stop = finish(false, 'sold-out', `對到的票區都賣完了：${pick.names.join('、')}`);
    else if (pick.kind === 'blocked') stop = finish(false, 'blocked', `對到的票區都在排除清單裡：${pick.names.join('、')}`, { handOff: true });
    else if (pick.kind === 'no-match') stop = finish(false, 'no-match', `關鍵字比對不到任何票區。可選的有：${opts.map((o) => o.text).join(' ／ ')}。請自己選`, { handOff: true });
    if (stop) { await stop; return false; }
    log(pick.kind === 'fallback' ? `關鍵字都沒比對到，改選第一個還能買的：${pick.text}` : `選中票區：${pick.text}`, pick.kind === 'fallback' ? 'warn' : 'info');
    if (!setSelect(price, opts[pick.index].value)) { await finish(false, 'fill-failed', '票區價格選不起來', { handOff: true }); return false; }
    // 選了票區價格，ibon 會回傳（整頁換掉，或在背景更新張數表）：整頁換掉的話頁面開始離開就停手，由新頁面接著做；
    // 背景更新的話等請求回來、畫面穩定再往下。0.9.4 以前是固定等 4 秒
    await settle(150, 6000, 300);
    return !state.aborted && !state.leaving;
  }

  /**
   * 座位/數量頁：選票區價格（多票區才有）、選張數、按下一步；有驗證碼就停手。
   * 這個票區賣完了：記下來（d.failedAreas 是之前售完的），同一頁還有別的票區就直接改選，沒有就回選區頁（d.areaUrl）換別區。
   */
  async function runQty(cfg, d = {}) {
    setStatus('選張數中…', 'ok');
    const deadline = Date.now() + 20000;
    for (;;) {
      const got = await waitFor(() => (qtyPrice() || qtySelects().length ? { kind: 'ready' } : null), Math.max(0, deadline - Date.now()), () => {
        if (challengeText()) return { kind: 'challenge' };
        const b = blockerText();
        return b && !qtyCaptcha() ? { kind: 'blocker', text: b } : null;
      });
      if (!got || got.kind === 'ready') break;
      if (got.kind === 'blocker') return finish(false, 'blocked-page', `頁面出現「${got.text}」，助手不處理，請你自己操作`, { handOff: true });
      if (!(await waitChallenge(60000))) return finish(false, 'challenge', 'ibon 的「正在驗證您是否是人類」一分鐘還沒通過，請你自己看畫面', { handOff: true });
    }
    if (state.aborted || state.leaving) return;
    const failed = [...(d.failedAreas || [])];
    for (let round = 0; round < 5; round++) {
      const price = qtyPrice();
      const curArea = price && price.selectedIndex > 0 ? norm(price.options[price.selectedIndex].text) : '';
      if (price && (price.selectedIndex <= 0 || isFailedArea(curArea, failed))) {
        if (!(await qtyPickPrice(cfg, price, failed, curArea))) return;
        if (!qtySelects().length) return finish(false, 'no-qty', '選了票區價格但沒有出現購買數量，請自己看畫面', { handOff: true });
      }
      if (!qtySelects().length) return finish(false, 'no-qty', '找不到「購買數量」的下拉選單。可能是 ibon 改版了，請直接看畫面', { handOff: true });
      if (!qtySoldOut()) return qtyFill(cfg, d);
      const area = qtyAreaText();
      await markAreaFailed(area);
      failed.push(area);
      const p = qtyPrice();
      if (p && [...p.options].slice(1).some((o) => !isFailedArea(o.text, failed) && !SOLD_OUT_RE.test(o.text))) continue;   // 同一頁還有別的票區：直接改選
      return retry('fail', `票區「${area}」賣完了，回選區頁換別的票區`, d.areaUrl);
    }
    return finish(false, 'sold-out', '這一頁的票區試了好幾個都賣完了');
  }

  /** 選張數、（有開的話）勾不連號、按下一步 */
  async function qtyFill(cfg, d) {
    const sel = qtySelects()[0];
    const have = [...sel.options].filter((o) => !o.disabled).map((o) => Number(o.value)).filter((n) => Number.isFinite(n) && n > 0);
    const want = Math.max(1, Math.min(Number(cfg.qty) || 1, 10));
    if (Math.max(...have) < want) return finish(false, 'qty-limit', `你要 ${want} 張，但這個票區最多只能選 ${Math.max(...have)} 張。請自己決定要不要買`, { handOff: true });
    if (!setSelect(sel, want)) return finish(false, 'fill-failed', `張數選不到 ${want}`, { handOff: true });
    log(`已選張數 ${want}（${pageAge()}）`);
    // 等 ibon 的背景更新做完（請求回來、畫面穩定）；更新後如果張數被重置了就再選一次（最多三輪）
    let stable = false;
    for (let i = 0; i < 3 && !stable; i++) {
      await settle();
      if (state.aborted || state.leaving) return;
      const cur = qtySelects()[0];
      if (cur && Number(cur.value) === want) { stable = true; break; }
      if (!cur || !setSelect(cur, want)) return finish(false, 'fill-failed', `張數被頁面重置，重選 ${want} 失敗，請自己選`, { handOff: true });
      log(`頁面更新後張數被重置，重選 ${want}`, 'warn');
    }
    if (!stable) {
      await settle();
      if (state.aborted || state.leaving) return;
      const cur = qtySelects()[0];
      if (!cur || Number(cur.value) !== want) return finish(false, 'fill-failed', `張數一直被頁面重置，選不住 ${want}，請自己選`, { handOff: true });
    }
    if (cfg.allowNonAdjacent) {
      const box = qtyNonAdjacent();
      if (box && !box.checked) {
        pageClick(box);
        if (!box.checked) await sleep(50);
        if (box.checked) { log('已勾選「接受不連號座位」'); await settle(150, 4000, 200); }
        else log('「接受不連號座位」勾不起來，照連號的座位買', 'warn');
      }
    }
    if (qtyCaptcha()) {
      handToUser(qtyCaptcha());
      return finish(false, 'captcha', '張數選好了。這一頁有驗證碼，請自己輸入後按下一步', { handOff: true });
    }
    const next = qtyNext();
    if (!next) return finish(false, 'no-next', '找不到「下一步」按鈕，請自己按', { handOff: true });
    log(`按下「下一步」（${pageAge()}）`);
    setStatus('已按下一步…', 'ok');
    const out = await clickAndWatch(next, 45000, '正在處理（可能在排隊或配位）');
    if (out.kind === 'alert') return handleAlert(out, '按下一步', { areaText: qtyAreaText(), areaUrl: d.areaUrl });
    if (out.kind === 'timeout') return finish(false, 'timeout', '按下一步後等了 45 秒頁面還是沒有反應，請看畫面，先不要重新整理', { handOff: true });
    return undefined;
  }

  /* ───────────────────────── 填購票資訊頁（UTK0206_，第 4 步，2026-10-16 真站快照） ─────────────────────────
   * 進到這一頁名額就保留了（頁面開始倒數「剩餘時間」；tickets_hunter 也把到這一頁當成成功）。
   * 助手只勾同意、按下一步；電話與 Email 是會員資料，ibon 已經帶好，不改。實名制要填持票人資料，交給你。 */
  const buyerAgree = () => $$('input[type=checkbox]').find((c) => {
    const l = c.id ? $(`label[for="${CSS.escape(c.id)}"]`) : null;
    return l && /同意/.test(l.textContent);
  }) || null;
  const buyerNext = () => deepAll('a, button').find((b) => isVisible(b) && /^下一步/.test(norm(b.textContent))) || null;
  const buyerCountdown = () => $$('span').filter(isVisible).map((el) => norm(el.textContent)).find((x) => /^剩餘時間\s*\d{1,2}\s*[:：]\s*\d{2}$/.test(x)) || null;

  /** 填購票資訊頁：勾同意、按下一步。不改你的資料（電話、Email 是會員資料，ibon 已經帶好） */
  async function runBuyer(cfg) {
    setStatus('填購票資訊頁…', 'ok');
    const left = buyerCountdown();
    send('warn', { kind: 'held', msg: `名額已保留${left ? `（ibon 顯示${left}）` : ''}。助手會勾同意並按下一步；確認訂單與付款請你自己來，保留有時間限制` });
    await waitFor(() => buyerAgree() && buyerNext(), 15000);
    if (state.aborted || state.leaving) return;
    const agree = buyerAgree();
    const next = buyerNext();
    if (!agree || !next) return finish(false, 'no-buyer-form', '找不到「同意」或「下一步」，請自己操作（名額已保留，注意剩餘時間）', { handOff: true });
    if (cfg.autoAgree === false) {
      handToUser(agree);
      return finish(false, 'agree', '你設定不自動勾選同意。請自己閱讀後勾選並按下一步', { handOff: true });
    }
    if (!agree.checked) pageClick(agree);
    if (!agree.checked) await sleep(50);   // click() 通常當下就勾好了，沒勾到才稍等再看
    if (!agree.checked) return finish(false, 'agree-failed', '同意條款勾不起來，請自己勾選', { handOff: true });
    log('已勾選同意約款');
    await settle(150, 4000, 200);   // 勾選後 ibon 可能在背景更新頁面：等請求回來、畫面穩定再按下一步
    if (state.aborted || state.leaving) return;
    if (/實名制/.test(visibleText())) {
      // 實名制要填持票人資料，助手不替你填（tickets_hunter 遇到實名制也不按下一步）
      handToUser(next);
      return finish(false, 'name-based', '這場是實名制，請自己填寫持票人資料後按下一步（名額已保留，注意剩餘時間）', { handOff: true });
    }
    log(`按下「下一步」（${pageAge()}）`);
    const out = await clickAndWatch(next, 45000, '正在處理');
    // 這一頁名額已經保留：被網站擋下時不重新整理（重新整理可能弄丟保留的名額），交給你看
    if (out.kind === 'alert') return finish(false, 'rejected', `按下一步時 ibon 回覆「${out.msg}」。名額還在保留中，請自己看畫面，先不要重新整理`, { handOff: true });
    if (out.kind === 'timeout') return finish(false, 'timeout', '按下一步後等了 45 秒頁面還是沒有反應，請看畫面，先不要重新整理', { handOff: true });
    return undefined;
  }

  /* ───────────────────────── 讀取活動（彈出視窗的「讀取活動」） ───────────────────────── */

  /** 「讀取活動」「檢查」按鈕：在背景分頁讀場次、開賣時間、票價，回報後由 background 關掉分頁。不按任何東西 */
  async function runCheck(d) {
    const cfg = d.cfg || {};
    const report = (r) => call('check-result', r, 1500);
    panel();
    setStatus('讀取活動中…', 'ok');
    await domReady();
    if (pageKind() !== 'event') return report({ ok: false, error: '這不是 ibon 活動頁，請確認活動網址' });
    const raw = await readIbonActivity(20000);
    const info = buildEventInfo(raw, Date.now());
    if (!info.sessions.length) {
      return report({ ok: false, error: '沒有讀到任何場次（可能還沒開放、已下架，或頁面結構改了）', title: info.title });
    }
    // 開賣時間（台灣時間）：節目介紹裡可能寫好幾個（預購、一般），場次旁的小字也可能有自己的開賣時間。
    // 彈出視窗照你選的場次挑還沒到的那一個帶入
    const saleTimes = (info.saleTimes || []).map((x) => x.at).filter(Boolean);
    const upcoming = saleTimes.filter((at) => twMs(at) > Date.now()).sort();
    const sessions = info.sessions.map((s) => ({ when: s.when, name: s.name, status: s.status, statusLabel: s.statusLabel, saleStart: s.saleStart || null }));
    const matched = cfg.sessionWhen ? sessions.filter((s) => sessionKey(s.when) === sessionKey(cfg.sessionWhen)).length : null;
    const shown = upcoming[0] || saleTimes[0];
    const saleTxt = shown ? `${shown.replace('T', ' ').replace(/-/g, '/')}${upcoming.length ? '' : '（已經開賣）'}` : '節目介紹裡讀不到開賣時間';
    const msg = `${info.title || '活動'}：${sessions.length} 個場次，開賣 ${saleTxt}`
      + (matched === 0 ? `。注意：你選的場次「${sessionKey(cfg.sessionWhen)}」不在這個清單裡` : '');
    setStatus(msg, matched === 0 ? 'err' : 'ok');
    return report({
      ok: matched !== 0, msg, title: info.title, sessions, saleAt: upcoming[0] || null, saleTimes,
      prices: info.prices, priceLines: info.priceLines, limits: info.limits, warnings: raw.warnings || [],
    });
  }

  /* ───────────────────────── 健檢 ─────────────────────────
   * 檢查活動頁還是不是助手認得的樣子。不按任何東西，也不改任何欄位。
   * 每一項：ok 正常、warn 可能有問題、fail 開賣時一定會卡、skip 現在沒辦法檢查。
   * 購票流程的各頁（票區、座位/數量、填資料）要進去才看得到，這裡檢查不了。 */
  const BUNDLE_RE = /\/(main|runtime|polyfills|vendor)[.\-][\w.\-]*\.js/i;

  function bundleNames() {
    return [...document.scripts].map((s) => s.src || '').filter((src) => BUNDLE_RE.test(src))
      .map((src) => src.split('/').pop().split('?')[0]);
  }

  function healthItems(cfg = {}) {
    const items = [];
    const add = (key, label, status, detail = '') => items.push({ key, label, status, detail });

    const bundles = bundleNames();
    add('bundle', '活動頁程式檔', bundles.length ? 'ok' : 'warn', bundles.length ? bundles.join('、') : '找不到帶雜湊的程式檔，ibon 可能改了檔名');

    const rows = sessionRows();
    add('rows', '場次表', rows.length ? 'ok' : 'fail', rows.length ? `${rows.length} 列` : '找不到場次表（#GameInfoList）。ibon 可能改版了，或這個活動還沒開放');
    if (rows.length) {
      const col = columnsOf(sessionHeader());
      const infos = rows.map((r) => readRow(r, col));
      const noDate = infos.filter((r) => !parseDateTime(r.when)).length;
      add('dates', '場次日期', noDate ? 'warn' : 'ok', noDate ? `${noDate} 列讀不到日期` : `例如「${infos[0].when}」`);
      const withBtn = infos.filter((r) => r.button).length;
      add('buttons', '購票按鈕', withBtn === infos.length ? 'ok' : withBtn ? 'warn' : 'fail', `${withBtn}/${infos.length} 列有按鈕，例如「${(infos.find((r) => r.button) || {}).button || '沒有'}」`);
      const odd = infos.filter((r) => r.button && sessionStatus(r.button, r.disabled).status === 'unknown' && !(r.disabled && /線上購票/.test(r.button)));
      add('status', '場次狀態判讀', odd.length ? 'warn' : 'ok', odd.length ? `${odd.length} 列看不出狀態，例如「${odd[0].button}」` : '都認得');
      if (cfg.sessionWhen) {
        const hit = infos.filter((r) => sessionKey(r.when) === sessionKey(cfg.sessionWhen));
        add('session', '你選的場次', hit.length === 1 ? 'ok' : 'fail', hit.length === 1 ? sessionKey(cfg.sessionWhen) : hit.length ? '有多列相同的演出時間' : `頁面上找不到「${sessionKey(cfg.sessionWhen)}」`);
      }
    }

    const sale = parseSaleTimes(sectionText('節目介紹') || blockText($('#detail') || document.body));
    add('sale', '開賣時間', sale.length ? 'ok' : 'warn', sale.length ? sale.map((s) => s.at.replace('T', ' ')).join('、') : '節目介紹裡讀不到開賣時間，要自己設定');

    const login = loginState();
    add('login', '登入狀態', login === 'logged-in' ? 'ok' : 'warn', login === 'logged-out' ? '目前沒有登入' : login === 'logged-in' ? '已登入' : '認不出登入狀態（登入後活動頁的頁首還沒核對過）');

    return { worst: worstOf(items), items, bundles };
  }

  /** 「健檢」按鈕：在背景分頁檢查活動頁，回報後由 background 關掉分頁 */
  async function runHealth(d) {
    const report = (r) => call('health-result', r, 1500);
    panel();
    setStatus('健檢中：檢查活動頁是不是助手認得的樣子…', 'ok');
    await domReady();
    if (pageKind() !== 'event') return report({ ok: false, error: '這不是活動頁，沒辦法健檢', items: [], bundles: [] });
    await waitSessions(15000);
    const h = healthItems((d && d.cfg) || {});
    setStatus(h.worst === 'ok' ? '健檢通過' : h.worst === 'warn' ? '健檢有幾項要注意' : '健檢發現問題，開賣時可能會卡住', h.worst === 'ok' ? 'ok' : h.worst === 'warn' ? 'warn' : 'err');
    return report({ ok: h.worst !== 'fail', worst: h.worst, items: h.items, bundles: h.bundles });
  }
  /* ───────────────────────── 黑盒子 ─────────────────────────
   * 遇到失敗、交手、被拒、排隊頁時，記下當下頁面的重點，可以從擴充功能匯出。
   * 真站沒測過的狀況一旦真的發生，就能拿回來補進假網站。只記頁面上看得到的字，不記導覽列和個人資料；
   * 網址只留路徑，不帶參數。 */
  function safeUrl() {
    return location.origin + location.pathname;
  }

  /**
   * 元素的結構骨架（標籤、id、class、會動作的屬性、短短的文字），給沒看過的頁面變化用：例如點了票區沒反應，
   * 看得出點擊是掛在哪一層。不記輸入框的值；文字只留前 20 個字。最多 120 個節點。
   */
  function skeleton(el, budget = { n: 0 }, depth = 0) {
    if (!el || budget.n >= 120 || depth > 8) return '';
    if (el.hasAttribute && el.hasAttribute('data-ith')) return '';   // 助手自己的面板不記
    budget.n++;
    const tag = el.tagName ? el.tagName.toLowerCase() : '#';
    const attrs = [];
    if (el.id) attrs.push(`id="${String(el.id).slice(0, 40)}"`);
    if (el.className && typeof el.className === 'string') attrs.push(`class="${el.className.slice(0, 60)}"`);
    for (const a of ['type', 'name', 'role', 'onclick', 'href', 'for', 'aria-checked', 'aria-selected', 'data-id']) {
      if (el.hasAttribute && el.hasAttribute(a)) attrs.push(`${a}="${String(el.getAttribute(a)).slice(0, 60)}"`);
    }
    if (el.checked) attrs.push('checked');
    if (el.disabled) attrs.push('disabled');
    const own = norm([...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.nodeValue).join(' ')).slice(0, 20);
    const sr = shadowOf(el);
    const kids = [...(sr ? [{ shadow: true }] : []), ...el.children];
    const inner = kids.map((k) => (k.shadow ? `<#shadow>${[...sr.children].map((c) => skeleton(c, budget, depth + 1)).join('')}</#shadow>` : skeleton(k, budget, depth + 1))).join('');
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${own}${inner}</${tag}>`;
  }

  /** 這一頁重點區塊的骨架：「購票方式」那一段、票區表格的前兩列（選票區頁） */
  function keyParts() {
    const parts = [];
    // 「購票方式」：從寫著這幾個字的最裡層元素往外找，找到把選項也包進來的那一層（最多往上三層）
    const marks = deepAll('*').filter((el) => /^購票方式/.test(norm(el.textContent)) && norm(el.textContent).length < 60);
    let how = marks.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0] || null;
    if (how) {
      const base = norm(how.textContent).length;
      for (let i = 0; i < 3 && how.parentElement && norm(how.textContent).length <= base + 2; i++) how = how.parentElement;
      parts.push('購票方式：' + skeleton(how));
    }
    if (pageKind() === 'area') {
      const rows = areaRows();
      const ok = rows.filter((r) => !/已售完/.test(r.textContent)).slice(0, 2);
      for (const r of (ok.length ? ok : rows.slice(0, 2))) parts.push('票區列：' + skeleton(r));
    }
    return parts.join('\n').slice(0, 4000);
  }

  function snapshot(kind, msg) {
    const vis = [...document.querySelectorAll('button, a.btn, input[type="submit"]')].filter(isVisible);
    const rows = pageKind() === 'area' ? areaRows().map((r) => areaInfo(r, 1).text) : sessionRows().map((r) => norm(r.textContent));
    return {
      at: Date.now(), kind, msg: String(msg || '').slice(0, 300),
      url: safeUrl(), title: norm(document.title).slice(0, 80), page: pageKind(), login: loginState(),
      rows: rows.length, rowSample: rows.slice(0, 4).map((r) => r.slice(0, 60)),
      buttons: vis.map((b) => norm(b.textContent || b.value).slice(0, 30)).filter(Boolean).slice(0, 15),
      modals: [...document.querySelectorAll('.modal, [role="dialog"], .alert')].filter(isVisible).map((m) => norm(m.innerText).slice(0, 200)).slice(0, 5),
      alerts: state.alerts.slice(-3),
      text: norm(visibleText()).slice(0, 2000),   // 連同 Shadow DOM 裡的字（票區表、座位圖都在裡面）
      html: keyParts(),
    };
  }

  const boxed = new Set();
  /** 記一筆黑盒子；once 為真時同一種狀況在這一頁只記一次 */
  function blackbox(kind, msg, once = false) {
    if (once && boxed.has(kind)) return;
    boxed.add(kind);
    try { send('blackbox', snapshot(kind, msg)); } catch (_) { /* 記錄失敗不影響流程 */ }
  }

  // 背景程式剛被鬧鐘叫醒時第一次訊息可能失敗：沒回應就每 250ms 再問一次，最多約 10 秒
  (async () => {
    for (let i = 0; i < 40 && helloState !== 'done'; i++) {
      await hello();
      if (helloState !== 'done') await sleep(250);
    }
  })();
})();
