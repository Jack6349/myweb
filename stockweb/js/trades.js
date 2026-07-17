// 股利總管 Web — 交易紀錄（已實現損益 profit_loss + 明細 profit_loss_detail）
// 依日期區間查詢；每列〔明細〕可展開該筆的成本/稅費/配息明細

function _ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function initTradeDates() {
  var end = document.getElementById('tr-end'), begin = document.getElementById('tr-begin');
  if (!end.value) {
    var now = new Date();
    var from = new Date(now.getTime() - 7 * 86400000); // 預設近一週
    end.value = _ymd(now);
    begin.value = _ymd(from);
  }
}

async function startTrades() {
  initTradeDates();
  if (!(await checkServer())) {
    document.getElementById('tr-result').innerHTML = '<div class="stream-error" style="display:block">' + serverDownHtml() + '</div>';
    return;
  }
  loadTrades();
}

async function loadTrades() {
  var begin = document.getElementById('tr-begin').value;
  var end = document.getElementById('tr-end').value;
  var res = document.getElementById('tr-result');
  res.innerHTML = '<div class="modal-loading">查詢中…</div>';
  try {
    var rows = await fetchProfitLoss(begin, end);
    if (!rows || !rows.length) { res.innerHTML = '<div class="modal-loading">此區間無已實現損益</div>'; return; }
    rows.sort(function (a, b) { return (a.date < b.date) ? 1 : -1; }); // 新→舊
    var totPnl = 0; rows.forEach(function (r) { totPnl += (r.pnl || 0); });
    var tcls = totPnl >= 0 ? 'up' : 'down';

    var html = '<div class="tr-summary"><div class="sum-item"><div class="sum-label">區間已實現損益</div>' +
      '<div class="sum-val ' + tcls + '">' + (totPnl >= 0 ? '+' : '') + Math.round(totPnl).toLocaleString('zh-TW') + ' 元</div></div>' +
      '<div class="sum-item"><div class="sum-label">筆數</div><div class="sum-val">' + rows.length + '</div></div></div>';
    html += '<table class="detail-table"><thead><tr><th></th><th>賣出日</th><th>代號</th><th>名稱</th>' +
      '<th class="num">張</th><th class="num">賣價</th><th class="num">損益</th><th class="num">報酬率</th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      var code = String(r.code);
      var c = _contracts[code];
      var pcls = (r.pnl || 0) >= 0 ? 'up' : 'down';
      var prr = (r.pr_ratio != null) ? (r.pr_ratio * 100).toFixed(2) + '%' : '—';
      html += '<tr class="tr-main" data-id="' + r.id + '">' +
        '<td class="inv-detail"><button class="btn-detail" onclick="toggleTradeDetail(' + r.id + ',this)">明細</button></td>' +
        '<td>' + r.date + '</td><td>' + code + '</td><td>' + ((c && c.name) || '') + '</td>' +
        '<td class="num">' + r.quantity + '</td><td class="num">' + r.price + '</td>' +
        '<td class="num ' + pcls + '">' + ((r.pnl || 0) >= 0 ? '+' : '') + Math.round(r.pnl || 0).toLocaleString('zh-TW') + '</td>' +
        '<td class="num ' + pcls + '">' + prr + '</td></tr>' +
        '<tr class="tr-detail" id="tr-detail-' + r.id + '" style="display:none"><td colspan="8"></td></tr>';
    });
    html += '</tbody></table>';
    res.innerHTML = html;
  } catch (e) {
    res.innerHTML = '<div class="modal-loading">查詢失敗：' + e.message + '</div>';
  }
}

async function toggleTradeDetail(detailId, btn) {
  var tr = document.getElementById('tr-detail-' + detailId);
  if (!tr) return;
  if (tr.style.display !== 'none') { tr.style.display = 'none'; btn.textContent = '明細'; return; }
  tr.style.display = '';
  btn.textContent = '收合';
  var cell = tr.firstElementChild;
  cell.innerHTML = '<div class="modal-loading" style="padding:10px">載入中…</div>';
  try {
    var rows = await fetchProfitLossDetail(detailId);
    if (!rows || !rows.length) { cell.innerHTML = '<div class="modal-loading" style="padding:10px">無明細</div>'; return; }
    var h = '<table class="subdetail-table"><thead><tr><th>買/賣日</th><th class="num">張</th>' +
      '<th class="num">價</th><th class="num">成本</th><th class="num">手續費</th><th class="num">稅</th><th class="num">配息</th></tr></thead><tbody>';
    rows.forEach(function (d) {
      h += '<tr><td>' + d.date + '</td><td class="num">' + d.quantity + '</td>' +
        '<td class="num">' + d.price + '</td><td class="num">' + Math.round(d.cost || 0).toLocaleString('zh-TW') + '</td>' +
        '<td class="num">' + Math.round(d.fee || 0).toLocaleString('zh-TW') + '</td>' +
        '<td class="num">' + Math.round(d.tax || 0).toLocaleString('zh-TW') + '</td>' +
        '<td class="num">' + Math.round(d.ex_dividend_amt || 0).toLocaleString('zh-TW') + '</td></tr>';
    });
    h += '</tbody></table>';
    cell.innerHTML = h;
  } catch (e) {
    cell.innerHTML = '<div class="modal-loading" style="padding:10px">查詢失敗：' + e.message + '</div>';
  }
}
