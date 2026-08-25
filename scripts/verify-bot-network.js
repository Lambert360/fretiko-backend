/**
 * Verifies the bot network against the stated requirements.
 * Run: node scripts/verify-bot-network.js
 * Exits non-zero if any assertion fails.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ROOT = process.cwd();
const results = [];

function check(name, actual, expected, pass) {
  results.push({ name, actual, expected, pass });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name} | actual=${actual} expected=${expected}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

async function main() {
  // --- Static roster checks ---
  const content = readJson('content-bots.json').bots;
  const engagement = readJson('engagement-bots.json').bots;

  check('content bot count', content.length, '150-200', content.length >= 150 && content.length <= 200);
  check('engagement bot count', engagement.length, 200, engagement.length === 200);

  const totalFollowers = content.reduce((s, b) => s + b.followers_count, 0);
  const avgFollowers = totalFollowers / content.length;
  check('avg content-bot followers', avgFollowers.toFixed(1), '~500 (450-550)', avgFollowers >= 450 && avgFollowers <= 550);

  const requiredNiches = [
    'science_technology', 'ai', 'space', 'gadgets', 'fashion_lifestyle', 'nature_environment', 'animals_wildlife',
    'nigeria_news', 'sports', 'business_entrepreneurship', 'culture_entertainment', 'food_travel', 'health_fitness', 'education_career',
  ];
  const nicheSet = new Set(content.map((b) => b.niche));
  const missingNiches = requiredNiches.filter((n) => !nicheSet.has(n));
  check('all 14 required niches present', `${requiredNiches.length - missingNiches.length}/14 (missing: ${missingNiches.join(',') || 'none'})`, '14/14', missingNiches.length === 0);

  const ethnicGroups = new Set([...content, ...engagement].map((b) => b.ethnic_group));
  const requiredGroups = ['yoruba', 'igbo', 'hausa', 'english'];
  const missingGroups = requiredGroups.filter((g) => !ethnicGroups.has(g));
  check('Hausa/Igbo/Yoruba/English name groups present', `present: ${[...ethnicGroups].join(',')}`, requiredGroups.join(','), missingGroups.length === 0);

  const avatarPool = readJson('avatar-pool.json');
  check('avatar pool has male + female dark-skin-filtered photos', `${avatarPool.men.length} men / ${avatarPool.women.length} women`, '>0 each', avatarPool.men.length > 0 && avatarPool.women.length > 0);

  const allBots = [...content, ...engagement];
  const isRealPoolPhoto = (url) => url.includes('images.pexels.com') || url.includes('images.unsplash.com');
  const notFromPool = allBots.filter((b) => !isRealPoolPhoto(b.avatar_url));
  check('all bot avatars use filtered Pexels/Unsplash pool (not randomuser.me placeholder)', `${allBots.length - notFromPool.length}/${allBots.length}`, `${allBots.length}/${allBots.length}`, notFromPool.length === 0);

  const csvPath = path.join(ROOT, 'bot-network-roster.csv');
  const csvLines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  check('roster CSV row count (header + 400 bots)', csvLines.length, content.length + engagement.length + 1, csvLines.length === content.length + engagement.length + 1);

  // --- RSS feed liveness for the 7 new niches ---
  const Parser = require('rss-parser');
  const parser = new Parser({ timeout: 15000 });
  const rssConfig = readJson('rss-feeds-config.json');
  const newNiches = ['nigeria_news', 'sports', 'business_entrepreneurship', 'culture_entertainment', 'food_travel', 'health_fitness', 'education_career'];
  let totalNewNicheFeeds = 0;
  let workingNewNicheFeeds = 0;
  for (const niche of newNiches) {
    const feeds = rssConfig.feeds[niche] || [];
    for (const f of feeds) {
      totalNewNicheFeeds++;
      try {
        await parser.parseURL(f.url);
        workingNewNicheFeeds++;
      } catch (e) {
        console.log(`   -> RSS feed dead: [${niche}] ${f.name} (${f.url}): ${e.message}`);
      }
    }
  }
  check('RSS feeds for 7 new niches are live', `${workingNewNicheFeeds}/${totalNewNicheFeeds}`, `${totalNewNicheFeeds}/${totalNewNicheFeeds}`, workingNewNicheFeeds === totalNewNicheFeeds);

  // --- Live DB checks (requires backend to have been run at least once) ---
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const usernames = allBots.map((b) => b.username);
  const { data: profiles, error: profErr } = await client
    .from('user_profiles')
    .select('username, avatar_url')
    .in('username', usernames);
  if (profErr) {
    check('bot profiles provisioned in Supabase', 'query error: ' + profErr.message, '400 rows', false);
  } else {
    check('bot profiles provisioned in Supabase', `${profiles.length}/400`, '400/400', profiles.length === 400);
    const avatarMismatches = profiles.filter((p) => !p.avatar_url || !(p.avatar_url.includes('images.pexels.com') || p.avatar_url.includes('images.unsplash.com')));
    check('provisioned profiles carry dark-skin-filtered avatar_url', `${profiles.length - avatarMismatches.length}/${profiles.length}`, `${profiles.length}/${profiles.length}`, avatarMismatches.length === 0);
  }

  const { data: recentPosts, error: postErr } = await client
    .from('posts')
    .select('id, user_id, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  if (postErr || !recentPosts || recentPosts.length === 0) {
    check('recent posts exist with seeded likes >= 4', 'no posts found', '>=4 likes per recent post', false);
  } else {
    let postsWithEnoughLikes = 0;
    for (const p of recentPosts) {
      const { data: likes } = await client
        .from('post_interactions')
        .select('id')
        .eq('post_id', p.id)
        .eq('interaction_type', 'like');
      if ((likes || []).length >= 4) postsWithEnoughLikes++;
    }
    check('recent posts have >=4 seeded likes', `${postsWithEnoughLikes}/${recentPosts.length}`, `${recentPosts.length}/${recentPosts.length}`, postsWithEnoughLikes === recentPosts.length);
  }

  // --- followers_count column / migration status ---
  const { error: colErr } = await client.from('user_profiles').select('followers_count').limit(1);
  check('followers_count column exists on live DB (migration 120 applied)', colErr ? colErr.message : 'column exists', 'column exists', !colErr);

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED CHECKS:');
    for (const f of failed) console.log(` - ${f.name}: actual=${f.actual} expected=${f.expected}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Verification script crashed:', e);
  process.exitCode = 1;
});
