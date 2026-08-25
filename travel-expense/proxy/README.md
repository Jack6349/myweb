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

## 費用與風險提醒

- Cloudflare Workers 免費額度：每日 10 萬次請求，一般個人使用不會超過。
- Gemini API 呼叫本身是你 Google 帳號底下的用量，請到 Google AI Studio / Google Cloud 主控台設定用量或預算警報，避免異常扣費。
- `APP_SECRET` 只是降低隨機濫用門檻，不是強加密；它仍會出現在前端程式碼裡，只是外洩後頂多被拿去打你的 OCR 額度，不會直接動用到你的 Gemini 帳單金鑰本身。
