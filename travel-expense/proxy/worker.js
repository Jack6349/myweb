/* travel-expense — 收據 OCR/翻譯 Proxy（Cloudflare Worker）
 *
 * 目的：把 Gemini API key 藏在伺服器端，前端純靜態網頁不接觸到 key。
 * 前端只呼叫這支 Worker 的網址，Worker 再用環境變數裡的 key 去打 Gemini API。
 *
 * 部署步驟見同目錄 README.md。
 */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (request.method !== 'POST') {
      return jsonError('Method Not Allowed', 405, env);
    }

    // 簡易共用密鑰驗證：降低「隨便什麼人拿到這個網址就狂打」的風險。
    // 這不是強加密，只是提高濫用門檻；APP_SECRET 未設定時不驗證。
    if (env.APP_SECRET) {
      const provided = request.headers.get('X-App-Secret');
      if (provided !== env.APP_SECRET) {
        return jsonError('unauthorized', 401, env);
      }
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError('invalid JSON body', 400, env);
    }

    const { image, mimeType } = body; // image：base64 字串（不含 "data:image/...;base64," 前綴）
    if (!image) return jsonError('missing image', 400, env);
    if (!env.GEMINI_API_KEY) return jsonError('server not configured: GEMINI_API_KEY missing', 500, env);

    const prompt = `你是收據辨識助手。分析這張收據照片，只回傳 JSON（不要任何其他文字），欄位如下：
merchant：店家名稱（保留收據原文語言，不要翻譯）
currency：幣別 ISO 4217 代碼（如 JPY、TWD、KRW、USD、EUR），依收據內容判斷
items：陣列，每個元素為 { name, qty, amount }
  - name：品項名稱，翻譯成繁體中文
  - qty：數量（整數，收據未標示數量則填 1）
  - amount：該品項小計金額（純數字，不含幣別符號或千分位逗號）
若某些欄位難以辨識，仍盡力給出最合理的估計值，不要省略欄位。`;

    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inline_data: { mime_type: mimeType || 'image/jpeg', data: image } },
              ],
            }],
            generationConfig: {
              response_mime_type: 'application/json',
              responseSchema: {
                type: 'object',
                properties: {
                  merchant: { type: 'string' },
                  currency: { type: 'string' },
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        qty: { type: 'integer' },
                        amount: { type: 'number' },
                      },
                      required: ['name', 'qty', 'amount'],
                    },
                  },
                },
                required: ['merchant', 'currency', 'items'],
              },
            },
          }),
        }
      );
    } catch (e) {
      return jsonError('failed to reach gemini api: ' + e.message, 502, env);
    }

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return jsonError('gemini api error (' + geminiRes.status + '): ' + errText, 502, env);
    }

    const data = await geminiRes.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
      && data.candidates[0].content.parts[0].text;
    if (!text) return jsonError('no result text from gemini', 502, env);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonError('gemini returned non-JSON: ' + text.slice(0, 200), 502, env);
    }

    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders(env), 'Content-Type': 'application/json' },
    });
  },
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
  };
}

function jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(env), 'Content-Type': 'application/json' },
  });
}
