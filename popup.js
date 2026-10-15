'use strict';

const $ = (id) => document.getElementById(id);

const PHASE = {
  armed: '已排程，等待開賣',
  fired: '開賣了，正在選購',
  running: '正在選購',
  'waiting-user': '停下來等你',
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

const TEXT_FIELDS = ['eventUrl', 'keywords', 'tickets', 'openTime', 'preOpenSec', 'notOpenRetryMs', 'notOpenMaxRetries', 'failMaxRetries'];
const PROFILE_FIELDS = [['profileName', 'name'], ['profilePhone', 'phone'], ['profileEmail', 'email'], ['profileNote', 'note']];

function readForm() {
  const v = (id) => $(id).value;
  const cfg = {
    eventUrl: v('eventUrl').trim(),
    keywords: v('keywords'),
    tickets: v('tickets'),
    profile: Object.fromEntries(PROFILE_FIELDS.map(([id, k]) => [k, v(id)])),
    autoAgree: $('autoAgree').checked,
    openTime: v('openTime'),
    preOpenSec: v('preOpenSec'),
    notOpenRetryMs: v('notOpenRetryMs'),
    notOpenMaxRetries: v('notOpenMaxRetries'),
    failMaxRetries: v('failMaxRetries'),
    syncClock: $('syncClock').checked,
    fallback: $('fallback').checked,
  };
  if (cfg.openTime) {
    const t = new Date(cfg.openTime).getTime();   // datetime-local 沒有時區，照本機時間解讀
    if (Number.isFinite(t)) cfg.targetTs = t;
  }
  return cfg;
}

function fillForm(c) {
  if (!c) return;
  for (const id of TEXT_FIELDS) if (c[id] != null && c[id] !== '') $(id).value = c[id];
  const pf = c.profile || {};
  for (const [id, k] of PROFILE_FIELDS) if (typeof pf[k] === 'string') $(id).value = pf[k];
  for (const id of ['autoAgree', 'syncClock', 'fallback']) if (typeof c[id] === 'boolean') $(id).checked = c[id];
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ form: readForm() }), 200);
}

// 選購用的按鈕：ibon 活動頁只能讀取資訊，這些一律停用
const RUN_BUTTONS = ['btnSchedule', 'btnRunNow', 'btnCheck', 'btnHealth'];
const INFO_ONLY_TITLE = 'ibon 活動頁目前只能讀取活動資訊；自動選票、送出還在確認網站規則與法律適用';

function setInfoOnly(on) {
  $('infoBox').hidden = !on;
  for (const id of RUN_BUTTONS) {
    $(id).disabled = on;
    if (on) $(id).title = INFO_ONLY_TITLE; else $(id).removeAttribute('title');
  }
}

async function previewUrl() {
  const url = $('eventUrl').value.trim();
  const hint = $('regUrl');
  if (!url) { hint.textContent = ''; hint.className = 'hint'; setInfoOnly(false); return; }
  const r = await send({ type: 'preview-url', url });
  setInfoOnly(!!(r.ok && r.info));
  if (r.ok && r.regUrl) { hint.textContent = `${r.label}，時段列表：${r.regUrl}`; hint.className = 'hint'; }
  else if (r.ok && r.info) {
    hint.textContent = `${r.infoLabel}的活動頁：只能讀取活動資訊。自動選票、送出還在確認中，不會執行`;
    hint.className = 'hint';
    const { eventInfo } = await chrome.storage.local.get('eventInfo');
    renderInfo(eventInfo && eventInfo.url === r.infoUrl ? eventInfo : null);
  } else { hint.textContent = '看不懂這個網址。選購只支援本機的一般票券模擬站（http://127.0.0.1:3300/pool/）；ibon 活動頁可以讀取活動資訊'; hint.className = 'hint bad'; }
}

/* ───────────── 活動資訊（只讀） ───────────── */

const STATUS_CLASS = { 'on-sale': 'st-on-sale', 'sold-out': 'st-sold-out', 'not-open': 'st-not-open', closed: 'st-closed', unknown: 'st-unknown' };
const dtText = (iso) => (iso ? iso.replace('T', ' ').replace(/-/g, '/') : '');

function renderInfo(info) {
  const v = $('infoView');
  v.replaceChildren();
  if (!info) return;
  v.append(el('div', { class: 'title' }, info.title || '（沒有讀到標題）'));
  for (const o of info.offers || []) v.append(el('div', { class: 'hint' }, `${o.label}：${o.value}`));

  v.append(el('h3', {}, `場次（${(info.sessions || []).length}）`));
  if ((info.sessions || []).length) {
    const table = el('table');
    const head = el('tr');
    for (const h of ['演出時間', '場次', '場地', '狀態']) head.append(el('th', {}, h));
    table.append(head);
    for (const s of info.sessions) {
      const tr = el('tr');
      const extra = s.saleEnd ? `（${dtText(s.saleEnd)} 截止）` : s.saleStart ? `（${dtText(s.saleStart)} 開賣）` : '';
      tr.append(el('td', {}, s.date ? `${dtText(s.date)} ${s.time || ''}`.trim() : s.when), el('td', {}, s.name), el('td', {}, s.venue),
        el('td', { class: STATUS_CLASS[s.status] || '' }, s.statusLabel + extra));
      table.append(tr);
    }
    v.append(table);
  } else v.append(el('div', { class: 'hint' }, '沒有讀到場次'));

  v.append(el('h3', {}, '票區與票價（節目介紹的文字）'));
  if ((info.prices || []).length) {
    const ul = el('ul');
    for (const p of info.prices) ul.append(el('li', {}, `${p.name || '（沒寫名稱）'}　NT$${p.price.toLocaleString('en-US')}`));
    v.append(ul);
  } else v.append(el('div', { class: 'hint' }, '節目介紹裡沒有認得的票價'));
  for (const line of info.priceLines || []) v.append(el('div', { class: 'raw' }, `原文：${line}`));

  v.append(el('h3', {}, '開賣時間'));
  if ((info.saleTimes || []).length) {
    for (const t of info.saleTimes) v.append(el('div', {}, dtText(t.at)), el('div', { class: 'raw' }, `原文：${t.text}`));
  } else v.append(el('div', { class: 'hint' }, '節目介紹裡沒有認得的開賣時間'));

  if ((info.limits || []).length) {
    v.append(el('h3', {}, '限購（購票須知原文）'));
    const ul = el('ul');
    for (const l of info.limits) ul.append(el('li', {}, l));
    v.append(ul);
  }
  for (const w of info.warnings || []) v.append(el('div', { class: 'warn' }, `注意：${w}`));
  v.append(el('div', { class: 'raw' }, `讀取時間 ${fmt(info.readAt)}。票區與票價取自節目介紹的文字；實際能買的票區要進購票流程才看得到，助手不會進去。`));
}

$('btnInfo').addEventListener('click', async () => {
  const out = $('infoMsg');
  const btn = $('btnInfo');
  btn.disabled = true;
  out.textContent = '讀取中…（只讀，不會點任何按鈕）';
  out.className = 'hint';
  const r = await send({ type: 'read-info', url: $('eventUrl').value.trim() });
  out.textContent = r.ok ? '已讀取' : (r.error || '讀取失敗');
  out.className = 'hint ' + (r.ok ? 'good' : 'bad');
  renderInfo(r.ok ? r.info : null);
  btn.disabled = false;
  refresh();
});

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
  row('網站', task.regUrl || '-');
  row('時段', (task.cfg && task.cfg.keywords || []).join(' ／ ') || '-');
  row('票種', (task.cfg && task.cfg.tickets || []).filter((t) => t.qty > 0).map((t) => `${t.name} ${t.qty}`).join('、') || '-');
  if (task.skip && task.skip.length) row('換掉的時段', task.skip.join('、'));
  if (task.mode === 'scheduled') {
    row('開賣', fmt(task.targetTs) + (task.phase === 'armed' ? `（還有 ${left(task.targetTs - now)}）` : ''));
    if (task.phase === 'armed') row('開頁', task.tabId ? '已開好' : fmt(task.openAt));
    if (task.fireDrift != null) row('到點誤差', `${task.fireDrift} ms`);
  }
  if (task.notOpen || task.fail || task.loadFail) row('重試', `尚未開放 ${task.notOpen} 次、讀取失敗 ${task.loadFail || 0} 次、送出失敗 ${task.fail} 次`);
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
  // 停下來交給你（不是確認頁）時才顯示「繼續」：確認頁一定由你自己按確認
  const t = r.task;
  $('btnResume').hidden = !(t && t.phase === 'waiting-user' && !(t.result && t.result.kind === 'ready'));
  renderTask(r.task, r.now || Date.now());
  renderLogs(r.logs || []);
}

/* ───────────── 按鈕 ───────────── */

$('btnSchedule').addEventListener('click', async () => {
  const cfg = readForm();
  if (!cfg.targetTs) return say('請先設定開賣時間', 'err');
  const r = await send({ type: 'schedule', cfg });
  if (r.ok) say(`已排程：${fmt(r.task.targetTs)} 開賣，${fmt(r.task.openAt)} 開啟時段列表`, 'ok');
  else say(r.error || '排程失敗', 'err');
  refresh();
});

$('btnRunNow').addEventListener('click', async () => {
  if (!window.confirm('要立即執行嗎？它會選時段與張數、填購票人資料，停在確認頁，由你自己確認建立訂單。')) return;
  const r = await send({ type: 'run-now', cfg: readForm() });
  if (r.ok) say('已開始執行，請看網站的分頁', 'ok');
  else say(r.error || '執行失敗', 'err');
  refresh();
});

$('btnResume').addEventListener('click', async () => {
  const r = await send({ type: 'resume', cfg: readForm() });
  if (r.ok) say('已繼續，請看網站的分頁', 'ok');
  else say(r.error || '沒辦法繼續', 'err');
  refresh();
});

$('btnCancel').addEventListener('click', async () => {
  const r = await send({ type: 'cancel' });
  say(r.ok ? '已取消任務' : (r.error || '取消失敗'), r.ok ? 'ok' : 'err');
  refresh();
});

$('btnCheck').addEventListener('click', async () => {
  const out = $('checkMsg');
  const btn = $('btnCheck');
  btn.disabled = true;
  out.textContent = '檢查中…';
  out.className = 'hint';
  const r = await send({ type: 'check-slots', cfg: readForm() });
  out.textContent = r.msg || r.error || '檢查失敗';
  out.className = 'hint ' + (r.ok ? 'good' : 'bad');
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

/** 匯出：任務、紀錄、黑盒子存成一個 JSON 檔。購票人資料不會匯出 */
$('btnExport').addEventListener('click', async () => {
  const d = await chrome.storage.local.get(['task', 'logs', 'blackbox', 'form']);
  const hideProfile = (pf) => (pf ? Object.fromEntries(Object.keys(pf).map((k) => [k, pf[k] ? '（已隱藏）' : ''])) : pf);
  const hide = (o) => (o ? { ...o, ...(o.profile ? { profile: hideProfile(o.profile) } : {}) } : o);
  const task = d.task ? { ...d.task, cfg: hide(d.task.cfg) } : null;
  const out = {
    exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent,
    task, form: hide(d.form || null), logs: d.logs || [], blackbox: d.blackbox || [],
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }));
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const a = el('a', { href: url, download: `ticket-helper-log-${stamp}.json` });
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

for (const id of [...TEXT_FIELDS, ...PROFILE_FIELDS.map(([x]) => x), 'autoAgree', 'syncClock', 'fallback']) {
  $(id).addEventListener('input', saveSoon);
  $(id).addEventListener('change', saveSoon);
}
$('eventUrl').addEventListener('input', previewUrl);

/** 擴充功能資料夾裡有 preset.json 時，第一次打開（還沒存過設定）就先帶入 */
async function loadPreset() {
  try {
    const r = await fetch(chrome.runtime.getURL('preset.json'), { cache: 'no-store' });
    if (!r.ok) return null;
    const p = await r.json();
    return p && typeof p === 'object' && !Array.isArray(p) ? p : null;
  } catch (_) {
    return null;
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
