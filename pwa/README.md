# 813 看診進度提醒 — 手機版（PWA）

手機用的看診進度提醒，iOS 與 Android 共用同一份程式。加到主畫面就像一般 App，
指定診間的叫號一有異動、或快輪到你的號碼時通知你。

**非官方工具**，由個人開發，非國軍桃園總醫院新竹分院推出，未經該院授權或背書。

---

## 為什麼需要一台 Worker

兩個原因，都繞不掉：

1. **醫院網站只有 http 沒有 https。** PWA 的 service worker 強制要求 https，
   而 https 網頁不能去抓 http 資源（混合內容會被瀏覽器擋掉），所以中間一定要有一層代理。
2. **手機瀏覽器不能在背景自己輪詢。** iOS 完全不支援 Background Sync／Periodic Background Sync，
   PWA 關掉後不能執行任何程式碼；Android 的 Periodic Background Sync 間隔是數小時等級。
   想在螢幕鎖住時收到提醒，只能靠 **Web Push**——而推播必須由伺服器發出。

所以架構是：Cloudflare Worker 負責代理 + 每分鐘輪詢 + 推播，PWA 負責介面與前景即時顯示。
全部都在 Cloudflare 免費方案額度內。

```
                    ┌──────────────────────────┐
   醫院 API (http)  │  Cloudflare Worker       │
   ───────────────► │  ・代理 http → https     │
                    │  ・每分鐘 cron 輪詢       │ ──Web Push──► 手機（App 關著也收得到）
                    │  ・凌晨 00:00 清除紀錄    │
                    │  ・KV 存訂閱與監看設定    │
                    └──────────┬───────────────┘
                               │ /api/progress
                    ┌──────────▼───────────────┐
                    │  PWA（靜態網頁）          │
                    │  ・選診間、填號碼         │
                    │  ・前景每 30 秒更新       │
                    │  ・螢幕不休眠、震動、音效 │
                    └──────────────────────────┘
```

---

## 部署

### 1. 建立 Worker

```bash
cd worker
npm install
npx wrangler login

# 建立 KV，把輸出的 id 填進 wrangler.toml 的 kv_namespaces.id
npx wrangler kv namespace create STATE
```

### 2. 產生推播金鑰

```bash
cd ..
node scripts/gen-vapid.mjs
```

照畫面指示把兩個值設成 secret（**不要**寫進 `wrangler.toml`）：

```bash
cd worker
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

順便把 `wrangler.toml` 裡的 `VAPID_SUBJECT` 改成你的信箱
（推播服務業者出問題時會用這個聯絡你，規範要求要填）。

### 3. 部署

```bash
npx wrangler deploy
```

會得到一個網址，例如 `https://813-reminder.你的帳號.workers.dev`。

### 4. 設定前端並上線

把 `public/app.js` 最上面的 `DEFAULT_API` 換成上一步的 Worker 網址：

```js
const DEFAULT_API = 'https://813-reminder.你的帳號.workers.dev';
```

然後把 `public/` 整個資料夾丟到任何支援 https 的靜態空間。最省事的是 GitHub Pages：
把 `public/` 推上 repo，到 Settings → Pages 選好分支即可。

> 也可以先不改程式，直接用 `https://你的網址/?api=https://你的worker網址` 開啟，
> 網址參數會被記住，方便測試。

部署完成後建議把 `wrangler.toml` 的 `ALLOWED_ORIGINS` 從 `*` 改成你的前端網址，
避免別人拿你的 Worker 當免費代理。

---

## 手機上的安裝

### iPhone（重要）

**一定要先「加入主畫面」**，否則收不到通知——iOS 只允許從主畫面啟動的 PWA 使用通知。

1. 用 **Safari** 開啟網址（Chrome 不行，iOS 的 Chrome 是 WebKit 外殼）
2. 點下方分享鍵 → 「加入主畫面」
3. 從主畫面開啟，再開啟「看診進度提醒」開關並允許通知

需要 iOS 16.4 以上。

### Android

用 Chrome 開啟後，選單裡會出現「安裝應用程式」或「加到主畫面」。裝不裝都能收通知，
但裝起來體驗較好。

---

## 使用

1. 按「＋ 加入要監看的診間」，清單會自動抓出**今天**所有診間，依上午／下午／晚上分組
2. 選好診間後填入**你的號碼**，設定剩幾號時提醒（預設剩 3 號）
3. 需要的話開啟「手機關著也要收到」，允許通知即可

### 兩層提醒

| 情況 | 誰在查 | 行為 |
|---|---|---|
| App 開著 | 手機自己 | 每 30 秒更新、震動、提示音、螢幕可設定不休眠 |
| App 關著／螢幕鎖住 | Cloudflare Worker | 每分鐘查，快輪到你時推播叫醒你 |

### 通知時機

- **快輪到你了**：剩 N 號時提醒，同一個號碼只提醒一次，不會一直吵
- **輪到你了 / 已經過號**：各提醒一次
- **開始看診 / 看診結束**：狀態改變時各一次
- **每次叫號變動都通知**：預設關閉（手機上太吵），可在單一診間設定裡打開

---

## 每天凌晨自動清除

每天**台北時間 00:00**，前一天的紀錄會自動清掉：

| 會清除 | 會保留 |
|---|---|
| 監看的診間清單 | 推播訂閱（隔天不用重新授權通知） |
| 你填的號碼 | 提醒偏好（音效、螢幕不休眠等） |
| 比對狀態與已通知紀錄 | |
| 當日看診進度快取 | |

號碼每天都不一樣、診間也只在當天的班表上，留著只會誤判，所以整批清掉最乾淨。

清除在三個地方各做一次，任何一邊沒跑到都不會出錯：

- **Worker 排程**：`0 16 * * *`（UTC 16:00 = 台北 00:00，台灣全年固定 UTC+8）
- **Worker 每分鐘輪詢**：發現紀錄上的日期不是今天就地重置（防止排程漏跑）
- **PWA 端**：開啟 App、切回前景、以及 App 一直開著跨過午夜時，都會檢查並清除

想提早清掉的話，設定面板有「清除今日紀錄」按鈕。

---

## 檔案結構

```
public/                PWA（靜態檔案，丟哪都能跑）
├── index.html
├── app.js             介面、前景輪詢、通知、螢幕不休眠、跨日清除
├── app.css            淺色／深色
├── logic.js           共用判斷邏輯（Worker 也 import 這一份，只有一份來源）
├── sw.js              service worker：離線快取 + 接收推播
├── manifest.webmanifest
└── icons/

worker/                Cloudflare Worker
├── src/index.js       API 路由 + 兩個排程（每分鐘輪詢、凌晨清除）
├── src/push.js        Web Push（RFC 8291 aes128gcm + RFC 8292 VAPID）
└── wrangler.toml

scripts/gen-vapid.mjs  產生推播金鑰
test/                  測試（見下）
```

---

## 測試

```bash
node test/push.test.mjs     # 推播加密：自己加密→自己解密，逐項比對
node test/worker.test.mjs   # Worker 排程與凌晨清除（用假的 KV）
node test/pwa.test.mjs      # 真的 Chromium 跑一遍介面流程
```

`test/pwa.test.mjs` 需要先在 `public/` 起一個本機伺服器：

```bash
cd public && python3 -m http.server 8910
```

推播加密沒辦法在本機打到真的推播服務，因此改用**往返驗證**：
用測試用的訂閱金鑰加密，再用對應私鑰解回來比對原文，
並確認換了 auth secret 就解不開、每次加密的密文都不同、VAPID 簽章可用公鑰驗證通過。
HKDF、ECDH、AES-GCM 任何一步寫錯，往返都會對不起來。

---

## 幾件值得知道的事

**iOS 的背景推播沒有保證。** Apple 對 PWA 推播的資源配置比原生 App 保守，
長時間沒開啟 App 時訂閱有可能被系統回收。真的很在意的話，候診時把 App 開著最保險
（開著的那條路徑完全不依賴推播）。

**Cloudflare cron 最小間隔是 1 分鐘**，所以背景推播最慢會晚一分鐘。
App 開著時是 30 秒。

**Worker 只在有人監看時才會去打醫院網站**，而且結果會快取 45 秒共用，
不管幾個人訂閱，醫院那邊每分鐘最多收到一次請求。

**資料只有今天的班表。** 醫院 API 只回傳當日資料，所以隔天要看的診要等當天才查得到。

**隱私**：Worker 的 KV 只存推播端點、你選的診間名稱和你自己填的號碼，
沒有姓名、沒有病歷、沒有任何身分資訊。30 天沒更新的訂閱會自動過期刪除。
