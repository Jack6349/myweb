// 股利總管 Web — 夜推股票（進場訊號板的第四個頁籤）
//
// 跟「隔夜推估」那一頁同一組推估，不同的讀法。表格是一列一檔、一欄一個數字，
// 要比對兩欄才知道「現在的價離上緣還有多遠」。這一頁把同一組數字畫在一條
// 價格軸上，那段距離變成看得到的長度，不用讀數字。
//
// 推估引擎完全沿用 overnight.js 的 ovEstimate，這裡只負責畫。
// 兩頁同時存在是刻意的：表格適合精確比對與排序，這一頁適合掃一眼。
//
// ── 橫軸為什麼所有框共用 ──
//
// 一框一檔、各畫各的軸的話，框裡看起來一樣寬的區間，實際寬度可以差三倍，
// 而「這一檔的推估比別檔沒把握」正是要看出來的事。所以軸是共用的，
// 單位是對前收的漲跌幅，框跟框之間可以直接比長度。
//
// 軸寬不寫死。寫死 ±3% 的時候實測 00929 的收盤上限是 +3.46%，被切在邊上，
// 而區間最寬的那一檔正好是最需要看清楚的。改成取當天所有框用到的最大偏離，
// 外加一成餘裕再往上湊到 0.5 的整數倍。
//
// ── 標記為什麼分上下兩排 ──
//
// 六個標記全擠在橫條下方時，價位相近的兩個數字會疊在一起。先分成兩組：
// 上限、下限、前收是今天不會再變的框架，放上方；掛買、估收、現價是今天
// 走到哪，放下方。一側三個，重疊機率比六個擠在一起低得多。
// 同一側兩個還是靠太近時，後面那個掉到第二行，引線拉長指回自己的標記。

var OVC_SORT_LS = 'ovcard_sort_v1';
// 同一行兩個標籤的最小水平間距，換算成軸長的百分比。標籤本身是固定的 66px，
// 所以這個百分比要跟著橫條的像素寬走：框寬下限 800 時橫條約 752px，66px 等於 8.8%，
// 取 10 留一點餘裕。設太大的代價不是排版壞掉，是標籤被無謂地推到第二、第三行，
// 框白白變高。一行四框（橫條 292px）時這個值要 23，兩者差很多。
var OVC_GAP = 12;   // 字放大之後標籤從 66px 變 84px，門檻跟著從 10 提到 12
var OVC_LABW = 66;

function _ovcSort() {
  try { var v = localStorage.getItem(OVC_SORT_LS); if (v) return v; } catch (e) {}
  return 'lPx';
}
function ovcSort(k) {
  try { localStorage.setItem(OVC_SORT_LS, k); } catch (e) {}
  if (typeof rbRender === 'function') rbRender();
}

// 這一頁只收股票型。債券另外一個頁籤，兩者的橫軸意義不同，混在一起不能比。
function _ovcIsBond(code) { return /^00\d+[BD]$/.test(String(code)); }

// 有沒有持股。排序的第一順位，因為兩種框要做的事不一樣：
// 持有的是「今天要不要加碼、掛在哪」，關注的是「還沒進場，看看掛得到嗎」。
// 兩種混在一起由價格排，眼睛每掃幾框就要重新判斷一次這框屬於哪一種。
function _ovcHeld(code) {
  var m = (typeof _sharesMap !== 'undefined' && _sharesMap) || {};
  return !!(m[String(code)] > 0);
}

// 現價快照。要跟推估的是同一盤，日期對不上就不顯示，寧可少一個標記
// 也不要把別的交易日的價畫在今天的軸上。
function _ovcLive(code, t) {
  var lv = (typeof _ovLive !== 'undefined' && _ovLive) ? _ovLive[String(code)] : null;
  if (!lv || !(lv.px > 0)) return null;
  if (t && t.d && lv.d && lv.d !== t.d) return null;
  return lv;
}

// 軸寬由當天的資料決定
// 這一框自己用到的最大偏離（百分點）
function _ovcSpan(r) {
  var m = 0;
  [r.loPx, r.hiPx, r.lLoPx, r.lHiPx, r.lPx, r.cPx, r.oPx, r.live].forEach(function (v) {
    if (v > 0 && r.base > 0) m = Math.max(m, Math.abs((v / r.base - 1) * 100));
  });
  if (r.act) {
    [r.act.cPct, r.act.lPct].forEach(function (v) { if (v != null) m = Math.max(m, Math.abs(v)); });
  }
  return m;
}

// ── 軸寬取第 80 百分位，不取最大值 ──
//
// 取最大值的話，只要清單裡有一檔樣本少、區間特別寬的，整頁每一框都被它壓扁。
// 2026-11-18 實測：軸跑到 ±11.5%，而當天前四檔最寬的也只到 −5.53%，
// 於是 00964 那條 3.0 個百分點的收盤區間只佔整條軸的 13%。
//
// 代價講清楚：超出刻度的那幾框，長度不再能跟其他框直接比，要看數字。
// 它們的共同特徵就是樣本不足、殘差大，本來就不該拿長度去跟別人比。
// 超出的框會在框頭標出來，不是悄悄裁掉。
var OVC_AXIS_P = 0.80;
function _ovcAxis(rows) {
  var v = rows.map(_ovcSpan).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
  if (!v.length) return 2;
  // 最近位次法。只有一兩框時 p80 本來就等於最大值，不另外處理
  var i = Math.min(v.length - 1, Math.max(0, Math.ceil(OVC_AXIS_P * v.length) - 1));
  return Math.max(2, Math.ceil(v[i] * 1.1 * 2) / 2);
}

function _ovcPctTxt(v, dec) {
  if (v == null) return '—';
  return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(dec == null ? 2 : dec) + '%';
}

// 排位。arr 必須已經按重要性由高到低排好，重要的先挑靠橫條的那一行。
//
// 不能改用「由左到右」排：估收與現價盤中常常只差零點幾分，由左到右會讓估收先佔住
// 第二行，把現價擠回第一行去撞掛買。2026-11-17 實測六框有三框這樣疊，最多疊 19.5px。
// 按重要性排就不會：掛買與現價先各拿一行，擠不下的是估收。
//
// 最多三行。兩行不夠是常態不是例外，寧可讓框高一點也不要疊字。
// 三行還放不下才回到第一行疊著，至少不會憑空消失。
function _ovcStagger(arr) {
  var put = [[], [], []], rows = 1;
  var free = function (r, x) {
    return put[r].every(function (q) { return Math.abs(x - q) >= OVC_GAP; });
  };
  arr.forEach(function (m) {
    // 按重要性挑，所以 x 不是由小到大進來的，要跟那一行已經放的每一個都比距離，
    // 只跟最後一個比會漏掉「這一個在已放的那個左邊」的情形
    for (var r = 0; r < 3; r++) {
      if (free(r, m.x)) { m.row = r; put[r].push(m.x); rows = Math.max(rows, r + 1); return; }
    }
    m.row = 0; put[0].push(m.x);
  });
  return rows;
}
function _ovcLabsH(rows) { return rows === 1 ? 40 : (rows === 2 ? 76 : 112); }

function _ovcLabels(arr, side, rows, X) {
  var h = '<div class="ovc-labs ovc-' + side + '" style="height:' + _ovcLabsH(rows) + 'px">';
  arr.forEach(function (m) {
    // 引線永遠對準標記本身；方塊太靠邊會被推回框內，所以兩者分開畫
    var pin = m.x < 8 ? ' ovc-pinl' : (m.x > 92 ? ' ovc-pinr' : '');
    var tip = m.tip ? ' title="' + String(m.tip).replace(/"/g, '&quot;') + '"' : '';
    h += '<div class="ovc-stem ovc-r' + m.row + '" style="left:' + m.x.toFixed(2) + '%"></div>'
      + '<div class="ovc-lab ovc-r' + m.row + ' ovc-' + m.cl + pin + '" style="left:' + m.x.toFixed(2) + '%"' + tip + '>'
      + '<span class="ovc-t"><span class="ovc-k">' + m.k + '</span>'
      + '<span class="ovc-p" style="color:' + (m.base ? 'var(--text3)' : _rbCol(m.p)) + '">'
      + (m.base ? '基準' : _ovcPctTxt(m.p)) + '</span></span>'
      + '<span class="ovc-v" style="color:' + m.col + '">' + _ovPx(m.v) + '</span>'
      + '</div>';
  });
  return h + '</div>';
}

// 字的亮度就是可信度，與表格那一頁同一組門檻
function _ovcTier(r2) {
  if (r2 == null) return 'var(--text3)';
  return r2 >= 0.5 ? 'var(--text)' : (r2 >= 0.25 ? 'var(--text2)' : 'var(--text3)');
}

function _ovcCard(r, HI, ticks) {
  var LO = -HI;
  var X = function (p) { return Math.max(0, Math.min(100, (p - LO) / (HI - LO) * 100)); };
  var P = function (v) { return (v > 0 && r.base > 0) ? (v / r.base - 1) * 100 : null; };
  var tierCol = _ovcTier(r.r2);

  // ── 上方：今天不會再變的框架 ──
  var UP = [];
  if (r.loPx > 0) UP.push({ pri: 0, k: '下限', v: r.loPx, p: P(r.loPx), cl: 'edge', col: _rbCol(P(r.loPx)),
    tip: '收盤區間的下緣。半衰加權殘差乘上實測倍率算出來的，不是猜的。' });
  UP.push({ pri: 2, k: '前收', v: r.base, p: 0, cl: 'base', base: true, col: 'var(--text2)',
    tip: r.basePrev + ' 的收盤。這一頁所有百分比都是對它算的。' });
  if (r.hiPx > 0) UP.push({ pri: 1, k: '上限', v: r.hiPx, p: P(r.hiPx), cl: 'edge', col: _rbCol(P(r.hiPx)),
    tip: '收盤區間的上緣。上下不對稱是量出來的，不是對半分。' });

  // ── 下方：今天走到哪 ──
  var DN = [];
  if (r.lPx > 0) DN.push({ pri: 0, k: '掛買', v: r.lPx, p: P(r.lPx), cl: 'key', col: tierCol,
    tip: '日內最低價的推估。掛限價買進看這一個，不是看收盤。'
       + (r.lCover != null && r.lCoverN ? '這一檔的最低區間實測罩住了 ' + Math.round(r.lCover)
          + '% 的日子（' + r.lCoverN + ' 天），目標 68%。' : '') });
  if (r.act) {
    if (r.act.l > 0) DN.push({ pri: 2, k: '實低', v: r.act.l, p: r.act.lPct, cl: 'edge', col: _rbCol(r.act.lPct),
      tip: '那一天實際走出來的日內最低。' });
    if (r.act.c > 0) DN.push({ pri: 1, k: '實收', v: r.act.c, p: r.act.cPct, cl: 'now', col: _rbCol(r.act.cPct),
      tip: '那一天實際的收盤。這一列已經可以對答案了。' });
  } else {
    if (r.cPx > 0) DN.push({ pri: 2, k: '估收', v: r.cPx, p: P(r.cPx), cl: 'edge', col: _rbCol(P(r.cPx)),
      tip: '收盤區間的中心。別把它當成一個會到的價。' });
    if (r.live > 0) DN.push({ pri: 1, k: '現價', v: r.live, p: P(r.live), cl: 'now', col: 'var(--accent3)',
      tip: '券商即時快照' + (r.liveAt ? '，' + r.liveAt : '') + '。盤中每 30 秒更新。' });
  }

  UP.forEach(function (m) { m.x = X(m.p); });
  DN.forEach(function (m) { m.x = X(m.p); });
  // 排位按重要性，畫的順序仍照價格由左到右，否則引線交錯看不出誰是誰
  var rowsUp = _ovcStagger(UP.slice().sort(function (a2, b2) { return a2.pri - b2.pri; }));
  var rowsDn = _ovcStagger(DN.slice().sort(function (a2, b2) { return a2.pri - b2.pri; }));
  UP.sort(function (a2, b2) { return a2.x - b2.x; });
  DN.sort(function (a2, b2) { return a2.x - b2.x; });

  // 這一框有沒有畫到軸外。有的話長度不可信，要講出來
  var over = _ovcSpan(r) > HI + 1e-9;
  var h = '<div class="ovc-card' + (r.cal ? ' ovc-calc' : '') + (over ? ' ovc-over' : '')
    + '"><div class="ovc-head">'
    + '<span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + _rbName(r.code) + '</span>'
    + (_ovcHeld(r.code) ? ''
        : '<span class="ovc-wt" title="這一檔在關注清單裡，目前沒有持股。推估的算法與持股的那幾檔完全相同。">關注</span>')
    + (over ? '<span class="ovc-ovb" title="這一框用到的價格超出了共用刻度的範圍（±' + HI
        + '%），超出的那一端被切在框邊。數字本身沒有被改，但這一框的長度不能再拿去跟其他框比。'
        + '刻度取的是所有框的第 80 百分位，不取最大值：取最大值的話一檔特別寬的會把其餘每一框都壓扁。'
        + '區間特別寬通常代表這一檔樣本少、殘差大。">超出刻度</span>' : '')
    + (r.ixOn ? '<span class="ov-fx" title="這一檔的成份股有 '
        + (r.fgnW == null ? '' : r.fgnW.toFixed(0)) + '% 在海外，實測 Nasdaq 在夜盤與費半之上還能多解釋一截，'
        + '所以這一框的推估多掛了 Nasdaq。">＋N</span>' : '')
    + '</div>'
    // 兩個區間用文字再講一次，放在上框線的右端。
    // 圖上讀得出相對關係，讀不出精確值；要抄進委託單的是這兩組數字。
    + '<div class="ovc-head2">'
    + '<span class="ovc-h2k">掛買</span><b>'
    + (r.lLoPx > 0 ? _ovPx(r.lLoPx) + ' ～ ' + _ovPx(r.lHiPx) : '—') + '</b>'
    + '<span class="ovc-h2k">收盤</span><b>'
    + (r.loPx > 0 ? _ovPx(r.loPx) + ' ～ ' + _ovPx(r.hiPx) : '—') + '</b>'
    + ((typeof _ovPxTagHtml === 'function')
        ? _ovPxTagHtml(r.code, r.base, r.liveSame, r.liveWhy) : '')
    + '</div>';

  h += _ovcLabels(UP, 'up', rowsUp, X);

  // ── 橫條 ──
  h += '<div class="ovc-bar">';
  ticks.forEach(function (t) {
    if (Math.abs(t) > HI - 1e-9) return;        // 兩端的刻度就是框線，不重畫
    h += '<div class="ovc-gl' + (t === 0 ? ' ovc-zero' : '') + '" style="left:' + X(t).toFixed(2) + '%"></div>';
  });
  // 被切到的那一端改成方角，一眼看得出它沒有畫完
  var clip = function (a, b) {
    return (P(a) < -HI ? ' ovc-clipl' : '') + (P(b) > HI ? ' ovc-clipr' : '');
  };
  if (r.loPx > 0 && r.hiPx > 0) {
    h += '<div class="ovc-band' + clip(r.loPx, r.hiPx) + '" style="left:' + X(P(r.loPx)).toFixed(2)
       + '%;width:' + (X(P(r.hiPx)) - X(P(r.loPx))).toFixed(2) + '%"></div>';
  }
  if (r.lLoPx > 0 && r.lHiPx > 0) {
    h += '<div class="ovc-bandb' + clip(r.lLoPx, r.lHiPx) + '" style="left:' + X(P(r.lLoPx)).toFixed(2)
       + '%;width:' + (X(P(r.lHiPx)) - X(P(r.lLoPx))).toFixed(2) + '%"></div>';
  }
  if (!r.act && r.cPx > 0) h += '<div class="ovc-mk ovc-est" style="left:' + X(P(r.cPx)).toFixed(2) + '%"></div>';
  if (r.act && r.act.c > 0) h += '<div class="ovc-mk ovc-est" style="left:' + X(r.act.cPct).toFixed(2) + '%"></div>';
  if (r.lPx > 0) h += '<div class="ovc-mk ovc-buy" style="left:' + X(P(r.lPx)).toFixed(2) + '%"></div>';
  if (!r.act && r.live > 0) h += '<div class="ovc-mk ovc-now" style="left:' + X(P(r.live)).toFixed(2) + '%"></div>';
  if (r.act && r.act.l > 0) h += '<div class="ovc-mk ovc-now" style="left:' + X(r.act.lPct).toFixed(2) + '%"></div>';
  h += '</div>';

  h += _ovcLabels(DN, 'dn', rowsDn, X);

  // ── 次要資訊。不收合：收起來的話每看一檔要多點一下，而這幾個每次都要看 ──
  var volHot = (r.volX != null && r.volX >= 1.5);
  h += '<div class="ovc-foot">'
    + '<span>成本 <b>' + (r.cost > 0 ? _ovPx(r.cost) : '—') + '</b></span>'
    + '<span>折溢價 <b style="color:' + (r.prem == null ? 'var(--text3)' : _rbCol(r.prem)) + '">'
      + _ovcPctTxt(r.prem) + '</b></span>'
    + '<span>量能 <b' + (volHot ? ' class="ovc-hot"' : '') + '>'
      + (r.volX == null ? '—' : r.volX.toFixed(2) + ' 倍') + '</b></span>'
    + '<span>說明力 <b style="color:' + tierCol + '">' + (r.r2 == null ? '—' : r.r2.toFixed(2)) + '</b></span>'
    + '<span>樣本 <b>' + r.n + ' 天</b></span>'
    + (r.act ? '<span>估收 <b>' + (r.cPx > 0 ? _ovPx(r.cPx) : '—') + '</b></span>' : '')
    + '</div></div>';
  return h;
}

var OVC_SORTS = [
  { k: 'lPx', t: '掛買參考' },
  { k: 'width', t: '區間寬度' },
  { k: 'pos', t: '現價位置' },
  { k: 'prem', t: '折溢價' },
  { k: 'volX', t: '量能' },
  { k: 'r2', t: '說明力' },
  { k: 'code', t: '代號' }
];
function _ovcSortVal(r, k) {
  if (k === 'code') return String(r.code);
  if (k === 'lPx') return (r.lPx > 0 && r.base > 0) ? (r.lPx / r.base - 1) * 100 : null;
  if (k === 'width') return (r.hiPx > 0 && r.loPx > 0 && r.base > 0) ? (r.hiPx - r.loPx) / r.base * 100 : null;
  // 現價在收盤區間裡的位置，0＝貼著下限、1＝貼著上限。跨檔可比，所以用比例不用價差。
  if (k === 'pos') {
    if (!(r.live > 0) || !(r.hiPx > r.loPx)) return null;
    return (r.live - r.loPx) / (r.hiPx - r.loPx);
  }
  return r[k];
}

function ovcStockHtml() {
  if (!_rbData || typeof ovEstimate !== 'function') return '';
  var t = (typeof _ovToday !== 'undefined') ? _ovToday : null;
  if (!t) {
    return '<div class="rb-caveat nb-keep">拿不到台指期夜盤（本機券商連線未開，且資料檔是空的），這一頁沒有東西可以畫。</div>';
  }
  var codes = (_rbData.codes || []).filter(function (c) { return !_ovcIsBond(c); });
  var rows = codes.map(ovEstimate).filter(Boolean);
  if (!rows.length) {
    return '<div class="rb-caveat nb-keep">這一頁只收股票型，目前的持股與關注清單裡沒有符合的標的。</div>';
  }
  rows.forEach(function (r) {
    var lv = _ovcLive(r.code, t);
    r.live = lv ? lv.px : null;
    r.liveAt = lv ? lv.at : null;
    // 框頭那一塊要分得出「連線沒開」與「這不是推估那一盤的價」，所以日期要帶著走
    var raw = (typeof _ovLiveOf === 'function') ? _ovLiveOf(r.code) : null;
    r.liveSame = !!(raw && (!raw.d || !t.d || raw.d === t.d));
    r.liveWhy = (raw && raw.d && t.d && raw.d !== t.d)
      ? (raw.d < t.d ? '這是 ' + raw.d + ' 的收盤，推估的 ' + t.d + ' 那一盤還沒開始'
                     : '這是 ' + raw.d + ' 的價，推估的是 ' + t.d + ' 那一盤，已經過去了')
      : '';
  });

  var sk = _ovcSort();
  rows.sort(function (a, b) {
    // 第一順位永遠是持有與否，排序鈕選的那一欄只在各自的組內排
    var ha = _ovcHeld(a.code) ? 0 : 1, hb = _ovcHeld(b.code) ? 0 : 1;
    if (ha !== hb) return ha - hb;
    var x = _ovcSortVal(a, sk), y = _ovcSortVal(b, sk);
    if (sk === 'code') return x < y ? -1 : (x > y ? 1 : 0);
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;                      // 數值一律由大到小
  });

  var HI = _ovcAxis(rows);
  var STEP = HI <= 2.5 ? 0.5 : (HI <= 5 ? 1 : 2);
  // 刻度一定要從 0 往兩邊長，不能從 −HI 一路加上來。
  // 軸寬是由資料湊到 0.5 的整數倍，不保證是刻度間距的整數倍：
  // 實測 HI=3.5、間距 1 時，從 −3.5 加上來的刻度是 −3.5 −2.5 … +3.5，整排沒有 0，
  // 而 0 那條是前收的基準線，少了它整張圖就沒有對照點。
  var ticks = [0];
  for (var v = STEP; v <= HI + 1e-9; v += STEP) { ticks.push(+v.toFixed(2)); ticks.unshift(+(-v).toFixed(2)); }

  var _tw = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  var dLab = t.d ? t.d.slice(5).replace('-', '/') : '';
  var calOn = null;
  for (var i = 0; i < rows.length; i++) { if (rows[i].cal) { calOn = rows[i].cal; break; } }

  var h = '<div class="rb-sox">';
  h += '<div class="sec-title">夜推股票（'
    + (!t.d ? '明天的價格' : (t.d === _tw ? dLab + ' 這一盤' : dLab + ' 的價格')) + '）'
    + (calOn ? '<span class="ov-cal" title="開盤之後改用今天走到現在的價重新定心，'
        + '目前套的是 ' + _ovCalLab(calOn.slot) + ' 那一組倍率。">已用 '
        + (calOn.at || '').slice(0, 5) + ' 的價校準</span>' : '')
    + '</div>';

  // ── 共用刻度尺。整頁只有一把，所以框跟框之間的長度可以直接比 ──
  h += '<div class="ovc-axiswrap"><div class="ovc-axis">';
  ticks.forEach(function (tk) {
    h += '<i style="left:' + ((tk + HI) / (2 * HI) * 100).toFixed(2) + '%">'
      + (tk > 0 ? '+' : (tk < 0 ? '−' : '')) + (STEP < 1 ? Math.abs(tk).toFixed(1) : Math.abs(tk)) + '%</i>';
  });
  h += '</div><div class="ovc-legend">'
    + '<span><em class="ovc-e1"></em>收盤區間（上下限）</span>'
    + '<span><em class="ovc-e2"></em>掛買區間</span>'
    + '<span><em class="ovc-e3"></em>掛買參考</span>'
    + '<span><em class="ovc-e4"></em>' + (rows[0] && rows[0].act ? '實際日內最低' : '現價') + '</span>'
    + '<span><em class="ovc-e5"></em>' + (rows[0] && rows[0].act ? '實際收盤' : '預估收盤') + '</span>'
    + '<span class="ovc-note">橫軸是對前收的漲跌幅，刻度 ±' + HI + '%，取所有框的第 80 百分位，不取最大值。'
    + '所有框共用，所以框跟框之間可以直接比長度，但標了「超出刻度」的那幾框除外。</span></div></div>';

  // ── 排序 ──
  h += '<div class="ovc-sortbar"><span class="ovc-slb" title="持有的一律排在前面，這幾顆鈕是在持有與關注各自的組內排。">持有優先，再依</span>';
  OVC_SORTS.forEach(function (s) {
    h += '<button class="ovc-sb' + (sk === s.k ? ' on' : '') + '" onclick="ovcSort(\'' + s.k + '\')">'
      + s.t + '</button>';
  });
  h += '</div>';

  h += '<div class="ovc-grid">' + rows.map(function (r) { return _ovcCard(r, HI, ticks); }).join('') + '</div>';

  h += '<div class="detail-note"><dl>'
    + '<dt>這一頁要回答什麼</dt><dd>「我現在掛在哪個價買得到，而且那個價合不合理。」'
    + '推估本身與隔夜推估那一頁完全相同，是同一組迴歸、同一份資料，只是畫法不同。'
    + '要精確比對數字或看實測覆蓋率，回隔夜推估那一頁。'
    + '所有價格以 ' + (rows[0] ? rows[0].basePrev : '') + ' 的收盤為基準，已對齊升降單位。</dd>'

    + '<dt>現價在區間中的位置</dt><dd>'
    + '<b>定義</b>：橫條上那顆藍色膠囊，在收盤區間這段灰帶裡的相對位置。'
    + '貼左邊代表現價接近區間下限，貼右邊代表接近上限。<br>'
    + '<b>比較基準</b>：比的是這一檔自己今天的推估區間，不是歷史、也不是別檔。'
    + '跨檔要比的話看長度，因為所有框共用同一條軸。<br>'
    + '<b>白話意義</b>：膠囊貼右邊代表今天該漲的大概漲完了，往上的空間在模型眼裡所剩不多；'
    + '貼左邊代表還在區間的低檔。<br>'
    + '<b>機制</b>：區間是把夜盤與費半解釋不掉的那部分殘差，用近 10 日半衰加權算出寬度，'
    + '再往中心兩側各推一個實測倍率。現價走到哪一段，等於今天的實際買賣壓已經把'
    + '多少不確定性走掉了。開盤之後這個位置還會被盤中校準修正一次：'
    + '現在偏離開盤推估多少，收盤大概就偏離多少。<br>'
    + '<b>行動含義</b>：膠囊貼右邊時，掛在現價附近追買的勝算比開盤前差，'
    + '掛買參考那個價仍然是模型認為今天還可能回到的位置。<br>'
    + '<b>不能告訴你什麼</b>：位置不含方向。膠囊貼右邊可能是「漲完了」，'
    + '也可能是「今天強勢、要突破區間」，區間本身只罩得住約 68% 的日子，'
    + '剩下三成會走到區間外。要分辨這兩種，得配量能那一欄：'
    + '貼上限而且量能 1.5 倍以上，突破的成分比較大。</dd>'

    + '<dt>字的亮度</dt><dd>亮白代表這兩個訊號解釋掉一半以上的起伏，中灰是四分之一到一半，'
    + '暗灰是不到四分之一、區間跟隨便猜差不多寬。不用紅綠是因為那兩個色在這一頁是漲跌。</dd>'
    + '</dl></div>';

  return h + '</div>';
}
