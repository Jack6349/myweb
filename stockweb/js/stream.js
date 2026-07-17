// 股利總管 Web — 行情引擎 + 即時行情畫面（永豐金 Shioaji 本機服務，同源 /api/v1）
// 資料源：券商庫存（position_unit）為準；Firestore 僅作備援並由 broker.js 反向同步給手機版。
// ensureFeed() 為共用引擎：庫存→合約→快照→訂閱→SSE，即時行情/持股庫存兩畫面共用。

var API = ''; // 同源（由 shioaji server 的 /apps/stockweb/ 提供頁面）
var _contracts = {};   // code → {exchange, name, reference}
var _rows = {};        // code → 最新 {close, total_volume, time}
var _es = null;        // EventSource
var _positions = [];   // 券商庫存原始列（含 id/quantity/price/pnl）
var _sharesMap = {};   // code → 股數
var _totalCost = 0;    // 總付出成本（元）
var _feedReady = null; // ensureFeed 的 Promise（避免重複初始化）

// 券商端成本=0的入帳（如銀行認購後匯入，非本券商成交）：code → { 入帳日: 實際付出成本(元) }
// 只在建倉明細確實存在「同日、price=0」的筆時才套用；該筆賣出或券商補登成本後自動失效
var COST_OVERRIDES = { '00407A': { '2026-06-23': 100000 } }; // 往來銀行認購10張，0手續費

// ── 檢視切換 ──
var VIEW_TITLES = { stream: '即時行情', inv: '持股庫存', divest: '股利估算', txinfo: '交易資訊', live: '即時持股', news: '新聞情勢', trend: '趨勢評估', signals: '籌碼淨值', alerts: '停損停利', risk: '加減碼報告', params: '參數設定' };
var _curView = 'home';
function showView(name) {
  _curView = name;
  document.getElementById('home-cards').style.display = name === 'home' ? 'grid' : 'none';
  ['stream', 'inv', 'divest', 'txinfo', 'live', 'news', 'trend', 'signals', 'alerts', 'risk', 'params'].forEach(function (v) {
    document.getElementById(v + '-view').style.display = v === name ? 'block' : 'none';
  });
  document.getElementById('crumb').textContent = VIEW_TITLES[name] || '';
  document.getElementById('btn-back').style.display = name === 'home' ? 'none' : '';
  if (name === 'home') document.getElementById('stream-info').textContent = '';
  var nav = document.getElementById('nav-bar');
  if (nav) {
    nav.style.display = name === 'home' ? 'none' : 'flex';
    Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-view') === name);
    });
  }
  if (typeof renderTopbarTotals === 'function') renderTopbarTotals(); // 切頁時刷新頂欄常駐總計
  // 加減碼報告頁：標題後方顯示台指期即時指數；離開則移除
  if (name === 'risk') { if (typeof startTxfBadge === 'function') startTxfBadge(); }
  else { if (typeof stopTxfBadge === 'function') stopTxfBadge(); }
}
function goHome() { showView('home'); }
function openStream() { showView('stream'); startStream(); }
function openInventory() { showView('inv'); if (typeof startInventory === 'function') startInventory(); }
function openTxinfo() { showView('txinfo'); if (typeof startTxinfo === 'function') startTxinfo(); }
function openDividendEst() { showView('divest'); if (typeof startDividendEst === 'function') startDividendEst(); }
function openRiskReport() { showView('risk'); if (typeof startRiskReport === 'function') startRiskReport(); }
function openLive() { showView('live'); if (typeof startLive === 'function') startLive(); }
function openNews() { showView('news'); if (typeof startNews === 'function') startNews(); }
function openTrend() { showView('trend'); if (typeof startTrend === 'function') startTrend(); }
function openSignals() { showView('signals'); if (typeof startSignals === 'function') startSignals(); }
function openAlerts() { showView('alerts'); if (typeof startAlerts === 'function') startAlerts(); }
function openParams() { showView('params'); if (typeof startParams === 'function') startParams(); }
function closeStream() { goHome(); } // 相容頂欄返回鈕/標題連結

// ── 服務健康檢查 ──
async function checkServer() {
  var el = document.getElementById('conn-status');
  try {
    var r = await fetch(API + '/api/v1/health', { cache: 'no-store' });
    if (r.ok) { el.textContent = '● 行情服務連線中'; el.className = 'conn-status ok'; return true; }
  } catch (e) {}
  el.textContent = '● 行情服務未啟動';
  el.className = 'conn-status off';
  return false;
}
function serverDownHtml() {
  return '本機行情服務未啟動。請在電腦上執行：\n' +
    '<code>cd C:\\Users\\jack6\\shioaji-server</code>\n' +
    '<code>shioaji server start --production --no-open</code>\n' +
    '啟動後重新整理本頁。';
}

// ── Firestore 持股（備援：券商查詢失敗時使用） ──
async function loadPortfolioFallback() {
  if (!window.FB || !window.OWNER_UID) return [];
  try {
    var snap = await window.FB.getDoc(window.FB.doc(window.FB.db, 'stock_portfolio', window.OWNER_UID));
    if (snap.exists()) return snap.data().portfolio || [];
  } catch (e) { console.warn('[loadPortfolioFallback]', e); }
  return [];
}

// ── 合約 / 快照 / 訂閱 ──
async function fetchContract(code) {
  var r = await fetch(API + '/api/v1/data/contracts/' + encodeURIComponent(code) + '?security_type=STK');
  if (!r.ok) throw new Error('contract ' + code + ' HTTP ' + r.status);
  return r.json();
}
async function fetchSnapshots(contracts) {
  var body = { contracts: contracts.map(function (c) { return { security_type: 'STK', exchange: c.exchange, code: c.code }; }) };
  var r = await fetch(API + '/api/v1/data/snapshots', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('snapshots HTTP ' + r.status);
  return r.json();
}
async function subscribeTick(c) {
  var r = await fetch(API + '/api/v1/stream/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ security_type: 'STK', exchange: c.exchange, code: c.code, quote_type: 'Tick' })
  });
  if (!r.ok) console.warn('[subscribe]', c.code, r.status);
}

// ── 券商庫存載入（含出借/匯撥補償、成本補正、_sharesMap 重建） ──
// ensureFeed 首載與 refreshPositions 盤中成交重抓共用；失敗會 throw，呼叫端自行決定回復策略
async function loadBrokerPositionsFull(say) {
  say = say || function () {};

    say('讀取券商庫存…');
    try {
      _positions = await fetchBrokerPositions();
    } catch (e) {
      console.warn('[positions]', e);
      _positions = [];
    }

    // 出借/匯撥補償：出借中股數不在彙總 quantity（全數出借＝歸零、部分出借＝只剩未借出部分），
    // 但建倉明細仍有未平倉 → 每檔比對明細，明細股數 > 彙總就以明細重建股數/均價/損益，
    // 差額記在 lentShares（總覽「借出」欄用）；彙總與明細皆 0 才是真出清、剔除該列
    await Promise.all(_positions.map(async function (pz) {
      if (pz.id == null) return;
      try {
        var det = await fetchPositionDetail(pz.id);
        var dq = 0, dcost = 0, dpnl = 0;
        (det || []).forEach(function (d) {
          if (d.quantity > 0) { dq += d.quantity; dcost += (d.price || 0); dpnl += (d.pnl || 0); }
        });
        var detShares = dq * 1000;               // 明細以「張」計 → 股
        if (detShares > pz.quantity) {
          pz.lentShares = detShares - pz.quantity; // 出借/匯撥中股數
          pz.quantity = detShares;
          pz.price = dcost / detShares;          // 每股均價 = 總成本 ÷ 股數
          pz.pnl = dpnl;
          pz.direction = 'Buy';
          pz.lent = true;                        // 出借中（總覽的「借出」欄用）
          console.log('[positions] ' + pz.code + ' 依建倉明細補回出借/匯撥中 ' + (pz.lentShares / 1000) + ' 張（共 ' + dq + ' 張）');
        }
      } catch (e) { console.warn('[positions] ' + pz.code + ' 明細補償失敗', e); }
    }));
    _positions = _positions.filter(function (p) { return p.quantity > 0; });

    // 銀行認購成本補正：券商端該筆 price=0（成本沒登錄），把實際付出成本加回總成本並修正均價/損益
    for (var y = 0; y < _positions.length; y++) {
      var py = _positions[y];
      var ov = COST_OVERRIDES[String(py.code)];
      if (!ov || py.id == null) continue;
      try {
        var dets = await fetchPositionDetail(py.id);
        var add = 0, sumCost = 0;
        (dets || []).forEach(function (d) {
          if (d.quantity > 0) {
            sumCost += (d.price || 0);
            if (d.price === 0 && ov[d.date] != null) add += ov[d.date];
          }
        });
        if (add > 0) {
          py.price = (sumCost + add) / py.quantity; // 均價 = (明細總成本＋補正) ÷ 股數（明細比彙總四捨五入精確）
          if (py.pnl != null) py.pnl -= add;        // 原 pnl 把 0 成本筆的現值全額當獲利，扣回實際成本
          console.log('[positions] ' + py.code + ' 補正銀行認購成本 +' + add.toLocaleString('zh-TW') + ' 元');
        }
      } catch (e) { console.warn('[positions] ' + py.code + ' 成本補正失敗', e); }
    }

    if (_positions.length) {
      _sharesMap = {}; _totalCost = 0;
      _positions.forEach(function (p) {
        _sharesMap[String(p.code)] = p.quantity; // quantity 已是「股」（含零股）
        _totalCost += Math.round(p.price * p.quantity);
      });
    } else {
      // 備援：Firestore（shares 為張、cost 為總成本元）
      say('券商庫存無資料，改用雲端持股…');
      var pf = await loadPortfolioFallback();
      _sharesMap = {}; _totalCost = 0;
      pf.forEach(function (s) {
        var sh = parseFloat(s.shares), c = parseFloat(s.cost);
        if (!isNaN(sh) && sh > 0) _sharesMap[String(s.code)] = sh * 1000;
        if (!isNaN(c)) _totalCost += c;
      });
      _totalCost = Math.round(_totalCost);
      _positions = pf.map(function (s, i) {
        return { id: null, code: String(s.code), quantity: parseFloat(s.shares) || 0,
                 price: (parseFloat(s.cost) || 0) / ((parseFloat(s.shares) || 1) * 1000), pnl: null };
      });
    }
    if (!_positions.length) throw new Error('讀不到持股資料（券商與雲端皆空）');
}

// ── 共用行情引擎：庫存→合約→快照→訂閱→SSE（只跑一次） ──
function ensureFeed(statusCb) {
  if (_feedReady) return _feedReady;
  _feedReady = (async function () {
    var say = statusCb || function () {};

    await loadBrokerPositionsFull(say);

    say('查詢合約…');
    for (var i = 0; i < _positions.length; i++) {
      var code = String(_positions[i].code);
      try {
        _contracts[code] = await fetchContract(code);
        _rows[code] = { close: null, total_volume: null, time: '' };
      } catch (e) { console.warn('[contract]', code, e); }
    }

    say('取得快照…');
    try {
      var snaps = await fetchSnapshots(Object.values(_contracts));
      snaps.forEach(function (s) {
        _rows[s.code] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) };
      });
    } catch (e) { console.warn('[snapshots]', e); }

    say('訂閱行情…');
    var list = Object.values(_contracts);
    for (var j = 0; j < list.length; j++) await subscribeTick(list[j]);

    openSSE();
    openOrderEvents(); // 盤中成交自動更新庫存

    // 背景：券商持倉回寫 Firestore（手機版共用），不阻塞畫面
    if (_positions[0] && _positions[0].id !== null) {
      syncPositionsToFirestore(_positions);
    }
  })();
  _feedReady.catch(function () { _feedReady = null; }); // 失敗允許重試
  return _feedReady;
}

// ── 盤中成交自動更新：訂閱委託/成交事件（SSE），事件後重抓庫存並重繪 ──
// 修正「今日買入成交但持股庫存/即時持股數量沒變」：_positions 原本只在首載抓一次
var _orderEs = null, _posRefreshTimer = null, _posRefreshing = false;
function openOrderEvents() {
  if (_orderEs) return;
  try {
    _orderEs = new EventSource(API + '/api/v1/stream/data/order_event');
    _orderEs.onmessage = function () {
      // 任何委託/成交/取消事件都可能改變庫存 → 去抖 3 秒後重抓一次（連續多筆成交只抓一次）
      clearTimeout(_posRefreshTimer);
      _posRefreshTimer = setTimeout(function () { refreshPositions(); }, 3000);
    };
    _orderEs.onerror = function () {}; // EventSource 斷線自動重連
  } catch (e) { console.warn('[order events]', e); }
}
async function refreshPositions() {
  if (_posRefreshing || !_feedReady) return;
  _posRefreshing = true;
  var bakPos = _positions, bakShares = _sharesMap, bakCost = _totalCost;
  try {
    await loadBrokerPositionsFull();
    // 新買進的檔（首次建倉）：補合約/快照/訂閱；既有檔已訂閱，略過
    for (var i = 0; i < _positions.length; i++) {
      var code = String(_positions[i].code);
      if (_contracts[code]) continue;
      try {
        _contracts[code] = await fetchContract(code);
        _rows[code] = { close: null, total_volume: null, time: '' };
        var snaps = await fetchSnapshots([_contracts[code]]);
        snaps.forEach(function (s) {
          _rows[s.code] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) };
        });
        await subscribeTick(_contracts[code]);
      } catch (e) { console.warn('[refresh contract]', code, e); }
    }
    // 重繪目前畫面（各 render 內部自己讀 _positions/_sharesMap）
    if (typeof renderInvTable === 'function' && document.getElementById('inv-tbody') && document.getElementById('inv-tbody').children.length) renderInvTable();
    if (typeof renderLiveTables === 'function' && document.getElementById('live-cols') && document.getElementById('live-cols').children.length) renderLiveTables();
    if (typeof renderSummaries === 'function') renderSummaries();
    if (typeof renderTopbarTotals === 'function') renderTopbarTotals();
    if (_positions[0] && _positions[0].id !== null) syncPositionsToFirestore(_positions);
    console.log('[positions] 委託事件重抓完成：' + _positions.length + ' 檔');
  } catch (e) {
    // 重抓失敗（如券商暫時查無資料）→ 還原原快取，等下次事件再試
    _positions = bakPos; _sharesMap = bakShares; _totalCost = bakCost;
    console.warn('[refresh positions]', e);
  }
  _posRefreshing = false;
}

// ── 格式工具 ──
function fmtPct(v) { return (v > 0 ? '▲' : (v < 0 ? '▼' : '')) + Math.abs(v).toFixed(2) + '%'; }
function colorClass(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : 'flat'); }
function fmtMoney(v) { return '$' + Math.round(v).toLocaleString('zh-TW'); }

// ── 總覽合計（即時行情 / 持股庫存共用；每筆 tick 即時重算） ──
// 欄位：[含稅費/不含稅費 切換]（＋即時行情頁的 明細）| 總庫存 | 總現值 | 總付出成本 | 損益試算 | 獲利率 | 漲跌幅%
var _taxMode = true; // true=含稅費（淨額）, false=不含稅費（毛額）
function toggleTaxMode() {
  _taxMode = !_taxMode;
  renderSummaries();
  if (typeof renderInvTable === 'function' && document.getElementById('inv-tbody') && document.getElementById('inv-tbody').children.length) renderInvTable();
  if (typeof renderLiveTables === 'function' && document.getElementById('live-cols') && document.getElementById('live-cols').children.length) renderLiveTables();
}
function renderSummary(targetId) {
  var el = document.getElementById(targetId);
  if (!el) return;
  var grandTotal = 0, wsum = 0, wtotal = 0, totalShares = 0;
  Object.keys(_sharesMap).forEach(function (code) { totalShares += _sharesMap[code]; });
  Object.keys(_rows).forEach(function (code) {
    var r = _rows[code], c = _contracts[code];
    var sh = _sharesMap[code];
    if (!r || r.close == null || !sh) return;
    var val = r.close * sh;
    grandTotal += val;
    if (c && c.reference) {
      wsum += val * ((r.close - c.reference) / c.reference * 100);
      wtotal += val;
    }
  });
  if (!grandTotal) { el.style.display = 'none'; return; }
  var curVal = Math.round(_taxMode ? grandTotal * 0.997735 : grandTotal); // 總現值：含稅費淨額 / 毛額
  var wpct = wtotal > 0 ? wsum / wtotal : null;          // 加權漲跌幅%
  var profit = _totalCost ? curVal - _totalCost : null;  // 損益試算
  var prate = (profit != null && _totalCost) ? profit / _totalCost * 100 : null;
  var pcls = profit == null ? 'flat' : colorClass(profit);
  var wcls = wpct == null ? 'flat' : colorClass(wpct);
  var toggleBtn = '<button class="btn-toggle" onclick="toggleTaxMode()">' + (_taxMode ? '含稅費' : '不含稅費') + '</button>';
  var detailBtn = (targetId === 'inv-summary') ? '' : '<button class="btn-detail" onclick="openInventory()">明細</button>';
  var pair = function (label, val, colorStyle) {
    return '<span class="sum-pair"><span class="sum-plabel">' + label + '</span>' +
      '<span class="sum-pval"' + (colorStyle ? ' style="color:' + colorStyle + '"' : '') + '>' + val + '</span></span>';
  };
  var cls2var = { up: 'var(--up)', down: 'var(--down)', flat: 'var(--text3)' };
  // 出借股數與其現值（帳面現值＝總現值扣除出借部分，與券商帳面一致）
  // 部分出借時只算 lentShares（出借中股數），不能把整檔 quantity 都算成借出
  var lentShares = 0, lentGross = 0;
  (_positions || []).forEach(function (p) {
    if (!p.lent) return;
    var code = String(p.code);
    var ls = p.lentShares != null ? p.lentShares : p.quantity;
    lentShares += ls;
    var r = _rows[code];
    if (r && r.close != null) lentGross += r.close * ls;
  });
  var lentVal = Math.round(_taxMode ? lentGross * 0.997735 : lentGross);
  var bookVal = curVal - lentVal; // 帳面現值（不含借出）
  el.style.display = '';
  // 總現值/總付出成本/損益試算/獲利率 已移至頂欄；合計列留其餘欄位（回到一行）
  el.innerHTML = '<div class="sum-line">' + toggleBtn + detailBtn +
    pair('總庫存(含借出)', totalShares.toLocaleString('zh-TW'), '') +
    pair('漲跌幅％', wpct == null ? '—' : fmtPct(wpct), cls2var[wcls]) +
    pair('借出', lentShares.toLocaleString('zh-TW') + ' 股', 'var(--text2)') +
    pair('帳面現值', bookVal.toLocaleString('zh-TW'), 'var(--text2)') +
  '</div>';
}

// 頂欄常駐四項（總現值/總付出成本/損益試算/獲利率，全站可見、隨行情跳動）
function renderTopbarTotals() {
  var el = document.getElementById('topbar-totals');
  if (!el) return;
  if (_curView === 'risk') { el.innerHTML = ''; return; } // 加減碼報告頁：讓位給台指期徽章
  if (!_sharesMap || !Object.keys(_sharesMap).length) { el.innerHTML = ''; return; }
  var grandTotal = 0;
  Object.keys(_rows).forEach(function (code) {
    var r = _rows[code], sh = _sharesMap[code];
    if (!r || r.close == null || !sh) return;
    grandTotal += r.close * sh;
  });
  if (!grandTotal) { el.innerHTML = ''; return; }
  var curVal = Math.round(_taxMode ? grandTotal * 0.997735 : grandTotal);
  var profit = _totalCost ? curVal - _totalCost : null;
  var prate = (profit != null && _totalCost) ? profit / _totalCost * 100 : null;
  var pcls = profit == null ? 'flat' : colorClass(profit);
  var cvar = { up: 'var(--up)', down: 'var(--down)', flat: 'var(--text3)' };
  var tt = function (lb, v, c) {
    return '<span class="tt"><span class="tt-lb">' + lb + '</span><span class="tt-v" style="color:' + c + '">' + v + '</span></span>';
  };
  el.innerHTML =
    tt('總現值(含借出)', curVal.toLocaleString('zh-TW'), 'var(--accent2)') +
    tt('總付出成本(含借出)', _totalCost ? _totalCost.toLocaleString('zh-TW') : '—', '#f5d87a') +
    tt('損益試算', profit == null ? '—' : (profit >= 0 ? '+' : '') + profit.toLocaleString('zh-TW'), cvar[pcls]) +
    tt('獲利率', prate == null ? '—' : (prate > 0 ? '+' : '') + prate.toFixed(2) + '%', cvar[pcls]);
}
function renderSummaries() {
  renderSummary('stream-summary');
  renderSummary('inv-summary');
  renderSummary('live-summary');
  renderTopbarTotals();
}

// ── 即時行情卡片 ──
function renderCard(code) {
  var r = _rows[code], c = _contracts[code];
  var el = document.getElementById('scard-' + code);
  if (!el || !r || !c) return;
  var chg = (r.close != null && c.reference) ? r.close - c.reference : null;
  var pct = (chg != null && c.reference) ? chg / c.reference * 100 : null;
  var cls = chg == null ? 'flat' : colorClass(chg);
  el.innerHTML =
    '<div class="scard-head"><span class="scard-code">' + code + '</span>' +
      '<span class="scard-name">' + (c.name || '') + '</span></div>' +
    '<div class="scard-priceline">' +
      '<span class="scard-price ' + cls + '">' + (r.close != null ? r.close.toFixed(2) : '—') + '</span>' +
      '<span class="scard-chg ' + cls + '">' +
        (chg == null ? '—' : ((chg > 0 ? '+' : '') + chg.toFixed(2) + '　' + fmtPct(pct))) + '</span>' +
    '</div>' +
    '<div class="scard-sub">' +
      '<span>總量 ' + (r.total_volume != null ? r.total_volume.toLocaleString() : '—') + '</span>' +
      '<span>昨收 ' + (c.reference != null ? c.reference : '—') + '</span>' +
      '<span>' + (r.time || '—') + '</span>' +
    '</div>';
}

function flashCard(code, dir) {
  var el = document.getElementById('scard-' + code);
  if (!el) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // 重觸發動畫
  el.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
}

// ── SSE 接收（全畫面共用一條連線） ──
function openSSE() {
  if (_es) { _es.close(); _es = null; }
  _es = new EventSource(API + '/api/v1/stream/data/tick_stk');
  _es.addEventListener('tick_stk', function (ev) {
    try {
      var t = JSON.parse(ev.data);
      if (t.simtrade || t.intraday_odd) return; // 排除試撮與零股
      var code = t.code;
      var prev = _rows[code] ? _rows[code].close : null;
      var close = parseFloat(t.close);
      _rows[code] = { close: close, total_volume: t.total_volume, time: (t.time || '').slice(0, 8) };
      renderCard(code);
      renderSummaries();
      if (typeof renderInvRow === 'function') renderInvRow(code);
      if (typeof renderLiveRow === 'function') renderLiveRow(code);
      if (prev != null && close !== prev) flashCard(code, close > prev ? 1 : -1);
    } catch (e) {}
  });
  _es.onerror = function () {
    var info = document.getElementById('stream-info');
    if (info) info.textContent = '串流中斷，自動重連中…';
  };
  _es.onopen = function () {
    var info = document.getElementById('stream-info');
    if (info) info.textContent = '已連線｜' + Object.keys(_contracts).length + ' 檔訂閱中';
  };
}

// ── 即時行情畫面 ──
async function startStream() {
  var errEl = document.getElementById('stream-error');
  var grid = document.getElementById('stream-grid');
  var info = document.getElementById('stream-info');
  errEl.style.display = 'none';

  if (!(await checkServer())) {
    errEl.style.display = 'block';
    errEl.innerHTML = serverDownHtml();
    return;
  }
  try {
    await ensureFeed(function (msg) { info.textContent = msg; });
  } catch (e) {
    errEl.style.display = 'block';
    errEl.textContent = e.message;
    return;
  }
  // 建卡（若尚未建）並渲染
  Object.keys(_contracts).forEach(function (code) {
    if (!document.getElementById('scard-' + code)) {
      grid.insertAdjacentHTML('beforeend', '<div class="scard" id="scard-' + code + '"></div>');
    }
    renderCard(code);
  });
  renderSummaries();
  info.textContent = '已連線｜' + Object.keys(_contracts).length + ' 檔訂閱中';
}

// 開機：檢查服務狀態；由使用者點卡片進入功能
checkServer();
