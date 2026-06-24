// 股利總管 模組：portfolio — 新增/編輯/搜尋/儲存/刪除/股利快取（自 股利總管_v1_30.html 原樣抽出，邏輯未改動）
// ── ADD / EDIT MODAL ──
function openAddModal() {
  editingId = null;
  searchedStock = null;
  document.getElementById('modal-stock-title').textContent = '新增持股';
  document.getElementById('input-code').value = '';
  document.getElementById('input-code').disabled = false;
  document.getElementById('search-btn').style.display = '';
  document.getElementById('input-shares').value = '';
  document.getElementById('input-cost').value = '';
  document.getElementById('search-result').className = 'search-result';
  document.getElementById('search-result').textContent = '';
  document.getElementById('shares-preview').textContent = '';
  document.getElementById('manual-name-group').style.display = 'none';
  document.getElementById('input-name').value = '';
  document.getElementById('select-div-type').value = '';
  document.getElementById('div-months-group').style.display = 'none';
  document.getElementById('input-div-months').value = '';
  document.getElementById('div-months-source').textContent = '';
  document.getElementById('manual-div-group').style.display = 'none';
  document.getElementById('input-manual-div').value = '';
  document.getElementById('delete-btn').style.display = 'none';
  document.getElementById('save-btn').textContent = '儲存持股';
  openModal('modal-stock');
  setTimeout(() => document.getElementById('input-code').focus(), 350);
}

function openEditModal(id) {
  const stock = portfolio.find(s => s.id === id);
  if (!stock) return;
  editingId = id;
  searchedStock = { code: stock.code, name: stock.name };
  document.getElementById('modal-stock-title').textContent = '編輯持股';
  document.getElementById('input-code').value = stock.code;
  document.getElementById('input-code').disabled = true;
  document.getElementById('search-btn').style.display = 'none';
  document.getElementById('input-shares').value = stock.shares;
  document.getElementById('input-cost').value = (stock.cost != null && stock.cost !== '') ? stock.cost : '';
  const result = document.getElementById('search-result');
  result.className = 'search-result visible';
  result.textContent = '✓ ' + stock.name + '（' + stock.code + '）';
  updateSharesPreview(stock.shares);
  document.getElementById('delete-btn').style.display = '';
  document.getElementById('save-btn').textContent = '更新持股';
  // 還原手動配息設定
  // divFreqType determines display
  const divType = stock.divFreqType || '';
  document.getElementById('select-div-type').value = divType;
  document.getElementById('input-div-months').value = stock.divMonths || '';
  document.getElementById('div-months-source').textContent = stock.divMonthsSource ? '（' + stock.divMonthsSource + '）' : '';
  document.getElementById('div-months-group').style.display = (divType && divType !== 'none') ? 'block' : 'none';
  document.getElementById('manual-div-group').style.display = (divType && divType !== 'none') ? 'block' : 'none';
  document.getElementById('input-manual-div').value = stock.manualDiv || '';
  openModal('modal-stock');
}

// ── 內建常用股票清冊（上市＋上櫃＋ETF） ──
const STOCK_DB = {
  '0050':'元大台灣50','0051':'元大中型100','0052':'富邦科技','0053':'元大電子','0054':'元大台商50',
  '0055':'元大MSCI金融','0056':'元大高股息','0057':'富邦摩台','0058':'富邦發達','0059':'富邦金融',
  '006200':'富邦台灣優質高息','006201':'元大富櫃50','00625K':'富邦聚焦高息30','00631L':'元大台灣50正2',
  '00632R':'元大台灣50反1','00636':'國泰臺灣加權','00637L':'元大滬深300正2','00638R':'元大滬深300反1',
  '00639':'富邦深100','00640':'野村印度','00643':'群益深証中小','00646':'元大S&P500',
  '00647L':'元大美股雙漲','00648R':'元大美股雙跌','00650L':'富邦NASDAQ正2','00651R':'富邦NASDAQ反1',
  '00652':'富邦印度','00653L':'富邦道瓊正2','00654R':'富邦道瓊反1','00655L':'國泰中國A50正2',
  '00656':'元大亞太高股息','00657':'國泰日本正2','00660':'元大歐洲50','00661':'元大日本正2',
  '00662':'富邦NASDAQ','00663L':'國泰臺灣加權正2','00664R':'國泰臺灣加權反1','00665L':'富邦恒生正2',
  '00666R':'富邦恒生反1','00667':'國泰美國道瓊','00668':'國泰美國費城半導體',
  '00669':'富邦深証','00670L':'富邦恒生國企正2','00672':'富邦台灣加權','00673R':'富邦台灣加權反1',
  '00675L':'富邦臺灣加權正2','00676L':'富邦美國','00677U':'富邦美國短期公債',
  '00678':'群益非投等債','00679B':'元大美債20年','00680L':'元大美債20正2','00681L':'元大美債20反1',
  '00682':'富邦MSCI台灣','00683L':'富邦MSCI台灣正2','00685L':'群益臺灣加權','00686':'元大MSCI台灣ESG',
  '00687B':'國泰20年美債','00688B':'國泰15年EM債','00689':'野村台灣金融','00690':'兆豐藍籌30',
  '00692':'富邦公司債','00693B':'兆豐投等債20+','00694B':'群益25年美債','00695B':'群益中國政策債',
  '00696B':'富邦美債1-3','00697B':'元大10年IG公司債','00698':'路博邁新興收益',
  '00700':'富邦台灣半導體','00701':'國泰股利精選30','00702':'國泰標普低波高息',
  '00703':'台新北美景氣','00706L':'元大S&P原油正2','00707R':'元大S&P原油反1',
  '00708L':'元大S&P黃金正2','00709':'野村全球不動產','00710B':'復華彭博新興高收益債',
  '00711B':'復華彭博10年IG債','00712':'復華富時不動產','00713':'元大台灣高息低波',
  '00714':'群益道瓊美國地產','00715L':'復華S&P500正2','00716R':'復華S&P500反1',
  '00717':'富邦美國特別股','00718B':'群益投等債20+','00719B':'元大美債7-10',
  '00720B':'元大投等債20+','00721B':'元大新興債10年以上','00722B':'群益10年IG美債',
  '00723B':'群益新興債3-7年','00724B':'群益新興市場主權債','00725B':'台新投等債20年',
  '00726B':'台新美國短期公司債','00727B':'台新新興市場債','00728B':'第一金20年美債',
  '00730':'富邦道瓊優良特別股','00731':'復華彭博美國RE','00733':'富邦台灣中小A',
  '00734':'臺灣工銀新興市場ESG','00735':'國泰羅素全世界','00736':'國泰永豐臺灣ESG',
  '00737':'大華優利高填息30','00739B':'國泰投等債15+','00740B':'國泰A級公司債',
  '00741B':'群益全球非投等債','00742B':'新光美債14+','00743B':'新光亞洲成熟市場債',
  '00745B':'新光全球債','00746B':'台新美國公司債15+','00747':'統一台灣動能',
  '00748B':'新光優先順位高收益債','00751B':'台新彭博1-5年期美國公司債',
  '00752':'新光內需收益','00753B':'台新彭博5-10年期美國公司債',
  '00755B':'新光彭博新興市場政府債','00757':'統一FANG+','00762':'國泰臺灣ESG永續',
  '00770':'富邦全球優選ETF','00771':'元大全球AI','00773B':'中信優先金融債',
  '00774B':'中信高評級公司債','00775B':'新光投等債20年','00776B':'元大投資級公司債',
  '00777':'富邦臺灣中小優選','00779B':'凱基美債25+','00780':'富邦台灣半導體30',
  '00781':'國泰台灣5G+','00783':'富邦台灣醫療保健','00784':'國泰永續高股息',
  '00787':'富邦全球半導體','00791':'台新臺灣IC設計','00797':'統一MSCI台灣',
  '00830':'國泰費城半導體','00831':'兆豐臺灣晶圓製造','00832':'富邦標普美國REITs',
  '00836B':'街口美債20年IG','00850':'元大臺灣ESG永續','00851':'台新標普500ESG',
  '00855':'野村臺灣健康照護','00858':'野村台灣金融機構','00861':'野村台科技',
  '00864B':'群益ESG投等債20+','00865B':'富邦美國優先順位高收益','00867B':'群益新興市場投等債',
  '00868':'野村全球品牌50','00875':'國泰智能電動車','00876':'元大臺灣ESG低碳50',
  '00878':'國泰永續高股息','00882':'中信中國高股息','00883':'中信電池及儲能',
  '00886':'永豐ESG低碳高息','00887':'永豐美國科技','00891':'中信關鍵半導體',
  '00892':'富邦台灣半導體5G','00893':'國泰智能電動車','00894':'中信小資高價30',
  '00895':'富邦未來車','00896':'中信綠能及電動車','00898':'野村全球品牌',
  '00900':'富邦特選高股息30','00904':'新光臺灣半導體30','00905':'野村優質高息能源',
  '00907':'永豐優息存股','00911':'兆豐台灣晶圓製造','00912':'中信台灣智慧50',
  '00915':'凱基優選高股息30','00916':'國泰全球品牌50','00917':'中信特選金融','00918':'大華優利甄選高息30',
  '00919':'群益台灣精選高息','00921':'兆豐台灣核心50','00922':'國泰台灣智慧城市',
  '00923':'群益半導體收益','00924':'永豐臺灣永續優息','00927':'永豐美國科技ETF',
  '00929':'復華台灣科技優息','00930':'永豐ESG綠色電力','00932':'兆豐永續高息等權',
  '00933B':'國泰10Y+金融債','00934':'中信成長高息','00936':'台新臺灣IC設計',
  '00939':'統一台灣高息動能','00940':'元大台灣價值高息','00941':'台新北美科技',
  '00943B':'群益ESG投等美債','00944':'永豐台灣ESG永續高息','00945B':'台新彭博投等債10+',
  '00946':'大華銀ESG永續優選30','00947':'野村優化高息A組合',
  // 藍籌股
  '1101':'台泥','1102':'亞泥','1216':'統一','1301':'台塑','1303':'南亞',
  '1326':'台化','1402':'遠東新','1504':'東元','1590':'亞德客-KY',
  '2002':'中鋼','2008':'高興昌','2049':'上銀','2059':'川湖',
  '2105':'正新','2207':'和泰車','2301':'光寶科','2303':'聯電',
  '2308':'台達電','2317':'鴻海','2324':'仁寶','2325':'矽品',
  '2327':'國巨','2330':'台積電','2331':'精英','2332':'台灣大',
  '2344':'華邦電','2345':'智邦','2347':'聯強','2352':'佳世達',
  '2353':'宏碁','2354':'鴻準','2356':'英業達','2357':'華碩',
  '2360':'致茂','2362':'藍天','2363':'矽統','2376':'技嘉',
  '2377':'微星','2379':'瑞昱','2382':'廣達','2383':'台光電',
  '2385':'群光','2386':'麗正','2388':'威盛','2392':'正崴',
  '2395':'研華','2399':'映泰','2401':'凌陽','2402':'毅嘉',
  '2404':'漢唐','2408':'南亞科','2409':'友達','2412':'中華電',
  '2413':'環科','2414':'精技','2415':'毅天','2420':'新日興',
  '2421':'建準','2422':'彩晶','2423':'固緯','2424':'隴華',
  '2425':'承啟','2426':'鼎元','2427':'三商電','2429':'銘異',
  '2430':'燦坤','2431':'聯昌','2432':'超豐','2433':'互動',
  '2434':'統懋','2436':'偉詮電','2439':'美律','2441':'超潁',
  '2443':'實創','2444':'兆勁','2449':'京元電子','2450':'神腦',
  '2451':'創見','2454':'聯發科','2455':'全新','2458':'義隆',
  '2459':'敦吉','2460':'建通','2461':'光群雷','2462':'誠研',
  '2463':'遠傳','2464':'盟立','2465':'麗臺','2466':'冠西電',
  '2467':'志超','2468':'華經','2471':'資通','2474':'可成',
  '2475':'華映','2476':'鉅祥','2478':'大毅','2480':'敦陽科',
  '2482':'連宇','2485':'兆赫','2488':'漢平','2489':'瑞軒',
  '2491':'吉祥全','2492':'華新科','2493':'揚博','2495':'普安',
  '2496':'卓越','2497':'怡利電','2498':'宏達電','2499':'東貝',
  '2501':'國建','2502':'長榮建設','2503':'長亨','2504':'國產',
  '2505':'國泰建設','2506':'太設','2511':'太子','2515':'中工',
  '2520':'冠德','2521':'宏普','2524':'京城建設','2527':'宏璟',
  '2528':'皇普','2530':'華建','2534':'宏盛','2535':'達欣工',
  '2536':'宏普','2537':'聯上發','2538':'基泰','2539':'遠雄',
  '2547':'日勝生','2548':'華固','2603':'長榮','2609':'陽明',
  '2610':'華航','2615':'萬海','2618':'長榮航','2633':'台灣高鐵',
  '2801':'彰銀','2809':'京城銀','2812':'台中銀','2816':'旺旺保',
  '2820':'華票','2823':'中壽','2824':'台灣產物','2826':'萬通金',
  '2832':'台產','2834':'臺企銀','2836':'聯邦銀','2838':'聯邦銀',
  '2845':'遠東銀','2847':'大眾銀','2849':'安泰銀','2850':'新產',
  '2851':'中再保','2852':'第一保','2855':'統一證','2856':'元富證',
  '2860':'元大金','2861':'日盛金','2867':'三商壽','2880':'華南金',
  '2881':'富邦金','2882':'國泰金','2883':'開發金','2884':'玉山金',
  '2885':'元大金','2886':'兆豐金','2887':'台新金','2888':'新光金',
  '2889':'國票金','2890':'永豐金','2891':'中信金','2892':'第一金',
  '2912':'統一超','3008':'大立光','3017':'奇鋐','3034':'聯詠',
  '3037':'欣興','3045':'台灣大','3481':'群創','3490':'單井電',
  '3702':'大聯大','4904':'遠傳','4938':'和碩','5854':'合庫金',
  '6409':'旭隼','6415':'矽力-KY','6505':'台塑化','6669':'緯穎',
  '9910':'豐泰','9917':'中保科','9921':'巨大','9945':'潤泰新',
};

// ── STOCK SEARCH ──
async function searchStock() {
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  const result = document.getElementById('search-result');
  const btn = document.getElementById('search-btn');
  const manualGroup = document.getElementById('manual-name-group');
  if (!code) { showSearchError('請輸入股票代碼'); return; }

  // 第一層：內建清冊直接查詢
  if (STOCK_DB[code]) {
    searchedStock = { code, name: STOCK_DB[code] };
    result.className = 'search-result visible';
    result.innerHTML = '✓ <strong>' + STOCK_DB[code] + '</strong>（' + code + '）';
    manualGroup.style.display = 'none';
    return;
  }

  // 第二層：嘗試 API
  btn.innerHTML = '<span class="spinner"></span>';
  btn.disabled = true;
  result.className = 'search-result';
  manualGroup.style.display = 'none';

  try {
    const res = await fetchWithCORS('https://openapi.twse.com.tw/v1/opendata/t187ap03_L');
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    const found = data.find(d => (d['公司代號'] || '').trim() === code);
    if (found) {
      const name = (found['公司簡稱'] || found['公司名稱'] || '').trim();
      searchedStock = { code, name };
      result.className = 'search-result visible';
      result.innerHTML = '✓ <strong>' + name + '</strong>（' + code + '）';
      manualGroup.style.display = 'none';
      const dvt2 = document.getElementById('select-div-type').value;
      if (dvt2) autoDetectDivMonths(code, dvt2);
    } else {
      throw new Error('not found');
    }
  } catch (err) {
    // 第三層：顯示手動輸入欄位
    searchedStock = null;
    result.className = 'search-result visible';
    result.innerHTML = '<span style="color:var(--text2)">查無此代碼，請手動輸入股票名稱</span>';
    manualGroup.style.display = 'block';
    setTimeout(() => document.getElementById('input-name').focus(), 100);
  } finally {
    btn.innerHTML = '查詢';
    btn.disabled = false;
  }
}

function showSearchError(msg) {
  const r = document.getElementById('search-result');
  r.className = 'search-result visible search-error';
  r.textContent = '✗ ' + msg;
}

// ── SHARES PREVIEW ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('input-shares').addEventListener('input', function() {
    updateSharesPreview(this.value);
  });
  document.getElementById('input-code').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') searchStock();
  });
  refreshHome();
  document.getElementById('month-label').textContent =
    (new Date().getMonth()+1) + ' 月（入帳月份）';
});

// ── 自動偵測配息月份（從 API 歷史資料分析） ──
async function autoDetectDivMonths(code, divType) {
  const monthsInput = document.getElementById('input-div-months');
  const sourceLabel = document.getElementById('div-months-source');
  if (!monthsInput) return;
  // 不配息直接填「—」
  if (divType === 'none') { monthsInput.value = '—'; return; }
  // 月配：直接填 1-12，不需要 API
  if (divType === 'monthly') {
    monthsInput.value = '1-12';
    sourceLabel.textContent = '（月配息，入帳 1-12 月）';
    return;
  }
  // 其他類別：從 API 歷史偵測入帳月份
  sourceLabel.textContent = '（偵測中…）';
  try {
    const history = await fetchStockDivHistory(code);
    if (!history || history.length === 0) {
      sourceLabel.textContent = '（無資料，請手動輸入）';
      return;
    }
    // 以入帳月（除息月+1）分析
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 24);
    const payMonthSet = new Set();
    for (const rec of history) {
      if (rec.exDate && rec.exDate >= cutoff) {
        const pd = exToPayDate(rec.exDate);
        if (pd) payMonthSet.add(pd.getMonth() + 1);
      }
    }
    if (payMonthSet.size === 0) {
      sourceLabel.textContent = '（無近期資料，請手動輸入）';
      return;
    }
    const sortedMonths = Array.from(payMonthSet).sort((a,b) => a-b);
    // 半年配：取最新兩個月份
    if (divType === 'semiannual') {
      const recent2 = sortedMonths.slice(-2);
      monthsInput.value = recent2.join(',');
    }
    // 季配：取最新四個月份
    else if (divType === 'quarterly') {
      const recent4 = sortedMonths.slice(-4);
      monthsInput.value = recent4.join(',');
    }
    // 年配：取最新一個月份
    else if (divType === 'annual') {
      monthsInput.value = sortedMonths[sortedMonths.length - 1].toString();
    }
    else {
      monthsInput.value = sortedMonths.join(',');
    }
    sourceLabel.textContent = '（自動偵測入帳月份）';
  } catch(e) {
    sourceLabel.textContent = '（偵測失敗，請手動輸入）';
  }
}

// ── 解析配息月份字串 → 月份陣列（1-based） ──
function parseDivMonths(str) {
  if (!str || !str.trim()) return [];
  str = str.trim();
  // 區間格式 1-12
  const rangeMatch = str.match(/^(\d{1,2})-(\d{1,2})$/);
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1]), to = parseInt(rangeMatch[2]);
    const months = [];
    for (let m = from; m <= to; m++) months.push(m);
    return months;
  }
  // 逗號格式 1,4,7,10
  return str.split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 12);
}

function onDivTypeChange(val) {
  const hasDiv = val && val !== 'none';
  document.getElementById('div-months-group').style.display = hasDiv ? 'block' : 'none';
  document.getElementById('manual-div-group').style.display = hasDiv ? 'block' : 'none';
  if (!hasDiv) {
    document.getElementById('input-div-months').value = val === 'none' ? '—' : '';
    document.getElementById('div-months-source').textContent = '';
    return;
  }
  // 若已有股票代碼則自動偵測配息月份
  const code = document.getElementById('input-code').value.trim().toUpperCase() ||
               (searchedStock && searchedStock.code);
  if (code) autoDetectDivMonths(code, val);
}
function updateSharesPreview(val) {
  const preview = document.getElementById('shares-preview');
  const n = parseFloat(val);
  if (!val || isNaN(n) || n <= 0) { preview.textContent = ''; return; }
  const units = Math.round(n * 1000);
  preview.textContent = '= ' + units.toLocaleString('zh-TW') + ' 股';
}

// ── SAVE ──
function saveStock() {
  const sharesVal = document.getElementById('input-shares').value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  const manualGroup = document.getElementById('manual-name-group');

  if (!searchedStock && manualGroup.style.display !== 'none') {
    const manualName = document.getElementById('input-name').value.trim();
    if (!manualName) { document.getElementById('input-name').focus(); return; }
    searchedStock = { code, name: manualName };
  }

  if (!searchedStock && !editingId) { showSearchError('請先查詢股票代碼'); return; }
  if (!sharesVal || isNaN(parseFloat(sharesVal)) || parseFloat(sharesVal) <= 0) {
    alert('請輸入有效的持股張數');
    return;
  }

  const shares = parseFloat(parseFloat(sharesVal).toFixed(3));
  const btn = document.getElementById('save-btn');
  btn.textContent = '儲存中…';
  btn.disabled = true;

  setTimeout(() => {
    const divFreqType = document.getElementById('select-div-type').value || null;
    const manualDiv = parseFloat(document.getElementById('input-manual-div').value) || null;
    const divMonthsVal = document.getElementById('input-div-months').value.trim() || null;
    const divMonthsSource = document.getElementById('div-months-source').textContent.replace(/[（）]/g,'').trim() || null;
    const cost = Math.round(parseFloat((document.getElementById('input-cost').value || '').replace(/,/g, ''))) || null;
    const stockData = {
      shares,
      cost,
      divFreqType,
      divMonths: divFreqType === 'none' ? null : divMonthsVal,
      divMonthsSource,
      manualDiv: (divFreqType && divFreqType !== 'none') ? manualDiv : null,
      divFreq: divFreqType,
    };
    if (editingId) {
      portfolio = portfolio.map(s => s.id === editingId ? { ...s, ...stockData } : s);
    } else {
      portfolio.push({
        id: Date.now().toString(),
        code: searchedStock.code,
        name: searchedStock.name,
        addedAt: new Date().toISOString(),
        ...stockData,
      });
    }
    savePortfolio(portfolio);
    closeModal('modal-stock');
    renderPortfolio();
    refreshHome();
    btn.textContent = editingId ? '更新持股' : '儲存持股';
    btn.disabled = false;
  }, 400);
}

// ── DELETE ──
function confirmDelete() {
  const stock = portfolio.find(s => s.id === editingId);
  if (!stock) return;
  document.getElementById('delete-confirm-text').innerHTML =
    '確定要刪除 <strong>' + (stock.name || stock.code) + '</strong> 的持股資料嗎？<br>此操作無法復原。';
  openModal('modal-delete');
}
function executeDelete() {
  portfolio = portfolio.filter(s => s.id !== editingId);
  savePortfolio(portfolio);
  closeModal('modal-delete');
  closeModal('modal-stock');
  renderPortfolio();
  refreshHome();
  editingId = null;
}

// ── DIVIDEND CACHE ──
const DIV_CACHE_KEY = 'dividend_cache';
const DIV_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

function getDivCache() {
  try { return JSON.parse(localStorage.getItem(DIV_CACHE_KEY)) || {}; }
  catch { return {}; }
}
function setDivCache(data) {
  localStorage.setItem(DIV_CACHE_KEY, JSON.stringify(data));
}

// ── PARSE ROC DATE (民國年) → JS Date ──
// 支援格式：115年04月20日 / 115/04/20 / 2026/04/20 / 2026-04-20
function parseROCDate(str) {
  if (!str) return null;
  str = str.trim();
  // 民國中文：115年04月20日
  let m = str.match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (m) return new Date(parseInt(m[1]) + 1911, parseInt(m[2]) - 1, parseInt(m[3]));
  // 民國斜線：115/04/20
  m = str.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})/);
  if (m) {
    const y = parseInt(m[1]);
    return new Date((y < 1000 ? y + 1911 : y), parseInt(m[2]) - 1, parseInt(m[3]));
  }
  // 西元：2026-04-20 or 2026/04/20
  m = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  return null;
}

