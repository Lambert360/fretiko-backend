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

  check('content bot count', content.length, '~400', content.length >= 380 && content.length <= 420);
  check('engagement bot count', engagement.length, '~300', engagement.length >= 280 && engagement.length <= 320);

  const totalFollowers = [...content, ...engagement].reduce((s, b) => s + b.followers_count, 0);
  const avgFollowers = totalFollowers / (content.length + engagement.length);
  const allFollowersInRange = [...content, ...engagement].every((b) => b.followers_count >= 330 && b.followers_count <= 670);
  check('all bot followers within 330-670', `avg=${avgFollowers.toFixed(1)}, allInRange=${allFollowersInRange}`, '330-670 each', allFollowersInRange);

  const raceCounts = [...content, ...engagement].reduce((acc, b) => { acc[b.race] = (acc[b.race] || 0) + 1; return acc; }, {});
  check('race split ~400 caucasian / ~300 nigerian', JSON.stringify(raceCounts), '{"caucasian":400,"nigerian":300}', raceCounts.caucasian >= 380 && raceCounts.caucasian <= 420 && raceCounts.nigerian >= 280 && raceCounts.nigerian <= 320);

  const requiredNigerianNiches = ['nigeria_news', 'afrobeats_music', 'nollywood', 'football', 'nigerian_food_culture', 'african_tech', 'controversial_trending'];
  const requiredCaucasianNiches = ['science_technology', 'ai', 'space', 'gadgets', 'fashion_lifestyle', 'nature_environment', 'animals_wildlife', 'health_fitness', 'education_career', 'business_entrepreneurship', 'sports'];
  const nicheSet = new Set(content.map((b) => b.niche));
  const missingNigerianNiches = requiredNigerianNiches.filter((n) => !nicheSet.has(n));
  const missingCaucasianNiches = requiredCaucasianNiches.filter((n) => !nicheSet.has(n));
  check('all Nigerian niches present', `missing: ${missingNigerianNiches.join(',') || 'none'}`, 'none missing', missingNigerianNiches.length === 0);
  check('all Caucasian niches present', `missing: ${missingCaucasianNiches.join(',') || 'none'}`, 'none missing', missingCaucasianNiches.length === 0);

  const nigerianBotsUseTechOnlyAfrican = content.filter((b) => b.race === 'nigerian').every((b) => b.niche !== 'science_technology' && b.niche !== 'ai' && b.niche !== 'gadgets');
  check('Nigerian bots never assigned generic/international tech niches', nigerianBotsUseTechOnlyAfrican, true, nigerianBotsUseTechOnlyAfrican);

  const ethnicGroups = new Set([...content, ...engagement].map((b) => b.ethnic_group));
  const requiredGroups = ['yoruba', 'igbo', 'hausa', 'english', 'western'];
  const missingGroups = requiredGroups.filter((g) => !ethnicGroups.has(g));
  check('Yoruba/Igbo/Hausa/English/Western name groups present', `present: ${[...ethnicGroups].join(',')}`, requiredGroups.join(','), missingGroups.length === 0);

  const avatarPool = readJson('avatar-pool.json');
  check('avatar pool has nigerian + caucasian male/female photos', `nigerian: ${avatarPool.nigerian.men.length}m/${avatarPool.nigerian.women.length}w, caucasian: ${avatarPool.caucasian.men.length}m/${avatarPool.caucasian.women.length}w`, '>0 each', avatarPool.nigerian.men.length > 0 && avatarPool.nigerian.women.length > 0 && avatarPool.caucasian.men.length > 0 && avatarPool.caucasian.women.length > 0);

  const allBots = [...content, ...engagement];

  const csvPath = path.join(ROOT, 'bot-network-roster.csv');
  const csvLines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  check('roster CSV row count (header + bots)', csvLines.length, content.length + engagement.length + 1, csvLines.length === content.length + engagement.length + 1);

  // --- RSS feed liveness for the new/updated niches ---
  const Parser = require('rss-parser');
  const parser = new Parser({ timeout: 15000 });
  const rssConfig = readJson('rss-feeds-config.json');
  const newNiches = ['nigeria_news', 'football', 'sports', 'nigerian_food_culture', 'african_tech', 'controversial_trending', 'business_entrepreneurship', 'health_fitness', 'education_career'];
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
    check('bot profiles provisioned in Supabase', 'query error: ' + profErr.message, `${allBots.length} rows`, false);
  } else {
    check('bot profiles provisioned in Supabase', `${profiles.length}/${allBots.length}`, `${allBots.length}/${allBots.length}`, profiles.length === allBots.length);
    const avatarMismatches = profiles.filter((p) => !p.avatar_url);
    check('provisioned profiles carry an avatar_url', `${profiles.length - avatarMismatches.length}/${profiles.length}`, `${profiles.length}/${profiles.length}`, avatarMismatches.length === 0);
  }

  const { data: recentPosts, error: postErr } = await client
    .from('posts')
    .select('id, user_id, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  if (postErr || !recentPosts || recentPosts.length === 0) {
    check('recent posts exist with seeded likes >= 50 and comments >= 50', 'no posts found', '>=50 likes and >=50 comments per recent post', false);
  } else {
    let postsWithEnoughLikes = 0;
    let postsWithEnoughComments = 0;
    for (const p of recentPosts) {
      const { data: likes } = await client
        .from('post_interactions')
        .select('id')
        .eq('post_id', p.id)
        .eq('interaction_type', 'like');
      if ((likes || []).length >= 50) postsWithEnoughLikes++;
      const { data: comments } = await client
        .from('post_interactions')
        .select('id')
        .eq('post_id', p.id)
        .eq('interaction_type', 'comment');
      if ((comments || []).length >= 50) postsWithEnoughComments++;
    }
    check('recent posts have >=50 seeded likes', `${postsWithEnoughLikes}/${recentPosts.length}`, `${recentPosts.length}/${recentPosts.length}`, postsWithEnoughLikes === recentPosts.length);
    check('recent posts have >=50 seeded comments', `${postsWithEnoughComments}/${recentPosts.length}`, `${recentPosts.length}/${recentPosts.length}`, postsWithEnoughComments === recentPosts.length);
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
