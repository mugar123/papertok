const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  // Navigate to a blank page on mugar123.github.io to bypass origin blocks
  await page.goto('https://mugar123.github.io');
  
  const result = await page.evaluate(async () => {
    try {
      const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent('http://export.arxiv.org/api/query?search_query=all:electron&start=0&max_results=1')}`;
      const response = await fetch(proxyUrl);
      const text = await response.text();
      return text.substring(0, 200);
    } catch (e) {
      return 'Error: ' + e.message;
    }
  });
  
  console.log(result);
  await browser.close();
})();
