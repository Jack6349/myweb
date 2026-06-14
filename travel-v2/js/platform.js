/* travel-v2 prototype — Platform / Capabilities 橫切服務（跨裝置能力）
 * 原則：以「自動」為主——能力偵測（feature detection，非 User-Agent 字串）+ 通用連結（OS 自動路由）+ 優雅降級；
 *       「切換」僅作為使用者偏好的例外（放使用者設定）。
 * 本檔為薄佔位：對外提供能力旗標與通用連結建構；UI 依旗標選動作、一律有通用 fallback。
 * 第二階段補真實實作（相機 getUserMedia、原生分享、地圖深連結等），上層不需改。
 */
const Platform = (() => {
  // 能力偵測（偵測「能不能」，不偵測「是不是手機」）
  const has = {
    camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), // webcam/相機串流
    share: typeof navigator.share === 'function',                              // 原生分享
    geolocation: 'geolocation' in navigator,                                   // 定位
    coarsePointer: window.matchMedia && window.matchMedia('(pointer: coarse)').matches, // 觸控為主（多為手機/平板）
  };

  // 通用連結：一份寫法，手機深連結 App、PC 開網頁，由 OS 自動路由
  function mapUrl(query) { return `https://www.google.com/maps?q=${encodeURIComponent(query)}`; }
  function dirUrl(destination) { return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`; }

  // 由站點 place 物件產生地圖連結：優先吃座標 → placeId → 名稱（語言無關，避免誤判）
  function placeUrl(place) {
    if (!place) return null;
    if (place.lat != null && place.lng != null) return `https://www.google.com/maps?q=${place.lat},${place.lng}`;
    if (place.placeId) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place.mapName || '')}&query_place_id=${place.placeId}`;
    return mapUrl(place.mapName || place.name || '');
  }

  // 分享：有 Web Share 用之，否則退回「複製連結」
  async function share(data) {
    if (has.share) { try { await navigator.share(data); return 'shared'; } catch (e) { return false; } }
    try { await navigator.clipboard.writeText(data.url || data.text || ''); return 'copied'; } catch (e) { return false; }
  }

  return { has, mapUrl, dirUrl, placeUrl, share };
})();
