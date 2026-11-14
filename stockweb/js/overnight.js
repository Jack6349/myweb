// 股利總管 Web — 隔夜推估（進場訊號板的上半部）
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

// 分 K 的時刻標在「那一分鐘的結尾」，不是開頭。
// 實測兩次：牆上時鐘 00:36:51 時最後一根標 00:37:00，00:38:27 時標 00:39:00。
// 也就是標 00:34 的那根涵蓋的是 00:33:00～00:33:59。
// 直接把標籤當成成交時刻顯示，畫面會比系統時間早一分鐘，看起來像抓到了未來的資料。
// loadTxfIntra 的檔頭寫「日盤 08:46 → 13:45」也是同一件事：開盤是 08:45，
// 第一根被標成 08:46。
function kbarMin(iso) {
  if (!iso || iso.length < 16) return '';
  var h = +iso.slice(11, 13), m = +iso.slice(14, 16) - 1;
  if (m < 0) { m = 59; h = (h + 23) % 24; }
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

var OV_SD_HL = 10;       // 區間寬度的半衰期（交易日），見 _ovFit 檔頭
var OV_URL = 'data/night-txf.json';
var OV_REC_LS = 'overnight_rec_v1';      // 命中率紀錄（預測 vs 實際）
var _ovNight = null, _ovToday = null, _ovBusy = false, _ovRec = null, _ovAt = null;

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
    // 要的是「還沒被任何現貨盤消化掉的那一夜」：
    // 找最後一個已收盤的日盤當基準，再取它之後的最後一根夜盤價。
    //
    // 舊寫法用「最後兩個日盤日期」配對，永遠指到上一夜——而上一夜早就被
    // 上一個日盤反應完了。2026-11-11 03:36 實例：推估卡顯示 +2.70%（是 11/09 夜、
    // 11/10 日盤已經漲 +2.52% 反應過），而總覽顯示的今晚這一盤是 −0.47%。
    var lastDayIdx = -1, lastDayDate = null;
    for (var i = 0; i < dt.length; i++) {
      var hm = dt[i].slice(11, 16);
      if (hm >= '08:45' && hm <= '13:45') { lastDayIdx = i; lastDayDate = dt[i].slice(0, 10); }
    }
    if (lastDayIdx < 0) throw new Error('日盤資料不足');
    var baseClose = cl[lastDayIdx];
    // 日盤收盤之後的最後一根夜盤（夜盤 15:00～次日 05:00，可跨午夜）
    var nIdx = -1;
    for (var k = lastDayIdx + 1; k < dt.length; k++) {
      var h2 = dt[k].slice(11, 16);
      if (h2 >= '15:00' || h2 <= '05:00') nIdx = k;
    }
    var pending = nIdx >= 0;          // 這一夜還沒開過盤
    if (!pending) {
      // 今天日盤已收、今晚還沒開：退回「驅動這一個日盤的那一夜」，卡頭會標成已開過盤
      // 往回找上一夜。遇到日盤就停——但盤中時 lastDayIdx 本身就在今天的日盤裡，
      // 往回走的頭幾十根還是今天的日盤，一遇到就停等於永遠找不到夜盤。
      // 2026-11-13 11:13 實測：整個 08:45～15:00 都抽不到，退回資料檔，
      // 畫面因此推估「昨天」那一盤，而且沒有任何地方說它是昨天的。
      // 只有走到「更早那一天的日盤」才算越界。
      var pIdx = -1;
      for (var q = lastDayIdx - 1; q >= 0; q--) {
        var h3 = dt[q].slice(11, 16);
        if (h3 >= '08:45' && h3 <= '13:45') { if (dt[q].slice(0, 10) !== lastDayDate) break; continue; }
        if (h3 >= '15:00' || h3 <= '05:00') { if (pIdx < 0) pIdx = q; }
      }
      // 基準價要取「更早那一天」的日盤收盤，不是今天盤中的價
      var prevDayIdx = -1;
      for (var q2 = lastDayIdx - 1; q2 >= 0; q2--) {
        var h4 = dt[q2].slice(11, 16);
        if (h4 >= '08:45' && h4 <= '13:45' && dt[q2].slice(0, 10) !== lastDayDate) { prevDayIdx = q2; break; }
      }
      if (pIdx < 0 || prevDayIdx < 0) throw new Error('夜盤資料不足');
      nIdx = pIdx; baseClose = cl[prevDayIdx]; lastDayDate = dt[prevDayIdx].slice(0, 10);
    }
    if (!(cl[nIdx] > 0) || !(baseClose > 0)) throw new Error('夜盤資料不足');
    // d＝這一夜要驅動的那個交易日。夜盤跨午夜後就是那一天；
    // 還沒跨午夜（像晚上 20:00）則是基準日的隔天。
    var nd = dt[nIdx].slice(0, 10);
    var drive = (nd > lastDayDate) ? nd
      : new Date(Date.parse(lastDayDate) + 86400000).toISOString().slice(0, 10);
    _ovToday = { d: drive, pct: (cl[nIdx] / baseClose - 1) * 100, src: 'live',
                 base: lastDayDate, at: kbarMin(dt[nIdx]), pending: pending,
                 bp: baseClose, np: cl[nIdx] };
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
  // 區間寬度用「近期加權」的殘差，不是全部歷史的平均。
  //
  // 全部歷史那一版，實測覆蓋率只有 57 到 58%（00981A、00988A），而卡片寫「約三分之二」。
  // 原因是殘差本身會變：00981A 分段估是 1.48、1.27、2.25、2.91、2.38，最大是最小的 2.3 倍，
  // 平均進去等於用平靜期的尺去量現在。
  //
  // 半衰期 10 日是測出來的，不是挑的。八檔的覆蓋率偏離 68% 的平均絕對值：
  // 全部歷史 7.6、半衰60 5.6、半衰30 4.7、半衰20 3.5、半衰15 2.2、半衰10 1.9、半衰5 1.8。
  // 5 到 15 是一片平台，取 10 是因為更短會讓區間每天跳一到三個升降單位（半衰5 是 0.011～0.034 元，
  // 半衰10 是 0.006～0.018 元），畫面會抖而校準沒有變好。
  //
  // 係數維持全部歷史：測過 45、60、75、90 日與各種加權，四檔裡三檔都比全部歷史差。
  // 係數的時變性偵測不到（分段變異 ÷ 估計誤差應有的變異＝0.72 與 0.21，都小於 1）。
  var lam = Math.pow(0.5, 1 / OV_SD_HL), v = null, hit = 0, cvn = 0;
  for (var i2 = 0; i2 < n; i2++) {
    var e = Y[i2] - (b[0] + b[1] * X1[i2] + b[2] * X2[i2]);
    ss += e * e; tot += (Y[i2] - my) * (Y[i2] - my);
    if (X1[i2] > 0) resU.push(e); else if (X1[i2] < 0) resD.push(e);
    // 實測覆蓋率：當下那條區間有沒有罩住當天的實際值。前 40 天讓 EWMA 先收斂。
    if (v != null && i2 >= 40) { if (Math.abs(e) <= Math.sqrt(v)) hit++; cvn++; }
    v = (v == null) ? e * e : lam * v + (1 - lam) * e * e;
  }
  return {
    n: n, a: b[0], bN: b[1], bS: b[2], r2: tot ? 1 - ss / tot : null,
    sd: Math.sqrt(ss / (n - 3)),
    sdEw: (v == null) ? Math.sqrt(ss / (n - 3)) : Math.sqrt(v),
    cover: cvn ? hit / cvn * 100 : null, coverN: cvn,
    resU: resU, resD: resD
  };
}
// 說明力分三段亮度。這一頁的紅綠是漲跌，不能拿來標可信度。
//
// 門檻 0.5 與 0.25 是「解釋掉一半」「解釋掉四分之一」，不是從目前這幾檔的分布倒推的
// （那會隨持股變動而漂移）。實測兩個更自然的候選都分不出差別：
// 區間校不校準（八檔全在 68% ± 2 標準誤內）、訊號顯不顯著（F 值 20 到 109，門檻 3.1）。
// 會變的只有幅度，所以顏色接幅度。
function _ovTier(r2) {
  if (r2 == null) return 'ov-t0';
  return (r2 > 0.5) ? 'ov-t3' : ((r2 >= 0.25) ? 'ov-t2' : 'ov-t1');
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
// 持股成本均價（與持股庫存同一個來源）。
// 只在關注清單、沒有持股的回 null，表上標「—」——
// 標 0 會被讀成「成本是零」，跟「沒有這筆持股」是兩回事。
// ═════ 進場訊號板的表格排序（三張表共用）═════
//
// 價格類欄位照排：掋單時要看預算、要算幾張買得起。
// 但要知道實測的結果：依前收、依預估日內最低、依預估收盤排出來是同一個順序——
// 這幾檔的預估漲跌都在幾個百分點之內，價格水準差好幾倍，把排序蓋過去了。
// 成交率表的掋價格子更絕對：每格是前收 × (1+k%)，k 對整欄固定，
// 依它的價格排必然等於依前收排，所以那幾欄排的是成交率。
//
// 沒值的一律墊底（升冪降冪都是），與全站其他表格一致。
function rbSortGet(ls, def) {
  try {
    var v = localStorage.getItem(ls);
    if (v && /(Asc|Desc)$/.test(v)) return v;
  } catch (e) {}
  return def;
}
function rbSortNext(cur, k) { return cur === k + 'Desc' ? k + 'Asc' : k + 'Desc'; }
function rbSortTh(state, fn, k, label, tip) {
  var on = state.replace(/(Asc|Desc)$/, '') === k, asc = on && /Asc$/.test(state);
  return '<th class="num sort-th' + (on ? ' sorted' : '') + '" onclick="' + fn + '(\'' + k + '\')"'
    + (tip ? ' title="' + tip + '"' : '') + '>' + label
    + '<span class="sort-ind">' + (on ? (asc ? '\u25b2' : '\u25bc') : '\u2195') + '</span></th>';
}
function rbSortRows(rows, state, val) {
  var k = state.replace(/(Asc|Desc)$/, ''), asc = /Asc$/.test(state);
  var idx = {}; rows.forEach(function (r, i) { idx[r] = i; });
  return rows.slice().sort(function (a, b) {
    var x = val(a, k), y = val(b, k);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    var c = (typeof x === 'string') ? x.localeCompare(y, undefined, { numeric: true }) : x - y;
    return asc ? c : -c;
  });
}

// 預設不綁在任何一欄：維持原本「預估收盤漲幅由大到小」的順序，
// 點了欄位才改排。價格類欄位照排價格（掋單要算預算與張數）。
var OV_SORT_LS = 'ov_sort_v1', OV_DSORT_LS = 'ov_dsort_v1';
var _ovSort = rbSortGet(OV_SORT_LS, 'cPctDesc');
var _ovDSort = rbSortGet(OV_DSORT_LS, 'sdAsc');
function ovSort(k) {
  _ovSort = rbSortNext(_ovSort, k);
  try { localStorage.setItem(OV_SORT_LS, _ovSort); } catch (e) {}
  if (typeof rbRender === 'function') rbRender();
}
function ovDSort(k) {
  _ovDSort = rbSortNext(_ovDSort, k);
  try { localStorage.setItem(OV_DSORT_LS, _ovDSort); } catch (e) {}
  if (typeof rbRender === 'function') rbRender();
}
function _ovSortVal(r, k) {
  if (k === 'code') return r.code;
  if (k === 'live') { var lv = _ovLiveOf(r.code); return lv ? lv.px : null; }
  if (k === 'range') return r.loPx;          // 範圍照價格排（下界）
  if (k === 'actC') return r.act ? r.act.c : null;
  if (k === 'actL') return r.act ? r.act.l : null;
  return r[k] == null ? null : r[k];
}
function _ovDSortVal(r, k) {
  if (k === 'code') return r.code;
  // 偏移度按「元」排（使用者指定）：百分點 × 前收 ÷ 100
  var y = function (v) { return (v == null || !(r.basePx > 0)) ? null : v * r.basePx / 100; };
  if (k === 'sd') return y(r.sd);
  if (k === 'medUp') return y(r.medUp);
  if (k === 'medDn') return y(r.medDn);
  return null;
}

// ══════════ 現價（盤中即時，收盤後停住）══════════
// 這一頁本來只有日線，沒有任何即時來源。推估的那一盤正在進行時，
// 旁邊沒有現價就只能自己切到別頁對照——推估與實際是這張表的全部重點。
//
// 收盤後不動：盤中每 30 秒抓一次券商快照，13:35 之後那一輪直接跳過，
// 畫面停在最後一次抓到的價。不是「凍結一個舊值」，是收盤價本來就不會再變。
var OV_LIVE_MS = 30000;
var _ovLive = {};          // code -> { px, d, at }
var _ovLiveAt = '', _ovLiveOpen = null, _ovLiveTimer = null;

function _ovEx(code) {
  var ct = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
  if (ct && ct.exchange) return ct.exchange;
  var f = ((typeof _wtIdx !== 'undefined' && _wtIdx) || []).filter(function (x) { return x.c === code; })[0];
  return f ? f.e : 'TSE';
}
async function _ovLiveTick(always) {
  var view = document.getElementById('rebound-view');
  if (!view || view.style.display === 'none' || document.hidden) return;
  if (!_rbData || !_rbData.codes || !_rbData.codes.length) return;
  if (typeof fetchSnapshots !== 'function') return;
  var open = (typeof _twOpen === 'function') ? _twOpen() : false;
  // 收盤後只在進頁那一次抓（always），之後每一輪都在這裡掉頭
  if (!always && !open) return;
  try {
    var sn = await fetchSnapshots(_rbData.codes.map(function (c) { return { exchange: _ovEx(c), code: c }; }));
    (sn || []).forEach(function (x) {
      if (x && x.code && x.close > 0) {
        _ovLive[String(x.code)] = { px: +x.close, d: (x.datetime || '').slice(0, 10), at: (x.datetime || '').slice(11, 19) };
      }
    });
    _ovLiveAt = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 19);
    _ovLiveOpen = open;
    if (typeof rbRender === 'function') rbRender();
  } catch (e) { hush('overnight-live', e); }   // 券商連線中斷 → 維持上一次的價
}
function ovLiveStart() {
  _ovLiveTick(true);
  if (!_ovLiveTimer) _ovLiveTimer = setInterval(function () { _ovLiveTick(false); }, OV_LIVE_MS);
}
// 這一檔現在的價，以及它屬於哪一天。
// 日期要帶著走：晚上推估明天時，快照回來的是今天的收盤，那不是「推估那一盤的現價」，
// 不能拿去跟前收算漲跌（算出來一定是 0%，整欄都是假的 0）。
function _ovLiveOf(code) {
  var v = _ovLive[String(code)];
  if (v && v.px > 0) return v;
  var r = (typeof _rows !== 'undefined' && _rows[String(code)]) || null;   // 持股的 SSE tick
  return (r && r.close > 0) ? { px: r.close, d: '', at: r.time || '' } : null;
}

// 現價那一格。t＝_ovToday（推估的是哪一盤）。
// 三種狀況分開講，不混成一個數字：
//   1. 快照的日期就是推估那一盤 → 現價，附對前收的漲跌，上色
//   2. 快照是更早的日期（晚上看明天）→ 那一盤還沒開始，標灰、不給漲跌
//   3. 完全沒有快照（券商連線沒開）→ 破折號
function _ovLiveCell(r, t) {
  var lv = _ovLiveOf(r.code);
  if (!lv) return '<td class="num"><span class="dm-dim" title="券商快照取不到（本機連線未開）">—</span></td>';
  var sameDay = !lv.d || !t || !t.d || lv.d === t.d;
  if (!sameDay) {
    // 兩個方向都會發生，講錯方向比不講更糟：
    // 快照比推估早＝那一盤還沒開始（晚上看明天）；比推估晚＝那一盤已經過去了。
    var tip = lv.d < t.d
      ? '這是 ' + lv.d + ' 的收盤，推估的 ' + t.d + ' 那一盤還沒開始'
      : '這是 ' + lv.d + ' 的價，推估的是 ' + t.d + ' 那一盤，已經過去了';
    return '<td class="num"><span class="dm-dim" title="' + tip + '">' + _ovPx(lv.px)
      + '<span class="ov-sub dm-dim">' + lv.d.slice(5).replace('-', '/') + '</span></span></td>';
  }
  var ch = (r.base > 0) ? (lv.px / r.base - 1) * 100 : null;
  return '<td class="num ov-key">' + _ovPx(lv.px)
    + '<span class="ov-sub" style="color:' + _rbCol(ch) + '">'
    + (ch == null ? '—' : (ch > 0 ? '+' : (ch < 0 ? '\u2212' : '')) + Math.abs(ch).toFixed(2) + '%')
    + '</span></td>';
}

function _ovCost(code) {
  var ps = (typeof _positions !== 'undefined' && _positions) || [];
  for (var i = 0; i < ps.length; i++) {
    if (String(ps[i].code) === String(code) && ps[i].price > 0) return ps[i].price;
  }
  return null;
}

function _ovPx(v) { return v == null ? '—' : v.toFixed(2); }

// 一檔的三個推估：開盤跳空、日內最低、收盤。都相對前一日收盤。
function ovEstimate(code) {
  var d = _rbData, sox = d && d.sox;
  if (!d || !_ovNight) return null;
  // raw：只要有收盤就算數，用來挑基準價。
  // bars：還要有日內高低才能跑迴歸（開盤、最低那兩條）。
  // 兩者不能混用：Yahoo 單日線最後一根的收盤有時是 null、由 meta 補上的，
  // 那一根沒有日內高低，若一起濾掉會讓基準價退到前一天——
  // 2026-11-11 實例：00981A 基準價變成 11/09 的 23.06，而不是 11/10 的 24.27。
  var raw = (d.series[code] || []).filter(function (b) { return b.c > 0; });
  var bars = raw.filter(function (b) { return b.o > 0 && b.l > 0; });
  if (bars.length < 45 || !raw.length) return null;
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
  for (var k2 = raw.length - 1; k2 >= 0; k2--) { if (raw[k2].d < t.d) { bi = k2; break; } }
  if (bi < 0) return null;
  var base = raw[bi].c;
  // 偏移度要把百分點換回元，把基準價帶出去
  // 那一天的 K 已經存在 → 這不是預測，是可以當場對答案的紀錄
  var act = (bi + 1 < raw.length && raw[bi + 1].d === t.d) ? raw[bi + 1] : null;
  var mk = function (p) { return p == null ? null : ovTick(base * (1 + p / 100)); };
  var pc2 = ev(fc);
  return {
    code: code, n: fc.n, base: base, basePrev: raw[bi].d,
    basePx: base,   // 偏移度要把百分點換回元
    cost: _ovCost(code),                                   // 持股成本均價，沒持股為 null
    baseChg: (bi > 0 && raw[bi - 1].c > 0) ? (base / raw[bi - 1].c - 1) * 100 : null,
    prem: _ovPrem(code), volX: _ovVolX(raw, act ? bi + 1 : bi),
    act: act ? { o: act.o, l: act.l, c: act.c,
                 cPct: (act.c / base - 1) * 100, lPct: (act.l / base - 1) * 100 } : null,
    oPct: ev(fo), lPct: ev(fl), cPct: pc2,
    oPx: mk(ev(fo)), lPx: mk(ev(fl)), cPx: mk(pc2),
    loPx: mk(pc2 == null ? null : pc2 - fc.sdEw), hiPx: mk(pc2 == null ? null : pc2 + fc.sdEw),
    // 日內最低自己的區間。掛限價買進看的是這一個，不是收盤那一個，
    // 原本只有收盤有範圍，等於把最該有不確定性的那個數字寫成一個確定的價。
    lLoPx: (function () { var q = ev(fl); return (q == null || !fl) ? null : mk(q - fl.sdEw); })(),
    lHiPx: (function () { var q = ev(fl); return (q == null || !fl) ? null : mk(q + fl.sdEw); })(),
    lCover: fl ? fl.cover : null, lCoverN: fl ? fl.coverN : null,
    sd: fc.sdEw, sdFull: fc.sd, cover: fc.cover, coverN: fc.coverN, r2: fc.r2,
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
// 費半要跟總覽抽屜抽同一份價。
// 舊寫法用日線的最後一根，那一根盤中會更新、但更得比即時價慢：
// 2026-11-11 04:05 實例，總覽 −1.10%、推估卡 −0.72%，兩邊對不起來。
// 這裡改走 5 分鐘分時（基準為 chartPreviousClose，與總覽完全同一個定義），
// 抽不到再退回日線。
var _ovSoxLive = null;          // { r, at, open }

async function _ovLoadSoxLive() {
  if (_ovSoxLive) return _ovSoxLive;
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX?interval=5m&range=1d';
  var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
  var j = await r.json();
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('sox intra');
  var m = res.meta || {}, ts = res.timestamp || [];
  var cl = (res.indicators && res.indicators.quote && res.indicators.quote[0]
            && res.indicators.quote[0].close) || [];
  var ref = m.chartPreviousClose, lastC = null, lastT = null;
  for (var i = cl.length - 1; i >= 0; i--) {
    if (cl[i] != null && ts[i] != null) { lastC = cl[i]; lastT = ts[i]; break; }
  }
  if (!(ref > 0) || !(lastC > 0)) throw new Error('sox intra empty');
  // 開盤與否不能用 m.marketState：代理服務的回應根本沒有這個欄位，
  // undefined === 'REGULAR' 永遠是 false，所以卡上一直寫「已收盤」，盤中也一樣。
  // 2026-11-12 紐約 13:05（台北 02:05）實測：meta 裡只有 regularMarketTime、
  // timezone、exchangeTimezoneName、currentTradingPeriod、tradingPeriods。
  //
  // 改用回應裡真的有的東西：最後報價時刻跟該標的自己的收盤時間比。
  var rg = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  var live = (rg && rg.end && m.regularMarketTime) ? (m.regularMarketTime < rg.end) : null;
  // 標台灣時間，與卡上夜盤的時刻同一個時區才比得起來
  _ovSoxLive = {
    r: (lastC / ref - 1) * 100,
    at: new Date((lastT + 8 * 3600) * 1000).toISOString().slice(11, 16),
    open: live
  };
  return _ovSoxLive;
}

// 卡上的夜盤漲幅與總覽永遠差一點，因為兩邊的基準不同：
//   這裡＝前一交易日日盤 13:45 的最後成交價
//   總覽＝期交所參考價（結算價），與券商 App 一致
// 2026-11-11 實測：成交價兩邊都是 42,522，但基準 42,623 vs 42,646，
// 算出 −0.24% 與 −0.29%。不是其中一邊沒重抓。
//
// 為何不改成跟總覽同一個基準：這一卡的系數是用 446 天「對前一日日盤
// 收盤」迴歸出來的，而參考價沒有歷史資料可以重新迴歸。
// 此外現貨市場自己的漲跌也是對前一日收盤，要推現貨就該用收盤當基準。
// 所以兩個數字並列、各標各自的基準，不讓使用者自己猜哪一個是舊的。
var _ovRef = null;              // { pct, px, at }

async function _ovLoadRef() {
  if (_ovRef) return _ovRef;
  var r = await fetch(API + '/api/v1/data/snapshots', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contracts: [{ security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1' }] })
  });
  if (!r.ok) throw new Error('snapshot HTTP ' + r.status);
  var a = await r.json(), q = a && a[0];
  if (!q || q.close == null || q.change_price == null) throw new Error('snapshot empty');
  _ovRef = { pct: q.change_rate, px: q.close - q.change_price, at: (q.datetime || '').slice(11, 16) };
  return _ovRef;
}

function _ovSox() {
  if (_ovSoxLive) return _ovSoxLive.r;
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
// force＝按了「重新整理」。不清快取的話夜盤會停在進頁那一刻：
// 2026-11-11 實例，抽屜已經是 04:05 的價，推估卡還寫 03:49。
async function ovPrepare(force) {
  if (_ovBusy) return;
  _ovBusy = true;
  if (force) { _ovToday = null; _ovNight = null; _ovSoxLive = null; _ovRef = null; }
  try {
    await ovLoadNight();
    await ovTodayNight();
    try { await _ovLoadSoxLive(); } catch (e) { hush('overnight-sox', e); }
    try { await _ovLoadRef(); } catch (e) { hush('overnight-ref', e); }
  } finally { _ovBusy = false; }
  _ovAt = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
}
function ovHtml(view) {
  if (!_rbData || !_ovNight) return '';
  var t = _ovToday;
  if (!t) {
    return '<div class="rb-caveat nb-keep">拿不到台指期夜盤（本機券商連線未開，且資料檔是空的），隔夜推估略過。</div>';
  }
  var rows = _rbData.codes.map(ovEstimate).filter(Boolean);
  if (!rows.length) return '';
  rows = (_ovSort === 'cPctDesc')
    ? rows.slice().sort(function (a, b) { return b.cPct - a.cPct; })
    : rbSortRows(rows, _ovSort, _ovSortVal);
  ovRecord(rows);
  var hasAct = rows.some(function (r) { return r.act; });

  var ana = (view === 'ana');
  var sox = _ovSox();
  // 實測覆蓋率放提示，不放欄位：它是用來驗證區間的，不是你每天要讀的數字。
  // 樣本少的時候連這個覆蓋率自己都估不準，所以把標準誤一起寫進去。
  var cvTip = function (cv, n2, nm) {
    if (cv == null || !n2) return '';
    var se = Math.sqrt(0.68 * 0.32 / n2) * 100;
    return ' title="' + nm + '區間實測罩住了 ' + Math.round(cv) + '% 的日子（' + n2 + ' 天，誤差 ±'
      + se.toFixed(1) + ' 個百分點）。目標是 68%，' +
      (Math.abs(cv - 68) <= 2 * se ? '目前在誤差範圍內' : (cv < 68 ? '目前偏窄' : '目前偏寬')) + '"';
  };
  var pct = function (v, dec) {
    if (v == null) return '—';
    return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(dec == null ? 2 : dec) + '%';
  };
  var h = '<div class="rb-sox">';
  h += '<div class="sec-title">隔夜推估（明天的價格）</div>';
  var nf = function (v) { return v == null ? '—' : Math.round(v).toLocaleString('zh-TW'); };
  // 標額區只留「現在是什麼狀況」的事實，解釋全改放到下方的說明裡。
  // 舊版這一塊 418 字，而且用的是標額標記，全站的說明收合機制根本收不到它。
  // 基準要標出來。這個百分比比的是「日盤最後一根 K 的收盤」，
  // 總覽盤勢那一格比的是「期交所參考價」（當日結算價＝最後一分鐘的成交量加權均價），
  // 兩者差幾點，所以同一時刻兩邊會差 0.02～0.03 個百分點。
  // 這裡不能改用期交所參考價：night-txf.json 的 446 天歷史全是用日盤 K 收盤算的，
  // 換基準等於餵給迴歸的輸入跟當初配適的定義不一致。
  var nbTip = t.bp != null
    ? '基準＝' + nf(t.bp) + '（' + (t.base || '') + ' 日盤最後一根 K 的收盤）。'
      + '總覽盤勢那一格用的是期交所參考價，兩者差幾點，所以百分比會差 0.02～0.03。'
      + '這裡用日盤收盤是為了跟 446 天的夜盤歷史同一個定義，換成參考價會讓迴歸的輸入前後不一致。'
    : '';
  h += '<div class="rb-sox-hd on">台指期夜盤 <b style="color:' + _rbCol(t.pct) + '">' + pct(t.pct) + '</b>'
    + '（' + nf(t.np) + (t.at ? '，' + t.at : '')
    + (t.bp != null ? '，<span class="ov-base" title="' + nbTip.replace(/"/g, '&quot;')
        + '">基準 ' + nf(t.bp) + '</span>' : '') + '）　'
    + '隔夜費半 <b style="color:' + _rbCol(sox) + '">' + pct(sox) + '</b>'
    + (_ovSoxLive
        ? '（' + _ovSoxLive.at
            + (_ovSoxLive.open === true ? '，盤中'
              : (_ovSoxLive.open === false ? '，已收盤'
                : '，盤別不明')) + '）'
        : '（日線收盤值）')
    + (_ovAt ? '<span class="ov-at">' + _ovAt + ' 抓取</span>' : '')
    + (_ovLiveAt ? '<span class="ov-at">現價 ' + _ovLiveAt
        + (_ovLiveOpen ? '，盤中每 30 秒更新' : '，已收盤、不再更新') + '</span>' : '')
    + (hasAct
      ? '<br><b style="color:var(--accent2)">這一夜已經開過盤了</b>：'
        + _ovToday.d + ' 的 K 線已存在，右邊是實際值。'
      : '') + '</div>';

  h += '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>' +
    rbSortTh(_ovSort, 'ovSort', 'code', '代號 / 名稱').replace('class="num ', 'class="') +
    rbSortTh(_ovSort, 'ovSort', 'cost', '成本均價', '持股的成本均價；只關注、沒持有的為「—」。跟右邊的前收比就是目前的損益') +
    rbSortTh(_ovSort, 'ovSort', 'base', '前收', '字色是前收自己的漲跌（對再前一日）') +
    rbSortTh(_ovSort, 'ovSort', 'live', '現價', '券商即時快照，盤中每 30 秒更新；13:35 之後不再抓，停在收盤價。'
      + '下面那一行是對前收的漲跌，與右邊幾欄的推估是同一個基準，可以直接比') +
    rbSortTh(_ovSort, 'ovSort', 'oPx', '預估開盤', '當天開盤價的推估') +
    rbSortTh(_ovSort, 'ovSort', 'lPx', '掛買參考', '當天盤中最低價的推估，下面那一行是它的區間。'
      + '掛限價買進看這一欄，不是看收盤。字越亮代表這兩個訊號解釋得越多；暗的代表區間跟隨便猜差不多寬') +
    rbSortTh(_ovSort, 'ovSort', 'cPx', '預估收盤', '範圍的中心。別把它當成一個會到的價') +
    rbSortTh(_ovSort, 'ovSort', 'range', '收盤區間', '收盤推估上下各一個典型偏移。'
      + '寬度用近 10 日半衰的加權殘差，滑到價格上看得到這一檔實測罩住了幾成的日子') +
    (hasAct ? rbSortTh(_ovSort, 'ovSort', 'actC', '實際收盤', '那一天實際的收盤')
            + rbSortTh(_ovSort, 'ovSort', 'actL', '實際日內最低') : '') +
    rbSortTh(_ovSort, 'ovSort', 'prem', '折溢價', '市價相對預估淨值：正數代表買貴了。開高跳空當下容易跑到溢價') +
    rbSortTh(_ovSort, 'ovSort', 'volX', '量能', '當日成交量 ÷ 近 20 日均量。跳空上去有沒有量跟上') +
    (ana ? rbSortTh(_ovSort, 'ovSort', 'r2', '說明力', '這兩個訊號說明得了多少起伏；1 是完全說中、0 是完全說不中')
         + rbSortTh(_ovSort, 'ovSort', 'n', '樣本') : '') + '</tr></thead><tbody>';
  rows.forEach(function (r) {
    h += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + _rbName(r.code) + '</span></td>' +
      // 成本均價是固定的事實，它沒有漲跌。紅綠在這一頁的意思是「今天動了多少」，
      // 拿來標一個不會動的數字是讀錯顏色。改用標頭的橘黃。
      '<td class="num">' + (r.cost > 0
          ? '<span class="ov-cost">' + _ovPx(r.cost) + '</span>'
          : '<span class="dm-dim" title="只在關注清單，沒有持股">—</span>') + '</td>' +
      '<td class="num" style="color:' + _rbCol(r.baseChg) + '">' + _ovPx(r.base) + '</td>' +
      _ovLiveCell(r, t) +
      '<td class="num ov-side">' + _ovPx(r.oPx)
        + '<span class="ov-sub" style="color:' + _rbCol(r.oPct) + '">' + pct(r.oPct) + '</span></td>' +
      // 掛買參考與收盤區間是這張表唯一要讀的兩個東西，放大加粗；
      // 開盤與收盤那兩個點估值降成小字，它們只是區間的中心。
      '<td class="num ov-big ' + _ovTier(r.r2) + '"' + cvTip(r.lCover, r.lCoverN, '日內最低') + '>'
        + _ovPx(r.lPx)
        + '<span class="ov-rng">' + _ovPx(r.lLoPx) + ' ～ ' + _ovPx(r.lHiPx) + '</span>'
        + '<span class="ov-sub" style="color:' + _rbCol(r.lPct) + '">' + pct(r.lPct) + '</span></td>' +
      '<td class="num ov-side">' + _ovPx(r.cPx)
        + '<span class="ov-sub" style="color:' + _rbCol(r.cPct) + '">' + pct(r.cPct) + '</span></td>' +
      '<td class="num ov-big ' + _ovTier(r.r2) + '"' + cvTip(r.cover, r.coverN, '收盤') + '>'
        + _ovPx(r.loPx) + ' ～ ' + _ovPx(r.hiPx) + '</td>' +
      (hasAct ? '<td class="num" style="color:' + _rbCol(r.act ? r.act.cPct : null) + ';font-weight:700">'
          + (r.act ? _ovPx(r.act.c) : '—')
          + (r.act ? '<span class="ov-sub">' + pct(r.act.cPct) + '</span>' : '') + '</td>'
        + '<td class="num" style="color:' + _rbCol(r.act ? r.act.lPct : null) + '">' + (r.act ? _ovPx(r.act.l) : '—')
          + (r.act ? '<span class="ov-sub">' + pct(r.act.lPct) + '</span>' : '') + '</td>' : '') +
      '<td class="num" style="color:' + (r.prem == null ? 'var(--text3)' : _rbCol(r.prem)) + '">'
        + (r.prem == null ? '—' : pct(r.prem)) + '</td>' +
      '<td class="num' + (r.volX != null && r.volX >= 1.5 ? ' ov-key' : '') + '">'
        + (r.volX == null ? '—' : r.volX.toFixed(2) + ' 倍') + '</td>' +
      (ana ? '<td class="num rs-dim">' + (r.r2 == null ? '—' : r.r2.toFixed(2)) + '</td>'
           + '<td class="num rs-dim">' + r.n + ' 天</td>' : '') + '</tr>';
  });
  h += '</tbody></table></div>';
  // 解釋全部在這裡，收合後點了才看得到
  h += '<div class="detail-note"><dl>'
    + '<dt>要看哪一欄</dt><dd>只看放大的那兩欄：<b>掛買參考</b>與<b>收盤區間</b>。'
    + '掛限價買進用前者（並且看它底下那一行的區間，不是上面那一個點）。'
    + '預估開盤與預估收盤故意縮成小字：它們只是區間的中心，不是會到的價。'
    + '<br><b>字的亮度就是可信度</b>：亮白代表這兩個訊號解釋掉一半以上的起伏，'
    + '中灰代表四分之一到一半，暗灰代表不到四分之一、區間跟隨便猜差不多寬。'
    + '不用紅綠是因為那兩個色在這一頁是漲跌。'
    + '滑到價格上看得到這一檔的區間實測罩住了幾成的日子。'
    + '所有價格以 ' + (rows[0] ? rows[0].basePrev : '') + ' 的收盤為基準，已對齊升降單位。</dd>'
    + '<dt>現價</dt><dd>券商即時快照。盤中每 30 秒更新，13:35 之後那一輪就不再抓，停在收盤價——'
    + '收盤之後它本來就不會再變，不是畫面卡住。下面那一行的漲跌對的是前收，'
    + '跟右邊三欄推估同一個基準，直接比得出來今天走在推估的哪個位置。'
    + '推估的那一盤還沒開始時（例如晚上看明天），快照回來的是今天的收盤，'
    + '這一欄會標灰並說明是哪一天的價，不會假裝那是「明天的現價」。</dd>'
    + (_ovRef && _ovRef.pct != null
        ? '<dt>跟總覽的百分比不一樣</dt><dd>總覽與券商 App 顯示 '
            + pct(_ovRef.pct) + '，對的是期交所參考價 ' + nf(_ovRef.px)
            + '；這裡對的是 ' + (t.base || '—') + ' 日盤收盤 ' + nf(t.bp)
            + '。成交價兩邊同一個，差的是分母。'
            + '用收盤是因為要推的 ETF 漲跌也是對前一日收盤。</dd>'
        : '')
    + '</dl></div>';

  // 偏移度：這一檔照不照劇本走。跟「會漲多少」無關，跟「掛價要留多少餘裕」直接相關。
  if (view === 'ana') {
    h += '<div class="sec-title">偏移度（實際與推估的差距，元）</div>' +
      '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>' +
      rbSortTh(_ovDSort, 'ovDSort', 'code', '代號 / 名稱').replace('class="num ', 'class="') +
      rbSortTh(_ovDSort, 'ovDSort', 'sd', '整體上下差', '排序依元') +
      rbSortTh(_ovDSort, 'ovDSort', 'medUp', '夜盤上漲的日子', '排序依元') +
      rbSortTh(_ovDSort, 'ovDSort', 'medDn', '夜盤下跌的日子', '排序依元') + '</tr></thead><tbody>';
    rbSortRows(rows, _ovDSort, _ovDSortVal).forEach(function (r) {
      // 百分點對下單沒意義，換成這一檔的元：偏移×前收÷100。
      // 「上下 0.11 元」才知道掛價要留多少餘裕。
      var yuan = function (v) { return (r.basePx > 0) ? v * r.basePx / 100 : null; };
      var cell = function (sd, med, n) {
        if (sd == null) return '<td class="num rs-dim">樣本不足</td>';
        var m = yuan(med), d = yuan(sd);
        return '<td class="num">' + (med >= 0 ? '+' : '−')
          + (m == null ? Math.abs(med).toFixed(2) : Math.abs(m).toFixed(2)) + ' 元' +
          '<span class="ov-sub">上下 ' + (d == null ? sd.toFixed(2) : d.toFixed(2)) + ' 元　' + n + ' 天</span></td>';
      };
      h += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + _rbName(r.code) + '</span></td>' +
        '<td class="num" style="font-weight:700">'
          + ((r.basePx > 0) ? (r.sd * r.basePx / 100).toFixed(2) + ' 元' : r.sd.toFixed(2)) + '</td>' +
        cell(r.sdUp, r.medUp, r.nUp) + cell(r.sdDn, r.medDn, r.nDn) + '</tr>';
    });
    h += '</tbody></table></div>' +
      '<div class="rb-caveat">「整體上下差」小的那幾檔照劇本走，大的那幾檔同樣的夜盤漲幅、' +
      '結果散得多很多——這跟「會漲多少」無關，跟「掛價要留多少餘裕」直接相關。' +
      '每一欄的主數字是偏移的中位數（正＝實際比推估高），小字是上下差與天數。</div>';
  }

  h += ovHitHtml();
  h += '</div>';
  return h;
}
