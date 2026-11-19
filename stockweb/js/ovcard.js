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
  [r.loPx, r.hiPx, r.lLoPx, r.lHiPx, r.lPx, r.cPx, r.oPx, r.live, r.liveLo].forEach(function (v) {
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
// 掛得到過半的門檻。50% 的意思是「跌到的日子比沒跌到的多」，
// 不是分位數算出來的，是「多數」這個概念本身的分界。與夜推債券同一條線。
var OVC_FILL_HI = 50;
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
// 行數上限等於這一側的標籤數（下方最多四個：掛買、現價、今低、估收），
// 所以保證排得下、不會疊。只有真的擠在一起的那幾框會變高，其餘不受影響。
// 2026-11-18 實測：今低加進來之後，四個落在 0.8 個百分點內時三行會不夠，
// 第四個掉回第一行疊住掛買。
function _ovcStagger(arr) {
  var put = [[], [], [], []], rows = 1;
  var free = function (r, x) {
    return put[r].every(function (q) { return Math.abs(x - q) >= OVC_GAP; });
  };
  arr.forEach(function (m) {
    // 按重要性挑，所以 x 不是由小到大進來的，要跟那一行已經放的每一個都比距離，
    // 只跟最後一個比會漏掉「這一個在已放的那個左邊」的情形
    for (var r = 0; r < 4; r++) {
      if (free(r, m.x)) { m.row = r; put[r].push(m.x); rows = Math.max(rows, r + 1); return; }
    }
    m.row = 0; put[0].push(m.x);
  });
  return rows;
}
// 容器高度＝最後一行的底部。行的位移是 5／46／87，標籤本身高 40。
// 這三個數字要一起改，只改其中一個會讓標籤壓到橫條或框底的那條線。
function _ovcLabsH(rows) { return [46, 88, 129, 170][Math.min(rows, 4) - 1]; }

// 貼著橫條底下的那一條。單行、不參與錯開，所以不會讓框變高。
function _ovcEstHtml(m, X) {
  if (!m) return '';
  var x = X(m.p);
  var pin = x < 10 ? ' ovc-pinl' : (x > 90 ? ' ovc-pinr' : '');
  return '<div class="ovc-estrow">'
    + '<div class="ovc-stem ovc-eststem" style="left:' + x.toFixed(2) + '%"></div>'
    + '<div class="ovc-estlab' + pin + '" style="left:' + x.toFixed(2) + '%"'
    + ' title="' + String(m.tip).replace(/"/g, '&quot;') + '">'
    + (m.dot || '')
    + '<span class="ovc-k">' + m.k + '</span>'
    + '<span class="ovc-v" style="color:' + m.col + '">' + _ovPx(m.v) + '</span>'
    + '<span class="ovc-p" style="color:' + _rbCol(m.p) + '">' + _ovcPctTxt(m.p) + '</span>'
    + '</div></div>';
}

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
      + '<span class="ovc-v" style="color:' + m.col + '">'
      + (m.dot || '') + _ovPx(m.v) + '</span>'
      + '</div>';
  });
  return h + '</div>';
}

// 字的亮度就是可信度，與表格那一頁同一組門檻
function _ovcTier(r2) {
  if (r2 == null) return 'var(--text3)';
  return r2 >= 0.5 ? 'var(--text)' : (r2 >= 0.25 ? 'var(--text2)' : 'var(--text3)');
}

// ── 今天碰到哪裡 ──
//
// 推估價講的是「今天可能走到哪」，圓點講的是「今天實際已經走到哪」。
// 兩個合起來才知道現在站在哪一段：推估的下限已經碰到，代表今天走得比推的深；
// 掛買還沒碰到，代表掛在那裡的單今天還沒有機會成交。
//
// 判定就是「今天的價格區間有沒有涵蓋這個價」：日內最低 <= 它 <= 日內最高。
// 這一條對前收上下兩側都成立，不必分買賣兩套規則。
// 開完盤的那一列（r.act）不畫：那一天的高低已成定論，表上另有實低、實收兩個標籤。
function _ovcHit(r, v) {
  if (r.act) return null;
  if (!(v > 0) || !(r.liveLo > 0) || !(r.liveHi > 0)) return null;
  var c = function (x) { return Math.round(x * 100); };
  return c(r.liveLo) <= c(v) && c(v) <= c(r.liveHi);
}
function _ovcDot(hit, k, r) {
  if (hit == null) return '';
  var rng = (r.liveLo > 0 && r.liveHi > 0)
    ? '（今天 ' + _ovPx(r.liveLo) + ' 到 ' + _ovPx(r.liveHi) + '）' : '';
  return '<span class="ovc-dot' + (hit ? ' ovc-dot-on' : '') + '" title="'
    + k + '：今天' + (hit ? '已經走到過這個價' : '還沒走到這個價') + rng + '"></span>';
}

function _ovcCard(r, HI, ticks) {
  var LO = -HI;
  var X = function (p) { return Math.max(0, Math.min(100, (p - LO) / (HI - LO) * 100)); };
  var P = function (v) { return (v > 0 && r.base > 0) ? (v / r.base - 1) * 100 : null; };
  var tierCol = _ovcTier(r.r2);
  // 掛買的亮度接「掛得到的比例」，不接說明力：這一格是要抄進委託單的價，
  // 要先知道的是掛不掛得到，說明力在框底自己有一格。與夜推債券同一條線、同一個門檻。
  var fillHi = (r.lFill != null && r.lFill > OVC_FILL_HI);
  var fillCol = fillHi ? 'var(--text)' : 'var(--text2)';

  // ── 上方：今天不會再變的框架 ──
  var UP = [];
  if (r.loPx > 0) UP.push({ pri: 0, k: '下限', v: r.loPx, p: P(r.loPx), cl: 'edge', col: _rbCol(P(r.loPx)),
    tip: '收盤區間的下緣。半衰加權殘差乘上實測倍率算出來的，不是猜的。' });
  UP.push({ pri: 2, k: '前收', v: r.base, p: 0, cl: 'base', base: true, col: 'var(--text2)',
    tip: r.basePrev + ' 的收盤。這一頁所有百分比都是對它算的。' });
  if (r.hiPx > 0) UP.push({ pri: 1, k: '上限', v: r.hiPx, p: P(r.hiPx), cl: 'edge', col: _rbCol(P(r.hiPx)),
    tip: '收盤區間的上緣。上下不對稱是量出來的，不是對半分。' });

  // ── 下方：今天走到哪 ──
  var DN = [], est = null;
  if (r.lPx > 0) DN.push({ pri: 0, k: '掛買', v: r.lPx, p: P(r.lPx),
    cl: 'key' + (fillHi ? ' ovc-fillhi' : ''), col: fillCol,
    tip: '日內最低價的推估。掛限價買進看這一個，不是看收盤。'
       + (r.lFill != null ? '實測 ' + Math.round(r.lFill) + '% 的日子裡，當天的實際最低有跌到當天推的這個價。'
          : '')
       + (r.lCover != null && r.lCoverN ? '這一檔的最低區間實測罩住了 ' + Math.round(r.lCover)
          + '% 的日子（' + r.lCoverN + ' 天），目標 68%。' : '') });
  if (r.act) {
    if (r.act.l > 0) DN.push({ pri: 2, k: '實低', v: r.act.l, p: r.act.lPct, cl: 'edge', col: _rbCol(r.act.lPct),
      tip: '那一天實際走出來的日內最低。' });
    if (r.act.c > 0) DN.push({ pri: 1, k: '實收', v: r.act.c, p: r.act.cPct, cl: 'now', col: _rbCol(r.act.cPct),
      tip: '那一天實際的收盤。這一列已經可以對答案了。' });
  } else {
    // 估收刻意不進錯開的名單。它是收盤區間的中心，不是要抄進委託單的價，
    // 卻常常跟掛買、現價、今低擠在一個百分點之內，結果多吃掉一整行、框跟著變高。
    // 改成貼著橫條底下的一條單行小字，獨自一條不跟別人搶位置。
    if (r.cPx > 0) {
      est = { k: '估收', v: r.cPx, p: P(r.cPx), col: _rbCol(P(r.cPx)),
        tip: '收盤區間的中心。別把它當成一個會到的價。' };
    }
    if (r.live > 0) DN.push({ pri: 1, k: '現價', v: r.live, p: P(r.live), cl: 'now', col: 'var(--accent3)',
      tip: '券商即時快照' + (r.liveAt ? '，' + r.liveAt : '') + '。持股逐筆更新，關注清單每 30 秒一次。' });
    // 今天實際走到的最低。它跟掛買參考是同一件事的兩面：
    // 掛買是「模型推今天會跌到哪」，這一個是「今天實際已經跌到哪」。
    // 已經走過的最低是確定的事實，推估的最低不可能比它高。
    if (r.liveLo > 0) DN.push({ pri: 2, k: '今低', v: r.liveLo, p: P(r.liveLo), cl: 'today', col: 'var(--sum)',
      tip: '今天到現在走出來的最低價' + (r.liveLoAt ? '（' + r.liveLoAt + '）' : '')
         + '。掛在它以上的買進價，今天都已經觸及過了。'
         + '推估的最低不可能高於它，所以掛買參考那個數字也被它壓住。' });
  }

  // 圓點只給推估出來的價。現價與今低本身就是今天走出來的，畫了必定實心，是噪音。
  UP.concat(DN).forEach(function (m) {
    if (m.k === '現價' || m.k === '今低') return;
    m.dot = _ovcDot(_ovcHit(r, m.v), m.k, r);
  });
  if (est) est.dot = _ovcDot(_ovcHit(r, est.v), est.k, r);
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
    // 框頭右端排兩行。四組並排量過要 580px，加上代號、名稱與徽章超過框寬 798px，
    // 「掛得到」會疊到代號上面。拆成兩行之後最寬的那一行只有 320px 上下。
    // 分行照「講的是同一件事」分：掛買那個價與它掛得到的頻率同一行，
    // 收盤區間與現價同一行。
    + '<div class="ovc-head2">'
    + '<span class="ovc-h2r">'
    + '<span class="ovc-h2k">掛買</span><b>'
    + (r.lLoPx > 0 ? _ovPx(r.lLoPx) + ' ～ ' + _ovPx(r.lHiPx) : '—') + '</b>'
    + '<span class="ovc-h2k">掛得到</span><b style="color:' + fillCol + '">'
    + (r.lFill == null ? '—' : Math.round(r.lFill) + '%') + '</b>'
    + '</span>'
    + '<span class="ovc-h2r">'
    + '<span class="ovc-h2k">收盤</span><b>'
    + (r.loPx > 0 ? _ovPx(r.loPx) + ' ～ ' + _ovPx(r.hiPx) : '—') + '</b>'
    + ((typeof _ovPxTagHtml === 'function')
        ? _ovPxTagHtml(r.code, r.base, r.liveSame, r.liveWhy) : '')
    + '</span>'
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
    h += '<div class="ovc-bandb' + (fillHi ? ' ovc-bhi' : '') + clip(r.lLoPx, r.lHiPx)
       + '" title="掛買區間 ' + _ovPx(r.lLoPx) + ' 到 ' + _ovPx(r.lHiPx)
       + '。掛限價買進看的是這一段，不是上面那條收盤區間。"'
       + ' style="left:' + X(P(r.lLoPx)).toFixed(2)
       + '%;width:' + (X(P(r.lHiPx)) - X(P(r.lLoPx))).toFixed(2) + '%"></div>';
  }
  if (!r.act && r.cPx > 0) h += '<div class="ovc-mk ovc-est" style="left:' + X(P(r.cPx)).toFixed(2) + '%"></div>';
  if (r.act && r.act.c > 0) h += '<div class="ovc-mk ovc-est" style="left:' + X(r.act.cPct).toFixed(2) + '%"></div>';
  if (r.lPx > 0) h += '<div class="ovc-mk ovc-buy" style="left:' + X(P(r.lPx)).toFixed(2) + '%"></div>';
  if (!r.act && r.liveLo > 0) {
    h += '<div class="ovc-mk ovc-low" style="left:' + X(P(r.liveLo)).toFixed(2) + '%"></div>';
  }
  if (!r.act && r.live > 0) h += '<div class="ovc-mk ovc-now" style="left:' + X(P(r.live)).toFixed(2) + '%"></div>';
  if (r.act && r.act.l > 0) h += '<div class="ovc-mk ovc-now" style="left:' + X(r.act.lPct).toFixed(2) + '%"></div>';
  h += '</div>';

  h += _ovcEstHtml(est, X);
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
  { k: 'lFill', t: '掛得到' },
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
    // 今天走到的最低。只有「快照就是推估這一盤」時才算數，
    // 晚上推估明天時快照是今天的收盤，那個最低不屬於要推的那一盤。
    var snap = _ovLive[String(r.code)] || null;
    r.liveLo = (r.liveSame && snap && snap.lo > 0 && (!snap.d || !t.d || snap.d === t.d))
      ? snap.lo : null;
    // 今天的日內最高。圓點要判斷的是「今天的價格走到過這裡沒有」，
    // 前收上方那幾個價要靠最高才答得出來，只有最低答不了。
    r.liveHi = (r.liveSame && snap && snap.hi > 0 && (!snap.d || !t.d || snap.d === t.d))
      ? snap.hi : null;
    r.liveLoAt = snap ? (snap.at || '') : '';
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
    + '<span><em class="ovc-e2"></em>掛買區間（掛得到過半時轉實）</span>'
    + '<span><em class="ovc-e3"></em>掛買參考</span>'
    + '<span><em class="ovc-e4"></em>' + (rows[0] && rows[0].act ? '實際日內最低' : '現價') + '</span>'
    + '<span><em class="ovc-e5"></em>' + (rows[0] && rows[0].act ? '實際收盤' : '預估收盤') + '</span>'
    + (rows.some(function (r) { return r.liveLo > 0; })
        ? '<span><em class="ovc-e6"></em>今天到現在的最低</span>' : '')
    + (rows.some(function (r) { return !r.act && r.liveLo > 0 && r.liveHi > 0; })
        ? '<span><em class="ovc-e7"></em>今天已走到</span>'
          + '<span><em class="ovc-e8"></em>今天還沒走到</span>' : '')
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

    + '<dt>兩條帶子</dt><dd>上面那條綠轉紅的是<b>收盤區間</b>，下面金色的是<b>掛買區間</b>。'
    + '要抄進委託單的是下面那一條，上面那條回答的是「今天會收在哪裡」。'
    + '<br>兩條現在同樣高。舊版掛買區間只有 5px、四成透明，擠在橫條最下面四分之一，'
    + '框頭寫著掛買區間是多少、圖上卻找不到它。兩端另外加了端點，起訖在哪裡不用猜。'
    + '<br>金色帶子的濃淡跟「掛得到」同一條線：過半轉實、沒過半壓暗，'
    + '跟掛買那個數字的亮度是同一件事。</dd>'
    + '<dt>掛買的亮度</dt><dd><b>定義</b>：用同一條迴歸、同一段樣本回測，'
    + '數有多少比例的日子裡，當天的實際最低真的跌到當天推的掛買參考。'
    + '過半就把掛買那個數字打亮，沒過半壓暗，框頭的「掛得到」是同一個數字。<br>'
    + '<b>比較基準</b>：50%，也就是「跌到的日子比沒跌到的多」。這條線不是分位數算出來的，'
    + '是多數這個概念本身的分界，與夜推債券同一條線。<br>'
    + '<b>白話意義</b>：掛買是模型推今天會跌到哪，這個比例是「過去照這個推法掛，掛得到的頻率」。<br>'
    + '<b>機制</b>：掛買參考是迴歸的中心估計，而最小平方的殘差平均必定是 0，'
    + '所以這個比例天生就在五成附近。真正讓它偏離五成的是殘差的偏態：'
    + '日內最低偶爾會跌得很深，少數幾天把平均拉下去，多數日子的最低反而落在推估之上，'
    + '比例因此低於五成。偏態越重，掛得到的頻率越低。<br>'
    + '<b>行動含義</b>：低於五成代表照掛買參考掛，多數日子買不到，'
    + '要買得到得往下用掛買區間的下緣，代價是成本更高的那幾天會錯過。<br>'
    + '<b>不能告訴你什麼</b>：這個回測沒有把校準那一層算進去。'
    + '畫面上的掛買參考在校準成功時會再往下壓一點，實際掛得到的頻率會比這個數字低。'
    + '它也不含成交順序：同一價位的委託照時間排隊，最低只掃到一次的日子不一定輪得到你。'
    + '而且係數是用整段樣本配適的，不是當天只用當天以前的資料，這是樂觀的那一邊。</dd>'

    + '<dt>今天碰到哪裡</dt><dd>每個推估價前面那顆圓點。實心代表今天的價格已經走到過這個價，'
    + '空心代表還沒。判定就是「今天的日內最低到最高這一段有沒有涵蓋它」，'
    + '前收上下兩側同一條規則。沒有今天的即時快照時整張框都不畫，不會拿昨天的高低充數。'
    + '<br>現價與今低不畫：它們本身就是今天走出來的，畫了必定是實心。'
    + '收盤之後那一列也不畫，當天的高低已成定論，表上另有實低與實收兩個標籤。'
    + '<br>它跟推估價是同一件事的兩面：<b>推估講今天可能走到哪，圓點講今天實際已經走到哪。</b>'
    + '下限已經實心代表今天走得比推的深；掛買還是空心代表掛在那裡的單今天還沒有機會成交。'
    + '<br>不能告訴你什麼：走到過不代表掛得到。同一價位的委託照時間排隊，'
    + '最低只掃到一次的那種日子不一定輪得到你。它也不說還會不會再走到一次。</dd>'

    + '<dt>今低</dt><dd>今天到現在走出來的最低價，橫條上那條淺青色的線。'
    + '它跟<b>掛買參考</b>是同一件事的兩面：掛買是模型推今天會跌到哪，今低是今天實際已經跌到哪。'
    + '<br>掛在今低以上的買進價，今天都已經觸及過了。推估的最低也不可能高於它，'
    + '所以掛買參考那個數字被它壓住，兩者重合時代表今天已經跌破模型推的位置。'
    + '<br>不能告訴你的是「還會不會再跌一次」。觸及過不代表掛得到：同一價位的委託照時間排隊，'
    + '最低只掃到一次的那種日子不一定輪得到你。收盤之後這條線換成「實低」，那是當天的定論。</dd>'
    + '<dt>字的亮度</dt><dd>亮白代表這兩個訊號解釋掉一半以上的起伏，中灰是四分之一到一半，'
    + '暗灰是不到四分之一、區間跟隨便猜差不多寬。不用紅綠是因為那兩個色在這一頁是漲跌。</dd>'
    + '</dl></div>';

  return h + '</div>';
}
