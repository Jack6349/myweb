// 股利總管 Web — 總現值走勢（頂欄抽屜）
//
// 上方：總現值(含借出) 折線（左軸、元）＋ 獲利率 折線（右軸、%）
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
//   因此這張圖的損益是資本損益（純價差）：配息沒有逐日資料，無法畫含息版本。
//
// 收盤價：kbars 固定 1 分 K，前端聚合成日 K（與 chart.js 日線同一套做法）。
//   成交清淡的日子沒有分 K（實測同區間 00918 有 89 個交易日、2380 只有 82），缺的日子用前一日收盤補。
//
// 快取：過去某一天的數字不會再變 → 整條序列算一次存 localStorage，當天重開直接用。

var PV_SHOW = 90;              // 顯示的交易日數
var PV_BACK_DAYS = 150;        // 往前抓幾個日曆天（要蓋過 90 個交易日）
var PV_LS = 'pv_hist_v3';   // v3：成本改原始成本（還原配息），舊快取作廢

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

  var out = days.map(function (d) {
    var val = 0, cost = 0, noPx = 0;
    lots.forEach(function (l) {
      if (l.buy > d) return;
      if (l.sell && l.sell <= d) return;            // 賣出當天收盤已不持有
      cost += l.cost;
      var c = fill[l.code][d];
      if (c == null) { noPx++; return; }
      val += c * l.shares;
    });
    return { d: d, v: Math.round(val), c: Math.round(cost), n: noPx };
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
    '</span>　<span class="pv-lg val">總現值</span><span class="pv-lg rate">獲利率</span><span class="pv-lg bar">資本損益</span></div>';
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
      '　獲利率 <b class="' + c2 + '">' + (rate == null ? '—' : (rate > 0 ? '+' : '') + rate.toFixed(2) + '%') + '</b>';
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

function pvRender() {
  var el = document.getElementById('pv');
  if (!el) return;
  el.hidden = !_pvOpen;
  var btn = document.getElementById('pv-btn');
  if (btn) { btn.textContent = (_pvOpen ? '▴' : '▾') + ' 走勢'; btn.className = 'dw-btn' + (_pvOpen ? ' on' : ''); }
  if (!_pvOpen) { el.innerHTML = ''; return; }

  var body;
  if (_pvLoading) body = '<div class="modal-loading">重建買賣台帳與日收盤中…（首次約 3～5 秒）</div>';
  else if (_pvErr) body = '<div class="modal-loading">載入失敗：' + _pvErr + '</div>';
  else if (!_pvData) body = '<div class="modal-loading">載入中…</div>';
  else body = pvSvg(_pvData);

  var warn = (_pvData && _pvData.warn && _pvData.warn.length)
    ? '<div class="detail-note">' + _pvData.warn.join('；') + '</div>' : '';

  el.innerHTML =
    '<button class="dw-close" onclick="pvClose()" title="關閉">✕</button>' +
    '<div class="dw-sec">總現值走勢' +
      '<button class="fx-reload" onclick="pvReload()" title="重新計算">↻</button>' +
    '</div>' + body + warn +
    '<div class="detail-note">近 ' + PV_SHOW + ' 個交易日。持股與成本由買賣台帳逐日重建' +
      (_pvData ? '（' + _pvData.codes + ' 檔）' : '') + '，收盤價用 Shioaji 1 分 K 聚合、無成交日沿用前一日。' +
      '長條是資本損益（現值 － 原始成本，純價差），配息沒有逐日資料，畫不出含息版本；' +
      '賣出當天現值與成本會同時減少，已實現獲利不留在線上；除息當天價格先扣、配息還沒入帳，' +
      '總現值會出現向下的台階，那不是虧損。長條的底是區間外側、不是 0（整段同號時 0 基準每根都會頂到天花板），實際基準標在左軸。' +
      '含息版本做不到：券商的配息欄位是自買進以來的累計，沒有日期可拆。</div>';

  if (_pvData && !_pvLoading && !_pvErr) pvBindHover(_pvData);
}
