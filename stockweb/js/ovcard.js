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

// ── 橫軸：寬度共用，中心各自算 ──
//
// 舊版是固定的 ±HI%，前收永遠釘在正中央。問題是前收離當天的價很遠的時候，
// 右半邊整片空白，真正要看的那一段被擠到剩一成寬。
// 2026-11-19 實測 00927：掛買區間只佔整條軸的 6.8%、收盤區間 6.1%，
// 前收右邊 10 個百分點全空。
//
// 改成「寬度全頁共用、中心各框自己算」：寬度一樣所以長度仍然可以跨框比，
// 中心跟著這一框自己那群價跑，空白就沒了。前收不再進圖，改放框頭。
//
// 要罩住的東西：兩條區間各往外推半條區間寬（曲線的尾巴在那裡），
// 加上現價、今低、估收、掛買參考。
function _ovcWin(r) {
  var p = function (v) { return (v > 0 && r.base > 0) ? (v / r.base - 1) * 100 : null; };
  var wL = (r.lHiPx > 0 && r.lLoPx > 0) ? r.lHiPx - r.lLoPx : 0;
  var wC = (r.hiPx > 0 && r.loPx > 0) ? r.hiPx - r.loPx : 0;
  var pad = Math.max(wL, wC) * 0.55;
  var a = [];
  var add = function (v) { var q = p(v); if (q != null) a.push(q); };
  if (r.lLoPx > 0) { add(r.lLoPx - pad); add(r.lHiPx + pad); }
  if (r.loPx > 0) { add(r.loPx - pad); add(r.hiPx + pad); }
  add(r.lPx); add(r.cPx); add(r.live); add(r.liveLo);
  if (r.act) { if (r.act.cPct != null) a.push(r.act.cPct); if (r.act.lPct != null) a.push(r.act.lPct); }
  if (!a.length) return { mn: -1, mx: 1 };
  return { mn: Math.min.apply(null, a), mx: Math.max.apply(null, a) };
}
function _ovcSpan(r) { var w = _ovcWin(r); return w.mx - w.mn; }

// ── 軸寬取第 80 百分位，不取最大值 ──
//
// 取最大值的話，只要清單裡有一檔樣本少、區間特別寬的，整頁每一框都被它壓扁。
// 代價講清楚：超出刻度的那幾框，長度不再能跟其他框直接比，要看數字。
// 它們的共同特徵就是樣本不足、殘差大，本來就不該拿長度去跟別人比。
// 超出的框會在框頭標出來，不是悄悄裁掉。
var OVC_AXIS_P = 0.80;
// 成交機率過半的門檻。50% 的意思是「跌到的日子比沒跌到的多」，
// 不是分位數算出來的，是「多數」這個概念本身的分界。與夜推債券同一條線。
var OVC_FILL_HI = 50;
// 圖高。128px 是量出來的：再矮的話節點標籤與標記標籤會貼在一起。
var OVC_PH = 128;
function _ovcAxis(rows) {
  var v = rows.map(_ovcSpan).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; });
  if (!v.length) return 3;
  var i = Math.min(v.length - 1, Math.max(0, Math.ceil(OVC_AXIS_P * v.length) - 1));
  return Math.max(3, Math.ceil(v[i] * 1.06 * 2) / 2);
}

// 價格 → 機率。分布是回測殘差標準化之後的樣子，由 overnight.js 帶過來。
function _ovcCdf(zq, base, mid, sd) {
  if (!zq || !(base > 0) || mid == null || !(sd > 0)) return null;
  return function (px) {
    return ovCdf(zq, ((px / base - 1) * 100 - mid) / sd);
  };
}

function _ovcPctTxt(v, dec) {
  if (v == null) return '—';
  return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(dec == null ? 2 : dec) + '%';
}

// 字的亮度就是可信度，與表格那一頁同一組門檻
function _ovcTier(r2) {
  if (r2 == null) return 'var(--text3)';
  return r2 >= 0.5 ? 'var(--text)' : (r2 >= 0.25 ? 'var(--text2)' : 'var(--text3)');
}

// ══════════════════════════════════════════════════════════════
// 一張卡片：機率 × 價格
// ══════════════════════════════════════════════════════════════
//
// 縱軸是機率、橫軸是價位。兩條曲線：
//   金線 掛買成交機率 ＝ 限價委買掛在某一價位，當日最低價觸及該價位的機率。
//   青虛線 收盤跌破機率 ＝ 當日收盤價低於該價位的機率。
//
// 為什麼要二維。舊版只有一條價格軸，每加一樣東西就得再疊一排標籤，
// 距離越拉越遠；而「掛得到幾成」只能寫成框頭的一個字，圖上沒有對應的長度。
// 換成二維之後，機率有自己的軸可以讀，今天走到哪的那幾個點也回到圖裡，
// 不必再另闢一排，卡片反而變矮。
//
// 區間不必另外畫：掛買區間的上下緣就是金線上的 16% 與 84% 兩點，
// 收盤區間同理在青線上。節點直接從曲線取高度，所以點永遠落在線上，
// 不會出現「區間說在裡面、曲線說機率很低」這種自相矛盾。
function _ovcCard(r, SPAN) {
  var Pc = function (v) { return (v > 0 && r.base > 0) ? (v / r.base - 1) * 100 : null; };
  var win = _ovcWin(r);
  var need = win.mx - win.mn;
  var over = need > SPAN + 1e-9;
  var LO = (win.mn + win.mx) / 2 - SPAN / 2;
  var X = function (p) { return Math.max(0, Math.min(100, (p - LO) / SPAN * 100)); };
  var XV = function (v) { var p = Pc(v); return p == null ? null : X(p); };
  var tierCol = _ovcTier(r.r2);
  var fillHi = (r.lFill != null && r.lFill > OVC_FILL_HI);
  var fillCol = fillHi ? 'var(--text)' : 'var(--text2)';
  var fLow = _ovcCdf(r.zl, r.base, r.lMidPct, r.sdl);
  var fCls = _ovcCdf(r.zc, r.base, r.cMidPct, r.sdc);
  var tag = (typeof _ovPxTagHtml === 'function')
    ? _ovPxTagHtml(r.code, r.base, r.liveSame, r.liveWhy) : '';
  // 推的那一盤還沒開始時圖上一個標記都沒有，圖例就不要列它
  var hasMk = r.act ? (r.act.c > 0 || r.act.l > 0) : (r.live > 0 || r.liveLo > 0);

  var h = '<div class="ovc-card' + (r.cal ? ' ovc-calc' : '') + (over ? ' ovc-over' : '')
    + '"><div class="ovc-head">'
    + '<span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + _rbName(r.code) + '</span>'
    + (_ovcHeld(r.code) ? ''
        : '<span class="ovc-wt" title="這一檔在關注清單裡，目前沒有持股。推估的算法與持股的那幾檔完全相同。">關注</span>')
    + (over ? '<span class="ovc-ovb" title="這一框要用到 ' + need.toFixed(1)
        + ' 個百分點才畫得完，超過共用的 ' + SPAN + ' 個百分點，兩端被切在框邊。'
        + '數字本身沒有被改，但這一框的長度不能再拿去跟其他框比。'
        + '刻度取的是所有框的第 80 百分位，不取最大值：取最大值的話一檔特別寬的會把其餘每一框都壓扁。'
        + '區間特別寬通常代表這一檔樣本少、殘差大。">超出刻度</span>' : '')
    + (r.ixOn ? '<span class="ov-fx" title="這一檔的成份股有 '
        + (r.fgnW == null ? '' : r.fgnW.toFixed(0)) + '% 在海外，實測 Nasdaq 在夜盤與費半之上還能多解釋一截，'
        + '所以這一框的推估多掛了 Nasdaq。">＋N</span>' : '')
    + '</div>'
    // 要抄進委託單的數字。圖上讀得出相對關係，讀不出精確值。
    // 兩組排同一行、各自框起來：掛買那一組是你要掛的價與它的成交機率，
    // 另一組是這一盤的基準與你的成本。
    + '<div class="ovc-head2">'
    + '<span class="ovc-h2r">'
    + '<span class="ovc-h2k" title="模型推今天的日內最低會落在哪。要抄進委託單的就是這個價。'
    + '區間的上下緣在圖上：曲線的兩個空心點、以及下方那條金色 Bar 的兩端。">掛買參考</span><b>'
    + (r.lPx > 0 ? _ovPx(r.lPx) : '—') + '</b>'
    + '<span class="ovc-h2k" title="掛在掛買參考這個價的成交機率。實測 '
    + (r.lFill == null ? '—' : Math.round(r.lFill))
    + '% 的日子裡，當日最低確實觸及它。">成交機率</span><b style="color:' + fillCol + '">'
    + (r.lFill == null ? '—' : Math.round(r.lFill) + '%') + '</b>'
    + '</span>'
    + (tag ? '<span class="ovc-h2r">' + tag + '</span>' : '')
    + '</div>';

  if (!fLow && !fCls) {
    return h + '<div class="ovc-nodata">樣本不足，算不出機率分布（回測至少要 20 天）。</div>'
      + _ovcFoot(r, tierCol) + '</div>';
  }

  // ── 圖例。排在圖的上方，不壓在格線裡 ──
  h += '<div class="ovc-lg">'
    + '<i><u class="ovc-u1"></u><span style="color:var(--accent2)">掛買成交機率</span></i>'
    + (fCls ? '<i><u class="ovc-u2"></u><span style="color:var(--sum)">收盤跌破機率</span></i>' : '')
    + (hasMk ? '<i><u class="ovc-u3"></u><span style="color:var(--accent3)">'
        + (r.act ? '實際收盤' : '現價') + '</span></i>' : '')
    + '</div>';

  h += '<div class="ovc-ch"><div class="ovc-pa" style="height:' + OVC_PH + 'px">';
  [0, 25, 50, 75, 100].forEach(function (g) {
    h += '<div class="ovc-hl' + (g === 50 ? ' ovc-h50' : (g === 0 ? ' ovc-h0' : ''))
      + '" style="bottom:' + g + '%"></div>'
      + '<div class="ovc-yl" style="bottom:' + g + '%">' + g + '%</div>';
  });

  // ── 曲線 ──
  //
  // 區間內外分色：區間外壓暗、線細，16% 到 84% 之間用亮色加粗。
  // 一眼就分得出哪一段是有效區間，哪一段只是分布的尾巴。
  var path = function (fn, x0, x1) {
    var d = '', N = 110;
    for (var i = 0; i <= N; i++) {
      var xs = x0 + (x1 - x0) * i / N, p = r.base * (1 + (LO + SPAN * xs) / 100);
      var y = 100 - Math.max(0, Math.min(100, fn(p)));
      d += (i ? 'L' : 'M') + (xs * 1000).toFixed(1) + ',' + y.toFixed(2);
    }
    return d;
  };
  var seg = function (fn, a, b, cls) {
    if (!(a > 0) || !(b > 0)) return '<path class="ovc-cv ' + cls + '-d" d="' + path(fn, 0, 1) + '"/>';
    var xa = Math.max(0, Math.min(1, X(Pc(a)) / 100)), xb = Math.max(0, Math.min(1, X(Pc(b)) / 100));
    return '<path class="ovc-cv ' + cls + '-d" d="' + path(fn, 0, xa) + '"/>'
      + '<path class="ovc-cv ' + cls + '-d" d="' + path(fn, xb, 1) + '"/>'
      + '<path class="ovc-cv ' + cls + '" d="' + path(fn, xa, xb) + '"/>';
  };
  h += '<svg viewBox="0 0 1000 100" preserveAspectRatio="none">'
    + (fLow ? '<path class="ovc-ar" d="' + path(fLow, 0, 1) + ' L1000,100 L0,100 Z"/>' : '')
    + (fCls ? seg(fCls, r.loPx, r.hiPx, 'ovc-cvc') : '')
    + (fLow ? seg(fLow, r.lLoPx, r.lHiPx, 'ovc-cvl') : '')
    + '</svg>';

  // ── 標記：今天走到哪 ──
  var M = [];
  if (r.act) {
    if (r.act.c > 0) M.push({ k: '實收', v: r.act.c, c: 'var(--accent3)' });
    if (r.act.l > 0) M.push({ k: '實低', v: r.act.l, c: 'var(--sum)' });
  } else {
    if (r.live > 0) M.push({ k: '現價', v: r.live, c: 'var(--accent3)' });
    if (r.liveLo > 0) M.push({ k: '今低', v: r.liveLo, c: 'var(--sum)' });
  }
  M.sort(function (a, b) { return XV(a.v) - XV(b.v); });
  // 兩個標記靠太近就併成一個，不讓標籤疊在一起
  var grp = [];
  M.forEach(function (m) {
    var g = grp[grp.length - 1];
    if (g && Math.abs(XV(m.v) - XV(g[0].v)) < 7) g.push(m); else grp.push([m]);
  });
  grp.forEach(function (g) {
    g.x = g.reduce(function (a, m) { return a + XV(m.v); }, 0) / g.length;
    g.f = fLow ? fLow(g[0].v) : 50;
    // 曲線貼近頂端時標籤改掛在交點下方，否則會長到框外、撞到框頭
    g.down = g.f > 80;
    g.y = g.f * OVC_PH / 100 + (g.down ? -(9 + 15 * g.length) - 7 * g.length : 9 + 7 * g.length);
  });
  var mkX = M.map(function (m) { return XV(m.v); });
  // 某一側幾個百分點以內站著標記就算「忙」，節點標價要閃開
  var busy = function (x, dir) {
    return mkX.some(function (u) { return (u - x) * dir > -1.5 && Math.abs(u - x) < 9; });
  };

  // ── 節點：區間上下緣與掛買參考，價直接標在旁邊 ──
  //
  // 標上下會撞到從底部拉上來的那條標記線，所以一律標左右。
  // 左右也會撞：同高度的兩個節點（掛買下限與收盤下限都在 16% 那條高度上）
  // 靠太近時，左邊那個往左、右邊那個往右，往兩側分開。
  var nodes = [];
  if (fLow) {
    if (r.lLoPx > 0) nodes.push({ p: r.lLoPx, f: fLow(r.lLoPx), c: 'var(--accent2)' });
    if (r.lPx > 0) nodes.push({ p: r.lPx, f: fLow(r.lPx), c: 'var(--accent2)', key: 1 });
    if (r.lHiPx > 0) nodes.push({ p: r.lHiPx, f: fLow(r.lHiPx), c: 'var(--accent2)' });
  }
  if (fCls) {
    if (r.loPx > 0) nodes.push({ p: r.loPx, f: fCls(r.loPx), c: 'var(--sum)' });
    if (r.hiPx > 0) nodes.push({ p: r.hiPx, f: fCls(r.hiPx), c: 'var(--sum)' });
  }
  nodes.forEach(function (nd) {
    nd.x = X(Pc(nd.p));
    nd.side = (nd.f < 50) ? -1 : 1;
    if (busy(nd.x, nd.side) && !busy(nd.x, -nd.side)) nd.side = -nd.side;
    nd.lift = (busy(nd.x, 1) && busy(nd.x, -1)) ? 15 : 0;
    // 標記的價就是這個節點的價時，標記自己已經寫了，不再印第二次
    nd.dup = M.some(function (m) { return Math.abs(m.v - nd.p) < _ovcTick(nd.p) * 0.5; });
    // 標記那一塊字是置中的兩行，左右閃都閃不掉。撞上就不印這個節點的價：
    // 它在下方那條 Bar 的端點還看得到，點本身的提示也寫著。
    var ny = nd.f * OVC_PH / 100;
    if (grp.some(function (g) { return Math.abs(g.x - nd.x) < 11 && Math.abs(g.y - ny) < 24; })) {
      nd.dup = true;
    }
  });
  nodes.slice().sort(function (a, b) { return a.f - b.f; }).forEach(function (nd, i, arr) {
    var pv = arr[i - 1];
    if (pv && Math.abs(nd.f - pv.f) < 11 && Math.abs(nd.x - pv.x) < 9 && nd.side === pv.side) {
      if (nd.x >= pv.x) { pv.side = -1; nd.side = 1; } else { pv.side = 1; nd.side = -1; }
    }
  });
  nodes.forEach(function (nd) {
    h += '<div class="ovc-pt' + (nd.key ? ' ovc-ptk' : '') + '" style="left:' + nd.x.toFixed(2)
      + '%;bottom:' + nd.f.toFixed(1) + '%;background:' + nd.c + '" title="'
      + (nd.key ? '掛買參考 ' : '') + _ovPx(nd.p) + '，成交機率 ' + Math.round(nd.f) + '%"></div>'
      + (nd.dup ? '' : '<div class="ovc-ptl ' + (nd.side < 0 ? 'ovc-lft' : 'ovc-rgt')
        + '" style="left:' + nd.x.toFixed(2) + '%;bottom:calc(' + nd.f.toFixed(1) + '% + '
        + nd.lift + 'px);color:' + nd.c + '">' + _ovPx(nd.p) + '</div>');
  });

  grp.forEach(function (g) {
    h += '<div class="ovc-vl" style="left:' + g.x.toFixed(2) + '%;height:' + g.f.toFixed(1)
      + '%;border-left-color:' + g[0].c + '"></div>'
      + '<div class="ovc-vd" style="left:' + g.x.toFixed(2) + '%;bottom:' + g.f.toFixed(1)
      + '%;background:' + g[0].c + '"></div>'
      + '<div class="ovc-vt" style="left:' + g.x.toFixed(2) + '%;bottom:calc(' + g.f.toFixed(1) + '% '
      + (g.down ? '- ' + (9 + 15 * g.length) + 'px' : '+ 9px') + ')">'
      + g.map(function (m) {
          return '<span style="color:' + m.c + '">' + m.k + ' ' + _ovPx(m.v) + '</span>';
        }).join('<br>') + '</div>';
  });

  h += '</div>';

  // ── 座標下方：一組就是「這一條區間的兩個數字 ＋ 它自己的橫 Bar」 ──
  // 數字跟它的 Bar 貼在一起，不把四個數字混在同一排、Bar 另外擺。
  var grpBar = function (a, b, cls, lab, tip) {
    if (!(a > 0) || !(b > 0)) return '';
    var g = '<div class="ovc-gp" title="' + tip.replace(/"/g, '&quot;') + '"><div class="ovc-gn">';
    [a, b].forEach(function (v) {
      g += '<div class="ovc-tk" style="left:' + XV(v).toFixed(2) + '%"></div>'
        + '<span class="' + cls + '" style="left:' + XV(v).toFixed(2) + '%">' + _ovPx(v) + '</span>';
    });
    return g + '</div><div class="ovc-gb"><b class="' + cls + '">' + lab + '</b>'
      + '<em class="' + cls + '" style="left:' + XV(a).toFixed(2) + '%;width:'
      + (XV(b) - XV(a)).toFixed(2) + '%"></em></div></div>';
  };
  h += grpBar(r.lLoPx, r.lHiPx, 'ovc-c1', '掛買區間',
    '掛限價買進看的是這一段。兩端就是金線上的 16% 與 84%，'
    + '掛在下緣約一成六會成交、掛在上緣約八成四會成交。');
  h += grpBar(r.loPx, r.hiPx, 'ovc-c2', '收盤區間',
    '收盤大約六成八的日子會落在這一段裡。中心就是估收 '
    + (r.cPx > 0 ? _ovPx(r.cPx) : '—') + '。');
  h += '</div>';

  return h + _ovcFoot(r, tierCol) + '</div>';
}

// ── 次要資訊。不收合：收起來的話每看一檔要多點一下，而這幾個每次都要看 ──
function _ovcFoot(r, tierCol) {
  var volHot = (r.volX != null && r.volX >= 1.5);
  return '<div class="ovc-foot">'
    + '<span title="' + (r.basePrev || '') + ' 的收盤。這一框所有價格都以它為基準。">前收 <b>'
      + (r.base > 0 ? _ovPx(r.base) : '—') + '</b></span>'
    + '<span>成本 <b>' + (r.cost > 0 ? _ovPx(r.cost) : '—') + '</b></span>'
    + '<span>折溢價 <b style="color:' + (r.prem == null ? 'var(--text3)' : _rbCol(r.prem)) + '">'
      + _ovcPctTxt(r.prem) + '</b></span>'
    + '<span>量能 <b' + (volHot ? ' class="ovc-hot"' : '') + '>'
      + (r.volX == null ? '—' : r.volX.toFixed(2) + ' 倍') + '</b></span>'
    + '<span>說明力 <b style="color:' + tierCol + '">' + (r.r2 == null ? '—' : r.r2.toFixed(2)) + '</b></span>'
    + '<span>樣本 <b>' + r.n + ' 天</b></span>'
    + '<span>估收 <b>' + (r.cPx > 0 ? _ovPx(r.cPx) : '—') + '</b></span>'
    + '</div>';
}

// 升降單位。判斷標記的價與節點的價是不是同一個價時要用。
function _ovcTick(p) { return p < 10 ? 0.01 : (p < 50 ? 0.05 : (p < 100 ? 0.1 : 0.5)); }

var OVC_SORTS = [
  { k: 'lPx', t: '掛買參考' },
  { k: 'width', t: '區間寬度' },
  { k: 'pos', t: '現價位置' },
  { k: 'prem', t: '折溢價' },
  { k: 'volX', t: '量能' },
  { k: 'lFill', t: '成交機率' },
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

  // 全頁共用的橫軸寬度。寬度一樣，所以框跟框之間可以直接比長度。
  var SPAN = _ovcAxis(rows);

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

  // ── 這一頁怎麼讀，講一次就好 ──
  h += '<div class="ovc-axiswrap"><div class="ovc-legend">'
    + '<span class="ovc-note">每一框的縱軸是機率 0 到 100，橫軸是價位，寬度全頁共用 '
    + SPAN + ' 個百分點、中心各框自己算，所以框跟框之間可以直接比長度，'
    + '標了「超出刻度」的那幾框除外。前收不進圖，在框頭。</span>'
    + '</div></div>';

  // ── 排序 ──
  h += '<div class="ovc-sortbar"><span class="ovc-slb" title="持有的一律排在前面，這幾顆鈕是在持有與關注各自的組內排。">持有優先，再依</span>';
  OVC_SORTS.forEach(function (s) {
    h += '<button class="ovc-sb' + (sk === s.k ? ' on' : '') + '" onclick="ovcSort(\'' + s.k + '\')">'
      + s.t + '</button>';
  });
  h += '</div>';

  h += '<div class="ovc-grid">' + rows.map(function (r) { return _ovcCard(r, SPAN); }).join('') + '</div>';

  h += '<div class="detail-note"><dl>'
    + '<dt>這一頁要回答什麼</dt><dd>「我掛在哪個價會成交，而那個價合不合理。」'
    + '推估本身與隔夜推估那一頁完全相同，是同一組迴歸、同一份資料，只是畫法不同。'
    + '要精確比對數字或看實測覆蓋率，回隔夜推估那一頁。'
    + '所有價格以 ' + (rows[0] ? rows[0].basePrev : '') + ' 的收盤為基準，已對齊升降單位。</dd>'

    + '<dt>掛買成交機率（金線）</dt><dd>'
    + '<b>定義</b>：限價委買掛在某一價位時，當日最低價觸及該價位的機率。'
    + '算法是把回測每一天的殘差除以當天自己的區間寬度，排序之後數有多少比例落在該價位以下。'
    + '在橫軸挑一個價，往上碰到金線，往左看縱軸就是它。<br>'
    + '<b>比較基準</b>：兩個都要看，少一個就會誤判。一是五成，也就是「成交的日子比沒成交的多」；'
    + '二是這一檔自己的掛買區間，金線上那兩個空心點就是區間的上下緣。'
    + '只看機率不看價位會掛在不合理的價，只看區間不看機率會以為區間裡每個價都差不多。<br>'
    + '<b>白話意義</b>：這個價掛下去，過去十次大約有幾次會成交。<br>'
    + '<b>機制</b>：價位越低，能觸及它的日子越少，所以金線由左下往右上遞增。'
    + '掛買參考是迴歸的中心估計，而最小平方的殘差平均必定是 0，所以它的機率天生在五成附近。'
    + '真正讓它偏離五成的是殘差的偏態：日內最低偶爾跌得很深，少數幾天把平均拉下去，'
    + '多數日子的最低反而落在推估之上，機率因此低於五成。偏態越重，掛買參考的成交機率越低。<br>'
    + '<b>行動含義</b>：掛買參考低於五成，代表照它掛多數日子買不到。'
    + '要提高成交機率得往上靠區間上緣，代價是買貴；往下靠下緣買得便宜，但大多數日子空手。'
    + '這條線把這個取捨畫成了斜率，陡的那一段代表多讓一檔價就多換到不少成交機率，'
    + '平的那一段代表再讓也換不到多少。<br>'
    + '<b>不能告訴你什麼</b>：這是歷史頻率，不是當下報價，與現在委賣簿上有多少人要賣無關。'
    + '回測沒有把盤中校準那一層算進去，校準成功時掛買參考會再往下壓，實際成交機率比圖上低。'
    + '它也不含成交順序：同一價位的委託照時間排隊，最低只掃到一次的日子不一定輪得到你。'
    + '而且係數是用整段樣本配適的，不是當天只用當天以前的資料，這是樂觀的那一邊。</dd>'

    + '<dt>收盤跌破機率（青色虛線）</dt><dd>'
    + '<b>定義</b>：當日收盤價低於某一價位的機率。算法與金線完全相同，只是把日內最低換成收盤。<br>'
    + '<b>比較基準</b>：50% 所在的價位就是估收，兩個空心點就是收盤區間的上下緣。<br>'
    + '<b>白話意義</b>：收在這個價以下的機會有多大。<br>'
    + '<b>機制</b>：收盤的殘差比日內最低對稱得多，所以這條線中段陡、兩端收得快，'
    + '不像金線那樣下緣拖出一條長尾。那條長尾就是偶爾殺很深又拉回來的那幾天。<br>'
    + '<b>行動含義</b>：同一個價位上兩條線的高度差，就是「摸得到」與「收在那裡」的落差。'
    + '金線高、青線低的那一段，代表當天摸得到但收不在那裡，適合掛買等回檔，不適合追價。<br>'
    + '<b>不能告訴你什麼</b>：它不講路徑。收盤跌破機率三成，不代表盤中沒跌破過；'
    + '跌破再拉回在這條線上完全看不出來，那要看金線。</dd>'

    + '<dt>空心點與下方那兩組 Bar</dt><dd>空心點是區間的上下緣，高度直接從曲線上取，'
    + '所以點永遠落在線上，不會出現「區間說在裡面、曲線說機率很低」這種自相矛盾。'
    + '金線上還有一顆實心點，那是掛買參考，要抄進委託單的就是它。'
    + '<br>下方兩組 Bar 是同一組價位換個方向畫：一組是掛買區間、一組是收盤區間，'
    + '數字貼著自己那條 Bar，不把四個數字混在同一排。</dd>'

    + '<dt>現價與今低</dt><dd>從底部拉上來、停在金線上的那條線，菱形是交點。'
    + '它一次講兩件事：現在的價在哪，以及掛在那個價本來有多少機會成交。'
    + '<br>今低是今天到現在走出來的最低。掛在今低以上的買進價今天都已經觸及過了，'
    + '推估的最低也不可能高於它，所以掛買參考那個數字被它壓住，'
    + '兩者重合代表今天已經跌破模型推的位置。'
    + '<br>收盤之後這兩條換成實收與實低，那是當天的定論。'
    + '不能告訴你的是「還會不會再跌一次」，而且觸及過不代表成交得到。</dd>'

    + '<dt>字的亮度</dt><dd>亮白代表這兩個訊號解釋掉一半以上的起伏，中灰是四分之一到一半，'
    + '暗灰是不到四分之一、區間跟隨便猜差不多寬。不用紅綠是因為那兩個色在這一頁是漲跌。</dd>'
    + '</dl></div>';

  return h + '</div>';
}
