/* travel-v2 prototype — 班表庫 / 站點別名比對服務（第八節橫切服務之一）
 * 全域共用、不分日期；安排行程時依「站點名稱」（正規化＋別名表＋模糊比對）篩選候選班次。
 * Prototype：僅貼上 JSON 解析（不呼叫 AI）；別名表可手動 CRUD 修正 AI 翻譯偏差。
 */
const Timetable = (() => {
  // 正規化：去除常見站名後綴（站/驛/Station/駅）、去空白、轉小寫，供跨語系比對
  function normalize(name) {
    return (name || '')
      .trim()
      .replace(/(駅|站|Station|station)$/i, '')
      .trim()
      .toLowerCase();
  }

  // 名稱 → canonical（查別名表；查無則以正規化後名稱本身為 canonical）
  function canonicalOf(name) {
    const n = normalize(name);
    for (const a of Repo.stationAliases()) {
      if (normalize(a.canonical) === n) return a.canonical;
      if (a.aliases.some(x => normalize(x) === n)) return a.canonical;
    }
    return n;
  }

  // 依起訖站名找候選班次：先 canonical 精確比對，查無則模糊（包含）比對並標記 fuzzy
  function findCandidates(fromName, toName) {
    const fc = canonicalOf(fromName), tc = canonicalOf(toName);
    const exact = Repo.timetableEntries().filter(e =>
      canonicalOf(e.fromStation) === fc && canonicalOf(e.toStation) === tc);
    if (exact.length) return { fuzzy: false, entries: exact };

    const fn = normalize(fromName), tn = normalize(toName);
    const loose = Repo.timetableEntries().filter(e => {
      const ef = normalize(e.fromStation), et = normalize(e.toStation);
      const fHit = ef.includes(fn) || fn.includes(ef);
      const tHit = et.includes(tn) || tn.includes(et);
      return fHit && tHit;
    });
    return { fuzzy: true, entries: loose };
  }

  // 解析使用者貼上的 JSON（格式同附件範例：{ routes: [{ legs: [...] , ... }] }）
  // 攤平：每個 route = 一筆 entry；line/train 取首段；fromStation/Time 取首段、toStation/Time 取末段
  function parseImportJson(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('JSON 格式錯誤，請確認貼上的內容'); }
    const routes = Array.isArray(data) ? data : (data.routes || []);
    if (!routes.length) throw new Error('找不到可匯入的班次（routes 為空）');

    return routes.map((r, idx) => {
      const legs = r.legs || [];
      const first = legs[0] || {};
      const last = legs[legs.length - 1] || first;
      const lineName = first.line_name || '';
      const mode = /新幹線|shinkansen/i.test(lineName) ? 'shinkansen'
        : /巴士|バス|bus/i.test(lineName) ? 'bus'
        : 'train';
      return {
        id: 'tt-' + Date.now() + '-' + idx,
        mode,
        line: lineName,
        train: first.train_name || '',
        fromStation: first.departure_station || '',
        fromTime: first.departure_time ?? r.departure_time,
        toStation: last.arrival_station || '',
        toTime: last.arrival_time ?? r.arrival_time,
        transfers: legs.map(l => ({
          line: l.line_name, train: l.train_name,
          fromStation: l.departure_station, fromTime: l.departure_time,
          toStation: l.arrival_station, toTime: l.arrival_time,
        })),
        fare: r.fare,
        raw: r,
      };
    });
  }

  return { normalize, canonicalOf, findCandidates, parseImportJson };
})();
