/* travel-v2 prototype — UsageStats 使用統計服務（MFU 自適應排序）
 * 記錄各選項被選用的次數，提供「依點擊頻率自動排序」的清單，用於：
 * 費用分類、幣別、付款方式…（未來可擴及首頁卡片排序）。
 * 純前端：localStorage 持久化，不接後端。
 * 第二階段可改為依使用者帳號儲存於雲端，介面不變。
 */
const UsageStats = (() => {
  const KEY = 'tv2-usage';
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }

  // 某 namespace 下，key 被選用 +1
  function bump(ns, key) {
    const o = load(); o[ns] = o[ns] || {}; o[ns][key] = (o[ns][key] || 0) + 1; save(o);
  }
  function counts(ns) { return load()[ns] || {}; }

  // 依「點擊次數 desc → allKeys 原序（種子預設序）」回傳排序後的 key 陣列
  function ordered(ns, allKeys) {
    const c = counts(ns);
    return [...allKeys].sort((a, b) =>
      (c[b] || 0) - (c[a] || 0) || allKeys.indexOf(a) - allKeys.indexOf(b));
  }
  return { bump, counts, ordered };
})();
