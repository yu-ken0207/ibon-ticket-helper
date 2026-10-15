#!/usr/bin/env node
// 產生兩支頁面程式（content script 不能用 ES module，所以共用模組在這裡拿掉 import / export 後內嵌）：
//   agent.js      src/agent/ 底下的檔案依檔名順序串成一個 IIFE，00-core.js 之後內嵌 lib/ 的 format、clock、flow。
//                 只載入到本機模擬站（選購流程）。
//   ibon-info.js  src/info/ 加上共用的 src/agent/05-dom.js（只有找元素、讀文字的工具），內嵌 lib/eventinfo.js。
//                 只載入到 ibon 活動頁，只讀資訊，裡面沒有選購流程的程式。
//
// 用法：node tools/build.mjs           重新產生兩支
//       node tools/build.mjs --check   只檢查是不是最新的，不是就以代碼 1 結束
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_DIR = path.join(ROOT, 'src', 'agent');
const OUT = path.join(ROOT, 'agent.js');
const LIBS = ['format.js', 'clock.js', 'flow.js'];
const BANNER = '// 這個檔案由 tools/build.mjs 從 src/agent/ 和 lib/ 產生，請改那兩個地方，不要直接改這裡。\n';
const INFO_OUT = path.join(ROOT, 'ibon-info.js');
const INFO_PARTS = ['src/info/00-core.js', 'src/agent/05-dom.js', 'src/info/10-ibon.js', 'src/info/90-boot.js'];
const INFO_LIBS = ['eventinfo.js'];
const INFO_BANNER = '// 這個檔案由 tools/build.mjs 從 src/info/、src/agent/05-dom.js 和 lib/eventinfo.js 產生，請改那些地方，不要直接改這裡。\n';

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

/** ibon-info.js：只讀活動資訊的頁面程式 */
export function buildInfo() {
  let out = INFO_BANNER;
  for (const f of INFO_PARTS) {
    out += fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (f === 'src/info/00-core.js') out += '\n' + INFO_LIBS.map(inlineLib).join('');
  }
  return out;
}

const OUTPUTS = [[OUT, build], [INFO_OUT, buildInfo]];

/** 產生出來的檔案有沒有過期：回傳過期的檔名 */
export function stale() {
  return OUTPUTS.filter(([file, fn]) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '') !== fn()).map(([file]) => path.basename(file));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const old = stale();
    if (old.length) {
      console.error(`${old.join('、')} 不是最新的，請先執行 node tools/build.mjs`);
      process.exit(1);
    }
    console.log('agent.js、ibon-info.js 都是最新的');
  } else {
    for (const [file, fn] of OUTPUTS) {
      const next = fn();
      fs.writeFileSync(file, next);
      console.log(`已產生 ${path.basename(file)}，${next.split('\n').length} 行`);
    }
  }
}
