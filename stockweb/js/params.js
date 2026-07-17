// 股利總管 Web — 參數設定（手動維護資料集中地）
// 目前：成份股匯入框架——只列出無法自動抓取、需手動維護清單的 ETF（境外/主動式）。
// 匯入格式後續實作；之後其他需手動匯入的資料也集中放在本頁新增區塊。

async function startParams(force) {
  var el = document.getElementById('params-const-body');
  el.innerHTML = '<div class="modal-loading">整理需匯入清單…</div>';
  try {
    // 持股：優先用行情引擎已載入的 _positions，否則直接向券商查
    var positions = [];
    try {
      positions = (typeof _positions !== 'undefined' && _positions && _positions.length)
        ? _positions : (await fetchBrokerPositions() || []);
    } catch (e) { positions = []; }
    var seen = {}, etfs = [];
    positions.forEach(function (p) {
      var code = String(p.code);
      if (isEtfCode(code) && !seen[code]) { seen[code] = true; etfs.push(code); }
    });
    if (!etfs.length) { el.innerHTML = '<div class="modal-loading">目前持股中沒有 ETF</div>'; return; }

    // 自動抓取結果（constituents.js 的每日快取）：抓得到的不用匯入、不顯示
    var cache = null;
    try { cache = JSON.parse(localStorage.getItem('const_list_v1') || 'null'); } catch (e) {}
    var rows = [];
    etfs.forEach(function (code) {
      var d = cache && cache.map && cache.map[code];
      var az = (typeof ALLIANZ_FUNDS !== 'undefined') && ALLIANZ_FUNDS[code];
      var ov = (typeof HOLDINGS_OVERRIDES !== 'undefined') && HOLDINGS_OVERRIDES[code];
      // 官網 API 檔（如 00402A→安聯）：今日抓到官網資料顯示「自動」，否則顯示手動備援狀態
      if (az) {
        var okAuto = d && (d.holdings || []).length && /安聯官網/.test(d.source || '');
        if (okAuto) rows.push({ code: code, st: 'auto', source: d.source, n: d.holdings.length });
        else rows.push({ code: code, st: 'manual', source: ((ov && ov.source) || '') + '（官網備援）', n: ((ov || {}).holdings || []).length });
        return;
      }
      if (ov) { rows.push({ code: code, st: 'manual', source: ov.source || '手動', n: (ov.holdings || []).length }); return; }
      if (d && (d.holdings || []).length) return;      // 自動來源抓得到 → 不需匯入
      if (d) rows.push({ code: code, st: 'missing', source: null, n: 0 }); // 今日試過且失敗
      // 今日尚未嘗試自動抓取（未進過持股庫存）→ 狀態未知，不顯示，避免誤報
    });
    if (!rows.length) { el.innerHTML = '<div class="modal-loading">目前沒有需要手動匯入的 ETF（自動來源皆可抓取）</div>'; return; }

    // 名稱補查
    for (var i = 0; i < rows.length; i++) {
      var c = rows[i].code;
      if (!(typeof _contracts !== 'undefined' && _contracts[c])) {
        try { _contracts[c] = await fetchContract(c); } catch (e) {}
      }
      rows[i].name = (typeof _contracts !== 'undefined' && _contracts[c] && _contracts[c].name) || '';
    }

    var html = '<div class="inv-table-wrap"><table class="inv-table"><thead><tr>' +
      '<th>代號 / 名稱</th><th>清單狀態</th><th class="num">成份股檔數</th><th style="text-align:center">動作</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var stHtml = r.st === 'auto'
        ? '<span class="st-pill st-ok">自動（官網 API）</span><span class="params-src">' + (r.source || '') + '</span>'
        : (r.st === 'manual'
          ? '<span class="st-pill st-part">手動維護中</span><span class="params-src">' + (r.source || '') + '</span>'
          : '<span class="st-pill st-fail">自動抓取失敗，待匯入</span>');
      var actHtml = r.st === 'auto'
        ? '<span class="sbl-dim">每日自動更新</span>'
        : '<button class="btn-query params-import-btn" disabled title="匯入格式規劃中">匯入（規劃中）</button>';
      html += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + (r.name || '') + '</span></td>' +
        '<td>' + stHtml + '</td>' +
        '<td class="num">' + (r.n || '—') + '</td>' +
        '<td style="text-align:center">' + actHtml + '</td></tr>';
    });
    html += '</tbody></table></div>';
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div class="modal-loading">整理失敗：' + e.message + '</div>';
  }
}
