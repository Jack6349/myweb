// 股利總管 Web — 持股分類（全站共用）
// 尾碼決定結構（個股 / 主動 / 債券 / 槓反），名稱決定策略（高息 / 非投等 / 投等 / 公債）。
// 名稱來源 _contracts[code].name 最長 8 字會被截斷（「非投等債」實際只抓得到「非投」），
// 所以關鍵字都取短前綴，不比對完整詞。
var CAT_HY   = /高息|高股息|高配息|優利|高填息/;   // 高股息策略
var CAT_JUNK = /非投|高收/;                        // 非投資等級
var CAT_IG   = /投等|公司債|金融債|BBB/;            // 投資等級
var CAT_GOV  = /美債|公債|國債/;                        // 公債

function getCategory(symbol, name) {
  symbol = String(symbol); name = String(name || '');
  if (/^\d{4}$/.test(symbol)) return '股票';                // 個股：4 碼純數字
  if (/[LR]$/.test(symbol)) return '槓桿反向';           // L＝正向倍數、R＝反向（風險屬性獨立，不併入市值型）

  // 債券：B＝被動、D＝主動；投等/非投等/公債由名稱判定，尾碼不帶這個資訊
  if (/[BD]$/.test(symbol)) {
    var act = /D$/.test(symbol) ? '主動' : '';
    if (CAT_JUNK.test(name)) return act + '非投債';
    if (CAT_IG.test(name))   return act + '投等債';
    if (CAT_GOV.test(name))  return act + '公債';
    return act + '其他債';                               // 關鍵字全沒中 → 標示未知，不猜
  }

  var hy = CAT_HY.test(name);
  if (/A$/.test(symbol)) return hy ? '主動高息' : '主動市值';   // A＝主動股票型
  if (/^00\d+$/.test(symbol)) return hy ? '高息型' : '市值型';  // 無尾碼＝被動股票型
  return '其他';                                           // 未知代碼型態
}

// 以 _contracts 的名稱查分類（呼叫端不用自己取名稱）
function catOf(code) {
  code = String(code);
  var c = (typeof _contracts !== 'undefined' && _contracts[code]) || null;
  return getCategory(code, c && c.name);
}

// 顯示順序：股票型 → 債券型 → 個股/其他（未列入的排在後面，依名稱）
var CAT_ORDER = ['市值型', '高息型', '主動市值', '主動高息',
  '公債', '主動公債', '投等債', '主動投等債', '非投債', '主動非投債',
  '其他債', '主動其他債', '槓桿反向', '股票', '其他'];
function catSortKey(name) {
  var i = CAT_ORDER.indexOf(name);
  return i < 0 ? CAT_ORDER.length : i;
}

// 依分類汇總持股：回傳 [{cat, cost, val, n}]（依 CAT_ORDER 排序）。
// cost＝付出成本（p.price × 股數）、val＝現值（現價 × 股數，未扣稅費），
// 與庫存表「付出成本」「現值」兩欄同基準，占比才能和「現值比」對得起來。
function catAggregate(positions) {
  var map = {};
  (positions || []).forEach(function (p) {
    var code = String(p.code), cat = catOf(code);
    var r = (typeof _rows !== 'undefined') && _rows[code];
    var price = (r && r.close != null) ? r.close : (p.last_price != null ? p.last_price : null);
    var g = map[cat] || (map[cat] = { cat: cat, cost: 0, val: 0, n: 0 });
    g.cost += p.price * p.quantity;
    if (price != null) g.val += price * p.quantity;
    g.n++;
  });
  return Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return catSortKey(a.cat) - catSortKey(b.cat) || a.cat.localeCompare(b.cat); });
}
