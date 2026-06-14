/* travel-v2 prototype — 假資料層
 * 注意：本 prototype 不做登入機制（第二階段才接 Firebase Auth / 多人協作 / 鎖定）。
 * 但固定假設「當前使用者 = Jack」，讓費用、提醒等畫面有固定的「我」，
 * 第二階段接登入時可直接以真實使用者替換 CURRENT_USER，介面結構不需重改。
 */

/* 全域成員通訊錄（假資料）— 帳號 + 別名（LINE 式）。
 * - account：登入唯一 Key（可省略 @gmail.com），不可變，作為所有引用的鍵。
 * - alias  ：顯示名稱，可改、需唯一；僅於渲染時查表，故改別名全站（含歷史）即時同步。
 * 「我」由當前登入帳號 CURRENT_ACCOUNT 判定（見 core.js Auth）。
 * 重要：費用 payer/split、提醒 owner、行程 members 一律存「帳號」，不存別名。
 */
let MEMBERS = [
  { account: 'jack',   alias: 'Jack', admin: true },   // 系統管理員
  { account: 'meimei', alias: '妹妹' },
  { account: 'ershao', alias: '二少' },
  { account: 'mi',     alias: '咪' },
];
const CURRENT_ACCOUNT = 'jack';   // 本階段固定登入帳號（第二階段由 Auth 取代）

// 是否為系統管理員帳號（系統管理設定僅管理員可見）
function isAdminAccount(account) {
  const m = MEMBERS.find(x => x.account === account);
  return !!(m && m.admin);
}

// 帳號 → 別名（查無則退回顯示帳號本身）
function aliasOf(account) {
  const m = MEMBERS.find(x => x.account === account);
  return m ? m.alias : account;
}
// 別名是否已存在（可排除某帳號自己，用於改別名）
function aliasExists(alias, exceptAccount) {
  return MEMBERS.some(m => m.account !== exceptAccount && m.alias === alias);
}
function accountExists(account) {
  return MEMBERS.some(m => m.account === account);
}

// 成員是否已被引用（行程成員 / 費用付款人或分攤 / 提醒建立者）→ 用於刪除保護。以帳號比對。
function memberInUse(account) {
  for (const t of TRIPS) {
    if (t.members.includes(account)) return '行程成員';
    const exp = EXPENSES[t.id] || {};
    for (const d of Object.keys(exp)) {
      for (const e of exp[d]) {
        if (e.payer === account || (e.split || []).includes(account)) return '費用';
      }
    }
    for (const r of (REMINDERS[t.id] || [])) {
      if (r.owner === account) return '提醒';
    }
  }
  return null;
}

// 站點間交通方式（班表庫匯入/手動輸入皆用此集合）
const TRANSPORT_MODES = {
  shinkansen: { icon: '🚄', label: '新幹線' },
  train:      { icon: '🚆', label: '列車' },
  bus:        { icon: '🚌', label: '巴士' },
  localbus:   { icon: '🚏', label: '公車' },
  tram:       { icon: '🚊', label: '路面電車' },
  walk:       { icon: '🚶', label: '步行' },
  taxi:       { icon: '🚕', label: 'Taxi' },
  shuttle:    { icon: '🚐', label: '接送/專車' },
  ferry:      { icon: '⛴️', label: '客船' },
  other:      { icon: '🚙', label: '其他' },
};

// 站點型別
const STATION_TYPES = {
  spot:      { label: '景點',     icon: '📍' },
  station:   { label: '車站',     icon: '🚉' },
  airport:   { label: '機場',     icon: '✈️' },
  hotel:     { label: '旅館',     icon: '🏨' },
  overnight: { label: '跨日交通', icon: '🌙' },
};

// 幣別
const CURRENCIES = ['JPY', 'TWD', 'USD', 'KRW', 'EUR'];

// 假地點清單（prototype：模擬 Google Places Autocomplete 的建議來源）。
// 真實版改接 Places API；display=顯示候選、mapName=標準名、placeId/lat/lng=語言無關識別。
const MOCK_PLACES = [
  { display: '白色戀人公園',   mapName: '白い恋人パーク',                 placeId: 'ChIJ_shiroikoibito', lat: 43.0908, lng: 141.2865 },
  { display: '小樽運河',       mapName: '小樽運河',                       placeId: 'ChIJ_otaru_canal',   lat: 43.1979, lng: 140.9947 },
  { display: '札幌格蘭飯店',   mapName: '札幌グランドホテル',             placeId: 'ChIJ_sapporo_grand', lat: 43.0686, lng: 141.3503 },
  { display: '新千歲機場',     mapName: '新千歳空港',                     placeId: 'ChIJ_cts_airport',   lat: 42.7752, lng: 141.6923 },
  { display: '二条市場',       mapName: '二条市場',                       placeId: 'ChIJ_nijo_market',   lat: 43.0588, lng: 141.3556 },
  { display: '大通公園',       mapName: '大通公園',                       placeId: 'ChIJ_odori_park',    lat: 43.0606, lng: 141.3469 },
  { display: '富良野薰衣草田', mapName: 'ファーム富田',                   placeId: 'ChIJ_farm_tomita',   lat: 43.4216, lng: 142.4170 },
  { display: '道頓堀',         mapName: '道頓堀',                         placeId: 'ChIJ_dotonbori',     lat: 34.6687, lng: 135.5013 },
  { display: '環球影城',       mapName: 'ユニバーサル・スタジオ・ジャパン', placeId: 'ChIJ_usj',           lat: 34.6654, lng: 135.4323 },
  { display: '廣藏市場',       mapName: '광장시장',                       placeId: 'ChIJ_gwangjang',     lat: 37.5701, lng: 126.9999 },
];

// 費用分類（前 4 為預設前排卡片；其餘收「更多」下拉。實際前排順序由 UsageStats 依點擊頻率動態決定）
const EXPENSE_CATEGORIES = [
  { key: '購物', icon: '🛍️' },
  { key: '餐飲', icon: '🍽️' },
  { key: '交通', icon: '🚆' },
  { key: '住宿', icon: '🏨' },
  { key: '票券', icon: '🎫' },
  { key: '娛樂', icon: '🎡' },
  { key: '其他', icon: '🧾' },
];

// 付款方式（4 種，依點擊頻率動態排序，單行顯示）
const PAYMENT_METHODS = ['現金', '信用卡', 'IC卡', '電子支付'];

/* 行程假資料。
 * 以「今天 = 2026-06-07」為基準，刻意涵蓋三種狀態以驗證 P0 判定與 P3 當日高亮：
 *  - t-jp   進行中（今天落在區間內）
 *  - t-kr   規劃中（未來）
 *  - t-osk  已結束（過去）
 */
const TRIPS = [
  {
    id: 't-jp',
    name: '2026 北海道初夏',
    start: '2026-06-05',
    end: '2026-06-09',
    members: ['jack', 'meimei', 'ershao', 'mi'],
    roles: { jack: 'owner', meimei: 'editor', ershao: 'editor', mi: 'viewer' },
    currency: 'JPY',
    // 各日站點（D1..Dn）。idx 越小越早。
    days: {
      1: [
        { id: 's1', type: 'airport', name: '新千歲機場', leg: 'arrive', arrive: '10:30', depart: '11:10', note: '去程抵達' },
        // place：地圖解析欄位（語言無關）。顯示名 name 可任意語言；開圖用 place.placeId/座標，不用 name。
        { id: 's2', type: 'spot', name: '白色戀人公園', arrive: '13:00', depart: '15:00',
          place: { mapName: '白い恋人パーク', placeId: 'ChIJexample_shiroikoibito', lat: 43.0908, lng: 141.2865 } },
        { id: 's3', type: 'hotel', name: '札幌格蘭飯店', stay: 'in', note: 'Check-In' },
      ],
      2: [
        { id: 's4', type: 'hotel', name: '札幌格蘭飯店', stay: 'mid', note: 'Stay2' },
        { id: 's5', type: 'spot', name: '小樽運河', arrive: '10:00', depart: '14:00' },
        { id: 's6', type: 'station', name: '小樽站', arrive: '14:30', depart: '15:05' },
      ],
      3: [
        { id: 's7', type: 'hotel', name: '札幌格蘭飯店', stay: 'out', note: 'Check-Out' },
        { id: 's8', type: 'spot', name: '富良野薰衣草田', arrive: '12:00', depart: '16:00' },
      ],
      4: [],
      5: [
        { id: 's9', type: 'airport', name: '新千歲機場', leg: 'depart', arrive: '17:00', depart: '19:25', note: '回程出發' },
      ],
    },
    // 尚未排入時間軸的站點（左側規劃區）
    pool: [
      { id: 'p1', type: 'spot', name: '二条市場', arrive: '', depart: '' },
      { id: 'p2', type: 'spot', name: '大通公園', arrive: '', depart: '' },
      { id: 'p3', type: 'overnight', name: '夜行巴士 札幌→旭川', arrive: '', depart: '', note: '跨日' },
    ],
    // 站點間交通段（key = 起站id__訖站id）。範例：D2 小樽運河 → 小樽站，已選定一個候選＋備用一個。
    legs: {
      's5__s6': {
        bufferMinutes: 5,
        selectedId: 'c-demo-1',
        candidates: [
          { id: 'c-demo-1', mode: 'walk', source: 'manual', fromTime: '14:00', toTime: '14:25', note: '步行往小樽站', transfers: [] },
          { id: 'c-demo-2', mode: 'taxi', source: 'manual', fromTime: '14:00', toTime: '14:10', note: '備用：搭計程車', transfers: [] },
        ],
      },
    },
  },
  {
    id: 't-kr',
    name: '2026 秋首爾美食',
    start: '2026-10-12',
    end: '2026-10-16',
    members: ['jack', 'meimei'],
    roles: { jack: 'owner', meimei: 'editor' },
    currency: 'KRW',
    days: { 1: [], 2: [], 3: [], 4: [], 5: [] },
    pool: [
      { id: 'p4', type: 'airport', name: '仁川機場', leg: 'arrive', arrive: '', depart: '' },
      { id: 'p5', type: 'spot', name: '廣藏市場', arrive: '', depart: '' },
      { id: 'p6', type: 'hotel', name: '明洞 L7 飯店', stay: 'in', note: 'Check-In' },
    ],
  },
  {
    id: 't-osk',
    name: '2025 大阪跨年',
    start: '2025-12-29',
    end: '2026-01-02',
    members: ['jack', 'meimei', 'ershao', 'mi'],
    roles: { jack: 'owner', meimei: 'editor', ershao: 'editor', mi: 'editor' },
    currency: 'JPY',
    days: {
      1: [ { id: 's20', type: 'spot', name: '道頓堀', arrive: '18:00', depart: '21:00' } ],
      2: [ { id: 's21', type: 'spot', name: '環球影城', arrive: '09:00', depart: '20:00' } ],
      3: [], 4: [], 5: [],
    },
    pool: [],
  },
];

/* 費用假資料：以 tripId + day 索引。
 * 引用以帳號為鍵（payer / split）。category 為分類、note 為備註、payMethod 付款方式、currency 幣別。
 */
const EXPENSES = {
  't-jp': {
    all: [
      { id: 'e0', category: '交通', note: '來回機票', amount: 18000, currency: 'TWD', payMethod: '信用卡', payer: 'jack', split: ['jack', 'meimei', 'ershao', 'mi'] },
    ],
    1: [
      { id: 'e1', category: '交通', note: '機場巴士', amount: 1100, currency: 'JPY', payMethod: '現金',   payer: 'jack',   split: ['jack', 'meimei', 'ershao', 'mi'] },
      { id: 'e2', category: '餐飲', note: '午餐 拉麵', amount: 4200, currency: 'JPY', payMethod: '現金',   payer: 'ershao', split: ['jack', 'meimei', 'ershao', 'mi'] },
    ],
    2: [
      { id: 'e3', category: '餐飲', note: '小樽甜點', amount: 2600, currency: 'JPY', payMethod: '信用卡', payer: 'mi',     split: ['jack', 'meimei', 'mi'] },
    ],
    3: [], 4: [], 5: [],
  },
  't-kr': { 1: [], 2: [], 3: [], 4: [], 5: [] },
  't-osk': {
    1: [ { id: 'e10', category: '餐飲', note: '居酒屋', amount: 12000, currency: 'JPY', payMethod: '現金', payer: 'jack', split: ['jack', 'meimei', 'ershao', 'mi'] } ],
    2: [], 3: [], 4: [], 5: [],
  },
};

// 文件類別
const DOCUMENT_CATEGORIES = ['機票', '住宿', '交通', '門票', '購物', '其他'];

// 文件假資料（P5）。date 可空（空=全程）；category 為類別。
const DOCUMENTS = {
  't-jp': [
    { id: 'd1', name: '電子機票 (去程).pdf',      category: '機票', date: '2026-06-05', size: '218 KB' },
    { id: 'd2', name: '札幌格蘭飯店訂房確認.pdf', category: '住宿', date: '2026-06-05', size: '96 KB' },
    { id: 'd3', name: 'JR Pass 兌換券.png',        category: '交通', date: '',           size: '1.2 MB' },
  ],
  't-kr': [],
  't-osk': [ { id: 'd9', name: '環球影城電子票.pdf', category: '門票', date: '2025-12-30', size: '140 KB' } ],
};

// 旅遊照片紀錄假資料（P4）。以拍攝 datetime 分組（相簿式）。prototype 用 emoji 佔位。
const PHOTOS = {
  't-jp': [
    { id: 'ph1', datetime: '2026-06-05T10:32', caption: '新千歲機場',     emoji: '✈️' },
    { id: 'ph2', datetime: '2026-06-05T13:20', caption: '白色戀人公園',   emoji: '🍫' },
    { id: 'ph3', datetime: '2026-06-05T20:10', caption: '札幌夜景',       emoji: '🌃' },
    { id: 'ph4', datetime: '2026-06-06T10:05', caption: '小樽運河',       emoji: '🛶' },
    { id: 'ph5', datetime: '2026-06-06T15:40', caption: '小樽甜點',       emoji: '🍰' },
    { id: 'ph6', datetime: '2026-06-07T12:15', caption: '富良野薰衣草田', emoji: '💜' },
  ],
  't-kr': [],
  't-osk': [
    { id: 'ph9',  datetime: '2025-12-29T18:30', caption: '道頓堀',   emoji: '🌃' },
    { id: 'ph10', datetime: '2025-12-30T09:15', caption: '環球影城', emoji: '🎢' },
  ],
};

// 提醒類別
const REMINDER_CATEGORIES = ['住宿', '機票', '交通', '景點', '購物', '其他'];

// 提醒假資料（P6）。date 可空（空=全程）；done=完成/待辦。
const REMINDERS = {
  't-jp': [
    { id: 'r1', text: '出發前 24h 線上劃位', category: '機票', date: '2026-06-04', done: false, owner: 'jack' },
    { id: 'r2', text: '兌換 JR Pass',        category: '交通', date: '2026-06-05', done: false, owner: 'jack' },
    { id: 'r3', text: '退稅單據收好',        category: '購物', date: '2026-06-08', done: true,  owner: 'meimei' },
    { id: 'r7', text: '準備護照影本',        category: '其他', date: '',           done: false, owner: 'jack' },
  ],
  't-kr': [
    { id: 'r4', text: '訂廣藏市場周邊餐廳', category: '景點', date: '2026-10-01', done: false, owner: 'jack' },
  ],
  't-osk': [],
};

/* 班表庫（全域共用，不分行程／不分日期）。
 * 由「貼上時刻表 JSON」匯入後攤平而成：一個 route（含可能的轉乘）= 一筆 entry。
 * key 用於匯入時判斷「同一班次」以覆蓋更新（最後匯入為準），不重複累積。
 * raw 保留原始 route 物件，避免不同時刻表格式欄位遺漏。
 */
function timetableKey(e) {
  return [e.line, e.train, e.fromStation, e.toStation, e.fromTime].join('|');
}
const MOCK_TIMETABLE_LIB = [
  {
    id: 'tt1', mode: 'shinkansen', line: 'JR東北新幹線', train: 'はやぶさ5号',
    fromStation: '盛岡', fromTime: '10:29', toStation: '洞爺', toTime: '14:09',
    transfers: [
      { line: 'JR東北新幹線', train: 'はやぶさ5号', fromStation: '盛岡', fromTime: '10:29', toStation: '新函館北斗', toTime: '12:15' },
      { line: 'JR函館本線・室蘭本線', train: '特急北斗11号', fromStation: '新函館北斗', fromTime: '12:33', toStation: '洞爺', toTime: '14:09' },
    ],
    fare: { ticket_yen: 18440, ic_yen: -1 },
  },
  {
    id: 'tt2', mode: 'shinkansen', line: 'JR東北新幹線', train: 'はやぶさ11号',
    fromStation: '盛岡', fromTime: '11:47', toStation: '洞爺', toTime: '15:29',
    transfers: [
      { line: 'JR東北新幹線', train: 'はやぶさ11号', fromStation: '盛岡', fromTime: '11:47', toStation: '新函館北斗', toTime: '13:33' },
      { line: 'JR函館本線・室蘭本線', train: '特急北斗13号', fromStation: '新函館北斗', fromTime: '13:50', toStation: '洞爺', toTime: '15:29' },
    ],
    fare: { ticket_yen: 18440, ic_yen: -1 },
  },
  {
    id: 'tt3', mode: 'shinkansen', line: 'JR東北新幹線', train: 'はやぶさ17号',
    fromStation: '盛岡', fromTime: '13:05', toStation: '洞爺', toTime: '16:53',
    transfers: [
      { line: 'JR東北新幹線', train: 'はやぶさ17号', fromStation: '盛岡', fromTime: '13:05', toStation: '新函館北斗', toTime: '15:01' },
      { line: 'JR函館本線・室蘭本線', train: '特急北斗15号', fromStation: '新函館北斗', fromTime: '15:20', toStation: '洞爺', toTime: '16:53' },
    ],
    fare: { ticket_yen: 18440, ic_yen: -1 },
  },
  {
    id: 'tt4', mode: 'bus', line: '北海道中央巴士', train: '小樽-札幌線',
    fromStation: '小樽站', fromTime: '15:10', toStation: '札幌站', toTime: '16:05',
    transfers: [], fare: { ticket_yen: 680, ic_yen: 680 },
  },
];

/* 站點別名對照表（全域）。canonical = AI 轉換後常用的繁中/原文站名；
 * aliases = 其他語系/寫法（含 Google Maps 解析名稱），比對時雙方正規化後查此表。
 * 可手動 CRUD（修正 AI 翻譯偏差）。
 */
const MOCK_STATION_ALIAS = [
  { canonical: '札幌', aliases: ['Sapporo', 'さっぽろ', '札幌駅', 'Sapporo Station'] },
  { canonical: '小樽', aliases: ['Otaru', 'おたる', '小樽駅', 'Otaru Station'] },
  { canonical: '新千歳空港', aliases: ['新千歲機場', 'New Chitose Airport', 'CTS'] },
];

// 計算行程天數
function tripDayCount(trip) {
  const s = new Date(trip.start + 'T00:00:00');
  const e = new Date(trip.end + 'T00:00:00');
  return Math.round((e - s) / 86400000) + 1;
}
