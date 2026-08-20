const Parser = require('rss-parser');
const parser = new Parser({ timeout: 10000 });

const candidates = [
  ['science_technology', 'Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index'],
  ['ai', 'Google AI Blog', 'https://blog.google/technology/ai/rss/'],
  ['space', 'Sky & Telescope', 'https://skyandtelescope.org/feed/'],
  ['gadgets', 'TechRadar', 'https://www.techradar.com/rss'],
  ['fashion_lifestyle', 'Elle', 'https://www.elle.com/rss/all.xml/'],
  ['nature', 'Mongabay', 'https://news.mongabay.com/feed/'],
  ['animals', 'Live Science Animals', 'https://www.livescience.com/feeds/tag/animals'],
];

(async () => {
  for (const [niche, name, url] of candidates) {
    try {
      const feed = await parser.parseURL(url);
      console.log(`OK   [${niche}] ${name} -> ${feed.items?.length || 0} items (${url})`);
    } catch (err) {
      console.log(`FAIL [${niche}] ${name} -> ${err.message} (${url})`);
    }
  }
  process.exit(0);
})();
