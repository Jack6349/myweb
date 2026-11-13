// 股利總管 Web — 交易資訊（三框：台幣交割 / 今日委託與成交彙整 / 交易紀錄(已實現損益)）
// 上左：settlements（T/T+1/T+2 應收付）；上右：order/trades（委託+成交併一列）；下半：沿用 trades.js

async function startTxinfo() {
  var errEl = document.getElementById('tx-error');
  errEl.style.display = 'none';
  if (!(await checkServer())) { errEl.style.display = 'block'; errEl.innerHTML = serverDownHtml(); return; }
  loadSettleBox();
  loadOrderBox();
  initTradeDates();
  loadTrades(); // 下半框沿用交易紀錄（元素 id 不變）
}
function refreshTxinfo() { loadSettleBox(); loadOrderBox(); }

// ── 上左：台幣交割（券商交割 ＋ 預計進出 ＋ 配息入帳，依日期排出帳上餘額）──
// 原本只有券商那三筆。只看交割回答得了「要付多少」，回答不了「付得出來嗎」——
// 後者要有起點（帳戶餘額）、要有其他會動的錢（提領、入金、配息），而且要照日期排。
// 日期怎麼判斷「已經在餘額裡」統一寫在 acct.js 的檔頭，這裡不重複一套。
async function loadSettleBox() {
  var el = document.getElementById('tx-settle-body');
  el.innerHTML = '<div class="modal-loading">查詢中…</div>';
  try {
    var rows = await fetchSettlements();
    _abSettle = rows || [];
    var sp = splitSettlements(rows || []);
    var f = abFlow(rows || []);
    var bal = f.start, abDay = abAtDay();
    var today = _divTwDate().iso;

    var html = '<table class="tx-settle-table"><thead><tr><th>日期</th><th>項目</th>'
      + '<th class="num">金額</th>'
      + '<th class="num" title="帳戶餘額依日期套上這些進出之後，那一天結束時帳上剩多少。'
      + '輸入餘額之前就已經扣掉或入帳的不再算一次。沒填帳戶餘額時整欄是「—」">餘額</th>'
      + '<th></th></tr></thead><tbody>';

    // 起點列：看得見起點，下面每一列的餘額才有依據
    html += '<tr class="tx-cf-start"><td>' + (abDay ? abDay.slice(5).replace('-', '/') : '—') + '</td>'
      + '<td>帳戶餘額<span class="tx-st">起點</span></td><td class="num"></td>'
      + '<td class="num tx-bal">' + (bal == null ? '<span class="dm-dim">未填</span>' : abMoney(bal)) + '</td>'
      + '<td></td></tr>';

    if (!f.rows.length) {
      html += '<tr><td colspan="5" class="tx-cf-none">沒有待交割、預計進出或未入帳的配息</td></tr>';
    }
    f.rows.forEach(function (x) {
      var d = (x.d || '').slice(5).replace('-', '/');
      var due = x.kind === 'settle' && settleIsDueToday(x.ref, sp.today);
      var paid = x.kind === 'settle' && settleIsPaid(x.ref, sp.today);
      var tag = x.kind === 'plan' ? '<span class="tx-kind k-plan">自訂</span>'
        : (x.kind === 'div' ? '<span class="tx-kind k-div">配息</span>'
                            : '<span class="tx-kind k-stl">交割</span>');
      // 已扣款但仍列出：它不在輸入當時的餘額裡（餘額是更早填的），所以照樣要扣。
      // 標出來，否則看起來像重複計算。
      var pill = paid ? '<span class="tx-paid">已扣款</span>'
        : (due ? '<span class="tx-due">今日 ' + SETTLE_PAID_HOUR + ':00 交割</span>' : '');
      html += '<tr class="' + (x.kind === 'plan' ? 'tx-cf-plan' : (due ? 'tx-settle-due' : '')) + '">'
        + '<td class="tx-sd">' + d + '</td>'
        + '<td>' + tag + x.label + pill + '</td>'
        + '<td class="num ' + (x.amt > 0 ? 'up' : (x.amt < 0 ? 'down' : '')) + '">' + abSigned(x.amt) + '</td>'
        + '<td class="num tx-bal">' + (x.bal == null ? '<span class="dm-dim">—</span>'
            : '<span class="' + (x.bal < 0 ? 'tx-bal-neg' : '') + '"'
              + (x.bal < 0 ? ' title="這一天之後帳上不夠，要先入金"' : '') + '>' + abMoney(x.bal) + '</span>')
        + '</td>'
        + '<td class="tx-cf-act">' + (x.kind === 'plan'
            ? '<button class="swap-mini" title="刪除這筆" onclick="apDel(\'' + x.id + '\').then(abRefreshViews)">✕</button>'
            : '') + '</td></tr>';
    });

    var tot = sp.pending;
    var tcls = tot > 0 ? 'up' : (tot < 0 ? 'down' : '');
    html += '<tr class="tx-settle-total"><td></td><td>合計待交割</td><td class="num ' + tcls + '">' +
      (tot === 0 ? '0' : tot.toLocaleString('zh-TW')) + '</td>' +
      '<td class="num tx-bal">' + (f.end == null ? '<span class="dm-dim">—</span>'
        : '<span class="' + (f.end < 0 ? 'tx-bal-neg' : '') + '"'
          + (f.end < 0 ? ' title="全部走完之後帳上不夠，要先入金"' : '') + '>' + abMoney(f.end) + '</span>')
      + '</td><td></td></tr></tbody></table>';

    // ── 過期的預計進出：不自動清掉，先問 ──
    var od = apOverdue();
    if (od.length) {
      html += '<div class="tx-od"><div class="tx-od-t">這幾筆過了日期，已經停止計入餘額</div>';
      od.forEach(function (p) {
        html += '<div class="tx-od-r"><span class="tx-od-d">' + p.date.slice(5).replace('-', '/') + '</span>'
          + '<span class="tx-od-m">' + (p.memo || ((p.amt || 0) < 0 ? '提領' : '入金')) + '</span>'
          + '<span class="num tx-od-a ' + ((p.amt || 0) > 0 ? 'up' : 'down') + '">' + abSigned(p.amt) + '</span>'
          + '<button class="btn-query" title="這筆錢真的動了：併進帳戶餘額並刪掉這一列"'
          + ' onclick="apApply(\'' + p.id + '\').then(abRefreshViews)">已扣</button>'
          + '<button class="btn-query" title="還沒發生：改成明天，之後再調"'
          + ' onclick="apPostpone(\'' + p.id + '\')">沒扣</button>'
          + '<button class="swap-mini" onclick="apDel(\'' + p.id + '\').then(abRefreshViews)">刪除</button></div>';
      });
      html += '</div>';
    }

    // ── 新增一筆預計進出 ──
    html += '<div class="tx-add"><span class="tx-add-t">預計進出</span>'
      + '<input id="ap-d" class="ap-in ap-date" type="date" value="' + today + '" title="發生日期">'
      + '<input id="ap-a" class="ap-in ap-amt" type="text" inputmode="numeric" placeholder="金額" '
      + 'title="負數＝提領、轉出；正數＝入金、轉入" onkeydown="if(event.key===\'Enter\')apAddFromForm()">'
      + '<input id="ap-m" class="ap-in ap-memo" type="text" placeholder="說明（選填）" '
      + 'onkeydown="if(event.key===\'Enter\')apAddFromForm()">'
      + '<button class="btn-query" onclick="apAddFromForm()">＋ 加入</button>'
      + '<span id="ap-msg" class="wt-dim"></span></div>';

    html += '<div class="detail-note nb">金額負數＝付出（銀行扣款、提領），正數＝收到（應收、入金、配息）。'
      + '扣款門檻是交割日當天 ' + SETTLE_PAID_HOUR + ':00（銀行營業時間）。'
      + (sp.dueRows.length
          ? '<b>今日 ' + SETTLE_PAID_HOUR + ':00 待交割 ' + sp.dueToday.toLocaleString('zh-TW') + '</b>，'
            + '過了就會從「合計待交割」移出。'
          : '')
      + '<br><b>餘額欄怎麼算</b>：起點是你在總覽「部位與配置」填的帳戶餘額'
      + (bal == null
          ? '，目前<b>未填</b>，所以整欄是「—」。券商 API 給得出交割應收付，給不出銀行帳戶裡有多少錢，那兩件事在不同機構。'
          : '（' + bal.toLocaleString('zh-TW') + (abDay ? '，於 ' + abDay + ' 輸入' : '') + '）。'
            + '往後只加減<b>那一刻之後才會動的錢</b>：輸入前就扣掉的交割、輸入前就入帳的配息都不再算一次。'
            + '所以一筆標「已扣款」的交割仍然可能列在上面——它現在扣掉了，但它不在你當初填的那個數字裡。')
      + '<br><b>配息入帳</b>：'
      + (f.hasDiv ? '取自股利估算的月度結果（可領張數已依建倉明細判定），只列發放日還沒到的。'
                  : '<b>未計入</b>——股利估算頁這次還沒載入過，拿不到發放日與金額。'
                    + '<button class="btn-query" onclick="txLoadDiv()">載入配息</button>'
                    + '沒有它，下面的餘額只扣不加，會比實際低。')
      + '<br><b>預計進出</b>：提領、入金這類券商看不到的動帳，自己排進來。'
      + '過了日期不會自動消失——直接刪掉的話，萬一你還沒更新帳戶餘額，往後的餘額會悄悄多出那一筆。'
      + '過期的會停止計入並列在表格下方，按「已扣」才併進帳戶餘額。</div>';
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="modal-loading">查詢失敗：' + e.message + '</div>'; }
}
// 配息入帳要股利估算的結果。它是重活（逐檔抓配息紀錄），不自動跑，按了才跑。
async function txLoadDiv() {
  var m = document.getElementById('ap-msg');
  if (m) m.textContent = '載入配息資料…';
  try { if (typeof startDividendEst === 'function') await startDividendEst(false); }
  catch (e) { hush('txinfo', e); }
  loadSettleBox();
}
async function apAddFromForm() {
  var d = document.getElementById('ap-d'), a = document.getElementById('ap-a'), m = document.getElementById('ap-m');
  var msg = document.getElementById('ap-msg');
  var raw = String(a.value || '').replace(/[,\s元]/g, '');
  var v = raw === '' ? null : Number(raw);
  if (!d.value) { if (msg) msg.textContent = '要先選日期'; return; }
  if (v == null || !isFinite(v) || v === 0) { if (msg) msg.textContent = '金額要是數字，負數＝提領、正數＝入金'; return; }
  await apAdd(d.value, v, String(m.value || '').trim());
  loadSettleBox();
}
// 「沒扣」＝還沒發生，往後挪一天。挪到哪一天使用者自己最清楚，
// 這裡只負責讓它離開過期狀態，不替他猜日期。
async function apPostpone(id) {
  var t = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
  await apSet(id, { date: t });
  loadSettleBox();
}

// ── 上右：今日委託與成交彙整 ──
function _hms(ts) {
  if (!ts) return '';
  var d = new Date(ts * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}
// 狀態膠囊：失敗訊息與取消張數皆併入狀態呈現
function _stPill(t) {
  var s = t.status || {}, st = s.status || '', dq = s.deal_quantity || 0, cq = s.cancel_quantity || 0, oq = (t.order || {}).quantity || 0;
  if (st === 'Filled') return '<span class="st-pill st-ok">全部成交</span>';
  if (st === 'PartFilled' || st === 'Filling') return '<span class="st-pill st-part">部分成交 ' + dq + '/' + oq + '</span>';
  if (st === 'Cancelled') return '<span class="st-pill st-cancel">已取消' + (cq ? ' ' + cq : '') + (dq ? '（成交' + dq + '）' : '') + '</span>';
  if (st === 'Failed') {
    var msg = (s.msg || '').trim();
    return '<span class="st-pill st-fail" title="' + msg.replace(/"/g, '&quot;') + '">失敗' + (msg ? '：' + (msg.length > 12 ? msg.slice(0, 12) + '…' : msg) : '') + '</span>';
  }
  return '<span class="st-pill st-wait">委託中</span>'; // PendingSubmit / PreSubmitted / Submitted
}
// 有效委託價：在券商 App 改價後，order.price 仍是原始價，新價在 status.modified_price。
// 實測 2026-10-15 的 00988B：order.price 19.07、status.modified_price 19.06，兩者並存。
// 排隊推估要比對價位、損益要用成交對照價，全部都該用改價後的那個。
function _txPx(t) {
  var s = t.status || {}, o = t.order || {};
  return (s.modified_price > 0) ? +s.modified_price : +(o.price || 0);
}
function _txModified(t) {
  var s = t.status || {}, o = t.order || {};
  return (s.modified_price > 0 && +s.modified_price !== +(o.price || 0)) ? +(o.price || 0) : null;
}

// ── 委託排隊前方張數（推估）──
// 交易所與券商都不揭露排隊序位，只能用逐筆成交回推：
//   1) 取委託時間之後第一筆成交，讀當下同價位的委賣（賣單）／委買（買單）總量，扣掉自己未成交張數＝掛單當下前方張數
//   2) 之後累加「成交價＝委託價」的成交量，視為前方隊伍被消化的部分
//   3) 前方張數 − 已消化＝目前推估；已有部分成交代表前面清空，直接回 0
// 誤差：前方有人取消看不到（估計偏高）；委託到第一筆成交之間的變化算在前方；委託價非當時最佳一檔時無法估計。
var _txTicks = {};   // code → 當次查詢的逐筆成交（每次重新整理清空）
async function _txTicksOf(code) {
  if (_txTicks[code] !== undefined) return _txTicks[code];
  try {
    var day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    var r = await fetch('/api/v1/data/ticks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: { security_type: 'STK', exchange: ((typeof _contracts !== 'undefined' && _contracts[code]) || {}).exchange || 'TSE', code: code }, date: day })
    });
    _txTicks[code] = r.ok ? await r.json() : null;
  } catch (e) { _txTicks[code] = null; }
  return _txTicks[code];
}
function _txLive(t) {
  var st = (t.status || {}).status || '';
  return st === 'PendingSubmit' || st === 'PreSubmitted' || st === 'Submitted' || st === 'PartFilled' || st === 'Filling';
}
// all＝今日全部委託，用來找「同代號同買賣同價位、比本筆更早且仍未成交」的自己人：
// 基準的價位總量把它們也算在裡面，不扣掉會高估前方張數（同一價位分批掛單時特別明顯）。
function _txOwnEarlier(t, all) {
  var o = t.order || {}, s = t.status || {}, code = (t.contract || {}).code || '';
  var sum = 0;
  (all || []).forEach(function (x) {
    if (x === t || !_txLive(x)) return;
    var xo = x.order || {}, xs = x.status || {};
    if ((x.contract || {}).code !== code || xo.action !== o.action || _txPx(x) !== _txPx(t)) return;
    if ((xs.order_ts || 0) > (s.order_ts || 0)) return;            // 晚於本筆 → 排在後面，不算前方
    sum += (xo.quantity || 0) - (xs.deal_quantity || 0);
  });
  return sum;
}
async function _txAhead(t, all) {
  var o = t.order || {}, s = t.status || {}, code = (t.contract || {}).code || '';
  var left = (o.quantity || 0) - (s.deal_quantity || 0);
  if (!_txLive(t) || left <= 0) return null;                                  // 已成交／取消／失敗
  if (o.order_lot && o.order_lot !== 'Common') return { na: '盤中零股另一本委託簿，無法用逐筆五檔推估' };
  if (s.deal_quantity > 0) return { ahead: 0, note: '已有部分成交，前方已清空' };
  var j = await _txTicksOf(code);
  var dt = j && j.datetime;
  if (!dt || !dt.length) return { na: '今日尚無逐筆成交資料' };
  var hm = new Date((s.order_ts || 0) * 1000 + 8 * 3600000).toISOString().slice(11, 19);
  var base = -1;
  for (var i = 0; i < dt.length; i++) { if (String(dt[i]).slice(11, 19) >= hm) { base = i; break; } }
  if (base < 0) return { na: '委託後尚無成交，無法取基準' };
  var buy = o.action === 'Buy';
  var lvlP = buy ? j.bid_price : j.ask_price, lvlV = buy ? j.bid_volume : j.ask_volume;
  if (+lvlP[base] !== _txPx(t)) return { na: '委託價非當時最佳一檔（逐筆只揭示最佳檔），無法估計' };
  var atOrder = lvlV[base];
  var own = _txOwnEarlier(t, all);                                 // 自己較早、同價位未成交的張數（仍排在前面，但標示出來）
  var ahead0 = Math.max(0, atOrder - left);
  var used = 0;
  for (var k = base; k < dt.length; k++) { if (+j.close[k] === _txPx(t)) used += j.volume[k]; }
  var lastLvl = null;
  for (var m = dt.length - 1; m >= 0; m--) { if (+lvlP[m] === _txPx(t)) { lastLvl = { t: String(dt[m]).slice(11, 19), v: lvlV[m] }; break; } }
  return { ahead: Math.max(0, ahead0 - used), ahead0: ahead0, used: used, atOrder: atOrder, own: own,
    baseT: String(dt[base]).slice(11, 19), lastLvl: lastLvl };
}
// 顏色分級：越少越快輪到 → 綠；中等 → 黃；很多 → 紅
function _txAheadCls(n) { return n <= 100 ? 'tx-ahead-low' : (n <= 500 ? 'tx-ahead-mid' : 'tx-ahead-high'); }
function _txAheadHtml(a) {
  if (!a) return '<span class="tx-dim">—</span>';
  if (a.na) return '<span class="tx-dim" title="' + a.na + '">無法估計</span>';
  var tip = a.note ? a.note :
    ('掛單當下（' + a.baseT + '）同價位 ' + a.atOrder + ' 張，扣掉自己這筆 ' + (a.atOrder - a.ahead0) + ' 張 → 前方 ' + a.ahead0 + ' 張\n' +
     (a.own ? '其中同價位還有你自己較早的委託 ' + a.own + ' 張\n' : '') +
     '委託後該價位已成交 ' + a.used + ' 張 → 目前前方約 ' + a.ahead + ' 張' +
     (a.lastLvl ? '\n最新（' + a.lastLvl.t + '）該價位總量 ' + a.lastLvl.v + ' 張（含排在你後面的）' : '') +
     '\n推估值：前方有人取消看不到，實際可能更少');
  return '<span class="tx-ahead ' + _txAheadCls(a.ahead) + '" title="' + tip + '">' +
    (a.ahead > 0 ? '約 ' + a.ahead.toLocaleString('zh-TW') : '0') + '</span>';
}

// 沒有委託時的空畫面。開盤前要多講一句預約單，否則凌晨掛完五筆預約單走進來
// 只看到「今日無委託」，會以為單沒掛成功。
//
// 預約單真的拿不到：2026-11-07 01:03 實測，券商 App 顯示五筆預約中（00:54–00:57），
// 但 /order/trades 回空陣列、/order/order_deal_records 只有前一交易日 11/06 09:44–11:57 的 35 筆，
// 五個委託書編號在任何回應裡都出現 0 次。整份 API 也沒有預約單端點
// （stock_reserve_* 是圈存，不是預約下單）。預約單在送進交易所前只存在券商自己的系統，
// Shioaji 的委託簿還沒有這筆，要等開盤前送出才會變成一般委託。
function _txEmptyHtml() {
  var tw = new Date(Date.now() + 8 * 3600000);
  var hm = tw.getUTCHours() * 60 + tw.getUTCMinutes();
  // 台股 08:30 起接受委託，預約單在那之後才會送入委託簿 → 只在 00:00–08:30 多講這句
  var preOpen = hm < 510;
  return '<div class="modal-loading">今日無委託' +
    (preOpen ? '<div class="tx-empty-note">預約單不在此列：券商 API 不回傳預約中的委託，' +
      '要等開盤前（台股 08:30 起接受委託）送入委託簿後才會出現。</div>' : '') +
    '</div>';
}

async function loadOrderBox() {
  var el = document.getElementById('tx-order-body');
  el.innerHTML = '<div class="modal-loading">查詢中…</div>';
  try {
    _txTicks = {};                                  // 每次重新整理重抓逐筆（盤中持續增加）
    var trades = await fetchOrderTrades();
    if (!trades || !trades.length) { el.innerHTML = _txEmptyHtml(); return; }
    trades.sort(function (a, b) { return ((b.status || {}).order_ts || 0) - ((a.status || {}).order_ts || 0); }); // 新→舊
    // 名稱：_contracts 要等行情引擎啟動才有，缺的代號就地查合約補進共用快取
    var needName = {};
    trades.forEach(function (t) {
      var code = (t.contract || {}).code || '';
      if (code && !(typeof _contracts !== 'undefined' && _contracts[code])) needName[code] = true;
    });
    for (var code in needName) {
      try { _contracts[code] = await fetchContract(code); } catch (e) { console.warn('[txinfo contract]', code, e); }
    }
    var buyAmt = 0, sellAmt = 0, buyOpen = 0, sellOpen = 0;
    var html = '<div class="tx-otable-wrap"><table class="tx-otable"><thead><tr>' +
      '<th class="sort-th" data-key="code" onclick="txSortCol(\'code\')">商品<span class="sort-ind">↕</span></th><th class="sort-th" data-key="side" onclick="txSortCol(\'side\')">買賣<span class="sort-ind">↕</span></th><th class="num">委託</th><th class="num" title="現價 － 基準價。已成交部分的基準價是成交均價；&#10;未成交（含已取消、失敗）用委託價，標「對委託價」；&#10;部分成交兩個都列，小字那個是剩餘量。&#10;紅＝現價高於基準價（買單即尚未輪到），綠＝低於">差額</th><th class="num sort-th" data-key="pnl" onclick="txSortCol(\'pnl\')" title="買進：現值（扣賣出手續費＋交易稅）－成本（含買進手續費），同持股庫存明細的未實現損益&#10;賣出：(成交均價－現價)×股數×(1−手續費－交易稅)，正＝賣在現價之上。兩邊都扣賣出成本，同價為 0">損益<span class="sort-ind">↕</span></th><th class="num sort-th" data-key="stl" onclick="txSortCol(\'stl\')" title="這一筆實際會扣款或入帳多少。&#10;買進＝−成交均價×股數×(1＋買進手續費)，賣出＝＋成交均價×股數×(1−賣出手續費與交易稅)。&#10;費率與左邊「損益」同一組。這是估值，券商的正式數字在上方「台幣交割」">交割金額<span class="sort-ind">↕</span></th><th class="num" title="盤中隨報價更新；漲跌幅與昨收比：紅漲、綠跌、黃平">現價</th><th class="num" title="成交數量、成交均價；與現價的差額在委託後面那一欄">成交</th>' +
      '<th class="sort-th" data-key="status" onclick="txSortCol(\'status\')">狀態<span class="sort-ind">↕</span></th>' + '<th class="num" title="推估仍排在你前面的張數：以委託後第一筆逐筆成交的同價位總量為基準，扣掉自己並減去之後該價位的成交量">前方(張)</th>' +
      '<th>書號</th>' + '<th class="sort-th num" data-key="time" onclick="txSortCol(\'time\')">委託時間<span class="sort-ind">↕</span></th>' + '</tr></thead><tbody>';
    var aheads = await Promise.all(trades.map(function (t) { return _txAhead(t, trades).catch(function () { return null; }); }));
    trades.forEach(function (t, ti) {
      var o = t.order || {}, s = t.status || {}, code = (t.contract || {}).code || '';
      var c = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
      var buy = o.action === 'Buy';
      var unit = (o.order_lot && o.order_lot !== 'Common') ? '股' : '張';
      var mult = unit === '張' ? 1000 : 1; // 成交金額換算（張→股）
      var tif = (o.order_type && o.order_type !== 'ROD') ? ' ' + o.order_type : ''; // ROD 常態不顯示
      var deals = s.deals || [];
      var dq = 0, dsum = 0;
      deals.forEach(function (d) { dq += d.quantity; dsum += d.price * d.quantity; });
      var avg = dq ? (dsum / dq) : null;
      if (buy) buyAmt += dsum * mult; else sellAmt += dsum * mult;
      // 未成交金額＝（委託量 － 已成交量）× 委託價。只計仍在簿上的委託：
      // 已取消／失敗的單也有未成交數量，但那些不會再成交，算進來等於虛報。
      // 價用 _txPx（改價後的有效價），不是 order.price。
      if (_txLive(t)) {
        var openQ = (o.quantity || 0) - (s.deal_quantity || 0);
        if (openQ > 0) {
          var openAmt = openQ * _txPx(t) * mult;
          if (buy) buyOpen += openAmt; else sellOpen += openAmt;
        }
      }
      var dealTitle = deals.length > 1 ? deals.map(function (d) {
        return d.quantity + unit + ' ' + d.price.toFixed(2) + ' ' + _hms(d.ts);
      }).join('　') : '';
      html += '<tr data-code="' + code + '" data-side="' + (buy ? 0 : 1) + '" data-st="' + _txStRank(t) + '" data-ts="' + (s.order_ts || 0) + '">' +
        '<td><span class="tx-ocode">' + code + '</span><span class="tx-oname">' + ((c && c.name) || '') + '</span></td>' +
        '<td class="' + (buy ? 'up' : 'down') + '">' + (buy ? '買進' : '賣出') + '</td>' +
        '<td class="num">' + o.quantity + unit + '<span class="tx-gap"></span>' + _txPx(t).toFixed(2) +
          (_txModified(t) != null
            ? '<span class="tx-oldpx" title="原始委託價 ' + _txModified(t).toFixed(2) + '，已改價">原 ' +
              _txModified(t).toFixed(2) + '</span>'
            : '') +
          (tif ? '<span class="tx-tif">' + tif.trim() + '</span>' : '') + '</td>' +
        '<td class="num tx-ddcell">' + _txDdCell(t, code, avg, dq) + '</td>' +
        '<td class="num tx-pnl"' + (dq ? ' data-code="' + code + '" data-avg="' + avg + '" data-sh="' + (dq * mult) + '" data-side="' + (buy ? 'B' : 'S') + '"' : '') + '>' +
          (dq ? _txPnlHtml(code, avg, dq * mult, buy) : '<span class="swap-dim">—</span>') + '</td>' +
        '<td class="num tx-stl"' + (dq ? ' data-stl="' + _txSettleVal(avg, dq * mult, buy) + '"' : '') + '>' +
          (dq ? _txSettleHtml(avg, dq * mult, buy) : '<span class="swap-dim">—</span>') + '</td>' +
        '<td class="num tx-px" data-code="' + code + '">' + _txPxHtml(code) + '</td>' +
        '<td class="num"' + (dealTitle ? ' title="' + dealTitle + '"' : '') + '>' +
          (dq ? '<span class="tx-deal">' + dq + unit + '<span class="tx-gap"></span>' + avg.toFixed(2) + '</span>' +
            (deals.length > 1 ? '<span class="tx-dealn">分 ' + deals.length + ' 筆</span>' : '') : '—') + '</td>' +
        '<td>' + _stPill(t) + '</td>' +
        '<td class="num">' + _txAheadHtml(aheads[ti]) + '</td>' +
        '<td class="tx-dseq">' + ((o.ordno || '').trim() || '—') + '</td>' +
        '<td class="num">' + _hms(s.order_ts) + '</td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
    _txApplySort();
    _txPxStart();
    // 標題右側：今日買進/賣出/合計成交金額（合計＝賣出−買進；正紅負綠，與交割應收付一致）
    var sumEl = document.getElementById('tx-order-sum');
    if (sumEl) {
      var net = sellAmt - buyAmt;
      var ncls = net > 0 ? 'up' : (net < 0 ? 'down' : '');
      sumEl.innerHTML = '買進 <span class="up">' + Math.round(buyAmt).toLocaleString('zh-TW') + '</span>' +
        '｜賣出 <span class="down">' + Math.round(sellAmt).toLocaleString('zh-TW') + '</span>' +
        '｜合計 <span class="' + ncls + '">' + (net > 0 ? '+' : '') + Math.round(net).toLocaleString('zh-TW') + '</span>' +
        '｜損益 <span id="tx-pnl-sum" title="下方各筆「損益」加總（買賣皆已扣手續費與交易稅），隨現價更新">' + _txPnlSumHtml() + '</span>' +
        // 未成交：還掛在簿上、尚未成交的部分。ROD 當日有效，收盤後一律是 0，
        // 所以沒有未成交時整段不顯示，避免盤後每天都掛一行 0。
        ((buyOpen || sellOpen)
          ? '　<span class="tx-open-sum" title="仍掛在委託簿上、尚未成交的部分：（委託量 － 已成交量）× 委託價。' +
            '已取消與失敗的單不計。買進＝若全部成交要付出的金額，賣出＝可收到的金額（皆未扣手續費與交易稅）。' +
            'ROD 當日有效，收盤後會歸零">未成交 買 <b class="up">' + Math.round(buyOpen).toLocaleString('zh-TW') +
            '</b>｜賣 <b class="down">' + Math.round(sellOpen).toLocaleString('zh-TW') + '</b></span>'
          : '');
    }
  } catch (e) { el.innerHTML = '<div class="modal-loading">查詢失敗：' + e.message + '</div>'; }
}

// ── 委託列表「現價」：盤中隨報價更新 ──
// 來源：持股中的代號已有行情推送（_rows，tick SSE／補價 watchdog 會持續更新）→ 直接讀；
// 非持股（例：新買進前的委託、已全數賣出的標的）沒有推送 → 每 5 秒以快照補（一次查多檔，成本低）。
// 只在委託列表顯示中、且為交易時段才動作；每 2 秒重繪一次儲存格，價格變動時閃一下。
var _txSnapPx = {}, _txPxTimer = null, _txPxN = 0;
function _txPxOf(code) {
  var r = (typeof _rows !== 'undefined') && _rows[code];
  if (r && r.close != null) return r.close;
  return _txSnapPx[code] != null ? _txSnapPx[code] : null;
}
function _txPxHtml(code) {
  var px = _txPxOf(code);
  if (px == null) return '<span class="swap-dim">—</span>';
  var ref = (typeof _contracts !== 'undefined' && _contracts[code] && _contracts[code].reference) || null;
  var cls = ref == null ? '' : (px > ref ? 'up' : (px < ref ? 'down' : 'tx-flat'));
  // 漲跌幅（與昨收比）；小字接在價格後，同色
  var pct = ref ? (px - ref) / ref * 100 : null;
  var pctTxt = pct == null ? '' : '<span class="tx-pct">' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
  return '<span class="' + cls + '">' + (+px).toFixed(2) + pctTxt + '</span>';
}
// 成交欄的價差＝現價－成交均價：正紅（現價高於成交價）、負綠、0 黃
// 差額 ＝ 現價 − 基準價。基準價有兩種：已成交的那部分用成交均價，
// 還掛在簿上（或完全未成交）的用委託價。兩種混在同一欄，
// 用委託價算的必須標出來，否則看不出哪個是哪個。
// 顏色汿用同一套：紅＝現價高於基準價（買單就是「還沒輪到你」）。
function _txDiffHtml(code, base, byOrder) {
  var px = _txPxOf(code);
  if (px == null || !(base > 0)) return '<span class="swap-dim">—</span>';
  var d = Math.round((px - base) * 100) / 100;
  var cls = d > 0 ? 'up' : (d < 0 ? 'down' : 'tx-flat');
  return '<span class="' + cls + '">' + (d > 0 ? '+' : '') + d.toFixed(2) + '</span>'
    + (byOrder ? '<span class="tx-ddbase">對委託價</span>' : '');
}
// 差額那一格。無論是否成交都算：
//   全部未成交（含已取消／失敗）→ 對委託價
//   部分成交             → 主行對成交均價，小字再給剩餘量對委託價的那一個
//   全部成交             → 只有成交均價
// 部分成交只留一個的話，改過價或分批成交時兩者差很多，等於藏掉一半。
// 委託價用 _txPx（改價後的有效價），與「委託」欄顯示的一致。
function _txDdCell(t, code, avg, dq) {
  var o = t.order || {}, s = t.status || {};
  var ordPx = _txPx(t);
  var openQ = (o.quantity || 0) - (s.deal_quantity || 0);
  var span = function (base, byOrder) {
    return '<span class="tx-dd" data-code="' + code + '" data-avg="' + base + '"'
      + (byOrder ? ' data-basis="order"' : '') + '>' + _txDiffHtml(code, base, byOrder) + '</span>';
  };
  if (!dq) return span(ordPx, 1);
  var h = span(avg, 0);
  if (openQ > 0) h += '<div class="tx-dd2">' + span(ordPx, 1) + '</div>';
  return h;
}

// 成交後損益（元）：費率與換股試算／總現值同基準
//   買進：現價×股數×(1−賣出手續費與交易稅) − 成交均價×股數×(1＋買進手續費)  ← 等同持股庫存明細的未實現損益
//   賣出：(成交均價 − 現價)×股數×(1−賣出手續費與交易稅)  ← 賣出實拿 vs 留到現在才賣實拿
//
// 賣出那條 2026-10-02 修正。原本是「賣出淨額(已扣費) − 現價×股數(未扣費)」，
// 兩邊基準不同：賣掉的扣了 0.2265%，留著的沒扣，等於每一筆賣出都先被記上一筆
// 費用當虧損。實例：00407A 賣 10 張 @10.24、現價 10.23，賣得比現價高卻顯示 −132。
// 成交價與現價相同時更明顯，會顯示 −232 而不是 0。
// 留著的部位將來也要付同一筆賣出成本，兩邊都扣才比得過去；扣完同價就是 0。
var TX_SELL_COST = 0.002265, TX_BUY_FEE = 0.001425;
function _txPnlVal(code, avg, sh, buy) {
  var px = _txPxOf(code);
  if (px == null || !(avg > 0) || !(sh > 0)) return null;
  return Math.round(buy ? px * sh * (1 - TX_SELL_COST) - avg * sh * (1 + TX_BUY_FEE)
                        : (avg - px) * sh * (1 - TX_SELL_COST));
}
// 交割金額（元）：這一筆實際會從帳戶扣多少、或入多少。
//   買進：− 成交均價 × 股數 × (1 ＋ 買進手續費)      ← 應付
//   賣出：＋ 成交均價 × 股數 × (1 − 賣出手續費與交易稅) ← 應收
// 費率跟旁邊「損益」那一欄用同一組，兩欄才比得起來。
//
// 這是估值，不是券商的帳：實際扣款的手續費會取整、也可能有折扣。
// 券商的正式數字在上方「台幣交割」那一框。
function _txSettleVal(avg, sh, buy) {
  if (!(avg > 0) || !(sh > 0)) return null;
  return Math.round(buy ? -avg * sh * (1 + TX_BUY_FEE) : avg * sh * (1 - TX_SELL_COST));
}
function _txSettleHtml(avg, sh, buy) {
  var v = _txSettleVal(avg, sh, buy);
  if (v == null) return '<span class="swap-dim">—</span>';
  var cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'tx-flat');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toLocaleString('zh-TW') + '</span>';
}

function _txPnlHtml(code, avg, sh, buy) {
  var v = _txPnlVal(code, avg, sh, buy);
  if (v == null) return '<span class="swap-dim">—</span>';
  var cls = v > 0 ? 'up' : (v < 0 ? 'down' : 'tx-flat');
  return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toLocaleString('zh-TW') + '</span>';
}
// 今日損益合計：下方各筆損益儲存格的加總（任一筆尚無現價時，以已有價格者加總）
function _txPnlSumHtml() {
  var tot = 0, n = 0;
  document.querySelectorAll('#tx-order-body .tx-pnl[data-code]').forEach(function (td) {
    var v = _txPnlVal(td.getAttribute('data-code'), +td.getAttribute('data-avg'), +td.getAttribute('data-sh'), td.getAttribute('data-side') === 'B');
    if (v != null) { tot += v; n++; }
  });
  if (!n) return '<span class="swap-dim">—</span>';
  var cls = tot > 0 ? 'up' : (tot < 0 ? 'down' : 'tx-flat');
  return '<span class="' + cls + '">' + (tot > 0 ? '+' : '') + tot.toLocaleString('zh-TW') + '</span>';
}
function _txPxOpen() {
  var d = new Date(Date.now() + 8 * 3600000), wd = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return wd >= 1 && wd <= 5 && m >= 9 * 60 && m <= 13 * 60 + 35;
}
async function _txPxTick() {
  var cells = document.querySelectorAll('#tx-order-body .tx-px[data-code]');
  if (!cells.length) { clearInterval(_txPxTimer); _txPxTimer = null; return; }   // 列表已關閉
  if (document.hidden) return;
  _txPxN++;
  var codes = {};
  cells.forEach(function (td) { codes[td.getAttribute('data-code')] = true; });
  // 每 5 秒（第 1、3、5… 次以外略過）補查沒有即時推送的代號
  var need = Object.keys(codes).filter(function (c) {
    var r = (typeof _rows !== 'undefined') && _rows[c];
    return !(r && r.close != null);
  });
  if (need.length && _txPxOpen() && (_txPxN % 3 === 1) && typeof fetchSnapshots === 'function') {
    try {
      var sn = await fetchSnapshots(need.map(function (c) {
        return (_contracts[c]) || { exchange: 'TSE', code: c };
      }));
      (sn || []).forEach(function (x) { if (x && x.code && x.close > 0) _txSnapPx[x.code] = +x.close; });
    } catch (e) { hush('txinfo', e); }
  }
  cells.forEach(function (td) {
    var html = _txPxHtml(td.getAttribute('data-code'));
    if (td.innerHTML !== html) {
      var first = !td.hasAttribute('data-shown');
      td.innerHTML = html;
      if (!first) { td.classList.remove('tx-px-flash'); void td.offsetWidth; td.classList.add('tx-px-flash'); }
    }
    td.setAttribute('data-shown', '1');
  });
  document.querySelectorAll('#tx-order-body .tx-pnl[data-code]').forEach(function (td) {
    var html = _txPnlHtml(td.getAttribute('data-code'), +td.getAttribute('data-avg'), +td.getAttribute('data-sh'), td.getAttribute('data-side') === 'B');
    if (td.innerHTML !== html) td.innerHTML = html;
  });
  var sumEl = document.getElementById('tx-pnl-sum');
  if (sumEl) { var sh2 = _txPnlSumHtml(); if (sumEl.innerHTML !== sh2) sumEl.innerHTML = sh2; }
  document.querySelectorAll('#tx-order-body .tx-dd[data-code]').forEach(function (sp) {
    var html = _txDiffHtml(sp.getAttribute('data-code'), +sp.getAttribute('data-avg'),
                           sp.getAttribute('data-basis') === 'order');
    if (sp.innerHTML !== html) sp.innerHTML = html;
  });
}
function _txPxStart() {
  _txPxN = 0;
  _txPxTick();
  if (!_txPxTimer) _txPxTimer = setInterval(_txPxTick, 2000);
}

// ── 委託列表排序：商品／買賣／損益／狀態／委託時間，預設委託時間新→舊 ──
// 直接在 DOM 重排列（損益隨現價變動，排序只在點選或重新查詢時套用，避免列一直跳動）
// 排序狀態存 localStorage（本機、每個瀏覽器各自記住），重新整理後維持；讀不到或值不合法時回預設
var TX_SORT_LS = 'tx_sort_v1';
var _txSort = (function () {
  try { var v = localStorage.getItem(TX_SORT_LS); if (/^(code|side|pnl|stl|status|time)(Asc|Desc)$/.test(v || '')) return v; } catch (e) {}
  return 'timeDesc';
})();
// 數字越大越前面（第一次點＝降冪）：委託中 → 部分成交 → 全部成交 → 已取消 → 失敗，還在排隊的最先看到
function _txStRank(t) {
  var st = (t.status || {}).status || '';
  if (st === 'PartFilled' || st === 'Filling') return 3;
  if (st === 'Filled') return 2;
  if (st === 'Cancelled') return 1;
  if (st === 'Failed') return 0;
  return 4;
}
function txSortCol(key) {
  _txSort = (_txSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
  try { localStorage.setItem(TX_SORT_LS, _txSort); } catch (e) {}
  _txApplySort();
}
function _txRowPnl(tr) {
  var td = tr.querySelector('.tx-pnl[data-code]');
  if (!td) return null;
  return _txPnlVal(td.getAttribute('data-code'), +td.getAttribute('data-avg'), +td.getAttribute('data-sh'), td.getAttribute('data-side') === 'B');
}
function _txApplySort() {
  var tb = document.querySelector('#tx-order-body .tx-otable tbody');
  if (!tb) return;
  var key = _txSort.replace(/(Asc|Desc)$/, ''), asc = /Asc$/.test(_txSort);
  var rows = [].slice.call(tb.rows);
  var val = function (tr) {
    if (key === 'code') return tr.getAttribute('data-code');
    if (key === 'side') return +tr.getAttribute('data-side');
    if (key === 'status') return +tr.getAttribute('data-st');
    if (key === 'pnl') return _txRowPnl(tr);
    if (key === 'stl') {
      var st = tr.querySelector('.tx-stl[data-stl]');
      return st ? +st.getAttribute('data-stl') : null;
    }
    return +tr.getAttribute('data-ts');
  };
  rows.sort(function (a, b) {
    var va = val(a), vb = val(b);
    if (va == null && vb == null) return (+b.getAttribute('data-ts')) - (+a.getAttribute('data-ts'));
    if (va == null) return 1;                     // 沒有損益（未成交）一律墊底
    if (vb == null) return -1;
    var c = key === 'code' ? String(va).localeCompare(String(vb), undefined, { numeric: true }) : va - vb;
    if (!c) return (+b.getAttribute('data-ts')) - (+a.getAttribute('data-ts'));   // 同值：新→舊
    return asc ? c : -c;
  });
  rows.forEach(function (tr) { tb.appendChild(tr); });
  document.querySelectorAll('#tx-order-body .tx-otable th.sort-th').forEach(function (th) {
    var k = th.getAttribute('data-key'), on = _txSort.indexOf(k) === 0 && _txSort.replace(/(Asc|Desc)$/, '') === k;
    th.classList.toggle('sorted', on);
    var ind = th.querySelector('.sort-ind');
    if (ind) ind.textContent = on ? (asc ? '▲' : '▼') : '↕';
  });
}
