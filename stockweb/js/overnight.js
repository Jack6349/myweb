// 股利總管 Web — 隔夜推估（跌深訊號板的上半部）
//
// 回答的是「明天開盤跳到哪、日內最低到哪、收盤大概在哪」，而且直接給**價格**不是百分比：
// 掛單要的是可以抄進委託單的數字，差額還得自己加減一次。價格一律對齊升降單位。
//
// 兩個輸入：台指期夜盤漲幅 ＋ 隔夜費半漲幅。
//   夜盤比費半準（台灣市場自己對美股結論的定價），但兩個一起最好——
//   2026-11-10 實測七檔全部如此，例如 00988A 的說明力 0.42（只用夜盤）、0.40（只用費半）、0.48（兩個）。
//   夜盤對日盤幾乎一比一（446 天，倍率 1.010、偏差 +0.03），沒有系統性高估或低估。
//
// 夜盤歷史 Yahoo 沒有，來自本機券商連線，存成 data/night-txf.json 由排程每日更新；
// 當天那一筆直接問本機伺服器（檔案可能還沒更新）。伺服器沒開就退回只用費半。
//
// 說明力最高 0.54、最低 0.26：**一半以上的隔日漲跌這兩個訊號解釋不了**。
// 所以卡片給的是區間不是點，而且區間寬度各檔不同（偏移度那張表）。

var OV_URL = 'data/night-txf.json';
var OV_REC_LS = 'overnight_rec_v1';      // 命中率紀錄（預測 vs 實際）
var _ovNight = null, _ovToday = null, _ovBusy = false, _ovRec = null;

// ── 夜盤資料 ──
async function ovLoadNight() {
  if (_ovNight) return _ovNight;
  try {
    var r = await fetch(OV_URL, { cache: 'no-cache' });
    var j = r.ok ? await r.json() : null;
    _ovNight = (j && j.map) || {};
  } catch (e) { hush('overnight', e); _ovNight = {}; }
  return _ovNight;
}
// 當天那一筆：檔案由排程每日更新，可能還沒跑，所以直接問本機伺服器。
// 伺服器沒開就退回檔案裡最後一筆（並標示日期，讓使用者看得出是不是舊的）。
async function ovTodayNight() {
  if (_ovToday) return _ovToday;
  var nm = await ovLoadNight();
  var fallback = function () {
    var ks = Object.keys(nm).sort();
    var d = ks[ks.length - 1];
    return d ? { d: d, pct: nm[d], src: 'file' } : null;
  };
  try {
    var now = new Date(Date.now() + 8 * 3600000);
    var from = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
    var to = now.toISOString().slice(0, 10);
    var r = await fetch('/api/v1/data/kbars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: { security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1' }, start: from, end: to })
    });
    if (!r.ok) throw new Error('kbars HTTP ' + r.status);
    var j = await r.json();
    var dt = j.datetime || [], cl = j.Close || [];
    var day = {}, night = {};
    for (var i = 0; i < dt.length; i++) {
      var d = dt[i].slice(0, 10), hm = dt[i].slice(11, 16);
      if (hm >= '08:45' && hm <= '13:45') day[d] = cl[i];
      else if (hm >= '15:00') night[d + '|1'] = cl[i];
      else if (hm <= '05:00') night[d + '|0'] = cl[i];
    }
    var ds = Object.keys(day).sort();
    if (ds.length < 2) throw new Error('日盤資料不足');
    var D = ds[ds.length - 1], P = ds[ds.length - 2];
    var px = night[D + '|0'] || night[P + '|1'];
    if (!(px > 0) || !(day[P] > 0)) throw new Error('夜盤資料不足');
    _ovToday = { d: D, pct: (px / day[P] - 1) * 100, src: 'live' };
  } catch (e) { hush('overnight', e); _ovToday = fallback(); }
  return _ovToday;
}

// ── 兩個輸入的最小平方（常數＋夜盤＋費半），3×3 直接解 ──
function _ovFit(X1, X2, Y) {
  var n = Y.length;
  if (n < 40) return null;
  var s = function (f) { var t = 0; for (var i = 0; i < n; i++) t += f(i); return t; };
  var M = [
    [n, s(function (i) { return X1[i]; }), s(function (i) { return X2[i]; }), s(function (i) { return Y[i]; })],
    [0, s(function (i) { return X1[i] * X1[i]; }), s(function (i) { return X1[i] * X2[i]; }), s(function (i) { return X1[i] * Y[i]; })],
    [0, 0, s(function (i) { return X2[i] * X2[i]; }), s(function (i) { return X2[i] * Y[i]; })]
  ];
  M[1][0] = M[0][1]; M[2][0] = M[0][2]; M[2][1] = M[1][2];
  for (var c = 0; c < 3; c++) {
    var p = c;
    for (var r2 = c; r2 < 3; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[p][c])) p = r2;
    var t2 = M[c]; M[c] = M[p]; M[p] = t2;
    if (Math.abs(M[c][c]) < 1e-10) return null;
    for (var r3 = 0; r3 < 3; r3++) {
      if (r3 === c) continue;
      var f = M[r3][c] / M[c][c];
      for (var k = c; k < 4; k++) M[r3][k] -= f * M[c][k];
    }
  }
  var b = [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  var my = s(function (i) { return Y[i]; }) / n, ss = 0, tot = 0, resU = [], resD = [];
  for (var i2 = 0; i2 < n; i2++) {
    var e = Y[i2] - (b[0] + b[1] * X1[i2] + b[2] * X2[i2]);
    ss += e * e; tot += (Y[i2] - my) * (Y[i2] - my);
    if (X1[i2] > 0) resU.push(e); else if (X1[i2] < 0) resD.push(e);
  }
  return {
    n: n, a: b[0], bN: b[1], bS: b[2], r2: tot ? 1 - ss / tot : null,
    sd: Math.sqrt(ss / (n - 3)), resU: resU, resD: resD
  };
}
function _ovSd(a) {
  if (!a || a.length < 8) return null;
  var m = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  return Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / a.length);
}
function _ovMed(a) {
  if (!a || !a.length) return null;
  var s2 = a.slice().sort(function (x, y) { return x - y; }), m = s2.length >> 1;
  return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
}
// 升降單位：50 元以下 0.01，以上 0.05。對齊之後才能直接抄進委託單
function ovTick(p) {
  if (!(p > 0)) return null;
  var u = p < 50 ? 0.01 : 0.05;
  return Math.round(Math.round(p / u) * u * 100) / 100;
}
function _ovPx(v) { return v == null ? '—' : v.toFixed(2); }

// 一檔的三個推估：開盤跳空、日內最低、收盤。都相對前一日收盤。
function ovEstimate(code) {
  var d = _rbData, sox = d && d.sox;
  if (!d || !_ovNight) return null;
  var bars = (d.series[code] || []).filter(function (b) { return b.o > 0 && b.l > 0 && b.c > 0; });
  if (bars.length < 45) return null;
  var X1 = [], X2 = [], Yo = [], Yl = [], Yc = [];
  for (var i = 1; i < bars.length; i++) {
    var dd = bars[i].d, pc = bars[i - 1].c;
    var nv = _ovNight[dd];
    if (nv == null || !(pc > 0)) continue;
    var u = sox ? sox.prev(dd) : null;
    var sv = (u && sox.rets[u] != null) ? sox.rets[u] : null;
    if (sv == null) continue;
    // 除息日整根排除：開高低是未還原價，跨除息會把配息算成跳空
    var f0 = bars[i - 1].a / bars[i - 1].c, f1 = bars[i].a / bars[i].c;
    if (Math.abs(f1 - f0) > 1e-6 * Math.max(f0, f1)) continue;
    X1.push(nv); X2.push(sv);
    Yo.push((bars[i].o / pc - 1) * 100);
    Yl.push((bars[i].l / pc - 1) * 100);
    Yc.push((bars[i].c / pc - 1) * 100);
  }
  var fo = _ovFit(X1, X2, Yo), fl = _ovFit(X1, X2, Yl), fc = _ovFit(X1, X2, Yc);
  if (!fc) return null;
  var t = _ovToday;
  if (!t) return null;
  var ev = function (f) { return f ? f.a + f.bN * t.pct + f.bS * _ovSox() : null; };
  // 基準價＝那一夜「之前」的最後一個收盤，不是最新收盤。
  // 盤中時最新一根就是今天，而今天反映的正是這一夜——用它當基準等於把答案當題目。
  var bi = -1;
  for (var k2 = bars.length - 1; k2 >= 0; k2--) { if (bars[k2].d < t.d) { bi = k2; break; } }
  if (bi < 0) return null;
  var base = bars[bi].c;
  // 那一天的 K 已經存在 → 這不是預測，是可以當場對答案的紀錄
  var act = (bi + 1 < bars.length && bars[bi + 1].d === t.d) ? bars[bi + 1] : null;
  var mk = function (p) { return p == null ? null : ovTick(base * (1 + p / 100)); };
  var pc2 = ev(fc);
  return {
    code: code, n: fc.n, base: base, basePrev: bars[bi].d,
    prem: _ovPrem(code), volX: _ovVolX(bars, act ? bi + 1 : bi),
    act: act ? { o: act.o, l: act.l, c: act.c,
                 cPct: (act.c / base - 1) * 100, lPct: (act.l / base - 1) * 100 } : null,
    oPct: ev(fo), lPct: ev(fl), cPct: pc2,
    oPx: mk(ev(fo)), lPx: mk(ev(fl)), cPx: mk(pc2),
    loPx: mk(pc2 == null ? null : pc2 - fc.sd), hiPx: mk(pc2 == null ? null : pc2 + fc.sd),
    sd: fc.sd, r2: fc.r2,
    sdUp: _ovSd(fc.resU), sdDn: _ovSd(fc.resD),
    medUp: _ovMed(fc.resU), medDn: _ovMed(fc.resD),
    nUp: fc.resU.length, nDn: fc.resD.length
  };
}
// 折溢價：跟 ETF 評比同一份（每日更新）。那一頁還沒載入就是空的，不為了一欄去觸發全市場抓取
function _ovPrem(code) {
  if (typeof esMetricsFor !== 'function') return null;
  try { var r = esMetricsFor(code); return (r && r.prem != null) ? r.prem : null; }
  catch (e) { return null; }
}
// 量能：該日成交量 ÷ 前 20 日均量。跳空上去沒量跟上的話，跟有量的跳空是兩回事
function _ovVolX(bars, i) {
  if (!bars[i] || !(bars[i].v > 0)) return null;
  var a = [];
  for (var k = i - 1; k >= 0 && a.length < 20; k--) if (bars[k].v > 0) a.push(bars[k].v);
  if (a.length < 10) return null;
  var m = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  return m > 0 ? bars[i].v / m : null;
}
function _ovSox() {
  var s = _rbData && _rbData.sox;
  return (s && s.last) ? s.last.r : 0;
}

// ── 命中率追蹤：每天存一次推估，隔天拿實際回來對 ──
// 不記錄的話，「這套方法到底準不準」永遠只能一天一天手動回測。
function _ovRecLoad() {
  if (_ovRec) return _ovRec;
  try { _ovRec = JSON.parse(localStorage.getItem(OV_REC_LS) || '{}') || {}; } catch (e) { _ovRec = {}; }
  return _ovRec;
}
function _ovRecSave() { try { localStorage.setItem(OV_REC_LS, JSON.stringify(_ovRec)); } catch (e) {} }
// 存今天的推估（同一天只存第一次，之後盤中重算不覆蓋——否則會變成事後諸葛）
function ovRecord(rows) {
  var t = _ovToday;
  if (!t || !rows || !rows.length) return;
  var rec = _ovRecLoad();
  if (!rec[t.d]) {
    rec[t.d] = { night: +t.pct.toFixed(2), sox: +_ovSox().toFixed(2), est: {} };
    rows.forEach(function (r) { if (r.cPct != null) rec[t.d].est[r.code] = +r.cPct.toFixed(2); });
    _ovRecSave();
  }
  // 回填已經有實際值的日子
  var d = _rbData, dirty = false;
  Object.keys(rec).forEach(function (day) {
    var e = rec[day];
    if (e.act && Object.keys(e.act).length === Object.keys(e.est).length) return;
    e.act = e.act || {};
    Object.keys(e.est).forEach(function (c) {
      if (e.act[c] != null) return;
      var bars = d.series[c] || [];
      for (var i = 1; i < bars.length; i++) {
        if (bars[i].d !== day) continue;
        if (!(bars[i - 1].c > 0)) break;
        e.act[c] = +((bars[i].c / bars[i - 1].c - 1) * 100).toFixed(2);
        dirty = true;
        break;
      }
    });
  });
  if (dirty) _ovRecSave();
}
function ovHitHtml() {
  var rec = _ovRecLoad(), days = Object.keys(rec).sort();
  var errs = [], n = 0, within = 0;
  days.forEach(function (day) {
    var e = rec[day];
    Object.keys(e.est).forEach(function (c) {
      if (e.act && e.act[c] != null) {
        var g = e.act[c] - e.est[c];
        errs.push(g); n++;
        if (Math.abs(g) <= 2.5) within++;
      }
    });
  });
  if (!n) {
    return '<div class="rb-caveat nb-keep">命中率：還沒有可對照的紀錄。每天進這一頁會把當天的推估存下來，' +
      '隔天拿實際收盤回來對。累積之後才答得出「這套方法是不是系統性低估、哪一檔特別不準」——' +
      '今天看一次是看不出來的。紀錄存在本機瀏覽器。</div>';
  }
  var med = _ovMed(errs), avg = errs.reduce(function (a, b) { return a + b; }, 0) / n;
  return '<div class="rb-caveat nb-keep"><b>命中率追蹤</b>：已對照 ' + n + ' 筆（' + days.length + ' 天）。' +
    '實際減推估的中位數 <b>' + (med >= 0 ? '+' : '−') + Math.abs(med).toFixed(2) + '</b> 個百分點、平均 ' +
    (avg >= 0 ? '+' : '−') + Math.abs(avg).toFixed(2) + '；落在 ±2.5 個百分點內的佔 ' +
    Math.round(within / n * 100) + '%。中位數明顯偏正代表這套方法系統性低估，偏負代表高估。' +
    '紀錄存在本機瀏覽器，換電腦不會跟著走。</div>';
}

// ── 畫面 ──
async function ovPrepare() {
  if (_ovBusy) return;
  _ovBusy = true;
  try { await ovLoadNight(); await ovTodayNight(); } finally { _ovBusy = false; }
}
function ovHtml(view) {
  if (!_rbData || !_ovNight) return '';
  var t = _ovToday;
  if (!t) {
    return '<div class="rb-caveat nb-keep">拿不到台指期夜盤（本機券商連線未開，且資料檔是空的），隔夜推估略過。</div>';
  }
  var rows = _rbData.codes.map(ovEstimate).filter(Boolean);
  if (!rows.length) return '';
  rows.sort(function (a, b) { return b.cPct - a.cPct; });
  ovRecord(rows);
  var hasAct = rows.some(function (r) { return r.act; });

  var sox = _ovSox();
  var pct = function (v, dec) {
    if (v == null) return '—';
    return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(dec == null ? 2 : dec) + '%';
  };
  var h = '<div class="rb-sox">';
  h += '<div class="sec-title">隔夜推估（明天的價格）</div>';
  h += '<div class="rb-sox-hd on">台指期夜盤 <b style="color:' + _rbCol(t.pct) + '">' + pct(t.pct) + '</b>' +
    '（' + t.d + (t.src === 'live' ? '，券商即時' : '，資料檔') + '）　' +
    '隔夜費半 <b style="color:' + _rbCol(sox) + '">' + pct(sox) + '</b>' +
    '<br>價格以 <b>' + (rows[0] ? rows[0].basePrev : '') + '</b> 的收盤為基準，已對齊可掛的升降單位，直接抄進委託單即可。' +
    '<b>掛限價買進看「預估日內最低」</b>——掛在它之下，成交的前提是當天比預估弱。' +
    (hasAct
      ? '<br><b style="color:var(--accent2)">這一夜已經開過盤了</b>：' + _ovToday.d
        + ' 的 K 線已存在，右邊列出實際值可以當場對答案。'
        + '下一個交易日的推估要等今晚 15:00 之後的夜盤開出來才有。'
      : '') + '</div>';

  h += '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>' +
    '<th>代號 / 名稱</th><th class="num">前收</th>' +
    '<th class="num" title="當天開盤價的推估">預估開盤</th>' +
    '<th class="num" title="當天盤中最低價的推估。掛限價買進要跟這個比，不是跟收盤比">預估日內最低</th>' +
    '<th class="num" title="當天收盤價的推估">預估收盤</th>' +
    '<th class="num" title="收盤推估上下各一個典型偏移，約三分之二的日子落在這個範圍">典型範圍</th>' +
    (hasAct ? '<th class="num" title="那一天實際的收盤與日內最低">實際收盤</th>'
            + '<th class="num">實際日內最低</th>' : '') +
    '<th class="num" title="市價相對預估淨值：正數代表買貴了。開高跳空當下容易跑到溢價">折溢價</th>' +
    '<th class="num" title="當日成交量 ÷ 近 20 日均量。跳空上去有沒有量跟上">量能</th>' +
    '<th class="num" title="這兩個訊號說明得了多少起伏；1 是完全說中、0 是完全說不中">說明力</th>' +
    '<th class="num">樣本</th></tr></thead><tbody>';
  rows.forEach(function (r) {
    h += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + _rbName(r.code) + '</span></td>' +
      '<td class="num rs-dim">' + _ovPx(r.base) + '</td>' +
      '<td class="num">' + _ovPx(r.oPx) + '<span class="ov-sub">' + pct(r.oPct) + '</span></td>' +
      '<td class="num ov-key">' + _ovPx(r.lPx) + '<span class="ov-sub">' + pct(r.lPct) + '</span></td>' +
      '<td class="num" style="font-weight:700">' + _ovPx(r.cPx) + '<span class="ov-sub">' + pct(r.cPct) + '</span></td>' +
      '<td class="num rs-dim">' + _ovPx(r.loPx) + ' ～ ' + _ovPx(r.hiPx) + '</td>' +
      (hasAct ? '<td class="num" style="color:' + _rbCol(r.act ? r.act.cPct : null) + ';font-weight:700">'
          + (r.act ? _ovPx(r.act.c) : '—')
          + (r.act ? '<span class="ov-sub">' + pct(r.act.cPct) + '</span>' : '') + '</td>'
        + '<td class="num">' + (r.act ? _ovPx(r.act.l) : '—')
          + (r.act ? '<span class="ov-sub">' + pct(r.act.lPct) + '</span>' : '') + '</td>' : '') +
      '<td class="num" style="color:' + (r.prem == null ? 'var(--text3)' : _rbCol(r.prem)) + '">'
        + (r.prem == null ? '—' : pct(r.prem)) + '</td>' +
      '<td class="num' + (r.volX != null && r.volX >= 1.5 ? ' ov-key' : '') + '">'
        + (r.volX == null ? '—' : r.volX.toFixed(2) + ' 倍') + '</td>' +
      '<td class="num rs-dim">' + (r.r2 == null ? '—' : r.r2.toFixed(2)) + '</td>' +
      '<td class="num rs-dim">' + r.n + ' 天</td></tr>';
  });
  h += '</tbody></table></div>';

  // 偏移度：這一檔照不照劇本走。跟「會漲多少」無關，跟「掛價要留多少餘裕」直接相關。
  if (view === 'ana') {
    h += '<div class="sec-title">偏移度（實際與推估的差距）</div>' +
      '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>' +
      '<th>代號 / 名稱</th><th class="num">整體上下差</th>' +
      '<th class="num">夜盤上漲的日子</th><th class="num">夜盤下跌的日子</th></tr></thead><tbody>';
    rows.slice().sort(function (a, b) { return a.sd - b.sd; }).forEach(function (r) {
      var cell = function (sd, med, n) {
        if (sd == null) return '<td class="num rs-dim">樣本不足</td>';
        return '<td class="num">' + (med >= 0 ? '+' : '−') + Math.abs(med).toFixed(2) +
          '<span class="ov-sub">上下 ' + sd.toFixed(2) + '　' + n + ' 天</span></td>';
      };
      h += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + _rbName(r.code) + '</span></td>' +
        '<td class="num" style="font-weight:700">' + r.sd.toFixed(2) + '</td>' +
        cell(r.sdUp, r.medUp, r.nUp) + cell(r.sdDn, r.medDn, r.nDn) + '</tr>';
    });
    h += '</tbody></table></div>' +
      '<div class="rb-caveat">數字單位是百分點。「整體上下差」小的那幾檔照劇本走，大的那幾檔同樣的夜盤漲幅、' +
      '結果散得多很多——這跟「會漲多少」無關，跟「掛價要留多少餘裕」直接相關。' +
      '每一欄的主數字是偏移的中位數（正＝實際比推估高），小字是上下差與天數。</div>';
  }

  h += ovHitHtml();
  h += '</div>';
  return h;
}
