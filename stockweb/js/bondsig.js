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
var _bsHyg = null, _bsBars = {}, _bsBusy = false;

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
    if (force) { _bsHyg = null; _bsBars = {}; }
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
        + '<td class="num rs-dim">' + _bsPx(base.last)
        + (base.lastD ? '<span class="bs-sub">' + base.lastD.slice(5).replace('-', '/') + '</span>' : '')
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

  h += '<div class="detail-note"><dl>' + bsNoteHtml() + '</dl></div></div>';
  return h;
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
