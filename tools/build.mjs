#!/usr/bin/env node
// 產生 page-agent.js：src/agent/ 底下的檔案依檔名順序串成一個 IIFE，00-core.js 之後插入頁面要用的共用模組 lib/*.js。
// 頁面腳本（content script）不能用 ES module，所以共用模組在這裡拿掉 import / export 後內嵌。
//
// 用法：node tools/build.mjs           重新產生 page-agent.js
//       node tools/build.mjs --check   只檢查 page-agent.js 是不是最新的，不是就以代碼 1 結束
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_DIR = path.join(ROOT, 'src', 'agent');
const OUT = path.join(ROOT, 'page-agent.js');
// 頁面用得到的共用模組，順序要照相依：health 用到 format 的 fmt
const LIBS = ['format.js', 'urls.js', 'areas.js', 'clock.js', 'health.js', 'eventinfo.js'];
const BANNER = '// 這個檔案由 tools/build.mjs 從 src/agent/ 和 lib/ 產生，請改那兩個地方，不要直接改這裡。\n';

function inlineLib(name) {
  const src = fs.readFileSync(path.join(ROOT, 'lib', name), 'utf8');
  const lines = src.split('\n').filter((l) => !/^import\s/.test(l)).map((l) => l.replace(/^export\s+/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return `  /* ───── 內嵌 lib/${name} ───── */\n` + lines.map((l) => (l ? '  ' + l : l)).join('\n') + '\n\n';
}

export function build() {
  const parts = fs.readdirSync(AGENT_DIR).filter((f) => /^\d\d-[\w-]+\.js$/.test(f)).sort();
  if (!parts.length || !parts[0].startsWith('00-')) throw new Error('src/agent/ 少了 00-core.js');
  let out = BANNER;
  for (const f of parts) {
    out += fs.readFileSync(path.join(AGENT_DIR, f), 'utf8');
    if (f.startsWith('00-')) out += '\n' + LIBS.map(inlineLib).join('');
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = build();
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (cur !== next) {
      console.error('page-agent.js 不是最新的，請先執行 node tools/build.mjs');
      process.exit(1);
    }
    console.log('page-agent.js 是最新的');
  } else {
    fs.writeFileSync(OUT, next);
    console.log(`已產生 page-agent.js，${next.split('\n').length} 行`);
  }
}
