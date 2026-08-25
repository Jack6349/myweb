/* travel-expense — Prototype 假資料層。
 * 純畫面驗證用，不接後端、不持久化，重新整理頁面即重置。
 * 欄位命名沿用 travel-v2 的費用模型（category/note/amount/currency/payMethod/payer/split/items），
 * 以利之後銜接正式資料結構；items 另加 qty（數量）供本 App 使用。
 */

// 隨行人員（假資料）。帳號為唯一鍵，alias 為顯示名稱。
const MEMBERS = [
  { account: 'jack',   alias: 'Jack' },
  { account: 'meimei', alias: '妹妹' },
  { account: 'ershao', alias: '二少' },
  { account: 'mi',     alias: '咪' },
];
const ME = 'jack'; // prototype：固定「我」為 jack

function aliasOf(account) {
  const m = MEMBERS.find(x => x.account === account);
  return m ? m.alias : account;
}

// 別名是否已存在（可排除某帳號自己，用於改別名時檢查重複）
function aliasExists(alias, exceptAccount) {
  return MEMBERS.some((m) => m.account !== exceptAccount && m.alias === alias);
}

// 新增成員（帳號自動產生），回傳新成員物件
function addMember(alias) {
  const account = 'm-' + Date.now().toString(36);
  const m = { account, alias };
  MEMBERS.push(m);
  return m;
}

// 改別名
function renameMember(account, alias) {
  const m = MEMBERS.find((x) => x.account === account);
  if (m) m.alias = alias;
}

// 成員是否已被費用引用（付款人或分攤對象，含分項）→ 用於刪除保護
function memberInUse(account) {
  return EXPENSES.some((e) => {
    if (e.payer === account) return true;
    if ((e.split || []).includes(account)) return true;
    if ((e.items || []).some((it) => (it.split || []).includes(account))) return true;
    return false;
  });
}

// 刪除成員。回傳 { ok, reason }；ok=false 時 reason 為擋下原因
function removeMember(account) {
  if (account === ME) return { ok: false, reason: '「我」不可刪除' };
  if (memberInUse(account)) return { ok: false, reason: '此成員已有費用引用，無法刪除' };
  const idx = MEMBERS.findIndex((m) => m.account === account);
  if (idx >= 0) MEMBERS.splice(idx, 1);
  return { ok: true };
}

/* 行程（旅行）假資料。每筆費用以 tripId 歸屬到某一行程，用於區分不同次旅行的花費。
 * 欄位參考 travel-v2：id、name、start、end、currency（此行程預設幣別）、members（參與此行程的成員帳號，取自 MEMBERS 子集）。
 */
const TRIPS = [
  { id: 't-jp', name: '2026 北海道初夏', start: '2026-06-05', end: '2026-06-09', currency: 'JPY', members: ['jack', 'meimei', 'ershao', 'mi'] },
  { id: 't-kr', name: '2026 秋首爾美食', start: '2026-10-12', end: '2026-10-16', currency: 'KRW', members: ['jack', 'meimei'] },
];

function tripById(id) {
  return TRIPS.find((t) => t.id === id);
}

// 此行程的參與成員（MEMBERS 子集，依 trip.members 篩選）
function tripMembers(tripId) {
  const t = tripById(tripId);
  if (!t) return [];
  return MEMBERS.filter((m) => t.members.includes(m.account));
}

function tripDateLabel(t) {
  return `${t.start} ~ ${t.end}`;
}

// 新增行程，回傳新行程物件
function addTrip(data) {
  const id = 't-' + Date.now().toString(36);
  const t = { id, name: data.name, start: data.start, end: data.end, currency: data.currency, members: data.members };
  TRIPS.push(t);
  return t;
}

// 編輯行程
function updateTrip(id, data) {
  const t = tripById(id);
  if (t) Object.assign(t, data);
}

// 行程是否已被費用引用 → 用於刪除保護
function tripInUse(id) {
  return EXPENSES.some((e) => e.tripId === id);
}

// 刪除行程。回傳 { ok, reason }
function removeTrip(id) {
  if (TRIPS.length <= 1) return { ok: false, reason: '至少需保留一個行程' };
  if (tripInUse(id)) return { ok: false, reason: '此行程已有費用紀錄，無法刪除' };
  const idx = TRIPS.findIndex((t) => t.id === id);
  if (idx >= 0) TRIPS.splice(idx, 1);
  return { ok: true };
}

// 費用分類
const EXPENSE_CATEGORIES = [
  { key: '餐飲', icon: '🍽️' },
  { key: '交通', icon: '🚆' },
  { key: '購物', icon: '🛍️' },
  { key: '住宿', icon: '🏨' },
  { key: '票券', icon: '🎫' },
  { key: '娛樂', icon: '🎡' },
  { key: '其他', icon: '🧾' },
];
function catIconOf(key) {
  return (EXPENSE_CATEGORIES.find(c => c.key === key) || {}).icon || '🧾';
}

// 付款方式
const PAYMENT_METHODS = ['現金', '信用卡', 'IC卡', '電子支付'];

// 幣別（第一個為此行程預設幣別）
const CURRENCIES = ['JPY', 'TWD', 'USD', 'KRW', 'EUR'];

/* ---------- 假收據辨識服務 ----------
 * 介面：scan(imageDataUrl) -> Promise<ExtractedReceipt>
 * ExtractedReceipt { merchant, currency, items:[{name, qty, amount}], confidence{欄位:0~1} }
 * 本 Mock 依序輪流回傳固定樣本，模擬「拍照 → OCR → 翻譯」流程；金額欄位保留原幣別數字。
 */
const MockReceiptService = (() => {
  const SAMPLES = [
    {
      merchant: 'スターバックス',
      currency: 'JPY',
      items: [
        { name: '拿鐵咖啡（大杯）', qty: 2, amount: 1360 },
        { name: '起司蛋糕',         qty: 1, amount: 480 },
      ],
      confidence: { currency: 0.99, items: 0.86 },
    },
    {
      merchant: 'マツモトキヨシ',
      currency: 'JPY',
      items: [
        { name: '防曬乳',   qty: 1, amount: 980 },
        { name: '感冒藥',   qty: 1, amount: 1200 },
        { name: '面膜',     qty: 2, amount: 850 },
        { name: '護手霜',   qty: 1, amount: 600 },
      ],
      confidence: { currency: 0.97, items: 0.72 },
    },
    {
      merchant: 'JR東日本 みどりの窓口',
      currency: 'JPY',
      items: [
        { name: '車票（新千歲 → 札幌）', qty: 4, amount: 5280 },
      ],
      confidence: { currency: 0.99, items: 0.9 },
    },
    {
      merchant: '광장시장',
      currency: 'KRW',
      items: [
        { name: '生牛肉刺身', qty: 1, amount: 28000 },
        { name: '綠豆煎餅',   qty: 2, amount: 16000 },
        { name: '馬格利酒',   qty: 1, amount: 6000 },
      ],
      confidence: { currency: 0.95, items: 0.68 },
    },
  ];
  let idx = 0;

  function scan(/* imageDataUrl */) {
    return new Promise((resolve) => {
      setTimeout(() => {
        const s = JSON.parse(JSON.stringify(SAMPLES[idx % SAMPLES.length]));
        idx++;
        resolve(s);
      }, 1100);
    });
  }
  return { scan };
})();

/* ---------- 真實收據辨識服務（Gemini，經 Cloudflare Worker Proxy） ----------
 * proxyUrl 未填時代表尚未部署/設定 Proxy，ReceiptService 會自動退回 MockReceiptService。
 * 部署步驟見 travel-expense/proxy/README.md；proxyUrl 就是該 Worker 部署後的網址。
 */
const OCR_CONFIG = {
  proxyUrl: 'https://travel-expense-ocr-proxy.jack6349.workers.dev',
  // 與 Worker 的 APP_SECRET 相同的共用密鑰。注意：前端程式碼是公開的，這串一定看得到，
  // 它只是提高隨手濫用的門檻，不是真正的存取控制；真正的保護是 Worker 端的來源網域驗證
  // 與 Google 帳號的用量上限。
  appSecret: 'QvQzGdHexwGRxKAazuO0f6tqVmu0bJGg',
};

const RealReceiptService = (() => {
  function scan(imageDataUrl) {
    return new Promise((resolve, reject) => {
      if (!imageDataUrl) { reject(new Error('缺少照片')); return; }
      const commaIdx = imageDataUrl.indexOf(',');
      if (commaIdx < 0) { reject(new Error('照片格式錯誤')); return; }
      const meta = imageDataUrl.slice(5, commaIdx); // 例："image/jpeg;base64"
      const mimeType = meta.split(';')[0] || 'image/jpeg';
      const base64 = imageDataUrl.slice(commaIdx + 1);

      const headers = { 'Content-Type': 'application/json' };
      if (OCR_CONFIG.appSecret) headers['X-App-Secret'] = OCR_CONFIG.appSecret;

      fetch(OCR_CONFIG.proxyUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ image: base64, mimeType }),
      })
        .then((res) => {
          if (!res.ok) return res.json().then((e) => { throw new Error(e.error || ('OCR 服務錯誤 ' + res.status)); });
          return res.json();
        })
        .then((data) => {
          // 真實 API 目前不回傳逐欄位信心值，統一給中等信心值以觸發使用者核對提醒
          data.confidence = { currency: 0.8, items: 0.8 };
          resolve(data);
        })
        .catch(reject);
    });
  }
  return { scan };
})();

// 統一收據辨識入口：已設定 OCR_CONFIG.proxyUrl 就打真的 Gemini API，否則退回假資料
const ReceiptService = {
  scan(imageDataUrl) {
    if (OCR_CONFIG.proxyUrl) return RealReceiptService.scan(imageDataUrl);
    console.warn('[travel-expense] 尚未設定 OCR_CONFIG.proxyUrl，目前為假資料辨識（Mock）。部署步驟見 travel-expense/proxy/README.md');
    return MockReceiptService.scan(imageDataUrl);
  },
};

/* ---------- 費用假資料（記憶體內，reload 即重置） ---------- */
let EXPENSES = [
  {
    id: 'e1', tripId: 't-jp', category: '交通', note: '機場巴士', amount: 1100, currency: 'JPY',
    payMethod: '現金', payer: 'jack', split: ['jack', 'meimei', 'ershao', 'mi'], date: '2026-06-05',
  },
  {
    id: 'e2', tripId: 't-jp', category: '餐飲', note: '午餐 拉麵', amount: 4200, currency: 'JPY',
    payMethod: '現金', payer: 'ershao', split: ['jack', 'meimei', 'ershao', 'mi'], date: '2026-06-05',
  },
  {
    id: 'e3', tripId: 't-jp', category: '購物', note: '藥妝店', amount: 3630, currency: 'JPY',
    payMethod: '信用卡', payer: 'mi', split: ['mi', 'meimei'], date: '2026-06-06',
    items: [
      { name: '防曬乳', qty: 1, amount: 980, split: ['mi'] },
      { name: '感冒藥', qty: 1, amount: 1200, split: ['mi', 'meimei'] },
      { name: '面膜',   qty: 2, amount: 850, split: ['meimei'] },
      { name: '護手霜', qty: 1, amount: 600, split: ['mi'] },
    ],
    fromReceipt: true,
  },
];

/* ---------- 記事（比照 travel-v2 的提醒功能） ----------
 * Note { id, tripId, text, category, date（可空＝全程）, done, owner }
 * 以 tripId 歸屬行程；date 留空代表「全程」，於按日期分組時置頂。
 */
const NOTE_CATEGORIES = ['住宿', '機票', '交通', '景點', '購物', '其他'];

let NOTES = [
  { id: 'n1', tripId: 't-jp', text: '出發前 24h 線上劃位', category: '機票', date: '2026-06-04', done: false, owner: 'jack' },
  { id: 'n2', tripId: 't-jp', text: '兌換 JR Pass',        category: '交通', date: '2026-06-05', done: false, owner: 'jack' },
  { id: 'n3', tripId: 't-jp', text: '退稅單據收好',        category: '購物', date: '2026-06-08', done: true,  owner: 'meimei' },
  { id: 'n4', tripId: 't-jp', text: '準備護照影本',        category: '其他', date: '',           done: false, owner: 'jack' },
  { id: 'n5', tripId: 't-kr', text: '訂廣藏市場周邊餐廳',  category: '景點', date: '2026-10-01', done: false, owner: 'jack' },
];

function addNote(tripId, data) {
  const n = { id: 'n-' + Date.now(), tripId, owner: ME, ...data };
  NOTES.push(n);
  return n;
}

function removeNote(id) {
  const idx = NOTES.findIndex((n) => n.id === id);
  if (idx >= 0) NOTES.splice(idx, 1);
}
