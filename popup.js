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
function fillSessions(list, selected) {
  sessionList = list || sessionList;
  const sel = $('sessionWhen');
  const whens = sessionList.map((x) => x.when);
  if (selected && !whens.includes(selected)) whens.push(selected);
  sel.replaceChildren(el('option', { value: '' }, whens.length ? '（選一個場次）' : '先按「讀取活動」'),
    ...whens.map((w) => { const x = sessionList.find((y) => y.when === w); return el('option', { value: w }, x ? `${w}　${x.name || ''}` : w); }));
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
  if (typeof c.syncClock === 'boolean') $('syncClock').checked = c.syncClock;
  if (typeof c.autoAgree === 'boolean') $('autoAgree').checked = c.autoAgree;
  if (typeof c.fallback === 'boolean') $('fallback').checked = c.fallback;
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ form: { ...readForm(), sessionList } }), 200);
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
    fillSessions(r.sessions.map((x) => ({ when: x.when, name: x.name })), $('sessionWhen').value);
    if (r.saleAt && !$('openTime').value) $('openTime').value = r.saleAt;
    if (r.saleAt && r.saleAt !== $('openTime').value) {
      // 開賣時間跟你原本填的不同：照活動頁讀到的更新，提醒一下
      out.textContent += `（開賣時間已更新成 ${r.saleAt.replace('T', ' ')}）`;
      $('openTime').value = r.saleAt;
    }
    saveSoon();
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
  const out = {
    exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent,
    task: d.task || null, form: d.form || null, logs: d.logs || [], blackbox: d.blackbox || [], ibonFingerprint: d.ibonFingerprint || null,
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
  'notOpenRetryMs', 'notOpenMaxRetries', 'failMaxRetries', 'syncClock', 'autoAgree', 'exclude', 'fallback']) {
  $(id).addEventListener('input', saveSoon);
  $(id).addEventListener('change', saveSoon);
}
$('eventUrl').addEventListener('input', previewUrl);

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
  refresh();
  setInterval(refresh, 1000);
})();
