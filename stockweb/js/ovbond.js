// 股利總管 Web — 夜推債券（進場訊號板的第五個頁籤）
//
// 跟夜推股票同一個框，框裡問的不是同一件事。
//
// 股票那一頁問「明天會走到哪」，所以畫的是推估價與區間。債券不能這樣問：
// 實測五個隔夜訊號（台指期夜盤、費半、HYG、美債殖利率、匯率）對三檔債券的
// 隔日收盤，走查之後最好的模型只能把中心點挪動不到一個升降單位。
// 其中 HYG 的統計訊號是真的（增量 F 23.6 到 42.7，門檻 3.95，股票那九檔全部不到），
// 但它的用途不是推估價格，是挑樣本：隔夜 HYG 跌的日子，買進的成交率明顯較高。
//
// 所以這一頁問的是：
//
//     「我掛在比前收低 N 檔的地方，今天有多少機率買得到？」
//
// 這個問題不需要預測方向，只要數日內最低價有沒有觸及掛價。
// 成交率的算法沿用債券那一頁，這裡只負責畫。
//
// ── 橫軸是掛價，不是漲跌幅 ──
//
// 股票那一頁的軸是對前收的漲跌幅，兩頁的軸意義不同，不能互相比。
// 這一頁的軸是「掛價距前收幾個升降單位」，左邊便宜、右邊貴，正中央是前收。
// 三檔債券的升降單位都是 0.01，所以這條軸天生就是共用的。
//
// 柱子的高度是成交率，0 到 100% 固定刻度，跨框可比。
// 前收左邊的柱子是買進成交率（日內最低有沒有跌到掛價），
// 右邊是賣出成交率（日內最高有沒有漲到）。正中央兩根半寬，買賣各一。

var OVB_N = 5;            // 前收上下各幾個升降單位
var OVB_H = 104;          // 柱子區的高度（px），對應 0 到 100%
// 掛價過半成交的門檻。50% 的意思是「歷史上碰得到的日子比碰不到的多」，
// 不是哪個分位數算出來的，是「多數」這個概念本身的分界。
var OVB_HI = 50;

function _ovbIsBond(code) { return /^00\d+[BD]$/.test(String(code)); }

// ── 這一頁收哪些標的 ──
//
// 持股裡的債券，加上關注清單裡的債券。只看持股的話，還在觀察、還沒買的那幾檔
// 就看不到成交率，而那正是最需要知道「掛在這個價買不買得到」的時候。
//
// 債券那一頁維持只看持股，不動它：那一頁還有匯率曝險，而曝險講的是
// 「你現在同時持有多大的美元部位」，沒持有的標的放進去沒有意義。
function _ovbCodes() {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  var out = Object.keys(m).filter(function (c) { return m[c] > 0 && _ovbIsBond(c); });
  var seen = {};
  out.forEach(function (c) { seen[c] = 1; });
  var w = (typeof _wtLoad === 'function') ? (_wtLoad() || []) : [];
  w.forEach(function (c) {
    c = String(c);
    if (!seen[c] && _ovbIsBond(c)) { seen[c] = 1; out.push(c); }
  });
  return out.sort();
}
function _ovbHeld(code) {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return !!(m[code] > 0);
}

// 成交率的算法吃的是債券那一頁的日線快取，而那份快取只裝持股。
// 關注清單那幾檔的日線進場訊號板本來就抓過了（而且補過缺口），接過來放進同一個快取，
// 算法就不必改。那份快取是以代號為鍵的純快取，其他地方都只走持股清單，多幾個鍵不影響。
function _ovbFillBars() {
  if (typeof _bsBars === 'undefined' || !_bsBars) return;
  var src = (typeof _rbData !== 'undefined' && _rbData && _rbData.series) ? _rbData.series : null;
  if (!src) return;
  _ovbCodes().forEach(function (c) {
    if (!_bsBars[c] && src[c] && src[c].length) _bsBars[c] = src[c];
  });
}

// 今天 HYG 偏哪一邊。平盤或取不到時不歸到任一邊，改用全部日子，
// 門檻用「剛好為零」，不自己訂一個平盤區間。與債券那一頁同一個判定。
function _ovbDir() {
  var L = (typeof _bsHyg !== 'undefined' && _bsHyg) ? _bsHyg.last : null;
  if (!L || L.r == null || L.r === 0) return 0;
  return L.r > 0 ? 1 : -1;
}
function _ovbSel(dir) {
  if (dir === 0) return function () { return true; };
  if (dir > 0) return function (v) { return v != null && v > 0; };
  return function (v) { return v != null && v < 0; };
}

// 成交率的字級跟著數字本身走：高的粗、低的淡。不用紅綠，
// 那兩個色在這一站是漲跌，成交率不是漲跌。
//
// 亮的那一段跟掛價同一條線（OVB_HI）。兩邊用不同門檻的話，
// 會出現 54% 的價亮了、百分比卻還淡著的矛盾畫面。
function _ovbCls(v) {
  if (v == null) return 'ovb-na';
  return v > OVB_HI ? 'ovb-s3' : (v >= 30 ? 'ovb-s2' : 'ovb-s1');
}

// 前收那一欄有買賣兩根柱，取較高的那一根：只要其中一邊過半，這個價就值得先看。
function _ovbTop(main, pick, c) {
  if (c.side !== 'mid') return pick(main, c.side, c.k);
  var a = pick(main, 'buy', 0), b = pick(main, 'sell', 0);
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

// 這一檔的「前收」要配合現價的日期挑：日線最後一根可能就是今天（盤中那一根是未完成的），
// 拿它當基準會算出必定接近 0 的漲跌。所以取「早於現價那一天」的最後一根收盤。
// 這一框的「前收」。成交率的統計本身與它無關（每一天各自跟自己的前一日收盤比），
// 它只決定畫在柱子底下的那些價格要從哪裡往上下數。
//
// 不能直接拿日線最後一根的收盤：盤中資料來源會多出今天那一根未完成的 K，
// 於是整排掛價會錨在一個還在動的數字上，而標題卻寫著「前收」。
// 2026-11-18 實測：框頭寫前收 9.03（今天那根），現價算出來的前收是 9.05（昨天），
// 同一行出現兩個前收。所以有現價時一律取「早於現價那一天」的最後一根收盤。
function _ovbRef(code, fallback) {
  var lv = (typeof _ovLiveOf === 'function') ? _ovLiveOf(code) : null;
  if (!lv || !(lv.px > 0) || !lv.d) return { px: fallback, live: lv || null, why: '' };
  var bars = (typeof _bsBars !== 'undefined' && _bsBars) ? (_bsBars[code] || []) : [];
  for (var i = bars.length - 1; i >= 0; i--) {
    if (bars[i].c > 0 && bars[i].d < lv.d) return { px: bars[i].c, live: lv, why: '' };
  }
  return { px: fallback, live: lv, why: '找不到比現價更早的收盤，算不出漲跌' };
}
function _ovbPxTag(code, ref) {
  if (typeof _ovPxTagHtml !== 'function') return '';
  if (!ref.live || !(ref.live.px > 0)) {
    return _ovPxTagHtml(code, null, false, '券商快照取不到（本機連線未開）');
  }
  if (ref.why) return _ovPxTagHtml(code, null, false, ref.why);
  return _ovPxTagHtml(code, ref.px, true, '');
}

// ── 今天已經碰到哪幾個檔位 ──
//
// 柱子講的是「歷史上碰得到的機率」，這一排講的是「今天實際碰到哪裡」。
// 兩個合起來才知道現在該往下掛幾檔：柱子矮但今天已經碰到，代表今天走得比平常深；
// 柱子高但今天還沒碰到，代表今天比平常強，再等一下或者往上挪一檔。
//
// 判定很直接：日內最低只要跌到某個價，那個價以上的買進掛價今天全都觸及過了。
// 賣出那一側同理，用日內最高。價格一律換成「分」的整數再比，不留浮點數的容忍值，
// 跟成交率的統計同一個作法。
function _ovbToday(code) {
  var lv = (typeof _ovLiveOf === 'function') ? _ovLiveOf(code) : null;
  if (!lv) return null;
  var tw = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (lv.d && lv.d !== tw) return null;          // 不是今天的快照就不標
  if (!(lv.lo > 0) && !(lv.hi > 0)) return null;
  return { lo: (lv.lo > 0 ? lv.lo : null), hi: (lv.hi > 0 ? lv.hi : null), at: lv.at || '' };
}
// 一欄的標記。實心＝今天碰過，空心＝還沒，沒有今天的資料就整排不畫。
function _ovbHit(tdy, side, px) {
  if (!tdy) return null;
  if (side === 'sell') {
    if (!(tdy.hi > 0)) return null;
    return _bsCents(tdy.hi) >= _bsCents(px);
  }
  if (!(tdy.lo > 0)) return null;
  return _bsCents(tdy.lo) <= _bsCents(px);
}
function _ovbHitHtml(tdy, c, px) {
  if (!tdy) return '';
  var one2 = function (side, lb) {
    var v = _ovbHit(tdy, side, px);
    if (v == null) return '<span class="ovb-dot ovb-dot-na"></span>';
    var what = (side === 'sell' ? '日內最高 ' + _bsPx(tdy.hi) : '日內最低 ' + _bsPx(tdy.lo));
    return '<span class="ovb-dot' + (v ? ' ovb-dot-on' : '') + '" title="'
      + _bsPx(px) + '：今天' + (v ? '已經觸及過' : '還沒碰到') + '（' + what
      + (tdy.at ? '，' + tdy.at : '') + '）">' + (lb || '') + '</span>';
  };
  if (c.side === 'mid') return '<div class="ovb-hit">' + one2('buy') + one2('sell') + '</div>';
  return '<div class="ovb-hit">' + one2(c.side) + '</div>';
}

function _ovbCard(code) {
  if (typeof bsFill !== 'function') return '';
  var dir = _ovbDir(), sel = _ovbSel(dir);
  var all = function () { return true; };
  var main = bsFill(code, sel);
  var dn = bsFill(code, function (v) { return v != null && v < 0; });
  var up = bsFill(code, function (v) { return v != null && v > 0; });
  var full = bsFill(code, all);
  var r30 = bsFill(code, all, 30);
  var base = main || full || dn || up;

  var head = '<div class="ovb-card"><div class="ovb-head">'
    + '<span class="tx-ocode">' + code + '</span><span class="tx-oname">' + _rbName(code) + '</span>'
    + (_ovbHeld(code) ? ''
        : '<span class="ovb-wt" title="這一檔在關注清單裡，目前沒有持股。成交率的算法與持股的那幾檔完全相同。">關注</span>')
    + '</div>';

  if (!base) {
    return head + '<div class="ovb-thin">樣本不足 25 個交易日，算不出成交率。'
      + '這一檔要再累積一段時間才畫得出來。</div></div>';
  }

  var ref = _ovbRef(code, base.last);
  var tdy = _ovbToday(code);
  var tick = base.tick, last = ref.px;
  // 另一邊的方向：今天是跌就拿漲的那組當對照，反之亦然。
  // 兩邊都畫是為了看得到「萬一明天反過來，這個掛價變成多少」。
  var other = dir === 0 ? null : (dir < 0 ? up : dn);

  head += '<div class="ovb-head2">'
    + '<span class="ovb-h2k">前收</span><b>' + _bsPx(last) + '</b>'
    + '<span class="ovb-h2k">升降單位</span><b>' + tick.toFixed(2) + '</b>'
    + '<span class="ovb-h2k">樣本</span><b>' + base.n + ' 日</b>'
    + _ovbPxTag(code, ref)
    + '</div>';

  // ── 柱子。由便宜到貴，正中央是前收 ──
  var cells = [];
  for (var k = OVB_N; k >= 1; k--) cells.push({ side: 'buy', k: k });
  cells.push({ side: 'mid', k: 0 });
  for (var k2 = 1; k2 <= OVB_N; k2++) cells.push({ side: 'sell', k: k2 });

  var pick = function (z, side, k) {
    if (!z) return null;
    var arr = (side === 'sell') ? z.sell : z.buy;
    return (arr && arr[k] != null) ? arr[k] : null;
  };

  var h = head + '<div class="ovb-chart">';
  cells.forEach(function (c) {
    var px = _bsAlign(last + (c.side === 'sell' ? 1 : (c.side === 'buy' ? -1 : 0)) * c.k * tick);
    h += '<div class="ovb-col' + (c.side === 'mid' ? ' ovb-mid' : '') + '">';
    h += '<div class="ovb-plot">';
    var bars = (c.side === 'mid') ? [{ s: 'buy', lb: '買' }, { s: 'sell', lb: '賣' }]
                                  : [{ s: c.side, lb: '' }];
    bars.forEach(function (b) {
      var v = pick(main, b.s, c.k), o = pick(other, b.s, c.k), v30 = pick(r30, b.s, c.k);
      var hv = (v == null) ? 0 : Math.max(1, v / 100 * OVB_H);
      h += '<div class="ovb-slot">'
        // 對照那一組畫成空框，疊在同一個位置：高度直接比，不必在腦中換算
        + (o == null ? '' : '<div class="ovb-ghost" style="height:' + Math.max(1, o / 100 * OVB_H).toFixed(1)
            + 'px" title="' + (dir < 0 ? 'HYG 上漲' : 'HYG 下跌') + '的日子是 ' + o.toFixed(0) + '%"></div>')
        + '<div class="ovb-fill ovb-' + b.s + '" style="height:' + hv.toFixed(1) + 'px"'
        + ' title="' + _bsPx(px) + '：' + (b.s === 'sell' ? '賣出' : '買進') + '成交率 '
        + (v == null ? '樣本不足' : v.toFixed(0) + '%')
        + (dir === 0 ? '（今天 HYG 平盤或取不到，用全部日子）'
            : '（' + (dir < 0 ? 'HYG 下跌' : 'HYG 上漲') + '的 ' + base.n + ' 個日子）') + '"></div>'
        // 近 30 日畫成一條橫線：它回答「現在跟平常比是鬆是緊」，不是更準的那個數字
        + (v30 == null ? '' : '<div class="ovb-r30" style="bottom:' + (v30 / 100 * OVB_H).toFixed(1)
            + 'px" title="近 30 個交易日同一個掛價的實際成交率 ' + v30.toFixed(0) + '%'
            + (v == null ? '' : '，與左邊那根差 ' + (v30 - v > 0 ? '＋' : (v30 - v < 0 ? '−' : '±'))
               + Math.abs(v30 - v).toFixed(0) + ' 個百分點')
            + '。30 天的標準誤約 ±9 個百分點，不要拿它取代主數字。"></div>')
        + (b.lb ? '<span class="ovb-mlb">' + b.lb + '</span>' : '')
        + '</div>';
    });
    h += '</div>';
    // 前收那一欄畫了買賣兩根柱，數字就要兩個都印。只印買的那一個
    // 會讓人以為另一根沒有值，或者把賣的高度讀成買的數字。
    var rate1 = function (v) {
      return '<span class="' + _ovbCls(v) + '">' + (v == null ? '—' : v.toFixed(0) + '%') + '</span>';
    };
    h += '<div class="ovb-rate">'
      + (c.side === 'mid'
          ? rate1(pick(main, 'buy', 0)) + '<span class="ovb-sl">／</span>' + rate1(pick(main, 'sell', 0))
          : rate1(pick(main, c.side, c.k))) + '</div>'
      // 價格數字的亮度跟著成交率走：過半的亮、沒過半的淡。
      // 掃一整排的時候先看到的是「哪幾個價掛得到」，不必逐欄讀百分比。
      + '<div class="ovb-px' + (_ovbTop(main, pick, c) > OVB_HI ? ' ovb-pxhi' : '') + '">'
      + _bsPx(px) + '</div>'
      + '<div class="ovb-off">' + (c.k === 0 ? '前收' : (c.side === 'buy' ? '−' : '＋') + c.k + ' 檔') + '</div>'
      + _ovbHitHtml(tdy, c, px)
      + '</div>';
  });
  h += '</div>';

  h += '<div class="ovb-foot">'
    + (tdy ? '<span>今天 <b>'
        + (tdy.lo > 0 ? '最低 ' + _bsPx(tdy.lo) : '')
        + (tdy.lo > 0 && tdy.hi > 0 ? '　' : '')
        + (tdy.hi > 0 ? '最高 ' + _bsPx(tdy.hi) : '')
        + '</b>' + (tdy.at ? '<span class="ovb-at">' + tdy.at + '</span>' : '') + '</span>' : '')
    + '<span>資料到 <b>' + (base.lastD || '—') + '</b></span>'
    + '<span>HYG 跌／漲 <b>' + (dn ? dn.n : 0) + ' ／ ' + (up ? up.n : 0) + ' 日</b></span>'
    + '<span>近 30 日 <b>' + (r30 ? r30.n + ' 日' : '樣本不足') + '</b></span>'
    + '</div></div>';
  return h;
}

function ovcBondHtml() {
  if (typeof bsFill !== 'function') return '';
  _ovbFillBars();
  var codes = _ovbCodes();
  if (!codes.length) {
    return '<div class="modal-loading">持股與關注清單裡都沒有債券型 ETF（代號結尾 B 或 D），這個頁籤沒有標的。</div>';
  }
  if (typeof _bsHyg === 'undefined' || !_bsHyg) {
    return '<div class="modal-loading">HYG 日線取不到（代理服務無回應）。'
      + '<button class="btn-query" onclick="startRebound(true)">重試</button></div>';
  }
  var dir = _ovbDir(), L = _bsHyg.last;

  var h = '<div class="rb-sox">';
  h += '<div class="sec-title">夜推債券（掛在這個價，今天買得到的機率）</div>';
  h += '<div class="rb-sox-hd on">隔夜 HYG <b style="color:' + _rbCol(L ? L.r : null) + '">'
    + (L ? ((L.r > 0 ? '+' : '−') + Math.abs(L.r).toFixed(2) + '%') : '—') + '</b>'
    + '（' + (L ? L.d : '—') + '）　'
    + (dir === 0 ? '今天 HYG 平盤或取不到，柱子用全部日子算。'
        : '實心柱是' + (dir < 0 ? 'HYG 下跌' : 'HYG 上漲') + '的日子，也就是今天的方向；'
          + '空框是反方向的日子。') + '</div>';

  // ── 共用刻度。柱高固定 0 到 100%，所以框跟框之間可以直接比高度 ──
  h += '<div class="ovb-legend">'
    + '<span><em class="ovb-e1"></em>買進成交率（日內最低有沒有跌到掛價）</span>'
    + '<span><em class="ovb-e2"></em>賣出成交率（日內最高有沒有漲到）</span>'
    + '<span><em class="ovb-e3"></em>反方向的日子</span>'
    + '<span><em class="ovb-e4"></em>近 30 日</span>'
    + '<span><em class="ovb-e5"></em>今天已觸及</span>'
    + '<span><em class="ovb-e6"></em>今天還沒碰到</span>'
    + '<span class="ovb-note">柱高是 0 到 100%，所有框共用，框跟框之間可以直接比高度。'
    + '橫軸是掛價距前收幾個升降單位，左邊便宜、右邊貴。</span></div>';

  h += '<div class="ovb-grid">' + codes.map(_ovbCard).join('') + '</div>';

  h += '<div class="detail-note"><dl>'
    + '<dt>這一頁要回答什麼</dt><dd>「我掛在這個價，今天買得到的機率有多少。」'
    + '不預測漲跌，只數歷史上日內最低有沒有跌到掛價。'
    + '柱子上方的價格已經對齊升降單位，可以直接抄進委託單。'
    + '匯率曝險與完整的數字表格在債券那一頁，這裡不重複。'
    + '<br>這一頁收的是<b>持股加上關注清單</b>裡的債券型，標「關注」的那幾框目前沒有持股，'
    + '成交率的算法與持股的完全相同。債券那一頁維持只看持股，因為那一頁還有匯率曝險，'
    + '而曝險講的是你現在同時持有多大的美元部位，沒持有的標的放進去沒有意義。</dd>'

    + '<dt>各檔位的成交機率</dt><dd>'
    + '<b>定義</b>：把掛價設在前收上下 N 個升降單位，數歷史上有多少比例的日子碰得到。'
    + '買進看日內最低有沒有跌到掛價，賣出看日內最高有沒有漲到。'
    + '價格比大小一律換成「分」的整數再比，不留浮點數的容忍值。<br>'
    + '<b>比較基準</b>：兩個維度。一是同一檔的不同檔位（往左掛便宜，成交率一路降），'
    + '二是同一檔位的兩種隔夜情境（實心柱對空框）。'
    + '柱高的刻度所有框共用，所以也可以跨檔比。<br>'
    + '<b>白話意義</b>：柱子越高，這個價位今天碰得到的機會越大。'
    + '往左每多掛一檔，每張成本少 0.01 元，但買不到的機會跟著上升。<br>'
    + '<b>機制</b>：HYG 是美國非投等債 ETF，與這幾檔持有的是同一類信用資產。'
    + '隔夜 HYG 下跌代表信用價差走闊，隔天台股這幾檔開盤的賣壓較大，'
    + '日內最低因此更容易往下觸及掛價，買進成交率上升；HYG 上漲則反過來。'
    + '實測 HYG 在夜盤與費半之上的增量 F 是 23.6 到 42.7（門檻 3.95），'
    + '而股票那九檔全部不到 3.95，所以這個訊號是債券專屬的，不是撈出來的。'
    + '斜率的正負在前後兩段各自配適都一致（t 值 2.9 到 5.8）。<br>'
    + '<b>行動含義</b>：決定往下掛幾檔。每往左一檔換到 0.01 元的成本，'
    + '代價是柱子矮掉的那一截就是買不到的機會。<br>'
    + '<b>不能告訴你什麼</b>：成交率不含方向。柱子高代表碰得到，不代表買了划算，'
    + '它同樣可能是因為今天一路下跌。也不保證成交順序：掛在同一價位的委託'
    + '照時間排隊，日內最低只碰到一次的那種日子不一定輪得到你。'
    + '要判斷划不划算得看別的東西，這一頁不回答。</dd>'

    + '<dt>掛價的亮度</dt><dd>成交率過半（超過 50%）的掛價，價格數字是亮白的，'
    + '其餘的壓暗。50% 不是統計算出來的門檻，就是「碰得到的日子比碰不到的多」這條線。'
    + '<br>百分比那一行跟價格同一條線：過半的亮白，三成到五成的中間色，不到三成的壓暗。'
    + '<br>前收那一欄有買賣兩根柱，只要其中一邊過半就算亮。'
    + '<br>不能告訴你什麼：亮只代表掛得到，不代表該掛。往左每多掛一檔成本少 0.01 元，'
    + '最亮的那幾個通常是最靠近前收、也最貴的那幾個。</dd>'

    + '<dt>今天碰到哪裡</dt><dd>每一欄最底下那顆圓點。實心代表今天的日內最低（賣出那半邊是最高）'
    + '已經走到這個價，空心代表還沒。沒有今天的即時快照時整排不畫，不會拿昨天的高低充數。'
    + '<br>它跟柱子是兩件事：<b>柱子是歷史上碰得到的機率，圓點是今天實際碰到哪裡。</b>'
    + '柱子矮但今天已經碰到，代表今天走得比平常深；柱子高但今天還沒碰到，'
    + '代表今天比平常強，再等一下或者往上挪一檔。'
    + '<br>不能告訴你的是「還會不會再碰一次」。已經觸及過不代表你掛得到：'
    + '同一價位的委託照時間排隊，日內最低只掃到一次的那種日子不一定輪得到你。</dd>'
    + '<dt>近 30 日那一條橫線</dt><dd>同一個掛價在最近 30 個交易日的實際成交率，'
    + '回答的是「現在跟平常比是鬆還是緊」，不拆 HYG 方向。'
    + '<b>它不是更準的那個數字</b>：30 天的標準誤約 ±9 個百分點，'
    + '全期是 ±2 到 ±4。實測拿近 30 日去預測接下來 20 天，四檔裡有三檔比用全期還差。'
    + '兩個並列是讓你看差距，不是讓你換掉主數字。</dd>'
    + '</dl></div>';

  return h + '</div>';
}
