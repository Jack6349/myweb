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

// ── HYG 敏感度 ──
//
// 這一檔對 HYG 方向有多敏感：把五個檔位的「HYG 下跌那天的成交率 − 上漲那天的」
// 平均起來，單位是百分點。買賣各算一條，因為兩側的敏感度不一樣。
//
// 為什麼用差距不用比值：你要判斷的是「今天 HYG 的方向會不會改變我掛幾檔」，
// 那是差距的問題。比值會騙人 —— 55% 對 45% 切出來是 55:45 看起來只是微偏，
// 實際差 10 個百分點；5% 對 3% 切出來是 62:38 看起來偏很多，實際只差 2 個百分點。
// 2026-11-19 實測同一組資料：比值版 00981B 是 58:42、00982D 是 68:32，看起來差不多；
// 差距版是 11.8 對 27.9，一眼分得出 2.4 倍。
//
// 實測五檔債券的買側平均差：00982D 27.9、00990B 21.3、00984D 20.7、00989B 12.4、00981B 11.8。
// 賣側全是負的（−16.1 到 −23.3），代表 HYG 上漲的日子比較賣得掉。
// 沒有一檔是不敏感的，最低也有 11.8 個百分點，所以這條線讀的是相對強弱，不是有沒有。
var _ovbSensMemo = {}, _ovbSensKey = '', OVB_SENS_MIN = 30;
function _ovbSens(code) {
  if (_ovbSensMemo[code] !== undefined) return _ovbSensMemo[code];
  var r = null;
  try {
    var dn = bsFill(code, function (v) { return v != null && v < 0; });
    var up = bsFill(code, function (v) { return v != null && v > 0; });
    if (dn && up) {
      var gb = [], gs = [];
      for (var k = 1; k <= OVB_N; k++) {
        if (dn.buy[k] != null && up.buy[k] != null) gb.push(dn.buy[k] - up.buy[k]);
        if (dn.sell[k] != null && up.sell[k] != null) gs.push(dn.sell[k] - up.sell[k]);
      }
      var avg = function (a) {
        return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null;
      };
      r = { buy: avg(gb), sell: avg(gs), n: Math.min(dn.n, up.n) };
    }
  } catch (e) { hush('ovbond', e); }
  _ovbSensMemo[code] = r;
  return r;
}
// 滿刻度取自資料，不自己訂：所有標的裡最大的那個絕對值往上取到 5 的倍數，
// 下限 30（2026-11-19 實測最大是 27.9）。有標的超過就自己撐大，不截掉。
function _ovbSensScale(codes) {
  var m = 0;
  codes.forEach(function (c) {
    var s = _ovbSens(c);
    if (!s) return;
    if (s.buy != null) m = Math.max(m, Math.abs(s.buy));
    if (s.sell != null) m = Math.max(m, Math.abs(s.sell));
  });
  return Math.max(OVB_SENS_MIN, Math.ceil(m / 5) * 5);
}
var _ovbScale = OVB_SENS_MIN;
// 一條：長度是敏感度佔滿刻度的比例，顏色沿用圖上的買金賣藍。
// 數字帶正負號，因為方向本身有意義（正＝HYG 跌的日子比較買得到）。
function _ovbSensBar(side, v, scale) {
  var lb = (side === 'buy') ? '買' : '賣';
  if (v == null) {
    return '<span class="ovb-sg"><span class="ovb-sk">' + lb + '</span>'
      + '<span class="ovb-strack"></span><b class="ovb-sna">—</b></span>';
  }
  var w = Math.min(100, Math.abs(v) / scale * 100);
  return '<span class="ovb-sg"><span class="ovb-sk">' + lb + '</span>'
    + '<span class="ovb-strack"><em class="ovb-sfill ovb-' + side + '" style="width:'
    + w.toFixed(1) + '%"></em></span>'
    + '<b>' + (v > 0 ? '＋' : (v < 0 ? '−' : '±')) + Math.abs(v).toFixed(0) + '</b></span>';
}

// 外框數字擺哪裡。
//
// 一組柱子只有 36px 寬、兩個標籤各 23px，並排一定疊，所以不能兩個都靠同一邊。
// 規則很簡單：柱頭那個數字站哪一邊，外框數字就站另一邊。
// 柱頭數字永遠貼著「不是今天那一根」的左緣：今天是漲就標左邊的跌、今天是跌就標右邊的漲。
// 外框比柱子左右各寬 7px，所以兩邊各 23px 的標籤剛好讓得開。
//
// HYG 平盤那天兩根都有柱頭數字，沒有空邊可站，只好往上讓一行。
// 框太矮（不到 22px）塞不下數字，一律改放框的正上方。
function _ovbLabPos(hp, dir) {
  var up = (hp < 22) ? ' ovb-up' : '';
  if (dir === 0) return up + ' ovb-right';   // 平盤那天沒有柱頭數字，不用讓
  // 今天是漲 → 柱頭數字在左邊那根 → 外框數字靠右；今天是跌則相反
  return up + (dir > 0 ? ' ovb-right' : ' ovb-left');
}

// ── 前收，以及現價漲跌的基準 ──
//
// 兩者不是同一個數字，這是 2026-11-19 實測出來的。
//
// 前收 ＝ 掛價階梯要往上下數的那個起點，也就是「下一盤開始前，最後一個收完的收盤」。
//   舊規則是「取早於現價那一天的最後一根收盤」。盤中是對的：日線最後一根是今天
//   還沒收完的那一根，拿它當前收會變成錨在一個還在動的數字上。
//   但收盤之後就錯一天 —— 今天已經收完了，它就是下一盤的前收，規則卻還是往前跳一天。
//   2026-11-19 實測：美股已收、台股 11/18 也收完了，框頭卻還寫 11/17 的收盤。
//   改成「最後一個收完的交易日」，盤中算昨天、收盤後算今天，一條規則兩種時段都對。
//
// 漲跌的基準 ＝ 快照那個價自己的前一個收盤。這一個仍然要往前跳一天，
//   否則收盤後快照就是今天的收盤，拿今天比今天，漲跌必定是 0。
//
// 成交率的統計與這兩個都無關：每一天各自跟自己的前一日收盤比。
function _ovbRef(code, fallback) {
  var lv = (typeof _ovLiveOf === 'function') ? _ovLiveOf(code) : null;
  var bars = (typeof _bsBars !== 'undefined' && _bsBars) ? (_bsBars[code] || []) : [];
  var before = function (d) {
    for (var i = bars.length - 1; i >= 0; i--) if (bars[i].c > 0 && bars[i].d < d) return bars[i];
    return null;
  };
  var upto = function (d) {
    for (var i = bars.length - 1; i >= 0; i--) if (bars[i].c > 0 && bars[i].d <= d) return bars[i];
    return null;
  };
  var need = (typeof _rbNeedDay === 'function') ? _rbNeedDay() : '';
  var anchor = need ? upto(need) : null;
  // 沒有辦公日曆或資料不夠新時退回舊規則，至少不會比以前差
  if (!anchor && lv && lv.d) anchor = before(lv.d);
  var pb = (lv && lv.d) ? before(lv.d) : null;
  return {
    px: anchor ? anchor.c : fallback,
    d: anchor ? anchor.d : '',
    live: lv || null,
    pxBase: pb ? pb.c : null,
    why: (lv && lv.px > 0 && !pb) ? '找不到比現價更早的收盤，算不出漲跌' : ''
  };
}
function _ovbPxTag(code, ref) {
  if (typeof _ovPxTagHtml !== 'function') return '';
  if (!ref.live || !(ref.live.px > 0)) {
    return _ovPxTagHtml(code, null, false, '券商快照取不到（本機連線未開）');
  }
  if (ref.why || !(ref.pxBase > 0)) {
    return _ovPxTagHtml(code, null, false, ref.why || '找不到比現價更早的收盤，算不出漲跌');
  }
  // 漲跌用快照自己的前一個收盤，不是框頭那個前收：收盤後兩者差一天
  return _ovPxTagHtml(code, ref.pxBase, true, '');
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

  // 代號下面那一條：這一檔對 HYG 有多敏感。
  //
  // 放在這裡而不是每張框換框線顏色：HYG 今天漲或跌是整頁共用的一個數字，
  // 每張框都標等於同一件事印十幾次，而且框跟框之間比不出任何東西。
  // 敏感度才是每一檔各自不同、而且會改變「今天要不要細看這一檔」的東西。
  var sens = _ovbSens(code);
  head += '<div class="ovb-sens"><span class="ovb-sk ovb-sk1" title="'
    + '五個檔位的「HYG 下跌那天的成交率 − 上漲那天的」平均，單位是百分點。'
    + '數字越大代表今天 HYG 往哪邊走越會改變你該掛幾檔。'
    + '滿刻度 ' + _ovbScale + ' 個百分點，取自所有標的裡最大的那一個。'
    + (sens && sens.n ? '&#10;樣本 ' + sens.n + ' 天（取跌漲兩邊較少的那一邊）。' : '')
    + '">HYG 敏感度</span>'
    + _ovbSensBar('buy', sens ? sens.buy : null, _ovbScale)
    + _ovbSensBar('sell', sens ? sens.sell : null, _ovbScale)
    + '</div>';

  // 框頭右端排兩行，與夜推股票一致。分行照「講的是同一件事」分：
  // 前收與現價同一行（現價的漲跌就是對前收算的，拆開就看不出兩個數字的關係），
  // 升降單位與樣本同一行（這兩個是算成交率的前提，不是今天的價）。
  head += '<div class="ovb-head2">'
    + '<span class="ovb-h2r">'
    + '<span class="ovb-h2k" title="' + (ref.d ? ref.d + ' 的收盤。' : '')
    + '這是下一盤開始前最後一個收完的收盤，掛價階梯從它往上下數。'
    + '盤中是昨天的收盤，收盤之後換成今天的。">前收</span><b'
    + (ref.d ? ' title="' + ref.d + '"' : '') + '>' + _bsPx(last) + '</b>'
    + _ovbPxTag(code, ref)
    + '</span>'
    + '<span class="ovb-h2r">'
    + '<span class="ovb-h2k">升降單位</span><b>' + tick.toFixed(2) + '</b>'
    + '<span class="ovb-h2k">樣本</span><b>' + base.n + ' 日</b>'
    + '</span>'
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

  // ── 一組柱子：跌在左、漲在右，位置固定 ──
  //
  // 舊版把另一種情境畫成空框疊在同一個位置，兩個高度疊在一起看不出誰高誰低，
  // 而「兩種情境差多少」正是 HYG 這個訊號的全部內容（增量 F 23.6 到 42.7）。
  // 改成並排之後，買側跌的那根比漲的高、賣側反過來，這個反轉一眼就看得到。
  //
  // 今天那一邊實心滿色、數字印在下方那一行；另一邊同色系的深色、數字壓在它自己柱頭上。
  // 不用紅綠分跌漲：紅綠在這一頁是價格漲跌，拿來標 HYG 方向會打架。
  // HYG 平盤或取不到時兩根都不加亮，下方那一行是用全部日子算的。
  // flat＝HYG 平盤或取不到。兩根都不是「今天」，所以都壓暗、都不加柱頭數字
  // （一組只有 36px 寬，兩個數字一定疊），數值看提示，下方那一行是用全部日子算的。
  var bar1 = function (side, v, isToday, flat, isLeft, lab) {
    var hv = (v == null) ? 0 : Math.max(1, v / 100 * OVB_H);
    // 數字要包在柱子裡面。放在外面的話它會定位到整個柱子區的頂端，
    // 變成一排高度一致的數字，跟它要標的那根柱完全脫鉤。
    return '<div class="ovb-fill ovb-' + side + (isToday ? '' : ' ovb-dim')
      + '" style="height:' + hv.toFixed(1) + 'px"'
      + ' title="' + lab + (side === 'sell' ? '賣出' : '買進') + '成交率 '
      + (v == null ? '樣本不足' : v.toFixed(0) + '%') + '">'
      + (isToday || flat || v == null ? ''
          : '<span class="ovb-top ovb-top-' + (isLeft ? 'l' : 'r') + '">' + v.toFixed(0) + '%</span>')
      + '</div>';
  };
  // 近 30 日：從底線框到它自己的高度，橫跨一組柱子。
  // 它不分跌漲，一組只有一個數字，所以不能畫在任何一根柱子上。
  // 暗色，因為它是參考值不是主角；淺青留給「今天已觸及」那幾個標記。
  var frame1 = function (v30, vToday) {
    if (v30 == null) return '';
    var hp = v30 / 100 * OVB_H;
    return '<div class="ovb-r30b" style="height:' + hp.toFixed(1) + 'px" title="'
      + '近 30 個交易日同一個掛價的實際成交率 ' + v30.toFixed(0) + '%'
      + (vToday == null ? '' : '，與今天這一邊差 ' + (v30 - vToday > 0 ? '＋' : (v30 - vToday < 0 ? '−' : '±'))
         + Math.abs(v30 - vToday).toFixed(0) + ' 個百分點')
      + '。30 天的標準誤約 ±9 個百分點，不要拿它取代主數字。">'
      + '<span class="ovb-r30lab' + _ovbLabPos(hp, dir) + '">' + v30.toFixed(0) + '%</span></div>';
  };

  // ── 過半的那一段：掛價上面一條細 Bar ──
  //
  // 掛價那一行已經把過半的打亮，但那要你注意到哪幾個是亮的。
  // 這一條把「能掛到的範圍有多寬」變成一個長度，用餘光就讀得到。
  //
  // 買賣各一條，在前收分界：左半邊是「掛這個價買得到」、右半邊是「掛這個價賣得掉」，
  // 兩個不同的動作。一條連續的 Bar 會被讀成一個區間，那是錯的。
  //
  // 不連續就不連起來。過半的欄位不保證相鄰，樣本少的時候可能出現 55、48、52，
  // 畫成一整條等於憑空宣稱中間那一檔也過半。斷開本身就是資訊。
  //
  // 顏色沿用柱子的買金賣藍，不用橘：橘色在這個專案是警示色（夜推股票的「超出刻度」），
  // 拿來標一件好事會把它的意思弄反。
  var onOf = function (c, side) {
    var v = pick(main, side, c.k);
    return v != null && v > OVB_HI;
  };
  var segs = [];                       // 依畫面順序：買側每欄一格、前收兩格、賣側每欄一格
  cells.forEach(function (c) {
    if (c.side === 'mid') {
      segs.push({ side: 'buy', on: onOf(c, 'buy'), half: 'l' });
      segs.push({ side: 'sell', on: onOf(c, 'sell'), half: 'r' });
    } else {
      segs.push({ side: c.side, on: onOf(c, c.side) });
    }
  });
  // 跟左右鄰居接不接得上。只有同一側、而且兩邊都過半才接，所以前收那裡不會跨側黏起來。
  segs.forEach(function (s, i) {
    var L = segs[i - 1], R = segs[i + 1];
    s.jl = !!(s.on && L && L.on && L.side === s.side);
    s.jr = !!(s.on && R && R.on && R.side === s.side);
  });
  var si = 0;
  var rngCell = function (c) {
    var inner = function (s) {
      if (!s.on) return '<span class="ovb-rseg"></span>';
      return '<span class="ovb-rseg ovb-ron ovb-' + s.side
        + (s.jl ? ' ovb-jl' : '') + (s.jr ? ' ovb-jr' : '') + '"></span>';
    };
    if (c.side === 'mid') {
      var a = segs[si++], b = segs[si++];
      return '<div class="ovb-rng ovb-rng2">' + inner(a) + inner(b) + '</div>';
    }
    return '<div class="ovb-rng">' + inner(segs[si++]) + '</div>';
  };
  // ── 兩條 Bar 底下各自標名 ──
  //
  // 原本兩條在前收對接，中間只隔 3px，看起來像一把連續的尺被切成兩半，
  // 於是會被讀成「買價只能在前收左邊、賣價只能在右邊」。那是錯的讀法：
  // 這一頁問的不是價格會走到哪，是「掛在這個價會不會成交」，
  // 而買進成交率對價格單調遞增，掛得比前收高只會更容易買到。
  //
  // 前收另一側不畫，是因為那一側的答案一律是會成交（實測見說明），
  // 不是因為那一側不能掛。缺口拉開加上標名，就是把這件事畫進形狀裡，
  // 不必點開說明才知道是兩個動作。
  //
  // 標在每一欄都留一列（非前收欄是空的），不然這一列只有中間那一欄有東西，
  // 底下的價格那一排會差一個行高對不齊。
  var lblCell = function (c) {
    if (c.side !== 'mid') return '<div class="ovb-rlb"></div>';
    return '<div class="ovb-rlb ovb-rlb2">'
      + '<span class="ovb-lb-buy">買得到的價</span>'
      + '<span class="ovb-lb-sell">賣得掉的價</span></div>';
  };

  var h = head + '<div class="ovb-chart">';
  cells.forEach(function (c) {
    var px = _bsAlign(last + (c.side === 'sell' ? 1 : (c.side === 'buy' ? -1 : 0)) * c.k * tick);
    h += '<div class="ovb-col' + (c.side === 'mid' ? ' ovb-mid' : '') + '">';
    h += '<div class="ovb-plot">';
    var bars = (c.side === 'mid') ? [{ s: 'buy', lb: '買' }, { s: 'sell', lb: '賣' }]
                                  : [{ s: c.side, lb: '' }];
    bars.forEach(function (b) {
      var vDn = pick(dn, b.s, c.k), vUp = pick(up, b.s, c.k), v30 = pick(r30, b.s, c.k);
      var sfx = '（' + base.n + ' 個日子）';
        h += '<div class="ovb-grp">'
        + bar1(b.s, vDn, dir < 0, dir === 0, true, _bsPx(px) + '　HYG 下跌的日子：')
        + bar1(b.s, vUp, dir > 0, dir === 0, false, _bsPx(px) + '　HYG 上漲的日子：')
        + frame1(v30, pick(main, b.s, c.k))
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
      + rngCell(c)
      + lblCell(c)
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
    // 三個樣本天數是整頁共用的，搬到圖例寫一次就好。
    // 每一框印一次是重複，而且「近 30 日 30 日」那種標籤跟值重複的寫法本來就讀不通。
    // 每框真正要知道的只有「今天走哪一邊」。
    + '<span>今天 HYG <b>' + (dir === 0 ? '平盤或取不到' : (dir < 0 ? '下跌' : '上漲')) + '</b></span>'
    + (r30 ? '' : '<span>近 30 日<b>樣本不足</b></span>')
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
    + (dir === 0 ? '今天 HYG 平盤或取不到，沒有「今天那一邊」，兩根柱都壓暗且不標數字（滑過可看），'
        + '下方那一行是用全部日子算的。左邊仍然是跌、右邊是漲。'
        : '每一欄兩根柱：左邊是 HYG 下跌的日子、右邊是上漲的。'
          + '今天是' + (dir < 0 ? '下跌' : '上漲') + '，所以'
          + (dir < 0 ? '左' : '右') + '那根滿色、數字印在下方；'
          + '另一根深色、數字壓在它自己柱頭上。') + '</div>';

  // ── 共用刻度。柱高固定 0 到 100%，所以框跟框之間可以直接比高度 ──
  var _dnN = 0, _upN = 0, _r30N = 0;
  (function () {
    var any = _ovbCodes()[0];
    if (!any) return;
    try {
      var a = bsFill(any, function (v) { return v != null && v < 0; });
      var b = bsFill(any, function (v) { return v != null && v > 0; });
      var c3 = bsFill(any, function () { return true; }, 30);
      _dnN = a ? a.n : 0; _upN = b ? b.n : 0; _r30N = c3 ? c3.n : 0;
    } catch (e) { hush('ovbond', e); }
  })();
  h += '<div class="ovb-legend">'
    + '<span><em class="ovb-e1"></em>買進成交率（日內最低有沒有跌到掛價）</span>'
    + '<span><em class="ovb-e2"></em>賣出成交率（日內最高有沒有漲到）</span>'
    + '<span><em class="ovb-e3"></em>反方向情境（深色那根，數字壓在它自己柱頭上）</span>'
    + '<span><em class="ovb-e4"></em>近 30 個交易日實際成交率</span>'
    + '<span><em class="ovb-e5"></em>今天已觸及</span>'
    + '<span><em class="ovb-e6"></em>今天還沒碰到</span>'
    + '</div>'
    + '<div class="ovb-legend ovb-leg2">'
    + '<span>樣本　HYG 上漲 <b>' + _upN + ' 天</b>　HYG 下跌 <b>' + _dnN + ' 天</b>'
    + '　近 30 日 <b>' + _r30N + ' 天</b></span>'
    + '<span class="ovb-note">柱高是 0 到 100%，所有框共用，框跟框之間可以直接比高度。'
    + '橫軸是掛價距前收幾個升降單位，左邊便宜、右邊貴。'
    + '</span></div>';

  // 滿刻度全頁共用，框跟框之間才比得動長度。算完才畫卡片。
  // 快取跟著 HYG 與日線一起失效（重新篩選時 _bsBars 會被清掉）。
  var sk = codes.join(',') + '|' + Object.keys(_bsBars || {}).length;
  if (_ovbSensKey !== sk) { _ovbSensMemo = {}; _ovbSensKey = sk; }
  _ovbScale = _ovbSensScale(codes);

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
    + '二是同一檔位的兩種隔夜情境（並排的兩根柱）。'
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

    + '<dt>過半的那一段</dt><dd>成交率過半（超過 50%）的掛價，價格數字是亮白的，'
    + '其餘的壓暗，而且掛價上面會多一條細 Bar 把連續過半的那一段橫起來。'
    + '數字要逐欄讀，Bar 把「能掛到的範圍有多寬」變成一個長度，用餘光就讀得到。'
    + '<br><b>買賣各一條，在前收分界</b>：左半邊是「掛這個價買得到」、'
    + '右半邊是「掛這個價賣得掉」，兩個不同的動作，一條連續的 Bar 會被讀成一個區間。'
    + '不連續就不連起來：過半的欄位不保證相鄰，斷開本身就是資訊。'
    + '<br><b>前收另一側為什麼不畫</b>：不是因為那一側不能掛。'
    + '買進成交率對價格是單調遞增的，掛得比前收高只會更容易買到，賣出在前收下方同理。'
    + '把階梯往兩邊各延伸五檔實測（五檔債券，HYG 漲跌各一組，共 150 個格子）：'
    + '沒有一格低於五成。前收上方的買進成交率最低 79%（00982D，HYG 上漲的日子，+1 檔），'
    + '前收下方的賣出成交率最低 76%（00982D，HYG 下跌的日子，−1 檔），再往外很快就到 95% 以上。'
    + '那一側的答案一律是會成交，畫出來不會改變任何決定，所以版面留給要決定的這一側。'
    + '<br>HYG 上漲確實讓買變難，而且幅度不小：00984D 掛在前收，'
    + 'HYG 下跌的日子 93%、上漲的日子 75%，差 18 個百分點；00982D 是 83% 掉到 68%。'
    + '但難到的程度沒有把過半的界線推過前收。HYG 上漲時往上跑的是追價會付出的價格，'
    + '不是要掛多高才買得到，而這一頁只回答後者。'
    + '<br>50% 不是統計算出來的門檻，就是「碰得到的日子比碰不到的多」這條線。'
    + '<br>百分比那一行跟價格同一條線：過半的亮白，三成到五成的中間色，不到三成的壓暗。'
    + '<br>前收那一欄有買賣兩根柱，只要其中一邊過半就算亮。'
    + '<br>不能告訴你什麼：過半不是保證，Bar 畫成一條實心的會看起來像一個穩固的區域，'
    + '實際上它只說「碰得到的日子比較多」。同一價位的委託照時間排隊，碰過不代表輪得到你。'
    + '亮也只代表掛得到，不代表該掛。往左每多掛一檔成本少 0.01 元，'
    + '最亮的那幾個通常是最靠近前收、也最貴的那幾個。</dd>'

    + '<dt>今天碰到哪裡</dt><dd>每一欄最底下那顆圓點。實心代表今天的日內最低（賣出那半邊是最高）'
    + '已經走到這個價，空心代表還沒。沒有今天的即時快照時整排不畫，不會拿昨天的高低充數。'
    + '<br>它跟柱子是兩件事：<b>柱子是歷史上碰得到的機率，圓點是今天實際碰到哪裡。</b>'
    + '柱子矮但今天已經碰到，代表今天走得比平常深；柱子高但今天還沒碰到，'
    + '代表今天比平常強，再等一下或者往上挪一檔。'
    + '<br>不能告訴你的是「還會不會再碰一次」。已經觸及過不代表你掛得到：'
    + '同一價位的委託照時間排隊，日內最低只掃到一次的那種日子不一定輪得到你。</dd>'
    + '<dt>HYG 敏感度</dt><dd><b>定義</b>：代號下面那兩條。把五個檔位的「HYG 下跌那天的成交率 − 上漲那天的」'
    + '平均起來，單位是百分點。買賣各算一條，兩側不一樣。'
    + '條子長度是它佔滿刻度的比例，滿刻度 ' + _ovbScale + ' 個百分點。<br>'
    + '<b>比較基準</b>：跟其他標的比。滿刻度取自所有標的裡最大的那一個，'
    + '不是我訂的數字；有標的超過滿刻度會自己撐大。'
    + '2026-11-19 實測五檔債券的買側平均差：00982D 27.9、00990B 21.3、00984D 20.7、'
    + '00989B 12.4、00981B 11.8。<br>'
    + '<b>白話意義</b>：條子越長，今天 HYG 往哪邊走越會改變你該掘幾檔。'
    + '條子短的那幾檔，今天 HYG 怎麼走都差不多，照平常掘就行。<br>'
    + '<b>機制</b>：HYG 是美國非投等債 ETF，跟這幾檔持有的是同一類信用資產。'
    + '隔夜 HYG 下跌代表信用價差走闊，隔天開盤賣壓較大，日內最低更容易往下觸及掛價，'
    + '所以買進成交率上升；賣出那一側反過來。'
    + '敏感度大小取決於該檔的持股跟美國非投等債重疊得多深，以及它自己的流動性。<br>'
    + '<b>行動含意</b>：今天該先細看哪幾檔。條子長的，今天 HYG 的方向值得拿來調掛價；'
    + '條子短的不必為了 HYG 改計畫。<br>'
    + '<b>不能告訴你什麼</b>：實測下來沒有一檔是不敏感的，最低也有 11.8 個百分點，'
    + '所以這條線讀的是<b>相對強弱</b>，不是有沒有。'
    + '它也不說今天該不該買：那要配上殖利率與成本，這一頁不回答。'
    + '方向目前五檔一致（跌有利買、漲有利賣），哪天出現反向的條子會自己翻過來，'
    + '但圖上只有長度，方向要看數字的正負號。</dd>'
    + '<dt>近 30 日那個暗色外框</dt><dd>同一個掛價在最近 30 個交易日的實際成交率，'
    + '從底線框到它自己的高度，柱子從框裡穿出來，誰高誰低不用對高度就看得出來。'
    + '框橫跨「一組」柱子而不是單一一根：它不拆 HYG 方向，一組只有一個數字。'
    + '前收那一欄有買、賣兩組，所以有兩個框。'
    + '框與字都是暗色：它是參考值，柱子的金藍才是主角。'
    + '<b>它不是更準的那個數字</b>：30 天的標準誤約 ±9 個百分點，'
    + '全期是 ±2 到 ±4。實測拿近 30 日去預測接下來 20 天，四檔裡有三檔比用全期還差。'
    + '兩個並列是讓你看差距，不是讓你換掉主數字。</dd>'
    + '</dl></div>';

  return h + '</div>';
}
