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
    for (var k = 0; k < codes.length; k++) {
      if (!_bsBars[codes[k]]) _bsBars[codes[k]] = await _rbSeries(codes[k], cfg.years);
    }
  } catch (e) { hush('bondsig', e); }
  _bsBusy = false;
}

// 一檔的成交率：掛在「前收 ± n 個升降單位」時，日內最低／最高有沒有觸及。
// sel 用來挑樣本（全部／隔夜 HYG 跌／漲）。
function bsFill(code, sel) {
  var bars = (_bsBars[code] || []).filter(function (b) { return b.l > 0 && b.h > 0 && b.c > 0; });
  if (bars.length < 30 || !_bsHyg) return null;
  var tick = _bsTick(bars[bars.length - 1].c);
  var buy = BS_OFFS.map(function () { return 0; }), sell = BS_OFFS.map(function () { return 0; }), n = 0;
  for (var i = 1; i < bars.length; i++) {
    var pc = bars[i - 1].c;
    if (!(pc > 0)) continue;
    var u = _bsHyg.prev(bars[i].d);
    var hv = (u != null && _bsHyg.rets[u] != null) ? _bsHyg.rets[u] : null;
    if (!sel(hv)) continue;
    n++;
    for (var k = 0; k < BS_OFFS.length; k++) {
      var off = BS_OFFS[k] * tick;
      if (bars[i].l <= pc - off + 1e-9) buy[k]++;
      if (bars[i].h >= pc + off - 1e-9) sell[k]++;
    }
  }
  if (n < 25) return null;
  return {
    n: n, tick: tick, last: bars[bars.length - 1].c,
    buy: buy.map(function (v) { return v / n * 100; }),
    sell: sell.map(function (v) { return v / n * 100; })
  };
}

function _bsPx(v, d) { return v == null ? '—' : v.toFixed(d == null ? 2 : d); }
function _bsRate(v) {
  if (v == null) return '<span class="dm-dim">—</span>';
  var cls = v >= 60 ? 'bs-hi' : (v >= 30 ? 'bs-mid' : 'bs-lo');
  return '<span class="' + cls + '">' + v.toFixed(0) + '%</span>';
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
    + (dir === 0
        ? '下表是<b>全部日子</b>的成交率：HYG 平盤或取不到，沒有方向可以挑樣本。'
        : '下表是<b>' + (up ? 'HYG 上漲' : 'HYG 下跌') + '的那些日子</b>的成交率 —— 今天偏這一邊，用同方向的樣本才有參考價值；'
          + '括號內是不分條件的全部日子。')
    + '<br>'
    + '價格已對齊升降單位，直接抄進委託單。<b>買進看日內最低有沒有跌到你的掛價，賣出看日內最高有沒有漲到。</b>'
    + '這裡不預測漲跌，只回答「掛在這個價位，歷史上多少比例的日子碰得到」。</div>';

  ['buy', 'sell'].forEach(function (side) {
    var isBuy = side === 'buy';
    h += '<div class="sec-title bs-side">' + (isBuy ? '買進：掛在前收之下' : '賣出：掛在前收之上') + '</div>'
      + '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>'
      + '<th>代號 / 名稱</th><th class="num">前收</th>';
    BS_OFFS.forEach(function (k) {
      h += '<th class="num">' + (k === 0 ? '平盤' : (isBuy ? '−' : '＋') + (k * 0.01).toFixed(2)) + '</th>';
    });
    h += '<th class="num">樣本</th></tr></thead><tbody>';
    codes.forEach(function (c) {
      var a = bsFill(c, sel), b = bsFill(c, selAll);
      if (!b) {
        h += '<tr><td><span class="tx-ocode">' + c + '</span><span class="tx-oname">' + _rbName(c) + '</span></td>'
          + '<td class="num rs-dim" colspan="' + (BS_OFFS.length + 2) + '">樣本不足 25 日，不列成交率</td></tr>';
        return;
      }
      var arr = a || b, all = b;
      h += '<tr><td><span class="tx-ocode">' + c + '</span><span class="tx-oname">' + _rbName(c) + '</span></td>'
        + '<td class="num rs-dim">' + _bsPx(arr.last) + '</td>';
      BS_OFFS.forEach(function (k, idx) {
        var px = arr.last + (isBuy ? -1 : 1) * k * arr.tick;
        var v = (isBuy ? arr.buy : arr.sell)[idx];
        var va = (isBuy ? all.buy : all.sell)[idx];
        h += '<td class="num">' + _bsRate(v)
          + '<span class="bs-sub">' + _bsPx(px) + '</span>'
          + '<span class="bs-all">(' + va.toFixed(0) + '%)</span></td>';
      });
      h += '<td class="num rs-dim">' + arr.n + ' 日</td></tr>';
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
    + '主要數字取自與今天同方向的那組樣本（隔夜 HYG 漲或跌），括號內是不分條件的全部日子。</dd>'
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
