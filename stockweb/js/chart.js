// 股利總管 Web — 個股線圖彈窗（即時行情點卡片開啟）
// 頁籤一：五日線＋成交量（Shioaji kbars 1 分 K，5 個交易日串接，含日分隔線）
// 頁籤二：日線（待開發）
// 繪圖用內嵌 SVG（專案無圖表函式庫、無建置流程）；資料每檔快取，同日重開不重抓

var _chartCode = null;
var _chartTab = 'd5';
var _chartCache = {};   // code → { day, dts, close, vol, ref }

function openChartPop(code) {
  _chartCode = String(code);
  _chartTab = 'intra';
  var c = _contracts[_chartCode];
  document.getElementById('detail-title').textContent =
    _chartCode + ' ' + ((c && c.name) || '') + ' — 線圖';
  var modal = document.getElementById('detail-modal');
  modal.style.display = 'flex';
  // 線圖用加大版面（其他彈窗維持原尺寸）：關閉時由 closeDetailModal 還原
  var box = modal.querySelector('.modal-box');
  if (box) box.classList.add('chart-wide');
  _chartRenderShell();
  chartShowTab('intra');
}

function _chartRenderShell() {
  document.getElementById('detail-body').innerHTML =
    '<div class="tx-subtabs chart-tabs">' +
      '<button id="chart-tab-intra" class="tx-subtab active" onclick="chartShowTab(\'intra\')">即時行情</button>' +
      '<button id="chart-tab-bid" class="tx-subtab" onclick="chartShowTab(\'bid\')">五檔</button>' +
      '<button id="chart-tab-d5" class="tx-subtab" onclick="chartShowTab(\'d5\')">五日線</button>' +
      '<button id="chart-tab-day" class="tx-subtab" onclick="chartShowTab(\'day\')">日線</button>' +
    '</div><div id="chart-area"></div>';
}

function chartShowTab(tab) {
  _chartTab = tab;
  ['intra', 'bid', 'd5', 'day'].forEach(function (t) {
    document.getElementById('chart-tab-' + t).classList.toggle('active', t === tab);
  });
  if (tab !== 'bid') _chartStopBidAsk();     // 離開五檔頁籤即退訂，省行情訂閱額度
  _chartEnsureLiveTimer();
  if (tab === 'intra') return _chartLoadIntra();
  if (tab === 'bid') return _chartLoadBidAsk();
  if (tab === 'd5') return _chartLoad5d();
  return _chartLoadDay();
}

// 螢幕座標 → viewBox 座標（用 SVG 原生 CTM）
// 不可用 (clientX-box.left)/box.width*860 換算：preserveAspectRatio 在高度被 max-height 限制時
// 會把內容置中留白，實際繪圖區比元素窄，直接換算會產生隨 X 放大的偏移（十字線對不準游標）
function _chartVX(svg, clientX) {
  var m = svg.getScreenCTM();
  if (!m) return null;
  var p = svg.createSVGPoint();
  p.x = clientX; p.y = 0;
  return p.matrixTransform(m.inverse()).x;
}

function _chartYmd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 取近 5 個交易日 1 分 K：往前抓 12 個日曆天再取最後 5 個交易日（涵蓋連假）
async function _chartFetch5d(code) {
  var today = new Date();
  var start = new Date(today.getTime() - 12 * 86400000);
  var r = await fetch(API + '/api/v1/data/kbars', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contract: { security_type: 'STK', exchange: (_contracts[code] || {}).exchange || 'TSE', code: code },
      start: _chartYmd(start), end: _chartYmd(today)
    })
  });
  if (!r.ok) throw new Error('kbars HTTP ' + r.status);
  var j = await r.json();
  if (!j || !j.datetime || !j.datetime.length) throw new Error('無 K 線資料');
  // 只留最後 5 個交易日
  var days = [];
  j.datetime.forEach(function (t) { var d = t.slice(0, 10); if (days[days.length - 1] !== d) days.push(d); });
  var keep = {};
  days.slice(-5).forEach(function (d) { keep[d] = true; });
  var dts = [], close = [], vol = [];
  for (var i = 0; i < j.datetime.length; i++) {
    if (!keep[j.datetime[i].slice(0, 10)]) continue;
    dts.push(j.datetime[i]); close.push(j.Close[i]); vol.push(j.Volume[i]);
  }
  return { dts: dts, close: close, vol: vol };
}

async function _chartLoad5d() {
  var area = document.getElementById('chart-area');
  var code = _chartCode;
  area.innerHTML = '<div class="modal-loading">載入 K 線中…</div>';
  try {
    var today = _chartYmd(new Date());
    var cc = _chartCache[code];
    if (!cc || cc.day !== today) {
      var d = await _chartFetch5d(code);
      cc = _chartCache[code] = { day: today, dts: d.dts, close: d.close, vol: d.vol };
    }
    if (_chartCode !== code || _chartTab !== 'd5') return; // 期間已切走
    area.innerHTML = _chart5dSvg(cc, code);
    _chartBindHover(cc);
  } catch (e) {
    area.innerHTML = '<div class="modal-loading">載入失敗：' + e.message + '</div>';
  }
}

// ── 頁籤一：即時行情（當日分時走勢＋均價線＋成交量＋完整報價面板）──
// Y 軸以「參考價（昨收）」為中心對稱，昨收線永遠置中 → 一眼看出全日在昨收之上或之下（同券商 App 慣例）
// 非盤中時段自動顯示最近交易日；內外盤由 ticks 的 tick_type 聚合（1=外盤 2=內盤）

async function _chartFetchIntra(code) {
  var today = new Date(), from = new Date(today.getTime() - 10 * 86400000);
  var ex = (_contracts[code] || {}).exchange || 'TSE';
  var r = await fetch(API + '/api/v1/data/kbars', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contract: { security_type: 'STK', exchange: ex, code: code },
      start: _chartYmd(from), end: _chartYmd(today) })
  });
  if (!r.ok) throw new Error('kbars HTTP ' + r.status);
  var j = await r.json();
  if (!j || !j.datetime || !j.datetime.length) throw new Error('無 K 線資料');
  var day = j.datetime[j.datetime.length - 1].slice(0, 10);   // 最後一個有資料的交易日
  var b = { day: day, t: [], c: [], v: [], amt: [] };
  for (var i = 0; i < j.datetime.length; i++) {
    if (j.datetime[i].slice(0, 10) !== day) continue;
    b.t.push(j.datetime[i].slice(11, 16)); b.c.push(j.Close[i]); b.v.push(j.Volume[i]); b.amt.push(j.Amount[i]);
    if (b.o == null) { b.o = j.Open[i]; b.h = j.High[i]; b.l = j.Low[i]; }
    if (j.High[i] > b.h) b.h = j.High[i];
    if (j.Low[i] < b.l) b.l = j.Low[i];
  }
  return b;
}
// 內外盤（tick_type：1=外盤/買方成交、2=內盤/賣方成交）
async function _chartFetchIO(code, day) {
  try {
    var r = await fetch(API + '/api/v1/data/ticks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: { security_type: 'STK', exchange: (_contracts[code] || {}).exchange || 'TSE', code: code }, date: day })
    });
    if (!r.ok) return null;
    var j = await r.json();
    var tt = j.tick_type || [], vol = j.volume || [], inner = 0, outer = 0;
    for (var i = 0; i < tt.length; i++) { if (tt[i] === 2) inner += vol[i]; else if (tt[i] === 1) outer += vol[i]; }
    return { inner: inner, outer: outer };
  } catch (e) { return null; }
}

async function _chartLoadIntra() {
  var area = document.getElementById('chart-area');
  var code = _chartCode;
  area.innerHTML = '<div class="modal-loading">載入當日走勢中…</div>';
  try {
    var today = _chartYmd(new Date());
    var key = code + ':intra';
    var cc = _chartCache[key];
    if (!cc || cc.day !== today) {
      var b = await _chartFetchIntra(code);
      cc = _chartCache[key] = { day: today, bars: b, io: null };
    }
    if (_chartCode !== code || _chartTab !== 'intra') return;
    area.innerHTML = _chartIntraSvg(cc, code);
    _chartBindIntraHover(cc.bars);
    if (!cc.io) {                                  // 內外盤較慢，先畫圖再補
      var io = await _chartFetchIO(code, cc.bars.day);
      if (io) { cc.io = io; if (_chartCode === code && _chartTab === 'intra') {
        area.innerHTML = _chartIntraSvg(cc, code); _chartBindIntraHover(cc.bars); } }
    }
  } catch (e) {
    area.innerHTML = '<div class="modal-loading">載入失敗：' + e.message + '</div>';
  }
}

function _chartIntraSvg(cc, code) {
  var b = cc.bars, n = b.c.length;
  if (!n) return '<div class="modal-loading">當日無成交資料</div>';
  var W = 860, H = 300, VH = 62, PAD_L = 58, PAD_R = 12, PAD_T = 10, GAP = 20;
  var PW = W - PAD_L - PAD_R, PH = H - VH - GAP - PAD_T - 14;
  var ct = _contracts[code] || {}, ref = ct.reference || b.c[0];

  // 均價線（VWAP）：累計金額 ÷ 累計量；量為「張」需換算股數
  var vwap = [], cumA = 0, cumV = 0;
  for (var i = 0; i < n; i++) { cumA += b.amt[i] || 0; cumV += b.v[i] || 0; vwap.push(cumV ? cumA / (cumV * 1000) : null); }

  // Y 軸以參考價對稱；範圍取「價格與均價偏離昨收的最大值」再加 5% 邊距
  var dev = 0;
  var track = function (p) { if (p != null) { var d = Math.abs(p - ref); if (d > dev) dev = d; } };
  track(b.h); track(b.l); vwap.forEach(track);
  dev = dev * 1.05 || ref * 0.01;
  var hi = ref + dev, lo = ref - dev;
  var vmax = 1; b.v.forEach(function (v) { if (v > vmax) vmax = v; });

  var x = function (k) { return PAD_L + (n === 1 ? PW / 2 : k * PW / (n - 1)); };
  var y = function (p) { return PAD_T + (hi - p) * PH / (hi - lo); };
  var vy = function (v) { return PAD_T + PH + GAP + VH - v * VH / vmax; };

  var s = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  // Y 軸 5 檔：上紅、中黃（昨收）、下綠
  for (var g = 0; g <= 4; g++) {
    var pv = hi - dev * 2 * g / 4, yy = y(pv);
    var kls = g === 2 ? 'ck-ax-ref' : (g < 2 ? 'ck-ax-up' : 'ck-ax-dn');
    s += '<line class="' + (g === 2 ? 'ck-ref' : 'ck-grid') + '" x1="' + PAD_L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + yy.toFixed(1) + '"/>' +
      '<text class="ck-axis ' + kls + '" x="' + (PAD_L - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end">' + pv.toFixed(2) + '</text>';
  }
  // X 軸整點格線（09~13）
  var prevH = '';
  b.t.forEach(function (t, k) {
    var hh = t.slice(0, 2);
    if (hh !== prevH) {
      if (k > 0) s += '<line class="ck-grid" x1="' + x(k).toFixed(1) + '" y1="' + PAD_T + '" x2="' + x(k).toFixed(1) + '" y2="' + (PAD_T + PH) + '"/>';
      s += '<text class="ck-axis" x="' + x(k).toFixed(1) + '" y="' + (H - 2) + '" text-anchor="middle">' + hh + '</text>';
      prevH = hh;
    }
  });
  // 量條
  var bw = Math.max(0.6, PW / n * 0.7);
  for (var k2 = 0; k2 < n; k2++) {
    if (!b.v[k2]) continue;
    s += '<rect class="ck-ivol" x="' + (x(k2) - bw / 2).toFixed(1) + '" y="' + vy(b.v[k2]).toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.6, b.v[k2] * VH / vmax).toFixed(1) + '"/>';
  }
  // 價格線＋填色（收盤價相對昨收決定紅/綠）
  var up = b.c[n - 1] >= ref, cls = up ? 'up' : 'dn';
  var pts = [], k3;
  for (k3 = 0; k3 < n; k3++) pts.push(x(k3).toFixed(1) + ',' + y(b.c[k3]).toFixed(1));
  s += '<polygon class="ck-fill ' + cls + '" points="' + x(0).toFixed(1) + ',' + y(ref).toFixed(1) + ' ' + pts.join(' ') + ' ' + x(n - 1).toFixed(1) + ',' + y(ref).toFixed(1) + '"/>';
  s += '<polyline class="ck-iline ' + cls + '" points="' + pts.join(' ') + '"/>';
  // 均價線
  var vp = [];
  for (k3 = 0; k3 < n; k3++) if (vwap[k3] != null) vp.push(x(k3).toFixed(1) + ',' + y(vwap[k3]).toFixed(1));
  if (vp.length > 1) s += '<polyline class="ck-vwap" points="' + vp.join(' ') + '"/>';
  // 量區頂線
  s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + (PAD_T + PH + GAP) + '" x2="' + (W - PAD_R) + '" y2="' + (PAD_T + PH + GAP) + '"/>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (PAD_T + PH + GAP + 10) + '" text-anchor="end">' + Math.round(vmax).toLocaleString('zh-TW') + '</text>';
  s += '<rect id="cki-hit" x="' + PAD_L + '" y="' + PAD_T + '" width="' + PW + '" height="' + (PH + GAP + VH) + '" fill="transparent"/>' +
    '<line id="cki-cross" class="ck-cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (PAD_T + PH + GAP + VH) + '" style="display:none"/></svg>';

  // 報價面板
  var r = _rows[code] || {};
  var last = (r.close != null && cc.day === b.day) ? r.close : b.c[n - 1];   // 盤中用即時價
  var chg = last - ref, pct = ref ? chg / ref * 100 : 0;
  var ccls = chg > 0 ? 'up' : (chg < 0 ? 'down' : '');
  var totVol = 0; b.v.forEach(function (v) { totVol += v; });
  var avg = cumV ? cumA / (cumV * 1000) : null;
  var amp = ref ? (b.h - b.l) / ref * 100 : 0;
  var io = cc.io;
  var cell = function (label, val, klass) {
    return '<div class="iq-cell"><span class="iq-k">' + label + '</span><span class="iq-v ' + (klass || '') + '">' + val + '</span></div>';
  };
  var f2 = function (v) { return v != null ? v.toFixed(2) : '—'; };
  var panel = '<div class="iq-grid">' +
    cell('成交', f2(last), ccls) + cell('漲跌', (chg > 0 ? '+' : '') + chg.toFixed(2), ccls) + cell('幅度', (pct > 0 ? '+' : '') + pct.toFixed(2) + '%', ccls) +
    cell('總量', totVol.toLocaleString('zh-TW'), 'y') + cell('均價', f2(avg)) + cell('振幅', amp.toFixed(2) + '%', 'y') +
    cell('內盤', io ? io.inner.toLocaleString('zh-TW') : '—', 'down') + cell('外盤', io ? io.outer.toLocaleString('zh-TW') : '—', 'up') +
    cell('參考', f2(ref), 'y') +
    cell('開盤', f2(b.o), b.o >= ref ? 'up' : 'down') + cell('最高', f2(b.h), b.h >= ref ? 'up' : 'down') + cell('最低', f2(b.l), b.l >= ref ? 'up' : 'down') +
    cell('漲停', f2(ct.limit_up), 'up') + cell('跌停', f2(ct.limit_down), 'down') +
    cell('日期', b.day.slice(5).replace('-', '/') + (cc.day === b.day && _twMarketLive && _twMarketLive() ? ' 盤中' : ' 收盤')) +
    '</div>';

  return '<div class="chart-info"><span id="cki-tip">' + b.day.replace(/-/g, '/') +
      '　<b class="' + ccls + '">' + f2(last) + '</b>　<span class="' + ccls + '">' + (chg > 0 ? '+' : '') + chg.toFixed(2) +
      '（' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%）</span>' +
      '<span class="ck-legend vwap">均價 ' + f2(avg) + '</span></span></div>' +
    s + panel +
    '<div class="detail-note">Shioaji 1 分 K；縱軸以參考價（昨收）為中心對稱，白線為均價（VWAP）。內外盤由當日逐筆成交彙總（外盤＝買方成交、內盤＝賣方成交）。</div>';
}

function _chartBindIntraHover(b) {
  var svg = document.querySelector('#chart-area .chart-svg');
  var hit = document.getElementById('cki-hit'), cross = document.getElementById('cki-cross'), tip = document.getElementById('cki-tip');
  if (!svg || !hit || !cross || !tip) return;
  var n = b.c.length, PAD_L = 58, PW = 860 - 58 - 12;
  var base = tip.innerHTML;
  var ct = _contracts[_chartCode] || {}, ref = ct.reference || b.c[0];
  hit.addEventListener('mousemove', function (ev) {
    var vx = _chartVX(svg, ev.clientX);
    if (vx == null) return;
    var k = Math.round((vx - PAD_L) / PW * (n - 1));
    if (k < 0) k = 0; if (k > n - 1) k = n - 1;
    var xx = PAD_L + (n === 1 ? PW / 2 : k * PW / (n - 1));
    cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.style.display = '';
    var p = b.c[k], d = p - ref, dp = ref ? d / ref * 100 : 0;
    var cls = d > 0 ? 'up' : (d < 0 ? 'down' : '');
    tip.innerHTML = b.t[k] + '　收 <b class="' + cls + '">' + p.toFixed(2) + '</b>' +
      ' <span class="' + cls + '">(' + (d > 0 ? '+' : '') + dp.toFixed(2) + '%)</span>　量 <b>' + (b.v[k] || 0).toLocaleString('zh-TW') + '</b>';
  });
  hit.addEventListener('mouseleave', function () { cross.style.display = 'none'; tip.innerHTML = base; });
}

// ── 頁籤二：即時買賣五檔（訂閱 BidAsk → SSE bidask_stk）──
// 行情訂閱有 200 檔額度上限 → 只在本頁籤開啟時訂閱，切走/關窗立即退訂
var _bidEs = null, _bidSubCode = null, _bidLast = null;

async function _chartLoadBidAsk() {
  var area = document.getElementById('chart-area');
  var code = _chartCode;
  _bidLast = null;
  area.innerHTML = '<div id="bid-wrap">' + _bidAskHtml(null, code) + '</div>';
  try {
    var ct = _contracts[code] || {};
    await fetch(API + '/api/v1/stream/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_type: 'STK', exchange: ct.exchange || 'TSE', code: code, quote_type: 'BidAsk' })
    });
    _bidSubCode = code;
  } catch (e) { console.warn('[bidask subscribe]', e); }
  if (_bidEs) { _bidEs.close(); _bidEs = null; }
  _bidEs = new EventSource(API + '/api/v1/stream/data/bidask_stk');
  _bidEs.addEventListener('bidask_stk', function (ev) {
    try {
      var b = JSON.parse(ev.data);
      if (b.code !== _chartCode || b.simtrade || b.intraday_odd) return;
      _bidLast = b;
      var wrap = document.getElementById('bid-wrap');
      if (wrap) wrap.innerHTML = _bidAskHtml(b, b.code);
    } catch (e) {}
  });
}

function _chartStopBidAsk() {
  if (_bidEs) { _bidEs.close(); _bidEs = null; }
  if (_bidSubCode) {
    var ct = _contracts[_bidSubCode] || {};
    fetch(API + '/api/v1/stream/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_type: 'STK', exchange: ct.exchange || 'TSE', code: _bidSubCode, quote_type: 'BidAsk' })
    }).catch(function () {});
    _bidSubCode = null;
  }
}

// 五檔表：委買由高到低、委賣由低到高；量條寬度依該檔量佔比；未開盤或尚無推送時顯示快照最佳一檔
function _bidAskHtml(b, code) {
  var r = _rows[code] || {}, ct = _contracts[code] || {};
  var head = '<div class="bid-head">' +
    '<span>成交 <b class="' + (r.close != null && ct.reference ? colorClass(r.close - ct.reference) : '') + '">' +
      (r.close != null ? r.close.toFixed(2) : '—') + '</b></span>' +
    '<span>昨收 ' + (ct.reference != null ? ct.reference.toFixed(2) : '—') + '</span>' +
    '<span>總量 ' + (r.total_volume != null ? r.total_volume.toLocaleString('zh-TW') : '—') + '</span>' +
    '<span class="bid-time">' + (b ? (b.time || '').slice(0, 8) : (r.time || '')) + '</span></div>';

  if (!b) {
    var live = (typeof _twMarketLive === 'function') && _twMarketLive();
    return head + '<div class="modal-loading">' +
      (live ? '等待五檔推送…（盤中約 1–2 秒內出現）' : '目前非盤中時段，無即時五檔推送') +
      '</div>' + _bidSnapNote();
  }
  var bp = b.bid_price || [], bv = b.bid_volume || [], ap = b.ask_price || [], av = b.ask_volume || [];
  var dbv = b.diff_bid_vol || [], dav = b.diff_ask_vol || [];
  var maxV = 1;
  bv.concat(av).forEach(function (v) { if (v > maxV) maxV = v; });
  var ref = ct.reference;
  var pcls = function (p) { return (ref && p) ? colorClass(parseFloat(p) - ref) : ''; };
  var diff = function (d) { return d ? '<span class="bid-diff ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + d + '</span>' : ''; };

  var rows = '';
  for (var i = 4; i >= 0; i--) {   // 委賣：價高在上
    if (ap[i] == null) continue;
    rows += '<tr class="bid-row"><td class="bid-lv">賣' + (i + 1) + '</td>' +
      '<td class="num bid-empty"></td><td class="bid-bar-cell"></td>' +
      '<td class="num bid-px ' + pcls(ap[i]) + '">' + parseFloat(ap[i]).toFixed(2) + '</td>' +
      '<td class="bid-bar-cell"><span class="bid-bar ask" style="width:' + (av[i] / maxV * 100).toFixed(1) + '%"></span></td>' +
      '<td class="num">' + (av[i] || 0).toLocaleString('zh-TW') + diff(dav[i]) + '</td></tr>';
  }
  for (var j = 0; j < 5; j++) {    // 委買：價高在上
    if (bp[j] == null) continue;
    rows += '<tr class="bid-row"><td class="bid-lv">買' + (j + 1) + '</td>' +
      '<td class="num">' + diff(dbv[j]) + (bv[j] || 0).toLocaleString('zh-TW') + '</td>' +
      '<td class="bid-bar-cell bid-bar-r"><span class="bid-bar bid" style="width:' + (bv[j] / maxV * 100).toFixed(1) + '%"></span></td>' +
      '<td class="num bid-px ' + pcls(bp[j]) + '">' + parseFloat(bp[j]).toFixed(2) + '</td>' +
      '<td class="bid-bar-cell"></td><td class="num bid-empty"></td></tr>';
  }
  var sumB = 0, sumA = 0;
  bv.forEach(function (v) { sumB += v; }); av.forEach(function (v) { sumA += v; });
  var tot = sumB + sumA || 1;
  return head +
    '<table class="bid-table"><thead><tr><th></th><th class="num">買量</th><th></th><th class="num">價格</th><th></th><th class="num">賣量</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    '<div class="bid-ratio"><span class="bid-ratio-bar"><i class="bid" style="width:' + (sumB / tot * 100).toFixed(1) + '%"></i>' +
      '<i class="ask" style="width:' + (sumA / tot * 100).toFixed(1) + '%"></i></span>' +
      '<span class="bid-ratio-txt">委買 <b class="up">' + sumB.toLocaleString('zh-TW') + '</b>（' + (sumB / tot * 100).toFixed(1) + '%）' +
      '　委賣 <b class="down">' + sumA.toLocaleString('zh-TW') + '</b>（' + (sumA / tot * 100).toFixed(1) + '%）</span></div>' +
    _bidSnapNote();
}
function _bidSnapNote() {
  return '<div class="detail-note">Shioaji BidAsk 逐筆推送（僅本頁籤開啟時訂閱，切換或關閉即退訂以節省 200 檔訂閱額度）。小字為較前一筆的量增減。</div>';
}

// ── 盤中自動更新：只重抓「今日」分 K 併入既有資料（今日約 266 根、~17KB），不重抓整段 ──
var _chartLiveTimer = null;
function _chartEnsureLiveTimer() {
  if (_chartLiveTimer) return;
  _chartLiveTimer = setInterval(function () {
    if (!_chartCode) return _chartStopLiveTimer();               // 彈窗已關
    if (typeof _twMarketLive === 'function' && !_twMarketLive()) return; // 非盤中不動作
    if (_chartTab === 'intra') return _chartLoadIntraLive();
    if (_chartTab === 'd5' || _chartTab === 'day') _chartRefreshToday();
  }, 60000);
}
function _chartStopLiveTimer() {
  if (_chartLiveTimer) { clearInterval(_chartLiveTimer); _chartLiveTimer = null; }
}
// 盤中重抓當日走勢（僅當日分 K＋內外盤，約 17KB＋210KB）
async function _chartLoadIntraLive() {
  var code = _chartCode, key = code + ':intra';
  try {
    var b = await _chartFetchIntra(code);
    if (_chartCode !== code || _chartTab !== 'intra') return;
    var cc = _chartCache[key];
    if (!cc) return;
    cc.bars = b;
    cc.io = await _chartFetchIO(code, b.day) || cc.io;
    if (_chartCode !== code || _chartTab !== 'intra') return;
    document.getElementById('chart-area').innerHTML = _chartIntraSvg(cc, code);
    _chartBindIntraHover(cc.bars);
  } catch (e) { console.warn('[chart intra live]', e); }
}

async function _chartRefreshToday() {
  var code = _chartCode, tab = _chartTab;
  try {
    var today = _chartYmd(new Date());
    var r = await fetch(API + '/api/v1/data/kbars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contract: { security_type: 'STK', exchange: (_contracts[code] || {}).exchange || 'TSE', code: code },
        start: today, end: today
      })
    });
    if (!r.ok) return;
    var j = await r.json();
    if (!j || !j.datetime || !j.datetime.length) return;
    if (_chartCode !== code || _chartTab !== tab) return;        // 期間已切走

    if (tab === 'd5') {
      var cc = _chartCache[code];
      if (!cc) return;
      var keep = cc.dts.filter(function (t) { return t.slice(0, 10) !== today; }).length;
      cc.dts = cc.dts.slice(0, keep).concat(j.datetime);
      cc.close = cc.close.slice(0, keep).concat(j.Close);
      cc.vol = cc.vol.slice(0, keep).concat(j.Volume);
      document.getElementById('chart-area').innerHTML = _chart5dSvg(cc, code);
      _chartBindHover(cc);
    } else {
      var cd = _chartCache[code + ':day'];
      if (!cd) return;
      var bar = { d: today, o: j.Open[0], h: j.High[0], l: j.Low[0], c: j.Close[j.Close.length - 1], v: 0 };
      for (var i = 0; i < j.datetime.length; i++) {
        if (j.High[i] > bar.h) bar.h = j.High[i];
        if (j.Low[i] < bar.l) bar.l = j.Low[i];
        bar.v += j.Volume[i];
      }
      var bars = cd.bars;
      if (bars.length && bars[bars.length - 1].d === today) bars[bars.length - 1] = bar; else bars.push(bar);
      document.getElementById('chart-area').innerHTML = _chartDaySvg(bars, code);
      _chartBindDayHover(bars);
    }
  } catch (e) { console.warn('[chart live]', e); }
}

// ── 頁籤二：日線（日 K＋MA5/20/60＋成交量）──
// kbars 無週期參數（固定 1 分 K）→ 抓約 240 日曆天分 K 於前端聚合成日 K（實測 2.7MB/0.8 秒，本機 server）
// 取 157 個交易日：顯示最近 90 根，前面 60+ 根供 MA60 暖身，確保每根顯示日的均線都有效
var CHART_DAY_SHOW = 90;

async function _chartFetchDay(code) {
  var today = new Date();
  var start = new Date(today.getTime() - 240 * 86400000);
  var r = await fetch(API + '/api/v1/data/kbars', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contract: { security_type: 'STK', exchange: (_contracts[code] || {}).exchange || 'TSE', code: code },
      start: _chartYmd(start), end: _chartYmd(today)
    })
  });
  if (!r.ok) throw new Error('kbars HTTP ' + r.status);
  var j = await r.json();
  if (!j || !j.datetime || !j.datetime.length) throw new Error('無 K 線資料');
  // 分 K → 日 K：開＝當日首根開、高/低＝當日極值、收＝當日末根收、量＝加總
  var map = {}, order = [];
  for (var i = 0; i < j.datetime.length; i++) {
    var d = j.datetime[i].slice(0, 10), a = map[d];
    if (!a) { a = map[d] = { d: d, o: j.Open[i], h: j.High[i], l: j.Low[i], c: j.Close[i], v: 0 }; order.push(d); }
    if (j.High[i] > a.h) a.h = j.High[i];
    if (j.Low[i] < a.l) a.l = j.Low[i];
    a.c = j.Close[i]; a.v += j.Volume[i];
  }
  order.sort();
  return order.map(function (d) { return map[d]; });
}

// 簡單移動平均（不足期數回 null，畫線時跳過）
function _chartMA(bars, n) {
  var out = [], sum = 0;
  for (var i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= n) sum -= bars[i - n].c;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

async function _chartLoadDay() {
  var area = document.getElementById('chart-area');
  var code = _chartCode;
  area.innerHTML = '<div class="modal-loading">載入日 K 中…</div>';
  try {
    var today = _chartYmd(new Date());
    var key = code + ':day';
    var cc = _chartCache[key];
    if (!cc || cc.day !== today) {
      var bars = await _chartFetchDay(code);
      cc = _chartCache[key] = { day: today, bars: bars };
    }
    if (_chartCode !== code || _chartTab !== 'day') return; // 期間已切走
    area.innerHTML = _chartDaySvg(cc.bars, code);
    _chartBindDayHover(cc.bars);
  } catch (e) {
    area.innerHTML = '<div class="modal-loading">載入失敗：' + e.message + '</div>';
  }
}

// 日線 SVG：日 K 紅漲綠跌（實心）、MA5/20/60、下方成交量
function _chartDaySvg(bars, code) {
  var W = 860, H = 320, VH = 70, PAD_L = 58, PAD_R = 12, PAD_T = 12, GAP = 30;
  var PW = W - PAD_L - PAD_R, PH = H - VH - GAP - PAD_T;
  if (!bars.length) return '<div class="modal-loading">無資料</div>';

  var ma5 = _chartMA(bars, 5), ma20 = _chartMA(bars, 20), ma60 = _chartMA(bars, 60);
  var s0 = Math.max(0, bars.length - CHART_DAY_SHOW);          // 顯示起點（前段供均線暖身）
  var view = bars.slice(s0), n = view.length;

  var lo = Infinity, hi = -Infinity;
  view.forEach(function (b) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
  [ma5, ma20, ma60].forEach(function (m) {
    for (var i = s0; i < bars.length; i++) { if (m[i] == null) continue; if (m[i] < lo) lo = m[i]; if (m[i] > hi) hi = m[i]; }
  });
  var pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  var vmax = 1; view.forEach(function (b) { if (b.v > vmax) vmax = b.v; });

  var step = PW / n;
  var x = function (k) { return PAD_L + step * (k + 0.5); };
  var y = function (p) { return PAD_T + (hi - p) * PH / (hi - lo); };
  var vy = function (v) { return PAD_T + PH + GAP + VH - v * VH / vmax; };

  var s = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  // 價格格線＋Y 軸
  for (var g = 0; g <= 4; g++) {
    var pv = hi - (hi - lo) * g / 4, yy = y(pv);
    s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + yy.toFixed(1) + '"/>' +
      '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end">' + pv.toFixed(2) + '</text>';
  }
  // 月分隔線＋月份標籤
  var prevMo = '';
  view.forEach(function (b, k) {
    var mo = b.d.slice(0, 7);
    if (mo !== prevMo) {
      if (k > 0) s += '<line class="ck-sep" x1="' + (x(k) - step / 2).toFixed(1) + '" y1="' + PAD_T + '" x2="' + (x(k) - step / 2).toFixed(1) + '" y2="' + (PAD_T + PH + GAP + VH) + '"/>';
      s += '<text class="ck-axis" x="' + x(k).toFixed(1) + '" y="' + (H - 2) + '" text-anchor="middle">' + b.d.slice(5).replace('-', '/') + '</text>';
      prevMo = mo;
    }
  });
  // 成交量
  var bw = Math.max(1, step * 0.62);
  view.forEach(function (b, k) {
    var up = b.c >= b.o;
    s += '<rect class="ck-vol ' + (up ? 'up' : 'dn') + '" x="' + (x(k) - bw / 2).toFixed(1) + '" y="' + vy(b.v).toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.6, b.v * VH / vmax).toFixed(1) + '"/>';
  });
  // 日 K 棒：影線＋實體（紅漲綠跌；開＝收畫成一字線）
  view.forEach(function (b, k) {
    var up = b.c >= b.o, cls = up ? 'up' : 'dn', xx = x(k);
    s += '<line class="ck-wick ' + cls + '" x1="' + xx.toFixed(1) + '" y1="' + y(b.h).toFixed(1) + '" x2="' + xx.toFixed(1) + '" y2="' + y(b.l).toFixed(1) + '"/>';
    var yTop = y(Math.max(b.o, b.c)), hBody = Math.max(1, Math.abs(y(b.o) - y(b.c)));
    s += '<rect class="ck-body ' + cls + '" x="' + (xx - bw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + hBody.toFixed(1) + '"/>';
  });
  // 均線
  [['ma5', ma5], ['ma20', ma20], ['ma60', ma60]].forEach(function (pair) {
    var pts = [];
    for (var k = 0; k < n; k++) {
      var v = pair[1][s0 + k];
      if (v != null) pts.push(x(k).toFixed(1) + ',' + y(v).toFixed(1));
    }
    if (pts.length > 1) s += '<polyline class="ck-ma ' + pair[0] + '" points="' + pts.join(' ') + '"/>';
  });
  // 量區頂線與刻度
  s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + (PAD_T + PH + GAP) + '" x2="' + (W - PAD_R) + '" y2="' + (PAD_T + PH + GAP) + '"/>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (PAD_T + PH + GAP + 10) + '" text-anchor="end">' + Math.round(vmax).toLocaleString('zh-TW') + '</text>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (PAD_T + PH + GAP + VH) + '" text-anchor="end">量</text>';
  s += '<rect id="ckd-hit" x="' + PAD_L + '" y="' + PAD_T + '" width="' + PW + '" height="' + (PH + GAP + VH) + '" fill="transparent"/>' +
    '<line id="ckd-cross" class="ck-cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (PAD_T + PH + GAP + VH) + '" style="display:none"/>' +
    '</svg>';

  var last = view[n - 1], first = view[0];
  var chg = last.c - first.c, pct = first.c ? chg / first.c * 100 : 0;
  var cls2 = chg >= 0 ? 'up' : 'down';
  var maLbl = function (name, v, klass) { return '<span class="ck-legend ' + klass + '">' + name + ' ' + (v != null ? v.toFixed(2) : '—') + '</span>'; };
  return '<div class="chart-info"><span id="ckd-tip">' +
      n + ' 日 <b>' + first.c.toFixed(2) + '</b> → <b>' + last.c.toFixed(2) + '</b>　' +
      '<span class="' + cls2 + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '（' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%）</span>' +
    '</span>　' + maLbl('MA5', ma5[bars.length - 1], 'ma5') + maLbl('MA20', ma20[bars.length - 1], 'ma20') + maLbl('MA60', ma60[bars.length - 1], 'ma60') +
    '</div>' + s +
    '<div class="detail-note">Shioaji 1 分 K 聚合為日 K（近 ' + n + ' 個交易日）；紅漲綠跌，均線 MA5/MA20/MA60。</div>';
}

function _chartBindDayHover(bars) {
  var svg = document.querySelector('#chart-area .chart-svg');
  var hit = document.getElementById('ckd-hit'), cross = document.getElementById('ckd-cross'), tip = document.getElementById('ckd-tip');
  if (!svg || !hit || !cross || !tip) return;
  var s0 = Math.max(0, bars.length - CHART_DAY_SHOW), view = bars.slice(s0), n = view.length;
  var PAD_L = 58, PW = 860 - 58 - 12, step = PW / n;
  var base = tip.innerHTML;
  hit.addEventListener('mousemove', function (ev) {
    var vx = _chartVX(svg, ev.clientX);
    if (vx == null) return;
    var k = Math.floor((vx - PAD_L) / step);
    if (k < 0) k = 0; if (k > n - 1) k = n - 1;
    var xx = PAD_L + step * (k + 0.5);
    cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.style.display = '';
    var b = view[k], up = b.c >= b.o, cls = up ? 'up' : 'down';
    var prev = k > 0 ? view[k - 1].c : b.o;
    var dc = b.c - prev, dp = prev ? dc / prev * 100 : 0;
    tip.innerHTML = b.d.slice(5).replace('-', '/') +
      '　開 <b>' + b.o.toFixed(2) + '</b> 高 <b>' + b.h.toFixed(2) + '</b> 低 <b>' + b.l.toFixed(2) + '</b> 收 <b class="' + cls + '">' + b.c.toFixed(2) + '</b>' +
      ' <span class="' + cls + '">(' + (dc >= 0 ? '+' : '') + dp.toFixed(2) + '%)</span>　量 <b>' + Math.round(b.v).toLocaleString('zh-TW') + '</b>';
  });
  hit.addEventListener('mouseleave', function () { cross.style.display = 'none'; tip.innerHTML = base; });
}

// 滑鼠移動：十字線定位到最近的分鐘，標題列即時顯示該分鐘時間/價/量；移出還原五日區間摘要
function _chartBindHover(d) {
  var svg = document.querySelector('#chart-area .chart-svg');
  var hit = document.getElementById('ck-hit'), cross = document.getElementById('ck-cross'), tip = document.getElementById('ck-tip');
  if (!svg || !hit || !cross || !tip) return;
  var n = d.close.length, PAD_L = 58, PW = 860 - 58 - 12;
  var base = tip.innerHTML;
  hit.addEventListener('mousemove', function (ev) {
    var vx = _chartVX(svg, ev.clientX);
    if (vx == null) return;
    var i = Math.round((vx - PAD_L) / PW * (n - 1));
    if (i < 0) i = 0; if (i > n - 1) i = n - 1;
    var x = PAD_L + (n === 1 ? PW / 2 : i * PW / (n - 1));
    cross.setAttribute('x1', x); cross.setAttribute('x2', x);
    cross.style.display = '';
    var t = d.dts[i], prev = i > 0 ? d.close[i - 1] : d.close[i];
    var cls = d.close[i] >= prev ? 'up' : 'down';
    tip.innerHTML = t.slice(5, 10).replace('-', '/') + ' ' + t.slice(11, 16) +
      '　收 <b class="' + cls + '">' + d.close[i].toFixed(2) + '</b>　量 <b>' + d.vol[i].toLocaleString('zh-TW') + '</b>';
  });
  hit.addEventListener('mouseleave', function () {
    cross.style.display = 'none';
    tip.innerHTML = base;
  });
}

// 五日線 SVG：上價格折線（日分隔線＋昨收虛線）、下成交量長條
function _chart5dSvg(d, code) {
  var W = 860, H = 300, VH = 90, PAD_L = 58, PAD_R = 12, PAD_T = 12, GAP = 26;
  var PW = W - PAD_L - PAD_R;              // 繪圖區寬
  var PH = H - VH - GAP - PAD_T;           // 價格區高
  var n = d.close.length;
  if (!n) return '<div class="modal-loading">無資料</div>';

  var ct = _contracts[code] || {};
  var ref = ct.reference != null ? ct.reference : null;   // 昨收（5日前的基準無意義，僅供最後一日參考）
  var lo = Math.min.apply(null, d.close), hi = Math.max.apply(null, d.close);
  if (ref != null && ref > 0 && ref >= lo * 0.8 && ref <= hi * 1.2) { lo = Math.min(lo, ref); hi = Math.max(hi, ref); }
  var pad = (hi - lo) * 0.08 || 1;
  lo -= pad; hi += pad;
  var vmax = Math.max.apply(null, d.vol) || 1;

  var x = function (i) { return PAD_L + (n === 1 ? PW / 2 : i * PW / (n - 1)); };
  var y = function (p) { return PAD_T + (hi - p) * PH / (hi - lo); };
  var vy = function (v) { return PAD_T + PH + GAP + VH - v * VH / vmax; };

  // 日界線位置與標籤
  var dayStart = [], prevDay = '';
  d.dts.forEach(function (t, i) { var dd = t.slice(0, 10); if (dd !== prevDay) { dayStart.push({ i: i, day: dd }); prevDay = dd; } });

  var s = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';

  // 價格區水平格線＋Y 軸標籤（5 等分）
  for (var g = 0; g <= 4; g++) {
    var pv = hi - (hi - lo) * g / 4, yy = y(pv);
    s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + yy.toFixed(1) + '"/>' +
      '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end">' + pv.toFixed(2) + '</text>';
  }
  // 昨收虛線
  if (ref != null && ref >= lo && ref <= hi) {
    s += '<line class="ck-ref" x1="' + PAD_L + '" y1="' + y(ref).toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + y(ref).toFixed(1) + '"/>';
  }
  // 日分隔線＋日期標籤
  dayStart.forEach(function (ds, k) {
    var xx = x(ds.i);
    if (k > 0) s += '<line class="ck-sep" x1="' + xx.toFixed(1) + '" y1="' + PAD_T + '" x2="' + xx.toFixed(1) + '" y2="' + (PAD_T + PH + GAP + VH) + '"/>';
    var mid = x(k + 1 < dayStart.length ? (ds.i + dayStart[k + 1].i) / 2 : (ds.i + n - 1) / 2);
    s += '<text class="ck-axis" x="' + mid.toFixed(1) + '" y="' + (H - 2) + '" text-anchor="middle">' + ds.day.slice(5).replace('-', '/') + '</text>';
  });

  // 成交量長條（依該分鐘漲跌上色：與前一分鐘比）
  var barW = Math.max(0.7, PW / n * 0.8);
  for (var i = 0; i < n; i++) {
    if (!d.vol[i]) continue;
    var up = i === 0 ? true : d.close[i] >= d.close[i - 1];
    var vh = Math.max(0.6, d.vol[i] * VH / vmax);
    s += '<rect class="ck-vol ' + (up ? 'up' : 'dn') + '" x="' + (x(i) - barW / 2).toFixed(1) + '" y="' + vy(d.vol[i]).toFixed(1) +
      '" width="' + barW.toFixed(1) + '" height="' + vh.toFixed(1) + '"/>';
  }

  // 價格折線（收盤價；漲綠跌紅依全期首尾）
  var pts = [];
  for (var j2 = 0; j2 < n; j2++) pts.push(x(j2).toFixed(1) + ',' + y(d.close[j2]).toFixed(1));
  var rise = d.close[n - 1] >= d.close[0];
  s += '<polyline class="ck-line ' + (rise ? 'up' : 'dn') + '" points="' + pts.join(' ') + '"/>';

  // 量區頂線
  s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + (PAD_T + PH + GAP) + '" x2="' + (W - PAD_R) + '" y2="' + (PAD_T + PH + GAP) + '"/>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (PAD_T + PH + GAP + 10) + '" text-anchor="end">' + vmax.toLocaleString('zh-TW') + '</text>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (PAD_T + PH + GAP + VH) + '" text-anchor="end">量</text>';

  // 互動：滑鼠移動顯示該分鐘價量
  s += '<rect id="ck-hit" x="' + PAD_L + '" y="' + PAD_T + '" width="' + PW + '" height="' + (PH + GAP + VH) + '" fill="transparent"/>' +
    '<line id="ck-cross" class="ck-cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (PAD_T + PH + GAP + VH) + '" style="display:none"/>' +
    '</svg>';

  var last = d.close[n - 1], first = d.close[0];
  var chg = last - first, pct = first ? chg / first * 100 : 0;
  var cls = chg >= 0 ? 'up' : 'down';
  return '<div class="chart-info"><span id="ck-tip">' +
      '五日區間 <b>' + first.toFixed(2) + '</b> → <b>' + last.toFixed(2) + '</b>　' +
      '<span class="' + cls + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '（' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%）</span>' +
    '</span></div>' + s +
    '<div class="detail-note">Shioaji 1 分 K，近 5 個交易日串接；虛線為昨收。量長條顏色依該分鐘較前一分鐘漲跌。</div>';
}
