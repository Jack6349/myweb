// 股利總管 模組：import-ocr — 截圖匯入持股
// 辨識引擎：Gemini 視覺（經 GAS 代理）。Tesseract 純前端證實讀不出彩色代號，已改用此法。
// 流程：選圖/貼上 → 縮圖 → 縮小後 base64 POST 給 GAS → GAS 呼叫 Gemini 回結構化 JSON → 預覽。
// P4（未做）：對帳 + 可編輯校正表 + 寫入 Firestore。
(function () {
  // 沿用既有 Life Manager GAS（api.js 的 GAS_URL）：只要在該專案加上 doPost 的 OCR handler
  // 並重新部署即可，前端不需另外設定網址。
  function ocrEndpoint() { return (typeof GAS_URL !== 'undefined' && GAS_URL) ? GAS_URL : ''; }

  var currentImageDataUrl = null;
  var lastRecords = [];
  var pasteBound = false;
  var working = false;

  function el(id) { return document.getElementById(id); }
  function setStatus(text, color) {
    var s = el('import-status');
    if (!s) return;
    s.style.color = color || 'var(--text2)';
    s.textContent = text || '';
  }

  window.openImportModal = function () {
    clearImportImage();
    setStatus('');
    openModal('modal-import');
    bindPaste();
  };

  function bindPaste() {
    if (pasteBound) return;
    pasteBound = true;
    document.addEventListener('paste', function (e) {
      var overlay = el('modal-import');
      if (!overlay || !overlay.classList.contains('open')) return;
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var blob = items[i].getAsFile();
          if (blob) { readImage(blob); e.preventDefault(); break; }
        }
      }
    });
  }

  window.onImportFile = function (event) {
    var f = event.target.files && event.target.files[0];
    if (f) readImage(f);
  };

  function readImage(file) {
    if (!file.type || file.type.indexOf('image') !== 0) {
      setStatus('請選擇圖片檔。', 'var(--danger)');
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) { setImportImage(e.target.result); };
    reader.onerror = function () { setStatus('讀取圖片失敗，請重試。', 'var(--danger)'); };
    reader.readAsDataURL(file);
  }

  function setImportImage(dataUrl) {
    currentImageDataUrl = dataUrl;
    var img = el('import-preview');
    if (img) { img.src = dataUrl; img.style.display = 'block'; }
    if (el('import-placeholder')) el('import-placeholder').style.display = 'none';
    if (el('import-actions')) el('import-actions').style.display = 'flex';
    if (el('import-result')) el('import-result').innerHTML = '';
    setStatus('');
  }

  window.clearImportImage = function () {
    currentImageDataUrl = null;
    lastRecords = [];
    var img = el('import-preview');
    if (img) { img.src = ''; img.style.display = 'none'; }
    if (el('import-placeholder')) el('import-placeholder').style.display = 'block';
    if (el('import-actions')) el('import-actions').style.display = 'none';
    if (el('import-file')) el('import-file').value = '';
    if (el('import-result')) el('import-result').innerHTML = '';
    setStatus('');
  };

  window.getImportImageDataUrl = function () { return currentImageDataUrl; };
  window.getImportRecords = function () { return lastRecords; };

  // ───────────────────── 辨識（Gemini via GAS） ─────────────────────
  window.parseImportImage = async function () {
    if (!currentImageDataUrl) { setStatus('請先選擇或貼上截圖。', 'var(--danger)'); return; }
    if (working) return;
    var endpoint = ocrEndpoint();
    if (!endpoint) {
      setStatus('找不到 GAS 服務網址（api.js 的 GAS_URL）。', 'var(--danger)');
      return;
    }
    working = true;
    var btn = document.querySelector('#import-actions .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '辨識中…'; }
    setStatus('上傳並辨識中…（約數秒）', 'var(--text2)');
    try {
      var down = await downscale(currentImageDataUrl, 1600);
      var base64 = down.dataUrl.split(',')[1];
      var res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 用 text/plain 避免 CORS preflight
        body: JSON.stringify({ action: 'ocr_holdings', base64: base64, mimeType: down.mime })
      });
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      var records = normalizeRecords(data.records || []);
      lastRecords = records;
      renderResult(records);
      setStatus(records.length
        ? ('辨識完成，共 ' + records.length + ' 筆。請核對下表、必要時修正，再按「確認匯入」。')
        : '未辨識到持股，請換清晰一點的截圖或改用手動新增。',
        records.length ? 'var(--success)' : 'var(--danger)');
    } catch (e) {
      console.warn('[import-ocr]', e);
      setStatus('辨識失敗：' + (e && e.message ? e.message : e) + '\n（請確認 Apps Script 已部署、Gemini 金鑰已設定）', 'var(--danger)');
    } finally {
      working = false;
      if (btn) { btn.disabled = false; btn.textContent = '解析圖片'; }
    }
  };

  // 縮小影像（保留彩色給 Gemini 判讀），輸出 JPEG 降低上傳體積
  function downscale(dataUrl, maxW) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, maxW / (img.width || 1));
          var w = Math.round((img.width || 1) * scale), h = Math.round((img.height || 1) * scale);
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve({ dataUrl: c.toDataURL('image/jpeg', 0.85), mime: 'image/jpeg' });
        } catch (e) { resolve({ dataUrl: dataUrl, mime: 'image/png' }); }
      };
      img.onerror = function () { resolve({ dataUrl: dataUrl, mime: 'image/png' }); };
      img.src = dataUrl;
    });
  }

  // Gemini 回傳的列 → app 內部格式（股→張、補名稱）
  function normalizeRecords(arr) {
    var out = (arr || []).map(function (r) {
      var code = String(r.code || '').replace(/\s/g, '').toUpperCase();
      var sharesShares = parseInt(String(r.shares == null ? '' : r.shares).replace(/[^\d]/g, ''), 10) || 0;
      var costRaw = (r.cost == null || r.cost === '') ? null : parseInt(String(r.cost).replace(/[^\d]/g, ''), 10);
      return {
        code: code,
        // 已知代號用內建名（較準），新代號用截圖辨識名；兩者都可在校正表手動改
        name: (typeof STOCK_DB !== 'undefined' && STOCK_DB[code]) || r.name || '',
        shares: Math.round(sharesShares / 1000 * 1000) / 1000,
        sharesShares: sharesShares,
        cost: (costRaw != null && !isNaN(costRaw)) ? costRaw : null
      };
    }).filter(function (r) { return r.code && r.sharesShares; });
    // 以 code 去重
    var seen = {}, dedup = [];
    out.forEach(function (r) { if (!seen[r.code]) { seen[r.code] = 1; dedup.push(r); } });
    return dedup;
  }

  // ─────────────── 對帳 + 可編輯校正表（P4） ───────────────
  function currentPortfolio() { return (typeof portfolio !== 'undefined' && Array.isArray(portfolio)) ? portfolio : []; }
  function findHolding(code) {
    return currentPortfolio().filter(function (p) { return String(p.code).toUpperCase() === code; })[0];
  }
  var inp = 'background:var(--bg4);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-size:13px;padding:5px 7px;font-family:var(--font);text-align:right';
  var nameInp = 'width:100%;background:var(--bg4);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-size:11px;padding:3px 6px;margin:3px 0;font-family:var(--font);box-sizing:border-box';
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function renderResult(records) {
    var box = el('import-result');
    if (!box) return;
    if (!records.length) { box.innerHTML = ''; return; }
    var rowsHtml = records.map(function (r, i) {
      var ex = findHolding(r.code);
      var status, color;
      if (!ex) { status = '新增'; color = 'var(--success)'; }
      else if (Number(ex.shares) !== Number(r.shares) || (ex.cost || null) !== (r.cost != null ? r.cost : null)) {
        status = '更新'; color = 'var(--accent)';
        if (Number(ex.shares) !== Number(r.shares)) status += '（' + Number(ex.shares).toLocaleString('zh-TW') + '→' + r.shares.toLocaleString('zh-TW') + ' 張）';
      } else { status = '不變'; color = 'var(--text3)'; }
      var nm = r.name || (ex && ex.name) || '';
      // 預設只勾選有變動的項目（新增／更新）；「不變」預設不勾選，避免覆蓋沒有異動的既有資料
      var checkedAttr = status.indexOf('不變') === 0 ? '' : 'checked';
      return '<tr>' +
        '<td style="padding:6px 4px;border-top:1px solid var(--border);text-align:center;vertical-align:top"><input type="checkbox" id="imp-chk-' + i + '" ' + checkedAttr + ' style="width:16px;height:16px"></td>' +
        '<td style="padding:6px 4px;border-top:1px solid var(--border)"><div style="font-weight:600">' + r.code + '</div>' +
          '<input id="imp-name-' + i + '" type="text" value="' + esc(nm) + '" placeholder="名稱" style="' + nameInp + '">' +
          '<div style="font-size:10px;color:' + color + ';font-weight:600">' + status + '</div></td>' +
        '<td style="padding:6px 4px;border-top:1px solid var(--border);text-align:right;vertical-align:top">' +
          '<input id="imp-shares-' + i + '" type="number" step="0.001" value="' + r.shares + '" style="' + inp + ';width:66px">' +
          '<div style="font-size:10px;color:var(--text3);margin-top:2px">張</div></td>' +
        '<td style="padding:6px 4px;border-top:1px solid var(--border);text-align:right;vertical-align:top">' +
          '<input id="imp-cost-' + i + '" type="number" value="' + (r.cost != null ? r.cost : '') + '" placeholder="—" style="' + inp + ';width:92px"></td>' +
      '</tr>';
    }).join('');

    var inCodes = {}; records.forEach(function (r) { inCodes[r.code] = 1; });
    var missing = currentPortfolio().filter(function (p) { return !inCodes[String(p.code).toUpperCase()]; });
    var missingNote = missing.length
      ? '<div style="font-size:11px;color:var(--text3);margin-top:8px;line-height:1.6">另有 ' + missing.length + ' 檔現有持股不在此截圖中，將保留不變（不會被刪除）。</div>'
      : '';

    box.innerHTML =
      '<div style="font-size:13px;font-weight:600;color:var(--accent);margin-bottom:8px">辨識結果（' + records.length + ' 筆）— 可直接修改後匯入</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        '<thead><tr style="color:var(--text2);font-size:11px">' +
          '<th style="width:28px"></th>' +
          '<th style="text-align:left;padding:0 4px 4px">代號／名稱／狀態</th>' +
          '<th style="text-align:right;padding:0 4px 4px">持股(張)</th>' +
          '<th style="text-align:right;padding:0 4px 4px">付出成本</th>' +
        '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      '<div style="font-size:11px;color:var(--text3);margin-top:10px;line-height:1.6">' +
        '※ 持股已將「股」換算為「張」（÷1000）。新代號匯入後會自動偵測配息月份。</div>' +
      missingNote +
      '<button class="btn-primary" style="margin-top:14px" onclick="applyImport()">確認匯入勾選項目</button>';
  }

  // 確認匯入：把勾選（並可手動修正）的列寫入 portfolio → 存檔（Firestore）
  window.applyImport = function () {
    var records = lastRecords || [];
    var picked = [];
    records.forEach(function (r, i) {
      var chk = el('imp-chk-' + i); if (!chk || !chk.checked) return;
      var shares = parseFloat((el('imp-shares-' + i) || {}).value);
      var costRaw = (el('imp-cost-' + i) || {}).value;
      var cost = (costRaw !== '' && costRaw != null) ? Math.round(parseFloat(String(costRaw).replace(/,/g, ''))) : null;
      var nameVal = ((el('imp-name-' + i) || {}).value || '').trim();
      if (!shares || shares <= 0) return;
      picked.push({ code: r.code, name: nameVal || r.name, shares: Math.round(shares * 1000) / 1000, cost: (cost != null && !isNaN(cost)) ? cost : null });
    });
    if (!picked.length) { setStatus('沒有勾選任何要匯入的列。', 'var(--danger)'); return; }
    if (typeof portfolio === 'undefined') { setStatus('找不到持股資料。', 'var(--danger)'); return; }

    var newCodes = [], added = 0, updated = 0;
    picked.forEach(function (r) {
      var idx = portfolio.findIndex(function (p) { return String(p.code).toUpperCase() === r.code; });
      if (idx >= 0) {
        portfolio[idx] = Object.assign({}, portfolio[idx], { shares: r.shares, cost: r.cost, name: r.name || portfolio[idx].name });
        updated++;
      } else {
        portfolio.push({
          id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
          code: r.code, name: r.name, shares: r.shares, cost: r.cost,
          addedAt: new Date().toISOString(),
          divFreqType: null, divMonths: null, divMonthsSource: null, manualDiv: null, divFreq: null
        });
        newCodes.push(r.code);
        added++;
      }
    });
    savePortfolio(portfolio);
    if (typeof renderPortfolio === 'function') renderPortfolio();
    if (typeof refreshHome === 'function') refreshHome();
    closeModal('modal-import');
    if (newCodes.length) detectDividendsFor(newCodes); // 背景偵測配息，不阻塞
    // 提示（用既有持股頁的 chip / 或 alert 簡訊）
    try { alert('已匯入：新增 ' + added + ' 檔、更新 ' + updated + ' 檔。' + (newCodes.length ? '\n新代號的配息月份正在背景偵測…' : '')); } catch (e) {}
  };

  // 無 DOM 版配息偵測：依近 24 個月的入帳月份推斷頻率與月份
  async function detectDivConfig(code) {
    if (typeof fetchStockDivHistory !== 'function' || typeof exToPayDate !== 'function') return null;
    try {
      var history = await fetchStockDivHistory(code);
      if (!history || !history.length) return null;
      var cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 24);
      var set = {};
      history.forEach(function (rec) {
        if (rec.exDate && rec.exDate >= cutoff) {
          var pd = exToPayDate(rec.exDate);
          if (pd) set[pd.getMonth() + 1] = 1;
        }
      });
      var months = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
      var n = months.length;
      if (n === 0) return null;
      // 頻率優先用「除息日間隔」推斷（gap 法）：新上市 ETF 只有 2 筆連續月配，count 法會誤判成半年配。
      var step = (typeof inferStepFromHistory === 'function') ? inferStepFromHistory(history) : null;
      var type, divMonths;
      if (step) {
        type = step === 1 ? 'monthly' : (step === 3 ? 'quarterly' : (step === 6 ? 'semiannual' : 'annual'));
        if (type === 'monthly') {
          divMonths = '1-12';
        } else {
          var sorted = history.filter(function (r) { return r.exDate; }).sort(function (a, b) { return b.exDate - a.exDate; });
          var anchor = 1;
          if (sorted.length) { var pd = exToPayDate(sorted[0].exDate); if (pd) anchor = pd.getMonth() + 1; }
          divMonths = (typeof monthsAtStep === 'function') ? monthsAtStep(step, anchor).join(',') : months.join(',');
        }
      } else {
        type = n >= 11 ? 'monthly' : (n >= 3 ? 'quarterly' : (n === 2 ? 'semiannual' : 'annual'));
        divMonths = type === 'monthly' ? '1-12' : months.join(',');
      }
      return { divFreqType: type, divMonths: divMonths, divMonthsSource: '自動偵測' };
    } catch (e) { return null; }
  }

  async function detectDividendsFor(codes) {
    var changed = false;
    for (var i = 0; i < codes.length; i++) {
      var cfg = await detectDivConfig(codes[i]);
      if (!cfg) continue;
      var idx = portfolio.findIndex(function (p) { return String(p.code).toUpperCase() === codes[i]; });
      if (idx >= 0) {
        portfolio[idx].divFreqType = cfg.divFreqType;
        portfolio[idx].divFreq = cfg.divFreqType;
        portfolio[idx].divMonths = cfg.divMonths;
        portfolio[idx].divMonthsSource = cfg.divMonthsSource;
        changed = true;
      }
    }
    if (changed) {
      savePortfolio(portfolio);
      if (typeof renderPortfolio === 'function') renderPortfolio();
      if (typeof refreshHome === 'function') refreshHome();
    }
  }

  window._importParse = { normalizeRecords: normalizeRecords, detectDivConfig: detectDivConfig };

  // 拖放上傳
  document.addEventListener('DOMContentLoaded', function () {
    var dz = el('import-dropzone');
    if (!dz) return;
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readImage(f);
    });
  });
})();
