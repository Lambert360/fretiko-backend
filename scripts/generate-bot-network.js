/**
 * Generates the full bot network personas: 200 content bots + 200 engagement bots.
 * Ethnic mix: Yoruba ~42%, Igbo ~42%, Hausa ~8%, English (Nigerian-common) ~8%. Gender is balanced inside each group.
 * Avatars prefer avatar-pool.json (Pexels portraits), falling back to randomuser.me.
 * Run: node scripts/generate-bot-network.js
 * Output: content-bots.json, engagement-bots.json, bot-network-roster.csv
 */
const fs = require('fs');
const path = require('path');

const hausaMale = ['Mohammed Adamu', 'Ibrahim Musa', 'Abubakar Sani', 'Aliyu Garba', 'Yusuf Bello', 'Nuhu Danjuma', 'Sani Abdullahi', 'Umar Farouk', 'Lawal Shehu', 'Auwal Ibrahim', 'Tanko Suleiman', 'Bashir Yakubu'];
const hausaFemale = ['Amina Sule', 'Zainab Umar', 'Hauwa Bello', 'Fatima Abubakar', 'Halima Aliyu', 'Aisha Garba', 'Rabi Musa', 'Maryam Danjuma', 'Safiya Lawal', 'Hadiza Shehu', 'Rukayya Ibrahim', 'Jamila Sani'];

const igboMale = [
  'Chukwuemeka Obi', 'Emeka Nwachukwu', 'Chidi Okafor', 'Ikechukwu Eze', 'Obinna Chukwu', 'Chibueze Nnamdi',
  'Kelechi Okonkwo', 'Ugochukwu Anyanwu', 'Chinedu Okoye', 'Nnamdi Achebe', 'Ifeanyi Uzoma', 'Uchenna Onyekwere',
  'Chukwudi Nwankwo', 'Ikenna Okeke', 'Tochukwu Ibe', 'Chigozie Umeh', 'Onyeka Nwafor', 'Ekene Okoro',
  'Nonso Ezeani', 'Chukwuma Obioma', 'Somtochukwu Nwosu', 'Chijioke Eke', 'Lotanna Okpala', 'Ikemefuna Ibe',
  'Kamsiyochukwu Okeke', 'Echezona Nwankwo', 'Obinna Okoro', 'Chukwuebuka Umeh', 'Ikenna Nwafor', 'Tochukwu Ezeani',
];
const igboFemale = [
  'Chinasa Ezugo', 'Ngozi Chukwu', 'Adaeze Okafor', 'Chiamaka Nwosu', 'Ifeoma Eze', 'Amarachi Obi',
  'Uchechi Anyanwu', 'Chidinma Okonkwo', 'Nkechi Nnamdi', 'Ogechi Achebe', 'Chiazor Onyekwere', 'Chioma Okeke',
  'Nneka Nwankwo', 'Amaka Eke', 'Ijeoma Okoro', 'Adaobi Ibe', 'Onyinye Umeh', 'Chisom Nwafor',
  'Ifunanya Ezeani', 'Oluchi Obioma', 'Adaugo Nwosu', 'Kamsi Okpala', 'Somtochukwu Ibe', 'Chidera Okeke',
  'Ngozi Ezeani', 'Ifeoma Nwankwo', 'Amarachi Okoro', 'Chiamaka Umeh', 'Adaeze Nwafor', 'Ogechi Ibe',
];

const yorubaMale = [
  'Adewale Adenuga', 'Oluwaseun Ojo', 'Babatunde Fashola', 'Adeyemi Ogundele', 'Olumide Bankole', 'Kayode Afolabi',
  'Segun Adeyinka', 'Femi Oyelaran', 'Tunde Balogun', 'Wale Adisa', 'Ayodele Fagbenle', 'Damilare Oyewole',
  'Adebayo Ajayi', 'Olusegun Adeleke', 'Taiwo Ogunleye', 'Kunle Adeyemi', 'Seyi Adebisi', 'Lanre Olatunji',
  'Bolaji Akinwale', 'Tope Adesina', 'Dayo Oladipo', 'Gbenga Adekunle', 'Yemi Aluko', 'Jide Ogunbiyi',
  'Akin Oladapo', 'Rotimi Adebayo', 'Kehinde Alabi', 'Idowu Salami', 'Biodun Ajayi', 'Gbolahan Adeleke',
];
const yorubaFemale = [
  'Adeola Fashola', 'Folake Ojo', 'Bukola Ogundele', 'Yetunde Bankole', 'Omolara Afolabi', 'Temitope Adeyinka',
  'Aduke Oyelaran', 'Ronke Balogun', 'Abisola Adisa', 'Kemi Fagbenle', 'Titilayo Oyewole', 'Morenike Adenuga',
  'Funmilayo Adekoya', 'Bolanle Ajayi', 'Simisola Adeleke', 'Toyin Akinola', 'Bisi Ogunleye', 'Peju Alabi',
  'Sade Olatunji', 'Yewande Adesina', 'Dunni Oladipo', 'Motunrayo Salami', 'Eniola Ogunbiyi', 'Busola Oladapo',
  'Damilola Adebayo', 'Oluwatoyin Ajayi', 'Anjola Aluko', 'Ifeoluwa Adekunle', 'Yetunde Adeyemi', 'Folake Adeleke',
];

const englishMale = ['Charles Francis', 'David Johnson', 'Michael Brown', 'Samuel Edwards', 'Daniel Okoye', 'Peter Williams', 'Victor Anthony', 'Emmanuel Roberts', 'Joseph Bassey', 'Richard Etim'];
const englishFemale = ['Grace Williams', 'Patience Edwards', 'Mercy Johnson', 'Blessing Brown', 'Comfort Roberts', 'Faith Anthony', 'Joy Bassey', 'Precious Etim', 'Gift Francis', 'Peace Daniels'];

const niches = [
  'science_technology', 'ai', 'space', 'gadgets', 'fashion_lifestyle', 'nature_environment', 'animals_wildlife',
  'nigeria_news', 'sports', 'business_entrepreneurship', 'culture_entertainment', 'food_travel', 'health_fitness', 'education_career',
];

const CONTENT_BOT_COUNT = 200;
const ENGAGEMENT_BOT_COUNT = 200;

const YORUBA_SHARE = 0.42;
const IGBO_SHARE = 0.42;
const ENGLISH_SHARE = 0.08;

let avatarPool = { men: [], women: [] };
try {
  avatarPool = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'avatar-pool.json'), 'utf-8'));
} catch (e) {
  console.warn('avatar-pool.json not found, falling back to randomuser.me');
}

function toEntries(names, gender, group) {
  return names.map((name) => ({ name, gender, group }));
}

function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function expandGroup(maleNames, femaleNames, group, count, seed) {
  const malesNeeded = Math.floor(count / 2);
  const femalesNeeded = count - malesNeeded;
  const maleBase = seededShuffle(toEntries(maleNames, 'male', group), seed);
  const femaleBase = seededShuffle(toEntries(femaleNames, 'female', group), seed + 17);

  const expand = (base, needed) => {
    const out = [];
    let cycle = 0;
    while (out.length < needed) {
      for (const entry of base) {
        if (out.length >= needed) break;
        const suffix = cycle === 0 ? '' : ` ${String.fromCharCode(65 + ((cycle - 1) % 26))}.`;
        out.push({ ...entry, name: `${entry.name}${suffix}` });
      }
      cycle++;
    }
    return out;
  };

  return seededShuffle([...expand(maleBase, malesNeeded), ...expand(femaleBase, femalesNeeded)], seed + 41);
}

function buildWeightedNames(totalNeeded) {
  const yorubaCount = Math.round(totalNeeded * YORUBA_SHARE);
  const igboCount = Math.round(totalNeeded * IGBO_SHARE);
  const englishCount = Math.round(totalNeeded * ENGLISH_SHARE);
  const hausaCount = totalNeeded - yorubaCount - igboCount - englishCount;

  const yoruba = expandGroup(yorubaMale, yorubaFemale, 'yoruba', yorubaCount, 11);
  const igbo = expandGroup(igboMale, igboFemale, 'igbo', igboCount, 23);
  const hausa = expandGroup(hausaMale, hausaFemale, 'hausa', hausaCount, 37);
  const english = expandGroup(englishMale, englishFemale, 'english', englishCount, 53);

  // 25-slot pattern: 10 Yoruba, 10 Igbo, 3 Hausa, 2 English => ~42%/42%/8%/8%
  const pattern = [
    'yoruba', 'igbo', 'yoruba', 'igbo', 'yoruba', 'igbo', 'yoruba', 'igbo', 'yoruba', 'igbo',
    'yoruba', 'igbo', 'yoruba', 'igbo', 'yoruba', 'igbo', 'yoruba', 'igbo', 'yoruba', 'igbo',
    'hausa', 'english', 'hausa', 'english', 'hausa',
  ];
  const queues = { yoruba, igbo, hausa, english };
  const mixed = [];
  let patternIndex = 0;
  while (mixed.length < totalNeeded) {
    const group = pattern[patternIndex % pattern.length];
    patternIndex++;
    if (queues[group].length === 0) continue;
    mixed.push(queues[group].shift());
  }
  return mixed;
}

function makeUsername(name, usedUsernames) {
  const base = name.replace(/[^a-zA-Z ]/g, '').split(' ').join('');
  let username = base;
  let suffix = 1;
  while (usedUsernames.has(username.toLowerCase())) {
    username = `${base}${suffix}`;
    suffix++;
  }
  usedUsernames.add(username.toLowerCase());
  return username;
}

function makeEmail(username) {
  return `${username.toLowerCase()}@fretiko.local`;
}

function randInt(seed, min, max) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  const r = x - Math.floor(x);
  return min + Math.floor(r * (max - min + 1));
}

const genderAvatarIndex = { male: 0, female: 0 };

function avatarFor(gender) {
  const pool = gender === 'male' ? avatarPool.men : avatarPool.women;
  if (pool && pool.length > 0) {
    const url = pool[genderAvatarIndex[gender] % pool.length];
    genderAvatarIndex[gender] += 1;
    return url;
  }
  const genderPath = gender === 'male' ? 'men' : 'women';
  const photoIndex = genderAvatarIndex[gender] % 100;
  genderAvatarIndex[gender] += 1;
  return `https://randomuser.me/api/portraits/${genderPath}/${photoIndex}.jpg`;
}

function buildBios(name, isContentBot) {
  const first = name.split(' ')[0];
  if (isContentBot) {
    return `${first} | Sharing what catches my eye 👀 | Lagos, Nigeria`;
  }
  return `${first} 🇳🇬 | Just here for the vibes`;
}

function generate() {
  const usedUsernames = new Set();
  const totalNeeded = CONTENT_BOT_COUNT + ENGAGEMENT_BOT_COUNT;
  const extendedNames = buildWeightedNames(totalNeeded);

  const contentBots = [];
  const engagementBots = [];

  for (let i = 0; i < totalNeeded; i++) {
    const entry = extendedNames[i];
    const username = makeUsername(entry.name, usedUsernames);
    const email = makeEmail(username);
    const isContentBot = i < CONTENT_BOT_COUNT;
    const persona = {
      email,
      username,
      full_name: entry.name.trim(),
      first_name: entry.name.trim().split(' ')[0],
      last_name: entry.name.trim().split(' ').slice(1).join(' ') || entry.name.trim().split(' ')[0],
      gender: entry.gender,
      ethnic_group: entry.group,
      bio: buildBios(entry.name, isContentBot),
      avatar_url: avatarFor(entry.gender),
    };

    if (isContentBot) {
      persona.niche = niches[i % niches.length];
      persona.role = 'content';
      persona.location = 'Lagos, Nigeria';
      persona.followers_count = randInt(i + 1, 380, 620);
      persona.following_count = randInt(i + 17, 80, 250);
      contentBots.push(persona);
    } else {
      persona.role = 'engagement';
      persona.location = 'Lagos, Nigeria';
      persona.followers_count = randInt(i + 3, 40, 180);
      persona.following_count = randInt(i + 29, 100, 280);
      engagementBots.push(persona);
    }
  }

  fs.writeFileSync(
    path.join(process.cwd(), 'content-bots.json'),
    JSON.stringify({ bots: contentBots }, null, 2),
  );
  fs.writeFileSync(
    path.join(process.cwd(), 'engagement-bots.json'),
    JSON.stringify({ bots: engagementBots }, null, 2),
  );

  const roster = [...contentBots, ...engagementBots];
  const csvHeader = 'role,full_name,username,gender,ethnic_group,niche,followers_count,following_count,avatar_url';
  const csvRows = roster.map((bot) =>
    [
      bot.role,
      `"${bot.full_name.replace(/"/g, '""')}"`,
      bot.username,
      bot.gender,
      bot.ethnic_group,
      bot.niche || '',
      bot.followers_count,
      bot.following_count,
      bot.avatar_url,
    ].join(','),
  );
  fs.writeFileSync(path.join(process.cwd(), 'bot-network-roster.csv'), [csvHeader, ...csvRows].join('\n'));

  const contentFollowers = contentBots.reduce((sum, bot) => sum + bot.followers_count, 0);
  const ethnicCounts = roster.reduce((acc, bot) => {
    acc[bot.ethnic_group] = (acc[bot.ethnic_group] || 0) + 1;
    return acc;
  }, {});
  console.log(`Generated ${contentBots.length} content bots and ${engagementBots.length} engagement bots`);
  console.log(`Content-bot follower average: ${Math.round(contentFollowers / contentBots.length)}`);
  console.log(`Ethnic mix: ${JSON.stringify(ethnicCounts)}`);
  console.log(`Avatars: ${avatarPool.men.length} male / ${avatarPool.women.length} female dark-complexion portraits`);
}

generate();
