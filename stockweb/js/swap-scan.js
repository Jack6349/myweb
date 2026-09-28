// 股利總管 Web — 換股評估（加減碼報告 · 表二下方）
//
// 四個區塊，由內而外：
//   B 持股互換   你持有的非投等債兩兩比較，只列殖利率差達門檻者
//   C 市場掃描   月配／雙月配／季配的 ETF 全掃，列真實市價殖利率最高的前 N 檔
//   D 指定標的   你自己輸入的觀察清單，與 C 同格式
//  （A 持股現況即表二本身，不重複做）
//
// ── 為什麼排序用市價殖利率而不是成本殖利率 ──
// 換股當下賣出拿到的是市價，成本基準隨即重設，舊成本是沉沒成本、不影響未來收入。
// 以 322 張 00981B（成本 9.50、市價 9.02）換 00989B（9.93）驗算，月配實際 +5,410 元：
//   市價殖利率差 2.25% × 290 萬 ÷ 12 = +5,446  對得上
//   成本殖利率差 2.67% × 290 萬 ÷ 12 = +6,462  高估 19%
// 成本殖利率仍並列，它回答的是「原本投入的錢現在報酬如何」，那是另一個問題。
//
// ── 為什麼用「真實」殖利率排序 ──
// 真實 = 帳面年化 ×（股利＋利息占比）。平準金是新申購者的本金、資本利得靠賣債價差，
// 兩者都不是可持續的債息收入，卻會讓帳面數字好看。與表二同一套定義。
//
// ── 資料來源與各自的限制 ──
//   配息金額與占比  etf-div-mix.json（MOPS，214 檔）＋ etf-div-next.json（Yahoo，補已公告未申報）
//   價格            etf-nav.json（MoneyDJ，178 檔＝月配／雙月配／季配 ∪ 債券型），落後約一個交易日
//   規模            單位數 × 淨值，單位數來自 all_etf.txt 當日快照（223 檔）
//   健康度          nav-premium.js，需要月規模，目前僅債券型 93 檔有
//   配息頻率        etf-freq.json
// 沒有成交量：目前四個資料源都不給歷史成交金額，所以無法判斷候選標的吃不吃得下你的量。
// 規模只是大小，不是周轉，兩者不能互相取代——這點在表下說明會標出來。

var SW_GAP = 1.0;        // 持股互換的殖利率差門檻（百分點），使用者指定
var SW_TOP = 10;         // 市場掃描列出的檔數，使用者指定
var SW_WATCH_LS = 'swap_watch_v1';
var SW_FREQ_URL = 'data/etf-freq.json';

var _swFreq = null, _swWatch = null;

(function () {
  fetch(SW_FREQ_URL, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { if (j && j.map) _swFreq = j.map; })
    .catch(function () {});
})();

// ── 觀察清單（區塊 D）：本機優先，登入後與 Firestore 合併，與 cost-override 同一套機制 ──
function swWatchLoad() {
  if (_swWatch) return _swWatch;
  try { _swWatch = JSON.parse(localStorage.getItem(SW_WATCH_LS) || '[]'); } catch (e) { _swWatch = []; }
  if (!Array.isArray(_swWatch)) _swWatch = [];
  return _swWatch;
}
function swWatchSave(list) {
  _swWatch = list.slice();
  try { localStorage.setItem(SW_WATCH_LS, JSON.stringify(_swWatch)); } catch (e) {}
  try {
    if (typeof _fsDoc === 'function' && typeof _uid !== 'undefined' && _uid) {
      _fsDoc('stock_prefs', _uid).set({ swapWatch: _swWatch }, { merge: true });
    }
  } catch (e) {}
}

// ── 基礎量 ──

function swName(code) {
  var c = String(code);
  if (typeof _contracts !== 'undefined' && _contracts[c] && _contracts[c].name) return _contracts[c].name;
  if (typeof _npNames !== 'undefined' && _npNames && _npNames[c]) return _npNames[c];
  return '';
}

function swFreqStep(code) {
  var f = _swFreq && _swFreq[String(code)];
  return (f && f.s > 0) ? f.s : null;     // s = 每次配息間隔幾個月
}

// 現價：一律取 etf-nav.json 的最後一筆，讓持股與候選同基準可比。
// 不用 _rows 的即時價，否則持股是今天、候選是昨天，差一天的比較沒有意義。
function swPrice(code) {
  var s = (typeof npSeries === 'function') ? npSeries(code) : [];
  return s.length ? s[s.length - 1].px : null;
}

// 每股平均成本（僅持股有）
function swCost(code) {
  var ps = (typeof _positions !== 'undefined' && _positions) || [];
  for (var i = 0; i < ps.length; i++) {
    if (String(ps[i].code) === String(code) && ps[i].price > 0) return ps[i].price;
  }
  return null;
}

// 年化配息金額（元／股）：近 12 個月各期平均 × 每年期數，含已公告未申報的下一期。
// 用平均 × 期數而非 12 個月加總，新上市未滿一年的檔才不會被低估。
function swAnnualAmt(code) {
  if (typeof dmRecs !== 'function') return null;
  var a = dmRecs(code, 12).map(function (x) { return x.amt; }).filter(function (v) { return v > 0; });
  var nx = (typeof dmNext === 'function') ? dmNext(code) : null;
  if (nx) a.unshift(nx.amt);
  if (!a.length) return null;
  var step = swFreqStep(code) || 1;
  var avg = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  return { annual: avg * (12 / step), n: a.length, step: step, hasNext: !!nx };
}

// 本業占比（股利＋利息），近 12 個月線性遞減加權；取不到時回 null 而不是當成 100%
function swCore(code) {
  var m = (typeof dmMix === 'function') ? dmMix(code, 12) : null;
  return m ? m.core / 100 : null;
}

// 一檔標的的完整評估
function swEval(code) {
  var px = swPrice(code), aa = swAnnualAmt(code);
  if (!px || !aa) return null;
  var core = swCore(code), cost = swCost(code);
  var last = (typeof dmLatest === 'function') ? dmLatest(code) : null;
  var mkt = aa.annual / px * 100;
  var units = null, size = null;
  try {
    var u = (typeof _npUnits !== 'undefined' && _npUnits && _npUnits[String(code)]) || null;
    if (u) { var ks = Object.keys(u).sort(); units = u[ks[ks.length - 1]]; size = units * px / 1e8; }
  } catch (e) {}
  return {
    code: String(code), name: swName(code),
    px: px, cost: cost,
    mkt: mkt,                                            // 帳面市價殖利率
    real: core == null ? null : mkt * core,              // 真實市價殖利率（排序用）
    realLast: (last && last.core != null) ? mkt * last.core / 100 : null,
    costY: cost ? aa.annual / cost * 100 : null,         // 帳面成本殖利率
    costReal: (cost && core != null) ? aa.annual / cost * 100 * core : null,
    core: core == null ? null : core * 100,
    n: aa.n, step: aa.step, hasNext: aa.hasNext,
    e: (typeof dmMix === 'function' && dmMix(code, 12)) ? dmMix(code, 12).e : null,
    size: size,
    health: (typeof npHealthRecs === 'function')
      ? npHealthRecs(code, 12).filter(function (x) { return x.state !== 'nodata'; }) : [],
    prem: (typeof npPremium === 'function') ? npPremium(code) : null
  };
}

// 真實市價殖利率的歷史序列（配息品質趨勢用）。
// 每個月末取一點：金額用「該日之前最近一次已公告」、價格用該日淨值序列、占比用該期公告值。
// 不用加權平均，這裡要看的是變化本身。
function swYieldTrend(code, months) {
  if (typeof npSeries !== 'function' || typeof dmRecs !== 'function') return [];
  var s = npSeries(code);
  if (!s.length) return [];
  var recs = ((typeof _dmMap !== 'undefined' && _dmMap && _dmMap[String(code)]) || [])
    .filter(function (r) { return r.amt > 0; })
    .sort(function (a, b) { return a.ex < b.ex ? -1 : 1; });
  if (!recs.length) return [];
  var step = swFreqStep(code) || 1;
  var byMonth = {};
  s.forEach(function (x) { byMonth[x.date.slice(0, 7)] = x; });
  var yms = Object.keys(byMonth).sort().slice(-(months || 13));
  var out = [];
  yms.forEach(function (ym) {
    var d = byMonth[ym];
    var r = null;
    for (var i = 0; i < recs.length; i++) { if (recs[i].ex <= d.date) r = recs[i]; }
    if (!r || !(d.px > 0)) return;
    var core = r.pct ? ((r.pct.d || 0) + (r.pct.i || 0)) / 100 : null;
    var mkt = r.amt * (12 / step) / d.px * 100;
    out.push({ ym: ym, mkt: mkt, real: core == null ? null : mkt * core, px: d.px, amt: r.amt });
  });
  return out;
}

// 趨勢小圖：純文字 sparkline，不引外部繪圖，欄寬固定
var SW_SPARK = '▁▂▃▄▅▆▇█';
function swSparkHtml(tr, key) {
  var v = tr.map(function (x) { return x[key]; }).filter(function (x) { return x != null; });
  if (v.length < 3) return '<span class="dm-dim">—</span>';
  var mn = Math.min.apply(null, v), mx = Math.max.apply(null, v), rg = mx - mn;
  var bars = v.map(function (x) {
    return SW_SPARK.charAt(rg > 0 ? Math.round((x - mn) / rg * 7) : 3);
  }).join('');
  var d = v[v.length - 1] - v[0];
  var tip = tr.filter(function (x) { return x[key] != null; })
    .map(function (x) { return x.ym + '　' + x[key].toFixed(2) + '%　（配息 ' + x.amt.toFixed(4) + '　價 ' + x.px.toFixed(2) + '）'; })
    .join('&#10;');
  return '<span class="sw-spark" title="' + tip + '">' + bars + '</span>' +
    '<span class="sw-d ' + (d >= 0 ? 'down' : 'up') + '">' + (d >= 0 ? '+' : '') + d.toFixed(2) + '</span>';
}

function swHealthHtml(code, ev) {
  if (typeof npHealthHtml === 'function' && ev && ev.health.length) return npHealthHtml(code);
  var e = ev ? ev.e : null;
  return '<span class="np-h np-h-na" title="健康度需要月規模；目前僅債券型有，股票型要等每日單位數快照累積到前後兩次除息日">' +
    (e == null ? '—' : '平準金 ' + e.toFixed(1) + '%') + '</span>';
}

// ══════════ 區塊 B：持股互換 ══════════
// 你持有的非投等債兩兩比較。只列「買進腳真實市價殖利率 − 賣出腳」達 SW_GAP 以上者。
// 換後月配增額用實際流程算：賣出淨額 ÷ 買進價 → 股數 → × 年化配息 ÷ 12。
var SW_FEE = 0.001425 * 0.6;    // 手續費 6 折；債券 ETF 免證交稅

// 兩種增額都要算，缺一會誤導：
//   現金  用帳面殖利率——你實際入帳的就是公告金額，不管它的來源是利息還是平準金
//   真實  用真實殖利率——扣掉平準金與資本利得後，可持續的部分
// 00984D → 00989B 是最好的例子：兩者帳面幾乎一樣（10.37% vs 10.39%），現金增額近乎零，
// 但 00984D 的配息 58% 是平準金，真實增額 3.92pp。只看現金會以為換了沒用。
function swSwapGain(a, b, shares) {
  if (!a || !b || !(shares > 0)) return null;
  var net = shares * a.px * (1 - SW_FEE);
  var got = net / (b.px * (1 + SW_FEE));
  var mk = function (n, e, k) { return e[k] == null ? null : n * (e[k] / 100) * e.px / 12; };
  var c0 = mk(shares, a, 'mkt'), c1 = mk(got, b, 'mkt');
  var r0 = mk(shares, a, 'real'), r1 = mk(got, b, 'real');
  return {
    lots: got / 1000,
    cash: (c0 == null || c1 == null) ? null : c1 - c0,
    real: (r0 == null || r1 == null) ? null : r1 - r0,
    fee: shares * a.px * SW_FEE * 2
  };
}

function swBlockB() {
  var codes = (typeof _rsBondHoldings === 'function') ? _rsBondHoldings() : [];
  var head = '<div class="rs-sec-title">換股評估 B · 持股互換</div>';
  if (codes.length < 2) {
    return head + '<div class="sw-none">持有的非投等債少於兩檔，無從互相比較。</div>';
  }
  var ev = {}, sm = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  codes.forEach(function (c) { ev[c] = swEval(c); });
  var pairs = [];
  codes.forEach(function (s) {
    codes.forEach(function (b) {
      if (s === b || !ev[s] || !ev[b] || ev[s].real == null || ev[b].real == null) return;
      var gap = ev[b].real - ev[s].real;
      if (gap < SW_GAP) return;
      pairs.push({ s: s, b: b, gap: gap,
        gapCost: (ev[s].costReal != null) ? ev[b].real - ev[s].costReal : null,
        g: swSwapGain(ev[s], ev[b], sm[s] || 0) });
    });
  });
  pairs.sort(function (x, y) { return y.gap - x.gap; });
  if (!pairs.length) {
    return head + '<div class="sw-none">持股之間的真實市價殖利率差距都不到 ' + SW_GAP.toFixed(1) +
      ' 個百分點，沒有值得互換的組合。</div>';
  }
  var money = function (v) { return v == null ? '—' : (v >= 0 ? '+' : '') + Math.round(v).toLocaleString('zh-TW'); };
  var h = head + '<div class="inv-table-wrap"><table class="inv-table sw-table"><thead><tr>' +
    '<th>賣出腳</th><th>買進腳</th>' +
    '<th class="num" title="買進腳 − 賣出腳，皆為真實市價殖利率">殖利率差</th>' +
    '<th class="num" title="以賣出腳的真實成本殖利率為基準；僅供對照，不用於排序">vs 成本</th>' +
    '<th class="num" title="賣出全部持股、扣來回手續費後可買到的張數">換後張數</th>' +
    '<th class="num" title="上排＝實際入帳的現金變化（用帳面殖利率）&#10;' +
    '下排＝扣掉平準金與資本利得後可持續的部分（用真實殖利率）&#10;' +
    '兩者差很多時，代表其中一檔的配息有很大一塊不是債息">月配增額<div class="rs-b-sub">現金／真實</div></th>' +
    '<th class="num" title="來回手續費（6 折，債券 ETF 免證交稅）；回本天數以真實增額攤提">手續費</th>' +
    '<th>買進腳健康度</th></tr></thead><tbody>';
  pairs.forEach(function (p) {
    var a = ev[p.s], b = ev[p.b], g = p.g;
    h += '<tr>' +
      '<td>' + p.s + '<div class="rs-b-name">' + a.real.toFixed(2) + '%</div></td>' +
      '<td>' + p.b + '<div class="rs-b-name">' + b.real.toFixed(2) + '%</div></td>' +
      '<td class="num"><b>' + p.gap.toFixed(2) + ' pp</b></td>' +
      '<td class="num">' + (p.gapCost == null ? '—' : p.gapCost.toFixed(2) + ' pp') + '</td>' +
      '<td class="num">' + (g ? g.lots.toFixed(1) : '—') + '</td>' +
      '<td class="num">' + (!g ? '—' :
        '<b class="' + (g.cash >= 0 ? 'down' : 'up') + '">' + money(g.cash) + '</b>' +
        '<div class="rs-b-sub ' + (g.real >= 0 ? 'down' : 'up') + '">' + money(g.real) + '</div>') + '</td>' +
      '<td class="num">' + (!g ? '—' : Math.round(g.fee).toLocaleString('zh-TW') +
        '<div class="rs-b-sub">' + (g.real > 0 ? Math.ceil(g.fee / g.real * 30) + ' 天回本' : '—') +
        '</div>') + '</td>' +
      '<td>' + swHealthHtml(p.b, b) + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

// ══════════ 區塊 C／D 共用的候選表 ══════════
function swCandTable(list, base, title, empty) {
  var h = '<div class="rs-sec-title">' + title + '</div>';
  if (!list.length) return h + '<div class="sw-none">' + empty + '</div>';
  h += '<div class="inv-table-wrap"><table class="inv-table sw-table"><thead><tr>' +
    '<th>代號</th>' +
    '<th class="num" title="年化配息金額 ÷ 現價">帳面</th>' +
    '<th class="num" title="帳面 ×（股利＋利息占比）。排序依據">真實<div class="rs-b-sub">加權／最新</div></th>' +
    (base ? '<th class="num" title="真實市價殖利率減去 ' + base.code + ' 的 ' +
      base.real.toFixed(2) + '%">vs ' + base.code + '</th>' : '') +
    '<th title="近 13 個月真實市價殖利率走勢；右側數字為期末減期初">殖利率趨勢</th>' +
    '<th class="num" title="近 12 個月線性遞減加權">平準金</th>' +
    '<th class="num" title="受益權單位數 × 淨值。這是規模不是周轉量">規模</th>' +
    '<th class="num">頻率</th>' +
    '<th class="num" title="近 12 個月用到幾期實際配息。年化是「各期平均 × 年期數」，'
      + '期數太少時這個外推很不穩，一期就能把整年推成任意值。不設門檻過濾，自己看">期數</th>' +
    '<th>健康度</th></tr></thead><tbody>';
  list.forEach(function (e) {
    var tr = swYieldTrend(e.code, 13);
    var f = _swFreq && _swFreq[e.code];
    h += '<tr>' +
      '<td>' + e.code + (e.name ? '<div class="rs-b-name">' + e.name + '</div>' : '') + '</td>' +
      '<td class="num">' + e.mkt.toFixed(2) + '%</td>' +
      '<td class="num"><b>' + (e.real == null ? '—' : e.real.toFixed(2) + '%') + '</b>' +
      (e.realLast == null ? '' : '<div class="rs-b-sub' +
        (e.real != null && Math.abs(e.realLast - e.real) >= 1 ? ' rs-b-gapbig' : '') + '">' +
        e.realLast.toFixed(2) + '%</div>') + '</td>' +
      (base ? '<td class="num"><b>' + (e.real == null ? '—' :
        ((e.real - base.real >= 0 ? '+' : '') + (e.real - base.real).toFixed(2) + ' pp')) +
        '</b></td>' : '') +
      '<td>' + swSparkHtml(tr, 'real') + '</td>' +
      '<td class="num">' + (e.e == null ? '—' : e.e.toFixed(1) + '%') + '</td>' +
      '<td class="num">' + (e.size == null ? '—' : e.size.toFixed(1) + ' 億') + '</td>' +
      '<td class="num">' + ((f && f.t) || '—') + '</td>' +
      '<td class="num">' + e.n + '</td>' +
      '<td>' + swHealthHtml(e.code, e) + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

// 比較基準：真實市價殖利率最低的持股，也就是表二標「換股候選」的那一檔
function swBase() {
  var hold = (typeof _rsBondHoldings === 'function') ? _rsBondHoldings() : [];
  var base = null;
  hold.forEach(function (c) {
    var e = swEval(c);
    if (e && e.real != null && (!base || e.real < base.real)) base = e;
  });
  return base;
}

// ══════════ 區塊 C：市場掃描 ══════════
function swBlockC() {
  var hold = (typeof _rsBondHoldings === 'function') ? _rsBondHoldings() : [];
  var base = swBase(), pool = [];
  for (var c in (_swFreq || {})) {
    var t = (_swFreq[c] || {}).t;
    if (t !== '月配' && t !== '雙月配' && t !== '季配') continue;
    if (hold.indexOf(c) >= 0) continue;
    var e = swEval(c);
    if (e && e.real != null) pool.push(e);
  }
  pool.sort(function (a, b) { return b.real - a.real; });
  var h = swCandTable(pool.slice(0, SW_TOP), base,
    '換股評估 C · 市場掃描（月配／雙月配／季配，前 ' + SW_TOP + ' 名）',
    '候選池中沒有可計算的標的（需要同時有配息紀錄與價格序列）。');
  h += '<div class="sw-sub">候選池 ' + pool.length + ' 檔可計算' +
    (base ? '；比較基準為你真實市價殖利率最低的持股 <b>' + base.code + ' ' +
      base.real.toFixed(2) + '%</b>' : '') + '。</div>';
  return h;
}

// ══════════ 區塊 D：指定標的 ══════════
function swBlockD() {
  var w = swWatchLoad(), base = swBase(), list = [], bad = [];
  w.forEach(function (c) {
    var e = swEval(c);
    if (e && e.real != null) list.push(e); else bad.push(c);
  });
  list.sort(function (a, b) { return b.real - a.real; });
  var h = swCandTable(list, base, '換股評估 D · 指定標的',
    '尚未加入標的。在下方輸入代號，可加多檔。');
  h += '<div class="sw-input">' +
    '<input id="sw-add" type="text" placeholder="輸入 ETF 代號，例如 00933B" maxlength="8">' +
    '<button onclick="swAdd()">加入</button>' +
    (w.length ? '<span class="sw-chips">' + w.map(function (c) {
      return '<span class="sw-chip">' + c + '<a onclick="swDel(&quot;' + c + '&quot;)">×</a></span>';
    }).join('') + '</span>' : '') + '</div>';
  if (bad.length) {
    h += '<div class="sw-sub"><b class="up">' + bad.join('、') + '</b> 算不出來：' +
      '需要同時有配息紀錄（MOPS）與價格序列。價格序列只涵蓋月配／雙月配／季配與債券型，' +
      '年配與半年配不在排程範圍內。</div>';
  }
  return h;
}

function swAdd() {
  var el = document.getElementById('sw-add');
  var c = ((el && el.value) || '').trim().toUpperCase();
  if (!/^\d{4,5}[A-Z]?$/.test(c)) { alert('代號格式不對，應為 4~5 位數字，可帶一個英文字母'); return; }
  var w = swWatchLoad();
  if (w.indexOf(c) < 0) { w.push(c); swWatchSave(w); }
  if (el) el.value = '';
  swRender();
}
function swDel(c) {
  swWatchSave(swWatchLoad().filter(function (x) { return x !== c; }));
  swRender();
}

// ══════════ 組裝與重繪 ══════════
function swAllHtml() {
  return swBlockB() + swBlockC() + swBlockD() +
    '<div class="rs-note">' +
    '<b>排序基準</b>：真實市價殖利率＝年化配息金額 ÷ <b>現價</b> ×（股利＋利息占比）。' +
    '用市價不用成本，是因為換股當下賣出拿到的是市價、成本基準隨即重設，舊成本是沉沒成本。' +
    '以 322 張 00981B 換 00989B 驗算，月配實際增加 5,410 元：' +
    '市價殖利率差推得 5,446 對得上，成本殖利率差推得 6,462 高估 19%。' +
    '成本殖利率仍在 B 區並列，它回答的是「原本投入的錢現在報酬如何」，那是另一個問題。<br>' +
    '<b>真實與帳面</b>：真實已扣掉收益平準金與資本利得。並列「加權／最新」，' +
    '加權為近 12 個月線性遞減（最新一期權重 n、遞減到最舊 1），最新為未平滑的最近一期；' +
    '兩者差距達 1 個百分點以上標紅，代表這段期間基金的收益結構改變了、平均不具代表性。<br>' +
    '<b>沒有成交量這一項</b>：目前的資料源都不給歷史成交金額，無法判斷候選標的吃不吃得下你的量。' +
    '「規模」是單位數 × 淨值，那是大小不是周轉——規模大但每日成交清淡的檔，掛 300 張一樣買不到。' +
    '下單前請自行確認成交量。<br>' +
    '<b>健康度</b>需要月規模，目前只有債券型 93 檔有；股票型要等每日單位數快照累積到' +
    '前後兩次除息日，月配約兩個月、季配約半年。<br>' +
    '<b>資料日</b>：價格與淨值 ' + ((typeof npDataDay === 'function' && npDataDay()) || '—') +
    '（來源落後約一個交易日），配息金額與占比 ' + ((typeof _dmDay !== 'undefined' && _dmDay) || '—') +
    '。<b>本區為依你設定規則自動計算的參考，非投資建議。</b></div>';
}

function swRender() {
  var el = document.getElementById('swap-scan');
  if (el) el.innerHTML = swAllHtml();
}
