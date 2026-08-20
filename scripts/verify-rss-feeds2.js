const Parser = require('rss-parser');
const parser = new Parser({ timeout: 10000 });

const candidates = [
  ['food_travel', 'Eater', 'https://www.eater.com/rss/index.xml'],
  ['food_travel', 'Food52', 'https://food52.com/blog.rss'],
  ['food_travel', 'National Geographic Travel', 'https://www.nationalgeographic.com/travel/rss/'],
  ['health_fitness', 'Shape', 'https://www.shape.com/rss/all.xml/'],
  ['health_fitness', 'Prevention', 'https://www.prevention.com/rss/all.xml/'],
  ['health_fitness', 'Everyday Health', 'https://www.everydayhealth.com/rss/all.xml'],
  ['education_career', 'Fast Company Work Life', 'https://www.fastcompany.com/work-life/rss'],
  ['education_career', 'Times Higher Education', 'https://www.timeshighereducation.com/rss.xml'],
  ['nigeria_news', 'The Cable', 'https://www.thecable.ng/feed'],
  ['sports', 'Complete Sports Football', 'https://www.completesports.com/category/football/feed/'],
  ['culture_entertainment', 'Nigerian Entertainment Today', 'https://www.netng.com/feed/'],
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
