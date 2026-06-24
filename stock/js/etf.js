// 股利總管 模組：etf — ETF 篩選器（自 股利總管_v1_30.html 原樣抽出，邏輯未改動）
// ════ ETF 筛選器模組 ════
var ETF_SCAN_KEY = 'etf_scan_results', ETF_EXCL_KEY = 'etf_excluded', ETF_NEW_KEY = 'etf_new_results', ETF_DATE_KEY = 'etf_scan_date', ETF_WATCH_KEY = 'etf_watchlist';
var EXCL_KW = ['正2','反1','櫭杆','放空','做空','反向'];

function detectEtfType(code, name) {
  name = name || '';
  // 債券型：代碼 B 結尾，或名稱含債券相關
  if (/B$/i.test(code) || /債券|公債|公司債|高收益|投等|非投|國債|投資等級/.test(name)) return 'bond';
  // 高息型：代碼或名稱含配息相關（含填息、優息、高息、月配等）
  if (/高股息|高息|配息|填息|優息|息收|月息|季息|收益|月配|高分紅/.test(name)) return 'dividend';
  // 主動型
  if (/A$/i.test(code) || /^00[0-9]{3,4}A/.test(code) || /主動|積極|精選|創新/.test(name)) return 'active';
  return 'market';
}
function stabilityClass(p) { return p>=80?'s-red':p>=60?'s-orange':p>=40?'s-yellow':p>=20?'s-green':'s-gray'; }
function calcAnnualYield(divs, price) {
  if (!divs || !price) return 0;
  var now = new Date(), ago = new Date(now.getFullYear()-1, now.getMonth(), now.getDate());
  var tot = divs.filter(function(d){ var dt=d.exDate?new Date(d.exDate):(d.date?new Date(d.date*1000):null); return dt&&dt>=ago&&dt<=now; })
               .reduce(function(s,d){ return s+parseFloat(d.cashDiv||d.amount||0); }, 0);
  return Math.round(tot/price*100*10)/10;
}
function calcStability(type, fillRate, yld, divYears) {
  if (type==='bond') return Math.round((fillRate||0)*0.6+Math.min((yld||0)/6*100,100)*0.25+75*0.15);
  var f=(fillRate||0)*0.4, sp=((45)<30?100:(45)<90?75:(45)<180?50:25)*0.25;
  return Math.round(f+sp+Math.min((yld||0)/10*100,100)*0.2+Math.min((divYears||0)/3*100,100)*0.15);
}
function setEtfStatus(msg, pct) {
  var el=document.getElementById('etf-status-text'), bar=document.getElementById('etf-progress-bar'), wrap=document.getElementById('etf-progress-wrap');
  if(el) el.textContent=msg; if(bar) bar.style.width=(pct||0)+'%'; if(wrap) wrap.style.display=(pct<100&&pct>0)?'block':'none';
}
function updateEtfHomeCounts(passed, newEtf) {
  var t=((passed||{}).dividend||[]).length+((passed||{}).bond||[]).length+((passed||{}).market||[]).length+((passed||{}).active||[]).length;
  var e=document.getElementById('card-etf-count'); if(e) e.textContent=t>0?t+' 檔':'—';
  var e2=document.getElementById('card-etf-new-count'); if(e2) e2.textContent=(newEtf||[]).length>0?(newEtf||[]).length+' 檔':'—';
}
async function startFullScan() {
  var btn=document.querySelector('.etf-scan-btn.primary');
  if(btn){btn.textContent='掃描中…';btn.disabled=true;}
  var _zc=document.getElementById('etf-zone-cards'); if(_zc) _zc.innerHTML='';
  setEtfStatus('取得 ETF 清單…',3);
  try {
    var lr=await fetch(GAS_URL+'?finmind_etflist=1'), ld=await lr.json(), etfList=ld.list||[];
    if(!etfList.length) throw new Error('無法取得 ETF 清單');
    setEtfStatus('共 '+etfList.length+' 檔 ETF，開始筛選…',8);
    var passed={dividend:[],bond:[],market:[],active:[]};
    var excl=JSON.parse(localStorage.getItem(ETF_EXCL_KEY)||'[]');
    var newEtf=[], exclCodes=excl.map(function(e){return e.code;}), tot=etfList.length, done=0;
    for(var i=0;i<etfList.length;i+=3){
      var batch=etfList.slice(i,i+3);
      await Promise.all(batch.map(async function(etf){
        try{
          if(exclCodes.indexOf(etf.code)>=0){done++;return;}
          for(var k=0;k<EXCL_KW.length;k++){if((etf.name||'').indexOf(EXCL_KW[k])>=0){excl.push({code:etf.code,name:etf.name,reason:'樿杆/反向型',excludedAt:new Date().toISOString().slice(0,10)});exclCodes.push(etf.code);done++;return;}}
          var pr=await fetch(GAS_URL+'?price='+encodeURIComponent(etf.code)), pd=await pr.json(), price=pd.stat==='OK'?pd.price:null;
          if(!price){done++;return;}
          if(price>30){excl.push({code:etf.code,name:etf.name,reason:'股價>30元（'+price.toFixed(1)+'）',excludedAt:new Date().toISOString().slice(0,10)});exclCodes.push(etf.code);done++;return;}
          var dr=await fetch(GAS_URL+'?code='+encodeURIComponent(etf.code)), dd=await dr.json(), divs=dd.dividends||[];
          if(!divs.length){done++;return;}
          var yld=calcAnnualYield(divs,price), etype=detectEtfType(etf.code,etf.name);
          if(etype==='dividend'&&yld<5){excl.push({code:etf.code,name:etf.name,reason:'高息型殼利率<5%（'+yld+'%）',excludedAt:new Date().toISOString().slice(0,10)});exclCodes.push(etf.code);done++;return;}
          if(etype==='bond'&&yld<3){excl.push({code:etf.code,name:etf.name,reason:'債券型殼利率<3%（'+yld+'%）',excludedAt:new Date().toISOString().slice(0,10)});exclCodes.push(etf.code);done++;return;}
          var fd=divs[0], fdDate=fd?(fd.exDate?new Date(fd.exDate):new Date(fd.date*1000)):null;
          var moAge=fdDate?(new Date()-fdDate)/(1000*60*60*24*30):999;
          var recD=divs.filter(function(d){var dt=d.exDate?new Date(d.exDate):new Date(d.date*1000);return dt>=new Date(new Date().getFullYear()-3,0,1);});
          var filledD=recD.filter(function(d){return d.payDate;});
          // 若 payDate 全為 null（FinMind 無資料），視為資料不足，預設填息率 75%，不排除
          var hasPayData=recD.some(function(d){return d.payDate;});
          var fillRate=!hasPayData?75:(recD.length>0?Math.round(filledD.length/recD.length*100):75);
          if(etype==='dividend'&&hasPayData&&fillRate<50){excl.push({code:etf.code,name:etf.name,reason:'填息率<50%（'+fillRate+'%）',excludedAt:new Date().toISOString().slice(0,10)});exclCodes.push(etf.code);done++;return;}
          var stability=calcStability(etype,fillRate,yld,Math.max(1,Math.round(moAge/12)));
          var now2=new Date(), ago2=new Date(now2.getFullYear()-1,now2.getMonth(),now2.getDate());
          var dh=divs.filter(function(d){var dt=d.exDate?new Date(d.exDate):new Date(d.date*1000);return dt>=ago2&&dt<=now2;}).map(function(d){var dt=d.exDate?new Date(d.exDate):new Date(d.date*1000);return{month:dt.getMonth()+1,cashDiv:parseFloat(d.cashDiv||d.amount||0)};});
          var obj={code:etf.code,name:etf.name,price:price,yield:yld,type:etype,stability:stability,fillRate:fillRate,divCount:divs.length,divYears:Math.max(1,Math.round(moAge/12)),monthsOld:Math.round(moAge),divHistory:dh,priceDate:pd.date,market:etf.market};
          if(moAge<6){
            obj.potential=divs.slice(-3).length>=3&&divs.slice(-3).every(function(d){return calcAnnualYield([d],price)>=7;});
            // Store total div amount for annualized calc
            obj.totalDivAmt=divs.reduce(function(s,d){return s+parseFloat(d.cashDiv||d.amount||0);},0);
            obj.monthsOld=Math.round(moAge)||1;
            newEtf.push(obj);
          }
          else if(etype==='dividend')passed.dividend.push(obj);
          else if(etype==='bond')passed.bond.push(obj);
          else if(etype==='market')passed.market.push(obj);
          else passed.active.push(obj);
        }catch(e2){console.warn('[ETF]',etf.code,e2.message);}
        done++;
      }));
      setEtfStatus('已處理 '+done+' / '+tot+' 檔…',Math.round(done/tot*88)+8);
      await new Promise(function(r){setTimeout(r,150);});
    }
    function sortEtf(arr){return arr.sort(function(a,b){var sa=(a.stability||0)*0.4+Math.min((a.yield||0)*10,100)*0.4+(30-(a.price||30))/30*100*0.2;var sb=(b.stability||0)*0.4+Math.min((b.yield||0)*10,100)*0.4+(30-(b.price||30))/30*100*0.2;return sb-sa;});}
    sortEtf(passed.dividend);sortEtf(passed.bond);sortEtf(passed.market);sortEtf(passed.active);
    newEtf.sort(function(a,b){return(b.potential?1:0)-(a.potential?1:0)||(b.yield||0)-(a.yield||0);});
    var sd=new Date().toISOString();
    localStorage.setItem(ETF_SCAN_KEY,JSON.stringify(passed));localStorage.setItem(ETF_EXCL_KEY,JSON.stringify(excl));
    localStorage.setItem(ETF_NEW_KEY,JSON.stringify(newEtf));localStorage.setItem(ETF_DATE_KEY,sd);
    setEtfStatus('掃描完成',100);renderEtfResults(passed,sd);updateEtfHomeCounts(passed,newEtf);
  }catch(e){setEtfStatus('掃描失敗：'+e.message,0);}
  if(btn){btn.textContent='搜尋 全台掃描';btn.disabled=false;}
}
var _currentZone = null;

// ETF zone click helper - avoids quoting issues in onclick
var ETF_ZONES = ['dividend','bond','market','active','watchlist'];
function etfZoneClick(idx) { enterEtfZone(ETF_ZONES[idx]); }

function renderEtfResults(passed, scanDate) {
  var cards = document.getElementById('etf-zone-cards');
  if (!cards) return;
  var zones = [
    { key:'dividend', label:'\u9ad8\u80a1\u606f\u578b', color:'#ff7070', bg:'rgba(255,107,107,.12)', desc:'\u5e74\u5316\u6bbc\u5229\u7387\u22675%\u30fb\u586b\u606f\u7387\u226550%' },
    { key:'bond',     label:'\u50b5\u5238\u578b',   color:'#6ec6f0', bg:'rgba(110,198,240,.12)', desc:'\u5e74\u5316\u6bbc\u5229\u7387\u22673%\u30fb\u4f4e\u6ce2\u52d5' },
    { key:'market',   label:'\u5e02\u5024\u578b',   color:'#f5d87a', bg:'rgba(245,216,122,.12)', desc:'NAV\u6210\u9577\u22678%\u30fb\u8ffd\u8e64\u8aa4\u5dee\u4f4e' },
    { key:'active',   label:'\u4e3b\u52d5\u578b',   color:'#7bed9f', bg:'rgba(123,237,159,.12)', desc:'\u4e3b\u52d5\u64cd\u4f5c\u7b56\u7565 ETF' },
  ];
  var html = '', hasAny = false;
  zones.forEach(function(z) {
    var arr = passed[z.key] || [];
    if (!arr.length) return;
    hasAny = true;
    var topYield = arr[0] ? (arr[0].yield||0).toFixed(2) + '%' : '--';
    var cls = arr[0] ? stabilityClass(arr[0].stability||0) : 's-gray';
    var topStab = arr[0] ? (arr[0].stability||0) + '%' : '--';
    html += '<div class="etf-zone-card" style="border-color:'+z.color+';background:linear-gradient(135deg,'+z.bg+' 0%,var(--bg3) 100%);" onclick="enterEtfZone(\''+z.key+'\')">' +
      '<div class="etf-zone-card-left">' +
        '<div class="etf-zone-card-title" style="color:'+z.color+'">'+z.label+'</div>' +
        '<div class="etf-zone-card-meta">'+z.desc+'</div>' +
        '<div style="margin-top:8px;display:flex;gap:10px;align-items:center">' +
          '<span style="font-size:11px;color:var(--text3)">\u6700\u4f73\u6bbc\u5229</span>' +
          '<span style="font-size:14px;font-weight:700;color:'+z.color+'">'+topYield+'</span>' +
          '<span style="font-size:11px;color:var(--text3)">\u7a69\u5b9a\u6307\u6578</span>' +
          '<span class="etf-stability '+cls+'">'+topStab+'</span>' +
        '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-size:26px;font-weight:700;color:'+z.color+'">'+arr.length+'</div>' +
        '<div style="font-size:10px;color:var(--text3)">\u6a94\u901a\u904e</div>' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="'+z.color+'" stroke-width="2.5" stroke-linecap="round" style="margin-top:8px"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</div>' +
    '</div>';
  });
  var newEtf = JSON.parse(localStorage.getItem(ETF_NEW_KEY)||'[]');
  // Watchlist card
  var watchlist = JSON.parse(localStorage.getItem(ETF_WATCH_KEY)||'[]');
  if (watchlist.length > 0) {
    html += '<div class="etf-zone-card" style="border-color:#f5d87a;background:linear-gradient(135deg,rgba(245,216,122,.1) 0%,var(--bg3) 100%);" onclick="enterEtfZone(\'watchlist\')">' +
      '<div class="etf-zone-card-left">' +
        '<div class="etf-zone-card-title" style="color:#f5d87a">★ 自選清單</div>' +
        '<div class="etf-zone-card-meta">手動新增的觀察標的</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-size:26px;font-weight:700;color:#f5d87a">'+watchlist.length+'</div>' +
        '<div style="font-size:10px;color:#8ab4d4">檔自選</div>' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f5d87a" stroke-width="2.5" stroke-linecap="round" style="margin-top:8px"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</div>' +
    '</div>';
  }
  if (newEtf.length > 0) {
    html += '<div class="etf-zone-card" style="border-color:#a4b0be;" onclick="showScreen(\'etf-new\')">' +
      '<div class="etf-zone-card-left">' +
        '<div class="etf-zone-card-title" style="color:#a4b0be">\u65b0\u8208\u89c0\u5bdf</div>' +
        '<div class="etf-zone-card-meta">\u6210\u7acb\u672a\u6eff 6 \u500b\u6708</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-size:26px;font-weight:700;color:#a4b0be">'+newEtf.length+'</div>' +
        '<div style="font-size:10px;color:var(--text3)">\u6a94\u89c0\u5bdf\u4e2d</div>' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a4b0be" stroke-width="2.5" stroke-linecap="round" style="margin-top:8px"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</div>' +
    '</div>';
  }
  if (!hasAny) html = '<div class="etf-empty">\u7121\u7b26\u5408\u689d\u4ef6\u7684 ETF</div>';
  cards.innerHTML = html;
  var lu = document.getElementById('etf-last-update');
  if (lu && scanDate) lu.textContent = '\u4e0a\u6b21\u6383\u63cf\uff1a' + new Date(scanDate).toLocaleString('zh-TW');
}

function enterEtfZone(zoneKey) {
  console.log('[ETF] enterEtfZone called with:', zoneKey);
  var passed = JSON.parse(localStorage.getItem(ETF_SCAN_KEY)||'null');
  if (!passed) return;
  var labels = { dividend:'\u9ad8\u80a1\u606f\u578b', bond:'\u50b5\u5238\u578b', market:'\u5e02\u5024\u578b', active:'\u4e3b\u52d5\u578b' };
  var colors = { dividend:'#ff7070', bond:'#6ec6f0', market:'#f5d87a', active:'#7bed9f' };
  _currentZone = zoneKey;
  document.getElementById('etf-zone-title').textContent = labels[zoneKey] || zoneKey;
  var arr = passed[zoneKey] || [];
  var top = arr.slice(0,10), rest = arr.slice(10);
  var col = colors[zoneKey];
  var html = '<div style="padding:8px 0">';
  top.forEach(function(e){ html += renderEtfCard(e, col); });
  if (rest.length) {
    html += '<button class="etf-more-btn" onclick="toggleEtfMore(this,this.nextElementSibling)">\u25bc \u986f\u793a\u5176\u9918 '+rest.length+' \u6a94</button>';
    html += '<div style="display:none">'+rest.map(function(e){return renderEtfCard(e,col);}).join('')+'</div>';
  }
  html += '</div>';
  document.getElementById('etf-zone-body').innerHTML = html;
  showScreen('etf-zone');
}

async function refreshCurrentZone() {
  if (!_currentZone) return;
  var svg = document.querySelector('#screen-etf-zone .refresh-btn svg');
  if (svg) svg.classList.add('spinning');
  await refreshEtfPrices();
  enterEtfZone(_currentZone);
  if (svg) svg.classList.remove('spinning');
}
function getEtfTags(code, name) {
  name = name || '';
  var tags = [];
  // 產業屬性
  if (/科技|半導體|電子|技術|創新|機器人|AI|智慧|元宇宙|雲端|5G|通訊|網路|資安/.test(name))
    tags.push({ text:'科技', color:'#6ec6f0' });
  if (/金融|銀行|保險|券商/.test(name))
    tags.push({ text:'金融', color:'#f5d87a' });
  if (/醫療|生技|生命科學|藥/.test(name))
    tags.push({ text:'醫藥', color:'#7bed9f' });
  if (/房地產|REITs|不動產/.test(name))
    tags.push({ text:'房地產', color:'#ff9f43' });
  if (/緑能|電動車|清潔|永續|ESG/.test(name))
    tags.push({ text:'ESG', color:'#7bed9f' });
  if (/美國|美倫|美元|S&P|NASDAQ|FANG|S&P500/.test(name))
    tags.push({ text:'美股', color:'#6ec6f0' });
  if (/日本|日經|Nikkei|东證/.test(name))
    tags.push({ text:'日股', color:'#ff7070' });
  if (/中國|滅深|上證|中證|A股/.test(name))
    tags.push({ text:'中股', color:'#ff7070' });
  if (/全球|全天下|新興市場/.test(name))
    tags.push({ text:'全球', color:'#a4b0be' });
  // 配息頻率
  if (/月配|月息/.test(name) || /B$/i.test(code))
    tags.push({ text:'月配', color:'#ff9f43' });
  else if (/季配|季息/.test(name))
    tags.push({ text:'季配', color:'#ffd32a' });
  // 債券屬性
  if (/非投等|高收益/.test(name))
    tags.push({ text:'高收益債', color:'#ff7070' });
  else if (/投等級|公府債/.test(name))
    tags.push({ text:'投等級債', color:'#7bed9f' });
  return tags.slice(0, 3); // max 3 tags
}


function renderEtfCard(e, accentColor, inWatchlist) {
  var cls = stabilityClass(e.stability||0);
  var tmap = { dividend:'\u9ad8\u606f', bond:'\u50b5\u5238', market:'\u5e02\u5024', active:'\u4e3b\u52d5' };
  var yieldColor = accentColor || 'var(--success)';
  var wl = JSON.parse(localStorage.getItem(ETF_WATCH_KEY)||'[]');
  var isInWL = wl.some(function(w){ return w.code === e.code; });
  var wlBtn = '<button onclick="event.stopPropagation();toggleWatchlist(\'' + e.code + '\',this)" style="background:none;border:none;cursor:pointer;font-size:16px;color:'+(isInWL?'#f5d87a':'#a4b0be')+';padding:0 4px;flex-shrink:0">'+(isInWL?'\u2605':'\u2606')+'</button>';
  var tags = getEtfTags(e.code, e.name).map(function(t){
    return '<span style="font-size:9px;color:'+t.color+';background:rgba(255,255,255,.07);padding:1px 5px;border-radius:3px;">'+t.text+'</span>';
  }).join('');
  return '<div class="etf-card" onclick="toggleEtfCard(this)">' +
    '<div class="etf-card-top">' +
      '<span class="etf-card-code">'+e.code+'</span>' +
      '<span class="etf-card-name">'+(e.name||'')+'</span>' +
      '<span class="etf-card-price">$'+(e.price||0).toFixed(2)+'</span>' +
      wlBtn +
    '</div>' +
    '<div class="etf-card-mid">' +
      '<span class="etf-card-yield" style="color:'+yieldColor+'">'+(e.yield||0).toFixed(2)+'%</span>' +
      '<span class="etf-card-type">'+(tmap[e.type]||e.type)+'</span>' +
      (e.stability!=null?'<span class="etf-stability '+cls+'">'+(e.stability||0)+'%</span>':'') +
      tags +
    '</div>' +
    '<div class="etf-card-expand">'+renderEtfMiniChart(e)+'</div>' +
  '</div>';
}
function renderEtfMiniChart(e) {
  var divs = e.divHistory || [];
  if (!divs.length) return '<div style="font-size:11px;color:#b0c4de;padding:8px 0">\u7121\u914d\u606f\u8a18\u9304</div>';
  var mx = Math.max.apply(null, divs.map(function(d){ return d.cashDiv||0; }));
  if (mx <= 0) return '';
  var avg = divs.reduce(function(s,d){ return s+(d.cashDiv||0); },0) / divs.length;
  var n = divs.length;
  // Fixed coordinate space: each slot 40px wide, height 80px
  var slotW = 40, H = 80;
  var W = n * slotW;
  var PT = 6, PB = 26;
  var chartH = H - PT - PB;
  var gap = 3;
  var svgBars = '', svgLine = '', svgDots = '', svgLabels = '';
  var points = [];
  divs.forEach(function(d, idx) {
    var barH = mx > 0 ? Math.max((d.cashDiv||0) / mx * chartH, 0) : 0;
    var x = idx * slotW;
    var cx = x + slotW / 2;
    var barTop = PT + (chartH - barH);
    svgBars += '<rect x="'+(x+gap/2).toFixed(1)+'" y="'+barTop.toFixed(1)+
      '" width="'+(slotW-gap).toFixed(1)+'" height="'+barH.toFixed(1)+
      '" fill="#1e5fa8" rx="2"/>';
    svgLabels += '<text x="'+cx+'" y="'+(H-14)+
      '" text-anchor="middle" font-size="9" fill="#8ab4d4">'+d.month+'</text>';
    svgLabels += '<text x="'+cx+'" y="'+(H-3)+
      '" text-anchor="middle" font-size="8" fill="#b0c4de">'+
      (d.cashDiv>0.001?(d.cashDiv).toFixed(3):'')+'</text>';
    points.push([cx, barTop]);
  });
  var avgY = (PT + (chartH - avg/mx * chartH)).toFixed(1);
  var avgLine = '<line x1="0" y1="'+avgY+'" x2="'+W+'" y2="'+avgY+
    '" stroke="rgba(255,179,71,.45)" stroke-width="1" stroke-dasharray="4,2"/>';
  var pts = points.map(function(p){ return p[0]+','+p[1].toFixed(1); }).join(' ');
  svgLine = '<polyline points="'+pts+'" fill="none" stroke="#ffb347" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  points.forEach(function(p){
    svgDots += '<circle cx="'+p[0]+'" cy="'+p[1].toFixed(1)+'" r="3" fill="#ffb347" stroke="#0f1923" stroke-width="1.5"/>';
  });
  var label = '\u8fd1 '+n+' \u6b21\u914d\u606f\u3000\u5e73\u5747 $'+avg.toFixed(3);
  // Container scrolls horizontally if too wide; fixed height prevents distortion
  return '<div class="etf-chart-wrap">'+
    '<div class="etf-chart-label" style="margin-bottom:8px">'+label+'</div>'+
    '<div style="overflow-x:auto;-webkit-overflow-scrolling:touch">'+
      '<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" style="display:block;min-width:100%">'+
        svgBars + avgLine + svgLine + svgDots + svgLabels +
      '</svg>'+
    '</div>'+
  '</div>';
}
function toggleEtfCard(el){var e=el.querySelector('.etf-card-expand');if(e)e.classList.toggle('open');}
function toggleEtfMore(btn,container){if(container.style.display==='none'){container.style.display='block';btn.textContent='▲ 收起';}else{container.style.display='none';btn.textContent='▼ 顯示其餘 '+container.querySelectorAll('.etf-card').length+' 檔';}}
async function refreshEtfPrices(){
  var btn=document.getElementById('etf-price-refresh-btn'),svg=btn?btn.querySelector('svg'):null;
  if(svg)svg.classList.add('spinning');
  var passed=JSON.parse(localStorage.getItem(ETF_SCAN_KEY)||'null'); if(!passed){if(svg)svg.classList.remove('spinning');return;}
  var all=[].concat(passed.dividend||[],passed.bond||[],passed.market||[],passed.active||[]);
  for(var i=0;i<all.length;i++){try{var r=await fetch(GAS_URL+'?price='+encodeURIComponent(all[i].code)),d=await r.json();if(d.stat==='OK'){all[i].price=d.price;all[i].priceDate=d.date;if(all[i].divHistory&&all[i].divHistory.length){var td=all[i].divHistory.reduce(function(s,x){return s+(x.cashDiv||0);},0);all[i].yield=Math.round(td/d.price*100*10)/10;}}}catch(e3){}}
  localStorage.setItem(ETF_SCAN_KEY,JSON.stringify(passed));renderEtfResults(passed,localStorage.getItem(ETF_DATE_KEY));if(svg)svg.classList.remove('spinning');
}
async function rescanZone(zone) {
  var passed = JSON.parse(localStorage.getItem(ETF_SCAN_KEY)||'null');
  if (!passed) { alert('請先執行全台掃描'); return; }
  var labels = { dividend:'高息型', bond:'債券型' };
  if (!confirm('重新掃描 ' + (labels[zone]||zone) + '？此操作會清除該區的現有結果。')) return;
  
  var btn = event.target;
  var origText = btn.textContent;
  btn.textContent = '掃描中…';
  btn.disabled = true;
  setEtfStatus('重掃 ' + (labels[zone]||zone) + '…', 5);
  
  // Get ETF list for this zone only
  try {
    var lr = await fetch(GAS_URL + '?finmind_etflist=1');
    var ld = await lr.json();
    var etfList = (ld.list||[]).filter(function(e){
      return detectEtfType(e.code, e.name) === zone;
    });
    setEtfStatus('共 '+etfList.length+' 檔 '+labels[zone]+'，掃描中…', 10);
    
    var excl = JSON.parse(localStorage.getItem(ETF_EXCL_KEY)||'[]');
    var exclCodes = excl.map(function(e){ return e.code; });
    var newArr = [];
    var done = 0, tot = etfList.length;
    
    for (var i = 0; i < etfList.length; i += 3) {
      var batch = etfList.slice(i, i+3);
      await Promise.all(batch.map(async function(etf) {
        try {
          if (exclCodes.indexOf(etf.code) >= 0) { done++; return; }
          var pr = await fetch(GAS_URL + '?price=' + encodeURIComponent(etf.code));
          var pd = await pr.json();
          var price = pd.stat === 'OK' ? pd.price : null;
          if (!price || price > 30) { done++; return; }
          var dr = await fetch(GAS_URL + '?code=' + encodeURIComponent(etf.code));
          var dd = await dr.json();
          var divs = dd.dividends || [];
          if (!divs.length) { done++; return; }
          var yld = calcAnnualYield(divs, price);
          if (zone === 'dividend' && yld < 5) { done++; return; }
          if (zone === 'bond' && yld < 3) { done++; return; }
          var fd = divs[0], fdDate = fd ? (fd.exDate ? new Date(fd.exDate) : new Date(fd.date*1000)) : null;
          var moAge = fdDate ? (new Date()-fdDate)/(1000*60*60*24*30) : 999;
          var recD = divs.filter(function(d){ var dt=d.exDate?new Date(d.exDate):new Date(d.date*1000); return dt>=new Date(new Date().getFullYear()-3,0,1); });
          var hasPayData = recD.some(function(d){ return d.payDate; });
          var fillRate = !hasPayData ? 75 : (recD.length>0?Math.round(recD.filter(function(d){return d.payDate;}).length/recD.length*100):75);
          var stability = calcStability(zone, fillRate, yld, Math.max(1,Math.round(moAge/12)));
          var now2=new Date(), ago2=new Date(now2.getFullYear()-1,now2.getMonth(),now2.getDate());
          var dh = divs.filter(function(d){ var dt=d.exDate?new Date(d.exDate):new Date(d.date*1000); return dt>=ago2&&dt<=now2; }).map(function(d){ var dt=d.exDate?new Date(d.exDate):new Date(d.date*1000); return{month:dt.getMonth()+1,cashDiv:parseFloat(d.cashDiv||d.amount||0)};});
          newArr.push({ code:etf.code, name:etf.name, price:price, yield:yld, type:zone, stability:stability, fillRate:fillRate, divCount:divs.length, divYears:Math.max(1,Math.round(moAge/12)), monthsOld:Math.round(moAge), divHistory:dh, priceDate:pd.date, market:etf.market });
        } catch(e2) {}
        done++;
      }));
      setEtfStatus('已處理 '+done+'/'+tot+'…', Math.round(done/tot*88)+10);
      await new Promise(function(r){ setTimeout(r,150); });
    }
    
    // Sort and update
    newArr.sort(function(a,b){ var sa=(a.stability||0)*0.4+Math.min((a.yield||0)*10,100)*0.4+(30-(a.price||30))/30*100*0.2; var sb=(b.stability||0)*0.4+Math.min((b.yield||0)*10,100)*0.4+(30-(b.price||30))/30*100*0.2; return sb-sa; });
    passed[zone] = newArr;
    var sd = new Date().toISOString();
    localStorage.setItem(ETF_SCAN_KEY, JSON.stringify(passed));
    localStorage.setItem(ETF_DATE_KEY, sd);
    setEtfStatus('重掃完成！共 '+newArr.length+' 檔通過', 100);
    renderEtfResults(passed, sd);
    updateEtfHomeCounts(passed, JSON.parse(localStorage.getItem(ETF_NEW_KEY)||'[]'));
  } catch(e) {
    setEtfStatus('失敗：'+e.message, 0);
  }
  btn.textContent = origText;
  btn.disabled = false;
}
function showEtfExcluded(){
  var excl=JSON.parse(localStorage.getItem(ETF_EXCL_KEY)||'[]'),c=document.getElementById('etf-zone-cards');
  var h='<div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:13px;font-weight:600">已排除（'+excl.length+' 檔）</span><div style="display:flex;gap:12px"><button onclick="clearEtfExcluded()" style="font-size:12px;color:#ff7070;background:none;border:none;cursor:pointer">清除全部</button><button onclick="loadEtfCache()" style="font-size:12px;color:var(--accent);background:none;border:none;cursor:pointer">← 返回</button></div></div>';
  excl.forEach(function(e){h+='<div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center"><div><span style="font-size:13px;font-weight:600">'+e.code+'</span><span style="font-size:12px;color:var(--text2);margin-left:8px">'+(e.name||'')+'</span></div><span style="font-size:11px;color:var(--text3);max-width:120px;text-align:right">'+(e.reason||'')+'</span></div>';});
  if(!excl.length) h+='<div class="etf-empty">無排除紀錄</div>';
  c.innerHTML=h;
}
function loadEtfCache(){
  var passed=JSON.parse(localStorage.getItem(ETF_SCAN_KEY)||'null'),sd=localStorage.getItem(ETF_DATE_KEY);
  if(!passed){var _zc2=document.getElementById('etf-zone-cards');if(_zc2)_zc2.innerHTML='<div class="etf-empty">尚無資料<br>請點「搜尋全台掃描」開始</div>';return;}
  renderEtfResults(passed,sd);updateEtfHomeCounts(passed,JSON.parse(localStorage.getItem(ETF_NEW_KEY)||'[]'));
}
function renderEtfNew(){
  var newEtf=JSON.parse(localStorage.getItem(ETF_NEW_KEY)||'[]');
  var c=document.getElementById('etf-new-content');
  if(!c) return;
  if(!newEtf.length){c.innerHTML='<div class="etf-empty">\u5c1a\u7121\u8cc7\u6599<br>\u8acb\u5148\u57f7\u884c\u5168\u53f0\u6383\u63cf</div>';return;}
  c.innerHTML=newEtf.map(function(e){
    var price=e.price||0;
    var months=e.monthsOld||1;
    var totalDiv=e.totalDivAmt||0;
    var divCount=e.divCount||0;
    // \u5df2\u767c\u6bbc\u5229\u7387 = \u5df2\u767c\u914d\u606f\u7e3d\u984d / \u73fe\u50f9
    var actualYield=price>0&&totalDiv?(totalDiv/price*100):0;
    // \u5e74\u5316\u4f30\u7b97 = \u5df2\u767c\u914d\u606f / \u6708\u6578 * 12 / \u73fe\u50f9
    var annualYield=price>0&&totalDiv&&months>0?(totalDiv/months*12/price*100):0;
    var freqLabel=months>0&&divCount>0?'\u6bcf '+(months/divCount).toFixed(1)+' \u6708\u914d\u606f 1 \u6b21':'';
    return '<div class="etf-card">'+
      '<div class="etf-card-top">'+
        (e.potential?'<span style="font-size:10px;background:#ff6b6b;color:#000;padding:1px 5px;border-radius:3px;margin-right:4px">\u6f5b\u529b</span>':'')+
        '<span class="etf-card-code">'+e.code+'</span>'+
        '<span class="etf-card-name">'+(e.name||'')+'</span>'+
        '<span class="etf-card-price">$'+price.toFixed(2)+'</span>'+
      '</div>'+
      '<div class="etf-card-mid">'+
        '<span style="font-size:10px;color:var(--text3);background:var(--bg4);padding:2px 6px;border-radius:4px">\u89c0\u5bdf\u4e2d</span>'+
        '<span style="font-size:11px;color:#8ab4d4">\u914d\u606f '+divCount+' \u6b21 / '+months+' \u6708</span>'+
        (freqLabel?'<span style="font-size:10px;color:var(--text3)">'+freqLabel+'</span>':'')+
      '</div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">'+
        '<div>'+
          '<div style="font-size:10px;color:#8ab4d4;margin-bottom:2px">\u5df2\u767c\u6bbc\u5229\u7387</div>'+
          '<div style="font-size:14px;font-weight:700;color:var(--success)">'+actualYield.toFixed(2)+'%</div>'+
          '<div style="font-size:9px;color:var(--text3)">\u5df2\u767c\u7e3d\u984d\u00f7\u73fe\u50f9</div>'+
        '</div>'+
        '<div>'+
          '<div style="font-size:10px;color:#8ab4d4;margin-bottom:2px">\u5e74\u5316\u4f30\u7b97</div>'+
          '<div style="font-size:14px;font-weight:700;color:#f5d87a">'+(annualYield>0?annualYield.toFixed(2)+'%':'\u2014')+'</div>'+
          '<div style="font-size:9px;color:var(--text3)">\u4f9d '+months+' \u6708\u5c55\u5ef6\u6210 12 \u6708</div>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
}
async function scanNewEtf(){alert('請先執行全台掃描，新興 ETF 會自動分類');}
function clearEtfExcluded(){
  if(!confirm('確定清除所有排除紀錄？下次掃描時會重新評估這些 ETF。')) return;
  localStorage.removeItem(ETF_EXCL_KEY);
  // 同時清除掃描結果，強制重新全掃
  localStorage.removeItem(ETF_SCAN_KEY);
  localStorage.removeItem(ETF_DATE_KEY);
  alert('排除清單已清除。請重新執行「全台掃描」。');
  loadEtfCache();
}

