// 購票流程狀態機（WorkflowEngine 的規則，純函式）。
// 背景程式把目前狀態存在 task.wf（WorkflowStateStore），每次轉移都用 transition() 檢查合不合法並記進歷程；
// 頁面程式每進一個狀態都要先問背景程式（被暫停、取消，或轉移不合法就不能做），每個網站操作再過一次 PolicyGate（lib/policy.js）。
// 交接給你的時候，用 composeHandoff() 整理原因、目前頁面、已確認的內容與下一步（HandoffManager）。

/**
 * 每個狀態：
 *   kind     active（助手在做事）／wait（等開賣）／handoff（交給你）／paused／terminal
 *   entry    什麼時候進來
 *   actions  這個狀態裡可能做的網站操作（每一個還要過 PolicyGate）
 *   done     做完的條件
 *   errors   出錯時怎麼處理
 *   next     可以轉到哪些狀態（暫停、取消、失敗、交給你另外統一處理，見 canTransition）
 */
export const STATES = {
  IDLE: { kind: 'idle', label: '尚未開始', entry: '沒有任務', actions: [], done: '你按「立即執行」或「排程」', errors: '—', next: ['WAITING_FOR_SALE', 'PAGE_DETECTION'] },
  WAITING_FOR_SALE: {
    kind: 'wait', label: '等待開賣', entry: '排程後到開賣前；或時段還沒開放、還在重看次數內',
    actions: ['read-page', 'refresh-list'], done: '開賣時間到（頁面倒數與背景到點保險），或頁面顯示已開放',
    errors: '重看次數用完 → FAILED；遇到排隊 → QUEUE_HANDOFF', next: ['PAGE_DETECTION', 'ACTIVITY_READ'],
  },
  PAGE_DETECTION: {
    kind: 'active', label: '判斷目前頁面', entry: '每次頁面載入、開賣重新整理後，或你按「繼續」',
    actions: ['read-page'], done: '認出是哪一頁', errors: '認不得 → MANUAL_CONFIRMATION',
    next: ['ACTIVITY_READ', 'TICKET_AREA_SELECTION', 'BUYER_INFO', 'ORDER_REVIEW', 'WAITING_FOR_SALE'],
  },
  ACTIVITY_READ: {
    kind: 'active', label: '讀取活動與場次', entry: '在場次列表頁',
    actions: ['read-page', 'refresh-list'], done: '讀到場次、狀態、票價',
    errors: '讀取失敗照重試額度重讀；429 照 Retry-After；一直讀不到 → MANUAL_CONFIRMATION', next: ['REQUIREMENT_CHECK', 'ACTIVITY_READ'],
  },
  REQUIREMENT_CHECK: {
    kind: 'active', label: '比對你的需求', entry: '讀到場次與票價',
    actions: [], done: '有符合需求的場次（依偏好排序，附理由）',
    errors: '尚未開放 → WAITING_FOR_SALE；偏好的場次狀態看不出來 → MANUAL_CONFIRMATION；沒有符合的（售完、預算、張數）→ FAILED',
    next: ['SESSION_SELECTION', 'WAITING_FOR_SALE'],
  },
  SESSION_SELECTION: {
    kind: 'active', label: '選場次', entry: '規劃出要選的場次', actions: ['select-session'],
    done: '進到選票頁', errors: '找不到選購按鈕 → MANUAL_CONFIRMATION；你已經保留了名額 → MANUAL_CONFIRMATION（不重選）', next: ['PAGE_DETECTION'],
  },
  TICKET_AREA_SELECTION: {
    kind: 'active', label: '選票區與票種', entry: '在選票頁', actions: ['select-area'],
    done: '選好符合偏好、預算、張數的票區（沒有分區就只對票種）',
    errors: '這一步已經做過（已保留）→ 直接往下一頁，不重送；沒有符合的票區 → FAILED；選不起來 → MANUAL_CONFIRMATION',
    next: ['QUANTITY_SELECTION', 'PAGE_DETECTION'],
  },
  QUANTITY_SELECTION: {
    kind: 'active', label: '選張數並送出選購', entry: '票區、票種已決定', actions: ['set-quantity', 'submit-hold'],
    done: '網站接受選購，進到下一頁',
    errors: '售完 → 換下一個票區或場次；伺服器錯誤（確定失敗）照次數上限重送；結果不明（連線中斷、逾時）→ MANUAL_CONFIRMATION，不重送；429 → RATE_LIMIT_HANDOFF；登入逾時 → MANUAL_CONFIRMATION',
    next: ['PAGE_DETECTION', 'TICKET_AREA_SELECTION'],
  },
  BUYER_INFO: {
    kind: 'active', label: '填購票人資料', entry: '在購票人資料頁（選購已保留）', actions: ['fill-profile', 'agree-terms', 'submit-buyer'],
    done: '網站接受資料，進到確認頁',
    errors: '資料不完整或網站說哪一欄有問題 → MANUAL_CONFIRMATION；不自動勾同意 → MANUAL_CONFIRMATION；結果不明 → MANUAL_CONFIRMATION',
    next: ['PAGE_DETECTION'],
  },
  ORDER_REVIEW: {
    kind: 'active', label: '核對訂單', entry: '在確認頁', actions: ['read-page'],
    done: '確認頁的場次、票區、張數、金額跟計畫一致', errors: '不一致 → MANUAL_CONFIRMATION', next: ['PAYMENT_HANDOFF'],
  },
  QUEUE_HANDOFF: { kind: 'handoff', label: '排隊中：交給你', entry: '遇到排隊或等候室', actions: [], done: '你按「繼續」', errors: '—', next: ['PAGE_DETECTION'] },
  CHALLENGE_HANDOFF: { kind: 'handoff', label: '驗證：交給你', entry: '遇到驗證碼、機器人檢查或其他驗證', actions: [], done: '你自己完成驗證後按「繼續」', errors: '—', next: ['PAGE_DETECTION'] },
  RATE_LIMIT_HANDOFF: { kind: 'handoff', label: '請求太多：交給你', entry: '送出遇到 429，或讀取重試用完', actions: [], done: '你等一下後按「繼續」', errors: '—', next: ['PAGE_DETECTION'] },
  MANUAL_CONFIRMATION: { kind: 'handoff', label: '需要你確認', entry: '資料不完整、登入逾時、結果不明、狀態看不出來、內容不一致、認不得的頁面', actions: [], done: '你處理後按「繼續」', errors: '—', next: ['PAGE_DETECTION'] },
  PAYMENT_HANDOFF: {
    kind: 'handoff', label: '付款前交接', entry: '確認頁核對無誤', actions: [],
    done: '你自己按「確認建立訂單」、付款；完成頁出現 → COMPLETED', errors: '保留快到期、到期都提醒', next: ['COMPLETED'],
  },
  PAUSED: { kind: 'paused', label: '已暫停', entry: '你按「暫停」', actions: [], done: '你按「繼續」', errors: '—', next: ['PAGE_DETECTION'] },
  FAILED: { kind: 'terminal', label: '沒有完成', entry: '沒有符合需求的選擇，或錯誤用完重試', actions: [], done: '—', errors: '—', next: [] },
  COMPLETED: { kind: 'terminal', label: '完成', entry: '你確認後網站建立了訂單', actions: [], done: '—', errors: '—', next: [] },
  CANCELLED: { kind: 'terminal', label: '已取消', entry: '你按「取消任務」、分頁被關掉，或被新任務取代', actions: [], done: '—', errors: '—', next: [] },
};

export const isTerminal = (s) => !!STATES[s] && STATES[s].kind === 'terminal';
const kindOf = (s) => (STATES[s] ? STATES[s].kind : null);

/**
 * from → to 合不合法：
 *   - 結束的狀態不能再轉移
 *   - 沒結束的都可以取消；助手在做事（或等開賣）時可以暫停、失敗、交給你（付款前交接只能從核對訂單來）
 *   - 交給你、暫停之後，按「繼續」回到判斷目前頁面；付款前交接之後只會到完成
 *   - 助手在做事、等開賣時，頁面一換就回到判斷目前頁面
 *   - 助手在做事、等開賣時，停在同一個狀態（例如重讀列表、錯誤頁重新整理）算合法，不另外記歷程
 *   - 其他照 STATES[from].next
 */
export function canTransition(from, to) {
  if (!STATES[from] || !STATES[to]) return false;
  const fk = kindOf(from);
  if (from === to) return fk === 'active' || fk === 'wait';
  if (fk === 'terminal') return false;
  if (to === 'CANCELLED') return true;
  if (to === 'PAUSED') return fk === 'active' || fk === 'wait';
  if (to === 'FAILED') return fk === 'active' || fk === 'wait';
  if (to === 'PAYMENT_HANDOFF') return from === 'ORDER_REVIEW';
  if (kindOf(to) === 'handoff') return fk === 'active' || fk === 'wait';
  if (to === 'COMPLETED') return from === 'PAYMENT_HANDOFF';
  if (to === 'PAGE_DETECTION' && from !== 'PAYMENT_HANDOFF' && fk !== 'idle') return true;
  return STATES[from].next.includes(to);
}

export const HISTORY_MAX = 60;

export const newWorkflow = () => ({ state: 'IDLE', since: Date.now(), history: [], done: {}, plan: null, selection: null, skipAreas: {}, resumeTo: null });

/**
 * 轉移：合法就回新的 wf（記進歷程，最多 HISTORY_MAX 筆）；不合法回 { ok: false, msg }，wf 不變。
 * force 用在交給你、結束這類一定要記下來的轉移（例如頁面回報的結果），不合法也照轉，但歷程會標 forced。
 */
export function transition(wf, to, { now = Date.now(), reason = '', force = false } = {}) {
  const w = wf || newWorkflow();
  const ok = canTransition(w.state, to);
  if (ok && w.state === to) return { ok: true, wf: w, same: true };
  if (!ok && !force) return { ok: false, wf: w, msg: `流程不能從「${label(w.state)}」直接到「${label(to)}」` };
  const history = [...(w.history || []), { from: w.state, to, at: now, reason: String(reason || '').slice(0, 160), ...(ok ? {} : { forced: true }) }].slice(-HISTORY_MAX);
  return { ok: true, wf: { ...w, state: to, since: now, history } };
}

export const label = (s) => (STATES[s] ? STATES[s].label : String(s));

/** 頁面回報的結果 → 狀態：交給你的分成排隊、驗證、請求太多、其他；沒交給你的就是失敗 */
export function stateOfResult({ ok, kind, handOff }) {
  const k = String(kind || '').toLowerCase();
  if (k === 'ordered') return 'COMPLETED';
  if (k === 'cancelled') return 'CANCELLED';
  if (ok && k === 'ready') return 'PAYMENT_HANDOFF';
  if (!handOff) return 'FAILED';
  if (/queue/.test(k)) return 'QUEUE_HANDOFF';
  if (/captcha|botcheck|challenge/.test(k)) return 'CHALLENGE_HANDOFF';
  if (/rate-limit/.test(k)) return 'RATE_LIMIT_HANDOFF';
  return 'MANUAL_CONFIRMATION';
}

/** 交給你之後，你要做的下一步（依狀態；有些原因另外說明） */
const NEXT_BY_STATE = {
  PAYMENT_HANDOFF: '請檢查訂單內容，自己按「確認建立訂單」；之後的付款也由你自己處理。助手不會替你送出',
  QUEUE_HANDOFF: '請在這一頁排隊等候，輪到你之後按「繼續」，或自己操作',
  CHALLENGE_HANDOFF: '請自己完成驗證，再按「繼續」或自己操作',
  RATE_LIMIT_HANDOFF: '網站說請求太多：請等一下再自己操作，或稍後按「繼續」',
  MANUAL_CONFIRMATION: '請看上面的原因處理好之後按「繼續」，或自己操作',
  PAUSED: '按「繼續」從目前這一頁接著做，或按「取消任務」',
  FAILED: '可以調整設定後重新「立即執行」',
};
const NEXT_BY_KIND = {
  'login-required': '請在網站上重新登入，再按「繼續」',
  'unknown-result': '請看頁面或網站的訂單查詢，確認剛才的送出有沒有成功；助手不會自己重送',
  'status-unknown': '請自己確認那個場次能不能買；要改選其他場次，請調整時段關鍵字後重新執行',
  'review-mismatch': '請核對確認頁的內容；不對就回上一步修改，或取消任務',
  'already-held': '你已經保留了名額；要換時段請先取消任務再重新執行',
  'budget': '請調整最高單價、總金額上限或張數後重新執行',
  'area-none': '請調整票區偏好、預算或張數後重新執行',
};

/**
 * HandoffManager：交接內容。
 *   reason     為什麼停下來（頁面回報的訊息）
 *   page       停在哪一頁
 *   confirmed  已經確認的內容（場次、票區、票種張數、金額、保留剩餘時間，以及做完的步驟）
 *   next       你要做的下一步
 */
export function composeHandoff(state, { kind = '', msg = '', page = null, wf = null, summary = null, now = Date.now() } = {}) {
  const w = wf || {};
  const sel = w.selection || {};
  const confirmed = {
    session: (summary && summary.session) || sel.sessionText || null,
    area: (summary && summary.area) || sel.areaName || null,
    items: (summary && summary.items && summary.items.length ? summary.items : sel.items) || [],
    amount: summary && summary.amount != null ? summary.amount : (sel.amount != null ? sel.amount : null),
    holdLeftSec: summary && summary.holdLeftSec != null ? summary.holdLeftSec : null,
    steps: Object.keys(w.done || {}),
  };
  return {
    state, label: label(state), kind: String(kind || ''), reason: String(msg || '').slice(0, 400),
    page: page ? { kind: page.kind || '', url: page.url || '' } : null,
    confirmed, next: NEXT_BY_KIND[kind] || NEXT_BY_STATE[state] || '', at: now,
  };
}
