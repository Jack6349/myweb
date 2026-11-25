// 股利總管 Web — 換股比歷程（換股試算子頁，單賣單買時才出現）
//
// 上面那張「換手品質」比的是殖利率、折溢價、量能，全是比率，沒有一列回答
// 「這一刻賣掉，實際換得到幾股」。這張表補的就是那個數字，而且是盤中逐筆的歷程。
//
// 為什麼不是每筆成交都記一列：同一個價連續成交 20 筆，換股比完全沒動，
// 表上卻多 20 列一樣的數字，真正的變化點反而被埋掉。這裡只在兩邊的價
// 至少有一邊變動時才記一列，等於記「製程的變化點」而不是「每一次取樣」。
// 兩檔升降單位都是 0.01，任一邊跳一檔換股比就會動，所以這個過濾不會漏掉真的變化。
//
// 價格來源與上面的試算刻意不同：試算用進頁時鎖定的價（免得結果隨 tick 跳動），
// 這張表用即時成交價。兩個數字不一樣是正常的，表頭有一行講明兩者的關係。

var SWL_LS = 'swap_log_v1';
var SWL_SHOW = 20;      // 表上顯示最近幾筆
var SWL_KEEP = 600;     // 存進瀏覽器的上限（約 15KB，夠放一整天的變化點）

var _swlKey = '';       // 日期|賣出代碼|買入代碼
var _swlRows = [];      // [[時間, 賣價, 買價], ...]，舊→新
var _swlPair = null;    // {s, b, sh, lockS, lockB}；null＝不是單賣單買，停止記錄
var _swlSubbed = [];    // 本頁額外訂閱的代碼（離開時退訂，歸還額度）
var _swlSubBusy = false;
var _swlSaveT = null;

// ── 存取 ──
// 只留一組配對：換成別的賣買組合，前一組就被取代。留多組要管過期與容量，
// 而實際用法是「盯著現在這一組」，留下來的那幾組不會回頭看。
function _swlLoad(key) {
  try {
    var o = JSON.parse(localStorage.getItem(SWL_LS) || 'null');
    if (o && o.k === key && Array.isArray(o.r)) return o.r;
  } catch (e) {}
  return [];
}
function _swlSave() {
  if (_swlSaveT) return;                       // 節流：每一筆都寫會拖慢 tick 處理
  _swlSaveT = setTimeout(function () {
    _swlSaveT = null;
    try { localStorage.setItem(SWL_LS, JSON.stringify({ k: _swlKey, r: _swlRows })); } catch (e) {}
  }, 1500);
}

function _swlClock() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 19); }
function _swlPx(code) {
  var r = (typeof _rows !== 'undefined') && _rows[code];
  return (r && r.close != null) ? r.close : null;
}
function _swlTime(code) {
  var r = (typeof _rows !== 'undefined') && _rows[code];
  return (r && r.time) ? String(r.time).slice(0, 8) : '';
}

// 賣出淨額 ÷ 每股買入成本 ＝ 換到的股數。費率沿用換股試算那一組，不另外定義。
function _swlShares(sellPx, buyPx, sellSh) {
  if (!(sellPx > 0) || !(buyPx > 0) || !(sellSh > 0)) return null;
  return sellPx * sellSh * (1 - SWAP_SELL_FEE) / (buyPx * (1 + SWAP_BUY_FEE));
}
function _swlFmt(v) { return v == null ? '—' : Math.round(v).toLocaleString('zh-TW'); }

// ── 訂閱 ──
// 賣出腳通常是持股（進頁時已由共用引擎訂閱過），買入腳多半還沒買、沒有訂閱，
// 所以這裡只補沒訂到的那幾檔，離開頁面再退訂。
async function _swlEnsureSub(codes) {
  if (_swlSubBusy) return;
  var own = {};
  (typeof _positions !== 'undefined' && _positions || []).forEach(function (p) { own[String(p.code)] = true; });
  var need = codes.filter(function (c) { return c && !own[c] && _swlSubbed.indexOf(c) < 0; });
  if (!need.length) { _swlSeed(); return; }
  _swlSubBusy = true;
  try {
    for (var i = 0; i < need.length; i++) {
      var cd = need[i];
      if (!_contracts[cd]) { try { _contracts[cd] = await fetchContract(cd); } catch (e) { hush('swaplog', e); } }
      if (!_contracts[cd]) continue;
      if (_swlPx(cd) == null) {                // 先補一筆快照，否則開盤前整張表都是空的
        try {
          var snaps = await fetchSnapshots([_contracts[cd]]);
          (snaps || []).forEach(function (s) {
            _rows[String(s.code)] = { close: s.close, total_volume: s.total_volume, time: (s.datetime || '').slice(11, 19) };
          });
        } catch (e) { hush('swaplog', e); }
      }
      try { await subscribeTick(_contracts[cd]); _swlSubbed.push(cd); } catch (e) { hush('swaplog', e); }
    }
  } finally { _swlSubBusy = false; }
  _swlSeed();
  _swlPaint();
}
function _swlUnsub(code) {
  var i = _swlSubbed.indexOf(code);
  if (i < 0) return;                           // 不是本頁訂的（可能是持股）→ 不動
  var c = _contracts[code];
  _swlSubbed.splice(i, 1);
  if (!c) return;
  fetch(API + '/api/v1/stream/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ security_type: 'STK', exchange: c.exchange, code: code, quote_type: 'Tick' })
  }).catch(function (e) { hush('swaplog', e); });
}
// 離開股利估算頁：退訂並停止記錄。留著訂閱會一直佔額度，而這張表只有這一頁看得到。
function stopSwapLog() {
  _swlSubbed.slice().forEach(function (code) { _swlUnsub(code); });
  _swlSubbed = [];
  _swlPair = null;
}

// ── 記錄 ──
// 第一列用現有報價墊底，否則盤後或開盤前整張表空白，連「現在換得到幾股」都看不到。
function _swlSeed() {
  if (!_swlPair || _swlRows.length) return;
  var sp = _swlPx(_swlPair.s), bp = _swlPx(_swlPair.b);
  if (!(sp > 0) || !(bp > 0)) return;
  _swlRows.push([_swlTime(_swlPair.s) || _swlTime(_swlPair.b) || _swlClock(), sp, bp]);
  _swlSave();
}
function swlOnTick(code) {
  if (!_swlPair) return;
  code = String(code);
  if (code !== _swlPair.s && code !== _swlPair.b) return;
  var sp = _swlPx(_swlPair.s), bp = _swlPx(_swlPair.b);
  if (!(sp > 0) || !(bp > 0)) return;
  var last = _swlRows[_swlRows.length - 1];
  if (last && last[1] === sp && last[2] === bp) return;   // 兩邊的價都沒變 → 換股比沒動 → 不記
  _swlRows.push([_swlTime(code) || _swlClock(), sp, bp]);
  if (_swlRows.length > SWL_KEEP) _swlRows.splice(0, _swlRows.length - SWL_KEEP);
  _swlSave();
  _swlPaint();
}

// ── 繪製 ──
// 只重畫自己那一塊，不走整頁重繪：整頁重繪會把賣出／買入張數的輸入焦點吃掉。
function _swlPaint() {
  var box = document.getElementById('swl-box');
  if (box) box.innerHTML = _swlInner();
}

function _swlInner() {
  var p = _swlPair;
  if (!p) return '';
  var lock = _swlShares(p.lockS, p.lockB, p.sh);
  var head = '<div class="detail-note nb-keep">本表用即時成交價；上方試算用的是進頁鎖定的價（' +
    p.lockS.toFixed(2) + ' ／ ' + p.lockB.toFixed(2) + '，換到 ' + _swlFmt(lock) +
    ' 股）。按「刷新現價」才會把上方試算同步到最新。</div>';
  if (!_swlRows.length) {
    return head + '<div class="detail-note nb-keep">還沒取得這兩檔的成交價。盤中有成交就開始累積。</div>';
  }

  var vals = _swlRows.map(function (r) { return _swlShares(r[1], r[2], p.sh); });
  var ci = vals.length - 1, cur = Math.round(vals[ci]);
  var bi = 0, wi = 0;
  vals.forEach(function (v, i) { if (v > vals[bi]) bi = i; if (v < vals[wi]) wi = i; });

  // 「跟現在差」不上紅綠：本站紅綠固定代表漲跌，拿來標好壞會被誤讀。
  // 方向改用「多／少」兩個等寬的字，數字另外加粗，掃起來一樣快。
  var dtxt = function (v) {
    var d = Math.round(v) - cur;
    if (!d) return '<span class="swap-dim">—</span>';
    return '<span class="swl-d">' + (d > 0 ? '多' : '少') +
      '<b' + (d > 0 ? ' class="swl-more"' : '') + '>' + Math.abs(d).toLocaleString('zh-TW') + '</b> 股</span>';
  };
  var pin = function (lb, i, now) {
    return '<div class="swl-pin' + (now ? ' swl-pin-now' : '') + '">' +
      '<span class="swl-pin-lb">' + lb + '</span>' +
      '<span class="swl-pin-t">' + _swlRows[i][0] + '</span>' +
      '<span class="swl-pin-v">' + _swlFmt(vals[i]) + ' 股</span>' +
      '<span class="swl-pin-d">' +
        (now ? _swlRows[i][1].toFixed(2) + ' ／ ' + _swlRows[i][2].toFixed(2) : dtxt(vals[i])) +
      '</span></div>';
  };
  // 三枚釘在上面不被捲掉：整天的歷程不會逐列看，但「區間多寬、現在站在哪」要一眼定位。
  var h = head + '<div class="swl-pins">' +
    pin('今日最佳', bi) + pin('今日最差', wi) + pin('現在', ci, true) + '</div>';

  h += '<div class="inv-table-wrap"><table class="inv-table swap-table swl-table"><thead><tr>' +
    '<th>時間</th><th class="num">' + p.s + '（賣）</th><th class="num">' + p.b + '（買）</th>' +
    '<th class="num">換到股數</th><th class="num">跟現在差</th></tr></thead><tbody>';
  var from = Math.max(0, _swlRows.length - SWL_SHOW);
  for (var i = _swlRows.length - 1; i >= from; i--) {
    h += '<tr><td class="swl-t">' + _swlRows[i][0] + '</td>' +
      '<td class="num">' + _swlRows[i][1].toFixed(2) + '</td>' +
      '<td class="num">' + _swlRows[i][2].toFixed(2) + '</td>' +
      '<td class="num swl-sh">' + _swlFmt(vals[i]) + '</td>' +
      '<td class="num">' + dtxt(vals[i]) + '</td></tr>';
  }
  h += '</tbody></table></div>';

  h += '<div class="detail-note nb-keep">今日累積 ' + _swlRows.length + ' 個變化點，上表為最近 ' +
    Math.min(SWL_SHOW, _swlRows.length) + ' 筆（新到舊）。離開這一頁會停止累積，' +
    '回來接著記，中間的成交補不回來。</div>';

  h += '<div class="detail-note"><dl>' +
    '<dt>定義</dt><dd>賣出腳即時成交價 × 賣出股數 ×（1 − ' + (SWAP_SELL_FEE * 100).toFixed(4) + '%），' +
      '除以買入腳即時成交價 ×（1 ＋ ' + (SWAP_BUY_FEE * 100).toFixed(4) + '%）。' +
      '得到的是這一刻把賣出金額全部換過去，能換到幾股。費率與上方試算同一組。</dd>' +
    '<dt>比較基準</dt><dd>只跟今天的自己比，不跟別檔比，也沒有固定門檻。每一列的「跟現在差」' +
      '是那一刻的股數減掉最新一筆，所以零點永遠是現在；釘在上面的最佳與最差是今天累積到的上下界。</dd>' +
    '<dt>白話意義</dt><dd>同樣賣掉這些張數，剛才那個時點換，比現在多拿或少拿幾股。</dd>' +
    '<dt>機制</dt><dd>換到幾股只看兩邊價格的比，不看各自漲跌多少。兩檔同方向、同比例一起動，' +
      '比不變，這張表不會多一列；只有一邊動得比另一邊多，比才會變。所以每多一列，' +
      '都代表兩檔的相對強弱真的變了，不只是行情在跑。這也是百分比會給出相反結論的原因：' +
      '同樣一塊錢放在低價那一檔，算出來的百分比比較大，看百分比會以為低價那檔比較強，' +
      '但決定換到幾股的是兩邊價格的比，不是各自的百分比。</dd>' +
    '<dt>行動含義</dt><dd>先看今日區間有多寬。區間只有幾股，代表今天什麼時候換都差不多，不必盯盤；' +
      '區間拉開到幾十股以上，挑時點才有意義，這時再看現在靠近最佳還是最差那一端。</dd>' +
    '<dt>不能告訴你什麼</dt><dd>只管價格換算。不管賣掉的是獲利了結還是認賠，不管兩檔的配息時間差，' +
      '也不管買進那一檔之後會不會繼續跌。今天的區間不能外推到明天，隔日開盤重新累積。' +
      '要判斷該不該換，還要看上面的換手品質。</dd>' +
    '<dt>限制</dt><dd>只記一組配對，換成別的賣買組合，前一組的歷程會被取代。' +
      '重新整理頁面不會清空，隔日自動換新。盤後沒有成交推送，表會停在收盤那一筆。</dd>' +
    '</dl></div>';
  return h;
}

// 由換股試算的結果區呼叫：決定配對、補訂閱，回傳這一塊的 HTML
function _swlHtml(c) {
  if (!c.sellRows.length || !c.buyRows) { _swlPair = null; return ''; }
  var buys = c.buyRows.filter(function (r) { return r && r.sh > 0; });
  if (c.sellRows.length !== 1 || buys.length !== 1) { _swlPair = null; return ''; }
  var s = c.sellRows[0], b = buys[0];
  var key = _divTwDate().iso + '|' + s.code + '|' + b.code;
  if (key !== _swlKey) { _swlKey = key; _swlRows = _swlLoad(key); }
  _swlPair = { s: s.code, b: b.code, sh: s.sh, lockS: s.px, lockB: b.px };
  _swlEnsureSub([s.code, b.code]);
  _swlSeed();
  return '<div class="sec-title">換股比歷程（盤中逐筆）</div><div id="swl-box">' + _swlInner() + '</div>';
}
