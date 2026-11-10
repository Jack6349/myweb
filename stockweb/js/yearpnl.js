// 股利總管 Web — 年度損益（交易資訊子頁籤）
//
// 來源：券商 portfolio/profitloss_sum（已實現損益彙總，逐檔）。
// 跟「交易紀錄（已實現損益）」是同一份資料的兩種切法：那邊逐筆、這邊彙總到代號。
// 實測 2026-01-01～11-10：明細 43 筆、彙總 9 檔，pnl 合計完全一致，沒有資料遺漏。
//
// 欄位定義（九檔逐一驗過，全部成立）：
//   pnl      ＝ sell_cost − buy_cost   （兩者皆為淨額，已含手續費與交易稅）
//   pr_ratio ＝ pnl ÷ buy_cost × 100
// entry_cost / cover_cost 是「成交均價 × 股數」的毛額，跟 pnl 對不起來，這裡不用。
//
// 認購匯撥進來的部位，券商端沒有成本（buy_cost = 0），整筆賣出金額會被當成獲利。
// 用參數設定的認購成本補正還原，而且原始與修正後兩個合計都列：
// 跟券商月結單核對時看原始的，估自己的實際損益時看修正後的。

var _ypRows = null, _ypBusy = false, _ypErr = '';
var YP_SORT_LS = 'yearpnl_sort_v1';
var _ypSort = (function () {
  try { var v = localStorage.getItem(YP_SORT_LS); if (v) return v; } catch (e) {}
  return 'pnlDesc';
})();

function _ypYmd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 預設區間：今年 1/1 ～ 今天。只在欄位是空的時候填，使用者改過就不覆蓋。
function ypInitDates() {
  var b = document.getElementById('yp-begin'), e = document.getElementById('yp-end');
  if (!b || !e) return;
  var now = new Date();
  if (!e.value) e.value = _ypYmd(now);
  if (!b.value) b.value = now.getFullYear() + '-01-01';
}

async function startYearPnl(force) {
  ypInitDates();
  if (_ypRows && !force) { ypRender(); return; }
  loadYearPnl();
}

async function loadYearPnl() {
  if (_ypBusy) return;
  var el = document.getElementById('yp-body');
  if (!el) return;
  ypInitDates();
  var b = document.getElementById('yp-begin').value, e = document.getElementById('yp-end').value;
  if (!b || !e) { el.innerHTML = '<div class="modal-loading">請先選日期區間</div>'; return; }
  _ypBusy = true; _ypErr = '';
  el.innerHTML = '<div class="modal-loading">查詢中…</div>';
  try {
    if (typeof coLoad === 'function') { try { await coLoad(); } catch (e2) { hush('yearpnl', e2); } }
    _ypRows = { begin: b, end: e, rows: await fetchProfitLossSum(b, e) };
    ypRender();
  } catch (err) {
    _ypRows = null; _ypErr = err.message || String(err);
    el.innerHTML = '<div class="modal-loading">查詢失敗：' + _ypErr +
      '　<button class="btn-query" onclick="loadYearPnl()">重試</button></div>';
  } finally { _ypBusy = false; }
}

// 認購成本補正。彙總沒有日期，所以只有「該檔設定過的認購價只有一個」時才自動還原；
// 設了多個不同單價就不猜，標出來讓使用者自己去參數設定確認。
function _ypFix(r) {
  var raw = r.pnl || 0, buy = r.buy_cost || 0, qty = r.quantity || 0;
  if (buy > 0) return { cost: buy, pnl: raw, note: '' };
  var ps = (typeof coPricesOf === 'function') ? coPricesOf(r.code) : [];
  if (ps.length === 1 && qty > 0) {
    var c = ps[0] * qty;
    return { cost: c, pnl: raw - c, note: 'fix', px: ps[0] };
  }
  return { cost: 0, pnl: raw, note: ps.length > 1 ? 'multi' : 'none' };
}

function ypSort(key) {
  _ypSort = (_ypSort === key + 'Desc') ? key + 'Asc' : key + 'Desc';
  try { localStorage.setItem(YP_SORT_LS, _ypSort); } catch (e) {}
  ypRender();
}
function _ypTh(key, label) {
  var on = (_ypSort === key + 'Asc' || _ypSort === key + 'Desc');
  var ind = _ypSort === key + 'Asc' ? '▲' : (_ypSort === key + 'Desc' ? '▼' : '↕');
  return '<th class="num sort-th' + (on ? ' sorted' : '') + '" onclick="ypSort(\'' + key + '\')">'
    + label + '<span class="sort-ind">' + ind + '</span></th>';
}
function _ypMoney(v) {
  if (v == null) return '—';
  return (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('zh-TW');
}
function _ypSigned(v) {
  if (v == null) return '—';
  return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.round(Math.abs(v)).toLocaleString('zh-TW');
}
function _ypCls(v) { return v > 0 ? 'up' : (v < 0 ? 'down' : ''); }

function ypRender() {
  var el = document.getElementById('yp-body');
  if (!el || !_ypRows) return;
  var raws = _ypRows.rows || [];
  if (!raws.length) {
    el.innerHTML = '<div class="modal-loading">' + _ypRows.begin + ' ～ ' + _ypRows.end + ' 之間沒有已實現損益</div>';
    return;
  }
  var rows = raws.map(function (r) {
    var f = _ypFix(r);
    return {
      code: String(r.code), name: (typeof _contracts !== 'undefined' && _contracts[String(r.code)] && _contracts[String(r.code)].name) || '',
      qty: r.quantity || 0, buy: r.buy_cost || 0, sell: r.sell_cost || 0,
      raw: r.pnl || 0, cost: f.cost, pnl: f.pnl, note: f.note, px: f.px,
      rate: f.cost > 0 ? (f.pnl / f.cost * 100) : null
    };
  });

  var key = _ypSort.replace(/(Asc|Desc)$/, ''), dir = /Asc$/.test(_ypSort) ? 1 : -1;
  rows.sort(function (a, b) {
    if (key === 'code') return a.code < b.code ? -dir : (a.code > b.code ? dir : 0);
    var x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;            // 沒有報酬率的（成本 0 又沒補正）一律沉底
    if (y == null) return -1;
    return (x - y) * dir;
  });

  var tRaw = 0, tPnl = 0, tBuy = 0, tSell = 0, nFix = 0, nBad = 0, fixAmt = 0;
  rows.forEach(function (r) {
    tRaw += r.raw; tPnl += r.pnl; tBuy += r.cost; tSell += r.sell;
    if (r.note === 'fix') { nFix++; fixAmt += (r.raw - r.pnl); }
    if (r.note === 'multi' || r.note === 'none') nBad++;
  });
  var tRate = tBuy > 0 ? (tPnl / tBuy * 100) : null;

  var html = '<div class="tr-summary">'
    + '<div class="sum-item"><div class="sum-label">區間已實現損益（修正後）</div><div class="sum-val '
      + _ypCls(tPnl) + '">' + _ypSigned(tPnl) + ' 元</div></div>'
    + '<div class="sum-item"><div class="sum-label">券商原始合計</div><div class="sum-val '
      + _ypCls(tRaw) + '">' + _ypSigned(tRaw) + ' 元</div></div>'
    + '<div class="sum-item"><div class="sum-label">報酬率（修正後）</div><div class="sum-val '
      + _ypCls(tRate) + '">' + (tRate == null ? '—' : (tRate >= 0 ? '+' : '−') + Math.abs(tRate).toFixed(2) + '%') + '</div></div>'
    + '<div class="sum-item"><div class="sum-label">檔數</div><div class="sum-val">' + rows.length + '</div></div>'
    + '</div>';

  if (nFix) {
    html += '<div class="yp-fix nb-keep">已補正 ' + nFix + ' 檔的認購成本，合計 '
      + _ypMoney(fixAmt) + ' 元：券商端這些部位成本是 0，不補正的話整筆賣出金額都被算成獲利。'
      + '認購價維護在 參數設定 → 認購成本補正。</div>';
  }
  if (nBad) {
    html += '<div class="yp-fix yp-bad nb-keep">有 ' + nBad + ' 檔成本為 0 但無法自動補正'
      + '（沒設認購價，或同一檔設了多個不同單價而彙總沒有日期可分攤）。'
      + '那幾列的損益是高估的，請到 參數設定 → 認購成本補正 處理。</div>';
  }

  html += '<table class="detail-table yp-table"><thead><tr>'
    + '<th class="sort-th' + (/^code/.test(_ypSort) ? ' sorted' : '') + '" onclick="ypSort(\'code\')">代號 / 名稱'
      + '<span class="sort-ind">' + (_ypSort === 'codeAsc' ? '▲' : (_ypSort === 'codeDesc' ? '▼' : '↕')) + '</span></th>'
    + _ypTh('qty', '股數')
    + _ypTh('cost', '買進成本')
    + _ypTh('sell', '賣出金額')
    + _ypTh('pnl', '已實現損益')
    + _ypTh('rate', '報酬率')
    + '</tr></thead><tbody>';

  rows.forEach(function (r) {
    var tag = '';
    if (r.note === 'fix') tag = '<div class="yp-sub">認購補正 ' + r.px + ' 元/股</div>';
    else if (r.note === 'multi') tag = '<div class="yp-sub yp-warn">成本 0，認購價有多筆不同單價，未補正</div>';
    else if (r.note === 'none') tag = '<div class="yp-sub yp-warn">成本 0，未設認購價，損益高估</div>';
    html += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + r.name + '</span>' + tag + '</td>'
      + '<td class="num">' + r.qty.toLocaleString('zh-TW') + '</td>'
      + '<td class="num">' + (r.cost > 0 ? _ypMoney(r.cost) : '<span class="yp-warn">0</span>') + '</td>'
      + '<td class="num">' + _ypMoney(r.sell) + '</td>'
      + '<td class="num ' + _ypCls(r.pnl) + '">' + _ypSigned(r.pnl) + '</td>'
      + '<td class="num ' + _ypCls(r.rate) + '">' + (r.rate == null ? '—' : (r.rate >= 0 ? '+' : '−') + Math.abs(r.rate).toFixed(2) + '%') + '</td></tr>';
  });
  html += '<tr class="yp-total"><td>合計</td><td class="num"></td>'
    + '<td class="num">' + _ypMoney(tBuy) + '</td>'
    + '<td class="num">' + _ypMoney(tSell) + '</td>'
    + '<td class="num ' + _ypCls(tPnl) + '">' + _ypSigned(tPnl) + '</td>'
    + '<td class="num ' + _ypCls(tRate) + '">' + (tRate == null ? '—' : (tRate >= 0 ? '+' : '−') + Math.abs(tRate).toFixed(2) + '%') + '</td></tr>';
  html += '</tbody></table>';

  html += '<div class="detail-note"><dl>' + _ypNoteHtml() + '</dl></div>';
  el.innerHTML = html;
}

function _ypNoteHtml() {
  return '<dt>定義</dt><dd>資料來自券商 <code>profitloss_sum</code>（已實現損益彙總），'
    + '跟下面「交易紀錄（已實現損益）」是同一份資料的兩種切法 —— 那邊逐筆、這邊彙總到代號，合計相同。'
    + '<code>已實現損益 ＝ 賣出金額 − 買進成本</code>，兩個金額都是淨額，手續費與交易稅已經扣在裡面；'
    + '<code>報酬率 ＝ 已實現損益 ÷ 買進成本</code>。'
    + '券商另外回的 entry_cost／cover_cost 是「成交均價 × 股數」的毛額，跟損益對不起來，這裡不採用。</dd>'
    + '<dt>為什麼要分「原始」與「修正後」</dt><dd>認購匯撥進來的股票不是在本券商成交，'
    + '券商端的買進成本是 0，整筆賣出金額會被當成獲利、報酬率顯示 100%。'
    + '修正後的數字用 參數設定 → 認購成本補正 裡登記的每股認購價 × 股數還原成本。'
    + '兩個都列是因為用途不同：跟券商月結單對帳時要用原始的（那才是券商帳上的數字），'
    + '估自己今年實際賺多少要用修正後的。</dd>'
    + '<dt>這張表不含什麼</dt><dd>四件事，少算任何一項都不等於「今年實際損益」。'
    + '一、<b>配息</b>：已領的現金股利不在這裡，在 股利估算 頁。'
    + '二、<b>借券收入與權益補償</b>：出借的利息收入與除息期間借券人支付的補償，兩者都另外入帳。'
    + '三、<b>未實現損益</b>：還沒賣的部位不算（在 持股庫存 頁），這張表只算已經落袋的價差。'
    + '四、<b>入出金</b>：你自己轉進轉出的錢，券商 API 看不到。</dd>'
    + '<dt>為什麼銀行餘額要你自己核對</dt><dd>券商有 <code>account_balance</code> 這支 API，'
    + '但實測回「非永豐銀行交割帳號」—— 你的交割銀行不是永豐，程式拿不到餘額。'
    + '這不是沒做，是做不到。可以對照的是 交易帳務 頁籤的「合計待交割」：'
    + '它告訴你還有多少錢尚未進出，銀行餘額加減它才是你實際可動用的數字。</dd>';
}
