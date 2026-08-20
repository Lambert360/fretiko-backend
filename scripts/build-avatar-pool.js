/**
 * Builds a gender-split portrait pool of dark-complexion African faces.
 * Sources: Pexels + Unsplash. Alt-text filtered, then skin-tone scored.
 * Run: node scripts/build-avatar-pool.js
 * Output: avatar-pool.json, avatar-candidates.json
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PEXELS_KEY = process.env.PEXELS_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_ACCESS_KEY;

const MALE_QUERIES = [
  'nigerian man portrait',
  'nigerian man headshot',
  'west african man portrait',
  'dark skin african man portrait',
  'african man smiling headshot',
  'ghanaian man portrait',
  'black african man face',
  'yoruba man portrait',
  'african businessman portrait',
  'portrait of african man',
  'studio headshot african man',
  'nigerian guy portrait',
  'african male model portrait',
  'smiling nigerian man',
];

const FEMALE_QUERIES = [
  'nigerian woman portrait',
  'nigerian woman headshot',
  'west african woman portrait',
  'dark skin african woman portrait',
  'african woman smiling headshot',
  'ghanaian woman portrait',
  'black african woman face',
  'yoruba woman portrait',
  'african businesswoman portrait',
  'portrait of african woman',
  'studio headshot african woman',
  'nigerian lady portrait',
  'smiling nigerian woman',
  'african female model portrait',
];

const POSITIVE = /(african|africa|nigerian|nigeria|ghanaian|ghana|kenyan|kenya|west african|black man|black woman|black male|black female|dark skin|dark-skinned|melanin|yoruba|igbo|hausa|lagos)/i;
const NEGATIVE = /(baby|infant|toddler|\bchild\b|\bkids?\b|caucasian|white man|white woman|european|crowd|group of|landscape|statue|drawing|illustration|cartoon|elephant|lion|impala|antelope|butterfly|wildlife|rice|rugby|festival|family)/i;

function altText(photo, source) {
  if (source === 'pexels') return `${photo.alt || ''} ${photo.photographer || ''}`;
  return `${photo.alt_description || ''} ${photo.description || ''} ${photo.user?.name || ''}`;
}

function isLikelyMatch(text) {
  if (!text) return false;
  if (NEGATIVE.test(text)) return false;
  return POSITIVE.test(text);
}

async function searchPexels(query, page) {
  if (!PEXELS_KEY) return [];
  const res = await axios.get('https://api.pexels.com/v1/search', {
    params: { query, per_page: 40, page, orientation: 'square' },
    headers: { Authorization: PEXELS_KEY },
    timeout: 15000,
  });
  return (res.data.photos || []).map((photo) => ({
    id: `pexels-${photo.id}`,
    url: photo.src.medium || photo.src.large,
    alt: altText(photo, 'pexels'),
    source: 'pexels',
  }));
}

async function searchUnsplash(query, page) {
  if (!UNSPLASH_KEY) return [];
  const res = await axios.get('https://api.unsplash.com/search/photos', {
    params: { query, per_page: 30, page, orientation: 'squarish' },
    headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` },
    timeout: 15000,
  });
  return (res.data.results || []).map((photo) => ({
    id: `unsplash-${photo.id}`,
    url: photo.urls?.small || photo.urls?.regular,
    alt: altText(photo, 'unsplash'),
    source: 'unsplash',
  }));
}

async function collect(queries, gender) {
  const seen = new Map();
  for (const query of queries) {
    for (let page = 1; page <= 3; page++) {
      try {
        const batch = [
          ...(await searchPexels(query, page)),
          ...(page <= 2 ? await searchUnsplash(query, page) : []),
        ];
        for (const photo of batch) {
          if (!photo.url || seen.has(photo.id)) continue;
          if (!isLikelyMatch(photo.alt)) continue;
          seen.set(photo.id, { ...photo, gender });
        }
        console.log(`[${gender}] "${query}" page ${page}: pool ${seen.size}`);
      } catch (err) {
        console.error(`[${gender}] "${query}" page ${page} failed: ${err.message}`);
      }
    }
  }
  return Array.from(seen.values());
}

(async () => {
  const men = await collect(MALE_QUERIES, 'male');
  const women = await collect(FEMALE_QUERIES, 'female');
  const candidates = { men, women };
  const candidatesPath = path.join(process.cwd(), 'avatar-candidates.json');
  fs.writeFileSync(candidatesPath, JSON.stringify(candidates, null, 2));
  console.log(`Candidates: ${men.length} male, ${women.length} female -> ${candidatesPath}`);

  const filterScript = path.join(__dirname, 'filter-avatar-pool.py');
  const result = spawnSync('python3', [filterScript, candidatesPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
})();
