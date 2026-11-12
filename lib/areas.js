// 場次與票區的比對。只處理文字，不碰網頁；頁面程式和背景程式共用。
// 規則同 kktix 助手的票種比對：關鍵字一行一組、越上面越優先，同一行用空格隔開表示每一段都要出現；
// 排除字一律不選；關鍵字都對不到時，fallback 打開才改選第一個還能買的（一樣套用排除字）。

export const DEFAULT_EXCLUDE = ['輪椅', '身障', '身心', '障礙', '愛心', 'Restricted View', '燈柱遮蔽', '視線不完整'];

const nz = (s) => String(s == null ? '' : s).replace(/[\s　]+/g, ' ').trim();
// 比對用的正規化：全小寫、把數字裡的千分位逗號拿掉（夢想音樂節顯示「5,880」、籃球賽顯示「6,980」）；
// 兩邊都走這一步，所以使用者填「6980」或「6,980」都能對到，ibon 顯示有逗號或沒逗號也都對。
// 全形逗號、數字之間的空格（例如「6 ,980」）也一起處理。
const unComma = (s) => String(s).replace(/(?<=\d)\s*[,，]\s*(?=\d)/g, '');
const lc = (s) => unComma(nz(s)).toLowerCase();
export const SOLD_OUT_RE = /已售完|售完|已額滿|額滿|暫無|無法購買|已截止|選購一空|尚無票/;

/** 一行一個，也接受逗號、頓號分隔 */
export function parseList(v) {
  return (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\r\n,，、]+/))
    .map((x) => nz(x))
    .filter(Boolean);
}

/** 關鍵字：一行一組 */
export function parseKeywords(v) {
  return (Array.isArray(v) ? v : String(v == null ? '' : v).split(/\r?\n/)).map(nz).filter(Boolean);
}

/** 演出時間「2026/10/24(六) 13:00」→「2026/10/24 13:00」：場次的唯一識別，去掉星期 */
export function sessionKey(text) {
  return nz(text).replace(/\s*[(（][^)）]*[)）]/g, '');
}

/**
 * 在選項裡挑一個。options：[{ text, unavailable }]（票區列、下拉選項都用這個格式）。
 * unavailable 為真表示頁面標了不能買（例如票區列的 class 有 disabled、剩下的張數不夠），當成賣完處理。
 * 回傳 { kind, index, text, names, excluded }：
 *   match 關鍵字對到、fallback 沒對到但依遞補設定選了第一個、
 *   sold-out 對到的都賣完了、blocked 對到的都在排除清單、no-match 一個都沒對到
 */
export function pickOption(options, cfg) {
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
export function validateCfg(cfg) {
  if (!cfg.regUrl) return '活動網址看不懂，請貼 ibon 活動頁網址（https://ticket.ibon.com.tw/ActivityInfo/Details/…）';
  if (!cfg.sessionWhen) return '請先按「讀取活動」，再選一個場次';
  if (!parseKeywords(cfg.keywords).length && cfg.fallback !== true) {
    return '請至少填一組票區關鍵字，或勾選「關鍵字對不到就選第一個」。沒有關鍵字時不會自己亂選票區';
  }
  return null;
}

/*
 * 驗證問題頁的擷取（同 tickets_hunter util.extract_answer_by_question_pattern）：
 * 題目含「末N碼／後N碼／最後N碼／末N位」→ 從答案取後 N 個字；
 * 「前N碼／首N碼／前N位」→ 從答案取前 N 個字；
 * 中文數字（一～十）自動換成阿拉伯數字；對不到就回傳原答案。
 */
const CN_TO_DIGIT = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
// 「末3碼」、「末 3 碼」、「末3位」都要能對；tickets_hunter 的原版沒處理空格，我多加 \s* 容忍
const LAST_N = [/末\s*(\d+)\s*碼/, /後\s*(\d+)\s*碼/, /最後\s*(\d+)\s*碼/, /末\s*(\d+)\s*位/];
const FIRST_N = [/前\s*(\d+)\s*碼/, /首\s*(\d+)\s*碼/, /前\s*(\d+)\s*位/];
export function extractAnswer(answer, questionText) {
  const a = String(answer == null ? '' : answer);
  if (!a) return '';
  const q = String(questionText == null ? '' : questionText).replace(/[一二三四五六七八九十]/g, (c) => CN_TO_DIGIT[c] || c);
  for (const re of LAST_N) {
    const m = q.match(re);
    if (m) { const n = Math.min(Number(m[1]), a.length); return a.slice(-n); }
  }
  for (const re of FIRST_N) {
    const m = q.match(re);
    if (m) { const n = Math.min(Number(m[1]), a.length); return a.slice(0, n); }
  }
  return a;
}
