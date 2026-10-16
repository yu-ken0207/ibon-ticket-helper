// 實際使用回報轉成的測試案例（test/cases/*.json，由 tools/report-to-case.mjs 產生）：用 replay 重跑，照 expect 核對。
// todo 為 true 的案例（還沒改好預期、或程式還沒修）只列出來，不算失敗。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayGuide } from '../../lib/guide.js';
import { leakCheck } from '../../lib/ibon.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];

for (const f of files) {
  const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
  const c = JSON.parse(raw);
  test(`案例 ${c.name}：${(c.problem && c.problem.label) || ''}${c.problem && c.problem.field ? `（${c.problem.field}）` : ''}`, { todo: c.todo ? (c.problem && c.problem.expected) || '還沒改好預期' : false }, () => {
    assert.deepEqual(leakCheck(raw), [], '案例裡不能有個資');
    const g = replayGuide(c.replay);
    const e = c.expect || {};
    const fields = Object.fromEntries((g.fields || []).map((x) => [x.field, x]));
    for (const [k, want] of Object.entries(e.fields || {})) {
      assert.ok(fields[k], `沒有「${k}」這一項`);
      if ('status' in want) assert.equal(fields[k].status, want.status, `「${k}」的讀取結果`);
      if ('value' in want) assert.equal(fields[k].value, want.value, `「${k}」的值`);
    }
    if (e.verifyStatus !== undefined) assert.equal(g.verify ? g.verify.status : null, e.verifyStatus, '核對結果');
    for (const s of e.recommendationIncludes || []) assert.ok(g.recommendation.includes(s), `建議裡要有「${s}」：${g.recommendation}`);
  });
}
