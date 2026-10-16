// 問題回報檔 → 測試案例（test/cases/<名稱>.json）。
//   node tools/report-to-case.mjs <回報檔.json> <案例名稱>
// 案例只留能重跑的部分（replay：這一頁交給助手的內容、上一步的預期、需求）與你回報的問題；不帶結構快照、網址參數。
// 存檔前再檢查一次個資，找到就不寫。寫好之後把 expect 改成「正確應該是」的樣子，修好程式後 node --test 會照它核對。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leakCheck } from '../lib/ibon.js';
import { replayGuide } from '../lib/guide.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [file, name] = process.argv.slice(2);
if (!file || !name || !/^[\w-]{1,60}$/.test(name)) {
  console.error('用法：node tools/report-to-case.mjs <回報檔.json> <案例名稱（英數、-、_）>');
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
if (report.type !== 'ibon-guide-report' || !report.replay) { console.error('這不是人工操作模式的問題回報檔'); process.exit(2); }

const now = replayGuide(report.replay);   // 用現在的程式重跑一次，當成 expect 的起點
const kase = {
  name,
  from: { version: report.version, createdAt: report.createdAt, page: report.page && report.page.label },
  problem: report.problem,
  replay: report.replay,
  // 照「正確應該是」改這裡：fields 的 status／value、verifyStatus、recommendationIncludes。todo 為 true 時測試只列出來、不算失敗
  todo: true,
  expect: {
    fields: Object.fromEntries((now.fields || []).map((f) => [f.field, { status: f.status, value: f.value }])),
    verifyStatus: now.verify ? now.verify.status : null,
    recommendationIncludes: [],
  },
};
const text = JSON.stringify(kase, null, 1);
const leaks = leakCheck(text);
if (leaks.length) { console.error(`案例裡找得到 ${leaks.join('、')}，沒有寫檔。請先處理回報檔裡的個資`); process.exit(1); }
const out = path.join(ROOT, 'test', 'cases', `${name}.json`);
if (fs.existsSync(out)) { console.error(`${out} 已經存在，換一個名稱`); process.exit(1); }
fs.writeFileSync(out, text + '\n');
console.log(`已寫入 ${path.relative(ROOT, out)}。問題：${report.problem.label}${report.problem.field ? `（${report.problem.field}）` : ''}：${report.problem.expected || '（沒寫）'}`);
console.log('下一步：照「正確應該是」改 expect，拿掉 todo，修程式直到 node --test test/unit/*.test.mjs 通過');
