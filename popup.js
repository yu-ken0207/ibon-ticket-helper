'use strict';

const $ = (id) => document.getElementById(id);

const PHASE = {
  armed: '已排程，等待開賣',
  fired: '開賣了，正在選購',
  running: '正在選購',
  'waiting-user': '停下來等你',
  paused: '已暫停',
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

const TEXT_FIELDS = ['eventUrl', 'keywords', 'tickets', 'areas', 'maxUnitPrice', 'maxTotal', 'openTime', 'preOpenSec', 'notOpenRetryMs', 'notOpenMaxRetries', 'failMaxRetries'];
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
    areas: v('areas'),
    maxUnitPrice: v('maxUnitPrice'),
    maxTotal: v('maxTotal'),
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

/*
 * 選購用的按鈕（排程、立即執行、檢查時段、健檢）能不能按，照背景程式對這個網址的判斷（preview-url 的 runnable／runNote），
 * 跟背景程式真正接不接受任務是同一個判斷。不能按時，原因寫在按鈕下方，不只是變灰。
 * 其他欄位（時段、票種、購票人資料）不在這裡擋：按下去由背景程式檢查，並說明缺什麼。
 */
const RUN_BUTTONS = ['btnSchedule', 'btnRunNow', 'btnCheck', 'btnHealth'];
let runState = { runnable: false, note: '' };   // 最近一次網址判斷的結果

function applyRunState() {
  for (const id of RUN_BUTTONS) {
    $(id).disabled = !runState.runnable;
    if (!runState.runnable && runState.note) $(id).title = runState.note; else $(id).removeAttribute('title');
  }
  const note = $('runNote');
  note.textContent = runState.runnable ? '' : runState.note;
  note.hidden = runState.runnable || !runState.note;
}

async function previewUrl() {
  const url = $('eventUrl').value.trim();
  const hint = $('regUrl');
  if (!url) {
    hint.textContent = ''; hint.className = 'hint';
    $('infoBox').hidden = true;
    runState = { runnable: false, note: '請先在上面貼網址' };
    applyRunState();
    return;
  }
  const r = await send({ type: 'preview-url', url });
  if ($('eventUrl').value.trim() !== url) return;   // 等回覆的時候網址又改了：這個結果已經過時，以後面那次為準
  runState = r.ok ? { runnable: !!r.runnable, note: r.runNote || '' } : { runnable: false, note: r.error || '背景程式沒有回應，請重新開啟這個視窗' };
  applyRunState();
  $('infoBox').hidden = !(r.ok && r.ibonKind);
  if (!$('infoBox').hidden) refreshSale();
  renderPolicy(r.ok ? r.policy : null);
  if (r.ok && r.regUrl) { hint.textContent = `${r.label}，時段列表：${r.regUrl}`; hint.className = 'hint'; }
  else if (r.ok && r.info) {
    hint.textContent = `${r.infoLabel}的活動頁：只能讀取活動資訊。自動選票、送出還在確認中，不會執行`;
    hint.className = 'hint';
    const { eventInfo } = await chrome.storage.local.get('eventInfo');
    const same = eventInfo && eventInfo.url === r.infoUrl;
    renderInfo(same ? eventInfo : null);
    if (same) matchSoon(0); else { renderChecks(null); renderMatch(null); }
  } else if (r.ok && r.ibonKind) {
    hint.textContent = `ibon 的${r.ibonLabel}：網址欄請貼活動頁網址才能讀活動資訊；這一頁請用下面的「讀取目前的 ibon 分頁」`;
    hint.className = 'hint';
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
  const r = await send({ type: 'read-info', url: $('eventUrl').value.trim(), prefs: ibonPrefs() });
  out.textContent = r.ok ? '已讀取' : (r.error || '讀取失敗');
  out.className = 'hint ' + (r.ok ? 'good' : 'bad');
  renderInfo(r.ok ? r.info : null);
  renderChecks(r.ok ? r.checks : null);
  renderMatch(r.ok ? r.match : null);
  btn.disabled = false;
  refresh();
  refreshSale();
});

/* ───────────── ibon：需求比對、資料檢查、目前分頁、操作政策（都只讀） ───────────── */

/** ibon 的比對也用「我的需求」：票區偏好、票種張數的合計、最高單價 */
const totalQty = () => $('tickets').value.split(/\r?\n/).reduce((a, line) => { const m = line.match(/(\d+)\s*張?\s*$/); return a + (m ? Number(m[1]) : 0); }, 0);
const ibonPrefs = () => ({ areas: $('areas').value, qty: totalQty() ? String(totalQty()) : '', maxPrice: $('maxUnitPrice').value });

function renderChecks(checks) {
  const v = $('checkView');
  v.replaceChildren();
  if (!checks || !checks.length) return;
  v.append(el('h3', {}, '資料檢查'));
  for (const c of checks) v.append(el('div', { class: c.level === 'warn' ? 'warn' : 'hint' }, c.msg));
}

function renderMatch(m) {
  const v = $('matchView');
  v.replaceChildren();
  if (!m) return;
  for (const a of m.areas || []) v.append(el('div', { class: a.ok ? 'ok' : 'warn' }, `${a.ok ? '✓' : '✗'} ${a.msg}`));
  if (m.qty) v.append(el('div', { class: m.qty.ok ? 'ok' : 'warn' }, `${m.qty.ok ? '✓' : '✗'} 張數：${m.qty.msg}`));
  for (const x of m.msgs || []) v.append(el('div', { class: 'warn' }, x));
  v.append(el('div', { class: 'raw' }, '比對的是節目介紹寫的票價表；實際能買的票區、剩餘數量要在購票頁看，選票由你自己點。'));
}

let matchTimer = 0;
function matchSoon(ms = 300) {
  clearTimeout(matchTimer);
  matchTimer = setTimeout(async () => {
    if ($('infoBox').hidden) return;
    const r = await send({ type: 'match-info', prefs: ibonPrefs() });
    if (r.ok) { renderChecks(r.checks); renderMatch(r.match); }
  }, ms);
}
for (const id of ['areas', 'tickets', 'maxUnitPrice']) $(id).addEventListener('input', () => matchSoon());

const MODE_TEXT = { auto: '助手會做', manual: '你自己做', never: '不做' };
function renderPolicy(policy) {
  const t = $('policyView');
  t.replaceChildren();
  for (const p of policy || []) {
    const tr = el('tr');
    tr.append(el('td', { class: `m-${p.mode}` }, MODE_TEXT[p.mode] || p.mode), el('td', {}, p.label), el('td', { class: 'raw' }, p.basis));
    t.append(tr);
  }
}

function renderPage(r) {
  const v = $('pageView');
  v.replaceChildren();
  if (!r || !r.state) return;
  const s = r.state;
  v.append(el('div', { class: 'title' }, `${s.label}${s.verified ? '' : '（這種頁面的結構還沒在真站核對過）'}`));
  v.append(el('div', { class: s.login.state === 'logged-out' ? 'warn' : 'hint' }, `登入：${s.login.msg}`));
  if (s.kind === 'activity') v.append(el('div', { class: 'hint' }, '活動頁的場次狀態請按「讀取活動資訊」'));
  else if (!s.hints.length) v.append(el('div', { class: 'hint' }, '頁面上沒有看到售完、排隊、驗證碼、錯誤這類字樣'));
  for (const h of s.hints) v.append(el('div', { class: 'warn' }, `${h.msg}（看到「${h.evidence}」，未驗證）`));
  v.append(el('div', { class: 'raw' }, '這一頁的點選、張數、下一步、驗證碼、付款都由你自己操作。'));
}

$('btnGuide').addEventListener('click', async () => {
  const out = $('guideMsg');
  const r = await send({ type: 'ibon-guide', cfg: readForm() });
  out.textContent = r.ok ? '已開始人工操作模式：建議與核對顯示在下面的「目前任務」' : (r.error || '沒辦法開始');
  out.className = 'hint ' + (r.ok ? 'good' : 'bad');
  refresh();
});

$('btnPage').addEventListener('click', async () => {
  const out = $('pageMsg');
  out.textContent = '讀取中…（只讀，不會點任何按鈕）';
  out.className = 'hint';
  const r = await send({ type: 'ibon-page', op: 'state' });
  out.textContent = r.ok ? '已讀取目前的 ibon 分頁' : (r.error || '讀取失敗');
  out.className = 'hint ' + (r.ok ? 'good' : 'bad');
  renderPage(r.ok ? r : null);
});

/** 結構快照：存成檔案，交給開發者做購票頁的讀取。先數一下有幾個封閉的 Shadow DOM，方便確認有讀進去 */
$('btnSnapshot').addEventListener('click', async () => {
  const out = $('pageMsg');
  out.textContent = '記錄中…（只讀）';
  out.className = 'hint';
  // 你填的姓名、手機、Email 只拿來在快照裡遮掉
  const own = [$('profileName').value.trim(), $('profilePhone').value.trim(), $('profilePhone').value.replace(/[\s-]/g, ''), $('profileEmail').value.trim()].filter((x) => x.length >= 2);
  const r = await send({ type: 'ibon-page', op: 'snapshot', own });
  if (!r.ok) { out.textContent = r.error || '記錄失敗'; out.className = 'hint bad'; return; }
  const snap = r.snapshot;
  let shadows = 0;
  (function walk(n) { if (!n) return; if (n.t === '#shadow-root') shadows++; for (const k of n.k || []) walk(k); })(snap.tree);
  const blob = new Blob([JSON.stringify({ version: chrome.runtime.getManifest().version, ...snap }, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const a = el('a', { href: url, download: `ibon-structure-${snap.kind || 'page'}-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  out.textContent = `已存成檔案：${snap.nodes} 個節點、${shadows} 個 Shadow DOM${snap.truncated ? '（頁面太大，後面沒記）' : ''}。姓名這類遮不到，交出去之前請打開檔案看過`;
  out.className = 'hint good';
});

/* ───────────── 狀態 ───────────── */

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

function renderTask(task, now, labels = {}) {
  const box = $('taskBox');
  box.replaceChildren();
  if (!task) { box.textContent = '沒有任務'; return; }

  const phaseCls = task.phase === 'done' ? (task.result && task.result.ok ? 'ok' : 'err')
    : task.phase === 'waiting-user' ? 'warn' : task.phase === 'cancelled' ? 'err' : '';
  box.append(el('div', { class: 'phase ' + phaseCls }, task.mode === 'guide' && task.phase === 'running' ? '人工操作模式（網站上的操作由你自己做）' : (PHASE[task.phase] || task.phase)));
  const wf = task.wf || null;
  if (wf) box.append(el('div', { class: 'wfstate' }, `流程：${labels[wf.state] || wf.state}`));
  if (task.handoff) box.append(renderHandoff(task.handoff));
  if (task.guide) box.append(renderGuide(task.guide));
  if (task.mode === 'guide' && task.phase === 'running' && task.hold) box.append(renderHold(task.hold, now));
  syncReport(task);

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
  if (wf && wf.plan) for (const k of ['session', 'area']) if (wf.plan[k]) box.append(renderPlan(wf.plan[k]));
  if (wf && wf.history && wf.history.length) {
    const d = el('details');
    d.append(el('summary', {}, `流程紀錄（${wf.history.length}）`));
    const ol = el('ol', { class: 'logs' });
    for (const h of wf.history.slice(-15)) ol.append(el('li', {}, `${clock(h.at)} ${labels[h.from] || h.from} → ${labels[h.to] || h.to}${h.forced ? '（照回報的結果）' : ''}${h.reason ? `：${h.reason}` : ''}`));
    d.append(ol);
    box.append(d);
  }
}

/** 人工操作模式：這一頁的核對結果、建議與依據、各欄位讀取結果 */
const FIELD_MARK = { ok: '✓ 讀取成功', unverified: '？ 尚未驗證', fail: '✗ 讀取失敗', unavailable: '— 這一頁沒有' };
/** 保留倒數：可靠就顯示推算的剩餘時間與通知狀態；看不出來就說未知，以頁面為準 */
function renderHold(h, now) {
  if (h.status !== 'ok' || !h.deadline) return el('div', { class: 'warn hold' }, `保留倒數：未知（${h.reason || '看不出來'}），以頁面上的時間為準，不會提醒`);
  const left = Math.max(0, Math.round((h.deadline - now) / 1000));
  const sent = [120, 60].filter((s) => h.notified && h.notified[s]).map((s) => `${s / 60} 分鐘`);
  return el('div', { class: left <= 120 ? 'warn hold' : 'hint hold' },
    left > 0 ? `保留倒數：剩約 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}（照頁面上的「剩餘時間」推算${h.checked ? '' : '，還在核對倒數有沒有在走'}）。剩 2 分鐘、1 分鐘時通知你${sent.length ? `；已通知：${sent.join('、')}` : ''}`
      : '保留倒數：照頁面推算已經到時間了，請看頁面');
}

/* ───────────── 問題回報 ───────────── */

let reportFor = '';
/** 人工操作模式讀到頁面時才顯示回報；「哪一項」的選項跟著目前這一頁的欄位換（你選到一半不會被洗掉） */
function syncReport(task) {
  const box = $('reportBox');
  const g = task && task.mode === 'guide' && task.guide;
  box.hidden = !g;
  if (!g) return;
  const key = `${g.n}|${g.pageKind}`;
  if (key === reportFor) return;
  reportFor = key;
  const sel = $('reportField');
  sel.replaceChildren(...['建議', '核對', ...(g.fields || []).map((f) => f.field), '其他'].map((f) => el('option', { value: f }, f)));
}

$('btnReport').addEventListener('click', async () => {
  const out = $('reportMsg');
  out.textContent = '產生中…（只讀）';
  out.className = 'hint';
  const own = [$('profileName').value.trim(), $('profilePhone').value.trim(), $('profilePhone').value.replace(/[\s-]/g, ''), $('profileEmail').value.trim()].filter((x) => x.length >= 2);
  const r = await send({ type: 'ibon-report', kind: $('reportKind').value, field: $('reportField').value, expected: $('reportExpected').value.trim(), withSnapshot: $('reportSnap').checked, own });
  if (!r.ok) { out.textContent = r.error || '沒有產生'; out.className = 'hint bad'; return; }
  const blob = new Blob([JSON.stringify(r.report, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const a = el('a', { href: url, download: `ibon-report-${r.report.page.kind || 'page'}-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  out.textContent = '已產生回報檔（下載資料夾）。交出去之前可以打開看過';
  out.className = 'hint good';
  $('reportExpected').value = '';
});

/* ───────────── 開賣提醒 ───────────── */

async function refreshSale() {
  const r = await send({ type: 'sale-remind-list', url: $('eventUrl').value.trim() });
  const list = $('saleList');
  list.replaceChildren();
  if (!r.ok) return;
  if (r.sale && r.sale.unknown && !r.sale.items.some((x) => !x.past)) list.append(el('div', { class: 'hint' }, `開賣時間：未知（${r.sale.unknown}），不能設定提醒`));
  for (const x of (r.sale && r.sale.items) || []) {
    if (!x.verified) list.append(el('div', { class: 'warn' }, `「${x.text}」的開賣時間來自${x.source}`));
  }
  for (const m of r.reminders || []) {
    const left = m.ms - r.now;
    const row = el('div', { class: 'checkrow' });
    const sent = [300, 60].filter((s) => m.notified && m.notified[s]).map((s) => `${s / 60} 分鐘`);
    row.append(el('span', {}, `⏰ ${m.title}：${saleText(m.ms)} 開賣${left > 0 ? `（還有約 ${fmtLeft(left)}）` : '（已開賣）'}${sent.length ? `，已通知：${sent.join('、')}` : ''}`));
    const b = el('button', { class: 'link', type: 'button' }, '取消');
    b.addEventListener('click', async () => { await send({ type: 'sale-remind-cancel', id: m.id }); refreshSale(); });
    row.append(b);
    list.append(row);
  }
}
const saleText = (ms) => {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}（台灣時間）`;
};
const fmtLeft = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 1440 ? `${Math.floor(m / 1440)} 天 ${Math.floor((m % 1440) / 60)} 小時` : m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分鐘`;
};

$('btnSaleRemind').addEventListener('click', async () => {
  const out = $('saleMsg');
  const r = await send({ type: 'sale-remind', url: $('eventUrl').value.trim() });
  out.textContent = r.ok ? `已設定 ${r.added} 個開賣提醒` : (r.error || '沒有設定');
  out.className = 'hint ' + (r.ok ? 'good' : 'bad');
  refreshSale();
});

function renderGuide(g) {
  const box = el('div', { class: 'guide' });
  box.append(el('div', { class: 'title' }, `人工操作模式：第 ${g.n} 頁，${g.label}`));
  if (g.verify) box.append(el('div', { class: g.verify.status === 'ok' ? 'ok' : 'warn' }, `核對：${g.verify.msg}`));
  box.append(el('div', { class: 'rec' }, `建議：${g.recommendation}`));
  const b = g.basis || {};
  if (b.plan) {
    box.append(el('div', {}, `依據：${b.plan.msg}`));
    const ul = el('ul');
    for (const r of (b.plan.ranked || []).slice(0, 6)) ul.append(el('li', {}, `${r.verdict === 'chosen' ? '✓' : '✗'} ${r.text}：${r.reason}`));
    box.append(ul);
  }
  if (b.match) for (const m of [...(b.match.areas || []), b.match.qty, ...(b.match.msgs || [])].filter(Boolean)) box.append(el('div', { class: 'raw' }, m));
  for (const h of b.hints || []) box.append(el('div', { class: 'warn' }, h));
  if (b.policy) box.append(el('div', { class: 'raw' }, b.policy));
  const table = el('table');
  for (const f of g.fields || []) {
    const tr = el('tr');
    tr.append(el('td', {}, f.field), el('td', { class: `s-${f.status}` }, FIELD_MARK[f.status] || f.status), el('td', {}, [f.value, f.note].filter(Boolean).join('｜')));
    table.append(tr);
  }
  box.append(table);
  return box;
}

/** 交接內容（HandoffManager）：為什麼停、停在哪、已確認的內容、你要做的下一步 */
function renderHandoff(h) {
  const box = el('div', { class: 'handoff' });
  box.append(el('div', { class: 'title' }, h.label));
  if (h.reason) box.append(el('div', {}, `原因：${h.reason}`));
  const c = h.confirmed || {};
  const parts = [];
  if (c.session) parts.push(`場次 ${c.session}`);
  if (c.area) parts.push(`票區 ${c.area}`);
  if (c.items && c.items.length) parts.push(c.items.map((x) => `${x.name} ${x.qty} 張`).join('、'));
  if (c.amount != null) parts.push(`合計 NT$${c.amount}`);
  if (c.holdLeftSec != null) parts.push(`保留約剩 ${c.holdLeftSec} 秒`);
  if (parts.length) box.append(el('div', {}, `已確認：${parts.join('，')}`));
  if (h.next) box.append(el('div', { class: 'next' }, `下一步：${h.next}`));
  return box;
}

/** 規劃（PurchasePlanner）的候選與理由 */
const VERDICT = { chosen: '✓ 選這個', skip: '✗', unknown: '？', wait: '…', ok: '○' };
function renderPlan(p) {
  const box = el('div', { class: 'plan' });
  box.append(el('div', {}, `${p.kind === 'area' ? '票區' : '場次'}規劃：${p.msg || ''}`));
  const ul = el('ul');
  for (const r of (p.ranked || []).slice(0, 6)) ul.append(el('li', { class: `v-${r.verdict}` }, `${VERDICT[r.verdict] || r.verdict} ${r.text}：${r.reason}`));
  box.append(ul);
  return box;
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
  $('btnResume').hidden = !(t && ((t.phase === 'waiting-user' && !(t.result && t.result.kind === 'ready')) || t.phase === 'paused'));
  $('btnPause').hidden = !(t && ['fired', 'running'].includes(t.phase) && t.mode !== 'guide');
  renderTask(r.task, r.now || Date.now(), r.labels || {});
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

$('btnPause').addEventListener('click', async () => {
  const r = await send({ type: 'pause' });
  say(r.ok ? '已暫停：助手做完手上這一個檢查就停。按「繼續」從目前這一頁接著做' : (r.error || '沒辦法暫停'), r.ok ? 'ok' : 'err');
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
  applyRunState();   // 照目前網址決定能不能再按（檢查途中網址可能換了）
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
  applyRunState();
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
  $('ver').textContent = `v${chrome.runtime.getManifest().version}`;   // 確認載入的是哪一版
  applyRunState();   // 網址判斷回來之前先停用
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
