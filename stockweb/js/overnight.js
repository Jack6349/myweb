// 股利總管 Web — 隔夜推估（進場訊號板的上半部）
//
// 回答的是「明天開盤跳到哪、日內最低到哪、收盤大概在哪」，而且直接給**價格**不是百分比：
// 掛單要的是可以抄進委託單的數字，差額還得自己加減一次。價格一律對齊升降單位。
//
// 兩個輸入：台指期夜盤漲幅 ＋ 隔夜費半漲幅。
//   夜盤比費半準（台灣市場自己對美股結論的定價），但兩個一起最好——
//   2026-11-10 實測七檔全部如此，例如 00988A 的說明力 0.42（只用夜盤）、0.40（只用費半）、0.48（兩個）。
//   夜盤對日盤幾乎一比一（446 天，倍率 1.010、偏差 +0.03），沒有系統性高估或低估。
//
// 夜盤歷史 Yahoo 沒有，來自本機券商連線，存成 data/night-txf.json 由排程每日更新；
// 當天那一筆直接問本機伺服器（檔案可能還沒更新）。伺服器沒開就退回只用費半。
//
// 說明力最高 0.54、最低 0.26：**一半以上的隔日漲跌這兩個訊號解釋不了**。
// 所以卡片給的是區間不是點，而且區間寬度各檔不同（偏移度那張表）。

// 分 K 的時刻標在「那一分鐘的結尾」，不是開頭。
// 實測兩次：牆上時鐘 00:36:51 時最後一根標 00:37:00，00:38:27 時標 00:39:00。
// 也就是標 00:34 的那根涵蓋的是 00:33:00～00:33:59。
// 直接把標籤當成成交時刻顯示，畫面會比系統時間早一分鐘，看起來像抓到了未來的資料。
// loadTxfIntra 的檔頭寫「日盤 08:46 → 13:45」也是同一件事：開盤是 08:45，
// 第一根被標成 08:46。
function kbarMin(iso) {
  if (!iso || iso.length < 16) return '';
  var h = +iso.slice(11, 13), m = +iso.slice(14, 16) - 1;
  if (m < 0) { m = 59; h = (h + 23) % 24; }
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

var OV_SD_HL = 10;       // 區間寬度的半衰期（交易日），見 _ovFit 檔頭

// ── 區間的上下緣要分開定，而且下緣要隨「隔夜費半跌幅」切換 ──
//
// 原本上下各一個半衰加權殘差，對稱。走查回測（八檔、319 個交易日、953 筆，
// 每一天只用該日之前的資料重新配適，不讓模型看到未來）顯示這在費半大跌的
// 隔天不成立：
//   隔夜費半 ≤ −3% 的隔天，收盤跌破下緣 32.9%，其餘日子 15.7%；
//   但跌破上緣兩組一樣，15.1% 對 14.6%。
// 也就是那天的殘差分布是整個往下拖，不是變寬。對稱放寬會兩邊都錯：實測把
// 寬度一律乘 1.59，破上緣掉到 3.6%（上緣幾乎碰不到），下緣還是破 24.6%。
//
// 所以改成四個邊界各自取走查殘差的分位數，p16 當下緣、p84 當上緣，
// 單位是一個半衰加權殘差。數字是量出來的：
//   收盤下緣      門檻日 2.30，其餘 0.96
//   收盤上緣      兩組都用 0.95（門檻日量到 0.96，差距在雜訊內，不另外分）
//   日內最低下緣  門檻日 2.31，其餘 1.09
//   日內最低上緣  兩組都用 0.78（門檻日量到 0.73）
//
// 前瞻驗證：用前半段（切在 2026-03-24）估出的倍率套到後半段，門檻日破下緣
// 18.1%、其餘日 17.0%，對照目標 16%。改之前門檻日是 29% 到 33%。
// 倍率在時間上也穩：門檻日的收盤下緣前半段 2.20、後半段 2.30。
//
// 門檻為什麼設在 −3% 而不是更低：−4% 到 −3% 這一段破下緣 36.7%（16 天），
// ≤ −4% 反而降到 23.5%（27 天），關係不是單調的，費半漲跌與破下緣比例的線性
// 相關只有 −0.08。它只能當門檻用，不能當連續訊號。27 天分不出「極端大跌當天
// 就反應完了」是原因還是雜訊，所以不往下再切一層。
//
// 門檻日總共只有 43 天，這幾個倍率自己的誤差不小。
var OV_SD_GATE = -3;      // 隔夜費半的門檻（%）
var OV_K = {
  cLo: { gate: 2.30, base: 0.96 },    // 收盤下緣
  cHi: { gate: 0.95, base: 0.95 },    // 收盤上緣
  lLo: { gate: 2.31, base: 1.09 },    // 日內最低下緣
  lHi: { gate: 0.78, base: 0.78 }     // 日內最低上緣
};
function _ovGate(sox) { return sox != null && sox <= OV_SD_GATE; }
function _ovK(which, sox) {
  var k = OV_K[which] || OV_K[which.slice(-2) === 'Lo' ? 'cLo' : 'cHi'];
  return _ovGate(sox) ? k.gate : k.base;
}

// ── 海外指數要不要當第三個因子：兩道閘，兩道都過才納入 ──
//
// 第一道是結構：這一檔的成份股有多少比例在海外。純台股的基金沒有理由掛 Nasdaq，
// 連測都不該測——八檔一起測四個因子等於 32 次檢定，在 p<0.05 下本來就會蹦出一兩個假陽性。
// 先用持股把範圍縮到說得出理由的那幾檔，統計才是在驗證假設而不是撈資料。
//
// 第二道是統計：在夜盤與費半之上，Nasdaq 還能不能多解釋一截（增量 F 檢定）。
//
// 2026-11-14 實測，兩道閘各自擋掉不同的東西：
//   00988A 外股 68.1%（美股 65.0%），F=9.59 → 納入。走查預測誤差 1.843 → 1.791。
//   00402A 外股 98.4% 但 F=0.11 → 不納入。它是美股半導體，費半已經蓋掉了，
//          而且台指期夜盤 15:00～05:00 跨完整個美股盤，本來就是更晚、更完整的一次定價。
//   其餘六檔外股 0%，第一道就擋下，不進統計。
//
// 所以這不是「替 00988A 開特例」，是一條規則；哪一檔過關由它自己的持股與資料決定。
// ── 開盤之後改用「今天走到現在的價」重新定心（盤中校準）──
//
// 開盤前這一頁的兩個輸入都是隔夜已經定價完的資訊，台股自己盤中新生的買賣壓不在裡面。
// 開盤之後那股力道已經部分表現在價格上，拿它回頭修正推估，比抱著開盤前那條不動好。
//
// 條件變數只有一個數字，單位是百分點：現在的價對前收的漲幅，減掉開盤模型推的開盤漲幅。
// 所以執行期只需要開盤模型與現價，不需要任何盤中歷史，也不需要新的資料檔。
//
// 單位一定要是百分點，不能先除以殘差寬度再乘回來。兩種寫法在配適時 R² 一樣，
// 但推論時不同：標準化那版的斜率換回百分點之後，等效斜率會隨「收盤殘差寬度 ÷ 開盤殘差寬度」
// 這個比值跑，實測散在 0.48 到 1.72。2026-11-17 盤中踩到過：那天這個比值偏大，
// 等效斜率變成 1.33，八檔的推估收盤全部被外推到低於現價，其中兩檔的現價跑到區間上緣之外。
// 原始百分點下 09:30 之後穩定在 1.02 到 1.08，而且八檔一致（0.88 到 1.12）。
//
// 量測用八檔的分鐘 K（953 筆、313 個交易日），每個時點各自走查：
// 每一天只用該日之前的資料重新配適，不讓模型看到未來。
//
// 另一種做法是替每個時點各配一條迴歸（需要把盤中歷史存成資料檔、每天重算）。
// 兩者實測幾乎同分，所以不做：同覆蓋率下收盤區間窄掉的幅度，
// 09:30 是 30% 對 29%、10:30 是 48% 對 46%、11:30 是 62% 對 62%、13:00 是 70% 對 79%。
// 只有 12:30 之後落後 4 到 9 個百分點，而那時區間本來就只剩零點幾毛。
//
// 收盤的斜率幾乎是 1：現在偏離開盤推估多少，收盤大概就偏離多少，不系統性延續也不回吐。
// 日內最低的斜率從 1.07 掉到 0.78，因為時間愈晚、還能破新低的時間愈短。
//
// 前瞻驗證（斜率只用前半段的日期估，跨距只在後半段量），同覆蓋率下區間窄掉的幅度：
//   時點    收盤  最低        時點    收盤  最低
//   開盤    16%   31%         11:00   59%   51%
//   09:05   26%   39%         11:30   65%   54%
//   09:15   31%   46%         12:00   70%   53%
//   09:30   34%   46%         12:30   73%   56%
//   10:00   46%   47%         13:00   77%   55%
//   10:30   50%   48%
// 門檻日的幅度更大：09:30 收盤就有 49%、12:00 有 76%。
//
// 日內最低在 12:00 之後停止改善（停在 53% 到 56%）：那時當日最低通常已經走出來，
// 剩下的不確定性只有最後一個半小時會不會破新低，那一截不會因為時間過去而變小。
//
// 收盤那條到 12:30 之後已經不是推估：相關 0.93 到 0.98，意思是它跟現價幾乎同一件事。
// 使用者決定做到 13:00，所以保留，但說明要講清楚那時候它在重複現價。
//
// 倍率是條件殘差的第 16 與第 84 百分位，門檻日與其餘日分開算。門檻日只有 146 筆、
// 而且切點之前只有 14 到 30 天，所以門檻日那一組估不出前瞻驗證，只能標樣本不足。
// 開盤那一格的斜率也最不穩：全樣本 1.18、前半段 0.97，逐檔散在 0.62 到 1.34。
var OV_CAL_T = ['open', '09:05', '09:15', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00'];
var OV_CAL = {
  // bc／bl＝收盤與日內最低的修正斜率，單位是百分點對百分點；
  // kc／kl＝區間倍率 [下緣, 上緣]，單位是一個半衰加權殘差，g 是門檻日、b 是其餘日
  'open':  { bc: 1.178, bl: 1.071, kc: { g: [1.72, 0.94], b: [0.75, 0.73] }, kl: { g: [1.50, 0.67], b: [0.80, 0.59] } },
  '09:05': { bc: 1.179, bl: 1.049, kc: { g: [1.33, 0.84], b: [0.74, 0.70] }, kl: { g: [1.28, 0.59], b: [0.74, 0.49] } },
  '09:15': { bc: 1.096, bl: 0.951, kc: { g: [0.84, 0.79], b: [0.69, 0.65] }, kl: { g: [1.14, 0.46], b: [0.63, 0.48] } },
  '09:30': { bc: 1.043, bl: 0.900, kc: { g: [0.82, 0.71], b: [0.63, 0.64] }, kl: { g: [0.90, 0.29], b: [0.66, 0.47] } },
  '10:00': { bc: 1.045, bl: 0.845, kc: { g: [0.71, 0.58], b: [0.48, 0.50] }, kl: { g: [0.93, 0.41], b: [0.61, 0.46] } },
  '10:30': { bc: 1.076, bl: 0.856, kc: { g: [0.76, 0.65], b: [0.44, 0.48] }, kl: { g: [0.93, 0.45], b: [0.60, 0.45] } },
  '11:00': { bc: 1.062, bl: 0.843, kc: { g: [0.70, 0.51], b: [0.34, 0.43] }, kl: { g: [0.90, 0.39], b: [0.60, 0.43] } },
  '11:30': { bc: 1.052, bl: 0.840, kc: { g: [0.48, 0.46], b: [0.30, 0.37] }, kl: { g: [0.66, 0.35], b: [0.59, 0.40] } },
  '12:00': { bc: 1.021, bl: 0.805, kc: { g: [0.30, 0.50], b: [0.25, 0.31] }, kl: { g: [0.66, 0.36], b: [0.55, 0.42] } },
  '12:30': { bc: 1.034, bl: 0.798, kc: { g: [0.32, 0.53], b: [0.21, 0.31] }, kl: { g: [0.64, 0.32], b: [0.54, 0.44] } },
  '13:00': { bc: 1.042, bl: 0.776, kc: { g: [0.24, 0.34], b: [0.16, 0.28] }, kl: { g: [0.80, 0.26], b: [0.56, 0.44] } }
};
// 寬度的下限。半衰加權殘差會塌到近乎零：量測時 09:15 那一組有一列算出 0.0006，
// 標準化之後是 1018 倍，整個相關係數被一列吃掉。連續幾天殘差接近零就會這樣。
// 不設下限的後果是某一天的區間縮成一條線，而畫面不會告訴你那是算壞的。
var OV_SD_FLOOR = 0.30;   // 不低於訓練期全樣本殘差標準差的三成
function _ovSdF(f) {
  if (!f) return null;
  var a = f.sdEw, b = OV_SD_FLOOR * f.sd;
  return (a > 0 && b > 0) ? Math.max(a, b) : (a > 0 ? a : b);
}
// 幾點幾分落在哪一組倍率。取「不晚於現在」的最後一個時點，所以 09:20 用 09:15 那一組，
// 寧可用早一點、比較寬的那一組。09:00 之前與 13:35 之後都不校準。
function _ovCalSlot(hm) {
  if (!hm || hm < '09:00' || hm > '13:35') return null;
  var best = null;
  for (var i = 0; i < OV_CAL_T.length; i++) {
    var T = OV_CAL_T[i], at = (T === 'open') ? '09:00' : T;
    if (hm >= at) best = T; else break;
  }
  return best;
}
function _ovCalLab(slot) { return slot === 'open' ? '開盤' : slot; }

var OV_FGN_W = 50;       // 外股權重門檻（%）
var OV_ADD_F = 3.95;     // 增量 F 門檻，約 p<0.05
var _ovIxic = null;      // Nasdaq 日報酬

async function _ovIxicLoad() {
  if (_ovIxic) return _ovIxic;
  try {
    var b = await _rbSeries('^IXIC', (_rbData && _rbData.cfg ? _rbData.cfg.years : 3));
    if (!b || b.length < 60) return null;
    var m = {}, ds = [];
    for (var i = 1; i < b.length; i++) {
      if (!(b[i - 1].c > 0)) continue;
      m[b[i].d] = (b[i].c / b[i - 1].c - 1) * 100; ds.push(b[i].d);
    }
    _ovIxic = { rets: m, dates: ds, prev: _rbPrevFn(ds) };
  } catch (e) { hush('overnight', e); }
  return _ovIxic;
}
// 這一檔的外股權重（%）。拿不到成份股就回 null，等於第一道閘關著。
function _ovFgnW(code) {
  var m = (typeof _constMap !== 'undefined' && _constMap) ? _constMap[String(code)] : null;
  if (!m || !m.rows || !m.rows.length) return null;
  var w = 0;
  m.rows.forEach(function (r) { if (r.kind !== 'TW') w += r.weight; });
  return w;
}
var OV_URL = 'data/night-txf.json';
var OV_REC_LS = 'overnight_rec_v1';      // 命中率紀錄（預測 vs 實際）
var _ovNight = null, _ovToday = null, _ovBusy = false, _ovRec = null, _ovAt = null;

// ── 夜盤資料 ──
async function ovLoadNight() {
  if (_ovNight) return _ovNight;
  try {
    var r = await fetch(OV_URL, { cache: 'no-cache' });
    var j = r.ok ? await r.json() : null;
    _ovNight = (j && j.map) || {};
  } catch (e) { hush('overnight', e); _ovNight = {}; }
  return _ovNight;
}
// 當天那一筆：檔案由排程每日更新，可能還沒跑，所以直接問本機伺服器。
// 伺服器沒開就退回檔案裡最後一筆（並標示日期，讓使用者看得出是不是舊的）。
// 往後頂到下一個交易日。週六日一律不算：辦公日曆裡的「補班星期六」
// 是上班日、不是開盤日，只拿日曆判會把它當成交易日。
// 日曆沒涵蓋到的年份 _divIsOff 回 null，那時就只跳週六日，漏掉國定假日。
function _ovRollTrade(iso) {
  if (!iso) return iso;
  var d = new Date(iso + 'T00:00:00Z');
  for (var i = 0; i < 14; i++) {
    var cur = d.toISOString().slice(0, 10), g = d.getUTCDay();
    var off = (g === 0 || g === 6);
    if (!off && typeof _divIsOff === 'function') { var h = _divIsOff(cur); if (h === true) off = true; }
    if (!off) return cur;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return iso;                                  // 連 14 天都不開盤＝日曆有問題，原值回去
}
async function ovTodayNight() {
  if (_ovToday) return _ovToday;
  var nm = await ovLoadNight();
  var fallback = function () {
    var ks = Object.keys(nm).sort();
    var d = ks[ks.length - 1];
    return d ? { d: d, pct: nm[d], src: 'file' } : null;
  };
  try {
    var now = new Date(Date.now() + 8 * 3600000);
    var from = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
    var to = now.toISOString().slice(0, 10);
    var r = await fetch('/api/v1/data/kbars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract: { security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1' }, start: from, end: to })
    });
    if (!r.ok) throw new Error('kbars HTTP ' + r.status);
    var j = await r.json();
    var dt = j.datetime || [], cl = j.Close || [];
    // 要的是「還沒被任何現貨盤消化掉的那一夜」：
    // 找最後一個已收盤的日盤當基準，再取它之後的最後一根夜盤價。
    //
    // 舊寫法用「最後兩個日盤日期」配對，永遠指到上一夜——而上一夜早就被
    // 上一個日盤反應完了。2026-11-11 03:36 實例：推估卡顯示 +2.70%（是 11/09 夜、
    // 11/10 日盤已經漲 +2.52% 反應過），而總覽顯示的今晚這一盤是 −0.47%。
    var lastDayIdx = -1, lastDayDate = null;
    for (var i = 0; i < dt.length; i++) {
      var hm = dt[i].slice(11, 16);
      if (hm >= '08:45' && hm <= '13:45') { lastDayIdx = i; lastDayDate = dt[i].slice(0, 10); }
    }
    if (lastDayIdx < 0) throw new Error('日盤資料不足');
    var baseClose = cl[lastDayIdx];
    // 日盤收盤之後的最後一根夜盤（夜盤 15:00～次日 05:00，可跨午夜）
    var nIdx = -1;
    for (var k = lastDayIdx + 1; k < dt.length; k++) {
      var h2 = dt[k].slice(11, 16);
      if (h2 >= '15:00' || h2 <= '05:00') nIdx = k;
    }
    var pending = nIdx >= 0;          // 這一夜還沒開過盤
    if (!pending) {
      // 今天日盤已收、今晚還沒開：退回「驅動這一個日盤的那一夜」，卡頭會標成已開過盤
      // 往回找上一夜。遇到日盤就停——但盤中時 lastDayIdx 本身就在今天的日盤裡，
      // 往回走的頭幾十根還是今天的日盤，一遇到就停等於永遠找不到夜盤。
      // 2026-11-13 11:13 實測：整個 08:45～15:00 都抽不到，退回資料檔，
      // 畫面因此推估「昨天」那一盤，而且沒有任何地方說它是昨天的。
      // 只有走到「更早那一天的日盤」才算越界。
      var pIdx = -1;
      for (var q = lastDayIdx - 1; q >= 0; q--) {
        var h3 = dt[q].slice(11, 16);
        if (h3 >= '08:45' && h3 <= '13:45') { if (dt[q].slice(0, 10) !== lastDayDate) break; continue; }
        if (h3 >= '15:00' || h3 <= '05:00') { if (pIdx < 0) pIdx = q; }
      }
      // 基準價要取「更早那一天」的日盤收盤，不是今天盤中的價
      var prevDayIdx = -1;
      for (var q2 = lastDayIdx - 1; q2 >= 0; q2--) {
        var h4 = dt[q2].slice(11, 16);
        if (h4 >= '08:45' && h4 <= '13:45' && dt[q2].slice(0, 10) !== lastDayDate) { prevDayIdx = q2; break; }
      }
      if (pIdx < 0 || prevDayIdx < 0) throw new Error('夜盤資料不足');
      nIdx = pIdx; baseClose = cl[prevDayIdx]; lastDayDate = dt[prevDayIdx].slice(0, 10);
    }
    if (!(cl[nIdx] > 0) || !(baseClose > 0)) throw new Error('夜盤資料不足');
    // d＝這一夜要驅動的那個交易日。夜盤跨午夜後就是那一天；
    // 還沒跨午夜（像晚上 20:00）則是基準日的隔天。
    var nd = dt[nIdx].slice(0, 10);
    var drive = (nd > lastDayDate) ? nd
      : new Date(Date.parse(lastDayDate) + 86400000).toISOString().slice(0, 10);
    // 算出來的可能不是交易日，要往後頂到下一個開盤日。
    // 週五夜盤 15:00 跨到週六 05:00，nd 就是週六；
    // 週五晚上還沒跨午夜時走下面那條，算出來也是週六。
    // 不頂的後果：週一盤中打開時，這一頁認為自己推的是週六那一盤，
    // 現價（今天）跟它對不上，整欄被當成「別的盤的價」標灰並拿掉漲跌。
    // 2026-11-16（週一）10:52 實例：nd＝11/14（週六），現價 11/16。
    drive = _ovRollTrade(drive);
    _ovToday = { d: drive, pct: (cl[nIdx] / baseClose - 1) * 100, src: 'live',
                 base: lastDayDate, at: kbarMin(dt[nIdx]), pending: pending,
                 bp: baseClose, np: cl[nIdx] };
  } catch (e) { hush('overnight', e); _ovToday = fallback(); }
  return _ovToday;
}

// ── 最小平方（常數＋任意個因子），高斯消去直接解 ──
// 原本寫死兩個因子。改成吃陣列是為了讓少數幾檔可以多掛一個海外指數，
// 判準寫在 _ovFactors。
function _ovFit(Xs, Y, tgt) {
  var n = Y.length, K = Xs.length + 1;
  if (n < 40 + (Xs.length - 2) * 10) return null;   // 多一個因子就多要 10 天
  var X1 = Xs[0], X2 = Xs[1];
  var col = function (a, i) { return a === 0 ? 1 : Xs[a - 1][i]; };
  var s = function (f) { var t = 0; for (var i = 0; i < n; i++) t += f(i); return t; };
  var M = [];
  for (var a = 0; a < K; a++) {
    M.push([]);
    for (var b2 = 0; b2 <= K; b2++) {
      M[a].push(s(function (i) { return col(a, i) * (b2 < K ? col(b2, i) : Y[i]); }));
    }
  }
  for (var c = 0; c < K; c++) {
    var p = c;
    for (var r2 = c; r2 < K; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[p][c])) p = r2;
    var t2 = M[c]; M[c] = M[p]; M[p] = t2;
    if (Math.abs(M[c][c]) < 1e-10) return null;
    for (var r3 = 0; r3 < K; r3++) {
      if (r3 === c) continue;
      var f = M[r3][c] / M[c][c];
      for (var k = c; k <= K; k++) M[r3][k] -= f * M[c][k];
    }
  }
  var b = []; for (var a2 = 0; a2 < K; a2++) b.push(M[a2][K] / M[a2][a2]);
  var pred = function (i) { var q = b[0]; for (var a3 = 1; a3 < K; a3++) q += b[a3] * Xs[a3 - 1][i]; return q; };
  var my = s(function (i) { return Y[i]; }) / n, ss = 0, tot = 0, resU = [], resD = [];
  // 區間寬度用「近期加權」的殘差，不是全部歷史的平均。
  //
  // 全部歷史那一版，實測覆蓋率只有 57 到 58%（00981A、00988A），而卡片寫「約三分之二」。
  // 原因是殘差本身會變：00981A 分段估是 1.48、1.27、2.25、2.91、2.38，最大是最小的 2.3 倍，
  // 平均進去等於用平靜期的尺去量現在。
  //
  // 半衰期 10 日是測出來的，不是挑的。八檔的覆蓋率偏離 68% 的平均絕對值：
  // 全部歷史 7.6、半衰60 5.6、半衰30 4.7、半衰20 3.5、半衰15 2.2、半衰10 1.9、半衰5 1.8。
  // 5 到 15 是一片平台，取 10 是因為更短會讓區間每天跳一到三個升降單位（半衰5 是 0.011～0.034 元，
  // 半衰10 是 0.006～0.018 元），畫面會抖而校準沒有變好。
  //
  // 係數維持全部歷史：測過 45、60、75、90 日與各種加權，四檔裡三檔都比全部歷史差。
  // 係數的時變性偵測不到（分段變異 ÷ 估計誤差應有的變異＝0.72 與 0.21，都小於 1）。
  // fhit：實際值有沒有跌到當天推的那個中心（殘差 <= 0）。
  // 只有 tgt='l' 的那一次有意義，因為 Y 是日內最低。
  // 最小平方的殘差平均是 0，所以這個比例一定在五成附近打轉，
  // 真正會把它推離五成的是殘差的偏態：最低價的殘差右偏（偶爾跌很深），
  // 中位數就會落在 0 的另一邊。
  // zs：標準化殘差，也就是殘差除以當天自己的區間寬度。
  //
  // 卡片上的機率曲線直接數這一份，所以它跟區間邊界必定對得起來：
  // 邊界是這份分布的 16% 與 84% 分位，曲線在那兩點讀出來就是 16% 與 84%。
  // 不標準化不行：殘差寬度每天不同，把寬鬆期與平靜期的殘差混在一起數，
  // 數出來的機率會被寬鬆期那幾天拉開。
  var lam = Math.pow(0.5, 1 / OV_SD_HL), v = null, hit = 0, cvn = 0, fhit = 0, zs = [];
  for (var i2 = 0; i2 < n; i2++) {
    var e = Y[i2] - pred(i2);
    ss += e * e; tot += (Y[i2] - my) * (Y[i2] - my);
    if (X1[i2] > 0) resU.push(e); else if (X1[i2] < 0) resD.push(e);
    // 實測覆蓋率：當下那條區間有沒有罩住當天的實際值。前 40 天讓 EWMA 先收斂。
    // 覆蓋率要用當天自己的那一組邊界算，而且上下緣不同。用對稱寬度算出來的
    // 覆蓋率講的是另一條區間，畫面上那個「罩住幾成」就會跟實際畫出來的對不起來。
    // tgt 指明算的是收盤（'c'）還是日內最低（'l'）。
    if (v != null && i2 >= 40) {
      var sd0 = Math.sqrt(v), gx = X2[i2], tg = tgt || 'c';
      if (e >= -_ovK(tg + 'Lo', gx) * sd0 && e <= _ovK(tg + 'Hi', gx) * sd0) hit++;
      if (e <= 0) fhit++;
      zs.push(e / sd0);
      cvn++;
    }
    v = (v == null) ? e * e : lam * v + (1 - lam) * e * e;
  }
  return {
    n: n, k: K, co: b, a: b[0], bN: b[1], bS: b[2], bX: (K > 3 ? b[3] : null),
    r2: tot ? 1 - ss / tot : null, ss: ss,
    sd: Math.sqrt(ss / (n - K)),
    sdEw: (v == null) ? Math.sqrt(ss / (n - K)) : Math.sqrt(v),
    cover: cvn ? hit / cvn * 100 : null, coverN: cvn,
    fill: cvn ? fhit / cvn * 100 : null,
    zq: _ovQuant(zs, OV_ZQ),
    resU: resU, resD: resD
  };
}
// 說明力分三段亮度。這一頁的紅綠是漲跌，不能拿來標可信度。
//
// 門檻 0.5 與 0.25 是「解釋掉一半」「解釋掉四分之一」，不是從目前這幾檔的分布倒推的
// （那會隨持股變動而漂移）。實測兩個更自然的候選都分不出差別：
// 區間校不校準（八檔全在 68% ± 2 標準誤內）、訊號顯不顯著（F 值 20 到 109，門檻 3.1）。
// 會變的只有幅度，所以顏色接幅度。
// ── 把一串殘差壓成分位點 ──
//
// 整串帶著走沒有必要：卡片只需要「某個值落在第幾成」，60 段的解析度
// 換算成機率是 1.7 個百分點，比圖上一個像素還細（圖高 128px，一格 0.78 個百分點）。
// 四百多個數字存成 61 個，記憶體與序列化都省下來，畫出來的線看不出差別。
var OV_ZQ = 60;
function _ovQuant(a, n) {
  if (!a || a.length < 20) return null;
  var b = a.slice().sort(function (x, y) { return x - y; }), o = [];
  for (var i = 0; i <= n; i++) {
    var t = i / n * (b.length - 1), k = Math.floor(t), f = t - k;
    o.push(+(b[k] + (b[Math.min(k + 1, b.length - 1)] - b[k]) * f).toFixed(4));
  }
  return o;
}
// 已排序的分位點 → 累積機率（百分比）。兩點之間線性內插，因為樣本本來就是離散的。
function ovCdf(zq, z) {
  if (!zq || !zq.length) return null;
  var n = zq.length - 1;
  if (z <= zq[0]) return 0;
  if (z >= zq[n]) return 100;
  for (var i = 1; i <= n; i++) {
    if (z <= zq[i]) {
      var w = zq[i] - zq[i - 1];
      return (i - 1 + (w > 0 ? (z - zq[i - 1]) / w : 0)) / n * 100;
    }
  }
  return 100;
}

function _ovTier(r2) {
  if (r2 == null) return 'ov-t0';
  return (r2 > 0.5) ? 'ov-t3' : ((r2 >= 0.25) ? 'ov-t2' : 'ov-t1');
}
function _ovSd(a) {
  if (!a || a.length < 8) return null;
  var m = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  return Math.sqrt(a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / a.length);
}
function _ovMed(a) {
  if (!a || !a.length) return null;
  var s2 = a.slice().sort(function (x, y) { return x - y; }), m = s2.length >> 1;
  return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
}
// 升降單位：50 元以下 0.01，以上 0.05。對齊之後才能直接抄進委託單
function ovTick(p) {
  if (!(p > 0)) return null;
  var u = p < 50 ? 0.01 : 0.05;
  return Math.round(Math.round(p / u) * u * 100) / 100;
}
// 持股成本均價（與持股庫存同一個來源）。
// 只在關注清單、沒有持股的回 null，表上標「—」——
// 標 0 會被讀成「成本是零」，跟「沒有這筆持股」是兩回事。
// ═════ 進場訊號板的表格排序（三張表共用）═════
//
// 價格類欄位照排：掋單時要看預算、要算幾張買得起。
// 但要知道實測的結果：依前收、依預估日內最低、依預估收盤排出來是同一個順序——
// 這幾檔的預估漲跌都在幾個百分點之內，價格水準差好幾倍，把排序蓋過去了。
// 成交率表的掋價格子更絕對：每格是前收 × (1+k%)，k 對整欄固定，
// 依它的價格排必然等於依前收排，所以那幾欄排的是成交率。
//
// 沒值的一律墊底（升冪降冪都是），與全站其他表格一致。
function rbSortGet(ls, def) {
  try {
    var v = localStorage.getItem(ls);
    if (v && /(Asc|Desc)$/.test(v)) return v;
  } catch (e) {}
  return def;
}
function rbSortNext(cur, k) { return cur === k + 'Desc' ? k + 'Asc' : k + 'Desc'; }
function rbSortTh(state, fn, k, label, tip) {
  var on = state.replace(/(Asc|Desc)$/, '') === k, asc = on && /Asc$/.test(state);
  return '<th class="num sort-th' + (on ? ' sorted' : '') + '" onclick="' + fn + '(\'' + k + '\')"'
    + (tip ? ' title="' + tip + '"' : '') + '>' + label
    + '<span class="sort-ind">' + (on ? (asc ? '\u25b2' : '\u25bc') : '\u2195') + '</span></th>';
}
function rbSortRows(rows, state, val) {
  var k = state.replace(/(Asc|Desc)$/, ''), asc = /Asc$/.test(state);
  var idx = {}; rows.forEach(function (r, i) { idx[r] = i; });
  return rows.slice().sort(function (a, b) {
    var x = val(a, k), y = val(b, k);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    var c = (typeof x === 'string') ? x.localeCompare(y, undefined, { numeric: true }) : x - y;
    return asc ? c : -c;
  });
}

// 預設不綁在任何一欄：維持原本「預估收盤漲幅由大到小」的順序，
// 點了欄位才改排。價格類欄位照排價格（掋單要算預算與張數）。
var OV_SORT_LS = 'ov_sort_v1', OV_DSORT_LS = 'ov_dsort_v1';
var _ovSort = rbSortGet(OV_SORT_LS, 'cPctDesc');
var _ovDSort = rbSortGet(OV_DSORT_LS, 'sdAsc');
function ovSort(k) {
  _ovSort = rbSortNext(_ovSort, k);
  try { localStorage.setItem(OV_SORT_LS, _ovSort); } catch (e) {}
  if (typeof rbRender === 'function') rbRender();
}
function ovDSort(k) {
  _ovDSort = rbSortNext(_ovDSort, k);
  try { localStorage.setItem(OV_DSORT_LS, _ovDSort); } catch (e) {}
  if (typeof rbRender === 'function') rbRender();
}
function _ovSortVal(r, k) {
  if (k === 'code') return r.code;
  if (k === 'live') { var lv = _ovLiveOf(r.code); return lv ? lv.px : null; }
  if (k === 'range') return r.loPx;          // 範圍照價格排（下界）
  if (k === 'actC') return r.act ? r.act.c : null;
  if (k === 'actL') return r.act ? r.act.l : null;
  return r[k] == null ? null : r[k];
}
function _ovDSortVal(r, k) {
  if (k === 'code') return r.code;
  // 偏移度按「元」排（使用者指定）：百分點 × 前收 ÷ 100
  var y = function (v) { return (v == null || !(r.basePx > 0)) ? null : v * r.basePx / 100; };
  if (k === 'sd') return y(r.sd);
  if (k === 'medUp') return y(r.medUp);
  if (k === 'medDn') return y(r.medDn);
  return null;
}

// ══════════ 現價（盤中即時，收盤後停住）══════════
// 這一頁本來只有日線，沒有任何即時來源。推估的那一盤正在進行時，
// 旁邊沒有現價就只能自己切到別頁對照——推估與實際是這張表的全部重點。
//
// 收盤後不動：盤中每 30 秒抓一次券商快照，13:35 之後那一輪直接跳過，
// 畫面停在最後一次抓到的價。不是「凍結一個舊值」，是收盤價本來就不會再變。
var OV_LIVE_MS = 30000;
var _ovLive = {};          // code -> { px, d, at }
var _ovLiveAt = '', _ovLiveOpen = null, _ovLiveTimer = null;

function _ovEx(code) {
  var ct = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
  if (ct && ct.exchange) return ct.exchange;
  var f = ((typeof _wtIdx !== 'undefined' && _wtIdx) || []).filter(function (x) { return x.c === code; })[0];
  return f ? f.e : 'TSE';
}
// 要抓現價的名單：這一頁的標的，加上債券那兩個頁籤的標的。
// 債券不在 _rbData.codes 裡（那份只收結尾 A 的持股與關注清單），
// 所以持有但沒放進關注清單的債券原本抓不到價。
function _ovLiveCodes() {
  var out = [], seen = {};
  ((_rbData && _rbData.codes) || []).forEach(function (c) {
    c = String(c); if (!seen[c]) { seen[c] = 1; out.push(c); }
  });
  if (typeof _ovbCodes === 'function') {
    try {
      _ovbCodes().forEach(function (c) {
        c = String(c); if (!seen[c]) { seen[c] = 1; out.push(c); }
      });
    } catch (e) { hush('overnight-live', e); }
  }
  return out;
}
async function _ovLiveTick(always) {
  var view = document.getElementById('rebound-view');
  if (!view || view.style.display === 'none' || document.hidden) return;
  if (!_rbData) return;
  var want = _ovLiveCodes();
  if (!want.length) return;
  if (typeof fetchSnapshots !== 'function') return;
  var open = (typeof _twOpen === 'function') ? _twOpen() : false;
  // 收盤後只在進頁那一次抓（always），之後每一輪都在這裡掉頭
  if (!always && !open) return;
  try {
    var sn = await fetchSnapshots(want.map(function (c) { return { exchange: _ovEx(c), code: c }; }));
    (sn || []).forEach(function (x) {
      if (x && x.code && x.close > 0) {
        // 開盤價與當日最低也存下來：盤中校準要用開盤當基準，日內最低要用它封頂
        _ovLive[String(x.code)] = { px: +x.close, op: (x.open > 0 ? +x.open : null),
          lo: (x.low > 0 ? +x.low : null), hi: (x.high > 0 ? +x.high : null),
          d: (x.datetime || '').slice(0, 10),
          at: (x.datetime || '').slice(11, 19) };
      }
    });
    _ovLiveAt = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 19);
    _ovLiveOpen = open;
    if (typeof rbRender === 'function') rbRender();
  } catch (e) { hush('overnight-live', e); }   // 券商連線中斷 → 維持上一次的價
}
function ovLiveStart() {
  _ovLiveTick(true);
  if (!_ovLiveTimer) _ovLiveTimer = setInterval(function () { _ovLiveTick(false); }, OV_LIVE_MS);
}
// 這一檔現在的價，以及它屬於哪一天。
// 日期要帶著走：晚上推估明天時，快照回來的是今天的收盤，那不是「推估那一盤的現價」，
// 不能拿去跟前收算漲跌（算出來一定是 0%，整欄都是假的 0）。
function _ovLiveOf(code) {
  var v = _ovLive[String(code)];
  if (v && v.px > 0) return v;
  var r = (typeof _rows !== 'undefined' && _rows[String(code)]) || null;   // 持股的 SSE tick
  return (r && r.close > 0) ? { px: r.close, d: '', at: r.time || '' } : null;
}

// 現價那一格。t＝_ovToday（推估的是哪一盤）。
// 三種狀況分開講，不混成一個數字：
//   1. 快照的日期就是推估那一盤 → 現價，附對前收的漲跌，上色
//   2. 快照是更早的日期（晚上看明天）→ 那一盤還沒開始，標灰、不給漲跌
//   3. 完全沒有快照（券商連線沒開）→ 破折號
function _ovLiveCell(r, t) {
  var lv = _ovLiveOf(r.code);
  if (!lv) return '<td class="num"><span class="dm-dim" title="券商快照取不到（本機連線未開）">—</span></td>';
  var sameDay = !lv.d || !t || !t.d || lv.d === t.d;
  if (!sameDay) {
    // 兩個方向都會發生，講錯方向比不講更糟：
    // 快照比推估早＝那一盤還沒開始（晚上看明天）；比推估晚＝那一盤已經過去了。
    var tip = lv.d < t.d
      ? '這是 ' + lv.d + ' 的收盤，推估的 ' + t.d + ' 那一盤還沒開始'
      : '這是 ' + lv.d + ' 的價，推估的是 ' + t.d + ' 那一盤，已經過去了';
    // 數字要讀得到，暗的只留日期那一行。
    // 這裡不給漲跌：快照不是推估那一盤的價，跟前收相減沒有意義。
    return '<td class="num ov-stale" title="' + tip + '">' + _ovPx(lv.px)
      + '<span class="ov-sub">' + lv.d.slice(5).replace('-', '/') + '</span></td>';
  }
  var ch = (r.base > 0) ? (lv.px / r.base - 1) * 100 : null;
  // 數字本身帶漲跌色：下面那一行已經是對前收的漲跌，
  // 數字卻用一個跟方向無關的橘黃，掃整欄時讀不出読漲跌。
  return '<td class="num ov-key" style="color:' + _rbCol(ch) + '">' + _ovPx(lv.px)
    + '<span class="ov-sub" style="color:' + _rbCol(ch) + '">'
    + (ch == null ? '—' : (ch > 0 ? '+' : (ch < 0 ? '\u2212' : '')) + Math.abs(ch).toFixed(2) + '%')
    + '</span></td>';
}

// ── 框頭右端那一小塊：現價、漲跌、漲跌幅 ──
//
// 不帶欄位名：框頭右端的寬度不夠，量過帶名要 308px 而中間只剩 281px。
// 三個數字靠格式認：第一個沒有三角的是現價，後面兩個帶三角的是漲跌與漲跌幅。
//
// 漲跌用上下三角不用正負號。負號在這一行會跟「8.23 ～ 8.55」那種區間的連接號
// 混在一起，而且三角不必靠顏色就讀得出方向，色盲或螢幕偏色時仍然成立。
//
// base 要是「現價那一天的前一個收盤」。拿當天自己的收盤當基準會算出必定接近 0 的漲跌。
// ── 現價取最新的那一個 ──
//
// 兩個來源：30 秒一次的券商快照（所有標的都有），以及逐筆推送（只有持股有）。
// 同一天時取時間較晚的那一個，所以持股在推送進來的瞬間就是最新的，
// 關注清單那幾檔仍然是半分鐘換一次。
//
// 只在「快照就是今天」時才讓推送蓋過去。推送那份沒有日期，晚上推估明天的時候
// 拿它當今天用，會把昨天的收盤算成今天的現價。
function _ovPxFresh(code) {
  code = String(code);
  var lv = _ovLive[code] || null;
  var r = (typeof _rows !== 'undefined' && _rows && _rows[code]) || null;
  var tw = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  var sameDay = lv && (!lv.d || lv.d === tw);
  if (r && r.close > 0 && (!lv || sameDay)) {
    if (!lv || !lv.at || (r.time && r.time > lv.at)) {
      return { px: +r.close, at: r.time || (lv ? lv.at : ''), src: 'tick' };
    }
  }
  if (lv && lv.px > 0) return { px: lv.px, at: lv.at || '', src: 'snap' };
  return (r && r.close > 0) ? { px: +r.close, at: r.time || '', src: 'tick' } : null;
}

function _ovPxBody(px, base, at) {
  var d = (base > 0) ? (px - base) : null;
  var p = (base > 0) ? (px / base - 1) * 100 : null;
  var tri = function (v) { return v > 0 ? '\u25b2' : (v < 0 ? '\u25bc' : '\u2014'); };
  var col = _rbCol(d);
  return '<span class="ovx-px" style="color:' + col + '">' + _ovPx(px) + '</span>'
    + '<span class="ovx-v" style="color:' + col + '">' + tri(d) + (d == null ? '' : Math.abs(d).toFixed(2)) + '</span>'
    + '<span class="ovx-v" style="color:' + col + '">' + tri(p) + (p == null ? '' : Math.abs(p).toFixed(2) + '%') + '</span>';
}

function _ovPxTip(px, base, at) {
  return '現價 ' + _ovPx(px) + (at ? '（' + at + '）' : '')
    + '，對前收 ' + _ovPx(base) + ' 的漲跌。'
    + '持股是逐筆更新，關注清單那幾檔是每 30 秒一次，13:35 之後停在收盤價。';
}

function _ovPxTagHtml(code, base, dayOk, whyStale) {
  var f = _ovPxFresh(code);
  if (!f) {
    return '<span class="ovx" title="券商快照取不到（本機連線未開）"><span class="ovx-na">—</span></span>';
  }
  if (!dayOk) {
    // 不是這一盤的價就不給漲跌：跟前收相減沒有意義，給了反而像真的。
    // 這種狀態也不掛逐筆更新的標記，推送進來不會去動它。
    var lv = _ovLive[String(code)] || null;
    return '<span class="ovx" title="' + String(whyStale || '').replace(/"/g, '&quot;') + '">'
      + '<span class="ovx-stale">' + _ovPx(f.px) + '</span>'
      + ((lv && lv.d) ? '<span class="ovx-d">' + lv.d.slice(5).replace('-', '/') + '</span>' : '')
      + '</span>';
  }
  // data-ovx 讓逐筆推送找得到這一塊，前收帶在屬性上，更新時不必重算
  // 畫出來的當下就把價寫進屬性：少了它，重畫之後的第一筆推送比不出方向，不會閃
  return '<span class="ovx" data-ovx="' + code + '" data-ovx-base="' + base + '"'
    + ' data-ovx-px="' + f.px + '"'
    + ' title="' + _ovPxTip(f.px, base, f.at).replace(/"/g, '&quot;') + '">'
    + _ovPxBody(f.px, base, f.at) + '</span>';
}

// ── 逐筆推送進來時只改這一塊，不重畫整頁 ──
//
// 整頁重畫要把每一檔的迴歸重新配適一次（實測 20 檔 11.5 毫秒、組 HTML 16.3 毫秒）。
// 30 秒一次無所謂，一秒好幾筆就是浪費，而且會把捲動位置與正在看的提示框打掉。
// 所以推送只改這一塊的文字，其餘的圖與區間維持 30 秒一次。
//
// 圖上那顆現價膠囊故意不跟著逐筆動：它的位置要跟區間一起算，
// 動一個不動另一個會看起來像兩個不同的現價。
function ovPxRow(code) {
  var view = document.getElementById('rebound-view');
  if (!view || view.style.display === 'none') return;
  var els = view.querySelectorAll('[data-ovx="' + String(code).replace(/[^0-9A-Za-z]/g, '') + '"]');
  if (!els.length) return;
  var f = _ovPxFresh(code);
  if (!f || !(f.px > 0)) return;
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var base = parseFloat(el.getAttribute('data-ovx-base'));
    if (!(base > 0)) continue;
    var old = el.getAttribute('data-ovx-px');
    if (old === String(f.px)) continue;            // 價沒變就不要動 DOM
    el.setAttribute('data-ovx-px', String(f.px));
    el.innerHTML = _ovPxBody(f.px, base, f.at);
    el.setAttribute('title', _ovPxTip(f.px, base, f.at));
    if (old != null) {
      // 閃一下才看得出剛剛跳過。方向跟著漲跌，與全站的紅漲綠跌一致
      var up = f.px > parseFloat(old);
      el.classList.remove('ovx-fu', 'ovx-fd');
      void el.offsetWidth;                          // 重新觸發動畫
      el.classList.add(up ? 'ovx-fu' : 'ovx-fd');
    }
  }
}

function _ovCost(code) {
  var ps = (typeof _positions !== 'undefined' && _positions) || [];
  for (var i = 0; i < ps.length; i++) {
    if (String(ps[i].code) !== String(code)) continue;
    // 券商的 price 是「付出的錢 − 領到的配息」，配息領愈多成本看起來愈低。
    // 持股庫存、即時持股、停損停利、進場訊號板的部位欄都走 invMetrics 還原過，
    // 這裡也要走同一個，否則同一個「成本均價」在兩頁會是兩個數字。
    if (typeof invMetrics === 'function') {
      try {
        var m = invMetrics(ps[i]);
        if (m && m.avg > 0) return m.avg;
      } catch (e) { hush('overnight', e); }
    }
    return ps[i].price > 0 ? ps[i].price : null;      // 庫存頁還沒載入時的退路
  }
  return null;
}

function _ovPx(v) { return v == null ? '—' : v.toFixed(2); }

// 一檔的三個推估：開盤跳空、日內最低、收盤。都相對前一日收盤。
function ovEstimate(code) {
  var d = _rbData, sox = d && d.sox;
  if (!d || !_ovNight) return null;
  // raw：只要有收盤就算數，用來挑基準價。
  // bars：還要有日內高低才能跑迴歸（開盤、最低那兩條）。
  // 兩者不能混用：Yahoo 單日線最後一根的收盤有時是 null、由 meta 補上的，
  // 那一根沒有日內高低，若一起濾掉會讓基準價退到前一天——
  // 2026-11-11 實例：00981A 基準價變成 11/09 的 23.06，而不是 11/10 的 24.27。
  var raw = (d.series[code] || []).filter(function (b) { return b.c > 0; });
  var bars = raw.filter(function (b) { return b.o > 0 && b.l > 0; });
  if (bars.length < 45 || !raw.length) return null;
  // 第一道閘：外股權重夠高才把 Nasdaq 列為候選
  var fgn = _ovFgnW(code);
  var useIx = (fgn != null && fgn >= OV_FGN_W && _ovIxic);
  var X1 = [], X2 = [], X3 = [], Yo = [], Yl = [], Yc = [];
  for (var i = 1; i < bars.length; i++) {
    var dd = bars[i].d, pc = bars[i - 1].c;
    var nv = _ovNight[dd];
    if (nv == null || !(pc > 0)) continue;
    var u = sox ? sox.prev(dd) : null;
    var sv = (u && sox.rets[u] != null) ? sox.rets[u] : null;
    if (sv == null) continue;
    var xv = null;
    if (useIx) {
      var ui = _ovIxic.prev(dd);
      xv = (ui && _ovIxic.rets[ui] != null) ? _ovIxic.rets[ui] : null;
      if (xv == null) continue;
    }
    // 除息日整根排除：開高低是未還原價，跨除息會把配息算成跳空
    var f0 = bars[i - 1].a / bars[i - 1].c, f1 = bars[i].a / bars[i].c;
    if (Math.abs(f1 - f0) > 1e-6 * Math.max(f0, f1)) continue;
    X1.push(nv); X2.push(sv); if (useIx) X3.push(xv);
    Yo.push((bars[i].o / pc - 1) * 100);
    Yl.push((bars[i].l / pc - 1) * 100);
    Yc.push((bars[i].c / pc - 1) * 100);
  }
  // 第二道閘：Nasdaq 在夜盤與費半之上還能不能多解釋一截（以收盤那條判定，三條共用同一個決定，
  // 否則同一列三個價會各用各的模型，解釋不了）
  var base = [X1, X2], f2 = _ovFit(base, Yc, 'c'), ixOn = false, addF = null;
  if (useIx && f2) {
    var f3 = _ovFit([X1, X2, X3], Yc, 'c');
    if (f3) {
      addF = ((f2.ss - f3.ss) / 1) / (f3.ss / (f3.n - f3.k));
      ixOn = addF > OV_ADD_F;
    }
  }
  var Xs = ixOn ? [X1, X2, X3] : base;
  var fo = _ovFit(Xs, Yo, 'c'), fl = _ovFit(Xs, Yl, 'l'), fc = _ovFit(Xs, Yc, 'c');
  if (!fc) return null;
  var t = _ovToday;
  if (!t) return null;
  // 今晚的 Nasdaq：與夜盤、費半同一個「台股還沒反應過」的判準
  var ixNow = null;
  if (ixOn) {
    var un = _ovIxic.prev(t.d);
    ixNow = (un && _ovIxic.rets[un] != null) ? _ovIxic.rets[un] : null;
    if (ixNow == null) { ixOn = false; Xs = base; fo = _ovFit(Xs, Yo, 'c'); fl = _ovFit(Xs, Yl, 'l'); fc = _ovFit(Xs, Yc, 'c'); if (!fc) return null; }
  }
  var ev = function (f) {
    if (!f) return null;
    var q = f.a + f.bN * t.pct + f.bS * _ovSox();
    if (ixOn && f.bX != null && ixNow != null) q += f.bX * ixNow;
    return q;
  };
  // 基準價＝那一夜「之前」的最後一個收盤，不是最新收盤。
  // 盤中時最新一根就是今天，而今天反映的正是這一夜——用它當基準等於把答案當題目。
  var bi = -1;
  for (var k2 = raw.length - 1; k2 >= 0; k2--) { if (raw[k2].d < t.d) { bi = k2; break; } }
  if (bi < 0) return null;
  var base = raw[bi].c;
  // 偏移度要把百分點換回元，把基準價帶出去
  // 那一天的 K 已經存在 → 這不是預測，是可以當場對答案的紀錄
  var act = (bi + 1 < raw.length && raw[bi + 1].d === t.d) ? raw[bi + 1] : null;
  var mk = function (p) { return p == null ? null : ovTick(base * (1 + p / 100)); };
  var pc2 = ev(fc);
  // 今天的費半決定用哪一組邊界。費半是全市場共用的一個數字，所以八檔同一天同一組
  var gs = _ovSox();
  // ── 盤中校準 ──
  // 要同時滿足：快照是「推估這一盤」當天的、有開盤價、現在落在 09:00～13:35、開盤模型存在。
  // 任一項不成立就維持開盤前那條，不做半套。
  var sdo = _ovSdF(fo), sdc = _ovSdF(fc), sdl = _ovSdF(fl);
  var po = ev(fo), pl = ev(fl);
  var cal = null;
  (function () {
    var lv = _ovLive[String(code)];
    if (!lv || !(lv.px > 0) || !(lv.op > 0)) return;
    if (!t.d || (lv.d && lv.d !== t.d)) return;
    var slot = _ovCalSlot((lv.at || '').slice(0, 5));
    if (!slot || po == null || !(base > 0)) return;
    var C = OV_CAL[slot]; if (!C) return;
    var nowPct = (lv.px / base - 1) * 100;
    var dev = nowPct - po;        // 單位是百分點，不再除以開盤殘差的寬度
    var kc = _ovGate(gs) ? C.kc.g : C.kc.b, kl = _ovGate(gs) ? C.kl.g : C.kl.b;
    cal = { slot: slot, at: lv.at, dev: dev, z: (sdo > 0 ? dev / sdo : null), nowPct: nowPct,
            oActPct: (lv.op / base - 1) * 100,
            // 當日最低是確定的事實：日內最低不可能高於已經走出來的最低，
            // 所以中心與區間上緣都要被它壓住。歷史 1350 根日 K 全部成立。
            runLoPct: (lv.lo > 0) ? (lv.lo / base - 1) * 100 : null,
            kc: kc, kl: kl };
    if (pc2 != null && sdc > 0) { cal.cPct = pc2 + C.bc * dev; }
    if (pl != null && sdl > 0) {
      var q = pl + C.bl * dev;
      cal.lPct = (cal.runLoPct != null) ? Math.min(q, cal.runLoPct) : q;
    }
  })();
  // 校準成功就用校準後的中心與倍率，否則維持原本的
  var cMid = (cal && cal.cPct != null) ? cal.cPct : pc2;
  var lMid = (cal && cal.lPct != null) ? cal.lPct : pl;
  var cLoK = cal ? cal.kc[0] : _ovK('cLo', gs), cHiK = cal ? cal.kc[1] : _ovK('cHi', gs);
  var lLoK = cal ? cal.kl[0] : _ovK('lLo', gs), lHiK = cal ? cal.kl[1] : _ovK('lHi', gs);
  var cLoP = (cMid == null || !(sdc > 0)) ? null : cMid - sdc * cLoK;
  var cHiP = (cMid == null || !(sdc > 0)) ? null : cMid + sdc * cHiK;
  var lLoP = (lMid == null || !fl || !(sdl > 0)) ? null : lMid - sdl * lLoK;
  var lHiP = (lMid == null || !fl || !(sdl > 0)) ? null : lMid + sdl * lHiK;
  if (cal && cal.runLoPct != null && lHiP != null) lHiP = Math.min(lHiP, cal.runLoPct);
  return {
    code: code, n: fc.n, base: base, basePrev: raw[bi].d,
    basePx: base,   // 偏移度要把百分點換回元
    cost: _ovCost(code),                                   // 持股成本均價，沒持股為 null
    // 前收字色用還原收盤算：未還原價在除息當天會憑空掉一截，
    // 拿它上色會把配息標成下跌。與 rebound.js 的 _rbLastChg 同一個算法，
    // 否則同一檔在兩張表上會是不同顏色。
    baseChg: (function () {
      if (!(bi > 0)) return null;
      var c1 = (raw[bi].a > 0) ? raw[bi].a : raw[bi].c;
      var c0 = (raw[bi - 1].a > 0) ? raw[bi - 1].a : raw[bi - 1].c;
      return (c0 > 0 && c1 > 0) ? (c1 / c0 - 1) * 100 : null;
    })(),
    prem: _ovPrem(code), volX: _ovVolX(raw, act ? bi + 1 : bi),
    act: act ? { o: act.o, l: act.l, c: act.c,
                 cPct: (act.c / base - 1) * 100, lPct: (act.l / base - 1) * 100 } : null,
    oPct: po, lPct: lMid, cPct: cMid,
    // 校準前的那一組也帶出去：提示要講得出「原本推多少、現在推多少」
    rawLPct: pl, rawCPct: pc2, cal: cal,
    oPx: mk(po), lPx: mk(lMid), cPx: mk(cMid),
    loPx: mk(cLoP),
    hiPx: mk(cHiP),
    // 日內最低自己的區間。掛限價買進看的是這一個，不是收盤那一個，
    // 原本只有收盤有範圍，等於把最該有不確定性的那個數字寫成一個確定的價。
    lLoPx: mk(lLoP),
    lHiPx: mk(lHiP),
    lCover: fl ? fl.cover : null, lCoverN: fl ? fl.coverN : null,
    // 掛得到的比例：同一條迴歸、同一段樣本，數有多少比例的日子實際最低
    // 真的跌到當天推的掛買參考。校準那一層沒有進這個回測（見卡片說明）。
    lFill: fl ? fl.fill : null,
    // 機率曲線要的三樣：分布、中心、寬度。中心用校準後的那一個，
    // 與畫出來的區間同一個基準，否則曲線會跟區間邊界錯開。
    zl: fl ? fl.zq : null, zc: fc.zq,
    sdl: sdl, sdc: sdc, lMidPct: lMid, cMidPct: cMid,
    sd: sdc, sdFull: fc.sd, cover: fc.cover, coverN: fc.coverN, r2: fc.r2, gate: _ovGate(gs),
    fgnW: fgn, ixOn: ixOn, ixF: addF, ixNow: ixNow,
    sdUp: _ovSd(fc.resU), sdDn: _ovSd(fc.resD),
    medUp: _ovMed(fc.resU), medDn: _ovMed(fc.resD),
    nUp: fc.resU.length, nDn: fc.resD.length
  };
}
// 折溢價：跟 ETF 評比同一份（每日更新）。那一頁還沒載入就是空的，不為了一欄去觸發全市場抓取
function _ovPrem(code) {
  if (typeof esMetricsFor !== 'function') return null;
  try { var r = esMetricsFor(code); return (r && r.prem != null) ? r.prem : null; }
  catch (e) { return null; }
}
// 量能：該日成交量 ÷ 前 20 日均量。跳空上去沒量跟上的話，跟有量的跳空是兩回事
function _ovVolX(bars, i) {
  if (!bars[i] || !(bars[i].v > 0)) return null;
  var a = [];
  for (var k = i - 1; k >= 0 && a.length < 20; k--) if (bars[k].v > 0) a.push(bars[k].v);
  if (a.length < 10) return null;
  var m = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
  return m > 0 ? bars[i].v / m : null;
}
// 費半要跟總覽抽屜抽同一份價。
// 舊寫法用日線的最後一根，那一根盤中會更新、但更得比即時價慢：
// 2026-11-11 04:05 實例，總覽 −1.10%、推估卡 −0.72%，兩邊對不起來。
// 這裡改走 5 分鐘分時（基準為 chartPreviousClose，與總覽完全同一個定義），
// 抽不到再退回日線。
var _ovSoxLive = null;          // { r, at, open }

async function _ovLoadSoxLive() {
  if (_ovSoxLive) return _ovSoxLive;
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX?interval=5m&range=1d';
  var r = await fetch(NEWS_GAS_URL + '?url=' + encodeURIComponent(url));
  var j = await r.json();
  var res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('sox intra');
  var m = res.meta || {}, ts = res.timestamp || [];
  var cl = (res.indicators && res.indicators.quote && res.indicators.quote[0]
            && res.indicators.quote[0].close) || [];
  var ref = m.chartPreviousClose, lastC = null, lastT = null;
  for (var i = cl.length - 1; i >= 0; i--) {
    if (cl[i] != null && ts[i] != null) { lastC = cl[i]; lastT = ts[i]; break; }
  }
  if (!(ref > 0) || !(lastC > 0)) throw new Error('sox intra empty');
  // 開盤與否不能用 m.marketState：代理服務的回應根本沒有這個欄位，
  // undefined === 'REGULAR' 永遠是 false，所以卡上一直寫「已收盤」，盤中也一樣。
  // 2026-11-12 紐約 13:05（台北 02:05）實測：meta 裡只有 regularMarketTime、
  // timezone、exchangeTimezoneName、currentTradingPeriod、tradingPeriods。
  //
  // 改用回應裡真的有的東西：最後報價時刻跟該標的自己的收盤時間比。
  var rg = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  var live = (rg && rg.end && m.regularMarketTime) ? (m.regularMarketTime < rg.end) : null;
  // 標台灣時間，與卡上夜盤的時刻同一個時區才比得起來
  _ovSoxLive = {
    r: (lastC / ref - 1) * 100,
    at: new Date((lastT + 8 * 3600) * 1000).toISOString().slice(11, 16),
    open: live
  };
  return _ovSoxLive;
}

// 卡上的夜盤漲幅與總覽永遠差一點，因為兩邊的基準不同：
//   這裡＝前一交易日日盤 13:45 的最後成交價
//   總覽＝期交所參考價（結算價），與券商 App 一致
// 2026-11-11 實測：成交價兩邊都是 42,522，但基準 42,623 vs 42,646，
// 算出 −0.24% 與 −0.29%。不是其中一邊沒重抓。
//
// 為何不改成跟總覽同一個基準：這一卡的系數是用 446 天「對前一日日盤
// 收盤」迴歸出來的，而參考價沒有歷史資料可以重新迴歸。
// 此外現貨市場自己的漲跌也是對前一日收盤，要推現貨就該用收盤當基準。
// 所以兩個數字並列、各標各自的基準，不讓使用者自己猜哪一個是舊的。
var _ovRef = null;              // { pct, px, at }

async function _ovLoadRef() {
  if (_ovRef) return _ovRef;
  var r = await fetch(API + '/api/v1/data/snapshots', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contracts: [{ security_type: 'FUT', exchange: 'TAIFEX', code: 'TXFR1' }] })
  });
  if (!r.ok) throw new Error('snapshot HTTP ' + r.status);
  var a = await r.json(), q = a && a[0];
  if (!q || q.close == null || q.change_price == null) throw new Error('snapshot empty');
  _ovRef = { pct: q.change_rate, px: q.close - q.change_price, at: (q.datetime || '').slice(11, 16) };
  return _ovRef;
}

function _ovSox() {
  if (_ovSoxLive) return _ovSoxLive.r;
  var s = _rbData && _rbData.sox;
  return (s && s.last) ? s.last.r : 0;
}

// ── 命中率追蹤：每天存一次推估，隔天拿實際回來對 ──
// 不記錄的話，「這套方法到底準不準」永遠只能一天一天手動回測。
function _ovRecLoad() {
  if (_ovRec) return _ovRec;
  try { _ovRec = JSON.parse(localStorage.getItem(OV_REC_LS) || '{}') || {}; } catch (e) { _ovRec = {}; }
  return _ovRec;
}
function _ovRecSave() { try { localStorage.setItem(OV_REC_LS, JSON.stringify(_ovRec)); } catch (e) {} }
// 存今天的推估（同一天只存第一次，之後盤中重算不覆蓋——否則會變成事後諸葛）
function ovRecord(rows) {
  var t = _ovToday;
  if (!t || !rows || !rows.length) return;
  var rec = _ovRecLoad();
  if (!rec[t.d]) {
    rec[t.d] = { night: +t.pct.toFixed(2), sox: +_ovSox().toFixed(2), est: {} };
    rows.forEach(function (r) { if (r.cPct != null) rec[t.d].est[r.code] = +r.cPct.toFixed(2); });
    _ovRecSave();
  }
  // 回填已經有實際值的日子
  var d = _rbData, dirty = false;
  Object.keys(rec).forEach(function (day) {
    var e = rec[day];
    if (e.act && Object.keys(e.act).length === Object.keys(e.est).length) return;
    e.act = e.act || {};
    Object.keys(e.est).forEach(function (c) {
      if (e.act[c] != null) return;
      var bars = d.series[c] || [];
      for (var i = 1; i < bars.length; i++) {
        if (bars[i].d !== day) continue;
        if (!(bars[i - 1].c > 0)) break;
        e.act[c] = +((bars[i].c / bars[i - 1].c - 1) * 100).toFixed(2);
        dirty = true;
        break;
      }
    });
  });
  if (dirty) _ovRecSave();
}
function ovHitHtml() {
  var rec = _ovRecLoad(), days = Object.keys(rec).sort();
  var errs = [], n = 0, within = 0;
  days.forEach(function (day) {
    var e = rec[day];
    Object.keys(e.est).forEach(function (c) {
      if (e.act && e.act[c] != null) {
        var g = e.act[c] - e.est[c];
        errs.push(g); n++;
        if (Math.abs(g) <= 2.5) within++;
      }
    });
  });
  if (!n) {
    return '<div class="rb-caveat nb-keep">命中率：還沒有可對照的紀錄。每天進這一頁會把當天的推估存下來，' +
      '隔天拿實際收盤回來對。累積之後才答得出「這套方法是不是系統性低估、哪一檔特別不準」——' +
      '今天看一次是看不出來的。紀錄存在本機瀏覽器。</div>';
  }
  var med = _ovMed(errs), avg = errs.reduce(function (a, b) { return a + b; }, 0) / n;
  return '<div class="rb-caveat nb-keep"><b>命中率追蹤</b>：已對照 ' + n + ' 筆（' + days.length + ' 天）。' +
    '實際減推估的中位數 <b>' + (med >= 0 ? '+' : '−') + Math.abs(med).toFixed(2) + '</b> 個百分點、平均 ' +
    (avg >= 0 ? '+' : '−') + Math.abs(avg).toFixed(2) + '；落在 ±2.5 個百分點內的佔 ' +
    Math.round(within / n * 100) + '%。中位數明顯偏正代表這套方法系統性低估，偏負代表高估。' +
    '紀錄存在本機瀏覽器，換電腦不會跟著走。</div>';
}

// ── 畫面 ──
// force＝按了「重新整理」。不清快取的話夜盤會停在進頁那一刻：
// 2026-11-11 實例，抽屜已經是 04:05 的價，推估卡還寫 03:49。
async function ovPrepare(force) {
  if (_ovBusy) return;
  _ovBusy = true;
  if (force) { _ovToday = null; _ovNight = null; _ovSoxLive = null; _ovRef = null; _ovIxic = null; }
  try {
    await ovLoadNight();
    await ovTodayNight();
    // 成份股：第一道闘要用（外股權重）。每日快取，重複呼叫不會再打請求。
    if (typeof _constEnsure === 'function' && _rbData && _rbData.codes) {
      for (var ci = 0; ci < _rbData.codes.length; ci++) {
        try { await _constEnsure(_rbData.codes[ci]); } catch (e) { hush('overnight', e); }
      }
    }
    await _ovIxicLoad();
    try { await _ovLoadSoxLive(); } catch (e) { hush('overnight-sox', e); }
    try { await _ovLoadRef(); } catch (e) { hush('overnight-ref', e); }
  } finally { _ovBusy = false; }
  _ovAt = new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16);
}
function ovHtml(view) {
  if (!_rbData || !_ovNight) return '';
  var t = _ovToday;
  if (!t) {
    return '<div class="rb-caveat nb-keep">拿不到台指期夜盤（本機券商連線未開，且資料檔是空的），隔夜推估略過。</div>';
  }
  var rows = _rbData.codes.map(ovEstimate).filter(Boolean);
  if (!rows.length) return '';
  rows = (_ovSort === 'cPctDesc')
    ? rows.slice().sort(function (a, b) { return b.cPct - a.cPct; })
    : rbSortRows(rows, _ovSort, _ovSortVal);
  ovRecord(rows);
  var hasAct = rows.some(function (r) { return r.act; });

  var ana = (view === 'ana');
  var sox = _ovSox();
  // 八檔同一天同一個時點，所以挑第一個有校準的那一列來標標頭
  var calOn = null;
  for (var ci = 0; ci < rows.length; ci++) { if (rows[ci].cal) { calOn = rows[ci].cal; break; } }
  // 實測覆蓋率放提示，不放欄位：它是用來驗證區間的，不是你每天要讀的數字。
  // 樣本少的時候連這個覆蓋率自己都估不準，所以把標準誤一起寫進去。
  var cvTip = function (cv, n2, nm, extra) {
    if (cv == null || !n2) return extra ? ' title="' + extra + '"' : '';
    var se = Math.sqrt(0.68 * 0.32 / n2) * 100;
    return ' title="' + nm + '區間實測罩住了 ' + Math.round(cv) + '% 的日子（' + n2 + ' 天，誤差 ±'
      + se.toFixed(1) + ' 個百分點）。目標是 68%，' +
      (Math.abs(cv - 68) <= 2 * se ? '目前在誤差範圍內' : (cv < 68 ? '目前偏窄' : '目前偏寬'))
      + (extra ? '。' + extra : '') + '"';
  };
  var pct = function (v, dec) {
    if (v == null) return '—';
    return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v).toFixed(dec == null ? 2 : dec) + '%';
  };
  // 校準後的那一格要講得出「原本推多少、現在推多少」，不然使用者只看到數字變了
  // 偏離要用「幾個殘差」講：那是跨標的可比的單位，百分點不可比。
  // 寬度算不出來（新上市、樣本不足）就退回百分點，不要印 NaN。
  var calDev = function (c) {
    if (c.z != null) {
      return (c.z > 0 ? '+' : (c.z < 0 ? '\u2212' : '')) + Math.abs(c.z).toFixed(2) + ' 個殘差';
    }
    return pct(c.dev);
  };
  var calTip = function (r, which) {
    var c = r.cal; if (!c) return '';
    var raw = (which === 'c') ? r.rawCPct : r.rawLPct;
    var now = (which === 'c') ? r.cPct : r.lPct;
    var zs = calDev(c);
    var s = '已用 ' + (c.at || '').slice(0, 5) + ' 的價校準，套 ' + _ovCalLab(c.slot) + ' 那一組倍率。'
      + '現在的價偏離開盤推估 ' + zs + '，中心從 ' + pct(raw) + ' 移到 ' + pct(now) + '。';
    if (which === 'l' && c.runLoPct != null) {
      s += '日內最低另外被「今天到現在的最低 ' + pct(c.runLoPct) + '」壓住：最低不可能高於已經走出來的最低。';
    }
    if (c.slot >= '12:30') {
      s += '這個時點的收盤推估與現價的相關已經到 0.93 以上，它在重複現價、不再是推估。';
    }
    return s.replace(/"/g, '&quot;');
  };
  var h = '<div class="rb-sox">';
  // 標題要講明是哪一盤。「明天」在週一盤中打開時是錯的：
  // 那時推的是今天這一盤，而且現價欄就是拿來跟它對答案的。
  var _ovTw = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  var dLab = t.d ? t.d.slice(5).replace('-', '/') : '';
  h += '<div class="sec-title">隔夜推估（'
    + (!t.d ? '明天的價格' : (t.d === _ovTw ? dLab + ' 這一盤' : dLab + ' 的價格')) + '）</div>';
  var nf = function (v) { return v == null ? '—' : Math.round(v).toLocaleString('zh-TW'); };
  // 標額區只留「現在是什麼狀況」的事實，解釋全改放到下方的說明裡。
  // 舊版這一塊 418 字，而且用的是標額標記，全站的說明收合機制根本收不到它。
  // 基準要標出來。這個百分比比的是「日盤最後一根 K 的收盤」，
  // 總覽盤勢那一格比的是「期交所參考價」（當日結算價＝最後一分鐘的成交量加權均價），
  // 兩者差幾點，所以同一時刻兩邊會差 0.02～0.03 個百分點。
  // 這裡不能改用期交所參考價：night-txf.json 的 446 天歷史全是用日盤 K 收盤算的，
  // 換基準等於餵給迴歸的輸入跟當初配適的定義不一致。
  var nbTip = t.bp != null
    ? '基準＝' + nf(t.bp) + '（' + (t.base || '') + ' 日盤最後一根 K 的收盤）。'
      + '總覽盤勢那一格用的是期交所參考價，兩者差幾點，所以百分比會差 0.02～0.03。'
      + '這裡用日盤收盤是為了跟 446 天的夜盤歷史同一個定義，換成參考價會讓迴歸的輸入前後不一致。'
    : '';
  h += '<div class="rb-sox-hd on">台指期夜盤 <b style="color:' + _rbCol(t.pct) + '">' + pct(t.pct) + '</b>'
    + '（' + nf(t.np) + (t.at ? '，' + t.at : '')
    + (t.bp != null ? '，<span class="ov-base" title="' + nbTip.replace(/"/g, '&quot;')
        + '">基準 ' + nf(t.bp) + '</span>' : '') + '）　'
    + '隔夜費半 <b style="color:' + _rbCol(sox) + '">' + pct(sox) + '</b>'
    + (_ovSoxLive
        ? '（' + _ovSoxLive.at
            + (_ovSoxLive.open === true ? '，盤中'
              : (_ovSoxLive.open === false ? '，已收盤'
                : '，盤別不明')) + '）'
        : '（日線收盤值）')
    + (_ovGate(sox)
        ? '<span class="ov-gate" title="隔夜費半跌超過 ' + Math.abs(OV_SD_GATE)
          + '%。這種日子收盤跌破區間下緣的比例是 32.9%，其餘日子 15.7%，而跌破上緣的'
          + '比例兩組一樣，所以偏的是方向不是幅度。下緣已經從 0.96 個殘差放到 2.30 個，'
          + '上緣不動。以上是開盤之前的那一組；開盤成交之後整組會換成校準後的倍率，'
          + '看旁邊那顆標記與下方說明。">下緣已放寬</span>'
        : '')
    + (calOn
        ? '<span class="ov-cal" title="開盤之後改用今天走到現在的價重新定心。條件變數是'
          + '「現在的漲幅 − 開盤模型推的開盤漲幅」，單位是百分點，所以不需要盤中歷史。'
          + '同覆蓋率下收盤區間窄掉的幅度，前瞻驗證量到開盤 16%、09:30 是 34%、11:00 是 59%、'
          + '13:00 是 77%。目前套的是 ' + _ovCalLab(calOn.slot) + ' 那一組。詳見下方說明。">'
          + '已用 ' + (calOn.at || '').slice(0, 5) + ' 的價校準</span>'
        : '')
    + (_ovAt ? '<span class="ov-at">' + _ovAt + ' 抓取</span>' : '')
    + (_ovLiveAt ? '<span class="ov-at">現價 ' + _ovLiveAt
        + (_ovLiveOpen ? '，盤中每 30 秒更新' : '，已收盤、不再更新') + '</span>' : '')
    + (hasAct
      ? '<br><b style="color:var(--accent2)">這一夜已經開過盤了</b>：'
        + _ovToday.d + ' 的 K 線已存在，右邊是實際值。'
      : '') + '</div>';

  h += '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>' +
    rbSortTh(_ovSort, 'ovSort', 'code', '代號 / 名稱').replace('class="num ', 'class="') +
    rbSortTh(_ovSort, 'ovSort', 'cost', '成本均價', '持股的成本均價；只關注、沒持有的為「—」。跟右邊的前收比就是目前的損益') +
    rbSortTh(_ovSort, 'ovSort', 'base', '前收', '字色是前收自己的漲跌（對再前一日）') +
    rbSortTh(_ovSort, 'ovSort', 'live', '現價', '券商即時快照，盤中每 30 秒更新；13:35 之後不再抓，停在收盤價。'
      + '下面那一行是對前收的漲跌，與右邊幾欄的推估是同一個基準，可以直接比') +
    rbSortTh(_ovSort, 'ovSort', 'oPx', calOn ? '開盤' : '預估開盤',
      calOn ? '當天實際的開盤價，下面那一行是它偏離推估幾個殘差。這個偏離就是校準用的條件變數'
            : '當天開盤價的推估') +
    rbSortTh(_ovSort, 'ovSort', 'lPx', '掛買參考', '當天盤中最低價的推估，下面那一行是它的區間。'
      + '掛限價買進看這一欄，不是看收盤。字越亮代表這兩個訊號解釋得越多；暗的代表區間跟隨便猜差不多寬') +
    rbSortTh(_ovSort, 'ovSort', 'cPx', '預估收盤', '範圍的中心。別把它當成一個會到的價') +
    rbSortTh(_ovSort, 'ovSort', 'range', '收盤區間', '收盤推估的上下緣，兩邊不對稱。'
      + '下緣＝近 10 日半衰的加權殘差 × 0.96，上緣 × 0.95；隔夜費半跌破 3% 的那天'
      + '下緣改用 2.30 倍，上緣不動。滑到價格上看得到這一檔實測罩住了幾成的日子') +
    (hasAct ? rbSortTh(_ovSort, 'ovSort', 'actC', '實際收盤', '那一天實際的收盤')
            + rbSortTh(_ovSort, 'ovSort', 'actL', '實際日內最低') : '') +
    rbSortTh(_ovSort, 'ovSort', 'prem', '折溢價', '市價相對預估淨值：正數代表買貴了。開高跳空當下容易跑到溢價') +
    rbSortTh(_ovSort, 'ovSort', 'volX', '量能', '當日成交量 ÷ 近 20 日均量。跳空上去有沒有量跟上') +
    (ana ? rbSortTh(_ovSort, 'ovSort', 'r2', '說明力', '這兩個訊號說明得了多少起伏；1 是完全說中、0 是完全說不中')
         + rbSortTh(_ovSort, 'ovSort', 'n', '樣本') : '') + '</tr></thead><tbody>';
  rows.forEach(function (r) {
    // 多掛了第三個因子的那幾檔要標出來，否則同一張表裡會有兩種模型而看不出來
    h += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + _rbName(r.code) + '</span>'
      + (r.ixOn ? '<span class="ov-fx" title="這一檔的成份股有 '
          + (r.fgnW == null ? '' : r.fgnW.toFixed(0)) + '% 在海外，而實測 Nasdaq 在夜盤與費半之上還能多解釋一截'
          + '（增量 F=' + (r.ixF == null ? '' : r.ixF.toFixed(1)) + '，門檻 ' + OV_ADD_F + '），'
          + '所以這一列的推估多掛了 Nasdaq。其他各檔只用夜盤與費半。">＋N</span>' : '')
      + '</td>' +
      // 成本均價是固定的事實，它沒有漲跌。紅綠在這一頁的意思是「今天動了多少」，
      // 拿來標一個不會動的數字是讀錯顏色。改用標頭的橘黃。
      '<td class="num">' + (r.cost > 0
          ? '<span class="ov-cost">' + _ovPx(r.cost) + '</span>'
          : '<span class="dm-dim" title="只在關注清單，沒有持股">—</span>') + '</td>' +
      '<td class="num" style="color:' + _rbCol(r.baseChg) + '"><span class="rb-bpx">' + _ovPx(r.base) + '</span>'
        + (typeof _rbStreakSub === 'function' ? _rbStreakSub(_rbData.series[r.code] || []) : '') + '</td>' +
      _ovLiveCell(r, t) +
      // 開盤已經成交之後，這一格的推估值就沒有用了，換成實際開盤與它的偏離。
      // 推估值不是丟掉，移到提示裡，要對答案還查得到。
      (r.cal
        ? '<td class="num ov-side" style="color:' + _rbCol(r.cal.oActPct) + '" title="'
            + '開盤推估 ' + _ovPx(r.oPx) + '（' + pct(r.oPct) + '），實際開盤偏離 '
            + calDev(r.cal)
            + '">' + _ovPx(ovTick(r.base * (1 + r.cal.oActPct / 100)))
            + '<span class="ov-sub" style="color:' + _rbCol(r.cal.oActPct) + '">'
            + pct(r.cal.oActPct) + '</span></td>'
        : '<td class="num ov-side" style="color:' + _rbCol(r.oPct) + '">' + _ovPx(r.oPx)
            + '<span class="ov-sub" style="color:' + _rbCol(r.oPct) + '">' + pct(r.oPct) + '</span></td>') +
      // 掛買參考與收盤區間是這張表唯一要讀的兩個東西，放大加粗；
      // 開盤與收盤那兩個點估值降成小字，它們只是區間的中心。
      '<td class="num ov-big ' + (r.cal ? 'ov-calc ' : '') + _ovTier(r.r2) + '"'
        + cvTip(r.lCover, r.lCoverN, '日內最低', calTip(r, 'l')) + '>'
        + _ovPx(r.lPx)
        + '<span class="ov-rng">' + _ovPx(r.lLoPx) + ' ～ ' + _ovPx(r.lHiPx) + '</span>'
        + '<span class="ov-sub" style="color:' + _rbCol(r.lPct) + '">' + pct(r.lPct) + '</span></td>' +
      '<td class="num ov-side" style="color:' + _rbCol(r.cPct) + '">' + _ovPx(r.cPx)
        + '<span class="ov-sub" style="color:' + _rbCol(r.cPct) + '">' + pct(r.cPct) + '</span></td>' +
      '<td class="num ov-big ' + (r.cal ? 'ov-calc ' : '') + _ovTier(r.r2) + '"'
        + cvTip(r.cover, r.coverN, '收盤', calTip(r, 'c')) + '>'
        + _ovPx(r.loPx) + ' ～ ' + _ovPx(r.hiPx) + '</td>' +
      (hasAct ? '<td class="num" style="color:' + _rbCol(r.act ? r.act.cPct : null) + ';font-weight:700">'
          + (r.act ? _ovPx(r.act.c) : '—')
          + (r.act ? '<span class="ov-sub">' + pct(r.act.cPct) + '</span>' : '') + '</td>'
        + '<td class="num" style="color:' + _rbCol(r.act ? r.act.lPct : null) + '">' + (r.act ? _ovPx(r.act.l) : '—')
          + (r.act ? '<span class="ov-sub">' + pct(r.act.lPct) + '</span>' : '') + '</td>' : '') +
      '<td class="num" style="color:' + (r.prem == null ? 'var(--text3)' : _rbCol(r.prem)) + '">'
        + (r.prem == null ? '—' : pct(r.prem)) + '</td>' +
      '<td class="num' + (r.volX != null && r.volX >= 1.5 ? ' ov-key' : '') + '">'
        + (r.volX == null ? '—' : r.volX.toFixed(2) + ' 倍') + '</td>' +
      (ana ? '<td class="num rs-dim">' + (r.r2 == null ? '—' : r.r2.toFixed(2)) + '</td>'
           + '<td class="num rs-dim">' + r.n + ' 天</td>' : '') + '</tr>';
  });
  h += '</tbody></table></div>';
  // 解釋全部在這裡，收合後點了才看得到
  h += '<div class="detail-note"><dl>'
    + '<dt>要看哪一欄</dt><dd>只看放大的那兩欄：<b>掛買參考</b>與<b>收盤區間</b>。'
    + '掛限價買進用前者（並且看它底下那一行的區間，不是上面那一個點）。'
    + '預估開盤與預估收盤故意縮成小字：它們只是區間的中心，不是會到的價。'
    + '<br><b>字的亮度就是可信度</b>：亮白代表這兩個訊號解釋掉一半以上的起伏，'
    + '中灰代表四分之一到一半，暗灰代表不到四分之一、區間跟隨便猜差不多寬。'
    + '不用紅綠是因為那兩個色在這一頁是漲跌。'
    + '滑到價格上看得到這一檔的區間實測罩住了幾成的日子。'
    + '所有價格以 ' + (rows[0] ? rows[0].basePrev : '') + ' 的收盤為基準，已對齊升降單位。</dd>'
    + '<dt>現價</dt><dd>券商即時快照。盤中每 30 秒更新，13:35 之後那一輪就不再抓，停在收盤價——'
    + '收盤之後它本來就不會再變，不是畫面卡住。下面那一行的漲跌對的是前收，'
    + '跟右邊三欄推估同一個基準，直接比得出來今天走在推估的哪個位置。'
    + '推估的那一盤還沒開始時（例如晚上看明天），快照回來的是今天的收盤，'
    + '這一欄會標灰並說明是哪一天的價，不會假裝那是「明天的現價」。</dd>'
    + (_ovRef && _ovRef.pct != null
        ? '<dt>跟總覽的百分比不一樣</dt><dd>總覽與券商 App 顯示 '
            + pct(_ovRef.pct) + '，對的是期交所參考價 ' + nf(_ovRef.px)
            + '；這裡對的是 ' + (t.base || '—') + ' 日盤收盤 ' + nf(t.bp)
            + '。成交價兩邊同一個，差的是分母。'
            + '用收盤是因為要推的 ETF 漲跌也是對前一日收盤。</dd>'
        : '')
    + '<dt>區間的上下緣</dt><dd>'
    + '<b>定義</b>：下緣與上緣各自是「近 10 日半衰的加權殘差 × 一個倍率」。'
    + '平常日收盤下緣用 0.96 倍、上緣 0.95，掛買參考的下緣用 1.09、上緣 0.78。'
    + '隔夜費半跌破 3% 的那天，只有下緣改用 2.30（收盤）與 2.31（掛買參考），上緣不動。'
    + '以上是<b>開盤之前</b>的倍率。開盤成交之後整組會換掉，看下一條「盤中校準」。'
    + '<br><b>比較基準</b>：倍率不是自訂的數字，是走查殘差的分位數：下緣取第 16 百分位、'
    + '上緣取第 84 百分位，兩者之間就是 68%。門檻日與其餘日各自算一組。'
    + '<br><b>白話</b>：費半大跌的隔天，這一頁推的價會系統性偏高，但偏的只有下面那一邊。'
    + '所以那天下緣會明顯往下掉、上緣看起來沒動，那不是畫錯。'
    + '<br><b>機制</b>：這一頁的兩個輸入都是隔夜已經定價完的資訊，台股自己盤中新生的'
    + '賣壓不在輸入裡，所以推估抓得住跳空、抓不住當日跌幅。費半大跌只標示出'
    + '「今天盤中比較可能繼續賣」，沒辦法告訴你會賣多深，表現出來就是殘差整個往下拖'
    + '而不是變寬：破下緣 32.9% 對 15.7%，破上緣 15.1% 對 14.6%。'
    + '<br><b>行動含義</b>：門檻亮起時掛限價買進要用放寬後的下緣，不是原本那一個。'
    + '門檻亮起本身不等於「別進場」：門檻日收盤進場的後 5 日報酬中位數 +1.31%、'
    + '其餘日子 +0.30%；等一天再掛的話，隔日收盤比當天低的機率只有 41.1%。'
    + '<br><b>不能告訴你什麼</b>：倍率校準的是大多數日子，不是極端日。'
    + '2026-11-16 那天八檔需要 1.66 到 2.59 個殘差（中位數 2.25），放寬後的 2.30 '
    + '只勉強罩住其中幾檔。它也分不出「還會再跌」與「已經跌完」，區間只給範圍不給方向。'
    + '倍率自己也是估出來的，門檻日總共只有 43 天。'
    + '<details class="ov-bt"><summary>回測怎麼做的</summary>'
    + '走查：每一天只用該日之前的資料重新配適一次，不讓模型看到未來。八檔全跑，'
    + '953 筆（檔 × 日）、319 個交易日，其中門檻日 43 天、146 筆。'
    + '前瞻驗證把樣本切在 2026-03-24，用前半段估倍率、後半段驗收：'
    + '門檻日破下緣 18.1%、其餘日 17.0%，對照目標 16%，改之前門檻日是 29% 到 33%。'
    + '倍率在時間上穩定：門檻日的收盤下緣前半段 2.20、後半段 2.30。'
    + '日層級的置換檢定把費半標籤在天之間隨機重排兩萬次，單尾 p=0.0115；'
    + '用日層級是因為同一天八檔會一起破，有效樣本是天數不是筆數。'
    + '門檻設在 −3% 的理由：−4% 到 −3% 破下緣 36.7%（16 天），≤ −4% 降到 23.5%'
    + '（27 天），關係不單調，線性相關只有 −0.08，所以只當門檻用，不當連續訊號。'
    + '</details></dd>'
    + '<dt>盤中校準</dt><dd>'
    + '<b>定義</b>：開盤成交之後，收盤與日內最低的推估中心各往「現在的價偏離開盤推估的方向」'
    + '移動一個固定倍數，區間倍率也換成該時點自己的一組。條件變數只有一個數字：'
    + '現在對前收的漲幅，減掉開盤模型推的開盤漲幅，單位就是百分點。'
    + '收盤的斜率幾乎是 1（1.02 到 1.18）：現在偏離開盤推估多少，收盤大概就偏離多少，'
    + '不系統性延續也不回吐。日內最低的斜率從 1.07 掉到 0.78，因為愈晚、還能破新低的時間愈短。'
    + '時點取不晚於現在的那一格，所以 09:20 用 09:15 那一組，寧可用早一點、比較寬的。'
    + '<br><b>比較基準</b>：比的是「同一個覆蓋率之下，區間能窄多少」，'
    + '算法是校準後的條件殘差跨距除以原本殘差的跨距，兩者都取第 16 到第 84 百分位。'
    + '前瞻驗證把斜率只用前半段的日期估、跨距只在後半段量（697 筆，其中門檻日 122 筆）：'
    + '開盤 16%、09:30 是 34%、10:00 是 46%、11:00 是 59%、12:00 是 70%、13:00 是 77%；'
    + '日內最低對應 31%、46%、47%、51%、53%、55%。門檻日的幅度更大，09:30 收盤就有 49%。'
    + '<br><b>白話</b>：開盤前這一頁只知道隔夜發生什麼事，開盤之後它多知道一件事，'
    + '就是今天實際走成什麼樣。愈晚看區間愈窄，因為還沒走完的時間愈短。'
    + '<br><b>機制</b>：台指期夜盤與隔夜費半都是隔夜已經定價完的資訊，台股盤中新生的買賣壓'
    + '不在輸入裡，所以開盤前的推估抓得住跳空、抓不住當日走勢。價格本身已經把那股力道顯示出來，'
    + '拿它回頭修正等於把模型看不到的那一塊補回去。日內最低還多一層確定的事實壓著：'
    + '當日最低不可能高於今天已經走出來的最低，所以它的中心與上緣都會被現在的最低壓住。'
    + '<br><b>行動含義</b>：掛限價買進要用校準後的掛買參考下緣，不是開盤前那一個。'
    + '想要窄一點的區間就晚一點掛，代價是能掛的時間變短。'
    + '<br><b>不能告訴你什麼</b>：12:30 之後收盤那條已經不是推估，'
    + '它跟現價的相關到 0.93 以上，實際上在重複現價；那時區間窄到只剩零點幾毛，'
    + '看起來很準是因為離收盤不到一小時，不是因為模型變強。'
    + '日內最低在 12:00 之後停止改善（停在 53% 到 56%），因為當日最低通常已經走出來，'
    + '剩下的只有最後一個半小時破新低的可能，那一截不會因為時間過去而變小。'
    + '倍率是寫死的常數，而殘差的形狀會隨期間與標的漂移：實測用前半段的倍率套後半段，'
    + '上緣會破到 20% 到 25%，而目標是 16%，也就是區間偏窄、實際跑出去的次數比設計值多。'
    + '門檻日那一組倍率估不出前瞻驗證，門檻日總共只有 146 筆，而切點之前只有 14 到 30 天。'
    + '開盤那一格的斜率也最不穩：全樣本 1.18、只用前半段估是 0.97，逐檔散在 0.62 到 1.34，'
    + '所以開盤剛成交那一下的修正量比後面幾個時點更該打折看。'
    + '它也不分方向：區間只給範圍，不告訴你接下來會往上還是往下。'
    + '<details class="ov-bt"><summary>回測怎麼做的</summary>'
    + '八檔的分鐘 K，953 筆、313 個交易日，11 個時點各自走查：'
    + '每一天只用該日之前的資料重新配適，不讓模型看到未來。'
    + '另一種做法是替每個時點各配一條自己的迴歸，那需要把盤中歷史存成資料檔、每天重算。'
    + '兩者實測幾乎同分（同覆蓋率下收盤區間窄掉的幅度，只用開盤模型 vs 各時點配模型）：'
    + '09:30 是 30% 對 29%、10:30 是 48% 對 46%、11:30 是 62% 對 62%、'
    + '12:30 是 68% 對 72%、13:00 是 70% 對 79%。只有 12:30 之後落後 4 到 9 個百分點，'
    + '而那時區間本來就只剩零點幾毛，所以不為它多養一個資料檔。'
    + '量測過程中查到區間寬度用的半衰加權殘差會塌掉：09:15 那一組有一列算出 0.0006，'
    + '標準化之後是 1018 倍，一列就把相關係數吃掉。原因是連續幾天殘差接近零。'
    + '已經加上下限，不低於全樣本殘差標準差的三成，否則某一天的區間會縮成一條線'
    + '而畫面不會告訴你那是算壞的。'
    + '另外踩過一個單位的坑：先把條件變數除以開盤殘差的寬度、再乘回收盤殘差的寬度，'
    + '配適時 R² 一樣，但推論時等效斜率會隨兩個寬度的比值跑，實測散在 0.48 到 1.72。'
    + '2026-11-17 盤中踩到：那天比值偏大，等效斜率變成 1.33，八檔的推估收盤全部被外推到'
    + '低於現價，其中兩檔的現價跑到區間上緣之外。改回百分點之後 09:30 之後穩定在 1.02 到 1.08。'
    + '</details></dd>'
    + '</dl></div>';

  // 偏移度：這一檔照不照劇本走。跟「會漲多少」無關，跟「掛價要留多少餘裕」直接相關。
  if (view === 'ana') {
    h += '<div class="sec-title">偏移度（實際與推估的差距，元）</div>' +
      '<div class="rs-cat-wrap"><table class="inv-table rb-table"><thead><tr>' +
      rbSortTh(_ovDSort, 'ovDSort', 'code', '代號 / 名稱').replace('class="num ', 'class="') +
      rbSortTh(_ovDSort, 'ovDSort', 'sd', '整體上下差', '排序依元') +
      rbSortTh(_ovDSort, 'ovDSort', 'medUp', '夜盤上漲的日子', '排序依元') +
      rbSortTh(_ovDSort, 'ovDSort', 'medDn', '夜盤下跌的日子', '排序依元') + '</tr></thead><tbody>';
    rbSortRows(rows, _ovDSort, _ovDSortVal).forEach(function (r) {
      // 百分點對下單沒意義，換成這一檔的元：偏移×前收÷100。
      // 「上下 0.11 元」才知道掛價要留多少餘裕。
      var yuan = function (v) { return (r.basePx > 0) ? v * r.basePx / 100 : null; };
      var cell = function (sd, med, n) {
        if (sd == null) return '<td class="num rs-dim">樣本不足</td>';
        var m = yuan(med), d = yuan(sd);
        return '<td class="num">' + (med >= 0 ? '+' : '−')
          + (m == null ? Math.abs(med).toFixed(2) : Math.abs(m).toFixed(2)) + ' 元' +
          '<span class="ov-sub">上下 ' + (d == null ? sd.toFixed(2) : d.toFixed(2)) + ' 元　' + n + ' 天</span></td>';
      };
      h += '<tr><td><span class="tx-ocode">' + r.code + '</span><span class="tx-oname">' + _rbName(r.code) + '</span></td>' +
        '<td class="num" style="font-weight:700">'
          + ((r.basePx > 0) ? (r.sd * r.basePx / 100).toFixed(2) + ' 元' : r.sd.toFixed(2)) + '</td>' +
        cell(r.sdUp, r.medUp, r.nUp) + cell(r.sdDn, r.medDn, r.nDn) + '</tr>';
    });
    h += '</tbody></table></div>' +
      '<div class="rb-caveat">「整體上下差」小的那幾檔照劇本走，大的那幾檔同樣的夜盤漲幅、' +
      '結果散得多很多——這跟「會漲多少」無關，跟「掛價要留多少餘裕」直接相關。' +
      '每一欄的主數字是偏移的中位數（正＝實際比推估高），小字是上下差與天數。</div>';
  }

  h += ovHitHtml();
  h += '</div>';
  return h;
}
