// 股利總管 Web — 總現值走勢（頂欄抽屜）
//
// 上方：總現值(含借出) 折線（左軸、元）＋ 資本報酬率 折線（右軸、%）
// 下方：資本損益 長條（紅正綠負）
//
// 歷史怎麼來：券商沒有「每日總現值」這種 API，但買賣台帳查得到，逐日重算即可。
//   現有批次：_lotsMap（持股庫存載入時已抓）→ 建倉日、股數、成本
//   賣掉的：  /api/v1/portfolio/profit_loss（區間內每筆賣出：日期、代號、id）
//             → /api/v1/portfolio/profit_loss_detail（該筆賣出對應的買進批次：買進日、成本）
//   少了第二段就只剩「現在還持有」的批次，過去的總現值會缺一塊（倖存者偏差）。
//   實測近 90 天有 5 檔賣出紀錄，其中 2 檔現在已不在持股。
//
// 成本口徑對齊：position_detail 與 profit_loss_detail 的成本都是「已扣掉累積配息」的淨額
//   （profit_loss_detail 實測 00900：10 張 × 13.02 ＋ 手續費 51 − 配息 35,210 ＝ 95,041；
//    position_detail 實測 00923 2026-03-23 淨額 25.201／加回 28.251，當日成交 28.04～28.40）。
//   兩邊一律還原成「原始成本 ＝ 淨額 ＋ 累積配息」，成本線才是當初實際付出的錢。
//   這張圖畫的是資本損益與資本報酬率（純價差）。配息沒有逐日資料，不在圖上。
//
// 收盤價：kbars 固定 1 分 K，前端聚合成日 K（與 chart.js 日線同一套做法）。
//   成交清淡的日子沒有分 K（實測同區間 00918 有 89 個交易日、2380 只有 82），缺的日子用前一日收盤補。
//
// 快取：過去某一天的數字不會再變 → 整條序列算一次存 localStorage，當天重開直接用。

var PV_SHOW = 90;              // 顯示的交易日數
var PV_BACK_DAYS = 150;        // 往前抓幾個日曆天（要蓋過 90 個交易日）
var PV_LS = 'pv_hist_v4';   // v4：序列多了逐日買進／賣出／除息，舊快取作廢

var _pvOpen = false, _pvData = null, _pvLoading = false, _pvErr = '';

function _pvYmd(d) {
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);   // 台灣日期
}
async function _pvPost(path, body) {
  var r = await fetch(API + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) throw new Error(path + ' HTTP ' + r.status);
  return r.json();
}

// ── 買賣台帳：現有批次 ＋ 區間內賣掉的批次 ──
async function _pvLedger(begin, end) {
  var lots = [], warn = [];
  Object.keys(_lotsMap || {}).forEach(function (code) {
    (_lotsMap[code] || []).forEach(function (l) {
      // 原始成本：券商記錄的成本已扣掉該筆累積配息，sub 為真表示被扣過，加回才與賣出批次同口徑
      lots.push({ code: String(code), buy: l.date, shares: l.shares,
                  cost: l.cost + (l.sub ? (l.div || 0) : 0), sell: null });
    });
  });
  var pl = [];
  try {
    pl = await _pvPost('/api/v1/portfolio/profit_loss', { begin_date: begin, end_date: end }) || [];
  } catch (e) { warn.push('已實現損益查詢失敗：' + e.message); return { lots: lots, warn: warn }; }

  for (var i = 0; i < pl.length; i++) {
    var rec = pl[i];
    if (rec.id == null) continue;
    try {
      var det = await _pvPost('/api/v1/portfolio/profit_loss_detail', { detail_id: rec.id }) || [];
      // detail_id 是「上一次查詢結果」的索引，對不上就不要硬算
      if (det.length && det[0].code && String(det[0].code) !== String(rec.code)) {
        warn.push(rec.code + ' ' + rec.date + ' 明細對應不上，略過'); continue;
      }
      det.forEach(function (x) {
        var cost = (x.cost || 0) + (x.ex_dividend_amt || 0);        // 還原成未扣配息的買進成本
        var sh = x.price ? Math.round((cost - (x.fee || 0)) / x.price) : (x.quantity || 0) * 1000;
        if (sh > 0) lots.push({ code: String(rec.code), buy: x.date, shares: sh, cost: cost, sell: rec.date });
      });
    } catch (e) { warn.push(rec.code + ' ' + rec.date + ' 明細讀取失敗'); }
  }
  return { lots: lots, warn: warn };
}

// ── 日收盤：1 分 K 聚合 ──
async function _pvCloses(code, begin, end) {
  var j = await _pvPost('/api/v1/data/kbars', {
    contract: { security_type: 'STK', exchange: ((_contracts || {})[code] || {}).exchange || 'TSE', code: code },
    start: begin, end: end
  });
  var out = {};
  if (!j || !j.datetime) return out;
  for (var i = 0; i < j.datetime.length; i++) out[j.datetime[i].slice(0, 10)] = j.Close[i];   // 當日最後一筆即收盤
  return out;
}

// 併發上限，避免一次開十幾個 1 分 K 請求
async function _pvPool(items, n, fn) {
  var idx = 0;
  async function worker() { while (idx < items.length) { var k = idx++; await fn(items[k], k); } }
  var ws = []; for (var i = 0; i < Math.min(n, items.length); i++) ws.push(worker());
  await Promise.all(ws);
}

async function pvBuild() {
  var today = new Date();
  var end = _pvYmd(today), begin = _pvYmd(new Date(today.getTime() - PV_BACK_DAYS * 86400000));

  // 除息金額要用配息組成的除息日，先等它載完（_dmReady 由 div-mix.js 建立）
  if (typeof _dmReady !== 'undefined') { try { await _dmReady; } catch (e) {} }
  var led = await _pvLedger(begin, end);
  var lots = led.lots;
  if (!lots.length) throw new Error('沒有建倉批次可用');

  var codes = [];
  lots.forEach(function (l) { if (codes.indexOf(l.code) < 0) codes.push(l.code); });

  var px = {}, bad = [];
  await _pvPool(codes, 4, async function (code) {
    try { px[code] = await _pvCloses(code, begin, end); }
    catch (e) { px[code] = {}; bad.push(code); }
  });

  // 交易日曆：所有標的有報價的日子取聯集
  var dayset = {};
  codes.forEach(function (c) { Object.keys(px[c] || {}).forEach(function (d) { dayset[d] = 1; }); });
  var days = Object.keys(dayset).sort();
  if (days.length > PV_SHOW) days = days.slice(days.length - PV_SHOW);
  if (!days.length) throw new Error('抓不到任何收盤價');

  // 每檔補齊：當天沒成交就沿用前一日收盤
  var fill = {};
  codes.forEach(function (c) {
    var m = px[c] || {}, prev = null, all = Object.keys(m).sort(), ai = 0, row = {};
    // 先把視窗之前的最後一筆帶進來，否則視窗第一天沒成交就會是空的
    while (ai < all.length && all[ai] < days[0]) { prev = m[all[ai]]; ai++; }
    days.forEach(function (d) { if (m[d] != null) prev = m[d]; row[d] = prev; });
    fill[c] = row;
  });

  // 除息日索引：date → [{code, amt}]（每股金額，乘當日持股才是對總現值的影響）
  var mix = (typeof _dmMap !== 'undefined' && _dmMap) || {};
  var exByDay = {};
  Object.keys(mix).forEach(function (c) {
    (mix[c] || []).forEach(function (e) {
      if (!e.ex || e.amt == null) return;
      (exByDay[e.ex] = exByDay[e.ex] || []).push({ code: c, amt: e.amt });
    });
  });

  // 逐日分解：當日變動 ＝ 市場效應 ＋ 買進 － 賣出 － 除息。
  // 買賣一律以當日收盤計價，與總現值同一套，三項才加得回變動；
  // 代價是當天買進後到收盤的漲跌被歸進市場效應。
  var out = days.map(function (d) {
    var val = 0, cost = 0, noPx = 0, buy = 0, sell = 0, exAmt = 0, shBy = {};
    lots.forEach(function (l) {
      var px = fill[l.code][d];
      if (l.buy === d) buy += (px || 0) * l.shares;
      if (l.sell === d) sell += (px || 0) * l.shares;
      if (l.buy > d) return;
      if (l.sell && l.sell <= d) return;            // 賣出當天收盤已不持有
      cost += l.cost;
      shBy[l.code] = (shBy[l.code] || 0) + l.shares;
      if (px == null) { noPx++; return; }
      val += px * l.shares;
    });
    (exByDay[d] || []).forEach(function (e) {
      if (shBy[e.code]) exAmt += e.amt * shBy[e.code];
    });
    return { d: d, v: Math.round(val), c: Math.round(cost), n: noPx,
             b: Math.round(buy), s: Math.round(sell), x: Math.round(exAmt) };
  });

  return { built: end, days: out, codes: codes.length, warn: led.warn.concat(bad.length ? ['無日 K：' + bad.join('、')] : []) };
}

function _pvCacheRead() {
  try { return JSON.parse(localStorage.getItem(PV_LS) || 'null'); } catch (e) { return null; }
}
function _pvCacheWrite(d) {
  try { localStorage.setItem(PV_LS, JSON.stringify(d)); } catch (e) {}
}

async function pvEnsure(force) {
  if (_pvLoading) return _pvData;
  var today = _pvYmd(new Date());
  if (!force) {
    if (_pvData && _pvData.built === today) return _pvData;
    var cc = _pvCacheRead();
    if (cc && cc.built === today && cc.days && cc.days.length) { _pvData = cc; return _pvData; }
  }
  _pvLoading = true; _pvErr = '';
  try {
    _pvData = await pvBuild();
    _pvCacheWrite(_pvData);
  } catch (e) {
    _pvErr = e.message || String(e);
  } finally { _pvLoading = false; }
  return _pvData;
}

// ── 繪圖 ──
function _pvWan(v) {
  var w = v / 10000;
  return (Math.abs(w) >= 1000 ? Math.round(w).toLocaleString('zh-TW') : w.toFixed(0)) + '萬';
}

function pvSvg(data) {
  var rows = (data && data.days) || [];
  if (rows.length < 2) return '<div class="modal-loading">資料不足</div>';
  var tax = (typeof _taxMode !== 'undefined' && _taxMode) ? 0.997735 : 1;
  var pts = rows.map(function (r) {
    var v = Math.round(r.v * tax), p = r.c ? v - r.c : null;
    return { d: r.d, v: v, c: r.c, p: p, rate: (p != null && r.c) ? p / r.c * 100 : null };
  });

  var W = 1180, H = 380, PAD_L = 74, PAD_R = 58, PAD_T = 14, BAR_H = 86, GAP = 26, FOOT = 16;
  var PH = H - PAD_T - GAP - BAR_H - FOOT;
  var n = pts.length, step = (W - PAD_L - PAD_R) / n;
  var x = function (k) { return PAD_L + step * (k + 0.5); };

  var vlo = Infinity, vhi = -Infinity, rlo = Infinity, rhi = -Infinity, plo = Infinity, phi = -Infinity;
  pts.forEach(function (o) {
    if (o.v < vlo) vlo = o.v; if (o.v > vhi) vhi = o.v;
    if (o.rate != null) { if (o.rate < rlo) rlo = o.rate; if (o.rate > rhi) rhi = o.rate; }
    if (o.p != null) { if (o.p < plo) plo = o.p; if (o.p > phi) phi = o.p; }
  });
  if (plo === Infinity) { plo = 0; phi = 1; }
  if (rlo === Infinity) { rlo = 0; rhi = 1; }
  var vp = (vhi - vlo) * 0.08 || 1; vlo -= vp; vhi += vp;
  var rp = (rhi - rlo) * 0.08 || 0.5; rlo -= rp; rhi += rp;

  var yv = function (v) { return PAD_T + (vhi - v) * PH / (vhi - vlo); };
  var yr = function (r) { return PAD_T + (rhi - r) * PH / (rhi - rlo); };
  // 長條的底：有正有負就用 0；整段同號時 0 基準會讓每根都頂到天花板、看不出變化，
  // 改錨在區間外側並把基準值標在軸上（不是 0 就寫出實際金額，免得被讀成「從 0 起算」）
  var pbase = (plo < 0 && phi > 0) ? 0 : (phi <= 0 ? phi + (phi - plo) * 0.12 : plo - (phi - plo) * 0.12);
  var ptop = (plo < 0 && phi > 0) ? Math.max(Math.abs(plo), Math.abs(phi)) : phi + (phi - plo) * 0.12;
  var pspan = Math.abs(ptop - pbase) || 1;
  var bTop = PAD_T + PH + GAP, bBot = bTop + BAR_H;
  var b0 = (plo < 0 && phi > 0) ? bTop + BAR_H / 2 : bBot;
  var yb = function (p) { return b0 - (p - pbase) / pspan * ((plo < 0 && phi > 0) ? BAR_H / 2 : BAR_H); };

  var s = '<svg class="chart-svg pv-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  for (var g = 0; g <= 4; g++) {
    var vv = vhi - (vhi - vlo) * g / 4, rv = rhi - (rhi - rlo) * g / 4, yy = PAD_T + PH * g / 4;
    s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + yy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + yy.toFixed(1) + '"/>' +
      '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="end">' + _pvWan(vv) + '</text>' +
      '<text class="ck-axis pv-ax-r" x="' + (W - PAD_R + 6) + '" y="' + (yy + 3.5).toFixed(1) + '" text-anchor="start">' + rv.toFixed(1) + '%</text>';
  }
  // 月分隔線與月份標籤
  var prevMo = '';
  pts.forEach(function (o, k) {
    var mo = o.d.slice(0, 7);
    if (mo !== prevMo) {
      if (k > 0) s += '<line class="ck-sep" x1="' + (x(k) - step / 2).toFixed(1) + '" y1="' + PAD_T + '" x2="' + (x(k) - step / 2).toFixed(1) + '" y2="' + (PAD_T + PH + GAP + BAR_H) + '"/>';
      s += '<text class="ck-axis" x="' + x(k).toFixed(1) + '" y="' + (H - 3) + '" text-anchor="middle">' + o.d.slice(5).replace('-', '/') + '</text>';
      prevMo = mo;
    }
  });
  // 損益長條（紅正綠負）
  var bw = Math.max(1, step * 0.6);
  pts.forEach(function (o, k) {
    if (o.p == null) return;
    var y1 = yb(o.p), h = Math.max(0.8, Math.abs(b0 - y1));
    s += '<rect class="pv-bar ' + (o.p >= 0 ? 'up' : 'dn') + '" x="' + (x(k) - bw / 2).toFixed(1) + '" y="' + Math.min(b0, y1).toFixed(1) +
      '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '"/>';
  });
  s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + b0.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + b0.toFixed(1) + '"/>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (b0 - 3).toFixed(1) + '" text-anchor="end">損益 ' + _pvWan(pbase) + '</text>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (bTop + 9) + '" text-anchor="end">' + _pvWan(ptop) + '</text>';
  // 折線
  var lv = [], lr = [];
  pts.forEach(function (o, k) {
    lv.push(x(k).toFixed(1) + ',' + yv(o.v).toFixed(1));
    if (o.rate != null) lr.push(x(k).toFixed(1) + ',' + yr(o.rate).toFixed(1));
  });
  s += '<polyline class="pv-line val" points="' + lv.join(' ') + '"/>';
  if (lr.length > 1) s += '<polyline class="pv-line rate" points="' + lr.join(' ') + '"/>';
  s += '<rect id="pv-hit" x="' + PAD_L + '" y="' + PAD_T + '" width="' + (W - PAD_L - PAD_R) + '" height="' + (PH + GAP + BAR_H) + '" fill="transparent"/>' +
    '<line id="pv-cross" class="ck-cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (PAD_T + PH + GAP + BAR_H) + '" style="display:none"/></svg>';

  var a = pts[0], z = pts[n - 1], dv = z.v - a.v;
  var cls = dv >= 0 ? 'up' : 'down';
  var head = '<div class="chart-info"><span id="pv-tip">' +
    n + ' 日　總現值 <b>' + a.v.toLocaleString('zh-TW') + '</b> → <b>' + z.v.toLocaleString('zh-TW') + '</b>　' +
    '<span class="' + cls + '">' + (dv >= 0 ? '+' : '') + dv.toLocaleString('zh-TW') + '</span>' +
    '</span>　<span class="pv-lg val">總現值</span><span class="pv-lg rate">資本報酬率</span><span class="pv-lg bar">資本損益</span></div>';
  return head + s;
}

function pvBindHover(data) {
  var svg = document.querySelector('#pv .pv-svg');
  var hit = document.getElementById('pv-hit'), cross = document.getElementById('pv-cross'), tip = document.getElementById('pv-tip');
  if (!svg || !hit || !cross || !tip) return;
  var tax = (typeof _taxMode !== 'undefined' && _taxMode) ? 0.997735 : 1;
  var rows = data.days, n = rows.length;
  var PAD_L = 74, step = (1180 - PAD_L - 58) / n, base = tip.innerHTML;
  hit.addEventListener('mousemove', function (ev) {
    var vx = (typeof _chartVX === 'function') ? _chartVX(svg, ev.clientX) : null;
    if (vx == null) return;
    var k = Math.floor((vx - PAD_L) / step);
    if (k < 0) k = 0; if (k > n - 1) k = n - 1;
    var xx = PAD_L + step * (k + 0.5);
    cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.style.display = '';
    var r = rows[k], v = Math.round(r.v * tax), p = r.c ? v - r.c : null;
    var rate = (p != null && r.c) ? p / r.c * 100 : null;
    var c2 = p == null ? '' : (p >= 0 ? 'up' : 'down');
    tip.innerHTML = r.d.slice(5).replace('-', '/') +
      '　總現值 <b>' + v.toLocaleString('zh-TW') + '</b>' +
      '　資本損益 <b class="' + c2 + '">' + (p == null ? '—' : (p >= 0 ? '+' : '') + p.toLocaleString('zh-TW')) + '</b>' +
      '　資本報酬率 <b class="' + c2 + '">' + (rate == null ? '—' : (rate > 0 ? '+' : '') + rate.toFixed(2) + '%') + '</b>';
  });
  hit.addEventListener('mouseleave', function () { cross.style.display = 'none'; tip.innerHTML = base; });
}

// ── 頁籤二：管制圖 ──
// 用途是看資產波動，不是品管意義的製程管制：目標上下限是你自己設的資產水位
// （設定 → 退休現金流），不是從資料算出來的 ±3σ。
//
// 配色與走勢頁籤刻意不同（這一頁屬管制圖性質，顏色只在這張圖內有意義）：
//   藍＝連續上升達標、紅＝連續下降達標、黃＝未達標準。燈號同一套，黃當空位。
// 「連續 N 日」以「每日較前一日」計：N=5 就是連續 5 個交易日同方向（5 段、6 個點）。
// 實測 90 個交易日內總現值沒有任何一天與前一日完全相同，所以持平不必特別處理。

// 逐段方向：回傳每一段（第 i 段＝第 i 點到第 i+1 點）的狀態 'up'|'dn'|'na'
function _pvRuns(vals, n) {
  var m = vals.length, dirs = [], i;
  for (i = 1; i < m; i++) dirs.push(vals[i] > vals[i - 1] ? 1 : (vals[i] < vals[i - 1] ? -1 : 0));
  var state = dirs.map(function () { return 'na'; });
  var st = 0;
  for (i = 0; i <= dirs.length; i++) {
    if (i < dirs.length && dirs[i] !== 0 && dirs[i] === dirs[st]) continue;
    var len = i - st;
    if (len >= n && dirs[st] !== 0) {
      for (var k = st; k < i; k++) state[k] = dirs[st] > 0 ? 'up' : 'dn';
    }
    st = i;
  }
  return state;
}

// 目前（從最後一點往回算）的連續方向與長度，供燈號用
function _pvCurRun(vals) {
  var cur = 0, dir = 0;
  for (var i = vals.length - 1; i > 0; i--) {
    var sgn = vals[i] > vals[i - 1] ? 1 : (vals[i] < vals[i - 1] ? -1 : 0);
    if (sgn === 0) break;
    if (dir === 0) { dir = sgn; cur = 1; } else if (sgn === dir) cur++; else break;
  }
  return { dir: dir, len: cur };
}

function _pvLampsHtml(vals, n) {
  var r = _pvCurRun(vals), cls = r.dir > 0 ? 'up' : (r.dir < 0 ? 'dn' : 'na');
  var lit = Math.min(r.len, n), h = '';
  for (var i = 0; i < n; i++) h += '<span class="pv-lamp ' + (i < lit ? cls : 'na') + '"></span>';
  var txt = r.dir === 0 ? '無連續' : (r.dir > 0 ? '連續上升 ' : '連續下降 ') + r.len + ' 日';
  return '<span class="pv-lamps" title="設定 ' + n + ' 日；目前 ' + txt + '">' + h +
    '<span class="pv-lamptx ' + cls + '">' + txt + (r.len >= n ? '（達標）' : '') + '</span></span>';
}

function pvSpcSvg(data) {
  var rows = (data && data.days) || [];
  if (rows.length < 2) return '<div class="modal-loading">資料不足</div>';
  var tax = (typeof _taxMode !== 'undefined' && _taxMode) ? 0.997735 : 1;
  var pts = rows.map(function (r) { return { d: r.d, v: Math.round(r.v * tax) }; });
  var vals = pts.map(function (o) { return o.v; });
  var cfg = (typeof rtSpc === 'function') ? rtSpc()
    : { n: 5, up: 18000000, lo: 17000000, mid: 17500000, avg: true };
  var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;

  var W = 1180, H = 430, PAD_L = 74, PAD_R = 118, PAD_T = 14, FOOT = 18;  // 右側留白放 90 日平均與線尾現值
  var BAR_H = 92, GAP = 26;                      // 下方逐日分解的堆疊直條區
  var PH = H - PAD_T - FOOT - GAP - BAR_H;
  var n = pts.length, step = (W - PAD_L - PAD_R) / n;
  var x = function (k) { return PAD_L + step * (k + 0.5); };

  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  [cfg.up, cfg.lo, cfg.mid].concat(cfg.avg ? [mean] : []).forEach(function (v) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  });
  var pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  var y = function (v) { return PAD_T + (hi - v) * PH / (hi - lo); };

  var s = '<svg class="chart-svg pv-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">';
  for (var g = 0; g <= 4; g++) {
    var gv = hi - (hi - lo) * g / 4, gy = PAD_T + PH * g / 4;
    s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + gy.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + gy.toFixed(1) + '"/>' +
      '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end">' + _pvWan(gv) + '</text>';
  }
  var prevMo = '';
  pts.forEach(function (o, k) {
    var mo = o.d.slice(0, 7);
    if (mo !== prevMo) {
      if (k > 0) s += '<line class="ck-sep" x1="' + (x(k) - step / 2).toFixed(1) + '" y1="' + PAD_T +
        '" x2="' + (x(k) - step / 2).toFixed(1) + '" y2="' + (PAD_T + PH + GAP + BAR_H) + '"/>';
      s += '<text class="ck-axis" x="' + x(k).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle">' +
        o.d.slice(5).replace('-', '/') + '</text>';
      prevMo = mo;
    }
  });

  // 目標區間鋪極淡底色：不新增顏色，「在不在區間內」不用對照線就看得出來。
  // 畫在格線之後、界線與折線之前，免得蓋住線。
  var bTop = y(Math.min(cfg.up, hi)), bBot = y(Math.max(cfg.lo, lo));
  if (bBot > bTop) {
    s += '<rect class="pv-band" x="' + PAD_L + '" y="' + bTop.toFixed(1) + '" width="' + (W - PAD_L - PAD_R) +
      '" height="' + (bBot - bTop).toFixed(1) + '"/>';
  }

  // 界線與標註分兩側：
  //   左側（目標上限、中線、目標下限）貼著 Y 軸刻度，重疊時往右退一格。
  //   右側留白放「90 日平均」與線尾的「目前總現值」。右側沒有往右退的空間，
  //   所以改成把下面那個往下挪，挪到彼此至少差 13px（實測兩者只差約 12 萬，會疊住）。
  var lastV = vals[n - 1], lastY = y(lastV);
  var leftLims = [[cfg.up, 'up', '目標上限'], [cfg.mid, 'mid', '中線'], [cfg.lo, 'lo', '目標下限']]
    .filter(function (a) { return a[0] != null && a[0] >= lo && a[0] <= hi; })
    .map(function (a) { return { v: a[0], cls: a[1], lb: a[2], y: y(a[0]) }; })
    .sort(function (a, b) { return a.y - b.y; });
  var prevY = -99, slot = 0;
  leftLims.forEach(function (o) {
    if (o.y - prevY < 13) slot++; else slot = 0;
    prevY = o.y;
    s += '<line class="pv-lim ' + o.cls + '" x1="' + PAD_L + '" y1="' + o.y.toFixed(1) +
      '" x2="' + (W - PAD_R) + '" y2="' + o.y.toFixed(1) + '"/>' +
      '<text class="pv-limtx ' + o.cls + '" x="' + (PAD_L + 6 + slot * 118) + '" y="' + (o.y - 4).toFixed(1) +
      '" text-anchor="start">' + o.lb + ' ' + _pvWan(o.v) + '</text>';
  });

  // 折線逐段著色：達標的連續段藍（上升）／紅（下降），其餘黃
  var state = _pvRuns(vals, cfg.n);
  for (var i = 1; i < n; i++) {
    s += '<line class="pv-seg ' + state[i - 1] + '" x1="' + x(i - 1).toFixed(1) + '" y1="' + y(vals[i - 1]).toFixed(1) +
      '" x2="' + x(i).toFixed(1) + '" y2="' + y(vals[i]).toFixed(1) + '"/>';
  }

  // 右側：90 日平均線（畫線）＋線尾的目前總現值（畫點）
  var right = [];
  if (cfg.avg && mean >= lo && mean <= hi) {
    s += '<line class="pv-lim avg" x1="' + PAD_L + '" y1="' + y(mean).toFixed(1) +
      '" x2="' + (W - PAD_R) + '" y2="' + y(mean).toFixed(1) + '"/>';
    right.push({ y: y(mean), cls: 'avg', lb: '90 日平均 ' + _pvWan(mean) });
  }
  s += '<circle class="pv-dot ' + (state[n - 2] || 'na') + '" cx="' + x(n - 1).toFixed(1) +
    '" cy="' + lastY.toFixed(1) + '" r="3.5"/>';
  right.push({ y: lastY, cls: 'now ' + (state[n - 2] || 'na'),
    lb: '目前 ' + lastV.toLocaleString('zh-TW') });
  right.sort(function (a, b) { return a.y - b.y; });
  var usedY = -99;
  right.forEach(function (o) {
    var ty = Math.max(o.y + 4, usedY + 13);
    usedY = ty;
    s += '<text class="pv-limtx ' + o.cls + '" x="' + (W - PAD_R + 6) + '" y="' + ty.toFixed(1) +
      '" text-anchor="start">' + o.lb + '</text>';
  });

  // ── 逐日分解（堆疊直條）──
  // 當日變動 ＝ 市場效應 ＋ 買賣淨額 － 除息。三段相加等於上方折線的日變動。
  // 顏色沿用這張圖的配色：市場正藍負紅、買賣灰（中性，不是賺賠）、除息黃（不是市場造成的）。
  var bTopY = PAD_T + PH + GAP, bBotY = bTopY + BAR_H;
  var comp = [];
  for (var j = 1; j < n; j++) {
    var dv = vals[j] - vals[j - 1];
    var bq = Math.round((rows[j].b || 0) * tax), sq = Math.round((rows[j].s || 0) * tax);
    var xq = Math.round((rows[j].x || 0) * tax);
    var trade = bq - sq;                                  // 買賣淨額（正＝淨買進）
    var mkt = dv - trade + xq;                            // 市場效應＝變動 － 買賣淨額 ＋ 除息
    comp.push({ i: j, dv: dv, mkt: mkt, trade: trade, ex: -xq, b: bq, s: sq });
  }
  var span = 1;
  comp.forEach(function (o) {
    var pos = (o.mkt > 0 ? o.mkt : 0) + (o.trade > 0 ? o.trade : 0);
    var neg = (o.mkt < 0 ? -o.mkt : 0) + (o.trade < 0 ? -o.trade : 0) + (-o.ex);
    if (pos > span) span = pos;
    if (neg > span) span = neg;
  });
  var bZero = bTopY + BAR_H / 2;
  var bh = function (v) { return Math.abs(v) / span * (BAR_H / 2); };
  var bw2 = Math.max(1, step * 0.6);
  comp.forEach(function (o) {
    var cx = x(o.i) - bw2 / 2, up = bZero, dn = bZero;
    var put = function (v, cls) {
      if (!v) return;
      var h = bh(v);
      if (h < 0.5) h = 0.5;
      if (v > 0) { up -= h; s += '<rect class="pv-bseg ' + cls + '" x="' + cx.toFixed(1) + '" y="' + up.toFixed(1) + '" width="' + bw2.toFixed(1) + '" height="' + h.toFixed(1) + '"/>'; }
      else { s += '<rect class="pv-bseg ' + cls + '" x="' + cx.toFixed(1) + '" y="' + dn.toFixed(1) + '" width="' + bw2.toFixed(1) + '" height="' + h.toFixed(1) + '"/>'; dn += h; }
    };
    put(o.mkt, o.mkt >= 0 ? 'mkt-up' : 'mkt-dn');
    put(o.trade, 'trade');
    put(o.ex, 'ex');
  });
  s += '<line class="ck-grid" x1="' + PAD_L + '" y1="' + bZero.toFixed(1) + '" x2="' + (W - PAD_R) + '" y2="' + bZero.toFixed(1) + '"/>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (bZero + 3.5).toFixed(1) + '" text-anchor="end">0</text>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (bTopY + 9) + '" text-anchor="end">' + _pvWan(span) + '</text>' +
    '<text class="ck-axis" x="' + (PAD_L - 6) + '" y="' + (bBotY) + '" text-anchor="end">-' + _pvWan(span) + '</text>';

  s += '<rect id="pvs-hit" x="' + PAD_L + '" y="' + PAD_T + '" width="' + (W - PAD_L - PAD_R) + '" height="' + PH + '" fill="transparent"/>' +
    '<line id="pvs-cross" class="ck-cross" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (PAD_T + PH) + '" style="display:none"/></svg>';

  var inBand = vals.filter(function (v) { return v >= cfg.lo && v <= cfg.up; }).length;
  var head = '<div class="chart-info"><span id="pvs-tip">' +
    n + ' 日　' + _pvLampsHtml(vals, cfg.n) +
    '　區間內 <b>' + inBand + '</b>/' + n + ' 日（' + (inBand / n * 100).toFixed(0) + '%）' +
    '　<span class="pv-lg2 mkt">市場</span><span class="pv-lg2 trade">買賣</span><span class="pv-lg2 ex">除息</span>' +
    '</span></div>';
  return head + s;
}

function pvBindSpcHover(data) {
  var svg = document.querySelector('#pv .pv-svg');
  var hit = document.getElementById('pvs-hit'), cross = document.getElementById('pvs-cross'), tip = document.getElementById('pvs-tip');
  if (!svg || !hit || !cross || !tip) return;
  var tax = (typeof _taxMode !== 'undefined' && _taxMode) ? 0.997735 : 1;
  var rows = data.days, n = rows.length;
  var PAD_L = 74, step = (1180 - PAD_L - 118) / n, base = tip.innerHTML;   // PAD_R 與 pvSpcSvg 一致
  var cfg = (typeof rtSpc === 'function') ? rtSpc() : { lo: 17000000, up: 18000000 };
  hit.addEventListener('mousemove', function (ev) {
    var vx = (typeof _chartVX === 'function') ? _chartVX(svg, ev.clientX) : null;
    if (vx == null) return;
    var k = Math.floor((vx - PAD_L) / step);
    if (k < 0) k = 0;
    if (k > n - 1) k = n - 1;
    var xx = PAD_L + step * (k + 0.5);
    cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.style.display = '';
    var v = Math.round(rows[k].v * tax);
    var prev = k > 0 ? Math.round(rows[k - 1].v * tax) : null;
    var dv = prev == null ? null : v - prev;
    var pos = v > cfg.up ? '高於上限' : (v < cfg.lo ? '低於下限' : '區間內');
    // 分解：當日變動 ＝ 市場 ＋ 買賣淨額 － 除息
    var ex = Math.round((rows[k].x || 0) * tax);
    var trade = Math.round((rows[k].b || 0) * tax) - Math.round((rows[k].s || 0) * tax);
    var mkt = dv == null ? null : dv - trade + ex;
    var sgn = function (x) { return x === 0 ? '0' : (x > 0 ? '+' : '') + x.toLocaleString('zh-TW'); };
    // 三段一律用與圖例相同的〔圖標 類別 數據〕，沒有事件的那天顯示 0，
    // 版面才不會因為當天有沒有買賣而跳動。市場的色塊跟著正負換，與直條同色。
    var seg = function (cls, lb, txt) {
      return '<span class="pv-lg2 ' + cls + '">' + lb + ' <b>' + txt + '</b></span>';
    };
    tip.innerHTML = rows[k].d.slice(5).replace('-', '/') +
      '　總現值 <b>' + v.toLocaleString('zh-TW') + '</b>' +
      (dv == null ? '' : '　較前日 <b class="' + (dv >= 0 ? 'pv-c-up' : 'pv-c-dn') + '">' + sgn(dv) + '</b>') +
      '　' + pos + '　' +
      (mkt == null ? '' :
        seg(mkt >= 0 ? 'mkt' : 'mktdn', '市場', sgn(mkt)) +
        seg('trade', '買賣', sgn(trade)) +
        seg('ex', '除息', ex ? '-' + ex.toLocaleString('zh-TW') : '0'));
  });
  hit.addEventListener('mouseleave', function () { cross.style.display = 'none'; tip.innerHTML = base; });
}

// ── 抽屜 ──
function pvToggle() {
  _pvOpen = !_pvOpen;
  if (_pvOpen && typeof _dwOpen !== 'undefined' && _dwOpen) {    // 兩個抽屜會疊在一起，一次只開一個
    _dwOpen = false;
    if (typeof renderTopbarTotals === 'function') renderTopbarTotals();
  }
  pvRender();
  if (typeof renderTopbarTotals === 'function') renderTopbarTotals();
  if (_pvOpen) {
    pvEnsure().then(function () { pvRender(); }).catch(function (e) { console.warn('[總現值走勢]', e); });
  }
}
function pvClose() { _pvOpen = false; pvRender(); if (typeof renderTopbarTotals === 'function') renderTopbarTotals(); }
function pvReload() { _pvData = null; try { localStorage.removeItem(PV_LS); } catch (e) {} pvRender(); pvEnsure(true).then(pvRender); }

// 抽屜兩個頁籤共用同一份 90 日序列，切換不重抓。
// 走勢＝紅綠（全站慣例）；管制圖＝藍紅黃（只在那張圖內有意義），兩套刻意不同。
var _pvTab = 'trend';
function pvTab(t) { _pvTab = t; pvRender(); }

function pvRender() {
  var el = document.getElementById('pv');
  if (!el) return;
  el.hidden = !_pvOpen;
  var btn = document.getElementById('pv-btn');
  if (btn) { btn.textContent = (_pvOpen ? '▴' : '▾') + ' 走勢'; btn.className = 'dw-btn' + (_pvOpen ? ' on' : ''); }
  if (!_pvOpen) { el.innerHTML = ''; return; }

  var ready = _pvData && !_pvLoading && !_pvErr;
  var body;
  if (_pvLoading) body = '<div class="modal-loading">重建買賣台帳與日收盤中…（首次約 3～5 秒）</div>';
  else if (_pvErr) body = '<div class="modal-loading">載入失敗：' + _pvErr + '</div>';
  else if (!_pvData) body = '<div class="modal-loading">載入中…</div>';
  else body = (_pvTab === 'spc') ? pvSpcSvg(_pvData) : pvSvg(_pvData);

  var warn = (_pvData && _pvData.warn && _pvData.warn.length)
    ? '<div class="detail-note">' + _pvData.warn.join('；') + '</div>' : '';

  var tab = function (id, lb) {
    return '<button class="pv-tab' + (_pvTab === id ? ' on' : '') + '" onclick="pvTab(\'' + id + '\')">' + lb + '</button>';
  };

  var note = (_pvTab === 'spc')
    ? '<div class="detail-note">近 ' + PV_SHOW + ' 個交易日的總現值，用來看資產波動。' +
      '<b>目標上限／下限</b>是你自己設的資產水位（設定 → 退休現金流），不是從資料算出來的統計界線；' +
      '<b>中線</b>是上下限的中點，<b>90 日平均</b>是這段期間的實際平均，兩條不是同一回事。' +
      '折線逐段著色：<span class="pv-c-up">藍＝連續上升達標</span>、' +
      '<span class="pv-c-dn">紅＝連續下降達標</span>、<span class="pv-c-na">黃＝未達設定天數</span>；' +
      '上方燈號亮幾格就是目前連續幾日，黃格是還沒走到的格數。連續天數以「每日較前一日」計。' +
      '線尾的「目前」是這張圖建立當下的分 K 收盤，與頂欄的即時報價取樣時點不同，' +
      '盤中會有小幅落差（實測 11,262 元，0.065%），按 ↻ 重新計算即對齊。' +
      '下方堆疊直條把當日變動拆開：<code>當日變動 ＝ 市場效應 ＋ 買賣淨額 － 除息</code>，' +
      '三段相加等於上方折線的日變動。<span class="pv-c-up">市場正藍</span>／<span class="pv-c-dn">負紅</span>、' +
      '<span class="pv-c-tr">買賣灰</span>（中性，不是賺賠）、<span class="pv-c-na">除息黃</span>（不是市場造成的）。' +
      '近 90 天有 43 天出現事件，其中 15 天總現值的方向與市場相反，所以看到連續紅段要先看直條是不是自己的動作造成的。' +
      '買賣一律以當日收盤計價（與總現值同一套，三段才加得回變動），當天買進後到收盤的漲跌會被歸進市場效應；' +
      '除息金額是<b>每股配息 × 當日持股</b>的推算，回答「價格為什麼掉」，不能拿去跟股利估算的本月發放對帳。</div>'
    : '<div class="detail-note">近 ' + PV_SHOW + ' 個交易日。持股與成本由買賣台帳逐日重建' +
      (_pvData ? '（' + _pvData.codes + ' 檔）' : '') + '，收盤價用 Shioaji 1 分 K 聚合、無成交日沿用前一日。' +
      '<code>資本損益 ＝ 現值 － 原始成本</code>，資本報酬率為其除以原始成本；' +
      '賣出當天現值與成本會同時減少，已實現獲利不留在線上；除息當天價格先扣、配息還沒入帳，' +
      '總現值會出現向下的台階，那不是虧損。長條的底是區間外側、不是 0（整段同號時 0 基準每根都會頂到天花板），實際基準標在左軸。' +
      '含息版本做不到：券商的配息欄位是自買進以來的累計，沒有日期可拆。</div>';

  el.innerHTML =
    '<button class="dw-close" onclick="pvClose()" title="關閉">✕</button>' +
    '<div class="dw-sec">總現值' +
      '<button class="fx-reload" onclick="pvReload()" title="重新計算（清快取重抓分 K）">↻</button>' +
      '<span class="pv-tabs">' + tab('trend', '走勢') + tab('spc', '管制圖') + '</span>' +
    '</div>' + body + warn + note;

  if (!ready) return;
  if (_pvTab === 'spc') pvBindSpcHover(_pvData); else pvBindHover(_pvData);
}
