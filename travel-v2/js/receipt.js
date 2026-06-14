/* travel-v2 prototype — ReceiptScanService（收據辨識服務介面）
 * 介面：scan(image) ⟶ Promise<ExtractedExpense>
 *   ExtractedExpense { category, note, amount, currency, payMethod, merchant, date, confidence{欄位:0~1} }
 *
 * 本檔為 MockReceiptService：回傳假擷取結果（模擬 OCR+翻譯+欄位擷取），用於驗證動線。
 * 第二階段以同介面替換為 VisionLLMReceiptService（雲端視覺 LLM）或 OnDeviceOcrService，上層 UI 不需改。
 */
const ReceiptScanService = (() => {
  // 模擬日文收據；note 已「翻譯」為中文，merchant 保留原文，以示翻譯流程。
  const SAMPLES = [
    { merchant: 'スターバックス', category: '餐飲', note: '拿鐵咖啡', amount: 680,   currency: 'JPY', payMethod: '信用卡',
      confidence: { category: 0.92, amount: 0.97, currency: 0.99, payMethod: 0.55, note: 0.8 } },
    { merchant: 'ビックカメラ',   category: '購物', note: '相機配件', amount: 15800, currency: 'JPY', payMethod: '信用卡',
      confidence: { category: 0.88, amount: 0.95, currency: 0.99, payMethod: 0.9, note: 0.5 } },
    { merchant: 'JR東日本',       category: '交通', note: '車票',     amount: 1320,  currency: 'JPY', payMethod: 'IC卡',
      confidence: { category: 0.93, amount: 0.9, currency: 0.99, payMethod: 0.7, note: 0.85 } },
    { merchant: 'マツモトキヨシ', category: '購物', note: '藥妝',     amount: 6230,  currency: 'JPY', payMethod: '現金',
      confidence: { category: 0.9, amount: 0.96, currency: 0.99, payMethod: 0.6, note: 0.7 },
      items: [
        { name: '防曬乳',   amount: 980 },
        { name: '感冒藥',   amount: 1200 },
        { name: '面膜',     amount: 850 },
        { name: '護手霜',   amount: 600 },
        { name: '洗髮精',   amount: 750 },
        { name: '彩妝組',   amount: 1850 },
      ] },
  ];
  let idx = 0;

  // 模擬非同步辨識（含網路/運算延遲）。image 參數本階段忽略。
  function scan(/* image */) {
    return new Promise((resolve) => {
      setTimeout(() => {
        const s = JSON.parse(JSON.stringify(SAMPLES[idx % SAMPLES.length]));
        idx++;
        resolve(s);
      }, 900);
    });
  }
  return { scan };
})();
