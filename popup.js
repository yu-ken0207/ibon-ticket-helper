'use strict';

const $ = (id) => document.getElementById(id);

// 跟 background.js 的預設排除字相同：身障席位保留給需要的人，視線不良的位置也避開（lib/areas.js 也是同一組）
const DEFAULT_EXCLUDE = ['輪椅', '身障', '身心', '障礙', '愛心', 'Restricted View', '燈柱遮蔽', '視線不完整'];

const PHASE = {
  armed: '已排程，等待開賣',
  fired: '開賣了，正在買票',
  running: '正在買票',
  'waiting-user': '需要你接手（驗證碼、找不到票區…）',
  done: '已結束',
  cancelled: '已取消',
};

const pad = (n) => String(n).padStart(2, '0');
function fmt(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function clock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** ibon 寫的時間是台灣時間（「2026-10-16T12:00」）→ 毫秒；看不懂回 NaN */
function twMs(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]) : NaN;
}
/** 台灣時間 → 這台電腦的本地時間，給 datetime-local 欄位用（電腦不在台灣時區也對） */
function twToLocalInput(iso) {
  const t = twMs(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const twText = (iso) => String(iso || '').replace('T', ' ').replace(/-/g, '/');

function left(ms) {
  if (ms <= 0) return '時間到';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h} 小時 ${m} 分` : m ? `${m} 分 ${sec} 秒` : `${sec} 秒`;
}

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res || { ok: false, error: '背景程式沒有回應，請重新開啟這個視窗' });
    });
  });
}

function say(text, cls = '') {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + cls;
}

/* ───────────── 表單 ───────────── */

function readForm() {
  const v = (id) => $(id).value;
  const cfg = {
    eventUrl: v('eventUrl').trim(),
    sessionWhen: v('sessionWhen'),
    keywords: v('keywords'),
    qty: v('qty'),
    openTime: v('openTime'),
    preOpenSec: v('preOpenSec'),
    notOpenRetryMs: v('notOpenRetryMs'),
    notOpenMaxRetries: v('notOpenMaxRetries'),
    failMaxRetries: v('failMaxRetries'),
    syncClock: $('syncClock').checked,
    autoAgree: $('autoAgree').checked,
    allowNonAdjacent: $('allowNonAdjacent').checked,
    memberCodes: $('memberCodes').value,
    cardPrefix: $('cardPrefix').value,
    exclude: v('exclude'),
    fallback: $('fallback').checked,
  };
  if (cfg.openTime) {
    const t = new Date(cfg.openTime).getTime();   // datetime-local 沒有時區，照本機時間解讀
    if (Number.isFinite(t)) cfg.targetTs = t;
  }
  return cfg;
}

/** 場次清單：存著讀取活動時的結果，選項是「演出時間」；表單存的場次不在清單裡也先放進去，不要憑空消失 */
let sessionList = [];
let eventSaleTimes = [];   // 節目介紹寫的開賣時間（台灣時間），可能有好幾個（預購、一般）
let priceHints = [];       // 節目介紹寫的票價（名稱、金額），當成票區關鍵字的參考
function fillSessions(list, selected) {
  sessionList = list || sessionList;
  const sel = $('sessionWhen');
  const whens = sessionList.map((x) => x.when);
  if (selected && !whens.includes(selected)) whens.push(selected);
  // 場次名稱可能很長（例如 NCT 演唱會），截到 24 字避免把下拉框撐寬
  const trim = (s) => (s && s.length > 24 ? s.slice(0, 24) + '…' : s || '');
  sel.replaceChildren(el('option', { value: '' }, whens.length ? '（選一個場次）' : '先按「讀取活動」'),
    ...whens.map((w) => { const x = sessionList.find((y) => y.when === w); const name = trim(x && x.name); return el('option', { value: w, title: x && x.name ? `${w}　${x.name}` : w }, name ? `${w}　${name}` : w); }));
  sel.value = selected && whens.includes(selected) ? selected : '';
}

function fillForm(c) {
  // 第一次打開（或舊版存的設定沒有排除字）時放預設排除字；你自己清空的話就保持空白
  $('exclude').value = c && typeof c.exclude === 'string' ? c.exclude : DEFAULT_EXCLUDE.join('\n');
  if (!c) return;
  for (const id of ['eventUrl', 'keywords', 'qty', 'openTime', 'preOpenSec', 'notOpenRetryMs', 'notOpenMaxRetries', 'failMaxRetries']) {
    if (c[id] != null && c[id] !== '') $(id).value = c[id];
  }
  fillSessions(Array.isArray(c.sessionList) ? c.sessionList : [], c.sessionWhen || '');
  eventSaleTimes = Array.isArray(c.saleTimes) ? c.saleTimes : [];
  priceHints = Array.isArray(c.priceHints) ? c.priceHints : [];
  if (typeof c.syncClock === 'boolean') $('syncClock').checked = c.syncClock;
  if (typeof c.autoAgree === 'boolean') $('autoAgree').checked = c.autoAgree;
  if (typeof c.allowNonAdjacent === 'boolean') $('allowNonAdjacent').checked = c.allowNonAdjacent;
  if (typeof c.memberCodes === 'string') $('memberCodes').value = c.memberCodes;
  if (typeof c.cardPrefix === 'string') $('cardPrefix').value = c.cardPrefix;
  if (typeof c.fallback === 'boolean') $('fallback').checked = c.fallback;
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ form: { ...readForm(), sessionList, saleTimes: eventSaleTimes, priceHints } }), 200);
}

/* ───────────── 開賣時間：照選的場次帶入還沒到的那一個 ───────────── */

/** 選的場次的開賣時間：場次旁有自己的開賣時間就用它，沒有就用節目介紹寫的、還沒到的最早那一個 */
function saleTimeFor(when) {
  const s = sessionList.find((x) => x.when === when);
  const own = !!(s && s.saleStart);
  const list = own ? [s.saleStart] : eventSaleTimes;
  const future = list.filter((at) => twMs(at) > Date.now()).sort();
  return { at: future[0] || null, last: list.slice().sort().pop() || null, own };
}

/** 帶入開賣時間並說明從哪裡來的；回傳說明文字 */
function applySaleTime() {
  const r = saleTimeFor($('sessionWhen').value);
  let msg;
  if (r.at) {
    const v = twToLocalInput(r.at);
    if ($('openTime').value.slice(0, 16) !== v) $('openTime').value = v;
    msg = `開賣時間已帶入 ${twText(r.at)}（${r.own ? '這一場自己寫的' : '活動頁的節目介紹寫的'}，台灣時間）`;
  } else if (r.last) {
    msg = `活動頁寫的開賣時間 ${twText(r.last)} 已經過了。現在就能買的話請按「立即執行」`;
  } else {
    msg = sessionList.length ? '活動頁沒寫開賣時間，請自己填' : '';
  }
  $('saleHint').textContent = msg;
  return msg;
}

/* ───────────── 票區關鍵字的建議 ───────────── */

const slugOf = (url) => { const m = String(url || '').match(/ticket\.ibon\.com\.tw\/ActivityInfo\/Details\/(\d+)/i); return m ? m[1] : null; };
/** 「2F 一般席 350」→ 關鍵字「2F 一般席」（後面的金額拿掉） */
const keywordOf = (label) => String(label).replace(/\s*(NT\$?\s*)?[\d,]+\s*元?\s*$/i, '').trim() || String(label).trim();
const excludedBy = (text) => {
  const ex = $('exclude').value.split(/[\r\n,，、]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return ex.find((x) => text.toLowerCase().includes(x)) || null;
};

function addKeyword(kw) {
  const lines = $('keywords').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.includes(kw)) lines.push(kw);
  $('keywords').value = lines.join('\n');
  saveSoon();
}

function chipsOf(labels) {
  const row = el('div', { class: 'chips' });
  for (const label of labels) {
    const kw = keywordOf(label);
    const ex = excludedBy(label);
    const b = el('button', { type: 'button', class: 'small chip' }, ex ? `${label}（排除：${ex}）` : label);
    if (ex) b.disabled = true;
    else b.addEventListener('click', () => addKeyword(kw));
    row.append(b);
  }
  return row;
}

/** 關鍵字欄下面的建議：上次在購票頁看到的這場票區、節目介紹寫的票價；都沒有就說明怎麼辦 */
async function renderKeywordHints() {
  const box = $('kwHints');
  const slug = slugOf($('eventUrl').value);
  const { areaSeen = {} } = await chrome.storage.local.get('areaSeen');
  const seen = slug ? areaSeen[slug] : null;
  box.replaceChildren();
  let any = false;
  if (seen && seen.names && seen.names.length) {
    box.append(el('div', { class: 'hint' }, `${fmt(seen.at)}${seen.session ? `（${seen.session} 那一場）` : ''}在購票頁看到的票區，點一下加進關鍵字：`), chipsOf(seen.names));
    any = true;
  }
  const named = priceHints.filter((p) => p && p.name).map((p) => `${p.name} ${p.price}`);
  if (named.length) {
    box.append(el('div', { class: 'hint' }, '活動頁的節目介紹寫的票價，點一下加進關鍵字：'), chipsOf(named));
    any = true;
  }
  if (!any && slug) {
    box.append(el('div', { class: 'hint' }, '沒有票區建議，助手還沒進過這場的購票頁。不確定可勾進階的「關鍵字對不到就選第一個」。'));
  }
}

async function previewUrl() {
  const url = $('eventUrl').value.trim();
  const hint = $('regUrl');
  if (!url) { hint.textContent = ''; hint.className = 'hint'; return; }
  const r = await send({ type: 'preview-url', url });
  if (r.ok && r.regUrl) { hint.textContent = '活動頁：' + r.regUrl; hint.className = 'hint'; }
  else { hint.textContent = '看不懂這個網址，請貼 ibon 活動頁的網址'; hint.className = 'hint bad'; }
}

/* ───────────── 狀態 ───────────── */

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function renderTask(task, now) {
  const box = $('taskBox');
  box.replaceChildren();
  if (!task) { box.textContent = '沒有任務'; return; }

  const phaseCls = task.phase === 'done' ? (task.result && task.result.ok ? 'ok' : 'err')
    : task.phase === 'waiting-user' ? 'warn' : task.phase === 'cancelled' ? 'err' : '';
  box.append(el('div', { class: 'phase ' + phaseCls }, PHASE[task.phase] || task.phase));

  const dl = el('dl');
  const row = (k, v) => { dl.append(el('dt', {}, k), el('dd', {}, v)); };
  row('活動', task.slug || '-');
  row('場次', (task.cfg && task.cfg.sessionWhen) || '-');
  row('票區', (task.cfg && task.cfg.keywords || []).join(' ／ ') || (task.cfg && task.cfg.fallback ? '（第一個還能買的）' : '-'));
  row('張數', String(task.cfg ? task.cfg.qty : '-'));
  if (task.mode === 'scheduled') {
    row('開賣', fmt(task.targetTs) + (task.phase === 'armed' ? `（還有 ${left(task.targetTs - now)}）` : ''));
    if (task.phase === 'armed') row('開頁', task.tabId ? '已開好' : fmt(task.openAt));
    if (task.fireDrift != null) row('到點誤差', `${task.fireDrift} ms`);
  }
  if (task.failedAreas && task.failedAreas.length) row('售完跳過', task.failedAreas.join('、'));
  if (task.notOpen || task.fail || task.loadFail) row('重試', `尚未開賣 ${task.notOpen} 次、頁面載入失敗 ${task.loadFail || 0} 次、被拒絕 ${task.fail} 次`);
  if (task.result) {
    const took = task.result.elapsedMs != null ? `（${(task.result.elapsedMs / 1000).toFixed(1)} 秒）` : '';
    row('結果', '');
    dl.lastChild.append(el('span', { class: task.result.ok ? 'ok' : (task.phase === 'waiting-user' ? 'warn' : 'err') }, task.result.msg + took));
  }
  box.append(dl);
}

function renderLogs(logs) {
  const list = $('logList');
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
  list.replaceChildren(...logs.map((l) => {
    const li = el('li', { class: l.level || '' });
    li.append(el('time', {}, clock(l.at)), document.createTextNode(l.msg));
    return li;
  }));
  if (atBottom) list.scrollTop = list.scrollHeight;
}

async function refresh() {
  const r = await send({ type: 'status' });
  if (!r.ok) return;
  renderTask(r.task, r.now || Date.now());
  renderLogs(r.logs || []);
}

/* ───────────── 按鈕 ───────────── */

$('btnSchedule').addEventListener('click', async () => {
  const cfg = readForm();
  if (!cfg.targetTs) return say('請先設定開賣時間', 'err');
  const r = await send({ type: 'schedule', cfg });
  if (r.ok) say(`已排程：${fmt(r.task.targetTs)} 開賣，${fmt(r.task.openAt)} 開啟活動頁`, 'ok');
  else say(r.error || '排程失敗', 'err');
  refresh();
});

$('btnRunNow').addEventListener('click', async () => {
  if (!window.confirm('要立即執行嗎？它會馬上在活動頁找場次，能買就點進購票流程，並自動選票區、張數、勾同意按下一步。')) return;
  const r = await send({ type: 'run-now', cfg: readForm() });
  if (r.ok) say('已開始執行，請看購票頁', 'ok');
  else say(r.error || '執行失敗', 'err');
  refresh();
});

$('btnCancel').addEventListener('click', async () => {
  const r = await send({ type: 'cancel' });
  say(r.ok ? '已取消任務' : (r.error || '取消失敗'), r.ok ? 'ok' : 'err');
  refresh();
});

$('btnRead').addEventListener('click', async () => {
  const out = $('readMsg');
  const btn = $('btnRead');
  btn.disabled = true;
  out.textContent = '讀取中…';
  out.className = 'hint';
  const r = await send({ type: 'check-event', cfg: readForm() });
  out.textContent = r.msg || r.error || '讀取失敗';
  out.className = 'hint ' + (r.ok ? 'good' : 'bad');
  if (Array.isArray(r.sessions) && r.sessions.length) {
    fillSessions(r.sessions.map((x) => ({ when: x.when, name: x.name, saleStart: x.saleStart || null })), $('sessionWhen').value);
    eventSaleTimes = Array.isArray(r.saleTimes) ? r.saleTimes : [];
    priceHints = Array.isArray(r.prices) ? r.prices.map((p) => ({ name: String(p.name || ''), price: Number(p.price) || 0 })) : [];
    applySaleTime();
    saveSoon();
    renderKeywordHints();
  }
  btn.disabled = false;
  refresh();
});

const HEALTH_MARK = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
$('btnHealth').addEventListener('click', async () => {
  const out = $('healthMsg');
  const list = $('healthList');
  const btn = $('btnHealth');
  btn.disabled = true;
  out.textContent = '健檢中…';
  out.className = 'hint';
  list.replaceChildren();
  const r = await send({ type: 'health-check', cfg: readForm() });
  out.textContent = r.msg || r.error || '健檢失敗';
  out.className = 'hint ' + (r.worst === 'ok' ? 'good' : r.worst === 'warn' ? 'warnmsg' : 'bad');
  list.replaceChildren(...(r.items || []).map((i) => {
    const li = el('li', { class: i.status });
    li.append(el('span', {}, HEALTH_MARK[i.status] || '?'), el('span', {}, i.label), el('span', {}, i.detail || ''));
    return li;
  }));
  btn.disabled = false;
  refresh();
});

/** 匯出：任務、紀錄、黑盒子、ibon 活動頁程式版本存成一個 JSON 檔 */
$('btnExport').addEventListener('click', async () => {
  const d = await chrome.storage.local.get(['task', 'logs', 'blackbox', 'ibonFingerprint', 'form']);
  // 匯出時隱藏會員代碼、持卡人卡號；task.cfg 裡若有也同樣處理
  const hide = (o) => (o ? { ...o, memberCodes: o.memberCodes ? '（已隱藏）' : '', cardPrefix: o.cardPrefix ? '（已隱藏）' : '' } : o);
  const task = d.task ? { ...d.task, cfg: hide(d.task.cfg) } : null;
  const out = {
    exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent,
    task, form: hide(d.form || null), logs: d.logs || [], blackbox: d.blackbox || [], ibonFingerprint: d.ibonFingerprint || null,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const a = el('a', { href: url, download: `ibon-helper-log-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  say(`已匯出紀錄：${(d.logs || []).length} 筆紀錄、${(d.blackbox || []).length} 筆黑盒子`, 'ok');
});

$('btnClearLogs').addEventListener('click', async () => {
  await send({ type: 'clear-logs' });
  refresh();
});

for (const id of ['eventUrl', 'sessionWhen', 'keywords', 'qty', 'openTime', 'preOpenSec',
  'notOpenRetryMs', 'notOpenMaxRetries', 'failMaxRetries', 'syncClock', 'autoAgree', 'allowNonAdjacent', 'memberCodes', 'cardPrefix', 'exclude', 'fallback']) {
  $(id).addEventListener('input', saveSoon);
  $(id).addEventListener('change', saveSoon);
}
$('eventUrl').addEventListener('input', () => { previewUrl(); renderKeywordHints(); });
$('sessionWhen').addEventListener('change', () => { applySaleTime(); saveSoon(); });
$('exclude').addEventListener('change', renderKeywordHints);

/** 擴充功能資料夾裡有 preset.json 時，第一次打開（還沒存過設定）就先帶入，給預先設定好的安裝用 */
async function loadPreset() {
  try {
    const r = await fetch(chrome.runtime.getURL('preset.json'), { cache: 'no-store' });
    if (!r.ok) return null;
    const p = await r.json();
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch (_) {
    return null;   // 沒有 preset.json：照平常的空白表單
  }
}

(async () => {
  let { form } = await chrome.storage.local.get('form');
  if (!form) {
    form = await loadPreset();
    if (form) await chrome.storage.local.set({ form });
  }
  fillForm(form);
  previewUrl();
  renderKeywordHints();
  refresh();
  setInterval(refresh, 1000);
})();
