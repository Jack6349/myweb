# travel-expense OCR Proxy 部署步驟

用途：把 Gemini API key 藏在 Cloudflare Worker（伺服器端），前端純靜態網頁完全不接觸 key。

## 事前準備

- 一個 Cloudflare 帳號（免費，不需信用卡）：https://dash.cloudflare.com/sign-up
- 一組 Google AI Studio 的 Gemini API key：https://aistudio.google.com/apikey
- 本機安裝 Node.js（跑 wrangler CLI 用）

## 步驟

在 `travel-expense/proxy/` 這個目錄下執行：

```bash
npx wrangler login
```

會開啟瀏覽器要你登入並授權 Cloudflare 帳號，這一步在你自己的瀏覽器完成，不會經過任何第三方。

設定 Gemini API key（機密值，只存在 Cloudflare 環境變數，不會進 git）：

```bash
npx wrangler secret put GEMINI_API_KEY
```

執行後終端機會提示你貼上 key，貼上後按 Enter。

（可選）設定一組共用密鑰，前端呼叫時也要帶同樣的值，降低被隨機濫用的風險：

```bash
npx wrangler secret put APP_SECRET
```

部署：

```bash
npx wrangler deploy
```

部署完成後，終端機會印出這支 Worker 的網址，長得像：

```
https://travel-expense-ocr-proxy.<你的-cloudflare-子網域>.workers.dev
```

## 接回前端

把上面那個網址填進 [travel-expense/js/data.js](../js/data.js) 的 `OCR_CONFIG.proxyUrl`；如果你有設定 `APP_SECRET`，同樣的值也填進 `OCR_CONFIG.appSecret`。

```js
const OCR_CONFIG = {
  proxyUrl: 'https://travel-expense-ocr-proxy.xxxx.workers.dev',
  appSecret: '', // 若有設定 wrangler secret put APP_SECRET，這裡填一樣的值
};
```

填好之後，App 拍照記帳會自動改用真的 Gemini 辨識；`proxyUrl` 留空則會退回假資料（Mock），並在瀏覽器 Console 印出提醒。

## 目前的防護與實際保護力

三道防線，效果由強到弱：

1. **API key 隔離（真正有效）**：`GEMINI_API_KEY` 只存在 Cloudflare 環境變數，前端與 git 都拿不到。就算有人濫用 Worker，也偷不走金鑰本身。
2. **來源網域驗證（有效擋瀏覽器濫用）**：`ALLOWED_ORIGIN` 設為 `https://jack6349.github.io`，Worker 在伺服器端比對 `Origin` 標頭，非此來源直接回 403。這擋得住別人把你的 Worker 網址嵌進自己網站使用。缺點：`curl` 等工具可以偽造 `Origin` 標頭，擋不住刻意繞過的人。
3. **共用密鑰（只是速度障礙）**：`APP_SECRET` 前端也要帶，而前端程式碼是公開的，所以任何願意讀 `js/data.js` 的人都拿得到。它只擋得住「只知道 Worker 網址、沒讀原始碼」的隨手嘗試。

另有單張圖片大小上限（base64 8MB），避免有人用超大圖片灌爆 token 用量。

**最後的保險是用量上限**：以上都擋不住鐵了心要濫用的人，所以請務必到 [Google AI Studio 用量頁](https://aistudio.google.com/usage) 設定用量警報／上限，把最壞情況的損失鎖死。

## 費用提醒

- Cloudflare Workers 免費額度：每日 10 萬次請求，一般個人使用不會超過。
- Gemini API 呼叫算在你 Google 帳號底下的用量。

## 更換共用密鑰

若要換一組 `APP_SECRET`，兩邊都要改成同一個新值：

```bash
npx wrangler secret put APP_SECRET
```

然後更新 [travel-expense/js/data.js](../js/data.js) 的 `OCR_CONFIG.appSecret`，並重新推上 GitHub。
