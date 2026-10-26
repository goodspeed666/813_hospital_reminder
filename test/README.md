# 測試

## 不需要瀏覽器

```bash
node test/logic.test.mjs
node test/firefox-runtime.test.mjs
node test/firefox-build.test.mjs
node test/safe-dom.test.mjs
```

用假的 `chrome.*` API 實際載入 `background.js`，跑完整的叫號流程：
剩 N 號提醒、同號碼不重複、過號、看診結束、跨日清除、台北午夜倒數等。

Firefox 測試檢查通知欄位、Firefox 背景頁提示音，以及產出的 AMO 套件、來源 ZIP 與可重現雜湊。
安全 DOM 測試會阻止將變動文字插入 HTML 字串。

## 需要瀏覽器

```bash
npm install --no-save playwright
npx playwright install chromium
node test/daily-reset.e2e.mjs
```

在真的 Chromium 裡載入這個擴充功能，把過期資料灌進 `chrome.storage.local`，
驗證五種情境下都會被清掉、且**今天的資料不會被誤清**。

> 這組測試是踩過坑才補的：1.0.5 和 1.0.6 兩次修正看程式碼都合理，
> 實際上日期檢查被卡住的查詢擋在外面，根本沒執行到。只有真的跑起來才看得出來。

### 環境變數

在已經有 Playwright 和 Chromium 的環境裡，可以指定路徑避免重新安裝：

```bash
PW_MODULE=/path/to/playwright/index.js \
CHROMIUM_PATH=/path/to/chromium \
node test/daily-reset.e2e.mjs
```
