// 股利總管 模組：tdccflow — ETF 資金流週報（TDCC 集保股權分散，經 GAS ?tdcc=）
// 指標：受益人數、在外流通單位、千張大戶比、400張以上大戶比、散戶比(≤10張)。
// TDCC 每週五資料、開放資料僅提供最新一週 → 每週快照存 localStorage，自第二週起顯示週變化。

const TDCC_HIST_KEY = 'tdcc_hist_v1';
const TDCC_KEEP_WEEKS = 26;

function _tdccHist() { try { return JSON.parse(localStorage.getItem(TDCC_HIST_KEY)) || {}; } catch (e) { return {}; } }
function _tdccSave(h) { try { localStorage.setItem(TDCC_HIST_KEY, JSON.stringify(h)); } catch (e) {} }

function _tdccLatestDate(hist) {
  let latest = '';
  Object.keys(hist).forEach(c => Object.keys(hist[c]).forEach(d => { if (d > latest) latest = d; }));
  return latest; // 'YYYYMMDD' 或 ''
}
function _ymdDays(ymd) {
  return Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) / 86400000;
}
function _fmtYmd(ymd) { return ymd ? ymd.slice(0, 4) + '/' + ymd.slice(4, 6) + '/' + ymd.slice(6, 8) : ''; }

async function fetchTdccSnapshot(codes) {
  const r = await fetch(GAS_URL + '?tdcc=' + encodeURIComponent(codes.join(',')));
  const j = await r.json();
  if (j.stat !== 'OK' || !j.rows) throw new Error(j.error || 'TDCC 查詢失敗');
  return j;
}

function _fmtAbsUnits(v) { return v >= 1e8 ? (v / 1e8).toFixed(2) + '億' : (v / 1e4).toFixed(1) + '萬'; }

// 週變化欄：kind = 'int'(人數) | 'units'(單位數) | 'pp'(百分點)
function _flowDelta(cur, prev, kind) {
  if (prev == null) return '<span style="color:var(--text2)">—</span>';
  const d = cur - prev;
  const tiny = kind === 'pp' ? 0.005 : 0.5;
  if (Math.abs(d) < tiny) return '<span style="color:var(--text2)">持平</span>';
  const col = d > 0 ? '#ff5252' : '#26d962';
  const ar = d > 0 ? '▲' : '▼';
  let txt;
  if (kind === 'int') {
    txt = ar + Math.abs(d).toLocaleString('zh-TW') + '（' + Math.abs(d / prev * 100).toFixed(2) + '%）';
  } else if (kind === 'units') {
    txt = ar + _fmtAbsUnits(Math.abs(d)) + '（' + Math.abs(d / prev * 100).toFixed(2) + '%）';
  } else {
    txt = ar + Math.abs(d).toFixed(2) + 'pp';
  }
  return '<span style="color:' + col + '">' + txt + '</span>';
}

function _flowRow(label, curHtml, deltaHtml) {
  return '<div style="display:flex;align-items:baseline;gap:6px;padding:4px 0;border-top:1px solid var(--border);font-size:12px">' +
    '<span style="color:var(--text2);flex:0 0 96px">' + label + '</span>' +
    '<span style="font-weight:700;flex:0 0 74px;white-space:nowrap">' + curHtml + '</span>' +
    '<span style="margin-left:auto;font-size:11px;white-space:nowrap">' + deltaHtml + '</span>' +
  '</div>';
}

// ── 頁籤「資金流」──
let _flowLoading = false;
async function renderFlowTab(force) {
  const pane = document.getElementById('holdings-pane-flow');
  if (!pane || _flowLoading) return;
  if (!portfolio.length) { pane.innerHTML = '<span class="holdings-hint">尚無持股</span>'; return; }
  const held = portfolio
    .filter(s => /^0\d/.test(String(s.code)))
    .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  if (!held.length) { pane.innerHTML = '<span class="holdings-hint">持股中無 ETF</span>'; return; }

  _flowLoading = true;
  const codes = held.map(s => String(s.code).toUpperCase());
  let hist = _tdccHist();
  let latest = _tdccLatestDate(hist);
  const now = new Date(Date.now() + 8 * 3600000);
  const todayDays = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86400000;
  const stale = !latest || (todayDays - _ymdDays(latest)) >= 6;   // 週資料：距上次資料日 ≥6 天才重抓
  const missing = latest && codes.some(c => !(hist[c] && hist[c][latest]));
  let fetchErr = null;

  if (force || stale || missing) {
    pane.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text2)">' +
      spin('載入集保週資料（首次約 10~30 秒）…') + '</div>';
    try {
      const snap = await fetchTdccSnapshot(codes);
      codes.forEach(c => {
        const row = snap.rows[c];
        if (!row) return;
        if (!hist[c]) hist[c] = {};
        hist[c][snap.date] = row;
        const ds = Object.keys(hist[c]).sort();
        while (ds.length > TDCC_KEEP_WEEKS) delete hist[c][ds.shift()];
      });
      _tdccSave(hist);
      latest = _tdccLatestDate(hist);
    } catch (e) {
      fetchErr = e.message || '載入失敗';
      if (!latest) { // 完全沒資料可顯示
        pane.innerHTML = '<div style="padding:20px;text-align:center"><span class="holdings-nav-status fail" onclick="renderFlowTab(true)">集保資料載入失敗，點此重試</span></div>';
        _flowLoading = false;
        return;
      }
    }
  }

  // 渲染
  let onlyOneWeek = false;
  const cards = held.map(s => {
    const code = String(s.code).toUpperCase();
    const rec = hist[code] || {};
    const dates = Object.keys(rec).sort().reverse(); // 最新在前
    const cur = dates.length ? rec[dates[0]] : null;
    const prev = dates.length > 1 ? rec[dates[1]] : null;
    if (dates.length === 1) onlyOneWeek = true;
    let body;
    if (!cur) {
      body = '<div style="font-size:12px;color:var(--text2);padding:4px 0">查無集保資料</div>';
    } else {
      body =
        _flowRow('受益人數', cur.people.toLocaleString('zh-TW'), _flowDelta(cur.people, prev && prev.people, 'int')) +
        _flowRow('流通單位', _fmtAbsUnits(cur.units), _flowDelta(cur.units, prev && prev.units, 'units')) +
        _flowRow('千張大戶比', cur.big1000.toFixed(2) + '%', _flowDelta(cur.big1000, prev && prev.big1000, 'pp')) +
        _flowRow('400張大戶比', cur.big400.toFixed(2) + '%', _flowDelta(cur.big400, prev && prev.big400, 'pp')) +
        _flowRow('散戶比(≤10張)', cur.retail.toFixed(2) + '%', _flowDelta(cur.retail, prev && prev.retail, 'pp'));
    }
    return '<div class="vcard" style="margin-bottom:8px">' +
      '<div class="vcard-head" style="display:flex;align-items:baseline;gap:6px;white-space:nowrap;overflow:hidden">' +
        '<span class="vcard-code" style="flex-shrink:0">' + code + '</span>' +
        '<span class="vcard-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">' + (s.name || '') + '</span>' +
        '<span style="font-size:10px;color:var(--text2);flex-shrink:0">' +
          (dates.length ? '資料日 ' + _fmtYmd(dates[0]) + (prev ? '｜vs ' + _fmtYmd(dates[1]) : '') : '') + '</span>' +
      '</div>' + body + '</div>';
  }).join('');

  pane.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      '<span style="font-size:11px;color:var(--text2)">TDCC 每週五資料，每週自動記錄快照</span>' +
      '<button class="cname-toggle" onclick="renderFlowTab(true)">更新</button>' +
    '</div>' +
    (fetchErr ? '<div style="font-size:11px;color:#e88;margin-bottom:8px">本次更新失敗（' + fetchErr + '），顯示上次快照。</div>' : '') +
    cards +
    (onlyOneWeek ? '<div style="font-size:11px;color:var(--accent2);margin:4px 0 8px">已記錄本週快照，下週資料發布後開始顯示週變化。</div>' : '') +
    '<div class="api-note">受益人數/流通單位連週增加＝資金流入、規模成長；千張大戶比連週上升＝籌碼向大戶集中（偏多）、' +
    '大戶比降＋散戶比升＝籌碼轉散（過熱警訊）。快照存於本機，累積愈久趨勢愈可判讀。</div>';
  _flowLoading = false;
}
