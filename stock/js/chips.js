// 股利總管 模組：chips — ETF 成分股籌碼分數（穿透成分股看三大法人買賣超）
// 資料：TWSE T86（個股三大法人買賣超，CORS 開放前端直抓），近 N 個交易日、按日快取（歷史資料不變）。
// 分數：每檔成分股取「外資連買/賣天數」與「投信連買/賣天數」（各 clamp ±5）相加，
//       再按 ETF 權重加權平均 → -10 ~ +10。正=籌碼偏多（台股慣例紅色）、負=偏空（綠色）。

const T86_DAYS = 5;               // 取近 5 個交易日
const T86_CACHE_PREFIX = 't86_v1_';
const T86_LOOKBACK_CALENDAR = 16; // 往回最多掃 16 個日曆日找足交易日

function _t86Num(s) { return parseInt(String(s).replace(/,/g, ''), 10) || 0; }

function _t86TodayYmd() {
  const tw = new Date(Date.now() + 8 * 3600000);
  return tw.getUTCFullYear() * 10000 + (tw.getUTCMonth() + 1) * 100 + tw.getUTCDate();
}

// 抓某日 T86 → { code: [外資買賣超, 投信買賣超] }；假日/無資料回 null。
// 過去日期的結果（含假日）永久快取；「今日」尚未發布不快取，之後再試。
async function fetchT86Day(ymd) {
  const key = T86_CACHE_PREFIX + ymd;
  try {
    const c = localStorage.getItem(key);
    if (c === 'HOLIDAY') return null;
    if (c) return JSON.parse(c);
  } catch (e) {}

  let j = null;
  try {
    const r = await fetch('https://www.twse.com.tw/rwd/zh/fund/T86?date=' + ymd + '&selectType=ALLBUT0999&response=json');
    j = await r.json();
  } catch (e) { return null; } // 網路失敗不寫快取

  if (!j || j.stat !== 'OK' || !Array.isArray(j.data) || !j.data.length) {
    // 只有「過去的日期」才視為假日永久快取；今日可能只是尚未發布（約 15:00 後）
    if (ymd < _t86TodayYmd()) { try { localStorage.setItem(key, 'HOLIDAY'); } catch (e) {} }
    return null;
  }
  // 欄位：4=外陸資買賣超、10=投信買賣超（T86 固定 19 欄）
  const map = {};
  j.data.forEach(row => {
    const code = String(row[0]).trim();
    map[code] = [_t86Num(row[4]), _t86Num(row[10])];
  });
  try { localStorage.setItem(key, JSON.stringify(map)); } catch (e) { _pruneT86Cache(); }
  return map;
}

// 移除最舊的 T86 快取（localStorage 滿時）
function _pruneT86Cache() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.indexOf(T86_CACHE_PREFIX) === 0) keys.push(k);
  }
  keys.sort().slice(0, Math.max(keys.length - T86_DAYS - 2, 0)).forEach(k => localStorage.removeItem(k));
}

// 取近 n 個交易日的 T86，最近在前：[{ymd, map}, ...]
async function getRecentT86(n) {
  const out = [];
  const now = new Date(Date.now() + 8 * 3600000);
  for (let back = 0; back < T86_LOOKBACK_CALENDAR && out.length < n; back++) {
    const d = new Date(now.getTime() - back * 86400000);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const ymd = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    const map = await fetchT86Day(ymd);
    if (map) out.push({ ymd, map });
  }
  return out;
}

// 連買/賣天數：vals 為最近在前的買賣超序列。回傳帶方向的天數（+3=連買3日、-2=連賣2日、0=最近一日無動作）
function _streak(vals) {
  if (!vals.length || vals[0] === 0) return 0;
  const dir = vals[0] > 0 ? 1 : -1;
  let n = 0;
  for (const v of vals) {
    if ((v > 0 ? 1 : v < 0 ? -1 : 0) !== dir) break;
    n++;
  }
  return dir * n;
}

const _clamp5 = v => Math.max(-5, Math.min(5, v));

// 對一檔 ETF 的成分股計算加權籌碼分數
// 回傳 { score, coveredPct, days, contributors:[{code,name,weight,f,t}] } 或 null（無可評分成分股）
function computeChipScore(holdings, t86days) {
  if (!t86days.length) return null;
  let wsum = 0, covered = 0, totalW = 0;
  const rows = [];
  (holdings || []).forEach(h => {
    if (typeof h.weight !== 'number') return;
    totalW += h.weight;
    const code = String(h.code).trim();
    if (!/^\d{4,6}[A-Z]?$/.test(code)) return;         // 非台股代碼（美股/債券 ISIN）不評分
    const series = t86days.map(d => d.map[code]);
    if (series.every(s => !s)) return;                  // T86 完全查無（如上櫃）→ 不計入覆蓋
    const fS = _streak(series.map(s => s ? s[0] : 0));
    const tS = _streak(series.map(s => s ? s[1] : 0));
    const sc = _clamp5(fS) + _clamp5(tS);
    wsum += h.weight * sc;
    covered += h.weight;
    rows.push({ code, name: h.name || '', weight: h.weight, f: fS, t: tS, impact: Math.abs(h.weight * sc) });
  });
  if (covered <= 0 || totalW <= 0 || covered / totalW < 0.3) return null; // 覆蓋率過低不評分
  rows.sort((a, b) => b.impact - a.impact);
  return {
    score: wsum / covered,
    coveredPct: Math.round(covered / totalW * 100),
    days: t86days.length,
    latestYmd: t86days[0].ymd,
    contributors: rows.slice(0, 3)
  };
}

function _streakLabel(n, who) {
  if (n === 0) return who + '觀望';
  return who + (n > 0 ? '連買' : '連賣') + Math.abs(n) + '日';
}
function _streakColor(n) { return n > 0 ? '#ff5252' : (n < 0 ? '#26d962' : 'var(--text2)'); }

// ── 頁籤「籌碼」：各持有 ETF 的成分股籌碼分數 ──
let _chipsLoading = false;
async function renderChipsTab() {
  const pane = document.getElementById('holdings-pane-chips');
  if (!pane || _chipsLoading) return;
  if (!portfolio.length) { pane.innerHTML = '<span class="holdings-hint">尚無持股</span>'; return; }
  const held = portfolio
    .filter(s => /^0\d/.test(String(s.code)))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  if (!held.length) { pane.innerHTML = '<span class="holdings-hint">持股中無 ETF</span>'; return; }

  _chipsLoading = true;
  pane.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">' + spin('載入法人買賣超（近 ' + T86_DAYS + ' 個交易日）…') + '</div>';

  let t86days = [];
  try { t86days = await getRecentT86(T86_DAYS); } catch (e) {}
  if (!t86days.length) {
    pane.innerHTML = '<div style="padding:20px;text-align:center"><span class="holdings-nav-status fail" onclick="renderChipsTab()">法人資料載入失敗，點此重試</span></div>';
    _chipsLoading = false;
    return;
  }

  // 逐檔骨架
  pane.innerHTML = held.map(s => {
    const code = String(s.code).toUpperCase();
    return '<div class="vcard" style="margin-bottom:8px" id="chip-card-' + code + '">' +
      '<div class="vcard-head"><span class="vcard-code">' + code + '</span>' +
        '<span class="vcard-name">' + (s.name || '') + '</span></div>' +
      '<div id="chip-body-' + code + '" style="font-size:12px;color:var(--text2)">' + spin('計算中…') + '</div>' +
    '</div>';
  }).join('') +
  '<div class="api-note">籌碼分數＝Σ成分股權重×（外資連買賣天數＋投信連買賣天數，各上限±5）÷覆蓋權重，範圍±10。' +
  '正值（紅）＝法人偏多、負值（綠）＝偏空。資料：TWSE T86 近 ' + T86_DAYS + ' 個交易日；僅涵蓋上市成分股，美股/債券型不適用。</div>';

  for (const s of held) {
    const code = String(s.code).toUpperCase();
    const body = document.getElementById('chip-body-' + code);
    if (!body) continue;
    try {
      const data = await fetchEtfHoldings(code);
      const res = computeChipScore(data.holdings, t86days);
      if (!res) {
        body.innerHTML = '<span style="color:var(--text2)">不適用（美股/債券成分或無法人資料）</span>';
        continue;
      }
      const sc = res.score;
      const col = sc > 0.5 ? '#ff5252' : (sc < -0.5 ? '#26d962' : 'var(--text2)');
      const tag = sc > 2 ? '偏多' : (sc < -2 ? '偏空' : '中性');
      const contribHtml = res.contributors.map(c =>
        '<div style="display:flex;justify-content:space-between;gap:6px;padding:3px 0;border-top:1px solid var(--border);font-size:11px">' +
          '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">' + c.code +
            ' <span style="color:var(--text2)">' + c.name + '（' + c.weight.toFixed(1) + '%）</span></span>' +
          '<span style="white-space:nowrap;flex-shrink:0">' +
            '<span style="color:' + _streakColor(c.f) + '">' + _streakLabel(c.f, '外資') + '</span>　' +
            '<span style="color:' + _streakColor(c.t) + '">' + _streakLabel(c.t, '投信') + '</span></span>' +
        '</div>'
      ).join('');
      body.innerHTML =
        '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:2px 0 6px">' +
          '<span style="font-size:20px;font-weight:800;color:' + col + '">' + (sc > 0 ? '+' : '') + sc.toFixed(1) +
            '<span style="font-size:11px;font-weight:600;margin-left:5px">' + tag + '</span></span>' +
          '<span style="font-size:10px;color:var(--text2)">覆蓋 ' + res.coveredPct + '%｜近 ' + res.days + ' 日</span>' +
        '</div>' + contribHtml;
    } catch (e) {
      body.innerHTML = '<span style="color:var(--danger)">成分股載入失敗</span>';
    }
  }
  _chipsLoading = false;
}
