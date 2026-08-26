/**
 * popup.js
 * 處理 Popup UI 的互動、從 storage 讀取商品資料並渲染。
 */

const btnScrape    = document.getElementById('btnScrape');
const btnPause     = document.getElementById('btnPause');
const intervalInput = document.getElementById('intervalInput');
const logArea      = document.getElementById('logArea');
const productCount = document.getElementById('productCount');
const lastChecked  = document.getElementById('lastChecked');
const alertBanner  = document.getElementById('alertBanner');
const alertText    = document.getElementById('alertText');
const statusDot    = document.getElementById('statusDot');
const statusLabel  = document.getElementById('statusLabel');

// ── 初始化：讀取上次結果與設定 ──────────────────────
chrome.storage.local.get(['products', 'lastChecked', 'intervalMin', 'paused'], (data) => {
  if (data.intervalMin) intervalInput.value = data.intervalMin;
  applyPausedState(data.paused || false);
  renderProducts(data.products || [], data.lastChecked);
});

// ── 監聴 storage 變化（background 爬完會更新）────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.products || changes.lastChecked) {
    chrome.storage.local.get(['products', 'lastChecked'], (data) => {
      renderProducts(data.products || [], data.lastChecked);
    });
  }
  if (changes.paused) {
    applyPausedState(changes.paused.newValue);
  }
});

// ── 暫停 / 恢復 ───────────────────────────────
btnPause.addEventListener('click', () => {
  chrome.storage.local.get(['paused'], (data) => {
    const nowPaused = !data.paused;
    chrome.runtime.sendMessage({ action: 'setPaused', value: nowPaused });
  });
});

// ── 立即抓取 ──────────────────────────────────────────────
btnScrape.addEventListener('click', () => {
  btnScrape.disabled = true;
  btnScrape.textContent = '抓取中…';

  chrome.runtime.sendMessage({ action: 'scrapeNow' }, () => {
    btnScrape.disabled = false;
    btnScrape.textContent = '立即抓取';
  });
});

// ── 間隔設定變更 ──────────────────────────────────────────
intervalInput.addEventListener('change', () => {
  const val = Math.max(1, Math.min(60, parseInt(intervalInput.value) || 3));
  intervalInput.value = val;
  chrome.runtime.sendMessage({ action: 'setInterval', value: val });
});

// ── 套用暫停/恢復 UI 狀態 ─────────────────────────
function applyPausedState(paused) {
  if (paused) {
    btnPause.textContent = '▶️ 恢復';
    btnPause.classList.add('active');
    btnScrape.disabled = true;
    statusDot.classList.add('paused');
    statusLabel.classList.add('paused');
    statusLabel.textContent = '已暫停';
    statusDot.title = '已暫停';
  } else {
    btnPause.textContent = '⏸ 暫停';
    btnPause.classList.remove('active');
    btnScrape.disabled = false;
    statusDot.classList.remove('paused');
    statusLabel.classList.remove('paused');
    statusLabel.textContent = '監測中';
    statusDot.title = '監測中';
  }
}

// ── 渲染商品清單 ──────────────────────────────────────────
function renderProducts(products, checkedAt) {
  // 更新統計列
  productCount.textContent = products.length;
  if (checkedAt) {
    const d = new Date(checkedAt);
    lastChecked.textContent = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // 判斷可購買商品
  const buyable = products.filter(p => {
    if (p.price === '未顯示價格') return false;
    const n = parseInt(p.price.replace(/,/g, ''), 10);
    return !isNaN(n) && n > 0 && n < 999999;
  });

  // Alert banner
  if (buyable.length > 0) {
    alertBanner.classList.add('show');
    alertText.textContent = `發現 ${buyable.length} 件可購買商品！`;
  } else {
    alertBanner.classList.remove('show');
  }

  // 商品卡片
  if (products.length === 0) {
    logArea.innerHTML = `
      <div class="log-empty">
        <span class="icon">🔍</span>
        點擊「立即抓取」<br>或等候自動排程觸發
      </div>`;
    return;
  }

  logArea.innerHTML = products.map(p => {
    const isBuyable = buyable.includes(p);
    const priceClass = p.price === '未顯示價格' ? 'price no-price' : 'price';
    const priceText  = p.price === '未顯示價格' ? '無定價' : `$${p.price}`;
    return `
      <div class="product-card ${isBuyable ? 'buyable' : ''}">
        <div class="product-title" title="${esc(p.title)}">${esc(p.title)}</div>
        <div class="product-meta">
          <span class="${priceClass}">${priceText}</span>
          ${p.url ? `<a class="product-link" href="${esc(p.url)}" target="_blank">開啟頁面 ↗</a>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── 簡易 HTML escape ──────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
