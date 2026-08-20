/**
 * Generates the full bot network personas: 100 content bots + 200 engagement bots.
 * Names are drawn from curated Hausa, Igbo, Yoruba, and English (Nigerian-common) pools.
 * Avatars use randomuser.me real portrait photos (male/female pools), cycled by index.
 * Run: node scripts/generate-bot-network.js
 * Output: content-bots.json, engagement-bots.json
 */
const fs = require('fs');
const path = require('path');

const hausaMale = ['Mohammed Adamu', 'Ibrahim Musa', 'Abubakar Sani', 'Aliyu Garba', 'Yusuf Bello', 'Nuhu Danjuma', 'Sani Abdullahi', 'Umar Farouk', 'Lawal Shehu', 'Auwal Ibrahim', 'Tanko Suleiman', 'Bashir Yakubu'];
const hausaFemale = ['Amina Sule', 'Zainab Umar', 'Hauwa Bello', 'Fatima Abubakar', 'Halima Aliyu', 'Aisha Garba', 'Rabi Musa', 'Maryam Danjuma', 'Safiya Lawal', 'Hadiza Shehu', 'Rukayya Ibrahim', 'Jamila Sani'];

const igboMale = ['Chukwuemeka Obi', 'Emeka Nwachukwu', 'Chidi Okafor', 'Ikechukwu Eze', 'Obinna Chukwu', 'Chibueze Nnamdi', 'Kelechi Okonkwo', 'Ugochukwu Anyanwu', 'Chinedu Okoye', 'Nnamdi Achebe', 'Ifeanyi Uzoma', 'Uchenna Onyekwere'];
const igboFemale = ['Chinasa Ezugo', 'Ngozi Chukwu', 'Adaeze Okafor', 'Chiamaka Nwosu', 'Ifeoma Eze', 'Amarachi Obi', 'Uchechi Anyanwu', 'Chidinma Okonkwo', 'Nkechi Nnamdi', 'Ogechi Achebe', 'Kelechi Uzoma', 'Chiazor Onyekwere'];

const yorubaMale = ['Adewale Adenuga', 'Oluwaseun Ojo', 'Babatunde Fashola', 'Adeyemi Ogundele', 'Olumide Bankole', 'Kayode Afolabi', 'Segun Adeyinka', 'Femi Oyelaran', 'Tunde Balogun', 'Wale Adisa', 'Ayodele Fagbenle', 'Damilare Oyewole'];
const yorubaFemale = ['Adeola Fashola', 'Folake Ojo', 'Bukola Ogundele', 'Yetunde Bankole', 'Omolara Afolabi', 'Temitope Adeyinka', 'Aduke Oyelaran', 'Ronke Balogun', 'Abisola Adisa', 'Kemi Fagbenle', 'Titilayo Oyewole', 'Morenike Adenuga'];

const englishMale = ['Charles Francis', 'David Johnson', 'Michael Brown', 'Samuel Edwards', 'Daniel Okoye', 'Peter Williams', 'Victor Anthony', 'Emmanuel Roberts', 'Joseph Bassey', 'Richard Etim'];
const englishFemale = ['Grace Williams', 'Patience Edwards', 'Mercy Johnson', 'Blessing Brown', 'Comfort Roberts', 'Faith Anthony', 'Joy Bassey', 'Precious Etim', 'Gift Francis', 'Peace Daniels'];

const niches = ['science_technology', 'ai', 'space', 'gadgets', 'fashion_lifestyle', 'nature_environment', 'animals_wildlife'];

function buildNamePool() {
  const pool = [];
  const groups = [
    { names: hausaMale, gender: 'male', group: 'hausa' },
    { names: hausaFemale, gender: 'female', group: 'hausa' },
    { names: igboMale, gender: 'male', group: 'igbo' },
    { names: igboFemale, gender: 'female', group: 'igbo' },
    { names: yorubaMale, gender: 'male', group: 'yoruba' },
    { names: yorubaFemale, gender: 'female', group: 'yoruba' },
    { names: englishMale, gender: 'male', group: 'english' },
    { names: englishFemale, gender: 'female', group: 'english' },
  ];
  for (const g of groups) {
    for (const name of g.names) {
      pool.push({ name, gender: g.gender, group: g.group });
    }
  }
  return pool;
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

function avatarFor(gender, index) {
  const genderPath = gender === 'male' ? 'men' : 'women';
  const photoIndex = index % 100;
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
  const namePool = buildNamePool();
  const usedUsernames = new Set();
  const totalNeeded = 300;

  // Repeat/shuffle-cycle the pool deterministically to reach 300 unique full names
  // by appending a Nigerian middle initial pattern when the base pool is exhausted.
  const extendedNames = [];
  let cycle = 0;
  while (extendedNames.length < totalNeeded) {
    for (const entry of namePool) {
      if (extendedNames.length >= totalNeeded) break;
      const suffix = cycle === 0 ? '' : ` ${String.fromCharCode(65 + (cycle % 26))}.`;
      extendedNames.push({ ...entry, name: `${entry.name}${suffix}` });
    }
    cycle++;
  }

  const contentBots = [];
  const engagementBots = [];

  for (let i = 0; i < totalNeeded; i++) {
    const entry = extendedNames[i];
    const username = makeUsername(entry.name, usedUsernames);
    const email = makeEmail(username);
    const isContentBot = i < 100;
    const persona = {
      email,
      username,
      full_name: entry.name.trim(),
      first_name: entry.name.trim().split(' ')[0],
      last_name: entry.name.trim().split(' ').slice(1).join(' ') || entry.name.trim().split(' ')[0],
      gender: entry.gender,
      ethnic_group: entry.group,
      bio: buildBios(entry.name, isContentBot),
      avatar_url: avatarFor(entry.gender, i),
    };

    if (isContentBot) {
      persona.niche = niches[i % niches.length];
      persona.role = 'content';
      contentBots.push(persona);
    } else {
      persona.role = 'engagement';
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

  console.log(`Generated ${contentBots.length} content bots and ${engagementBots.length} engagement bots`);
}

generate();
