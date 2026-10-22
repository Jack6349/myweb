// 股利總管 Web — 個股線圖彈窗（即時行情點卡片開啟）
// 頁籤一：五日線＋成交量（Shioaji kbars 1 分 K，5 個交易日串接，含日分隔線）
// 頁籤二：日線（待開發）
// 繪圖用內嵌 SVG（專案無圖表函式庫、無建置流程）；資料每檔快取，同日重開不重抓

var _chartCode = null;
var _chartTab = 'd5';
var CHART_TAB_LS = 'chart_tab_v1';
// 頁籤代碼：intra／bid／d5，再加上 CHART_PERIODS 的五個期間代碼（1mo…5y）。
// 期間不另外分一層：日 K 的五個期間就是五個頁籤，不必先點「日線」再點期間。
function _chartIsPer(t) { return _chartPerDef(t || ''); }
function _chartSavedTab() {
  try {
    var t = localStorage.getItem(CHART_TAB_LS);
    if (/^(intra|bid|d5)$/.test(t || '') || _chartIsPer(t)) return t;
    if (t === 'day') return '3mo';        // 舊版記憶的「日線」對應到預設期間
  } catch (e) {}
  return 'intra';
}
function _chartTabList() {
  return ['intra', 'bid', 'd5'].concat(CHART_PERIODS.map(function (p) { return p.k; }));
}
var _chartCache = {};   // code → { day, dts, close, vol, ref }

// 日線頁籤的期間。來源分兩邊，因為兩邊的成本差了三個量級（實測 00918）：
//   kbars 固定 1 分 K，前端聚合成日 K。一年 3.54MB／1.4 秒、五年 11.02MB／27.2 秒 — 彈窗裡不能接受。
//   Yahoo 日 K（走 GAS 代理，與 refill.js 同一條路）一年 27KB、五年 102KB，耗時全部落在 1.2–2.3 秒，
//   那是代理往返的固定成本，跟資料量無關。
// 所以：近月、三月用本機 kbars（0.1 秒，比代理更快），而且兩者共用同一筆 240 日曆天的快取，
// 切期間不重抓；六月以上走 Yahoo。
// 實測對帳：兩邊收盤價一致（0050 10/20 107.25 對 107.25、10/22 107.10 對 107.10），
// 但 Yahoo 有缺日（2026-10-21 三檔皆為 null），所以要濾空值。
// 量的單位不同：Yahoo 是股、kbars 是張（實測比值 1001.8），載入時除 1000 歸一。
// line：超過約 240 根時每根寬小於 3.3px，蠟燭的影線與實體已經分辨不出來，改畫收盤折線。
// 六月／一年／五年共用同一條五年序列，切期間只是切片，不重抓。
// 為什麼不各抓各的長度：成本幾乎全在代理往返，不在資料量（1mo 3.3KB／2.05 秒
// 對 5y 102KB／2.03 秒），所以一次抓滿、三個期間共用，比抓三次短的划算。
// 五個期間畫走勢（收盤折線＋漸層填滿＋下方量），日K 是最後一個頁籤、畫開高低收蠟燭＋均線。
// kmode 決定畫法，其餘欄位（來源、顯示根數）與期間共用同一套流程。
// 日K 取 90 個交易日：kbars 那一筆 240 日曆天約 157 個交易日，前面剩下的供 MA60 暖身。
var CHART_PERIODS = [
  { k: '1mo', lb: '近月', src: 'kbars', show: 21, line: false },
  { k: '3mo', lb: '三月', src: 'kbars', show: 64, line: false },
  { k: '6mo', lb: '六月', src: 'yahoo', show: 126, line: false },
  { k: '1y', lb: '一年', src: 'yahoo', show: 243, line: true },
  { k: '5y', lb: '五年', src: 'yahoo', show: 99999, line: true },
  { k: 'k', lb: '日K', src: 'kbars', show: 90, line: false, kmode: true }
];
var CHART_Y_RANGE = '5y';          // 一次抓滿的長度
var CHART_DK_LS = 'chart_dayk_v1:';   // 瀏覽器快取的 key 前綴（後面接代碼）
var _chartDaySrc = '';             // 這次的日 K 從哪一層來的，顯示在說明列
var CHART_PER_LS = 'chart_period_v1', CHART_ADJ_LS = 'chart_adj_v1';
var _chartPer = null;              // 目前期間（或日K）的定義物件
var _chartAdjOn = null;            // 是否還原權值（僅 Yahoo 來源有意義）

function _chartPerDef(k) {
  for (var i = 0; i < CHART_PERIODS.length; i++) if (CHART_PERIODS[i].k === k) return CHART_PERIODS[i];
  return null;
}
function _chartSavedPer() {
  try { var k = localStorage.getItem(CHART_PER_LS); if (_chartPerDef(k)) return _chartPerDef(k); } catch (e) {}
  return _chartPerDef('3mo');
}
// 還原價預設開：六月以上的線每除一次息就往下跳一格，高配息 ETF 的長期線會被壓成沒漲。
// 實測 00918：五年前收盤 15.00、還原後 9.75，差的就是這三年的配息。
function _chartSavedAdj() {
  try { var v = localStorage.getItem(CHART_ADJ_LS); if (v === '0') return false; if (v === '1') return true; } catch (e) {}
  return true;
}

function openChartPop(code) {
  _chartCode = String(code);
  _chartTab = _chartSavedTab();
  var c = _contracts[_chartCode];
  document.getElementById('detail-title').textContent =
    _chartCode + ' ' + ((c && c.name) || '') + ' — 線圖';
  var modal = document.getElementById('detail-modal');
  modal.style.display = 'flex';
  // 線圖用加大版面（其他彈窗維持原尺寸）：關閉時由 closeDetailModal 還原
  var box = modal.querySelector('.modal-box');
  if (box) box.classList.add('chart-wide');
  _chartRenderShell();
  chartShowTab(_chartTab);   // 上次看的頁籤（五檔頁籤會照常訂閱，關窗即退訂）
}

function _chartRenderShell() {
  document.getElementById('detail-body').innerHTML =
    '<div class="tx-subtabs chart-tabs">' +
      [['intra', '日均'], ['bid', '五檔'], ['d5', '五日線']]
        .concat(CHART_PERIODS.map(function (p) { return [p.k, p.lb]; }))
        .map(function (a) {
          return '<button id="chart-tab-' + a[0] + '" class="tx-subtab' + (_chartIsPer(a[0]) ? ' tx-sub-per' : '') + '" onclick="chartShowTab(&quot;' + a[0] + '&quot;)">' +
            a[1] + '</button>';
        }).join('') +
    '</div><div id="chart-area"></div>';
}

function chartShowTab(tab) {
  var per = _chartIsPer(tab);
  _chartTab = tab;
  try { localStorage.setItem(CHART_TAB_LS, tab); } catch (e) {}
  _chartTabList().forEach(function (t) {
    var el = document.getElementById('chart-tab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  if (tab !== 'bid') _chartStopBidAsk();     // 離開五檔頁籤即退訂，省行情訂閱額度
  _chartEnsureLiveTimer();
  if (tab === 'intra') return _chartLoadIntra();
  if (tab === 'bid') return _chartLoadBidAsk();
  if (tab === 'd5') return _chartLoad5d();
  _chartPer = per;
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

// ── 頁籤一：日均（當日分時走勢＋均價線 VWAP＋成交量＋完整報價面板）──
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

  // X 軸固定為整個交易時段 09:00–13:30（不隨當前時間縮放）；資料只填到現在，右側留白
  var SESS_S = 540, SESS_E = 810; // 分鐘
  var _tmin = function (t) { return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10); };
  var x = function (k) { return PAD_L + (_tmin(b.t[k]) - SESS_S) / (SESS_E - SESS_S) * PW; };
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
  // X 軸固定整點格線 09~13（位置依時段比例，與資料多寡無關）
  for (var hh = 9; hh <= 13; hh++) {
    var xg = PAD_L + (hh * 60 - SESS_S) / (SESS_E - SESS_S) * PW;
    if (hh > 9) s += '<line class="ck-grid" x1="' + xg.toFixed(1) + '" y1="' + PAD_T + '" x2="' + xg.toFixed(1) + '" y2="' + (PAD_T + PH) + '"/>';
    s += '<text class="ck-axis" x="' + xg.toFixed(1) + '" y="' + (H - 2) + '" text-anchor="middle">' + String(hh).padStart(2, '0') + '</text>';
  }
  // 量條（寬度依每分鐘間距，不隨資料筆數變化）
  var bw = Math.max(0.6, PW / (SESS_E - SESS_S) * 0.7);
  for (var k2 = 0; k2 < n; k2++) {
    if (!b.v[k2]) continue;
    s += '<rect class="ck-ivol" x="' + (x(k2) - bw / 2).toFixed(1) + '" y="' + vy(b.v[k2]).toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.6, b.v[k2] * VH / vmax).toFixed(1) + '"/>';
  }
  // 價格線＋填色以昨收為界分段上色：高於昨收＝紅、低於＝綠，跨越昨收處精確切分（同券商 App）
  var yRef = y(ref), k3;
  var redFill = '', dnFill = '', redLn = '', dnLn = '';
  var seg = function (xa, ya, xb, yb, red) {
    var ln = 'M' + xa.toFixed(1) + ' ' + ya.toFixed(1) + 'L' + xb.toFixed(1) + ' ' + yb.toFixed(1);
    var fl = 'M' + xa.toFixed(1) + ' ' + ya.toFixed(1) + 'L' + xb.toFixed(1) + ' ' + yb.toFixed(1) +
      'L' + xb.toFixed(1) + ' ' + yRef.toFixed(1) + 'L' + xa.toFixed(1) + ' ' + yRef.toFixed(1) + 'Z';
    if (red) { redLn += ln; redFill += fl; } else { dnLn += ln; dnFill += fl; }
  };
  for (k3 = 0; k3 < n - 1; k3++) {
    var ca = b.c[k3], cb = b.c[k3 + 1], xa = x(k3), xb = x(k3 + 1);
    if ((ca >= ref) === (cb >= ref)) {
      seg(xa, y(ca), xb, y(cb), ca >= ref);
    } else {
      var xc = xa + (xb - xa) * (ref - ca) / (cb - ca);   // 與昨收線交點
      seg(xa, y(ca), xc, yRef, ca >= ref);
      seg(xc, yRef, xb, y(cb), cb >= ref);
    }
  }
  if (dnFill) s += '<path class="ck-fill dn" d="' + dnFill + '"/>';
  if (redFill) s += '<path class="ck-fill up" d="' + redFill + '"/>';
  if (dnLn) s += '<path class="ck-iline dn" d="' + dnLn + '"/>';
  if (redLn) s += '<path class="ck-iline up" d="' + redLn + '"/>';
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
  var SESS_S = 540, SESS_E = 810;
  var _tmin = function (t) { return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10); };
  var base = tip.innerHTML;
  var ct = _contracts[_chartCode] || {}, ref = ct.reference || b.c[0];
  hit.addEventListener('mousemove', function (ev) {
    var vx = _chartVX(svg, ev.clientX);
    if (vx == null) return;
    // 反推游標對應的時間，找最接近的那根分 K（X 軸為固定時段，非等距索引）
    var tgt = SESS_S + (vx - PAD_L) / PW * (SESS_E - SESS_S);
    var k = 0, best = Infinity;
    for (var i = 0; i < n; i++) { var dd = Math.abs(_tmin(b.t[i]) - tgt); if (dd < best) { best = dd; k = i; } }
    var xx = PAD_L + (_tmin(b.t[k]) - SESS_S) / (SESS_E - SESS_S) * PW;
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
var _bidHL = null;   // { code, high, low }：五檔標 H／L 用
function _bidHLUpdate(code, hi, lo) {
  if (code !== _chartCode) return;
  if (!_bidHL || _bidHL.code !== code) _bidHL = { code: code, high: null, low: null };
  var changed = false;
  if (hi > 0 && (_bidHL.high == null || hi > _bidHL.high)) { _bidHL.high = hi; changed = true; }
  if (lo > 0 && (_bidHL.low == null || lo < _bidHL.low)) { _bidHL.low = lo; changed = true; }
  if (changed && _bidLast) {
    var wrap = document.getElementById('bid-wrap');
    if (wrap) wrap.innerHTML = _bidAskHtml(_bidLast, code);
  }
}

async function _chartLoadBidAsk() {
  var area = document.getElementById('chart-area');
  var code = _chartCode;
  _bidLast = null;
  _bidHL = null;
  _ticks = [];
  fetchSnapshots([_contracts[code] || { exchange: 'TSE', code: code }]).then(function (sn) {
    var x = (sn || [])[0];
    if (x) _bidHLUpdate(code, +x.high, +x.low);
  }).catch(function () {});
  // 左右並排：五檔（掛單）在左、逐筆（成交）在右。
  // 兩者原本上下排會超出彈窗高度需捲動，但各自都用不到全寬 → 改用橫向分欄消化寬度。
  area.innerHTML = '<div class="bid-cols">' +
    '<div id="bid-wrap" class="bid-col-l">' + _bidAskHtml(null, code) + '</div>' +
    '<div id="tick-wrap" class="bid-col-r">' + _tickHtml() + '</div></div>';
  try {
    var ct = _contracts[code] || {};
    // 同時訂閱 BidAsk（掛單）與 Tick（成交）：五檔看掛單、逐筆看成交，兩者一起才完整
    await fetch(API + '/api/v1/stream/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_type: 'STK', exchange: ct.exchange || 'TSE', code: code, quote_type: 'BidAsk' })
    });
    _bidSubCode = code;
    await fetch(API + '/api/v1/stream/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_type: 'STK', exchange: ct.exchange || 'TSE', code: code, quote_type: 'Tick' })
    });
    _tickSubCode = code;
  } catch (e) { console.warn('[bidask/tick subscribe]', e); }
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
  // 先用歷史逐筆填滿（盤後也看得到內容），再由 SSE 即時往上疊新成交
  _chartLoadTickHistory(code);
  _chartStartTickStream();
}

// ── 逐筆成交 ──
// A：進頁時以 ticks API 取當日逐筆，只留最後 TICK_N 筆（盤後仍有內容可看）
// B：訂閱 Tick → SSE tick_stk，新成交即時插到最上方
// 兩者並用的原因：純即時在盤後是空的、純歷史則不會跳動
var TICK_N = 10;
var _tickEs = null, _tickSubCode = null, _ticks = [];
var _tickHistLoading = false;

async function _chartLoadTickHistory(code) {
  _tickHistLoading = true;
  _tickRender();
  try {
    var ct = _contracts[code] || {};
    var day = (typeof _divTwDate === 'function') ? _divTwDate().iso
      : new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    var r = await fetch(API + '/api/v1/data/ticks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: { security_type: 'STK', exchange: ct.exchange || 'TSE', code: code }, date: day })
    });
    if (!r.ok) throw new Error('ticks HTTP ' + r.status);
    var j = await r.json();
    var dt = j.datetime || [];
    var n = dt.length;
    if (code !== _chartCode) return;                    // 期間已切換標的 → 丟棄
    var out = [];
    for (var i = Math.max(0, n - TICK_N); i < n; i++) {
      out.push({
        t: String(dt[i]).slice(11, 19),
        price: (j.close || [])[i] != null ? Number((j.close || [])[i]) : null,
        vol: (j.volume || [])[i],
        type: (j.tick_type || [])[i],
        // 13:30:00＝收盤集合競價、14:30:00＝盤後定價，量常是全日最大，標記避免誤讀
        mark: String(dt[i]).indexOf('T13:30:00') >= 0 ? '收盤'
          : (String(dt[i]).indexOf('T14:30:00') >= 0 ? '盤後' : '')
      });
    }
    out.reverse();                                      // 最新在最上（與券商 App 一致）
    _ticks = out;
  } catch (e) {
    console.warn('[ticks history]', e);
  } finally {
    _tickHistLoading = false;
    if (code === _chartCode) _tickRender();
  }
}

function _chartStartTickStream() {
  if (_tickEs) { _tickEs.close(); _tickEs = null; }
  _tickEs = new EventSource(API + '/api/v1/stream/data/tick_stk');
  _tickEs.addEventListener('tick_stk', function (ev) {
    try {
      var d = JSON.parse(ev.data);
      if (d.code !== _chartCode || d.simtrade) return;
      // 即時推送的欄位格式與歷史 API 不同：time 是 "09:05:23.256835"（無日期、無 T），
      // 且 close/價格為「字串」→ 需自行取 HH:MM:SS 並轉數字，否則時間切錯、toFixed 會噴錯
      var tv = String(d.time || '');
      var hhmmss = /^\d{2}:\d{2}:\d{2}/.test(tv) ? tv.slice(0, 8) : String(d.datetime || '').slice(11, 19);
      _ticks.unshift({
        t: hhmmss,
        price: (d.close != null && d.close !== '') ? Number(d.close) : null,
        vol: d.volume, type: d.tick_type,
        mark: d.intraday_odd ? '零股' : '', live: true
      });
      if (_ticks.length > TICK_N) _ticks.length = TICK_N;
      _tickRender();
      if (!d.intraday_odd) {
        var px = Number(d.close);
        _bidHLUpdate(d.code, d.high != null ? Number(d.high) : px, d.low != null ? Number(d.low) : px);
      }
    } catch (e) {}
  });
}

function _chartStopTickStream() {
  if (_tickEs) { _tickEs.close(); _tickEs = null; }
  if (_tickSubCode) {
    var ct = _contracts[_tickSubCode] || {};
    fetch(API + '/api/v1/stream/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_type: 'STK', exchange: ct.exchange || 'TSE', code: _tickSubCode, quote_type: 'Tick' })
    }).catch(function () {});
    _tickSubCode = null;
  }
}

function _tickRender() {
  var w = document.getElementById('tick-wrap');
  if (w) w.innerHTML = _tickHtml();
}

// tick_type：1＝外盤（買方成交，紅）、2＝內盤（賣方成交，綠）、0/其他＝無法判定
function _tickHtml() {
  var h = '<div class="sub-title">逐筆成交 <span class="tick-dim">最近 ' + TICK_N +
    ' 筆　紅＝外盤（買方主動）、綠＝內盤（賣方主動）</span></div>';
  if (_tickHistLoading && !_ticks.length) return h + '<div class="modal-loading">載入逐筆成交…</div>';
  if (!_ticks.length) return h + '<div class="modal-loading">今日尚無成交紀錄</div>';
  h += '<table class="tick-table"><thead><tr><th>時間</th><th class="num">成交價</th>' +
    '<th class="num">單量</th><th>內外盤</th></tr></thead><tbody>';
  _ticks.forEach(function (k) {
    var cls = k.type === 1 ? 'up' : (k.type === 2 ? 'down' : 'flat');
    var side = k.type === 1 ? '外盤' : (k.type === 2 ? '內盤' : '—');
    h += '<tr' + (k.live ? ' class="tick-new"' : '') + '>' +
      '<td class="tick-t">' + (k.t || '—') + '</td>' +
      '<td class="num ' + cls + '">' + (k.price != null ? k.price.toFixed(2) : '—') + '</td>' +
      '<td class="num">' + (k.vol != null ? k.vol.toLocaleString('zh-TW') : '—') + '</td>' +
      '<td class="' + cls + '">' + side + (k.mark ? ' <span class="tick-mark">' + k.mark + '</span>' : '') + '</td>' +
    '</tr>';
  });
  return h + '</tbody></table>';
}

function _chartStopBidAsk() {
  _chartStopTickStream();      // 逐筆與五檔同頁籤，一起退訂才不會佔著行情額度
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

// 五檔表：左右兩欄深度對照（買盤左、賣盤右，各 5 檔，買1/賣1 在最上）
// 版面 左→右：〔量條→買量→買價 ‖ 賣價→賣量→量條〕；量條在最外側、價格在中央面對面
// 顏色（同券商 App）：價格與昨收比，高於紅、平盤黃、低於綠；買賣量黃。
// 標記：等於當日最高價標紅色 H、最低價標綠色 L，放在量條欄最外側（買盤最左、賣盤最右，與量條隔一個字元）；等於最新成交價加黃底線。
// 漲跌停鎖住時的兩種 0：
//   價 0、量 > 0 → 市價單排隊。漲停鎖死時買方第一檔就是它，跌停則出現在賣方。
//     實例 2026-10-16 的 2380 虹光漲停 18.85：bid_price[0]=0、bid_volume[0]=44。
//     照原本的寫法會印成「0.00」，還因為 0 < 昨收而上綠色，讀起來像有人掛 0 元買。
//   價 0、量 0 → 這一檔根本沒有單。漲停鎖死時賣方五檔全是這種。
// 所以不能用 != null 判斷有沒有這一檔，要看價與量。
function _bidAskHtml(b, code) {
  var r = _rows[code] || {}, ct = _contracts[code] || {}, ref = ct.reference;
  var dealCls = (r.close != null && ref != null) ? (r.close > ref ? 'up' : (r.close < ref ? 'down' : 'flat')) : '';
  var head = '<div class="bid-head">' +
    '<span>成交 <b class="' + dealCls + '">' + (r.close != null ? r.close.toFixed(2) : '—') + '</b></span>' +
    '<span>昨收 ' + (ref != null ? ref.toFixed(2) : '—') + '</span>' +
    '<span>總量 ' + (r.total_volume != null ? r.total_volume.toLocaleString('zh-TW') : '—') + '</span>' +
    '<span class="bid-time">' + (b ? (b.time || '').slice(0, 8) : (r.time || '')) + '</span></div>';

  if (!b) {
    var live = (typeof _twMarketLive === 'function') && _twMarketLive();
    return head + '<div class="modal-loading">' +
      (live ? '等待五檔推送…（盤中約 1–2 秒內出現）' : '目前非盤中時段，無即時五檔推送') +
      '</div>' + _bidSnapNote();
  }
  var bp = b.bid_price || [], bv = b.bid_volume || [], ap = b.ask_price || [], av = b.ask_volume || [];
  // 'px'＝一般限價檔、'mkt'＝市價單排隊（價 0 量 >0）、'none'＝沒有這一檔
  var lvl = function (px, v) {
    if (px == null) return 'none';
    if (+px > 0) return 'px';
    return (v > 0) ? 'mkt' : 'none';
  };
  var dbv = b.diff_bid_vol || [], dav = b.diff_ask_vol || [];
  var maxV = 1;
  bv.concat(av).forEach(function (v) { if (v > maxV) maxV = v; });
  var diff = function (d) { return d ? '<span class="bid-diff ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + d + '</span>' : ''; };
  var barW = function (v) { return (v / maxV * 100).toFixed(1); };
  var hl = (_bidHL && _bidHL.code === code) ? _bidHL : {};
  var same = function (a, b2) { return a != null && b2 != null && Math.abs(a - b2) < 1e-6; };
  // H／L 標記：沒有標記時仍留空位，各列量條的起點才會對齊
  var mark = function (raw) {
    var p = parseFloat(raw);
    return same(p, hl.high) ? '<span class="bid-hl up">H</span>' : (same(p, hl.low) ? '<span class="bid-hl down">L</span>' : '<span class="bid-hl"></span>');
  };
  // 量條欄：買盤〔標記｜量條靠右〕、賣盤〔量條靠左｜標記〕
  var barCell = function (has, v, raw, side) {
    if (!has) return '<td class="bid-bar-cell"></td>';
    var bar = '<span class="bid-bar-track"><span class="bid-bar ' + (side === 'buy' ? 'bid' : 'ask') + '" style="width:' + barW(v) + '%"></span></span>';
    return '<td class="bid-bar-cell"><div class="bid-bar-wrap">' + (side === 'buy' ? mark(raw) + bar : bar + mark(raw)) + '</div></td>';
  };
  var pxCell = function (raw, side, kind) {
    if (kind === 'mkt') {
      // 市價沒有價位可點，不給下單；顏色也不走紅綠，它不是一個價格
      return '<td class="num bid-px ' + side + ' bid-mkt" title="市價單排隊（漲跌停鎖住時出現）">市價</td>';
    }
    var p = parseFloat(raw);
    var cls = ref == null ? 'bid-flat' : (p > ref + 1e-6 ? 'up' : (p < ref - 1e-6 ? 'down' : 'bid-flat'));
    var txt = '<span class="bid-pxv' + (same(p, r.close) ? ' bid-last' : '') + '">' + p.toFixed(2) + '</span>';
    // 點價下單：買方欄預設買進、賣方欄預設賣出，另一邊在確認框一鍵切換
    var tap = (typeof ordFromLadder === 'function')
      ? ' bid-tap" onclick="ordFromLadder(\'' + code + '\',' + p + ',\'' + side + '\')" title="點選下單"' : '"';
    return '<td class="num bid-px ' + side + ' ' + cls + tap + '>' + txt + '</td>'; }; // 內外盤比 Bar（移到最上方、加高，兩側放張數與百分比） var sumB = 0, sumA = 0; bv.forEach(function (v) { sumB += v; }); av.forEach(function (v) { sumA += v; }); var tot = sumB + sumA || 1, pB = sumB / tot * 100, pA = sumA / tot * 100; var ratio = '<div class="bid-ratio">' +
    '<span class="bid-ratio-lbl">委買</span>' +
    '<span class="bid-ratio-side left"><b class="y">' + sumB.toLocaleString('zh-TW') + '</b>（' + pB.toFixed(1) + '%）</span>' +
    '<span class="bid-ratio-bar"><i class="bid" style="width:' + pB.toFixed(1) + '%"></i><i class="ask" style="width:' + pA.toFixed(1) + '%"></i></span>' +
    '<span class="bid-ratio-side right">（' + pA.toFixed(1) + '%）<b class="y">' + sumA.toLocaleString('zh-TW') + '</b></span>' +
    '<span class="bid-ratio-lbl">委賣</span>' +
    '</div>';

  // 五列：買 i／賣 i 同列（i=0 為最佳買賣，置頂）
  var rows = '';
  for (var i = 0; i < 5; i++) {
    var kB = lvl(bp[i], bv[i]), kA = lvl(ap[i], av[i]);
    var hasB = kB !== 'none', hasA = kA !== 'none';
    rows += '<tr class="bid-row">' +
      // 買盤（左）：量條 → 買量 → 買價
      barCell(hasB, bv[i], bp[i], 'buy') +
      '<td class="num bid-vol">' + (hasB ? diff(dbv[i]) + (bv[i] || 0).toLocaleString('zh-TW') : '') + '</td>' +
      (hasB ? pxCell(bp[i], 'buy', kB) : '<td class="num bid-px buy"></td>') +
      // 賣盤（右）：賣價 → 賣量 → 量條
      (hasA ? pxCell(ap[i], 'sell', kA) : '<td class="num bid-px sell"></td>') +
      '<td class="num bid-vol">' + (hasA ? diff(dav[i]) + (av[i] || 0).toLocaleString('zh-TW') : '') + '</td>' +
      barCell(hasA, av[i], ap[i], 'sell') +
      '</tr>';
  }
  return head + ratio +
    '<table class="bid-table"><thead><tr>' +
      '<th colspan="3" class="bid-side-h buy">買盤</th><th colspan="3" class="bid-side-h sell">賣盤</th></tr>' +
      '<tr><th></th><th class="num">買量</th><th class="num">買價</th><th class="num">賣價</th><th class="num">賣量</th><th></th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    _bidSnapNote();
}
function _bidSnapNote() {
  return '<div class="detail-note">Shioaji BidAsk 逐筆推送（僅本頁籤開啟時訂閱，切換或關閉即退訂以節省 200 檔訂閱額度）。小字為較前一筆的量增減。</div>';
}

// ── 盤中自動更新：只重抓「今日」分 K 併入既有資料（今日約 266 根、~17KB），不重抓整段 ──
var _chartLiveTimer = null, _chartTick = 0;
function _chartEnsureLiveTimer() {
  if (_chartLiveTimer) return;
  _chartLiveTimer = setInterval(function () {
    if (!_chartCode) return _chartStopLiveTimer();               // 彈窗已關
    if (typeof _twMarketLive === 'function' && !_twMarketLive()) return; // 非盤中不動作
    _chartTick++;
    // 即時行情：每 12 秒更新價格線/報價面板（僅當日分 K，輕量）；內外盤較重，每 5 次(60s)才更新
    if (_chartTab === 'intra') return _chartLoadIntraLive(_chartTick % 5 === 0);
    // 五日線/日線：資料每分鐘才增一根，每 5 次(60s)更新即可
    if ((_chartTab === 'd5' || _chartIsPer(_chartTab)) && _chartTick % 5 === 0) _chartRefreshToday();
  }, 12000);
}
function _chartStopLiveTimer() {
  if (_chartLiveTimer) { clearInterval(_chartLiveTimer); _chartLiveTimer = null; }
}
// 盤中輕量更新：只抓「今日」分 K（約 17KB）重繪價格線與報價面板；內外盤(ticks,~210KB)較重，refreshIO 時才抓
async function _chartLoadIntraLive(refreshIO) {
  var code = _chartCode, key = code + ':intra';
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
    if (!j || !j.datetime || !j.datetime.length) return;    // 開盤前今日尚無分 K → 維持原圖
    if (_chartCode !== code || _chartTab !== 'intra') return;
    var cc = _chartCache[key];
    if (!cc) return;
    var b = { day: today, t: [], c: [], v: [], amt: [] };
    for (var i = 0; i < j.datetime.length; i++) {
      b.t.push(j.datetime[i].slice(11, 16)); b.c.push(j.Close[i]); b.v.push(j.Volume[i]); b.amt.push(j.Amount[i]);
      if (b.o == null) { b.o = j.Open[i]; b.h = j.High[i]; b.l = j.Low[i]; }
      if (j.High[i] > b.h) b.h = j.High[i];
      if (j.Low[i] < b.l) b.l = j.Low[i];
    }
    cc.bars = b;
    if (refreshIO || !cc.io) cc.io = await _chartFetchIO(code, today) || cc.io;
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
      var per = _chartPer;
      if (!per) return;
      var cd = _chartCache[code + ':day:' + per.src];
      if (!cd) return;
      var bar = { d: today, o: j.Open[0], h: j.High[0], l: j.Low[0], c: j.Close[j.Close.length - 1], v: 0, ac: null };
      for (var i = 0; i < j.datetime.length; i++) {
        if (j.High[i] > bar.h) bar.h = j.High[i];
        if (j.Low[i] < bar.l) bar.l = j.Low[i];
        bar.v += j.Volume[i];
      }
      if (!document.getElementById('ckd-plot')) return;
      _chartDayRender(_chartPutToday(cd.bars, bar), code, per);
    }
  } catch (e) { console.warn('[chart live]', e); }
}

// ── 頁籤二：日線（日 K＋MA5/20/60＋成交量，期間可切）──
// 這支只服務近月／三月：kbars 無週期參數（固定 1 分 K）→ 抓約 240 日曆天分 K 於前端聚合成日 K
// （實測 2.7MB／0.8 秒，本機 server）。取得約 157 個交易日，兩個期間共用這一筆，
// 顯示 21／64 根，前面剩下的都拿來給 MA60 暖身，確保每根顯示日的均線都有效。
// 六月以上改走 _chartFetchYahoo，理由見 CHART_PERIODS 的註解。

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

// Yahoo 日 K（與 refill.js 同一條 GAS 代理路徑）。上市試 .TW、上櫃轉試 .TWO。
// 回傳 [{d,o,h,l,c,v,ac}]：ac 是還原收盤，濾掉 close 為 null 的缺日，量除 1000 改成張。
async function _chartFetchYahoo(code, range) {
  var syms = /^\d/.test(String(code)) ? [code + '.TW', code + '.TWO'] : [code];
  var err = null;
  for (var i = 0; i < syms.length; i++) {
    try {
      var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(syms[i]) +
        '?interval=1d&range=' + range;
      var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      var res = j && j.chart && j.chart.result && j.chart.result[0];
      var q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
      if (!res || !res.timestamp || !q || !q.close) throw new Error('無日 K 資料');
      var ac = ((res.indicators.adjclose && res.indicators.adjclose[0]) || {}).adjclose || null;
      var out = [];
      for (var k = 0; k < res.timestamp.length; k++) {
        if (q.close[k] == null || q.open[k] == null) continue;    // Yahoo 缺日
        out.push({ d: new Date(res.timestamp[k] * 1000).toISOString().slice(0, 10),
                   o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k],
                   v: (q.volume[k] || 0) / 1000, ac: ac ? ac[k] : null });
      }
      if (!out.length) throw new Error('無日 K 資料');
      out.sort(function (a, b) { return a.d < b.d ? -1 : 1; });
      return out;
    } catch (e) { err = e; }
  }
  throw err || new Error('無日 K 資料');
}

// ── 日 K 的三層來源 ──
// 排程產出的本機靜態檔 → 瀏覽器快取 → Yahoo。
// 會分三層是因為代理很不穩：同一條 GAS 代理實測從 2.0 秒到 23.8 秒都有，
// 而且跟資料量無關（1mo 3.3KB 要 2.05 秒、5y 102KB 要 2.03 秒），瓶頸是往返本身。
// 所以真正的解不是「少抓一點」，是「盡量不要抓」。

// 緊湊格式：價格乘 100 存整數、日期去掉分隔符。
// 實測 0050 五年 1,213 根，原樣 159 KB → 壓縮後 48 KB。
function _chartDkPack(code, bars, src) {
  var r2 = function (x) { return Math.round(x * 100); };
  return { v: 1, code: code, src: src, saved: _chartYmd(new Date()),
    d: bars.map(function (b) { return b.d.replace(/-/g, ''); }),
    o: bars.map(function (b) { return r2(b.o); }), h: bars.map(function (b) { return r2(b.h); }),
    l: bars.map(function (b) { return r2(b.l); }), c: bars.map(function (b) { return r2(b.c); }),
    a: bars.map(function (b) { return b.ac == null ? 0 : r2(b.ac); }),
    n: bars.map(function (b) { return Math.round(b.v); }) };
}
function _chartDkUnpack(o) {
  if (!o || o.v !== 1 || !o.d || !o.d.length) return null;
  var out = [];
  for (var i = 0; i < o.d.length; i++) {
    out.push({ d: o.d[i].slice(0, 4) + '-' + o.d[i].slice(4, 6) + '-' + o.d[i].slice(6),
      o: o.o[i] / 100, h: o.h[i] / 100, l: o.l[i] / 100, c: o.c[i] / 100,
      v: o.n[i], ac: o.a[i] ? o.a[i] / 100 : null });
  }
  return out;
}
function _chartDkRead(code) {
  try { return _chartDkUnpack(JSON.parse(localStorage.getItem(CHART_DK_LS + code) || 'null')); }
  catch (e) { return null; }
}
function _chartDkWrite(code, bars, src) {
  if (!bars || !bars.length) return false;
  var txt = JSON.stringify(_chartDkPack(code, bars, src));
  try { localStorage.setItem(CHART_DK_LS + code, txt); return true; } catch (e) {}
  // 配額滿了：只丟自己存的日 K，從最早存的那筆開始丟，不碰其他功能的 key
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf(CHART_DK_LS) === 0 && k !== CHART_DK_LS + code) keys.push(k);
  }
  keys.sort(function (a, b) {
    var sa = '', sb = '';
    try { sa = (JSON.parse(localStorage.getItem(a)) || {}).saved || ''; } catch (e) {}
    try { sb = (JSON.parse(localStorage.getItem(b)) || {}).saved || ''; } catch (e) {}
    return sa < sb ? -1 : 1;
  });
  while (keys.length) {
    try { localStorage.removeItem(keys.shift()); localStorage.setItem(CHART_DK_LS + code, txt); return true; }
    catch (e2) {}
  }
  return false;
}

// 上一個交易日。歷史只要補到這天就夠了 —— 今天那一根本來就會被本機分 K 蓋掉。
// 不能直接用辦公日曆判斷：補班的星期六是上班日，但股市不開。
// 所以先排掉週六日，再用辦公日曆排掉國定假日；日曆沒涵蓋到的年份就只排週末。
// 颱風假不在辦公日曆裡，碰上時序列會被當成差一天，只多付一次便宜的補丁。
function _chartPrevTradeDay() {
  var base = (typeof _divTwDate === 'function') ? _divTwDate().iso : _chartYmd(new Date());
  var d = new Date(base + 'T00:00:00Z');
  for (var i = 0; i < 20; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    var g = d.getUTCDay();
    if (g === 0 || g === 6) continue;
    var iso = d.toISOString().slice(0, 10);
    if ((typeof _divIsOff === 'function' ? _divIsOff(iso) : null) === true) continue;
    return iso;
  }
  return null;
}
function _chartDkFresh(bars, prev) {
  return !!(bars && bars.length && (!prev || bars[bars.length - 1].d >= prev));
}

// 排程（daily-k.py）產出的本機靜態檔。沒有就回 null，不當成錯誤。
async function _chartFetchStatic(code) {
  try {
    var r = await fetch('data/dayk/' + encodeURIComponent(code) + '.json', { cache: 'no-cache' });
    if (!r.ok) return null;
    return _chartDkUnpack(await r.json());
  } catch (e) { return null; }
}

// 補丁：只抓最近三個月接到舊序列後面。
// 用三月不用一月，是因為成本一樣（都是一次往返），但連假或缺日時重疊的餘裕比較大。
// 重疊日比對是必要的：Yahoo 在除息當天會把整條歷史的 adjclose 重算一次，
// 只接新資料的話舊段會停在除息前的版本，還原線會在接縫處跳一階。
// 偵測到重算、或久到沒有重疊，就回 null 要求整條重抓。
async function _chartTopUp(code, bars) {
  var patch = await _chartFetchYahoo(code, '3mo');
  if (!patch.length) return null;
  var byD = {};
  bars.forEach(function (b) { byD[b.d] = b; });
  var ovOld = null, ovNew = null;
  for (var i = 0; i < patch.length; i++) {
    if (byD[patch[i].d]) { ovOld = byD[patch[i].d]; ovNew = patch[i]; break; }
  }
  if (!ovOld) return null;
  if (ovOld.ac != null && ovNew.ac != null && Math.abs(ovOld.ac - ovNew.ac) > 0.005) return null;
  var cut = patch[0].d;
  return bars.filter(function (b) { return b.d < cut; }).concat(patch);
}

// 單一出口：決定這條五年序列從哪裡來
async function _chartDaySeries(code) {
  var prev = _chartPrevTradeDay();
  var st = await _chartFetchStatic(code);
  if (_chartDkFresh(st, prev)) { _chartDaySrc = '本機排程檔'; _chartDkWrite(code, st, 'static'); return st; }
  var ls = _chartDkRead(code);
  if (_chartDkFresh(ls, prev)) { _chartDaySrc = '瀏覽器快取'; return ls; }

  var base = null;
  if (st && st.length && ls && ls.length) base = st[st.length - 1].d >= ls[ls.length - 1].d ? st : ls;
  else base = (st && st.length) ? st : ls;

  var bars = null;
  if (base && base.length) { try { bars = await _chartTopUp(code, base); } catch (e) {} }
  if (_chartDkFresh(bars, prev)) { _chartDaySrc = '快取＋Yahoo 補丁'; }
  else { bars = await _chartFetchYahoo(code, CHART_Y_RANGE); _chartDaySrc = 'Yahoo 整條'; }
  _chartDkWrite(code, bars, 'yahoo');
  return bars;
}

// 還原權值：Yahoo 只給還原收盤，所以拿每根的 adjclose/close 比例回乘開高低。
// 最後一根的比例是 1（實測：末日收 34.56 與末日還原 34.56 相等），
// 所以盤中那根直接拿未還原的現價接上去不會接錯。
function _chartAdjBars(bars, on) {
  if (!on) return bars;
  return bars.map(function (b) {
    if (b.ac == null || !b.c) return b;
    var r = b.ac / b.c;
    if (!(r > 0) || Math.abs(r - 1) < 1e-9) return b;
    return { d: b.d, o: b.o * r, h: b.h * r, l: b.l * r, c: b.ac, v: b.v, ac: b.ac };
  });
}

// 今天那一根一律用本機分 K 算，不用 Yahoo 的。
// 實測同一時刻三個 range 的最後一根各給 107.25／107.20，本機 kbars 是 107.15 —— Yahoo 盤中的
// 日 K 是它自己的快照，會落後也會互相不一致。還原比例在最後一根是 1，所以未還原的現價
// 接在還原序列後面不會接錯（見 _chartAdjBars）。
// 回傳 null 代表今天還沒有分 K（開盤前、假日），此時沿用來源給的最後一根。
async function _chartTodayBar(code) {
  var today = _chartYmd(new Date());
  var r = await fetch(API + '/api/v1/data/kbars', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contract: { security_type: 'STK', exchange: (_contracts[code] || {}).exchange || 'TSE', code: code },
      start: today, end: today
    })
  });
  if (!r.ok) return null;
  var j = await r.json();
  if (!j || !j.datetime || !j.datetime.length) return null;
  var bar = { d: today, o: j.Open[0], h: j.High[0], l: j.Low[0], c: j.Close[j.Close.length - 1], v: 0, ac: null };
  for (var i = 0; i < j.datetime.length; i++) {
    if (j.High[i] > bar.h) bar.h = j.High[i];
    if (j.Low[i] < bar.l) bar.l = j.Low[i];
    bar.v += j.Volume[i];
  }
  return bar;
}

// 把今天那一根併進序列（同日覆寫，否則接在後面）
function _chartPutToday(bars, bar) {
  if (!bar) return bars;
  if (bars.length && bars[bars.length - 1].d === bar.d) bars[bars.length - 1] = bar;
  else bars.push(bar);
  return bars;
}

function chartSetPeriod(k) {
  if (!_chartPerDef(k) || !_chartCode) return;
  chartShowTab(k);          // 期間就是頁籤，走同一個入口
}
function chartToggleAdj() {
  _chartAdjOn = !_chartAdjOn;
  try { localStorage.setItem(CHART_ADJ_LS, _chartAdjOn ? '1' : '0'); } catch (e) {}
  _chartLoadDay();
}

// 圖上方的控制列：期間已經在頁籤列，這裡只剩還原／收盤的切換。
// 放在 #ckd-ctl、與圖區 #ckd-plot 分開，載入中不會消失。
function _chartPerBarHtml() {
  if (_chartPer.src !== 'yahoo') return '';
  return '<div class="ckd-perbar">' +
    '<button class="ckd-adj' + (_chartAdjOn ? ' active' : '') + '" onclick="chartToggleAdj()" ' +
    'title="還原價：把除息落差加回歷史價，長期線才看得出總報酬；收盤價則是實際成交價">' +
    (_chartAdjOn ? '還原價' : '收盤價') + '</button></div>';
}

async function _chartLoadDay() {
  var area = document.getElementById('chart-area');
  var code = _chartCode;
  if (!_chartPer) _chartPer = _chartIsPer(_chartTab) || _chartSavedPer();
  if (_chartAdjOn == null) _chartAdjOn = _chartSavedAdj();
  var per = _chartPer;
  if (!document.getElementById('ckd-plot')) {
    area.innerHTML = '<div id="ckd-ctl"></div><div id="ckd-plot"></div>';
  }
  document.getElementById('ckd-ctl').innerHTML = _chartPerBarHtml();
  var plot = document.getElementById('ckd-plot');
  plot.innerHTML = '<div class="modal-loading">載入' + per.lb + '日 K 中…</div>';
  try {
    var today = _chartYmd(new Date());
    // kbars 的兩個期間共用同一筆快取（240 日曆天、約 157 個交易日），切期間不重抓
    var key = code + ':day:' + per.src;          // Yahoo 的三個期間共用同一條序列
    var cc = _chartCache[key];
    if (!cc || cc.day !== today) {
      var bars, src = '';
      if (per.src === 'kbars') {
        bars = await _chartFetchDay(code);          // 已含今天
      } else {
        bars = await _chartDaySeries(code);
        src = _chartDaySrc;
        _chartPutToday(bars, await _chartTodayBar(code).catch(function () { return null; }));
      }
      cc = _chartCache[key] = { day: today, bars: bars, src: src };
    }
    _chartDaySrc = cc.src || '';
    if (_chartCode !== code || !_chartIsPer(_chartTab) || _chartPer !== per) return;   // 期間已切走
    _chartDayRender(cc.bars, code, per);
  } catch (e) {
    plot.innerHTML = '<div class="modal-loading">載入失敗：' + e.message + '</div>';
  }
}

// 畫圖與綁互動的單一出口（載入、切期間、盤中更新都走這裡）
function _chartDayRender(bars, code, per) {
  var view = _chartAdjBars(bars, per.src === 'yahoo' && _chartAdjOn);
  document.getElementById('ckd-plot').innerHTML = _chartDaySvg(view, code, per);
  _chartBindDayHover(view, per);
}

// 日線區的兩種畫法，同一組資料、同一組座標，由 per.kmode 決定：
//   走勢（近月／三月／六月／一年／五年）＝收盤折線＋橘色漸層填滿＋下方成交量，
//   與五日線同一套視覺語彙。
//   日K（自己一個頁籤，90 個交易日）＝開高低收蠟燭（紅漲綠跌實心）＋MA5/20/60。
// 長期間不給蠟燭：243 根以上每根寬不到 3.3px，影線與實體分辨不出來。
function _chartDaySvg(bars, code, per) {
  // FOOT 是日期標籤專用的一條。原本標在 H-2，而量區的底就是 H，標籤會壓在量柱上。
  var W = 860, H = 320, VH = 70, PAD_L = 58, PAD_R = 12, PAD_T = 12, GAP = 30, FOOT = 16;
  var PW = W - PAD_L - PAD_R, PH = H - VH - GAP - PAD_T - FOOT;
  var VB = PAD_T + PH + GAP + VH;        // 量區底線，也是圖面的下界
  if (!bars.length) return '<div class="modal-loading">無資料</div>';
  var kmode = !!per.kmode;

  var ma5 = _chartMA(bars, 5), ma20 = _chartMA(bars, 20), ma60 = _chartMA(bars, 60);
  var s0 = Math.max(0, bars.length - per.show);                // 顯示起點（前段供均線暖身）
  var view = bars.slice(s0), n = view.length;

  // 走勢只畫收盤，軸就只收斂到收盤的範圍，線才撐得開；日 K 要含影線與均線
  var lo = Infinity, hi = -Infinity;
  view.forEach(function (b) {
    if (kmode) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    else { if (b.c < lo) lo = b.c; if (b.c > hi) hi = b.c; }
  });
  if (kmode) {
    [ma5, ma20, ma60].forEach(function (m) {
      for (var i = s0; i < bars.length; i++) { if (m[i] == null) continue; if (m[i] < lo) lo = m[i]; if (m[i] > hi) hi = m[i]; }
    });
  }
  var pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  var vmax = 1; view.forEach(function (b) { if (b.v > vmax) vmax = b.v; });

  var step = PW / n;
  var x = function (k) { return PAD_L + step * (k + 0.5); };
  var y = function (p2) { return PAD_T + (hi - p2) * PH / (hi - lo); };
  var vy = function (v) { return VB - v * VH / vmax; };

  var s = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
    '<defs><linearGradient id="ckdgrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-opacity="0.55"/>' +
      '<stop offset="1" stop-opacity="0.03"/></linearGradient></defs>';
  // 價格格線＋Y 軸
  for (var g = 0; g <= 4; g++) {
    var pv = hi - (hi - lo) * g / 4, yy = y(pv);
    s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + yy.toFixed(1) + '"/>' +
      '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end">' + pv.toFixed(2) + '</text>';
  }
  // 時間分隔線＋標籤：根數多時每隔幾個月才標一次，否則五年會擠出六十個標籤
  var lblEvery = n > 600 ? 12 : (n > 300 ? 3 : (n > 150 ? 2 : 1));
  var prevMo = '', moIdx = -1;
  view.forEach(function (b, k) {
    var mo = b.d.slice(0, 7);
    if (mo === prevMo) return;
    prevMo = mo; moIdx++;
    if (moIdx % lblEvery) return;
    if (k > 0) s += '<line class="ck-sep" x1="' + (x(k) - step / 2).toFixed(1) + '" y1="' + PAD_T + '" x2="' + (x(k) - step / 2).toFixed(1) + '" y2="' + VB + '"/>';
    var lb = lblEvery >= 12 ? b.d.slice(0, 4) : b.d.slice(2).replace(/-/g, '/').slice(0, 5);
    s += '<text class="ck-axis" x="' + x(k).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle">' + lb + '</text>';
  });
  // 成交量
  var bw = Math.max(0.6, step * 0.62);
  view.forEach(function (b, k) {
    var up = kmode ? b.c >= b.o : (k > 0 ? b.c >= view[k - 1].c : true);
    s += '<rect class="ck-vol ' + (up ? 'up' : 'dn') + '" x="' + (x(k) - bw / 2).toFixed(1) + '" y="' + vy(b.v).toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + Math.max(0.6, b.v * VH / vmax).toFixed(1) + '"/>';
  });
  if (!kmode) {
    // 走勢：收盤折線＋自線往下填至價格區底（上濃下淡），與五日線同一套
    var lp = [];
    view.forEach(function (b, k) { lp.push(x(k).toFixed(1) + ',' + y(b.c).toFixed(1)); });
    var baseY = (PAD_T + PH).toFixed(1);
    s += '<polygon class="ckd-fill" points="' + x(0).toFixed(1) + ',' + baseY + ' ' + lp.join(' ') + ' ' + x(n - 1).toFixed(1) + ',' + baseY + '"/>' +
      '<polyline class="ckd-trend" points="' + lp.join(' ') + '"/>';
    // 標出最高、最低與最後一筆：看走勢最先想知道的就是這三個數字，
    // 游標不經過就讀不到的話，圖只能看形狀不能看值。
    // 高標在點上方、低標在下方，水平位置夾在繪圖區內避免標籤被切掉；
    // 最後一筆靠右對齊，若它本身就是高點或低點就不重複標。
    var iHi = 0, iLo = 0;
    view.forEach(function (b, k) { if (b.c > view[iHi].c) iHi = k; if (b.c < view[iLo].c) iLo = k; });
    var mk = function (k, dir, anchor) {
      var b = view[k], px = x(k);
      var tx = anchor === 'end' ? (W - PAD_R) : Math.min(Math.max(px, PAD_L + 20), W - PAD_R - 20);
      // 低點通常離價格區底不到 14px（軸只留 6% 邊距），硬壓在底線上會疊到線，
      // 所以放不下就改標在點的上方。
      var ty = (dir === 'dn' && y(b.c) + 14 <= PAD_T + PH - 2) ? y(b.c) + 14
                                                               : Math.max(y(b.c) - 7, PAD_T + 9);
      s += '<circle class="ckd-dot" cx="' + px.toFixed(1) + '" cy="' + y(b.c).toFixed(1) + '" r="2.4"/>' +
        '<text class="ckd-mk" x="' + tx.toFixed(1) + '" y="' + ty.toFixed(1) + '" text-anchor="' + (anchor || 'middle') + '">' +
        b.c.toFixed(2) + '</text>';
    };
    mk(iHi, 'up');
    if (iLo !== iHi) mk(iLo, 'dn');
    if (n - 1 !== iHi && n - 1 !== iLo) mk(n - 1, view[n - 1].c >= view[iLo].c ? 'up' : 'dn', 'end');
  } else {
    // 日 K 棒：影線＋實體（紅漲綠跌；開＝收畫成一字線）
    view.forEach(function (b, k) {
      var up = b.c >= b.o, cls = up ? 'up' : 'dn', xx = x(k);
      s += '<line class="ck-wick ' + cls + '" x1="' + xx.toFixed(1) + '" y1="' + y(b.h).toFixed(1) + '" x2="' + xx.toFixed(1) + '" y2="' + y(b.l).toFixed(1) + '"/>';
      var yTop = y(Math.max(b.o, b.c)), hBody = Math.max(1, Math.abs(y(b.o) - y(b.c)));
      s += '<rect class="ck-body ' + cls + '" x="' + (xx - bw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + hBody.toFixed(1) + '"/>';
    });
    // 均線只在日 K 畫：走勢圖要的是乾淨的一條線
    [['ma5', ma5], ['ma20', ma20], ['ma60', ma60]].forEach(function (pair) {
      var pts = [];
      for (var k = 0; k < n; k++) {
        var v = pair[1][s0 + k];
        if (v != null) pts.push(x(k).toFixed(1) + ',' + y(v).toFixed(1));
      }
      if (pts.length > 1) s += '<polyline class="ck-ma ' + pair[0] + '" points="' + pts.join(' ') + '"/>';
    });
  }
  // 量區頂線與刻度
  s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + (PAD_T + PH + GAP) + '" x2="' + (W - PAD_R) + '" y2="' + (PAD_T + PH + GAP) + '"/>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (PAD_T + PH + GAP + 10) + '" text-anchor="end">' + Math.round(vmax).toLocaleString('zh-TW') + '</text>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + VB + '" text-anchor="end">量</text>';
  s += '<rect id="ckd-hit" x="' + PAD_L + '" y="' + PAD_T + '" width="' + PW + '" height="' + (PH + GAP + VH) + '" fill="transparent"/>' +
    '<line id="ckd-cross" class="ck-cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + VB + '" style="display:none"/>' +
    '</svg>';

  var last = view[n - 1], first = view[0];
  var chg = last.c - first.c, pct = first.c ? chg / first.c * 100 : 0;
  var cls2 = chg >= 0 ? 'up' : 'down';
  var maLbl = function (name, v, klass) { return '<span class="ck-legend ' + klass + '">' + name + ' ' + (v != null ? v.toFixed(2) : '—') + '</span>'; };
  var adj = per.src === 'yahoo' && _chartAdjOn;
  var note = per.src === 'kbars'
    ? 'Shioaji 1 分 K 聚合為日 K，收盤價；最後一根盤中每分鐘更新。'
    : '日 K（' + (adj ? '還原價：除息落差已加回歷史價，看的是總報酬' : '收盤價：實際成交價，除息當天會往下跳') +
      '），最後一根改用本機盤中現價。量已由股換算為張。來源：' + (_chartDaySrc || 'Yahoo') + '。';
  note += kmode ? ' 開高低收蠟燭，紅漲綠跌，均線 MA5／MA20／MA60。'
                : ' 走勢圖畫收盤，量長條顏色依當日較前一日漲跌；要看開高低收與均線請切到日K。';
  return '<div class="chart-info"><span id="ckd-tip">' +
      per.lb + ' ' + n + ' 日 <b>' + first.c.toFixed(2) + '</b> → <b>' + last.c.toFixed(2) + '</b>　' +
      '<span class="' + cls2 + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '（' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%）</span>' +
    '</span>　' + (kmode ? maLbl('MA5', ma5[bars.length - 1], 'ma5') + maLbl('MA20', ma20[bars.length - 1], 'ma20') + maLbl('MA60', ma60[bars.length - 1], 'ma60') : '') +
    '</div>' + s +
    '<div class="detail-note">' + note + (first.d ? ' 區間 ' + first.d + ' 起。' : '') + '</div>';
}

function _chartBindDayHover(bars, per) {
  var svg = document.querySelector('#chart-area .chart-svg');
  var hit = document.getElementById('ckd-hit'), cross = document.getElementById('ckd-cross'), tip = document.getElementById('ckd-tip');
  if (!svg || !hit || !cross || !tip) return;
  var s0 = Math.max(0, bars.length - per.show), view = bars.slice(s0), n = view.length;
  var PAD_L = 58, PW = 860 - 58 - 12, step = PW / n;
  var base = tip.innerHTML;
  hit.addEventListener('mousemove', function (ev) {
    var vx = _chartVX(svg, ev.clientX);
    if (vx == null) return;
    var k = Math.floor((vx - PAD_L) / step);
    if (k < 0) k = 0; if (k > n - 1) k = n - 1;
    var xx = PAD_L + step * (k + 0.5);
    cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.style.display = '';
    var b = view[k];
    var prev = k > 0 ? view[k - 1].c : b.o;
    var dc = b.c - prev, dp = prev ? dc / prev * 100 : 0;
    var cls = dc >= 0 ? 'up' : 'down';
    var ohl = per.kmode
      ? '　開 <b>' + b.o.toFixed(2) + '</b> 高 <b>' + b.h.toFixed(2) + '</b> 低 <b>' + b.l.toFixed(2) + '</b> 收 '
      : '　收 ';
    tip.innerHTML = b.d.replace(/-/g, '/') + ohl +
      '<b class="' + cls + '">' + b.c.toFixed(2) + '</b>' +
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
  // FOOT 是日期標籤專用的一條。與日線區同一個毛病：原本標在 H-2，
  // 而量區的底就是 H，字會壓在量柱上。
  var W = 860, H = 300, VH = 90, PAD_L = 58, PAD_R = 12, PAD_T = 12, GAP = 26, FOOT = 16;
  var PW = W - PAD_L - PAD_R;              // 繪圖區寬
  var PH = H - VH - GAP - PAD_T - FOOT;    // 價格區高
  var VB = PAD_T + PH + GAP + VH;          // 量區底線，也是圖面的下界
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
  var vy = function (v) { return VB - v * VH / vmax; };

  // 日界線位置與標籤
  var dayStart = [], prevDay = '';
  d.dts.forEach(function (t, i) { var dd = t.slice(0, 10); if (dd !== prevDay) { dayStart.push({ i: i, day: dd }); prevDay = dd; } });

  var s = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' +
    '<defs><linearGradient id="ck5grad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-opacity="0.55"/>' +
      '<stop offset="1" stop-opacity="0.03"/></linearGradient></defs>';

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
    if (k > 0) s += '<line class="ck-sep" x1="' + xx.toFixed(1) + '" y1="' + PAD_T + '" x2="' + xx.toFixed(1) + '" y2="' + VB + '"/>';
    var mid = x(k + 1 < dayStart.length ? (ds.i + dayStart[k + 1].i) / 2 : (ds.i + n - 1) / 2);
    s += '<text class="ck-axis" x="' + mid.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle">' + ds.day.slice(5).replace('-', '/') + '</text>';
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

  // 價格折線＋暗橘漸層填滿（自線往下填至價格區底，上濃下淡）
  var pts = [];
  for (var j2 = 0; j2 < n; j2++) pts.push(x(j2).toFixed(1) + ',' + y(d.close[j2]).toFixed(1));
  var baseY = (PAD_T + PH).toFixed(1);
  s += '<polygon class="ck5-fill" points="' + x(0).toFixed(1) + ',' + baseY + ' ' + pts.join(' ') + ' ' + x(n - 1).toFixed(1) + ',' + baseY + '"/>';
  s += '<polyline class="ck5-line" points="' + pts.join(' ') + '"/>';

  // 五日區間的最高與最低。標的是「哪一分鐘」，所以圓點落在那一根分 K 上，
  // 不是日 K 的高低。水平位置夾在繪圖區內，免得落在端點時標籤被切掉；
  // 低點離價格區底不到 14px 時改標在上方（軸只留 8% 邊距，常常放不下）。
  var iHi = 0, iLo = 0;
  for (var m5 = 1; m5 < n; m5++) {
    if (d.close[m5] > d.close[iHi]) iHi = m5;
    if (d.close[m5] < d.close[iLo]) iLo = m5;
  }
  var mk5 = function (i, dir, anchor) {
    var v = d.close[i], px = x(i);
    var tx = anchor === 'end' ? (W - PAD_R) : Math.min(Math.max(px, PAD_L + 20), W - PAD_R - 20);
    var ty = (dir === 'dn' && y(v) + 14 <= PAD_T + PH - 2) ? y(v) + 14 : Math.max(y(v) - 7, PAD_T + 9);
    s += '<circle class="ckd-dot" cx="' + px.toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.4"/>' +
      '<text class="ckd-mk" x="' + tx.toFixed(1) + '" y="' + ty.toFixed(1) + '" text-anchor="' + (anchor || 'middle') + '">' +
      v.toFixed(2) + '</text>';
  };
  mk5(iHi, 'up');
  if (iLo !== iHi) mk5(iLo, 'dn');
  // 最後一筆靠右對齊；它本身就是高點或低點時不重複標
  if (n - 1 !== iHi && n - 1 !== iLo) mk5(n - 1, 'up', 'end');

  // 量區頂線
  s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + (PAD_T + PH + GAP) + '" x2="' + (W - PAD_R) + '" y2="' + (PAD_T + PH + GAP) + '"/>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (PAD_T + PH + GAP + 10) + '" text-anchor="end">' + vmax.toLocaleString('zh-TW') + '</text>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + VB + '" text-anchor="end">量</text>';

  // 互動：滑鼠移動顯示該分鐘價量
  s += '<rect id="ck-hit" x="' + PAD_L + '" y="' + PAD_T + '" width="' + PW + '" height="' + (PH + GAP + VH) + '" fill="transparent"/>' +
    '<line id="ck-cross" class="ck-cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + VB + '" style="display:none"/>' +
    '</svg>';

  var last = d.close[n - 1], first = d.close[0];
  var chg = last - first, pct = first ? chg / first * 100 : 0;
  var cls = chg >= 0 ? 'up' : 'down';
  return '<div class="chart-info"><span id="ck-tip">' +
      '五日區間 <b>' + first.toFixed(2) + '</b> → <b>' + last.toFixed(2) + '</b>　' +
      '<span class="' + cls + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '（' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%）</span>' +
    '</span></div>' + s +
    '<div class="detail-note">Shioaji 1 分 K，近 5 個交易日串接；虛線為昨收。' +
      '圖上標出五日區間的最高、最低與最後一筆（標的是那一分鐘的收盤，不是日 K 的高低）。' +
      '量長條顏色依該分鐘較前一分鐘漲跌。</div>';
}
