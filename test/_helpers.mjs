// 測試共用：讓測試在不同機器上都跑得起來
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 擴充功能根目錄（這個檔案的上一層） */
export const EXT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 載入 playwright；可用 PW_MODULE 指定路徑（例如全域安裝時） */
export async function loadPlaywright() {
  const spec = process.env.PW_MODULE || 'playwright';
  const mod = await import(spec);
  return mod.default || mod;
}

/** 啟動瀏覽器用的選項；CHROMIUM_PATH 可指定自訂的 Chromium */
export function launchOptions(extra = {}) {
  const o = { headless: true, args: ['--no-sandbox'], ...extra };
  if (process.env.CHROMIUM_PATH) o.executablePath = process.env.CHROMIUM_PATH;
  return o;
}

export function makeChecker() {
  const state = { failed: 0 };
  const check = (name, cond, detail) => {
    if (cond) console.log('  ✓ ' + name);
    else {
      state.failed++;
      console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
    }
  };
  const finish = () => {
    console.log(state.failed === 0 ? '\n全部通過 ✅' : `\n${state.failed} 項失敗 ❌`);
    process.exit(state.failed === 0 ? 0 : 1);
  };
  return { check, finish, state };
}

export const todayTaipei = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d).replace(/-/g, '');
