// RequirementMatcher 與 PurchasePlanner（純函式，不碰網頁）：把你的需求跟網站讀到的場次、票區、票種、價格比對，
// 排出候選並說明每一個選或不選的理由。這裡只做決定；網站操作由流程（src/agent/60-flow.js）照決定做，每一步還要過 PolicyGate。
// 場次的關鍵字比對、票種配對沿用 lib/flow.js（hasAll、planTickets），不另外寫一套。
import { words, hasAll, isBuyable, planTickets } from './flow.js';

const toInt = (v) => {
  const n = Number.parseInt(String(v == null ? '' : v).replace(/[,，\s]/g, ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const linesOf = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/\r?\n/)).map((x) => String(x).trim()).filter(Boolean);
const plain = (s) => String(s || '').replace(/[\s　]+/g, '').replace(/[–—~～〜－-]/g, '-');

/** 設定 → 需求：場次偏好、票種張數、票區偏好、最高單價、總金額上限、遞補 */
export function requirementOf(cfg) {
  const c = cfg || {};
  const tickets = Array.isArray(c.tickets) ? c.tickets : [];
  const need = tickets.reduce((a, t) => a + (Number.isInteger(t.qty) && t.qty > 0 ? t.qty : 0), 0);
  return {
    sessions: linesOf(c.keywords), tickets, areas: linesOf(c.areas),
    maxUnitPrice: toInt(c.maxUnitPrice), maxTotal: toInt(c.maxTotal), fallback: !!c.fallback, need: need || 1,
  };
}

/**
 * RequirementMatcher：票種張數對網站的票種與價格（加上票區加價 surcharge），檢查最高單價與總金額上限。
 * types: [{ id?, name, price }]。回 { ok, kind?: 'tickets' | 'budget', plan?, msg }
 */
export function matchTickets(req, types, { surcharge = 0, maxPerOrder = Infinity } = {}) {
  const priced = (types || []).map((t, i) => ({ id: t.id || t.name || String(i), name: t.name, price: (Number(t.price) || 0) + surcharge }));
  const p = planTickets(priced, req.tickets, maxPerOrder);
  if (!p.ok) return { ok: false, kind: 'tickets', msg: p.msg };
  const over = req.maxUnitPrice ? p.plan.filter((x) => x.price > req.maxUnitPrice) : [];
  if (over.length) return { ok: false, kind: 'budget', plan: p, msg: `${over.map((x) => `${x.name}每張 NT$${x.price}`).join('、')}超過你設定的最高單價 NT$${req.maxUnitPrice}` };
  if (req.maxTotal && p.amount > req.maxTotal) return { ok: false, kind: 'budget', plan: p, msg: `合計 NT$${p.amount}（${p.total} 張）超過你設定的總金額上限 NT$${req.maxTotal}` };
  return { ok: true, plan: p, msg: `${p.plan.map((x) => `${x.name} ${x.qty} 張`).join('、')}，合計 NT$${p.amount}` };
}

/** 場次的判斷與理由 */
function judgeSession(s, need, skipped) {
  if (skipped.has(s.id)) return ['skip', '這次已經試過，買不到'];
  if (s.status === 'unknown') return ['unknown', '頁面上看不出能不能買'];
  if (s.status === 'not-open') return ['wait', '還沒開放'];
  if (s.status === 'full') return ['skip', '已額滿'];
  if (!isBuyable(s)) return ['skip', '不能買'];
  if (s.remaining != null && s.remaining < need) return ['skip', `只剩 ${s.remaining} 張，不夠 ${need} 張`];
  return ['ok', s.remaining != null ? `可以買（剩 ${s.remaining} 張）` : '可以買'];
}

/**
 * PurchasePlanner：場次。依偏好順序（一行一組，空白分隔的每一段都要對到），每個對到的場次都附理由：
 *   ok        選這個（同一組裡有能買的就選第一個）
 *   unknown   這一組沒有能買的，而且有狀態看不出來的：不猜，停下來問你
 *   not-open  這一組還沒開放：等，不跳去比較不想要的那組
 *   sold-out  偏好的都額滿、剩的不夠或已經試過；no-match 關鍵字都對不到
 * 開了遞補，偏好都沒結果時改選第一個能買的。
 * 回 { kind, slot?, line?, fallback?, ranked: [{ id, text, status, remaining, pref, verdict, reason }], msg }
 */
export function planSession(slots, req, { skip = [] } = {}) {
  const skipped = new Set(skip);
  const ranked = [];
  const seen = new Set();
  let result = null;
  req.sessions.forEach((line, i) => {
    if (!words(line).length) return;
    const pref = i + 1;
    for (const s of slots.filter((x) => hasAll(x.text, line) && !seen.has(x.id))) {
      seen.add(s.id);
      const [verdict, reason] = judgeSession(s, req.need, skipped);
      ranked.push({ id: s.id, text: s.text, status: s.status, remaining: s.remaining == null ? null : s.remaining, pref, verdict, reason });
    }
    if (result) return;   // 已經決定了，後面的偏好只列出來給你看
    const mine = ranked.filter((r) => r.pref === pref);
    const ok = mine.find((r) => r.verdict === 'ok');
    if (ok) { ok.verdict = 'chosen'; result = { kind: 'ok', slot: slots.find((s) => s.id === ok.id), line }; return; }
    const unk = mine.find((r) => r.verdict === 'unknown');
    if (unk) { result = { kind: 'unknown', line, text: unk.text }; return; }
    const wait = mine.find((r) => r.verdict === 'wait');
    if (wait) result = { kind: 'not-open', line, text: wait.text };
  });
  if (!result && req.fallback) {
    const any = slots.find((s) => judgeSession(s, req.need, skipped)[0] === 'ok');
    if (any) {
      result = { kind: 'ok', slot: any, line: null, fallback: true };
      ranked.push({ id: any.id, text: any.text, status: any.status, remaining: any.remaining == null ? null : any.remaining, pref: null, verdict: 'chosen', reason: '偏好都買不到，遞補第一個能買的' });
    } else if (slots.some((s) => s.status === 'not-open')) result = { kind: 'not-open', line: null };
  }
  if (!result) {
    // 跟 lib/flow.js 的 describePick 相容：sold-out 帶 names 與 short（剩的不夠的那一個），no-match 帶頁面上的場次
    const short = ranked.find((x) => x.remaining != null && x.remaining > 0 && x.remaining < req.need && (x.status === 'available' || x.status === 'limited'));
    result = ranked.length
      ? { kind: 'sold-out', names: [...new Set(ranked.map((x) => x.text))], short: short ? { text: short.text, remaining: short.remaining } : null }
      : { kind: 'no-match', names: slots.map((s) => s.text) };
  }
  return { ...result, ranked: ranked.slice(0, 20), msg: describeSessionPlan(result, ranked, slots) };
}

function describeSessionPlan(r, ranked, slots) {
  const chosen = ranked.find((x) => x.verdict === 'chosen');
  switch (r.kind) {
    case 'ok': return `選「${chosen.text}」（${chosen.pref ? `第 ${chosen.pref} 個偏好` : '遞補'}，${chosen.reason}）`;
    case 'unknown': return `偏好的「${r.text}」頁面上看不出能不能買。為了不選錯，先停下來`;
    case 'not-open': return r.text ? `偏好的「${r.text}」還沒開放` : '還沒開放';
    case 'sold-out': return `偏好的場次都買不到：${ranked.slice(0, 6).map((x) => `${x.text}（${x.reason}）`).join('、')}`;
    default: return `關鍵字對不到任何場次。頁面上的場次有：${slots.slice(0, 6).map((s) => s.text).join('、')}${slots.length > 6 ? '…' : ''}`;
  }
}

/**
 * PurchasePlanner：票區（選票頁有分區時）。areas: [{ id, name, surcharge, remaining, soldOut }]，types 是頁面上的票種與單價。
 * 有票區偏好就照偏好順序（一行一組），沒設就照頁面順序；每個票區都附理由：售完、剩的不夠、超過預算、這次試過買不到。
 * 回 { kind: 'ok' | 'none', area?, tickets?（matchTickets 的結果）, ranked, msg }
 */
export function planArea(areas, req, types, { skip = [], maxPerOrder = Infinity } = {}) {
  const skipped = new Set(skip);
  const order = [];
  const add = (a, pref) => { if (!order.some((o) => o.a.id === a.id)) order.push({ a, pref }); };
  if (req.areas.length) req.areas.forEach((line, i) => areas.filter((a) => hasAll(a.name, line)).forEach((a) => add(a, i + 1)));
  else areas.forEach((a) => add(a, null));
  const ranked = [];
  let pick = null;
  for (const { a, pref } of order) {
    let verdict = 'ok', reason = '';
    const t = matchTickets(req, types, { surcharge: a.surcharge || 0, maxPerOrder });
    if (skipped.has(a.id)) { verdict = 'skip'; reason = '這次已經試過，售完了'; }
    else if (a.soldOut || a.remaining === 0) { verdict = 'skip'; reason = '已售完'; }
    else if (a.remaining != null && a.remaining < req.need) { verdict = 'skip'; reason = `只剩 ${a.remaining} 張，不夠 ${req.need} 張`; }
    else if (!t.ok) { verdict = 'skip'; reason = t.msg; }
    else reason = `${a.surcharge ? `每張加 NT$${a.surcharge}，` : ''}${t.msg}${a.remaining != null ? `（剩 ${a.remaining} 張）` : ''}`;
    if (verdict === 'ok' && !pick) { verdict = 'chosen'; pick = { a, t }; }
    ranked.push({ id: a.id, name: a.name, pref, verdict, reason });
  }
  if (pick) return { kind: 'ok', area: pick.a, tickets: pick.t, ranked, msg: `選「${pick.a.name}」：${ranked.find((x) => x.verdict === 'chosen').reason}` };
  const why = ranked.length ? ranked.map((x) => `${x.name}（${x.reason}）`).join('、') : `票區偏好對不到頁面上的票區（有：${areas.map((a) => a.name).join('、')}）`;
  return { kind: 'none', ranked, msg: `沒有符合需求的票區：${why}` };
}

/**
 * ORDER_REVIEW：確認頁讀到的內容（summary）跟計畫（expect）比對；不一致就不交接付款，停下來請你確認。
 *   summary { session, area, items: [{ name, qty }], amount }
 *   expect  { sessionText, areaName, items: [{ name, qty }], amount }
 */
export function reviewOrder(summary, expect) {
  const s = summary || {};
  const e = expect || {};
  const items = Array.isArray(s.items) ? s.items : [];
  const diffs = [];
  if (!items.length) diffs.push('確認頁讀不到票種與張數');
  if (e.sessionText && plain(s.session) !== plain(e.sessionText)) diffs.push(`場次：預計「${e.sessionText}」，確認頁是「${s.session || '（沒寫）'}」`);
  if (e.areaName && s.area !== e.areaName) diffs.push(`票區：預計「${e.areaName}」，確認頁是「${s.area || '（沒寫）'}」`);
  for (const it of e.items || []) {
    const got = items.find((x) => x.name === it.name);
    if (!got || got.qty !== it.qty) diffs.push(`${it.name}：預計 ${it.qty} 張，確認頁是 ${got ? got.qty : 0} 張`);
  }
  // 沒有計畫的票種（例如你自己操作到確認頁再按「繼續」）：不比對張數，只確認讀得到內容
  if ((e.items || []).length) for (const got of items) if (!e.items.some((x) => x.name === got.name)) diffs.push(`確認頁多了「${got.name} ${got.qty} 張」`);
  if (e.amount != null && s.amount != null && s.amount !== e.amount) diffs.push(`金額：預計 NT$${e.amount}，確認頁是 NT$${s.amount}`);
  return { ok: !diffs.length, diffs, msg: diffs.length ? `確認頁的內容跟計畫不一致：${diffs.join('；')}` : '確認頁的內容跟計畫一致' };
}
