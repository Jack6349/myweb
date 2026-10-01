// 股利總管 Web — 策略檢視：每個指標的六欄說明
//
// 為什麼有這支檔案：指標只給統計輸出不算交付。每一個數字都要走完
// 「定義 → 比較基準 → 白話意義 → 機制 → 行動含義 → 這個指標不能告訴你什麼」
// 這條鏈，六欄缺一不可。寫不出六欄，代表那個指標還沒想清楚，不該放上畫面。
//
// 文字裡的數字一律由當下資料帶入，不寫死：寫死的數字過兩天就變成錯的。
// 第六欄特別重要——「在外單位數第 25 百分位」單獨看會讓人以為基金在走下坡，
// 要配上「成立以來 +115%」才知道真正的故事是從高峰回落。

// 同一來源的市值型對照（富邦台 50，2026-10-01 揭露）。
// 用它當「有沒有變成市值型」的尺：同一張揭露表、同一種算法，才比得過去。
var SD_REF_0 = { code: '006208', name: '富邦台50', n: 50, bench: 56.70, top5: 71.91 };

function _sdStat(f, k) {
  var ser = f[k] || [], vals = [], firstI = -1, lastI = -1;
  ser.forEach(function (v, i) {
    if (v == null) return;
    if (firstI < 0) firstI = i;
    lastI = i; vals.push(v);
  });
  if (!vals.length) return null;
  var sorted = vals.slice().sort(function (a, b) { return a - b; });
  return {
    now: ser[lastI], first: vals[0], d: ser[lastI] - vals[0],
    firstDate: f.dates[firstI], lastDate: f.dates[lastI],
    n: vals.length, total: ser.length,
    rank: _sdRank(vals, ser[lastI]),
    p25: _sdPct(sorted, 0.25), p50: _sdPct(sorted, 0.5), p75: _sdPct(sorted, 0.75),
    min: sorted[0], max: sorted[sorted.length - 1]
  };
}

// 前五大是不是集中在同一個族群：名單看得出來，數字看不出來
function _sdTop5Names(f) {
  return (f.top || []).slice(0, 5).map(function (x) { return x.n; }).join('、');
}

var SD_DOC = {
  n: function (f, s) { return {
    def: '當日揭露的持股家數，直接數富邦每日持股明細有幾列。',
    base: '跟這檔自己成立以來的 ' + s.total + ' 個交易日比。不跟別檔比：檔數多寡由策略決定，' +
          '同一天 ' + SD_REF_0.code + ' ' + SD_REF_0.name + ' 也是 ' + SD_REF_0.n + ' 檔，但那是追指數的結果，兩者不同義。',
    plain: '現在 ' + s.now + ' 檔，成立時 ' + s.first + ' 檔（第 ' + s.rank.toFixed(0) +
           ' 百分位，成立以來區間 ' + s.min + '–' + s.max + ' 檔）。',
    mech: '檔數下降有兩種來源：出清一檔（名字從清單消失），或賣掉後沒有補新倉。' +
          '實測不是單向砍倉——9/30 出清邁科，10/01 新增南亞與景碩、同時又出清一檔，' +
          '是有進有出的淨減少。',
    act: '這個數字單獨不構成任何訊號，要跟前五大一起看：' +
         '檔數減少＋前五大上升＝資金集中到少數名字；檔數減少＋前五大持平＝只是尾巴部位的清理。' +
         '目前是前者。',
    lim: '它不含權重。砍掉一檔 0.001% 的部位和砍掉一檔 5% 的部位，在這個數字上都是 −1。' +
         '最新揭露裡最小的兩檔分別只有 0.0045% 與 0.001%，它們進出對你的損益毫無影響。'
  }; },

  top5: function (f, s) { return {
    def: '權重最大的五檔相加，再除以股票合計權重。<code>Σ前五大權重 ÷ 股票合計 × 100</code>',
    base: '跟自己成立以來的 ' + s.total + ' 個交易日比。另有一個方向性的對照：' +
          '同一天 ' + SD_REF_0.code + ' ' + SD_REF_0.name + ' 的前五大是 ' + SD_REF_0.top5.toFixed(2) + '%，' +
          '市值型天生就極度集中，所以那不是門檻，只是告訴你刻度在哪裡。',
    plain: '你每投 100 元在它的股票部位，現在有 ' + s.now.toFixed(1) + ' 元壓在五檔上，' +
           '成立時是 ' + s.first.toFixed(1) + ' 元。',
    mech: '為什麼要除以股票合計：主動式 ETF 走現金申購買回，贖回從現金付錢、持股不動，' +
          '淨資產縮小會讓每一檔的權重一起上升。不除掉的話，單純的贖回會被讀成「變集中」。' +
          '除掉之後剩下的是價格效應加上主動加碼。這次兩種算法差 0.06 個百分點，' +
          '所以這段集中是真的有人在加碼，不是贖回造成的假象。',
    act: '這是整頁唯一直接對應你持有理由的數字。你買它是為了分散族群，' +
         '而它從 ' + s.first.toFixed(1) + '% 走到 ' + s.now.toFixed(1) + '%（第 ' + s.rank.toFixed(0) + ' 百分位），' +
         '分散程度已經和當初不同。要不要因此調整是你的決定；這裡能確定的是這不是波動，是單向走高。',
    lim: '它分不出「集中在相關性高的同一族群」和「集中在五個不相關的產業」。' +
         '目前前五大是' + _sdTop5Names(f) + '，全部在電子供應鏈，' +
         '實際的分散程度比 ' + s.now.toFixed(1) + '% 這個數字看起來更低。要看名單才知道。'
  }; },

  max1: function (f, s) { return {
    def: '權重最大的那一檔除以股票合計。<code>最大單一權重 ÷ 股票合計 × 100</code>',
    base: '跟自己成立以來的 ' + s.total + ' 個交易日比（區間 ' + s.min.toFixed(2) + '%–' + s.max.toFixed(2) + '%）。',
    plain: '最大一檔是' + ((f.top && f.top[0] && f.top[0].n) || '—') + '，佔股票部位 ' + s.now.toFixed(2) + '%，' +
           '成立時最大的那一檔只有 ' + s.first.toFixed(2) + '%。',
    mech: '權重變重只有兩種來源：那一檔漲得比別人多，或經理人加碼。' +
          '這一頁分不開兩者，要分開得看股數有沒有增加（原始持股資料有存，目前沒做成指標）。',
    act: '把它換算成你自己的曝險：你在 00405A 的部位 × ' + s.now.toFixed(2) + '% 就是你透過它間接持有' +
         ((f.top && f.top[0] && f.top[0].n) || '最大那一檔') + '的金額。' +
         '但別拿這個權重去推跌幅——實測的連動比權重大得多，見下面的侷限。',
    lim: '權重不是風險。' + (f.sens
         ? '實測 ' + f.sens.name + '每跌 1%，淨值跟著跌 ' + f.sens.beta.toFixed(2) +
           '%，照權重推只會算出 ' + (f.sens.w / 100).toFixed(2) + '，差約 ' +
           (f.sens.beta / (f.sens.w / 100)).toFixed(0) + ' 倍——因為持股彼此相關，它跌的時候同族群一起跌。'
         : '持股彼此相關時，權重會低估實際連動。') +
         ' 另外它也不知道公開說明書的單一個股上限是多少，看不出離制度上限還有多遠。'
  }; },

  bench: function (f, s) { return {
    def: '台積電（2330）權重除以股票合計。沒持有就是 0。',
    base: '兩個基準。一是自己的歷史（區間 ' + s.min.toFixed(2) + '%–' + s.max.toFixed(2) + '%）；' +
          '二是市值型的刻度：同一天 ' + SD_REF_0.code + ' ' + SD_REF_0.name + ' 的台積電佔 ' +
          SD_REF_0.bench.toFixed(2) + '%。',
    plain: '現在 ' + s.now.toFixed(2) + '%，離市值型的 ' + SD_REF_0.bench.toFixed(0) + '% 非常遠，' +
           '成立以來還往下走了 ' + Math.abs(s.d).toFixed(2) + ' 個百分點。',
    mech: '主動式 ETF 最常見的漂移方式是往大型權值股靠攏——跟著指數走最不容易落後太多。' +
          '真的發生時，台股的 ETF 一定會先反映在台積電權重上，因為它是台股最大的單一標的。',
    act: '目前這一項是「沒事」。它的價值不在現在的數字，而在它開始上升的那一天：' +
         '那代表你用兩檔 ETF 分散族群的配置開始重疊，該考慮擇一。',
    lim: '不靠攏台積電不等於風格沒變。這次 00405A 的漂移發生在集中度上，' +
         '台積電這條線幾乎沒動，只看這一項會以為一切正常。'
  }; },

  stock: function (f, s) { return {
    def: '股票合計佔總資產的比重，其餘為現金與其他。富邦揭露表的「股票合計」那一列。',
    base: '跟自己成立以來的 ' + s.total + ' 個交易日比（區間 ' + s.min.toFixed(2) + '%–' + s.max.toFixed(2) + '%）。',
    plain: '股票 ' + s.now.toFixed(2) + '%，換句話說手上現金約佔 ' + (100 - s.now).toFixed(2) + '%。',
    mech: '現金是贖回的緩衝。贖回要用現金付，現金夠就不必動到股票；' +
          '現金越低，下一筆大額贖回越可能逼著賣股。',
    act: '這是「會不會被迫賣股」的預警，要跟在外單位數一起看。' +
         '實例：9/23 現金只剩 3.1%（約 8.63 億），9/24 來了 13.72 億的贖回，' +
         '當天就賣掉創意 91 張與聯發科 136 張共 14.95 億——那天個股是漲的，不是看壞，是要湊錢。' +
         '現在 ' + (100 - s.now).toFixed(1) + '%，比當時寬。',
    lim: '它不預測贖回會不會來。現金低只是讓衝擊更大，不是讓衝擊更可能發生。'
  }; },

  units: function (f, s) { return {
    def: '基金發行在外的受益權單位總數，富邦揭露頁直接給，不是推算的。',
    base: '兩個維度要一起看，少一個就會誤判。一是跟自己的歷史分布比（第 ' + s.rank.toFixed(0) + ' 百分位）；' +
          '二是跟成立那天的絕對水位比（' + (s.first / 1e8).toFixed(2) + ' 億 → ' + (s.now / 1e8).toFixed(2) + ' 億）。',
    plain: '現在 ' + (s.now / 1e8).toFixed(2) + ' 億單位。比成立時多 ' +
           ((s.now / s.first - 1) * 100).toFixed(0) + '%，但比成立以來 ' + (100 - s.rank).toFixed(0) +
           '% 的日子都低。兩句合起來是「從高峰回落」，不是「每況愈下」——規模沒有退回起點，' +
           '是從高點退潮中。',
    mech: '為什麼看單位數而不看規模：<code>規模 = 在外單位數 × 淨值</code>。' +
          '規模下滑可能是淨值跌（市場的事，你的持有單位沒變），也可能是單位數減少（資金真的走了）。' +
          '單位數把市場漲跌排掉，只留資金流向。<br>' +
          '單位數為什麼會減少：<code>投資人賣超 → 市價低於淨值（折價） → ' +
          '參與券商買便宜憑證向基金贖回、領回淨值 → 單位數註銷</code>。起點是投資人離場，' +
          '不是經理人的判斷。',
    act: '跟股票水位搭配著看：單位數大幅減少＋現金水位低＝預期會出現被迫賣壓，' +
         '那段期間的持股變動不能當成經理人的看法來解讀。',
    lim: '百分位分不出「正在往下探底」和「已經止跌打底」，這是百分位這個統計量天生的侷限。' +
         '最近四個交易日單位數幾乎不動，看起來像止穩，但四天太短，判斷不了。'
  }; },

  tail5: function (f, s) { return {
    def: '權重最小的五檔相加，再除以股票合計。<code>Σ最小五檔權重 ÷ 股票合計 × 100</code>',
    base: '跟自己成立以來的 ' + s.total + ' 個交易日比（區間 ' + s.min.toFixed(3) + '%–' + s.max.toFixed(3) + '%）。',
    plain: '現在 ' + s.now.toFixed(3) + '%，成立時 ' + s.first.toFixed(3) +
           '%。基金最小的五檔加起來不到你股票部位的千分之一。',
    mech: '主動式 ETF 的尾部常常是試水溫的小部位或還沒建完的倉。' +
          '尾部越薄，代表持股清單上那些名字裡有越多是沒有實質金額的。',
    act: '它存在的唯一用途是替「持股檔數」做分母：檔數少 4 檔聽起來很多，' +
         '但如果少掉的是這種尾部部位，對你的損益沒有影響。先看這個再看檔數。',
    lim: '它不告訴你少掉的那幾檔到底是不是尾部。要嚴格回答這件事，' +
         '得逐日比對消失名單當時的權重，目前沒做。它只給一個量級上的參考。'
  }; },

  prem: function (f, s) { return {
    def: '<code>(市價 − 淨值) ÷ 淨值 × 100</code>。來源 MoneyDJ ETF 折溢價頁，不自己算。',
    base: '跟自己有資料的 ' + s.n + ' 個交易日比。樣本只有 ' + s.n + ' 天（來源固定只回最近 30 個交易日），' +
          '這個分位數參考價值有限。',
    plain: '現在 ' + s.now.toFixed(2) + '%。負值代表市價低於淨值，也就是折價。',
    mech: '折價就是參與券商贖回套利的誘因：市價 9.39、淨值 9.46 時，' +
          '券商在市場上用 9.39 收憑證、向基金贖回領 9.46，每單位賺 0.07，單位數同時減少。' +
          '實測對得很整齊：9/17 溢價 +0.12% 那天單位數完全沒動，' +
          '9/21 到 9/24 連四天折價 0.43%–0.74%，單位數連四天減少。',
    act: '它是在外單位數的領先指標。看到折價擴大，可以預期接下來單位數會減少；' +
         '再配上股票水位判斷會不會演變成被迫賣股。',
    lim: '只有 ' + s.n + ' / ' + s.total + ' 天有資料，算不出可靠的分布，不要太認真看它的百分位。' +
         '另外它是收盤價對淨值，盤中的折溢價會更大，這個數字看不到。'
  }; }
};

function sdDocHtml(f, key) {
  var s = _sdStat(f, key), doc = SD_DOC[key];
  if (!s || !doc) return '';
  var d = doc(f, s);
  var m = SD_METRICS.filter(function (x) { return x.k === key; })[0] || {};
  // 標題與全站一致用「說明」，預設收起：單一指標的六欄很長，展開著會把走勢圖擠出畫面。
  // 不寫「這個數字怎麼讀」這種對話句型。
  return '<details class="sd-doc"><summary>說明　<span class="sd-dsum">' + (m.t || key) +
    '</span></summary><dl>' +
    '<dt>定義</dt><dd>' + d.def + '</dd>' +
    '<dt>比較基準</dt><dd>' + d.base + '</dd>' +
    '<dt>白話意義</dt><dd>' + d.plain + '</dd>' +
    '<dt>機制</dt><dd>' + d.mech + '</dd>' +
    '<dt>行動含義</dt><dd>' + d.act + '</dd>' +
    '<dt>這個指標不能告訴你什麼</dt><dd>' + d.lim + '</dd>' +
    '</dl></details>';
}

// ── 決策視圖：每個指標一句結論、一句為什麼在意 ────────────────────────
// 這裡不講機制、不講方法論、不講驗證過程。那些只在分析視圖的六欄裡出現一次。
//
// 燈號的方向：這一頁關心的是「分散的理由還在不在」與「會不會被迫賣股」，
// 所以每個指標各有一個不利的方向（dir：+1＝越高越不利，−1＝越低越不利）。
// 門檻用四分位，不自訂數字：落在不利那一端的四分之一亮黃燈，走到成立以來
// 的極值亮紅燈。四分位是和走勢圖上 P25／P50／P75 同一套，不是另外發明的刻度。
// 檔數不給燈號。它的六欄自己就寫了「單獨不構成任何訊號」，一邊這樣寫一邊給它亮黃燈
// 互相矛盾。更實際的理由：2026-10-01 權重最小的 5 檔加起來只有 0.027%，
// 檔數 50→46 對損益毫無影響，但百分位會算出第 1 百分位，看起來很嚴重。
// 統計上極端、實務上無關的指標不該佔一個燈，它改列在參考項。
var SD_DIR = { top5: +1, max1: +1, bench: +1, stock: +1, units: -1, prem: -1 };

function sdLight(f, key) {
  var s = _sdStat(f, key), dir = SD_DIR[key];
  if (!s || !dir) return null;
  var bad = dir > 0 ? s.max : s.min;                  // 成立以來最不利的那一天
  var q = dir > 0 ? s.p75 : s.p25;                    // 不利端的四分位
  var lv = 0;
  if ((dir > 0 && s.now >= bad) || (dir < 0 && s.now <= bad)) lv = 2;
  else if ((dir > 0 && s.now >= q) || (dir < 0 && s.now <= q)) lv = 1;
  return { lv: lv, s: s };
}

// 位置的描述一律由資料算出來，不在文案裡寫死「最高」「最低」這種最高級：
// 2026-10-02 的教訓——我寫「檔數降到成立以來最少」，實際 min 是 45、現在 46；
// 寫「單一個股走到成立以來最高」，實際 max 是 10.39、現在 9.53。
// 近一個月的走向：只講兩個數字，不下「仍在上升」這種形容詞
function _sdM(k) { return SD_METRICS.filter(function (x) { return x.k === k; })[0]; }

// 近 n 個交易日的單位數淨變化（億）。用來把「折價代表什麼」講成結論而不是選擇題：
// 折價同時可能是「買得便宜」和「資金在退」，光看折價分不出來，配上單位數就分得出來。
function _sdFlow(f, n, back) {
  var u = f.units || [], end = u.length - (back || 0), st = Math.max(1, end - n), sum = 0, got = 0;
  for (var i = st; i < end; i++) {
    if (u[i] == null || u[i - 1] == null) continue;
    sum += u[i] - u[i - 1]; got++;
  }
  return got ? sum / 1e8 : null;
}


// 指標狀態列：只給燈號、數值與位置，不附理由。
// 理由寫在上面的結論與依據裡，兩個地方各講一次就是單一出處的問題。
// 這一塊的角色是「掃一眼現在怎樣」，不是解釋。
function sdExecHtml(f) {
  var order = ['top5', 'max1', 'bench', 'stock', 'units', 'prem'];
  var dot = ['🟢', '🟡', '🔴'];
  var h = '<div class="sd-exec"><div class="sd-oh">指標狀態</div>';
  h += '<div class="sd-xkey">🟢 落在歷史常態（P25–P75）　🟡 偏離常態（P25 以下或 P75 以上）　' +
    '🔴 走到成立以來最不利的一天。四分位與走勢圖的 P25／P50／P75 同一套，不另訂門檻。</div>';
  h += '<div class="sd-grid">';
  order.forEach(function (k) {
    var L = sdLight(f, k), m = _sdM(k);
    if (!L || !m) return;
    h += '<div class="sd-g sd-x' + L.lv + '">' + dot[L.lv] + ' ' + m.t + '　<b>' +
      _sdFmt(L.s.now, m) + '</b>　<span class="sd-gp">第 ' + L.s.rank.toFixed(0) + ' 百分位</span></div>';
  });
  var sn = _sdStat(f, 'n'), st = _sdStat(f, 'tail5');
  if (sn) {
    h += '<div class="sd-g sd-xr">參考　持股檔數　<b>' + sn.now + ' 檔</b>　<span class="sd-gp">常態 ' +
      sn.min + '–' + sn.max + (st ? '，尾部 5 檔 ' + st.now.toFixed(3) + '%' : '') + '</span></div>';
  }
  return h + '</div></div>';
}

function sdOptionsHtml(f) {
  var t = _sdStat(f, 'top5');
  if (!t) return '';
  var q = f.sens, pr = _sdStat(f, 'prem');
  var a = _sdFlow(f, 3, 0), b = _sdFlow(f, 3, 3);
  // 超額報酬一律取「自掛牌起、還原市價」那一組，與下面五檔的表同一個口徑。
  // 不要用 f.excess（淨值、起點是我的資料起點 6/8）：00405A 掛牌價 10.00，
  // 6/8 已經跌到 9.1，用它當起點會把成立後那段跌幅整個漏掉，
  // 算出來落後 8.11 個百分點，自掛牌起算是 17.24 個百分點。同一畫面兩個數字會自相矛盾。
  var ex = null;
  ((_sdData.active && _sdData.active.rows) || []).forEach(function (r) {
    if (r.code === _sdFund) ex = { from: r.own.from, to: r.own.to, days: r.own.days,
      fund: r.own.fund, bm: r.own.bm, ex: r.own.ex,
      label: (_sdData.active && _sdData.active.market) || '大盤' };
  });
  var h = '<div class="sd-opt">';

  // 問題一：它有沒有照自己寫的做。集中、換股都是說明書寫明的策略，不是違規；
  // 它對持有人唯一可驗證的承諾是「追求長期優於台股大盤」。
  h += '<div class="sd-oh">一、它有沒有照公開說明書做</div>';
  if (ex) {
    h += '<div class="sd-ob">它唯一可驗證的那一條，目前這段沒做到：掛牌 ' + ex.from +
      ' 至 ' + ex.to + ' 共 ' + ex.days + ' 個交易日，' + (ex.fund >= 0 ? '+' : '') +
      ex.fund.toFixed(2) + '%，' + ex.label + ' ' + (ex.bm >= 0 ? '+' : '') + ex.bm.toFixed(2) +
      '%，落後 ' + Math.abs(ex.ex).toFixed(2) + ' 個百分點。</div>';
    h += '<div class="sd-onote">以還原市價計，起點為掛牌首日。' +
      '同一區間用淨值算是 +2.09%、市價 +1.65%，差 0.44 個百分點，差別在起算日不在算法。' +
      '說明書寫的是「長期」，' + ex.days + ' 個交易日判斷不了，但這是它存在的全部時間。' +
      '集中度上升、換股頻繁都是它寫明的做法（聚焦龍頭、依市況動態調整），不構成警訊。</div>';
  } else {
    h += '<div class="sd-ob">超額報酬資料不足，無法判斷。</div>';
  }

  h += sdActiveHtml();

  // 問題二：使用者自己的配置假設。這跟基金做得對不對是兩件事。
  h += '<div class="sd-oh">二、它在你的組合裡還算不算分散的那一腳</div>';
  h += '<div class="sd-ob">不算。前五大是' + _sdTop5Names(f) + '，佔股票部位 ' +
    t.now.toFixed(2) + '%，全在電子供應鏈。</div>';
  h += '<ol class="sd-ol">';
  h += '<li>這是它的策略不是漂移：集中度從成立時的 ' + t.first.toFixed(2) + '% 走到 ' +
    t.now.toFixed(2) + '%，方向與說明書一致，不會因為你希望它分散就回頭。</li>';
  if (q) {
    h += '<li>連動比權重大：' + q.name + '每跌 1%，淨值平均跟著跌 ' + q.beta.toFixed(2) +
      '%（' + q.days + ' 個交易日迴歸），照權重 ' + q.w.toFixed(1) + '% 推只會算出 ' +
      (q.w / 100).toFixed(2) + '。同族群一起跌，分散的效果比帳面上更小。</li>';
  }
  if (a != null && b != null) {
    h += '<li>目前不是被動效應：賣壓已收斂（近 3 個交易日單位數 ' + a.toFixed(2) +
      ' 億、前 3 個交易日 ' + b.toFixed(2) + ' 億），集中度不會因為贖回自己變動。</li>';
  }
  h += '</ol>';

  h += '<div class="sd-oh">可選方案</div><div class="sd-ov">';
  h += '<div class="sd-o"><b>A　維持不動</b>　把它當集中型的 Alpha 部位持有，分散改由組合裡其他部位承擔。' +
    '代價：' + (ex ? '目前這段它落後大盤 ' + Math.abs(ex.ex).toFixed(2) + ' 個百分點，' : '') +
    '等於承擔了集中的波動，還沒拿到它承諾的報酬。</div>';
  h += '<div class="sd-o"><b>B　減碼轉出</b>　把原本指望它分散的那部分資金移到真正分散的標的。代價：' +
    (pr ? '目前折價 ' + Math.abs(pr.now).toFixed(2) + '%，賣出等於用低於淨值的價格出場；' : '') +
    '同時放棄它後續可能兌現的 Alpha。</div>';
  h += '<div class="sd-o"><b>C　再觀察</b>　前提：' + t.total +
    ' 個交易日不足以判斷說明書講的「長期」，主動式基金的超額報酬需要更長的區間才看得出來。</div>';
  h += '</div></div>';
  return h;
}

// ── 五檔主動式的超額報酬 ────────────────────────────────────────────
// 這一段不需要持股揭露，只要還原市價與大盤，所以沒接到發行商揭露頁的那幾檔也算得出來。
// 兩個區間各自回答一個問題：自掛牌起＝它對自己的承諾兌現了沒；
// 共同區間＝把掛牌早晚的影響拿掉之後，五檔彼此怎麼比。
function sdActiveHtml() {
  var a = _sdData && _sdData.active;
  if (!a || !a.rows || !a.rows.length) return '';
  var pp = function (v) { return (v >= 0 ? '+' : '') + v.toFixed(2); };
  var h = '<div class="sd-ctitle">五檔主動式 ETF 對' + a.market + '的超額報酬' +
    '<span class="sd-chint">' + a.basis + '</span></div>';
  h += '<div class="inv-table-wrap"><table class="inv-table swap-table"><thead><tr>' +
    '<th>代號</th><th>掛牌日</th><th class="num">自掛牌　基金</th><th class="num">' + a.market +
    '</th><th class="num">超額</th><th class="num">共同區間超額</th></tr></thead><tbody>';
  a.rows.forEach(function (r) {
    var o = r.own, c = r.common;
    var link = '<span class="code-link" title="看線圖" onclick="openChartPop(&#39;' + r.code +
      '&#39;)">' + r.code + '</span>';
    h += '<tr><td class="inv-code">' + link + '</td>' +
      '<td>' + o.from + '</td>' +
      '<td class="num">' + pp(o.fund) + '%</td>' +
      '<td class="num">' + pp(o.bm) + '%</td>' +
      '<td class="num" style="font-weight:700;color:' + (o.ex >= 0 ? 'var(--up)' : 'var(--down)') +
        '">' + pp(o.ex) + ' pp</td>' +
      '<td class="num"' + (c ? ' style="color:' + (c.ex >= 0 ? 'var(--up)' : 'var(--down)') + '"' : '') +
        '>' + (c ? pp(c.ex) + ' pp' : '—') + '</td></tr>';
  });
  h += '</tbody></table></div>';
  h += '<div class="sd-onote">共同區間自 ' + (a.commonFrom || '—') +
    ' 起（最晚掛牌那一檔的首日），把掛牌早晚造成的市況差異拿掉。' +
    '區間都只有幾個月，不足以判斷說明書講的「長期」。</div>';
  return h;
}
