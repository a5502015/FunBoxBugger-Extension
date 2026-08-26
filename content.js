/**
 * content.js
 * 注入至 shop.funbox.com.tw 商品頁面，萃取商品卡片資料後回傳。
 * 由 background.js 透過 chrome.scripting.executeScript 呼叫。
 */
(function () {
  const productList = [];

  // 選取所有商品卡片容器
  const cards = document.querySelectorAll('.funbox-products .funcbox-product');

  cards.forEach(card => {
    const el = card.querySelector('a.productClick');
    if (el) {
      const title = el.getAttribute('data-name');
      const price = el.getAttribute('data-price');
      const relativeUrl = el.getAttribute('href');

      if (title) {
        productList.push({
          title: title.trim(),
          price: price ? price.trim() : '未顯示價格',
          url: relativeUrl
            ? (relativeUrl.startsWith('http')
              ? relativeUrl
              : 'https://shop.funbox.com.tw' + relativeUrl)
            : ''
        });
      }
    }
  });

  return productList;
})();
