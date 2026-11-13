// 股利總管 Web — 提醒（盤中與夜盤的自動提示）
//
// 它跟記事（notes.js）的分工：記事是手動寫、可編輯、不自動觸發；
// 提醒是自動判斷、唯讀、不可編輯。兩邊都能設條件就會不知道該信哪個，
// 所以價格門檻只留在停損停利那一頁設定，這裡只負責把觸發的結果送到看得見的地方。
//
// 兩個數字是不同的東西，不要混：
//   按鈕上的數字 ＝ 現在成立的條件數（此刻為真的有幾條）
//   清單裡的紀錄 ＝ 只在「從未觸發變成觸發」那一刻寫一次，附日期，兩日前的自動刪掉
// 常駐成立的條件（交割款、流量）每次輪詢都為真，若也記進清單會把它洗滿，
// 所以清單只收轉換事件，常駐狀態靠按鈕數字與清單上方的現況區表示。
//
// 門檻一律從資料算，不寫死：
//   夜盤與費半的「大跌／大漲」取自己兩年日報酬分布的 p5／p95（實測見 _rmQ 的註解）
//   流量用當場量到的消耗速率外推到收盤，不是拍一個百分比
// 只有兩個是人訂的時間參數，而且它們是版面選擇不是統計主張：
//   收盤前幾分鐘開始提醒未成交委託（RM_ROD_MIN），紀錄保留幾天（RM_KEEP_DAYS）。

var RM_LOG_LS = 'remind_log_v1';
var RM_SEEN_LS = 'remind_state_v1';
var RM_ROD_MIN = 30;        // 收盤前幾分鐘開始提醒未成交的 ROD 委託
var RM_KEEP_DAYS = 2;       // 兩日前的紀錄刪掉（今天與昨天留著）
var RM_TICK_DAY = 30000;    // 盤中輪詢
var RM_TICK_NIGHT = 60000;  // 夜間輪詢（夜盤與費半）
var RM_SLOW = 300000;       // 交割款與流量：變動慢，五分鐘一次

var _rmLog = null, _rmState = null, _rmNow = [], _rmTimer = null, _rmSlowAt = 0;
var _rmSettle = null, _rmUsage = null, _rmUsageSeen = [];
var _rmOpen = false, _rmBusy = false;

// ── 儲存 ──
function _rmLoadLog() {
  if (_rmLog) return _rmLog;
  try { _rmLog = JSON.parse(localStorage.getItem(RM_LOG_LS)) || []; } catch (e) { _rmLog = []; }
  return _rmLog;
}
function _rmSaveLog() { try { localStorage.setItem(RM_LOG_LS, JSON.stringify(_rmLog || [])); } catch (e) {} }
function _rmLoadState() {
  if (_rmState) return _rmState;
  try { _rmState = JSON.parse(localStorage.getItem(RM_SEEN_LS)) || {}; } catch (e) { _rmState = {}; }
  return _rmState;
}
function _rmSaveState() { try { localStorage.setItem(RM_SEEN_LS, JSON.stringify(_rmState || {})); } catch (e) {} }

function _rmTw() { return new Date(Date.now() + 8 * 3600000); }
function _rmIso(d) {
  d = d || _rmTw();
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
function _rmHm(d) {
  d = d || _rmTw();
  return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
}
function _rmMin() { var d = _rmTw(); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function _rmDow() { return _rmTw().getUTCDay(); }
function _rmWeekday() { var w = _rmDow(); return w >= 1 && w <= 5; }
// 台股日盤 09:00–13:30。非交易日只靠星期判斷，國定假日會誤判成盤中，
// 但誤判的後果只是多輪詢幾次、條件一條都不會成立，不值得為它多抓一份行事曆。
function _rmDaySession() { var m = _rmMin(); return _rmWeekday() && m >= 540 && m <= 810; }
// 夜盤 15:00–次日 05:00
function _rmNightSession() { var m = _rmMin(); return (m >= 900 || m <= 300); }

// 分位：給一串歷史值，回傳第 p 百分位
function _rmQ(arr, p) {
  var a = (arr || []).filter(function (v) { return typeof v === 'number' && isFinite(v); })
    .sort(function (x, y) { return x - y; });
  if (a.length < 100) return null;     // 樣本不足就不下判斷，寧可這一條不說話
  return a[Math.max(0, Math.min(a.length - 1, Math.floor(a.length * p)))];
}

// ── 紀錄：只在 false → true 那一刻寫一次 ──
function _rmFire(list) {
  var st = _rmLoadState(), log = _rmLoadLog(), day = _rmIso(), changed = false;
  var on = {};
  list.forEach(function (c) { on[c.id] = 1; });
  list.forEach(function (c) {
    if (st[c.id]) return;              // 已經是觸發狀態，不重複記
    st[c.id] = 1;
    log.unshift({ id: c.id, d: day, t: _rmHm(), k: c.k, s: c.s, w: c.w || '' });
    changed = true;
  });
  // 條件不再成立就解除武裝，下次再成立才算新的一次
  Object.keys(st).forEach(function (k) { if (!on[k]) { delete st[k]; changed = true; } });
  // 兩日前的刪掉
  var cut = _rmIso(new Date(_rmTw().getTime() - RM_KEEP_DAYS * 86400000));
  var kept = log.filter(function (r) { return r.d > cut; });
  if (kept.length !== log.length) { _rmLog = kept; changed = true; } else { _rmLog = log; }
  if (changed) { _rmSaveState(); _rmSaveLog(); }
}

// ═════ 條件 ═════

// 一、ROD 委託到收盤還沒成交
// ROD 當日有效，收盤即失效，沒有隔夜未成交單。漏掉就是整張單作廢。
async function _rmCondRod() {
  if (!_rmDaySession() || typeof fetchOrderTrades !== 'function') return [];
  var left = 810 - _rmMin();
  if (left > RM_ROD_MIN) return [];
  var trades = [];
  try { trades = (await fetchOrderTrades()) || []; } catch (e) { hush('remind', e); return []; }
  var pend = [];
  trades.forEach(function (t) {
    var o = t.order || {}, s = t.status || {};
    var q = o.quantity || 0, done = s.deal_quantity || 0, can = s.cancel_quantity || 0;
    var rest = q - done - can;
    if (rest <= 0) return;
    if (/Cancelled|Failed|Inactive/i.test(s.status || '')) return;
    var c = (t.contract && (t.contract.code || t.contract.id)) || o.code || '';
    pend.push({ code: c, rest: rest, px: o.price, act: o.action });
  });
  if (!pend.length) return [];
  return [{
    id: 'rod|' + _rmIso(),
    k: 'rod', lv: 2,
    s: '還有 ' + pend.length + ' 筆委託沒成交，收盤剩 ' + left + ' 分鐘',
    w: pend.map(function (p) {
      return p.code + ' ' + (p.act === 'Sell' ? '賣' : '買') + ' ' + p.rest + ' 張 @ ' + p.px;
    }).join('；') + '｜ROD 當日有效，收盤即失效'
  }];
}

// 二、交割款到期
// account_balance 回 0 並附「非信用銀行帳戶」，銀行餘額抓不到，
// 所以這條只報應付金額與日期，不判斷夠不夠。
async function _rmCondSettle() {
  if (!_rmSettle) return [];
  var out = [];
  _rmSettle.forEach(function (r) {
    if (!(r.amount < 0)) return;
    var bal = (typeof abBalAt === 'function') ? abBalAt(_rmSettle, r.date, { divs: false }) : null;
    out.push({
      id: 'settle|' + r.date, k: 'settle', lv: r.T <= 1 ? 2 : 1,
      s: r.date + ' 要付 ' + Math.abs(r.amount).toLocaleString('zh-TW') + ' 元（T+' + r.T + '）',
      w: bal == null
        ? '券商交割款。總覽「部位與配置」填了帳戶餘額之後，這裡會直接說那天帳上剩多少'
        : '券商交割款。那天扣完帳上預估剩 ' + Math.round(bal).toLocaleString('zh-TW') + ' 元（不含配息）'
    });
  });
  // 帳上不夠：任何一個未來的日期餘額轉負就說話。
  // 這跟上面那條不是同一件事——上面是「要付多少」，這條是「付不出來」。
  // 沒填帳戶餘額時整條不存在，不會變成噪音。
  if (typeof abFlow === 'function' && typeof abGet === 'function' && abGet() != null) {
    // 不含配息：寧可早一點說「可能不夠」，也不要讓還沒入帳的錢把警告壓下去
    var f = abFlow(_rmSettle, { divs: false });
    var hit = null;
    f.rows.forEach(function (x) { if (hit == null && x.bal != null && x.bal < 0) hit = x; });
    if (hit) {
      out.push({
        id: 'short|' + hit.d, k: 'short', lv: 2,
        s: hit.d + ' 帳上不夠，差 ' + Math.abs(Math.round(hit.bal)).toLocaleString('zh-TW') + ' 元',
        w: '以帳戶餘額為起點，排完交割與預計進出之後第一個轉負的日子，不含配息入帳。'
          + '明細在交易資訊「台幣交割」'
      });
    }
  }
  return out;
}

// 三、停損停利觸發（門檻在停損停利那一頁設定，這裡只讀結果）
function _rmCondAlert() {
  if (typeof loadAlerts !== 'function' || typeof evalAlert !== 'function') return [];
  var all = loadAlerts(), out = [];
  var pos = (typeof _positions !== 'undefined' && _positions) ? _positions : [];
  pos.forEach(function (p) {
    var code = String(p.code);
    if (!all[code]) return;
    // 價格與獲利率的來源跟即時持股同一套：即時報價優先，沒有才用券商的 last_price。
    // 獲利率一定要用含息（invMetrics 的 wrate），停損停利頁的門檻就是對含息比的。
    var r0 = (typeof _rows === 'object' && _rows) ? _rows[code] : null;
    var px = (r0 && r0.close != null) ? r0.close : (p.last_price != null ? p.last_price : null);
    if (px == null) return;
    var m0 = (typeof invMetrics === 'function') ? invMetrics(p) : null;
    var pr = m0 ? m0.wrate : null;
    var hit = evalAlert(code, px, pr);
    if (!hit) return;
    out.push({
      id: 'al|' + code + '|' + hit + '|' + _rmIso(), k: 'alert', lv: 2,
      s: code + ' 觸及' + (hit === 'sell' ? '停利停損' : '買進') + '門檻，現價 ' + px,
      w: '門檻在「停損停利」頁設定'
    });
  });
  return out;
}

// 四、除息最後買進日
// 除息前一日買進才領得到，這是制度不是判斷。
function _rmCondEx() {
  // div-mix.js 載入 data/etf-div-next.json 之後放在 _dmNext
  var map = (typeof _dmNext === 'object' && _dmNext) ? _dmNext : null;
  if (!map) return [];
  var want = {};
  ((typeof _positions !== 'undefined' && _positions) ? _positions : []).forEach(function (p) { want[String(p.code)] = '持股'; });
  if (typeof _wtLoad === 'function') {
    try { (_wtLoad() || []).forEach(function (c) { if (!want[c]) want[c] = '關注'; }); } catch (e) {}
  }
  var next = _rmNextTradingDay();
  var out = [];
  Object.keys(want).forEach(function (c) {
    var r = map[c];
    if (!r || !r.ex) return;
    if (r.ex !== next) return;
    out.push({
      id: 'ex|' + c + '|' + r.ex, k: 'ex', lv: 1,
      s: c + ' 今天是最後買進日（' + r.ex + ' 除息，每股 ' + r.amt + ' 元）',
      w: want[c] + '｜發放日 ' + (r.pay || '—') + '。除息前一日買進才領得到'
    });
  });
  return out;
}
function _rmNextTradingDay() {
  var d = _rmTw();
  for (var i = 1; i <= 5; i++) {
    var n = new Date(d.getTime() + i * 86400000), w = n.getUTCDay();
    if (w >= 1 && w <= 5) return _rmIso(n);
  }
  return '';
}

// 五、API 流量
// 每日 500MB（你的級距），開盤日早上 8:00 重置。超過時 ticks／snapshots／kbars
// 回「空值」而不是錯誤，所以用完了看起來像行情壞掉，不會有人告訴你。
// 門檻不拍百分比：用這一輪量到的消耗速率外推到 13:30，推出來會超過才說話。
function _rmCondUsage() {
  if (!_rmUsage || !(_rmUsage.limit_bytes > 0)) return [];
  var used = _rmUsage.bytes, lim = _rmUsage.limit_bytes, pct = used / lim * 100;
  var out = [];
  var s0 = _rmUsageSeen[0], s1 = _rmUsageSeen[_rmUsageSeen.length - 1];
  if (_rmDaySession() && s0 && s1 && s1.t > s0.t + 600000 && s1.b > s0.b) {
    var rate = (s1.b - s0.b) / ((s1.t - s0.t) / 60000);     // bytes / 分鐘
    var mins = Math.max(0, 810 - _rmMin());
    var proj = used + rate * mins;
    if (proj > lim) {
      out.push({
        id: 'usage|proj|' + _rmIso(), k: 'usage', lv: 2,
        s: '行情流量照這個速度會在收盤前用完',
        w: '已用 ' + (used / 1048576).toFixed(0) + ' / ' + (lim / 1048576).toFixed(0)
          + ' MB，目前每分鐘 ' + (rate / 1048576).toFixed(2) + ' MB，推到 13:30 是 '
          + (proj / 1048576).toFixed(0) + ' MB。用完後行情查詢會回空值，不會報錯'
      });
    }
  }
  if (pct >= 90) {
    out.push({
      id: 'usage|90|' + _rmIso(), k: 'usage', lv: 2,
      s: '行情流量已用 ' + pct.toFixed(0) + '%',
      w: '剩 ' + ((lim - used) / 1048576).toFixed(0) + ' MB，開盤日早上 8:00 重置'
    });
  }
  return out;
}

// 六、夜盤與費半的當日變動落在自己歷史的極端
// 門檻取自己兩年日報酬分布的 p5／p95，不是拍一個百分比：
// 實測夜盤 448 天 p5 −1.74%、p95 約 +1.6%；費半 500 天 p5 −4.53%、p95 約 +4%。
// 做雙向不只做跌：連續上漲時一樣會下單，只標跌會漏掉一半的場合。
// 夜盤與費半的資料平常是「進場訊號板」那一頁載的。深夜不會有人先去開那一頁，
// 所以這裡自己備齊：夜盤走 ovPrepare（讀 data/night-txf.json 與少量 K 棒），
// 費半的兩年日線自己抓一次（Yahoo，跟全站同一個端點），不去呼叫 startRebound——
// 那會連帶抓全部持股的日線，為了一條提醒付那個流量不划算。
var _rmSoxHist = null, _rmSoxAt = 0, _rmNightReq = false;
async function _rmNightData() {
  if (!_ovNight && !_rmNightReq && typeof ovPrepare === 'function') {
    _rmNightReq = true;
    try { await ovPrepare(false); } catch (e) { hush('remind', e); }
    _rmNightReq = false;
  }
  if (_rmSoxHist && Date.now() - _rmSoxAt < 6 * 3600000) return;
  try {
    // Yahoo 不給 CORS，跟全站一樣走 GAS 代理（_ovLoadSoxLive 也是這樣抓的）
    var u = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX?interval=1d&range=2y';
    var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(u));
    var j = await r.json();
    var cl = j.chart.result[0].indicators.quote[0].close.filter(function (v) { return v > 0; });
    var rr = [];
    for (var i = 1; i < cl.length; i++) rr.push((cl[i] / cl[i - 1] - 1) * 100);
    if (rr.length >= 100) { _rmSoxHist = rr; _rmSoxAt = Date.now(); }
  } catch (e) { hush('remind', e); }
}

async function _rmCondNight() {
  if (!_rmNightSession()) return [];
  await _rmNightData();
  var out = [];
  var nMap = (typeof _ovNight === 'object' && _ovNight) ? _ovNight : null;
  if (nMap) {
    var hist = Object.keys(nMap).map(function (k) { return nMap[k]; });
    var lo = _rmQ(hist, 0.05), hi = _rmQ(hist, 0.95);
    var cur = (typeof _ovToday === 'object' && _ovToday && _ovToday.pct != null) ? _ovToday.pct : null;
    if (cur != null && lo != null && (cur <= lo || cur >= hi)) {
      out.push({
        id: 'night|' + _rmIso() + '|' + (cur <= lo ? 'd' : 'u'), k: 'night', lv: 2,
        s: '台指期夜盤' + (cur <= lo ? '大跌' : '大漲') + ' ' + cur.toFixed(2) + '%',
        w: '自己 ' + hist.length + ' 天分布的 ' + (cur <= lo ? 'p5（' + lo.toFixed(2) : 'p95（' + hi.toFixed(2))
          + '%）以外' + _rmOvText()
      });
    }
  }
  var sh = _rmSoxHist;
  if (!sh && typeof _rbData === 'object' && _rbData && _rbData.sox && _rbData.sox.rets) {
    sh = Object.keys(_rbData.sox.rets).map(function (k) { return _rbData.sox.rets[k]; });
  }
  if (sh) {
    var slo = _rmQ(sh, 0.05), shi = _rmQ(sh, 0.95);
    var sc = (typeof _ovSox === 'function') ? _ovSox() : null;
    if (!sc) sc = null;
    if (sc != null && slo != null && (sc <= slo || sc >= shi)) {
      out.push({
        id: 'sox|' + _rmIso() + '|' + (sc <= slo ? 'd' : 'u'), k: 'sox', lv: 2,
        s: '費半' + (sc <= slo ? '大跌' : '大漲') + ' ' + sc.toFixed(2) + '%',
        w: '自己 ' + sh.length + ' 天分布的 ' + (sc <= slo ? 'p5（' + slo.toFixed(2) : 'p95（' + shi.toFixed(2))
          + '%）以外' + _rmOvText()
      });
    }
  }
  return out;
}
// 只給 % 沒有用，附上隔夜推估算出來的價格
function _rmOvText() {
  if (typeof ovEstimate !== 'function') return '';
  var out = [];
  ((typeof _positions !== 'undefined' && _positions) ? _positions : []).slice(0, 5).forEach(function (p) {
    var e = null;
    try { e = ovEstimate(String(p.code)); } catch (x) { e = null; }
    if (e && e.cPx != null) out.push(p.code + ' ' + e.cPx + ' 元');
  });
  return out.length ? '｜隔夜推估明日收盤：' + out.join('、') : '';
}

// ═════ 輪詢 ═════
async function _rmSlowFetch() {
  var now = Date.now();
  if (now - _rmSlowAt < RM_SLOW) return;
  _rmSlowAt = now;
  try {
    var r = await fetch('/api/v1/portfolio/settlements', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    var j = await r.json();
    if (Array.isArray(j)) _rmSettle = j;
  } catch (e) { hush('remind', e); }
  try {
    var r2 = await fetch('/api/v1/auth/usage');
    var j2 = await r2.json();
    if (j2 && j2.limit_bytes) {
      _rmUsage = j2;
      _rmUsageSeen.push({ t: now, b: j2.bytes });
      if (_rmUsageSeen.length > 24) _rmUsageSeen.shift();
    }
  } catch (e) { hush('remind', e); }
}

async function rmTick() {
  if (_rmBusy) return;
  _rmBusy = true;
  try {
    await _rmSlowFetch();
    var list = [];
    try { list = list.concat(await _rmCondRod()); } catch (e) { hush('remind', e); }
    try { list = list.concat(await _rmCondSettle()); } catch (e) { hush('remind', e); }
    try { list = list.concat(_rmCondAlert()); } catch (e) { hush('remind', e); }
    try { list = list.concat(_rmCondEx()); } catch (e) { hush('remind', e); }
    try { list = list.concat(_rmCondUsage()); } catch (e) { hush('remind', e); }
    try { list = list.concat(await _rmCondNight()); } catch (e) { hush('remind', e); }
    _rmNow = list;
    _rmFire(list);
    rmRenderBadge();
    if (_rmOpen) rmRenderPanel();
  } finally {
    _rmBusy = false;
    clearTimeout(_rmTimer);
    _rmTimer = setTimeout(rmTick, _rmDaySession() ? RM_TICK_DAY : (_rmNightSession() ? RM_TICK_NIGHT : RM_SLOW));
  }
}

// ═════ 畫面 ═════
function rmRenderBadge() {
  var b = document.getElementById('rm-badge');
  if (!b) return;
  var n = _rmNow.length;
  b.textContent = n ? String(n) : '';
  b.style.display = n ? '' : 'none';
  var btn = document.getElementById('rm-btn');
  if (btn) btn.classList.toggle('rm-on', n > 0);
}

function rmToggle() {
  _rmOpen = !_rmOpen;
  var p = document.getElementById('rm-pop');
  if (!p) return;
  p.hidden = !_rmOpen;
  if (_rmOpen) { rmRenderPanel(); rmTick(); }
}

function _rmRow(c, when) {
  return '<div class="rm-row rm-lv' + (c.lv || 1) + '">'
    + '<span class="rm-k">' + ({ rod: '委託', settle: '交割', alert: '門檻', ex: '除息', usage: '流量', night: '夜盤', sox: '費半' }[c.k] || '—') + '</span>'
    + '<span class="rm-s">' + c.s + (when ? '<i class="rm-when">' + when + '</i>' : '') + '</span>'
    + '<span class="rm-w">' + (c.w || '') + '</span></div>';
}

function rmRenderPanel() {
  var p = document.getElementById('rm-pop');
  if (!p) return;
  var now = _rmNow.map(function (c) { return _rmRow(c, ''); }).join('');
  var log = _rmLoadLog().map(function (r) {
    return _rmRow(r, r.d.slice(5) + ' ' + r.t);
  }).join('');
  p.innerHTML = '<div class="rm-head">提醒'
    + '<span class="rm-sub">按鈕數字＝現在成立的條件數</span>'
    + '<button class="rm-x" onclick="rmToggle()">✕</button></div>'
    + '<div class="rm-sec">現在成立</div>'
    + (now || '<div class="rm-none">沒有成立的條件</div>')
    + '<div class="rm-sec">最近觸發（只在條件從未觸發變成觸發那一刻記一次，保留兩天）</div>'
    + (log || '<div class="rm-none">兩天內沒有觸發紀錄</div>')
    + '<div class="nb">六條的判斷方式與它們的限制。'
    + '<b>委託</b>：收盤前 ' + RM_ROD_MIN + ' 分鐘內還有未成交的委託就成立。ROD 當日有效，收盤即失效。'
    + '<b>交割</b>：券商 settlements 的應付金額與日期。'
    + '這裡看不到銀行餘額（account_balance 回 0 並附「非信用銀行帳戶」），所以只報金額，不判斷夠不夠。'
    + '<b>門檻</b>：停損停利頁設定的價格與報酬率門檻，這裡只讀結果，不在這裡設定。'
    + '<b>除息</b>：下一個交易日除息的持股與關注標的，今天是最後買進日。'
    + '<b>流量</b>：Shioaji 每日 500MB，開盤日早上 8:00 重置。超過時行情查詢回空值不報錯，'
    + '所以用現場量到的消耗速率外推到 13:30，推出來會超過才說話，不拍一個百分比當門檻。'
    + '<b>夜盤與費半</b>：門檻取各自兩年日報酬分布的 p5 與 p95，雙向都標——'
    + '多頭上漲時一樣會下單，只標跌會漏掉一半的場合。'
    + '<b>共同限制</b>：這一頁關著就不會判斷，沒有推播。國定假日只靠星期判斷，'
    + '會被當成交易日，但那天一條都不會成立。</div>';
}

function rmStart() {
  if (!document.getElementById('rm-btn')) return;
  rmRenderBadge();
  clearTimeout(_rmTimer);
  rmTick();
}

// 跟成交提示同一個時機起跑：那時候已經登入、庫存與行情都在路上了。
// 延遲一點是為了讓 overnight / rebound 先把夜盤與費半的歷史載好，
// 沒載好的那幾輪，對應的條件自己會回空陣列，不會誤判。
window.addEventListener('load', function () { setTimeout(rmStart, 6000); });
