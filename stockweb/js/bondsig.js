// 股利總管 Web — 債券（進場訊號板的第三個頁籤）
//
// 債券跟股票要問的不是同一件事。股票那邊問「明天會漲多少」，所以追求說明力；
// 非投等債的波動只有主動股票型的十分之一（實測 00989B 年化 4.4%、00405A 49.3%），
// 拿方向預測去衡量它是用錯的尺。這裡要回答的是：
//
//     「我掛在比前收低 2 分的地方，今天有多少機率買得到？」
//
// 這個問題不需要預測方向，只要數日內最低價有沒有觸及掛價。
//
// HYG（非投等債 ETF）在這裡有用，但用法不是推估價格，是**挑樣本**：
// 隔夜 HYG 跌的日子，買進的成交率明顯較高；漲的日子，賣出的成交率較高。
// 實測 00989B 掛 −0.03 買進：HYG 跌的日子 33%、漲的日子只有 14%。
// 只用 HYG 一個參數——多加 TLT、殖利率會讓參數變多、彼此重疊，反而難判讀。

var BS_OFFS = [0, 1, 2, 3, 4, 5];          // 掛價距前收幾個升降單位
var _bsHyg = null, _bsBars = {}, _bsBusy = false, _bsFx = null;

// ══════ 匯率曝險 ══════
//
// 為什麼要有這一段：這兩檔持有的是美元計價的債券，在台股以台幣掛牌。
// 你看到的淨值同時含兩件事：債券本身的漲跌，以及台幣兌美元的變動。
// 帳面跌 3% 可能是債券跌 6%、台幣貶值補回 3%，兩者導向的決定不一樣。
//
// 頻率的選擇不是隨便挑的。逐日報酬幾乎測不到相關（2026-11-14 實測
// 00981B 近 90 天 0.055、00984D 近 90 天 0.100，都不顯著），但不重疊的
// 5 日報酬測得到（最近 20 段 0.587 與 0.476，顯著）。原因是這兩檔成交稀疏、
// 買賣價差相對波動很大，單日報酬裡雜訊佔比太高，把真訊號稀釋掉；
// 彙總到一週雜訊互相抵消，匯率的成分才浮出來。
//
// 用不重疊而不是滾動：滾動窗彼此重疊，看起來樣本幾百個、實際獨立的只有幾十個，
// 顯著性會被灌水好幾倍。
var BS_FXSEG = 5;        // 幾個交易日算一段
var BS_FXN = 20;         // 取最近幾段估 beta
var BS_FX_SYM = 'TWD=X'; // USD/TWD，上漲＝台幣貶值

// 把日收盤接成不重疊的 N 日報酬配對
function _bsFxPairs(code, seg) {
  if (!_bsFx || !_bsBars[code]) return null;
  var pm = {}, pd = [];
  _bsBars[code].forEach(function (b) { if (b.c > 0) { pm[b.d] = b.c; pd.push(b.d); } });
  var ds = pd.filter(function (d) { return _bsFx[d] > 0; });
  var X = [], Y = [], T = [];
  for (var i = seg; i < ds.length; i += seg) {
    X.push((_bsFx[ds[i]] / _bsFx[ds[i - seg]] - 1) * 100);
    Y.push((pm[ds[i]] / pm[ds[i - seg]] - 1) * 100);
    T.push(ds[i]);
  }
  return { x: X, y: Y, t: T };
}
// 最小平方 ＋ beta 的標準誤。標準誤一定要給：20 段估出來的 beta 很鬆，
// 寫成一個精確數字會被當成已知常數用。
function _bsFxFit(X, Y) {
  var n = X.length;
  if (n < 8) return null;
  var mx = 0, my = 0, i;
  for (i = 0; i < n; i++) { mx += X[i]; my += Y[i]; }
  mx /= n; my /= n;
  var sxy = 0, sxx = 0, syy = 0;
  for (i = 0; i < n; i++) { var a = X[i] - mx, b = Y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (!(sxx > 0) || !(syy > 0)) return null;
  var beta = sxy / sxx, alpha = my - beta * mx, sr = 0;
  for (i = 0; i < n; i++) { var e = Y[i] - alpha - beta * X[i]; sr += e * e; }
  var se = Math.sqrt((sr / (n - 2)) / sxx);
  var r = sxy / Math.sqrt(sxx * syy);
  return { n: n, beta: beta, se: se, r: r, t: se > 0 ? beta / se : null };
}
// 最近 BS_FXN 段的 beta
function bsFxBeta(code) {
  var p = _bsFxPairs(code, BS_FXSEG);
  if (!p || p.x.length < 8) return null;
  var k = Math.min(BS_FXN, p.x.length);
  var f = _bsFxFit(p.x.slice(-k), p.y.slice(-k));
  if (f) { f.from = p.t[p.t.length - k]; f.to = p.t[p.t.length - 1]; }
  return f;
}
// beta 隨時間：不重疊的區塊各估一次。曝險是會變的，不是固定屬性：
// 2026-11-14 實測 00984D 前半段 −0.18、後半段 0.53，它原本沒有匯率曝險。
function bsFxBetaHist(code) {
  var p = _bsFxPairs(code, BS_FXSEG);
  if (!p) return [];
  // 由新往舊切。最前面那一塊不足 BS_FXN 段也收，只要還有 8 段以上，
  // 否則上市較晚的那一檔只會切出一塊，看不出「這個曝險是不是近期才出現的」。
  var out = [], k = BS_FXN;
  for (var e = p.x.length; e >= 8; e -= k) {
    var st = Math.max(0, e - k);
    if (e - st < 8) break;
    var f = _bsFxFit(p.x.slice(st, e), p.y.slice(st, e));
    if (f) out.push({ from: p.t[st], to: p.t[e - 1], beta: f.beta, se: f.se, n: f.n });
  }
  return out;   // 新的在前，兩檔的第一欄才是同一個期間
}
// 報酬拆解：這一段期間，有多少是匯率給的
function bsFxDecomp(code, beta, days) {
  if (!_bsFx || !_bsBars[code] || beta == null) return null;
  var pm = {}, pd = [];
  _bsBars[code].forEach(function (b) { if (b.c > 0) { pm[b.d] = b.c; pd.push(b.d); } });
  var ds = pd.filter(function (d) { return _bsFx[d] > 0; });
  if (ds.length <= days) return null;
  var a = ds[ds.length - 1 - days], b = ds[ds.length - 1];
  var fx = (_bsFx[b] / _bsFx[a] - 1) * 100, etf = (pm[b] / pm[a] - 1) * 100;
  return { from: a, to: b, fx: fx, contrib: fx * beta, etf: etf, rest: etf - fx * beta };
}

// 債券型：持股中代號結尾 B（債券）或 D（組合／多重資產債）
function bsCodes() {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return Object.keys(m).filter(function (c) { return m[c] > 0 && /^00\d+[BD]$/.test(c); }).sort();
}
function _bsTick(p) { return p < 50 ? 0.01 : 0.05; }

// 價格比大小一律換成「分」的整數再比，不留浮點數的容忍值。
//
// 原本寫的是 `日內最低 <= 掛價 + 1e-9`。資料來源回傳的是單精度浮點數，
// 9.78 存進去是 9.779999732971191、9.76 是 9.760000228881836，誤差約 2e-7，
// 比那個容忍值大兩百倍。於是「日內最低剛好等於掛價」時，算不算成交要看
// 浮點數往哪邊捨入，大約一半的情況被判成沒成交。
//
// 而「剛好等於」正是這張表的大宗：這兩檔一天只動 1 到 3 檔，掛價又是整數檔位。
// 2026-11-14 實測 00984D 掛 −0.02，修正前 38%、修正後 52%，差 14 個百分點，
// 而且四個數列（兩檔 × 買賣）全部往低估的方向偏，中段偏最多。
//
// 換成整數之後沒有誤差可言，也不必再猜容忍值該設多大。
function _bsCents(v) { return Math.round(v * 100); }
// 掛價要先對齊升降單位：委託單只掛得出格線上的價格，統計就該用同一個價格。
function _bsAlign(v) { var t = _bsTick(v); return Math.round(v / t) * t; }

async function bsPrepare(force) {
  if (_bsBusy) return;
  _bsBusy = true;
  try {
    var cfg = _rbCfg();
    if (force) { _bsHyg = null; _bsBars = {}; _bsFx = null; }
    if (!_bsHyg) {
      var h = await _rbSeries('HYG', cfg.years);
      if (h && h.length > 60) {
        var rets = {}, ds = [];
        for (var i = 1; i < h.length; i++) {
          if (!(h[i - 1].c > 0)) continue;
          rets[h[i].d] = (h[i].c / h[i - 1].c - 1) * 100; ds.push(h[i].d);
        }
        _bsHyg = { rets: rets, dates: ds, prev: _rbPrevFn(ds), last: ds.length ? { d: ds[ds.length - 1], r: rets[ds[ds.length - 1]] } : null };
      }
    }
    if (!_bsFx) {
      // 匯率日線。走的是股票那條共用的序列抓取，所以快取、缺口補值都一樣。
      var fb = await _rbSeries(BS_FX_SYM, cfg.years);
      if (fb && fb.length > 60) {
        _bsFx = {};
        fb.forEach(function (b) { if (b.c > 0) _bsFx[b.d] = b.c; });
      }
    }
    var codes = bsCodes();
    // 交易日曆用大盤，跟股票那邊同一套缺口偵測。原本債券這條路沒接，
    // Yahoo 漏一天就只能退回前一天的收盤，而畫面上看不出來。
    var cal = null;
    try {
      var idx = (_rbData && _rbData.idx && _rbData.idx.length)
        ? _rbData.idx : await _rbSeries('^TWII', cfg.years);
      cal = idx.map(function (b) { return b.d; });
    } catch (e) { hush('bondsig', e); }
    for (var k = 0; k < codes.length; k++) {
      if (!_bsBars[codes[k]]) {
        _bsBars[codes[k]] = await _rbSeries(codes[k], cfg.years);
        if (cal) { try { await _rbPatchGaps(codes[k], _bsBars[codes[k]], cal); } catch (e2) { hush('bondsig', e2); } }
      }
    }
  } catch (e) { hush('bondsig', e); }
  _bsBusy = false;
}

// 一檔的成交率：掛在「前收 ± n 個升降單位」時，日內最低／最高有沒有觸及。
// sel 用來挑樣本（全部／隔夜 HYG 跌／漲）。
// days 有給就只看最近 N 個交易日，而且不拆 HYG 方向（30 天拆完每格剩十幾天，沒有意義）。
// 這一列的用途是「現在跟平常比是鬆還是緊」，不是拿來取代全期統計。
function bsFill(code, sel, days) {
  var all = _bsBars[code] || [];
  // 成交率要日內最高最低才算得出來，所以統計只用高低齊全的日子。
  // 但「前收」只需要收盤 —— 拿最新那一根有收盤的，不要跟著統計一起被濾掉。
  // 收盤當下 Yahoo 偶爾只給得出收盤（高低要等補），那一天算不進成交率，
  // 卻一定要當前收：掛單是掛在今天收盤的上下，不是前天收盤的上下。
  // 高低相等的那幾根排掉：上市後的頭幾個交易日資料來源給不出日內價，
  // 開高低收填同一個數字（而且不在升降單位的格線上，例如 10.0103）。
  // 留著的話平盤那一欄會變成必定成交，等於灌水。兩檔各 8 根。
  var bars = all.filter(function (b) { return b.l > 0 && b.h > 0 && b.c > 0 && b.h > b.l; });
  if (bars.length < 30 || !_bsHyg) return null;
  var win = days ? Math.max(2, Math.min(days + 1, bars.length)) : 0;
  var lastC = null;
  for (var z = all.length - 1; z >= 0; z--) { if (all[z].c > 0) { lastC = all[z]; break; } }
  if (!lastC) lastC = bars[bars.length - 1];
  var tick = _bsTick(lastC.c);
  var buy = BS_OFFS.map(function () { return 0; }), sell = BS_OFFS.map(function () { return 0; }), n = 0;
  for (var i = win ? bars.length - win + 1 : 1; i < bars.length; i++) {
    var pc = bars[i - 1].c;
    if (!(pc > 0)) continue;
    if (!win) {
      var u = _bsHyg.prev(bars[i].d);
      var hv = (u != null && _bsHyg.rets[u] != null) ? _bsHyg.rets[u] : null;
      if (!sel(hv)) continue;
    }
    n++;
    var lc = _bsCents(bars[i].l), hc = _bsCents(bars[i].h);
    for (var k = 0; k < BS_OFFS.length; k++) {
      var off = BS_OFFS[k] * tick;
      if (lc <= _bsCents(_bsAlign(pc - off))) buy[k]++;
      if (hc >= _bsCents(_bsAlign(pc + off))) sell[k]++;
    }
  }
  if (n < (win ? 10 : 25)) return null;
  return {
    n: n, tick: tick, last: lastC.c, lastD: lastC.d,
    buy: buy.map(function (v) { return v / n * 100; }),
    sell: sell.map(function (v) { return v / n * 100; })
  };
}

function _bsPx(v, d) { return v == null ? '—' : v.toFixed(d == null ? 2 : d); }
// on＝這個方向就是今天的方向，標重；另一邊淡化但仍然讀得到
// 強弱用亮度與粗細，不用紅綠。
// 綠色在這一頁是「跌」，而成交率不是漲跌，借用它會讓整頁的色彩語彙鬆掉。
function _bsRate(v, on) {
  if (v == null) return '<span class="dm-dim">—</span>';
  if (!on) return '<span class="bs-off">' + v.toFixed(0) + '%</span>';
  return '<span class="' + (v >= 60 ? 'bs-s3' : (v >= 30 ? 'bs-s2' : 'bs-s1')) + '">'
    + v.toFixed(0) + '%</span>';
}

function bsHtml() {
  var codes = bsCodes();
  if (!codes.length) {
    return '<div class="modal-loading">持股中沒有債券型 ETF（代號結尾 B 或 D），這個頁籤沒有標的。</div>';
  }
  if (!_bsHyg) {
    return '<div class="modal-loading">HYG 日線取不到（代理服務無回應）。'
      + '<button class="btn-query" onclick="startRebound(true)">重試</button></div>';
  }
  var L = _bsHyg.last;
  // 今天偏哪一邊，就拿那一組樣本當主要數字——這是 HYG 在這裡唯一的用途。
  // 平盤或取不到時不該歸到任一邊，改用全部日子；門檻用「剛好為零」，不自己訂一個平盤區間。
  var dir = (!L || L.r == null || L.r === 0) ? 0 : (L.r > 0 ? 1 : -1);
  var up = dir > 0;
  var sel = dir === 0 ? function () { return true; }
    : (up ? function (v) { return v != null && v > 0; } : function (v) { return v != null && v < 0; });
  var selAll = function () { return true; };
  var h = '<div class="rb-sox">';
  h += '<div class="sec-title">債券：掛單價差的成交率</div>';
  h += '<div class="rb-sox-hd on">隔夜 HYG <b style="color:' + _rbCol(L ? L.r : null) + '">'
    + (L ? ((L.r > 0 ? '+' : '−') + Math.abs(L.r).toFixed(2) + '%') : '—') + '</b>（' + (L ? L.d : '—') + '）。'
    + '每一格兩個數字是<b>「HYG 跌的日子 ／ HYG 漲的日子」</b>的成交率，'
    + (dir === 0 ? '今天 HYG 平盤或取不到，兩邊都不標重。'
                 : '粗體那個是今天的方向（' + (up ? 'HYG 上漲' : 'HYG 下跌') + '）。')
    + '兩邊都列是為了讓你看得到「萬一明天反過來，這個掛價變成多少」。'
    + '<br>'
    + '每一格上方的大字是<b>價格</b>，已對齊升降單位，直接抄進委託單；'
    + '下方小字是那個價位的成交率。'
    + '<b>買進看日內最低有沒有跌到你的掛價，賣出看日內最高有沒有漲到。</b>'
    + '這裡不預測漲跌，只回答「掛在這個價位，歷史上多少比例的日子碰得到」。'
    + '<br><b>「近 30 日」那一列</b>：同一個掛價在最近 30 個交易日的實際成交率，'
    + '小字是它跟上面全期數字的差距。它回答的是「現在跟平常比是鬆是緊」，'
    + '不拆 HYG 方向（30 天再拆成兩半，每格只剩十幾天）。'
    + '<b>它不是更準的那個數字</b>：30 天的標準誤約 ±9 個百分點，'
    + '全期（兩、四百天）是 ±2 到 ±4。實測拿近 30 日去預測接下來 20 天，'
    + '四檔裡有三檔比用全期還差。兩個並列是讓你看差距，不是讓你換掉上面那一個。</div>';

  ['buy', 'sell'].forEach(function (side) {
    var isBuy = side === 'buy';
    h += '<div class="sec-title bs-side">' + (isBuy ? '買進：掛在前收之下' : '賣出：掛在前收之上') + '</div>'
      + '<div class="rs-cat-wrap"><table class="inv-table rb-table bs-table"><thead><tr>'
      + '<th>代號 / 名稱</th><th class="num">前收</th>';
    BS_OFFS.forEach(function (k) {
      h += '<th class="num">' + (k === 0 ? '平盤' : (isBuy ? '−' : '＋') + (k * 0.01).toFixed(2)) + '</th>';
    });
    h += '<th class="num" title="左為 HYG 下跌的日數、右為上漲">樣本 跌／漲</th></tr></thead><tbody>';
    codes.forEach(function (c) {
      var dn = bsFill(c, function (v) { return v != null && v < 0; });
      var upS = bsFill(c, function (v) { return v != null && v > 0; });
      var b = bsFill(c, selAll);
      if (!b) {
        h += '<tr><td><span class="tx-ocode">' + c + '</span><span class="tx-oname">' + _rbName(c) + '</span></td>'
          + '<td class="num rs-dim" colspan="' + (BS_OFFS.length + 2) + '">樣本不足 25 日，不列成交率</td></tr>';
        return;
      }
      var base = dn || upS || b;
      var r30 = bsFill(c, selAll, 30);
      // 價格放主體、成交率降為小字：掛單要抄的是價格，成交率是用來決定抄哪一欄。
      // 與股票那張成交率表同一個主從關係。
      h += '<tr><td><span class="tx-ocode">' + c + '</span><span class="tx-oname">' + _rbName(c) + '</span></td>'
        + '<td class="num" style="color:' + _rbCol(_rbLastChg(_bsBars[c] || [])) + '">' + _bsPx(base.last)
        + (base.lastD ? '<span class="bs-sub">' + base.lastD.slice(5).replace('-', '/') + '</span>' : '')
        + (typeof _rbStreakSub === 'function' ? _rbStreakSub(_bsBars[c] || []) : '')
        + '</td>';
      BS_OFFS.forEach(function (k, idx) {
        var px = _bsAlign(base.last + (isBuy ? -1 : 1) * k * base.tick);
        var pick = function (z) { return z ? (isBuy ? z.buy : z.sell)[idx] : null; };
        h += '<td class="num"><span class="bs-px">' + _bsPx(px) + '</span>'
          + '<span class="bs-sub">'
          + _bsRate(pick(dn), dir < 0) + '<span class="bs-slash">／</span>' + _bsRate(pick(upS), dir > 0)
          + '</span></td>';
      });
      h += '<td class="num rs-dim">' + (dn ? dn.n : 0) + ' ／ ' + (upS ? upS.n : 0) + ' 日</td></tr>';
      // 近 30 日：回答「現在跟平常比是鬆還是緊」。不拆 HYG 方向，分母就是 30。
      if (r30) {
        h += '<tr class="bs-r30"><td class="bs-r30-l">近 30 日</td><td class="num"></td>';
        BS_OFFS.forEach(function (k, idx) {
          var v = (isBuy ? r30.buy : r30.sell)[idx];
          var full = base ? (isBuy ? b.buy : b.sell)[idx] : null;
          var d = (v == null || full == null) ? null : v - full;
          h += '<td class="num">' + (v == null ? '<span class="dm-dim">—</span>'
            : v.toFixed(0) + '%<span class="bs-sub">'
              + (d == null ? '' : (d > 0 ? '＋' : (d < 0 ? '−' : '±')) + Math.abs(d).toFixed(0))
              + '</span>') + '</td>';
        });
        h += '<td class="num rs-dim">' + r30.n + ' 日</td></tr>';
      }
    });
    h += '</tbody></table></div>';
  });

  h += bsFxHtml();
  h += '<div class="detail-note"><dl>' + bsNoteHtml() + bsFxNoteHtml() + '</dl></div></div>';
  return h;
}

// ── 匯率曝險區 ──
// 這一區不預測任何事，只說明「你現在同時持有多大的美元部位」。
function bsFxHtml() {
  var codes = bsCodes();
  if (!_bsFx) {
    return '<div class="sec-title bs-side">匯率曝險</div>'
      + '<div class="rb-caveat nb-keep">匯率日線取不到（代理服務無回應），這一區略過。</div>';
  }
  var pc = function (v, dp) {
    if (v == null) return '—';
    return (v > 0 ? '＋' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(dp == null ? 2 : dp) + '%';
  };
  // 負號用排版用的減號，跟全站一致（ASCII 的短橫線在數字旁邊會矮一截）
  var bt = function (v) { return (v < 0 ? '−' : '') + Math.abs(v).toFixed(2); };
  var rows = codes.map(function (c) { return { c: c, b: bsFxBeta(c) }; }).filter(function (r) { return r.b; });
  if (!rows.length) {
    return '<div class="sec-title bs-side">匯率曝險</div>'
      + '<div class="rb-caveat nb-keep">樣本不足，估不出匯率敏感度。</div>';
  }

  var h = '<div class="sec-title bs-side">匯率曝險</div>';
  h += '<div class="rb-sox-hd on">這兩件事混在同一個淨值裡：<b>債券本身的漲跌</b>與<b>台幣兌美元的變動</b>。'
    + '下表把它們拆開。敏感度是用不重疊的 ' + BS_FXSEG + ' 日報酬、最近 ' + BS_FXN + ' 段估的，'
    + '逐日報酬測不到（雜訊蓋過訊號），理由在下方說明。</div>';

  var HS = [20, 60, 120];
  h += '<div class="rs-cat-wrap"><table class="inv-table rb-table bs-table"><thead><tr>'
    + '<th>代號 / 名稱</th>'
    + '<th class="num" title="台幣兌美元每變動 1%，淨值跟著變動幾 %。正值＝台幣貶值對淨值有利">匯率敏感度</th>';
  HS.forEach(function (d) {
    h += '<th class="num" title="這段期間的實際報酬，以及把匯率那一塊扣掉之後剩下的（債券本身）">'
      + '近 ' + d + ' 日</th>';
  });
  h += '</tr></thead><tbody>';

  rows.forEach(function (r) {
    var b = r.b;
    // beta 一律連同正負一個標準誤一起寫。20 段估出來的 beta 很鬆，
    // 只給點估計會被當成已知常數用在心算上。
    h += '<tr><td><span class="tx-ocode">' + r.c + '</span><span class="tx-oname">' + _rbName(r.c) + '</span></td>'
      + '<td class="num"><span class="bs-px">' + bt(b.beta) + '</span>'
      + '<span class="bs-sub">±' + b.se.toFixed(2)
      + (b.t != null && Math.abs(b.t) >= 2 ? '　測得到' : '　<b>測不到</b>') + '</span></td>';
    HS.forEach(function (d) {
      var k = bsFxDecomp(r.c, b.beta, d);
      if (!k) { h += '<td class="num rs-dim">—</td>'; return; }
      h += '<td class="num"><span class="bs-px" style="color:' + _rbCol(k.etf) + '">' + pc(k.etf) + '</span>'
        + '<span class="bs-sub">匯率 ' + pc(k.contrib) + '</span>'
        + '<span class="bs-sub">債券 <b style="color:' + _rbCol(k.rest) + '">' + pc(k.rest) + '</b></span></td>';
    });
    h += '</tr>';
  });
  h += '</tbody></table></div>';

  // 同期間的台幣變動，整段只說一次（它對每一檔都一樣，不該在每一格重複）
  var any = bsFxDecomp(rows[0].c, 1, 120), a60 = bsFxDecomp(rows[0].c, 1, 60), a20 = bsFxDecomp(rows[0].c, 1, 20);
  h += '<div class="rb-caveat">同期間台幣兌美元：近 20 日 ' + (a20 ? pc(a20.fx) : '—')
    + '、近 60 日 ' + (a60 ? pc(a60.fx) : '—') + '、近 120 日 ' + (any ? pc(any.fx) : '—')
    + '（正值＝台幣貶值）。'
    + '「匯率」那一列＝台幣變動 × 這一檔的敏感度；「債券」＝實際報酬減掉匯率那一塊，'
    + '也就是把匯率影響拿掉之後，債券部位自己的表現。</div>';

  // 敏感度隨時間：收合，屬於進階追蹤
  var hist = rows.map(function (r) { return { c: r.c, h: bsFxBetaHist(r.c) }; })
                 .filter(function (r) { return r.h.length > 1; });
  if (hist.length) {
    h += '<details class="bs-fxh"><summary>敏感度隨時間的變化（' + BS_FXN + ' 段一組）</summary>'
      + '<div class="rs-cat-wrap"><table class="inv-table rb-table bs-table"><tbody>';
    // 欄數取最多的那一檔，短的在右邊補空格，第一欄才會是同一個期間
    var wide = hist.reduce(function (a, r) { return Math.max(a, r.h.length); }, 0);
    hist.forEach(function (r) {
      h += '<tr><td><span class="tx-ocode">' + r.c + '</span></td>';
      for (var i = 0; i < wide; i++) {
        var x = r.h[i];
        if (!x) { h += '<td class="num rs-dim">—</td>'; continue; }
        h += '<td class="num"><span class="bs-px">' + bt(x.beta) + '</span>'
          + '<span class="bs-sub">' + x.from.slice(2).replace(/-/g, '/') + '～</span>'
          + '<span class="bs-sub">' + x.to.slice(2).replace(/-/g, '/')
          + '（' + x.n + ' 段）</span></td>';
      }
      h += '</tr>';
    });
    h += '</tbody></table></div>'
      + '<div class="rb-caveat">左邊是最近的一段，越往右越早。'
      + '曝險會變，不是固定屬性，列在這裡是為了讓你看得出「現在這個數字是常態還是近期才出現的」。'
      + '段數不足 ' + BS_FXN + ' 的那一欄是上市後資料就只有那麼多，標在日期後面。</div>'
      + '</details>';
  }
  return h;
}

function bsFxNoteHtml() {
  var rows = bsCodes().map(function (c) { return { c: c, b: bsFxBeta(c) }; }).filter(function (r) { return r.b; });
  var ex = rows.length ? rows[0] : null;
  return '<dt>匯率敏感度 · 定義</dt><dd>把每 ' + BS_FXSEG + ' 個交易日接成一段<b>不重疊</b>的報酬，'
    + '拿這一檔的段報酬對 USD/TWD 的段報酬做最小平方，斜率就是敏感度，取最近 ' + BS_FXN + ' 段。'
    + '匯率上漲代表台幣貶值，所以正的敏感度＝台幣貶值時淨值上升。'
    + '旁邊的 ± 是這個斜率的標準誤，不是波動範圍。</dd>'
    + '<dt>匯率敏感度 · 比較基準</dt><dd>兩個。一是跟 0 比：標示「測得到」代表斜率離 0 有兩個標準誤以上，'
    + '「測不到」代表這段期間分不出它有沒有匯率曝險。二是跟自己的歷史比，在收合的那張表裡。'
    + '沒有跟同類基金比，因為避險與否是各檔自己的政策，不存在一個「正常值」。</dd>'
    + '<dt>匯率敏感度 · 白話意義</dt><dd>台幣兌美元每變動 1%，這一檔的淨值大約跟著變動幾 %，'
    + '這一塊跟債券漲跌無關。數字接近 1 等於幾乎沒有避險，接近 0 等於避掉了。</dd>'
    + '<dt>匯率敏感度 · 機制</dt><dd>這幾檔持有的是美元計價的債券，在台股以台幣報價。'
    + '傳導路徑：<code>台幣貶值 → 同一批美元債券換算回台幣的金額變大 → 淨值上升</code>，'
    + '跟債券價格本身沒有關係。基金若做了匯率避險，這條路徑會被鎖掉一部分，敏感度就往 0 靠。'
    + '為什麼逐日看不到：這兩檔成交稀疏、買賣價差相對日波動很大，'
    + '單日報酬裡雜訊佔比太高，把匯率的成分稀釋掉；彙總成一週，雜訊互相抵消就浮出來了。'
    + '2026-11-14 實測 00981B 逐日近 90 天相關 0.055（測不到），同期不重疊 5 日是 0.587（測得到）。</dd>'
    + '<dt>匯率敏感度 · 行動含義</dt><dd>它改變的是你怎麼讀帳面損益，不是買賣訊號。'
    + '看到帳上跌幾 %，要先扣掉匯率那一塊，才知道債券部位本身發生了什麼。'
    + '兩檔的敏感度不同時，它們在你的部位裡就不是同一種東西，即使名字都叫非投等債。</dd>'
    + '<dt>匯率敏感度 · 不能告訴你什麼</dt><dd>五件事。'
    + '一、<b>它不能用來擇時</b>。實測匯率自己的日自相關是 −0.065，昨天的變動對今天沒有資訊；'
    + '前一日匯率對今日報酬的相關是 −0.005 與 −0.015。拆解是在解釋已經發生的事，不是預測。'
    + '二、它<b>進不了上面那張成交率表</b>。條件要在你下單前就知道，而台幣是在台股盤中同步變動的；'
    + '開盤前唯一拿得到的匯率類訊號是隔夜美元指數，實測它對這兩檔的相關只有 −0.07。'
    + '三、' + BS_FXN + ' 段的樣本很小'
    + (ex ? '，' + ex.c + ' 的標準誤是 ±' + ex.b.se.toFixed(2) + '，佔斜率本身的 '
        + Math.round(Math.abs(ex.b.se / ex.b.beta) * 100) + '%' : '')
    + '。把它當成精確常數去心算會高估精度。'
    + '四、敏感度是估出來的，不是基金公布的避險比例。它同時吃到真實避險政策與期間內的巧合。'
    + '五、拆解假設敏感度在整段期間是固定的。近 120 日那一欄跨了半年，而收合表裡看得到它會變，'
    + '所以期間越長、那個拆解越粗。</dd>';
}

function bsNoteHtml() {
  return '<dt>定義</dt><dd>買進成交率＝歷史上有多少比例的日子，<b>日內最低價</b>跌到「前一日收盤 − N 個升降單位」'
    + '或更低；賣出成交率看的是<b>日內最高價</b>有沒有漲到「前一日收盤 ＋ N」。'
    + '50 元以下的升降單位是 0.01，表上的價格已經對齊，可以直接抄進委託單。'
    + '每一格兩個數字是「HYG 跌的日子／HYG 漲的日子」，粗體是今天的方向。'
    + '兩邊都列，是因為你要決定的往往不是「今天掛多少」而是「要不要等反方向那一天」。</dd>'
    + '<dt>比較基準</dt><dd>兩個。一是同一檔的不同掛價互相比，回答「多掛遠一點，成交率掉多少」；'
    + '二是同一個掛價在「HYG 漲」與「HYG 跌」的日子互相比，回答「今天這個方向，值不值得掛遠一點」。'
    + '不跟股票那幾頁比——波動量級差十倍，混在一起看會誤判。</dd>'
    + '<dt>白話意義</dt><dd>你想買便宜一分、賣貴一分，這張表告訴你那一分的代價是多少成交率。</dd>'
    + '<dt>機制</dt><dd>HYG 是美國非投等債的指標，這幾檔台灣掛牌的債券 ETF 持有的是同一類資產，'
    + '所以隔夜 HYG 的方向會帶動隔天的開盤與盤中走勢：<code>HYG 跌 → 隔天偏弱 → 日內低點更低 → 買進容易成交</code>，'
    + '漲的時候反過來。它在這裡不是拿來預測價格的，只是用來挑出「跟今天同方向」的那些日子。</dd>'
    + '<dt>行動含義</dt><dd>掛價不是越低越好。成交率從平盤的九成掉到 −0.03 的兩成多，'
    + '多賺三分錢的代價是七成以上的日子根本買不到。要建倉就往上掛，要撿便宜就往下掛，'
    + '這張表只把兩邊的代價標出來，不替你決定。</dd>'
    + '<dt>這個指標不能告訴你什麼</dt><dd>四件事。'
    + '一、它不預測方向。成交率高不代表買得划算——跌得多當然容易成交，那正是價格在走弱。'
    + '二、它用的是日線的最高最低，<b>不保證你那個數量排得進去</b>。債券 ETF 的量比股票小，'
    + '掛大筆時實際成交會比表上差。'
    + '三、樣本只有一兩年，而且這段期間利率走勢偏單一方向，升息循環裡的分布會不一樣。'
    + '四、它不含配息。除息日前後的價格本來就會跳，那幾天的成交率要另外看。</dd>';
}
