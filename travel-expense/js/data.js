/* travel-expense — 資料層。
 * 下方陣列為初始種子資料；實際執行時會由 Firestore 即時同步覆蓋（見 Sync），
 * 離線或尚未登入時則沿用 localStorage 的本機快取（見 Store）。
 * 欄位命名沿用 travel-v2 的費用模型（category/note/amount/currency/payMethod/payer/split/items），
 * 以利之後銜接正式資料結構；items 另加 qty（數量）供本 App 使用。
 */

/* 隨行人員。account 為唯一鍵（所有引用都存 account，不存別名），
 * alias 為顯示名稱，email 用來對應 Google 登入身分（比照 travel-v2）。
 */
const MEMBERS = [
  { account: 'jack',   alias: 'Jack', email: 'jack6349@gmail.com' },
  { account: 'meimei', alias: '妹妹', email: '' },
  { account: 'ershao', alias: '二少', email: '' },
  { account: 'mi',     alias: '咪',   email: '' },
];

/* 「我」是誰：由登入的 Google 帳號 email 對應到 MEMBERS 決定（見 app.js 的 Auth）。
 * 未登入時為 null，此時畫面上不會標記任何人為「我」。
 */
let ME = null;
function setMe(account) { ME = account; }

// 依 email 找對應成員帳號，找不到回傳 null（代表此信箱未登錄在成員名單中）
function accountByEmail(email) {
  if (!email) return null;
  const m = MEMBERS.find((x) => x.email && x.email.toLowerCase() === email.toLowerCase());
  return m ? m.account : null;
}

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
  const m = { account: newId('m'), alias, email: '' };
  MEMBERS.push(m);
  Store.save();
  Sync.putMember(m);
  return m;
}

// 改別名
function renameMember(account, alias, email) {
  const m = MEMBERS.find((x) => x.account === account);
  if (!m) return;
  m.alias = alias;
  if (email !== undefined) m.email = email;
  Store.save();
  Sync.putMember(m);
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
  Store.save();
  Sync.delMember(account);
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
  const t = { id: newId('t'), name: data.name, start: data.start, end: data.end, currency: data.currency, members: data.members };
  TRIPS.push(t);
  Store.save();
  Sync.putTrip(t);
  return t;
}

// 編輯行程
function updateTrip(id, data) {
  const t = tripById(id);
  if (!t) return;
  Object.assign(t, data);
  Store.save();
  Sync.putTrip(t);
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
  Store.save();
  Sync.delTrip(id);
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
  const n = { id: newId('n'), tripId, owner: ME || '', ...data };
  NOTES.push(n);
  Store.save();
  Sync.putNote(n);
  return n;
}

// 刪除費用
function removeExpense(id) {
  const idx = EXPENSES.findIndex((e) => e.id === id);
  if (idx >= 0) EXPENSES.splice(idx, 1);
  Store.save();
  Sync.delExpense(id);
}

function removeNote(id) {
  const idx = NOTES.findIndex((n) => n.id === id);
  if (idx >= 0) NOTES.splice(idx, 1);
  Store.save();
  Sync.delNote(id);
}

/* ---------- 本機快取（localStorage） ----------
 * 作為離線／未登入時的暫存。登入後以 Firestore 為準（見 Sync），
 * 每次收到雲端更新也會回寫此快取，讓下次開啟能立即顯示上次的內容。
 */

// 上方種子資料的乾淨副本，供首次初始化雲端與「重設」還原用（須在任何載入/異動之前取得）
const SEED = JSON.parse(JSON.stringify({ members: MEMBERS, trips: TRIPS, expenses: EXPENSES, notes: NOTES }));

/* 產生唯一 id。加上隨機碼，避免兩台裝置在同一毫秒新增時撞號
 * （只用 Date.now() 在多人同時記帳的情境下會互相覆蓋）。
 */
function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

// 就地換掉陣列內容（MEMBERS/TRIPS 為 const，不能重新指派，只能改內容）
function replaceArray(target, src) {
  target.length = 0;
  if (Array.isArray(src)) src.forEach((x) => target.push(x));
}

const Store = {
  KEY: 'tex-data',
  VERSION: 1,
  prefs: { currentTripId: null }, // 目前行程等偏好，一併記住

  save() {
    try {
      localStorage.setItem(this.KEY, JSON.stringify({
        version: this.VERSION,
        members: MEMBERS,
        trips: TRIPS,
        expenses: EXPENSES,
        notes: NOTES,
        prefs: this.prefs,
      }));
    } catch (e) {
      // 無痕模式或空間已滿：略過存檔，不讓 App 掛掉
      console.warn('[travel-expense] 存檔失敗，本次變更不會保留：', e.message);
    }
  },

  // 回傳是否成功載入既有存檔；失敗一律沿用假資料
  load() {
    let raw;
    try { raw = localStorage.getItem(this.KEY); } catch (e) { return false; }
    if (!raw) return false;
    let data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    // 版本不符（資料結構已改）或行程為空，都退回假資料，避免載入壞掉的舊格式
    if (!data || data.version !== this.VERSION) return false;
    if (!Array.isArray(data.trips) || !data.trips.length) return false;

    replaceArray(MEMBERS, data.members);
    replaceArray(TRIPS, data.trips);
    replaceArray(EXPENSES, data.expenses);
    replaceArray(NOTES, data.notes);
    if (data.prefs && typeof data.prefs === 'object') this.prefs = data.prefs;
    return true;
  },

  // 這個瀏覽器能不能用 localStorage（無痕模式、空間已滿時為 false）
  available() {
    try {
      const probe = this.KEY + '-probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  },

  // 清空本機快取並把資料還原成種子資料（不影響雲端）
  reset() {
    try { localStorage.removeItem(this.KEY); } catch (e) {}
    const seed = JSON.parse(JSON.stringify(SEED));
    replaceArray(MEMBERS, seed.members);
    replaceArray(TRIPS, seed.trips);
    replaceArray(EXPENSES, seed.expenses);
    replaceArray(NOTES, seed.notes);
    this.prefs = { currentTripId: null };
  },
};

Store.load();

/* ---------- 雲端同步（Firestore） ----------
 * 以「每筆資料一份文件」寫入，而非整包覆蓋，這樣兩台裝置同時記帳不會互相蓋掉。
 * 讀取用 onSnapshot 即時訂閱，任一裝置的異動會立即推送到其他裝置。
 * 未登入或 Firebase 尚未就緒時 enabled=false，所有寫入呼叫直接略過（僅走本機快取）。
 */
const COL = {
  members: 'TravelExpense_members',
  trips: 'TravelExpense_trips',
  expenses: 'TravelExpense_expenses',
  notes: 'TravelExpense_notes',
};

const Sync = {
  enabled: false,
  unsubs: [],
  onChange: null,   // 收到雲端更新時通知 app.js 重繪
  onError: null,    // 權限不足等錯誤時通知 app.js
  _seeded: false,

  // 等待 firebase-init.js（deferred module）就緒
  waitForFB(timeoutMs = 5000) {
    if (window.FB) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(!!window.FB), timeoutMs);
      window.addEventListener('fb-ready', () => { clearTimeout(timer); resolve(true); }, { once: true });
    });
  },

  // 登入成功後由 app.js 呼叫，開始即時訂閱四個 collection
  async start(onChange, onError) {
    this.onChange = onChange;
    this.onError = onError;
    await this.waitForFB();
    if (!window.FB) { console.warn('[travel-expense] Firebase 未就緒，僅使用本機資料'); return false; }

    const F = window.FB;
    this.stop();
    this.enabled = true;

    const subscribe = (colName, targetArray, afterFirst) => {
      const unsub = F.onSnapshot(
        F.collection(F.db, colName),
        (snap) => {
          replaceArray(targetArray, snap.docs.map((d) => ({ id: d.id, ...d.data() })));
          if (afterFirst) afterFirst(snap);
          Store.save();           // 回寫本機快取，供離線/下次開啟使用
          if (this.onChange) this.onChange();
        },
        (err) => {
          console.warn('[travel-expense] 同步失敗（' + colName + '）：', err.code);
          if (this.onError) this.onError(err);
        }
      );
      this.unsubs.push(unsub);
    };

    // 成員以 account 當文件 id，故讀回時要把 id 映射回 account
    const unsubMembers = F.onSnapshot(
      F.collection(F.db, COL.members),
      (snap) => {
        replaceArray(MEMBERS, snap.docs.map((d) => ({ account: d.id, ...d.data() })));
        Store.save();
        if (this.onChange) this.onChange();
      },
      (err) => {
        console.warn('[travel-expense] 同步失敗（members）：', err.code);
        if (this.onError) this.onError(err);
      }
    );
    this.unsubs.push(unsubMembers);

    // 首次使用（雲端還沒有任何行程）時，把種子資料寫上去，避免 App 開起來是空的
    subscribe(COL.trips, TRIPS, (snap) => {
      if (!this._seeded && snap.empty && !snap.metadata.fromCache) {
        this._seeded = true;
        this.seedCloud();
      }
    });
    subscribe(COL.expenses, EXPENSES);
    subscribe(COL.notes, NOTES);
    return true;
  },

  stop() {
    this.unsubs.forEach((u) => { try { u(); } catch (e) {} });
    this.unsubs = [];
    this.enabled = false;
  },

  // 把種子資料寫進雲端（僅在雲端完全沒有行程時執行一次）
  seedCloud() {
    const seed = JSON.parse(JSON.stringify(SEED));
    seed.members.forEach((m) => this.putMember(m));
    seed.trips.forEach((t) => this.putTrip(t));
    seed.expenses.forEach((e) => this.putExpense(e));
    seed.notes.forEach((n) => this.putNote(n));
    console.log('[travel-expense] 雲端無資料，已寫入初始種子資料');
  },

  // 寫入單筆文件；未啟用時直接略過。錯誤只記錄不中斷操作（本機仍會顯示）
  _put(colName, id, data) {
    if (!this.enabled || !window.FB) return;
    const F = window.FB;
    // Firestore 不接受 undefined（例如簡單模式費用的 items、非收據來源的 fromReceipt），須先剔除
    const clean = {};
    Object.keys(data).forEach((k) => { if (data[k] !== undefined) clean[k] = data[k]; });
    F.setDoc(F.doc(F.db, colName, id), clean)
      .catch((e) => console.warn('[travel-expense] 寫入失敗（' + colName + '）：', e.code));
  },

  _del(colName, id) {
    if (!this.enabled || !window.FB) return;
    const F = window.FB;
    F.deleteDoc(F.doc(F.db, colName, id))
      .catch((e) => console.warn('[travel-expense] 刪除失敗（' + colName + '）：', e.code));
  },

  // account 當文件 id，故資料本身不重複存 account
  putMember(m) { const { account, ...rest } = m; this._put(COL.members, account, rest); },
  delMember(account) { this._del(COL.members, account); },

  putTrip(t) { const { id, ...rest } = t; this._put(COL.trips, id, rest); },
  delTrip(id) { this._del(COL.trips, id); },

  putExpense(e) { const { id, ...rest } = e; this._put(COL.expenses, id, rest); },
  delExpense(id) { this._del(COL.expenses, id); },

  putNote(n) { const { id, ...rest } = n; this._put(COL.notes, id, rest); },
  delNote(id) { this._del(COL.notes, id); },
};
