// 股利總管 Web — 買賣紀錄（交易資訊子頁籤）
//
// 為什麼要有這一頁：台幣交割那張表把走完的日子收進每日剩餘總額之後，
// 畫面上就看不到「那一天到底是買了什麼還是賣了什麼」。券商那邊查得回來，
// 但要分兩個介面問，而且兩邊的單位與欄位都不一樣，所以在這裡接成一張表。
//
// ══════ 兩邊的來源不對稱，這是這一頁最重要的前提 ══════
//
// 賣出：已實現損益可以用日期區間查，查得到的是完整的，包含已經整批出清的標的。
// 買進：建倉明細要先有持倉編號才查得到，而持倉清單只列現在還有部位的標的。
//       已經整批出清的標的沒有編號，它的買進紀錄查不到。
//       出借中的部位不受影響，明細保留著它們（實測明細股數大於庫存彙總的那幾檔就是）。
//
// 2026-11-18 實測：過去一年有賣出紀錄的 9 檔裡，6 檔已經不在持倉清單上
// （00900、00953B、00971、00988B、00989B、2884）。這一頁會自己比對，
// 把當次查詢裡查不到買進的那幾檔列出來，不讓人以為這是完整流水。
//
// 交割日：成交日往後數兩個交易日。用辦公日曆算，不是加兩天——連假會算錯。

var _bsgBusy = false;

function _bsgYmd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}
function bsgInitDates() {
  var b = document.getElementById('bsg-begin'), e = document.getElementById('bsg-end');
  if (!b || !e || e.value) return;
  var now = new Date();
  e.value = _bsgYmd(now);
  b.value = _bsgYmd(new Date(now.getTime() - 90 * 86400000));   // 預設近三個月
}
function startBsLog() {
  bsgInitDates();
  var el = document.getElementById('bsg-body');
  if (el && !el.innerHTML) el.innerHTML = '<div class="modal-loading">按「查詢」開始</div>';
}

// 成交日 → 交割日（往後兩個交易日）。與下單視窗用同一套辦公日曆。
function _bsgSettleDay(iso) {
  var d = new Date(iso + 'T00:00:00Z'), left = 2;
  for (var i = 0; i < 30 && left > 0; i++) {
    d = new Date(d.getTime() + 86400000);
    var s = d.toISOString().slice(0, 10), w = d.getUTCDay();
    var off = (typeof _divIsOff === 'function') ? _divIsOff(s) : null;
    var isOff = (off == null) ? (w === 0 || w === 6) : off;
    if (!isOff) left--;
  }
  return d.toISOString().slice(0, 10);
}
function _bsgName(code) {
  var c = (typeof _contracts !== 'undefined' && _contracts) ? _contracts[String(code)] : null;
  return (c && c.name) || '';
}
function _bsgMoney(v) { return (v == null) ? '—' : Math.round(v).toLocaleString('zh-TW'); }

// 買進：現有部位的建倉批次。
// 金額要用「當初真的付出去的錢」，所以券商有記成本的那幾筆要把已領配息加回去
// （券商在明細裡記的是扣掉配息之後的淨額）。認購價還原的那幾筆沒有被扣過，不能再加。
// 這與台幣交割重建當天金額用的是同一條規則，兩邊對得起來才有意義。
function _bsgBuys(from, to) {
  var out = [];
  if (typeof _lotsMap === 'undefined' || !_lotsMap) return out;
  Object.keys(_lotsMap).forEach(function (code) {
    (_lotsMap[code] || []).forEach(function (l) {
      if (!l.date || l.date < from || l.date > to) return;
      var amt = (l.cost || 0) + (l.sub ? (l.div || 0) : 0);
      out.push({ d: l.date, side: 'buy', code: String(code), shares: l.shares || 0,
                 amt: amt, px: (l.shares > 0) ? amt / l.shares : null });
    });
  });
  return out;
}

async function loadBsLog() {
  if (_bsgBusy) return;
  var from = (document.getElementById('bsg-begin') || {}).value;
  var to = (document.getElementById('bsg-end') || {}).value;
  var el = document.getElementById('bsg-body');
  if (!el || !from || !to) return;
  _bsgBusy = true;
  el.innerHTML = '<div class="modal-loading">查詢中…</div>';
  try {
    var sells = [];
    if (typeof fetchProfitLoss === 'function') {
      var rows = await fetchProfitLoss(from, to);
      (rows || []).forEach(function (r) {
        if (!r || !r.date || r.date < from || r.date > to) return;
        // 清單那一層的張數是「張」，金額是價 × 股數，手續費與證交稅沒扣。
        // 要精確到元得逐筆再查明細，那是幾十支請求，這一頁的用途不需要。
        var shares = (r.quantity || 0) * 1000;
        sells.push({ d: r.date, side: 'sell', code: String(r.code), shares: shares,
                     amt: (r.price || 0) * shares, px: r.price || null, pnl: r.pnl || 0 });
      });
    }
    var buys = _bsgBuys(from, to);
    var all = buys.concat(sells).sort(function (a, b) {
      if (a.d !== b.d) return a.d < b.d ? 1 : -1;        // 新 → 舊
      return a.side === b.side ? 0 : (a.side === 'buy' ? -1 : 1);
    });
    if (!all.length) { el.innerHTML = '<div class="modal-loading">這個區間查不到買賣</div>'; _bsgBusy = false; return; }

    // 查不到買進的那幾檔：有賣出紀錄、但建倉明細裡完全沒有它。
    // 這就是前面講的那個洞，要具名列出來，不能只寫一句「可能有遺漏」。
    var lots = (typeof _lotsMap !== 'undefined' && _lotsMap) ? _lotsMap : {};
    var gone = [], seen = {};
    sells.forEach(function (s) {
      if (seen[s.code] || (lots[s.code] && lots[s.code].length)) return;
      seen[s.code] = 1; gone.push(s.code);
    });

    // ── 按交割日彙總：這一頁的主要用途 ──
    // 金額是 0 的那幾筆要記下來，不能讓它靜靜算成 0。
    // 成因：券商在建倉明細裡把那一筆的成本記成 0（銀行認購、配股會這樣），
    // 程式會去參數設定的認購價表找價來還原，找不到就維持 0。
    // 不標的話整列會畫成「—　—　+0」，看起來像一列空白，但那一天確實有成交。
    var byS = {};
    all.forEach(function (x) {
      var sd = _bsgSettleDay(x.d);
      if (!byS[sd]) byS[sd] = { d: sd, buy: 0, sell: 0, n: 0, zero: 0 };
      byS[sd].n++;
      if (!(x.amt > 0)) byS[sd].zero++;
      if (x.side === 'buy') byS[sd].buy += x.amt; else byS[sd].sell += x.amt;
    });
    var sds = Object.keys(byS).sort().reverse();

    var h = '<div class="tr-summary">'
      + '<div class="sum-item"><div class="sum-label">買進</div><div class="sum-val down">'
      + _bsgMoney(buys.reduce(function (s, x) { return s + x.amt; }, 0)) + ' 元</div></div>'
      + '<div class="sum-item"><div class="sum-label">賣出</div><div class="sum-val up">'
      + _bsgMoney(sells.reduce(function (s, x) { return s + x.amt; }, 0)) + ' 元</div></div>'
      + '<div class="sum-item"><div class="sum-label">筆數</div><div class="sum-val">'
      + all.length + '</div></div></div>';

    if (gone.length) {
      h += '<div class="bsg-warn">這幾檔查不到買進紀錄：<b>' + gone.join('、') + '</b>。'
        + '它們已經整批出清，不在持倉清單上，建倉明細要先有持倉編號才查得到。'
        + '賣出那一邊不受影響，是完整的。</div>';
    }

    // 今天（台灣日）。交割日大於今天＝錢還沒動，與已經走完的那幾天分開標。
    var today = (typeof _divTwDate === 'function') ? _divTwDate().iso : _bsgYmd(new Date());
    h += '<table class="detail-table bsg-sum"><thead><tr><th>交割日</th><th class="num">筆數</th>'
      + '<th class="num">買進</th><th class="num">賣出</th><th class="num">當天淨額</th>'
      + '</tr></thead><tbody>';
    sds.forEach(function (k) {
      var r = byS[k], net = r.sell - r.buy;
      var future = k > today;
      h += '<tr' + (future ? ' class="bsg-future"' : '') + '><td>' + k
        + (future ? '<span class="bsg-tag t-wait" title="交割日還沒到，這筆錢還沒從帳戶進出">未交割</span>' : '')
        + (r.zero ? '<span class="bsg-tag t-gap" title="這一天有 ' + r.zero
            + ' 筆算不出金額：券商在建倉明細把成本記成 0（銀行認購、配股會這樣），'
            + '要到參數設定補上認購價才還原得出來。沒補之前這一列的金額是少算的。">金額待補</span>' : '')
        + '</td>'
        + '<td class="num">' + r.n + '</td>'
        + '<td class="num">' + (r.buy ? '−' + _bsgMoney(r.buy) : '—') + '</td>'
        + '<td class="num">' + (r.sell ? '+' + _bsgMoney(r.sell) : '—') + '</td>'
        + '<td class="num ' + (net >= 0 ? 'up' : 'down') + '">'
        + (net >= 0 ? '+' : '−') + _bsgMoney(Math.abs(net)) + '</td></tr>';
    });
    h += '</tbody></table>';

    h += '<details class="nbox bsg-det"><summary>逐筆　' + all.length + ' 筆</summary>'
      + '<table class="detail-table"><thead><tr><th>成交日</th><th>交割日</th><th>買賣</th>'
      + '<th>代號</th><th>名稱</th><th class="num">股數</th><th class="num">每股</th>'
      + '<th class="num">金額</th></tr></thead><tbody>';
    all.forEach(function (x) {
      var xsd = _bsgSettleDay(x.d);
      h += '<tr><td>' + x.d + '</td><td>' + xsd
        + (xsd > today ? '<span class="bsg-tag t-wait">未交割</span>' : '') + '</td>'
        + '<td><span class="tx-kind ' + (x.side === 'buy' ? 'k-stl' : 'k-plan') + '">'
        + (x.side === 'buy' ? '買' : '賣') + '</span></td>'
        + '<td>' + x.code + '</td><td>' + _bsgName(x.code) + '</td>'
        + '<td class="num">' + (x.shares || 0).toLocaleString('zh-TW') + '</td>'
        + '<td class="num">' + (x.px == null ? '—' : x.px.toFixed(2)) + '</td>'
        + '<td class="num ' + (x.side === 'buy' ? 'down' : 'up') + '">'
        + ((x.amt > 0) ? (x.side === 'buy' ? '−' : '+') + _bsgMoney(x.amt)
            : '<span class="bsg-tag t-gap" title="券商在建倉明細把這一筆的成本記成 0，'
              + '要到參數設定補上認購價才還原得出金額">金額待補</span>') + '</td></tr>';
    });
    h += '</tbody></table></details>';

    h += '<div class="detail-note">這一頁回答的是「某一天的交割是從哪幾筆成交來的」。'
      + '台幣交割那張表把走完的日子收進每日剩餘總額之後，畫面上看不到明細，要回頭查就來這裡。'
      + '<br><b>交割日怎麼算</b>：成交日往後數兩個交易日，用辦公日曆算，不是加兩天，'
      + '不然連假會算錯。'
      + '<br><b>為什麼會出現超過結束日期的交割日</b>：上面的區間篩的是成交日，表格彙總的是交割日，'
      + '兩者差兩個交易日。所以最後面那幾列的交割日會晚於結束日期，標著「未交割」，'
      + '意思是那筆錢還沒從帳戶進出。'
      + '<br><b>金額待補</b>：券商在建倉明細把那一筆的成本記成 0（銀行認購、配股會這樣），'
      + '程式會去參數設定的認購價表找價來還原，找不到就還原不出來。'
      + '沒補之前那一列的金額是<b>少算的</b>，不是真的 0。補的方式是到參數設定填那一筆的認購價。'
      + '<br><b>兩邊的來源不對稱</b>：賣出用已實現損益按日期區間查，查得到的是完整的，'
      + '包含已經整批出清的標的。買進來自建倉明細，而建倉明細要先有持倉編號才查得到，'
      + '持倉清單只列現在還有部位的標的，所以<b>已經整批出清的標的查不到買進</b>。'
      + '出借中的部位不受影響，明細保留著它們。'
      + '<br><b>金額怎麼來的</b>：買進是建倉明細的成本，券商有記成本的那幾筆要把已領配息加回去，'
      + '因為券商記的是扣掉配息之後的淨額，不是當初付出去的錢。'
      + '銀行認購那種券商端沒記成本的，用認購價還原。'
      + '<br>賣出是<b>價 × 股數</b>，<b>沒有扣手續費與證交稅</b>，所以實際入帳會比這個數字略低。'
      + '要精確到元得逐筆再查明細，那是幾十支請求，這一頁的用途不需要。'
      + '<br><b>它不能告訴你什麼</b>：當天淨額跟銀行實際扣款不會分毫不差，'
      + '差在賣出的手續費與證交稅，以及查不到買進的那幾檔。'
      + '要精確的數字，去台幣交割看券商自己算的交割金額。</div>';

    el.innerHTML = h;
  } catch (e) {
    el.innerHTML = '<div class="modal-loading">查詢失敗：' + ((e && e.message) || e) + '</div>';
  }
  _bsgBusy = false;
}
