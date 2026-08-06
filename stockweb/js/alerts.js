// 股利總管 Web — 停損停利點設定
// 每檔可設：停利價(≥賣)、停利率%(≥賣)、停損價(≤賣)、停損率%(≤賣)、買進價(≤買)
// 觸發時：賣出→反紅底、買進→反綠底（僅底色，不顯示文字）。狀態存 localStorage。

var ALERTS_KEY = 'alerts_v1';
var _alerts = null;
function loadAlerts() {
  if (_alerts) return _alerts;
  try { _alerts = JSON.parse(localStorage.getItem(ALERTS_KEY)) || {}; } catch (e) { _alerts = {}; }
  return _alerts;
}
function saveAlerts() { try { localStorage.setItem(ALERTS_KEY, JSON.stringify(loadAlerts())); } catch (e) {} }

// 評估某檔是否觸發：回傳 'sell'(紅) | 'buy'(綠) | null
function evalAlert(code, price, profitRate) {
  var a = loadAlerts()[String(code)];
  if (!a || price == null) return null;
  if (a.tpPrice != null && price >= a.tpPrice) return 'sell';
  if (a.slPrice != null && price <= a.slPrice) return 'sell';
  if (profitRate != null && a.tpRate != null && profitRate >= a.tpRate) return 'sell';
  if (profitRate != null && a.slRate != null && profitRate <= a.slRate) return 'sell';
  if (a.buyPrice != null && price <= a.buyPrice) return 'buy';
  return null;
}

function setAlert(code, field, value) {
  var all = loadAlerts();
  var a = all[code] || {};
  var v = (value === '' || value == null) ? null : parseFloat(value);
  a[field] = (v == null || isNaN(v)) ? null : v;
  all[code] = a;
  saveAlerts();
  // 即時反映到目前分頁（若在即時持股/持股庫存）
  if (typeof renderLiveTables === 'function' && document.getElementById('live-cols') && document.getElementById('live-cols').children.length) renderLiveTables();
  if (typeof renderInvTable === 'function' && document.getElementById('inv-tbody') && document.getElementById('inv-tbody').children.length) renderInvTable();
}

// ── 設定畫面 ──
function _alInput(code, field, val) {
  return '<input type="number" step="0.01" class="al-in" value="' + (val == null ? '' : val) +
    '" oninput="setAlert(\'' + code + '\',\'' + field + '\',this.value)">';
}

async function startAlerts() {
  var errEl = document.getElementById('al-error');
  var wrap = document.getElementById('al-wrap');
  var info = document.getElementById('al-info');
  errEl.style.display = 'none';
  wrap.innerHTML = '<div class="modal-loading">載入持股與現價…</div>';

  await checkServer();
  // 與「持股庫存／即時持股」共用同一份持股（ensureFeed → _positions）：
  // 已含出借/匯撥補償與銀行認購成本補正，成本均價才會三頁一致；
  // 直接呼叫 fetchBrokerPositions() 會拿到未補正的原始值（例：00405A 0.00、00407A 7.15）
  var positions = [];
  try { await ensureFeed(function (m) { info.textContent = m; }); } catch (e) {}
  positions = (_positions && _positions.length) ? _positions : [];
  if (!positions.length) {                      // 行情引擎未就緒時的最後手段
    try { positions = await fetchBrokerPositions(); } catch (e) { positions = []; }
  }
  if (!positions.length) { errEl.style.display = 'block'; errEl.textContent = '讀不到持股（券商連線可能未就緒，稍候重試）'; wrap.innerHTML = ''; return; }

  var names = {};
  try { (await loadPortfolioFallback()).forEach(function (s) { if (s.name) names[String(s.code)] = s.name; }); } catch (e) {}

  var all = loadAlerts();
  var rows = positions.slice().sort(function (a, b) { return String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); });
  info.textContent = '共 ' + rows.length + ' 檔｜留白＝不設定，輸入即存';

  var html = '<div class="inv-table-wrap"><table class="inv-table al-table"><thead><tr>' +
    '<th>代號</th><th>名稱</th><th class="num">成本均價</th><th class="num">現價</th><th class="num">獲利率</th>' +
    '<th class="num al-red">停利價≥</th><th class="num al-red">停利率%≥</th>' +
    '<th class="num al-red">停損價≤</th><th class="num al-red">停損率%≤</th>' +
    '<th class="num al-green">買進價≤</th></tr></thead><tbody>';
  rows.forEach(function (p) {
    var code = String(p.code);
    var r = _rows[code], c = _contracts[code];
    var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
    var shares = p.quantity, cost = p.price * shares;
    var prate = (price != null && cost) ? ((price * shares * 0.997735) - cost) / cost * 100 : null;
    var a = all[code] || {};
    html += '<tr>' +
      '<td class="inv-code">' + code + '</td>' +
      '<td class="inv-name">' + ((c && c.name) || names[code] || '') + '</td>' +
      '<td class="num' + costLineClass(p.price, price) + '">' + (p.price != null ? p.price.toFixed(2) : '—') + '</td>' +
      '<td class="num">' + (price != null ? price.toFixed(2) : '—') + '</td>' +
      '<td class="num ' + (prate == null ? 'flat' : (prate >= 0 ? 'up' : 'down')) + '">' + (prate == null ? '—' : (prate >= 0 ? '+' : '') + prate.toFixed(1) + '%') + '</td>' +
      '<td class="num">' + _alInput(code, 'tpPrice', a.tpPrice) + '</td>' +
      '<td class="num">' + _alInput(code, 'tpRate', a.tpRate) + '</td>' +
      '<td class="num">' + _alInput(code, 'slPrice', a.slPrice) + '</td>' +
      '<td class="num">' + _alInput(code, 'slRate', a.slRate) + '</td>' +
      '<td class="num">' + _alInput(code, 'buyPrice', a.buyPrice) + '</td>' +
    '</tr>';
  });
  html += '</tbody></table></div>' +
    '<div class="sig-note">停利價/停利率、停損價/停損率任一達到 → 賣出訊號（即時持股、持股庫存整列反<span style="color:var(--up)">紅</span>底）；' +
    '買進價達到 → 買進訊號（反<span style="color:var(--down)">綠</span>底）。僅以底色標示，不顯示文字。設定即時儲存於本機。</div>';
  wrap.innerHTML = html;
}
