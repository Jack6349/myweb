// 股利總管 Web — 債券型 ETF 每日淨值／市價／折溢價，以及月均規模
// 資料檔 data/etf-nav.json 由 shioaji-server/etf-nav.py 每日 18:30（及登入後補跑）產生並上傳。
// 網頁只讀不抓：資料源在 MoneyDJ 與 TPEx，兩邊都不給 CORS，瀏覽器端取不到。
//
// 檔案結構（共用一份日期索引以壓縮體積，110 檔一年約 350 KB）
//   dates: ['20250929', …]                     全域交易日，舊→新
//   map:   { '00981B': { i: 起點索引, n: [淨值…], p: [市價…] } }   n/p 自 dates[i] 起對齊
//   aum:   { '00981B': { '2026-09': 141.54 } }  月均規模（億元），資料源只給近 12 個月滾動
//   units: { '00981B': { '20260925': 1574613000 } }  受益權單位數日快照，只有排程開始後的日期
//   names: { '00981B': '第一金優選非投債' }            全市場 ETF 簡稱（_contracts 只有持股）
//
// 兩個必須知道的資料特性
//   1. n[t] === n[t-1] 時不可計折溢價。成因有二：美國休市日持債未重新定價（淨值不動是正確的，
//      不是壞資料），或當日淨值尚未公告而資料源沿用前值。兩種情況台股都有交易、價格會動，
//      算出來的「折溢價」是計價時點落差不是供需。淨值本身兩種情況都有效，故資料保留不刪除。
//   2. 資料源落後約一個交易日。可用於健康度與水位判讀，不可用於盤中下單——
//      盤中要看發行商的即時預估淨值（iNAV）。

var NP_STALE_DAYS = 5;       // 每日更新；超過 5 天＝排程連續數日未成功
var NP_WIN = 250;            // 折溢價水位的比較區間（約一年交易日）

var _npDates = null, _npMap = null, _npAum = null, _npUnits = null, _npNames = null,
    _npDay = null, _npLoaded = false;

(function () {
  fetch('data/etf-nav.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      _npLoaded = true;
      if (j && j.map) {
        _npMap = j.map;
        _npAum = j.aum || {};
        _npNames = j.names || {};   // 全市場 ETF 簡稱，換股評估列候選標的用
        // 單位數的日期鍵在檔案裡是 'YYYYMMDD'，除息日是 'YYYY-MM-DD'，
        // 直接字串比較會錯（'-' 的碼位小於數字），載入時統一轉成 ISO
        _npUnits = {};
        var raw = j.units || {};
        for (var c in raw) {
          var o = {};
          for (var d in raw[c]) {
            o[d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6) : d] = raw[c][d];
          }
          _npUnits[c] = o;
        }
        _npDay = j.updated || null;
        // 'YYYYMMDD' → 'YYYY-MM-DD'，與 div-mix.js 的除息日同格式才能直接比對
        _npDates = (j.dates || []).map(function (s) {
          return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6) : s;
        });
      }
      if (typeof npOnLoad === 'function') npOnLoad();
    })
    .catch(function () { _npLoaded = true; });
})();

function npReady() { return !!(_npMap && _npDates && _npDates.length); }
function npDataDay() { return _npDay; }

// 資料是否過期（排程連續失敗時要標出來，而不是默默用舊值）
function npStale() {
  if (!_npDay) return null;
  var d = Math.floor((Date.now() - new Date(_npDay + 'T00:00:00+08:00').getTime()) / 86400000);
  return d > NP_STALE_DAYS ? d : null;
}

// 逐日序列（舊→新）：[{ date, nav, px, prem }]，prem 在淨值沿用前值時為 null
function npSeries(code) {
  if (!npReady()) return [];
  var e = _npMap[String(code)];
  if (!e) return [];
  var out = [], prevNav = null;
  for (var k = 0; k < e.n.length; k++) {
    var nav = e.n[k], px = e.p[k], d = _npDates[e.i + k];
    if (d == null || !(nav > 0) || !(px > 0)) continue;
    out.push({
      date: d, nav: nav, px: px,
      prem: (prevNav != null && nav === prevNav) ? null : (px / nav - 1) * 100
    });
    prevNav = nav;
  }
  return out;
}

// 最新一筆可用折溢價（往前跳過淨值沿用前值的日子）
function npPremium(code) {
  var s = npSeries(code);
  for (var i = s.length - 1; i >= 0; i--) {
    if (s[i].prem != null) return { date: s[i].date, prem: s[i].prem, nav: s[i].nav, px: s[i].px };
  }
  return null;
}

// 目前折溢價在近 NP_WIN 個交易日中的百分位（0＝最便宜、100＝最貴）。
// 只給水位不給進出場建議：折溢價確實由價格在隔日修正（實測 00989B r=-0.65、00988B r=-0.71，
// 以不含當日收盤的區間重測後消失，故修正只發生在次一日），但那是盤後才知道的數字。
function npPremRank(code) {
  var s = npSeries(code).filter(function (x) { return x.prem != null; });
  if (s.length < 20) return null;
  var win = s.slice(-NP_WIN), cur = win[win.length - 1].prem;
  var below = win.filter(function (x) { return x.prem < cur; }).length;
  return { pct: below / win.length * 100, cur: cur, n: win.length };
}

function npAumOf(code, ym) {
  var a = _npAum && _npAum[String(code)];
  return (a && a[ym] > 0) ? a[ym] : null;
}

var _npT = function (iso) { return new Date(iso + 'T00:00:00+08:00').getTime(); };

// 月均規模視為「該月中點的瞬時值」，在相鄰兩個中點之間線性內插出任一天的規模。
// 這是為了讓規模能對齊計息區間的端點——資料源只給月平均，除息日卻可能落在月初。
// 端點落在第一個或最後一個中點之外時回 null，不外插：外插誤差沒有上界。
function _npAumAt(code, iso) {
  var a = _npAum && _npAum[String(code)];
  if (!a) return null;
  var ms = Object.keys(a).sort().map(function (ym) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { t: _npT(ym + '-' + (dim >> 1 < 10 ? '0' : '') + (dim >> 1) + ''), v: a[ym], ym: ym };
  });
  if (ms.length < 2) return null;
  var t = _npT(iso), lo = ms[0], hi = ms[ms.length - 1];
  // 端點落在首尾中點之外時不外插（誤差沒有上界），但只要仍在該月之內就取該月均值。
  // 月底除息的檔（00981B 9/21）會落在最後一個月中點之後，不給這個退路的話
  // 最新一期永遠要等下個月的規模才算得出來。
  if (t < lo.t) return iso.slice(0, 7) === lo.ym ? { v: lo.v, from: lo.ym, to: lo.ym, approx: 1 } : null;
  if (t > hi.t) return iso.slice(0, 7) === hi.ym ? { v: hi.v, from: hi.ym, to: hi.ym, approx: 1 } : null;
  for (var i = 1; i < ms.length; i++) {
    if (t <= ms[i].t) {
      var w = (t - ms[i - 1].t) / (ms[i].t - ms[i - 1].t);
      return { v: ms[i - 1].v + (ms[i].v - ms[i - 1].v) * w, from: ms[i - 1].ym, to: ms[i].ym };
    }
  }
  return null;
}

// 受益權單位數：指定日或之前最近一筆快照。
// 這是上限公式真正要的量，拿得到就不必再用 規模 ÷ 淨值 去推，內插誤差一併消失。
// 來源 all_etf.txt 的 c 欄，上市上櫃一致（00984D 是上市，TPEx 的月均規模供不供它看運氣）。
// 代價是只有排程開始後的日期，往回補不了。
function _npUnitsAt(code, iso, notBefore) {
  var u = _npUnits && _npUnits[String(code)];
  if (!u) return null;
  var best = null;
  for (var d in u) {
    if (d <= iso && (best == null || d > best) && (!notBefore || d > notBefore)) best = d;
  }
  return best == null ? null : { d: best, v: u[best] };
}

// 指定日（或之前最近一個交易日）的淨值
function _npNavAt(code, iso) {
  var s = npSeries(code);
  for (var i = s.length - 1; i >= 0; i--) {
    if (s[i].date <= iso) return s[i].nav;
  }
  return null;
}

// 收益平準金占比的機制上限 u/(1+u)
//
// 推導：期初單位 U，期末 U(1+u)，新單位占比 u/(1+u)。新申購價內含應計未分配收益，
// 該部分依法列入收益平準金而非本金，故平準金能占配息的比例上限＝u/(1+u)。
// 這是「上界」不是估計值：假設每個新單位都帶滿整期應計收益，實際上期初申購的帶得少。
// 所以超出上限＝確定有一部分不是新單位帶進來的（動到本金）；
// 未超出＝不能證明有問題，不等於證明健康。
//
// u 必須用單位數成長，不能直接用規模成長：規模＝單位數 × 淨值，債券價格漲也會讓規模變大，
// 但那不代表有新錢進來，也就不會產生平準金。(1+g)=(1+u)(1+r) → u=(1+g)/(1+r)-1。
// 區間＝(上一次除息日, 本次除息日]。平準金是這段期間新申購者帶進來的，
// 所以 u 要量的是這兩個端點之間單位數成長了多少：
//   單位數(d) = 規模(d) / 淨值(d)，兩端相除即得 u，不必再走 (1+g)/(1+r)。
//
// 為什麼不能用「除息日所屬月份」挑規模（我原本的寫法）：
//   00984D 9/1 除息，區間是 7/31 → 9/1，幾乎整段落在八月，用九月規模會差一整個月；
//   更嚴重的是九月規模含 9/1 之後的申購，那些錢不可能參與 9/1 就已決定的配息，是未來資訊。
//   實測近幾期「區間中點不在除息月」的比例：00984D 3/4、00989B 2/2、00988B 1/3、00981B 0/4。
//
// 殘留誤差：規模只有月平均，端點靠相鄰兩個月中點線性內插，仍會沾到除息日之後幾天的申購。
// 月初除息的檔沾得最少（權重落在前一個月），無法完全消除。
function npCeiling(code, ex) {
  if (typeof dmPrevEx !== 'function') return null;
  var p = dmPrevEx(code, ex);
  if (!p) return null;                      // 首次配息沒有前一期，區間無法界定

  // 優先用實際單位數快照。兩個端點各取「該日或之前最近一筆」，
  // 並要求 ex 端的快照日晚於 p（否則兩端取到同一筆，u 恆為 0）。
  var q1 = _npUnitsAt(code, ex, p), q0 = _npUnitsAt(code, p);
  if (q1 && q0 && q1.d > q0.d) {
    var uu = q1.v / q0.v - 1;
    return {
      win: p + ' → ' + ex, src: 'units',
      days: Math.round((_npT(ex) - _npT(p)) / 86400000),
      u: uu * 100, ceil: Math.max(uu / (1 + uu) * 100, 0),
      u0: q0.v, u1: q1.v, d0: q0.d, d1: q1.d
    };
  }

  var a1 = _npAumAt(code, ex), a0 = _npAumAt(code, p);
  if (!a1 || !a0) return null;
  var n1 = _npNavAt(code, ex), n0 = _npNavAt(code, p);
  if (!n1 || !n0) return null;
  var u1 = a1.v / n1, u0 = a0.v / n0;
  var u = u1 / u0 - 1;
  return {
    win: p + ' → ' + ex, src: 'aum',
    days: Math.round((_npT(ex) - _npT(p)) / 86400000),
    g: (a1.v / a0.v - 1) * 100, r: (n1 / n0 - 1) * 100, u: u * 100,
    ceil: Math.max(u / (1 + u) * 100, 0),
    aum: a1.v, aumFrom: a0.from + '~' + a1.to,
    approx: !!(a1.approx || a0.approx)      // 端點落在首尾月中點之外，改取該月均值
  };
}

// 單期配息的健康度：平準金占比 vs 該期除息日所屬月份的機制上限
// state: ok（無平準金）／safe（在上限內）／warn（超出上限）／nodata
function npHealth(code, exDate, ePct) {
  if (ePct == null) return { state: 'nodata', why: '占比未公告', c: null };
  var c = npCeiling(code, String(exDate));
  if (ePct === 0) return { state: 'ok', ceil: c ? c.ceil : null, gap: null, c: c };
  if (!c) return { state: 'nodata', why: '規模或淨值資料不足', c: null };
  var gap = c.ceil - ePct;
  return { state: gap >= 0 ? 'safe' : 'warn', ceil: c.ceil, gap: gap, c: c };
}

// 近 n 期的健康度（新→舊），沿用 div-mix.js 的 dmRecs（只含已公告占比者）
function npHealthRecs(code, n) {
  if (typeof dmRecs !== 'function') return [];
  return dmRecs(code, n == null ? 12 : n).map(function (r) {
    var h = npHealth(code, r.ex, r.pct ? (r.pct.e || 0) : null);
    h.ex = r.ex; h.amt = r.amt; h.e = r.pct ? (r.pct.e || 0) : null;
    return h;
  });
}

function _npTip(rs) {
  return rs.map(function (x) {
    return x.ex + '　平準金 ' + (x.e == null ? '—' : x.e.toFixed(1) + '%') +
      '　上限 ' + (x.ceil == null ? '—' : x.ceil.toFixed(1) + '%') +
      (x.gap == null ? '' : (x.gap >= 0 ? '　餘裕 ' : '　超出 ') + Math.abs(x.gap).toFixed(1) + 'pp');
  }).join('&#10;');
}

// 健康度徽章：以「最新一期」為準。
// 曾經考慮「近 12 期任一期超出就標警示」，理由是那期的稀釋已經發生、不會回補——
// 這句話沒錯，但答錯了問題。這張表要回答的是「現在該不該續抱」，不是「歷史上有沒有發生過」。
// 00981B 2025-11 超出 13.5pp，之後連續 10 期零平準金，用舊規則會一直掛著警示，沒有決策價值。
// 歷史次數改成附在旁邊，逐期明細在 title。
function npHealthHtml(code) {
  var rs = npHealthRecs(code, 12).filter(function (x) { return x.state !== 'nodata'; });
  if (!rs.length) {
    return '<span class="np-h np-h-na" title="需要月均規模與月均淨值。月均規模資料源只給近 12 個月滾動，' +
      '且逐檔會間歇性缺漏">—</span>';
  }
  var tip = _npTip(rs);
  var past = rs.slice(1).filter(function (x) { return x.state === 'warn'; }).length;
  var hist = past ? '<span class="np-h-n" title="' + tip + '">近 12 期另有 ' + past + ' 期超出</span>' : '';
  var top = rs[0];
  if (top.state === 'warn') {
    return '<span class="np-h np-h-warn" title="' + tip + '">警示 超出 ' +
      Math.abs(top.gap).toFixed(1) + 'pp</span>' + hist;
  }
  if (top.state === 'ok') {
    return '<span class="np-h np-h-ok" title="' + tip + '">穩定 無平準金</span>' + hist;
  }
  return '<span class="np-h np-h-safe" title="' + tip + '">穩定 餘裕 ' +
    top.gap.toFixed(1) + 'pp</span>' + hist;
}

// 上限欄：最新一期所屬月份的上限，提示裡放出中間值供核對
function npCeilHtml(code) {
  var rs = npHealthRecs(code, 12).filter(function (x) { return x.c; });
  if (!rs.length) return '—';
  var c = rs[0].c;
  var sgn = function (v, dp) { return (v >= 0 ? '+' : '') + v.toFixed(dp); };
  var n = function (v) { return v.toLocaleString('zh-TW'); };
  var body = (c.src === 'units')
    ? ('單位數 ' + n(c.u0) + '（' + c.d0 + '）→ ' + n(c.u1) + '（' + c.d1 + '）&#10;' +
       'u = ' + sgn(c.u, 2) + '%　實際受益權單位數，未經推算')
    : ('規模 ' + c.aum.toFixed(2) + ' 億，區間兩端 ' + sgn(c.g, 1) + '%（由 ' + c.aumFrom + ' 月均內插）&#10;' +
       '淨值 ' + sgn(c.r, 2) + '%&#10;' +
       'u = 規模成長 ÷ 淨值漲跌 = ' + sgn(c.u, 1) + '%　由月均規模推算' +
       (c.approx ? '&#10;※ 區間端點在首／末月中點之外，該端改取整月均值' : ''));
  return '<span title="計息區間 ' + c.win + '（' + c.days + ' 天）&#10;' + body + '&#10;' +
    '上限 = u/(1+u) = ' + c.ceil.toFixed(1) + '%">' + c.ceil.toFixed(1) + '%' +
    (c.src === 'units' ? '' : '<span class="np-h-n">' + (c.approx ? '約' : '推算') + '</span>') + '</span>';
}
