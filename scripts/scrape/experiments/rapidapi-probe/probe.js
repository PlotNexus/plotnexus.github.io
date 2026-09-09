import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";

mkdirSync("out", { recursive: true });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" });
  const results = {};

  for (const [label, url] of [
    ["idealista", "https://rapidapi.com/search/idealista"],
    ["real-estate", "https://rapidapi.com/search/real%20estate"],
    ["unblocker", "https://rapidapi.com/search/web%20scraping"],
  ]) {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const items = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/user/"], a[href*="/hub/"], a[href^="/"]')];
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        const text = a.innerText?.trim();
        const href = a.getAttribute("href");
        if (!text || text.length < 3 || text.length > 120) continue;
        const key = href + "|" + text;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text, href });
      }
      return out.slice(0, 80);
    });
    results[label] = items;
    await page.screenshot({ path: `out/rapidapi-${label}.png`, fullPage: true }).catch(() => {});
  }

  writeFileSync("out/rapidapi-results.json", JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
}

main();
