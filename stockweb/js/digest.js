// 股利總管 Web — 今日提醒（融合 L1趨勢 + L2折溢價 + L3法人籌碼 + 隔夜美股/ADR → 每檔傾向）
// 時段感知：盤前突出隔夜預判、盤後突出收盤結算籌碼/趨勢、盤中收合（評估資料盤中不更新）。
// 註：此為透明的規則式融合啟發，非精確預測；請以各檔附列的「依據」自行判讀。

function twMarketPhase() {
  var d = new Date(Date.now() + 8 * 3600000); // UTC+8
  var dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return 'closed';
  var hm = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (hm < 9 * 60) return 'pre';
  if (hm <= 13 * 60 + 30) return 'open';
  return 'post';
}

// 融合單檔 → { code, lean:'buy'|'sell'|'risk', reasons:[] } 或 null（無明顯傾向）
function fuseDigest(code, trend, sig) {
  var reasons = [], buy = 0, sell = 0, risk = 0;
  // 隔夜美股 / ADR（盤前預判開盤，最即時）
  if (sig) {
    var on = sig.overnight ? sig.overnight.estChangePct : (sig.adr ? sig.adr.bias : null);
    var lbl = sig.overnight ? '隔夜美股' : 'ADR隔夜';
    if (on != null) {
      if (on <= -3) { risk++; reasons.push(lbl + on.toFixed(1) + '%(開盤預估大跌)'); }
      else if (on <= -1) { buy++; reasons.push(lbl + on.toFixed(1) + '%(開盤偏弱，低接參考)'); }
      else if (on >= 2) { sell++; reasons.push(lbl + '+' + on.toFixed(1) + '%(開盤偏強)'); }
    }
  }
  // L2 折溢價
  if (sig && sig.nav && sig.nav.premium != null) {
    if (sig.nav.premium <= -0.8) { buy++; reasons.push('折價' + sig.nav.premium.toFixed(1) + '%(可能錯殺)'); }
    else if (sig.nav.premium >= 1) { sell++; reasons.push('溢價+' + sig.nav.premium.toFixed(1) + '%(追價過熱)'); }
  }
  // L3 法人籌碼（覆蓋率≥50% 才採計，避免低覆蓋外推）
  if (sig && sig.chip && sig.chip.coveredPct >= 50) {
    if (sig.chip.score >= 2) { buy++; reasons.push('法人偏多+' + sig.chip.score.toFixed(1)); }
    else if (sig.chip.score <= -2) { risk++; reasons.push('法人偏空' + sig.chip.score.toFixed(1)); }
  }
  // L1 趨勢
  if (trend) {
    if (trend.score10 <= 3.5) { risk++; reasons.push('趨勢弱' + trend.score10.toFixed(1)); }
    else if (trend.score10 >= 8) { sell++; reasons.push('趨勢強' + trend.score10.toFixed(1) + '(高檔)'); }
  }
  if (!reasons.length) return null;
  var lean = (risk > 0 && risk >= buy) ? 'risk' : (sell > buy ? 'sell' : (buy > 0 ? 'buy' : null));
  if (!lean) return null;
  return { code: code, lean: lean, reasons: reasons.slice(0, 3) };
}

var LEAN_TXT = { buy: '低接', sell: '停利', risk: '觀望' };
var LEAN_ORDER = { risk: 0, sell: 1, buy: 2 };
var _digestOpen = false;
function toggleDigest() {
  _digestOpen = !_digestOpen;
  var b = document.querySelector('#live-digest .digest-body');
  var c = document.querySelector('#live-digest .digest-caret');
  if (b) b.style.display = _digestOpen ? 'block' : 'none';
  if (c) c.textContent = _digestOpen ? '▼' : '▶';
}

async function renderDailyDigest() {
  var el = document.getElementById('live-digest');
  if (!el) return;
  var phase = twMarketPhase();
  if (phase === 'open') {
    el.className = 'live-digest muted';
    el.innerHTML = '🕘 盤中：以即時價格/損益為主。趨勢、籌碼、淨值等評估資料於收盤後更新，盤中不變動。';
    return;
  }
  el.className = 'live-digest';
  el.innerHTML = '<div class="modal-loading" style="padding:10px">彙整今日提醒（趨勢/籌碼/淨值/隔夜）…</div>';

  try { if (typeof ensureTrend === 'function') await ensureTrend(); } catch (e) {}
  try { if (typeof ensureSignals === 'function') await ensureSignals(); } catch (e) {}

  var trendMap = {}; (typeof _trendRows !== 'undefined' ? _trendRows : []).forEach(function (r) { if (r.trend) trendMap[r.code] = r.trend; });
  var sigMap = {}; (typeof _sigRows !== 'undefined' ? _sigRows : []).forEach(function (r) { sigMap[r.code] = r; });

  var items = [];
  (_positions || []).forEach(function (p) {
    var code = String(p.code);
    var d = fuseDigest(code, trendMap[code], sigMap[code]);
    if (d) items.push(d);
  });
  items.sort(function (a, b) { return LEAN_ORDER[a.lean] - LEAN_ORDER[b.lean]; });

  var phaseWord = phase === 'pre' ? '盤前' : (phase === 'post' ? '盤後' : '非交易日');
  var phaseIcon = phase === 'pre' ? '🌅' : (phase === 'post' ? '🌆' : '📅');

  // 折疊時的一行結論：依 觀望→停利→低接 分組
  var groups = { risk: [], sell: [], buy: [] };
  items.forEach(function (d) { groups[d.lean].push(d.code); });
  var parts = [];
  ['risk', 'sell', 'buy'].forEach(function (k) {
    if (groups[k].length) parts.push('<span class="dg-' + k + '">' + LEAN_TXT[k] + '</span>：' + groups[k].join(', '));
  });
  var summaryLine = parts.length ? parts.join('　｜　') : '<span style="color:var(--text3)">各檔中性，無明顯傾向</span>';

  var detail = items.length
    ? items.map(function (d) {
        var c = _contracts[d.code], nm = (c && c.name) || '';
        return '<div class="digest-item">' +
          '<span class="digest-lean ' + d.lean + '">' + LEAN_TXT[d.lean] + '</span>' +
          '<span class="digest-code">' + d.code + '</span>' +
          '<span class="digest-name">' + nm + '</span>' +
          '<span class="digest-reasons">' + d.reasons.join('｜') + '</span>' +
        '</div>';
      }).join('')
    : '<div class="digest-none">今日無明顯傾向訊號（各檔評估中性）。</div>';

  el.innerHTML =
    '<div class="digest-head" onclick="toggleDigest()">' +
      '<span class="digest-caret">' + (_digestOpen ? '▼' : '▶') + '</span>' +
      '<span>' + phaseIcon + ' ' + phaseWord + '評估：</span>' + summaryLine +
    '</div>' +
    '<div class="digest-body" style="display:' + (_digestOpen ? 'block' : 'none') + '">' +
      detail +
      '<div class="sig-note">融合 L1趨勢＋L2官方折溢價＋L3法人籌碼＋隔夜美股/ADR 的規則式提醒，非精確預測；請以各檔「依據」自行判讀。' +
      '純美股 ETF 以隔夜美股預估開盤為主，台股 ETF 綜合折溢價與法人籌碼。</div>' +
    '</div>';
}
