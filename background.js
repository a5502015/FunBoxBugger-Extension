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
const BUYABLE_PRODUCT_KEYS_STORAGE_KEY = 'buyableProductKeys';
let scrapeInProgress = null;

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
      if (!data.paused) {
        runScrape().catch(err => {
          console.error('[FunBoxBugger] 排程抓取失敗:', err);
        });
      }
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
function runScrape() {
  if (scrapeInProgress) {
    console.debug('[FunBoxBugger] 抓取已在進行中，沿用既有流程。');
    return scrapeInProgress;
  }

  scrapeInProgress = runScrapeOnce().finally(() => {
    scrapeInProgress = null;
  });

  return scrapeInProgress;
}

async function runScrapeOnce() {
  // 1. 一律建立專用的背景頁籤，避免重整或關閉使用者自行開啟的頁面
  const tab = await chrome.tabs.create({ url: TARGET_URL, active: false });

  try {
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

    // 5. 判斷可購買商品，並找出本次新增的可購買項目
    const lastChecked = new Date().toISOString();
    const buyable = products.filter(p => {
      if (p.price === '未顯示價格') return false;
      const n = parseInt(p.price.replace(/,/g, ''), 10);
      return !isNaN(n) && n > 0 && n < 999999;
    });

    const previousData = await chrome.storage.local.get(BUYABLE_PRODUCT_KEYS_STORAGE_KEY);
    const previousKeys = new Set(
      Array.isArray(previousData[BUYABLE_PRODUCT_KEYS_STORAGE_KEY])
        ? previousData[BUYABLE_PRODUCT_KEYS_STORAGE_KEY]
        : []
    );
    const currentBuyableByKey = new Map();

    buyable.forEach(product => {
      const key = getProductKey(product);
      if (!currentBuyableByKey.has(key)) currentBuyableByKey.set(key, product);
    });

    const newlyBuyable = [...currentBuyableByKey]
      .filter(([key]) => !previousKeys.has(key))
      .map(([, product]) => product);

    // 6. 儲存結果與目前可購買狀態；商品下架後會從這份狀態移除。
    await chrome.storage.local.set({
      products,
      lastChecked,
      [BUYABLE_PRODUCT_KEYS_STORAGE_KEY]: [...currentBuyableByKey.keys()]
    });

    if (newlyBuyable.length > 0) {
      chrome.notifications.create('funbox-alert-' + Date.now(), {
        type: 'list',
        iconUrl: 'icons/icon128.png',
        title: `🎯 FunBox 有 ${newlyBuyable.length} 件商品可購買！`,
        message: '',
        items: newlyBuyable.slice(0, 5).map(p => ({
          title: p.title.slice(0, 30),
          message: `$${p.price}`
        }))
      });
    }
  } finally {
    // 僅清理由本次監測建立的專用頁籤；若它已被關閉則忽略錯誤。
    try {
      await chrome.tabs.remove(tab.id);
    } catch (err) {
      console.debug('[FunBoxBugger] 專用頁籤已關閉:', err);
    }
  }
}

// ── 等待頁籤載入完成（含已完成檢查與逾時保護）──────────────
function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        complete();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    timeoutId = setTimeout(() => {
      fail(new Error(`頁籤載入逾時（${timeoutMs / 1000} 秒）`));
    }, timeoutMs);

    // 監聽器註冊後再確認目前狀態，補捉在 create 後已完成載入的情況。
    chrome.tabs.get(tabId)
      .then(tab => {
        if (tab.status === 'complete') complete();
      })
      .catch(fail);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getProductKey(product) {
  return product.url || product.title;
}
