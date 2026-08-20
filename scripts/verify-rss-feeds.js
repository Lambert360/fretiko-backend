/**
 * Checks every feed in rss-feeds-config.json.
 * Run: node scripts/verify-rss-feeds.js
 */
const Parser = require('rss-parser');
const config = require('../rss-feeds-config.json');

const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'FretikoRSS/1.0' } });

(async () => {
  const results = [];
  for (const [niche, feeds] of Object.entries(config.feeds)) {
    for (const feed of feeds) {
      if (!feed.active) {
        console.log(`SKIP [${niche}] ${feed.name}`);
        continue;
      }
      try {
        const parsed = await parser.parseURL(feed.url);
        const count = parsed.items?.length || 0;
        console.log(`OK   [${niche}] ${feed.name} -> ${count} items`);
        results.push({ niche, name: feed.name, url: feed.url, ok: true, count });
      } catch (err) {
        console.log(`FAIL [${niche}] ${feed.name} -> ${err.message}`);
        results.push({ niche, name: feed.name, url: feed.url, ok: false, error: err.message });
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length} ok, ${failed.length} failed`);
  process.exit(failed.length > 0 ? 1 : 0);
})();
