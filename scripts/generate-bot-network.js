/**
 * Generates the full bot network personas: ~700 bots (400 Caucasian + 300 Nigerian).
 * Caucasian bots: Western names, proper English, international niches.
 * Nigerian bots: Yoruba ~42%, Igbo ~42%, Hausa ~8%, English (Nigerian-common) ~8%.
 *   Nigerian niches: football, afrobeats, nollywood, food/culture, african tech, controversial, nigeria news.
 * All bots get 330-670 followers.
 * Run: node scripts/generate-bot-network.js
 * Output: content-bots.json, engagement-bots.json, bot-network-roster.csv
 */
const fs = require('fs');
const path = require('path');

// ── Nigerian name pools ──
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

// ── Caucasian name pools ──
const caucasianMale = [
  'James Miller', 'Robert Wilson', 'William Anderson', 'David Thompson', 'Richard Martinez',
  'Thomas Garcia', 'Christopher Robinson', 'Daniel Clark', 'Matthew Lewis', 'Andrew Walker',
  'Joshua Hall', 'Brandon Allen', 'Ryan Young', 'Kevin King', 'Jason Wright',
  'Justin Lopez', 'Tyler Hill', 'Aaron Scott', 'Nathan Green', 'Adam Baker',
  'Brian Nelson', 'Patrick Carter', 'Sean Mitchell', 'Kyle Perez', 'Ethan Roberts',
  'Connor Turner', 'Luke Phillips', 'Dylan Campbell', 'Caleb Parker', 'Ian Evans',
  'Jake Edwards', 'Mason Collins', 'Logan Stewart', 'Liam Sanchez', 'Owen Morris',
  'Carter Rogers', 'Hunter Reed', 'Gavin Cook', 'Blake Morgan', 'Chase Bell',
  'Trevor Murphy', 'Cody Bailey', 'Dustin Rivera', 'Derek Cooper', 'Marcus Richardson',
  'Shane Cox', 'Troy Howard', 'Brent Ward', 'Scott Torres', 'Craig Peterson',
  'Keith Gray', 'Jesse Ramirez', 'Dennis James', 'Raymond Watson', 'Philip Brooks',
  'Todd Kelly', 'Bradley Sanders', 'Russell Price', 'Howard Bennett', 'Carl Wood',
  'Gerald Barnes', 'Roy Ross', 'Eugene Henderson', 'Randy Coleman', 'Wayne Jenkins',
  'Johnny Perry', 'Ralph Powell', 'Albert Long', 'Joe Patterson', 'Lawrence Hughes',
  'Bobby Flores', 'Billy Washington', 'Bruce Butler', 'Gabriel Simmons', 'Clarence Foster',
  'Martin Gonzales', 'Allen Bryant', 'Vincent Alexander', 'Terry Russell', 'Norman Griffin',
  'Leo Diaz', 'Freddie Hayes', 'Ernest Myers', 'Stanley Ford', 'Clifford Hamilton',
  'Darren Graham', 'Wade Sullivan', 'Milton Wallace', 'Harvey Woods', 'Cecil West',
  'Lyle Jordan', 'Dirk Owens', 'Gordon Reynolds', 'Neil Fisher', 'Dean Ellis',
  'Spencer Harrison', 'Vince Gibson', 'Clayton McDonald', 'Donovan Cruz', 'Marshall Murray',
];
const caucasianFemale = [
  'Emily Johnson', 'Sarah Williams', 'Jessica Davis', 'Ashley Brown', 'Amanda Jones',
  'Stephanie Taylor', 'Jennifer Thomas', 'Elizabeth Moore', 'Lauren Jackson', 'Megan White',
  'Rachel Harris', 'Nicole Martin', 'Samantha Lee', 'Kayla Robinson', 'Hannah Clark',
  'Brittany Lewis', 'Olivia Walker', 'Sophia Hall', 'Isabella Allen', 'Ava Young',
  'Chloe King', 'Grace Wright', 'Lily Scott', 'Zoe Green', 'Emma Baker',
  'Madison Nelson', 'Abigail Carter', 'Natalie Mitchell', 'Victoria Perez', 'Alexis Roberts',
  'Brooke Turner', 'Paige Phillips', 'Morgan Campbell', 'Taylor Parker', 'Sydney Evans',
  'Kylie Edwards', 'Jenna Collins', 'Amber Stewart', 'Haley Sanchez', 'Kaitlyn Morris',
  'Courtney Rogers', 'Vanessa Reed', 'Christina Cook', 'Kelly Morgan', 'Sara Bell',
  'Danielle Murphy', 'Rebecca Bailey', 'Michelle Rivera', 'Tiffany Cooper', 'Teresa Richardson',
  'Laura Cox', 'Heather Howard', 'Amy Ward', 'Deborah Torres', 'Andrea Peterson',
  'Kathleen Gray', 'Sandra Ramirez', 'Diane James', 'Ruth Watson', 'Sharon Brooks',
  'Virginia Kelly', 'Carol Sanders', 'Brenda Price', 'Pamela Bennett', 'Dorothy Wood',
  'Janet Barnes', 'Frances Ross', 'Ann Henderson', 'Joyce Coleman', 'Marie Jenkins',
  'Alice Perry', 'Jean Powell', 'Judy Long', 'Martha Patterson', 'Christine Hughes',
  'Gloria Flores', 'Beverly Washington', 'Bonnie Butler', 'Irene Simmons', 'Helen Foster',
  'Catherine Gonzales', 'Tammy Bryant', 'Donna Alexander', 'Angela Russell', 'Jane Griffin',
  'Cheryl Diaz', 'Theresa Hayes', 'Norma Myers', 'Phyllis Ford', 'Evelyn Hamilton',
  'Lillian Graham', 'Rosa Sullivan', 'Tina Wallace', 'Peggy Woods', 'Wanda West',
  'Karen Jordan', 'Betty Owens', 'Annie Reynolds', 'Elaine Fisher', 'Roberta Ellis',
];

// ── Niche definitions by race ──
const NIGERIAN_NICHES = [
  'nigeria_news', 'afrobeats_music', 'nollywood', 'football',
  'nigerian_food_culture', 'african_tech', 'controversial_trending',
];

const CAUCASIAN_NICHES = [
  'science_technology', 'ai', 'space', 'gadgets', 'fashion_lifestyle',
  'nature_environment', 'animals_wildlife', 'health_fitness',
  'education_career', 'business_entrepreneurship', 'sports',
];

// ── Bot counts ──
const CAUCASIAN_CONTENT_BOTS = 230;
const CAUCASIAN_ENGAGEMENT_BOTS = 170;
const NIGERIAN_CONTENT_BOTS = 170;
const NIGERIAN_ENGAGEMENT_BOTS = 130;

const YORUBA_SHARE = 0.42;
const IGBO_SHARE = 0.42;
const ENGLISH_SHARE = 0.08;

// ── Locations ──
const CAUCASIAN_LOCATIONS = [
  'New York, USA', 'London, UK', 'Toronto, Canada', 'Sydney, Australia', 'Berlin, Germany',
  'Amsterdam, Netherlands', 'Dublin, Ireland', 'San Francisco, USA', 'Chicago, USA', 'Manchester, UK',
  'Los Angeles, USA', 'Melbourne, Australia', 'Vancouver, Canada', 'Seattle, USA', 'Austin, USA',
];
const NIGERIAN_LOCATIONS = ['Lagos, Nigeria', 'Abuja, Nigeria', 'Port Harcourt, Nigeria', 'Ibadan, Nigeria', 'Enugu, Nigeria', 'Kano, Nigeria'];

// ── Avatar pool ──
let avatarPool = { nigerian: { men: [], women: [] }, caucasian: { men: [], women: [] } };
try {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'avatar-pool.json'), 'utf-8'));
  if (raw.nigerian) {
    avatarPool = raw;
  } else if (raw.men && raw.women) {
    avatarPool.nigerian = { men: raw.men, women: raw.women };
  }
} catch (e) {
  console.warn('avatar-pool.json not found, falling back to randomuser.me');
}

// ── Helpers ──
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

function buildWeightedNigerianNames(totalNeeded) {
  const yorubaCount = Math.round(totalNeeded * YORUBA_SHARE);
  const igboCount = Math.round(totalNeeded * IGBO_SHARE);
  const englishCount = Math.round(totalNeeded * ENGLISH_SHARE);
  const hausaCount = totalNeeded - yorubaCount - igboCount - englishCount;

  const yoruba = expandGroup(yorubaMale, yorubaFemale, 'yoruba', yorubaCount, 11);
  const igbo = expandGroup(igboMale, igboFemale, 'igbo', igboCount, 23);
  const hausa = expandGroup(hausaMale, hausaFemale, 'hausa', hausaCount, 37);
  const english = expandGroup(englishMale, englishFemale, 'english', englishCount, 53);

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

function buildCaucasianNames(totalNeeded) {
  return expandGroup(caucasianMale, caucasianFemale, 'western', totalNeeded, 71);
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

const genderAvatarIndex = { nigerian_male: 0, nigerian_female: 0, caucasian_male: 0, caucasian_female: 0 };

function avatarFor(gender, race) {
  const key = `${race}_${gender}`;
  const racePool = race === 'caucasian' ? avatarPool.caucasian : avatarPool.nigerian;
  const pool = gender === 'male' ? racePool.men : racePool.women;
  if (pool && pool.length > 0) {
    const url = pool[genderAvatarIndex[key] % pool.length];
    genderAvatarIndex[key] += 1;
    return url;
  }
  const genderPath = gender === 'male' ? 'men' : 'women';
  const offset = race === 'caucasian' ? 0 : 50;
  const photoIndex = (genderAvatarIndex[key] % 50) + offset;
  genderAvatarIndex[key] += 1;
  return `https://randomuser.me/api/portraits/${genderPath}/${photoIndex}.jpg`;
}

function buildBio(name, isContentBot, race) {
  const first = name.split(' ')[0];
  if (race === 'caucasian') {
    if (isContentBot) return `${first} | Curious mind, sharing what I find 🌍`;
    return `${first} | Here for the good content`;
  }
  if (isContentBot) return `${first} | Sharing what catches my eye 👀 | Lagos, Nigeria`;
  return `${first} 🇳🇬 | Just here for the vibes`;
}

function pickLocation(race, seed) {
  const pool = race === 'caucasian' ? CAUCASIAN_LOCATIONS : NIGERIAN_LOCATIONS;
  return pool[Math.abs(seed) % pool.length];
}

function generate() {
  const usedUsernames = new Set();

  const nigerianTotal = NIGERIAN_CONTENT_BOTS + NIGERIAN_ENGAGEMENT_BOTS;
  const caucasianTotal = CAUCASIAN_CONTENT_BOTS + CAUCASIAN_ENGAGEMENT_BOTS;

  const nigerianNames = buildWeightedNigerianNames(nigerianTotal);
  const caucasianNames = buildCaucasianNames(caucasianTotal);

  const contentBots = [];
  const engagementBots = [];

  let globalIndex = 0;

  for (let i = 0; i < caucasianTotal; i++) {
    const entry = caucasianNames[i];
    const username = makeUsername(entry.name, usedUsernames);
    const email = makeEmail(username);
    const isContentBot = i < CAUCASIAN_CONTENT_BOTS;
    const persona = {
      email,
      username,
      full_name: entry.name.trim(),
      first_name: entry.name.trim().split(' ')[0],
      last_name: entry.name.trim().split(' ').slice(1).join(' ') || entry.name.trim().split(' ')[0],
      gender: entry.gender,
      ethnic_group: entry.group,
      race: 'caucasian',
      bio: buildBio(entry.name, isContentBot, 'caucasian'),
      avatar_url: avatarFor(entry.gender, 'caucasian'),
      role: isContentBot ? 'content' : 'engagement',
      location: pickLocation('caucasian', globalIndex),
      followers_count: randInt(globalIndex + 1, 330, 670),
      following_count: randInt(globalIndex + 17, 80, 300),
    };
    if (isContentBot) {
      persona.niche = CAUCASIAN_NICHES[i % CAUCASIAN_NICHES.length];
      contentBots.push(persona);
    } else {
      engagementBots.push(persona);
    }
    globalIndex++;
  }

  for (let i = 0; i < nigerianTotal; i++) {
    const entry = nigerianNames[i];
    const username = makeUsername(entry.name, usedUsernames);
    const email = makeEmail(username);
    const isContentBot = i < NIGERIAN_CONTENT_BOTS;
    const persona = {
      email,
      username,
      full_name: entry.name.trim(),
      first_name: entry.name.trim().split(' ')[0],
      last_name: entry.name.trim().split(' ').slice(1).join(' ') || entry.name.trim().split(' ')[0],
      gender: entry.gender,
      ethnic_group: entry.group,
      race: 'nigerian',
      bio: buildBio(entry.name, isContentBot, 'nigerian'),
      avatar_url: avatarFor(entry.gender, 'nigerian'),
      role: isContentBot ? 'content' : 'engagement',
      location: pickLocation('nigerian', globalIndex),
      followers_count: randInt(globalIndex + 1, 330, 670),
      following_count: randInt(globalIndex + 17, 80, 300),
    };
    if (isContentBot) {
      persona.niche = NIGERIAN_NICHES[i % NIGERIAN_NICHES.length];
      contentBots.push(persona);
    } else {
      engagementBots.push(persona);
    }
    globalIndex++;
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
  const csvHeader = 'role,race,full_name,username,gender,ethnic_group,niche,followers_count,following_count,avatar_url';
  const csvRows = roster.map((bot) =>
    [
      bot.role,
      bot.race,
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

  const allFollowers = roster.reduce((sum, bot) => sum + bot.followers_count, 0);
  const raceCounts = roster.reduce((acc, bot) => { acc[bot.race] = (acc[bot.race] || 0) + 1; return acc; }, {});
  const ethnicCounts = roster.reduce((acc, bot) => { acc[bot.ethnic_group] = (acc[bot.ethnic_group] || 0) + 1; return acc; }, {});
  console.log(`Generated ${contentBots.length} content bots and ${engagementBots.length} engagement bots (${roster.length} total)`);
  console.log(`Race split: ${JSON.stringify(raceCounts)}`);
  console.log(`Ethnic mix: ${JSON.stringify(ethnicCounts)}`);
  console.log(`Avg followers: ${Math.round(allFollowers / roster.length)}`);
  console.log(`Content bots — Caucasian: ${contentBots.filter(b => b.race === 'caucasian').length}, Nigerian: ${contentBots.filter(b => b.race === 'nigerian').length}`);
  console.log(`Engagement bots — Caucasian: ${engagementBots.filter(b => b.race === 'caucasian').length}, Nigerian: ${engagementBots.filter(b => b.race === 'nigerian').length}`);
}

generate();
