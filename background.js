/**
 * background.js  (Manifest V3 Service Worker)
 *
 * 負責：
 *  1. 安裝/更新時建立預設設定
 *  2. 透過 chrome.alarms 定時觸發爬取
 *  3. 開啟/重整目標頁籤，注入 content.js 取得商品資料
 *  4. 將結果存入 chrome.storage.local
 *  5. 有可購買商品時發送桌面通知
 */

const TARGET_URL = 'https://shop.funbox.com.tw/categories/XI/KB';
const ALARM_NAME = 'funbox-check';

// ── 安裝時初始化預設值 ──────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['intervalMin', 'products', 'lastChecked'], (data) => {
    if (!data.intervalMin) {
      chrome.storage.local.set({ intervalMin: 3, products: [], lastChecked: null });
    }
    scheduleAlarm(data.intervalMin || 3);
  });
});

// ── 每次 Service Worker 啟動時重新建立 alarm（SW 可能被終止）─
chrome.storage.local.get(['intervalMin'], (data) => {
  scheduleAlarm(data.intervalMin || 3);
});

// ── 設定 alarm ──────────────────────────────────────────────
function scheduleAlarm(intervalMin) {
  chrome.alarms.clear(ALARM_NAME, () => {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: intervalMin,
      periodInMinutes: intervalMin
    });
  });
}

// ── Alarm 觸發：執行爬取 ──────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    // 暫停中則日志忽略，不執行爬取
    chrome.storage.local.get(['paused'], (data) => {
      if (!data.paused) runScrape();
    });
  }
});

// ── 接收來自 popup 的訊息 ──────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'scrapeNow') {
    runScrape().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // 非同步回應
  }
  if (msg.action === 'setInterval') {
    chrome.storage.local.set({ intervalMin: msg.value });
    scheduleAlarm(msg.value);
    sendResponse({ ok: true });
  }
  if (msg.action === 'setPaused') {
    chrome.storage.local.set({ paused: msg.value });
    sendResponse({ ok: true });
  }
});

// ── 核心爬取流程 ────────────────────────────────────────────
async function runScrape() {
  // 1. 尋找已開啟的目標頁籤，或新開一個
  const existingTabs = await chrome.tabs.query({ url: TARGET_URL + '*' });
  let tab;

  if (existingTabs.length > 0) {
    tab = existingTabs[0];
    // 重新整理頁面確保資料是最新的
    await chrome.tabs.reload(tab.id);
  } else {
    tab = await chrome.tabs.create({ url: TARGET_URL, active: false });
  }

  // 2. 等待頁面載入完成
  await waitForTabLoad(tab.id);

  // 3. 額外等待 3 秒讓前端 JS 渲染商品卡片
  await delay(3000);

  // 4. 注入 content.js 並取得結果
  let products = [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    products = results[0]?.result ?? [];
  } catch (err) {
    console.error('[FunBoxBugger] executeScript 失敗:', err);
  }

  // 5. 儲存結果
  const lastChecked = new Date().toISOString();
  await chrome.storage.local.set({ products, lastChecked });

  // 6. 判斷是否有可購買商品
  const buyable = products.filter(p => {
    if (p.price === '未顯示價格') return false;
    const n = parseInt(p.price.replace(/,/g, ''), 10);
    return !isNaN(n) && n > 0 && n < 999999;
  });

  if (buyable.length > 0) {
    chrome.notifications.create('funbox-alert-' + Date.now(), {
      type: 'list',
      iconUrl: 'icons/icon128.png',
      title: `🎯 FunBox 有 ${buyable.length} 件商品可購買！`,
      message: '',
      items: buyable.slice(0, 5).map(p => ({
        title: p.title.slice(0, 30),
        message: `$${p.price}`
      }))
    });
  }
}

// ── 等待頁籤載入完成（Promise 包裝）───────────────────────
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
