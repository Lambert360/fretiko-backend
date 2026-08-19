/**
 * Bot Avatar Generator
 * 
 * This script generates AI profile pictures for the bot personas.
 * 
 * Options:
 * 1. Use UI Avatars (Free, immediate) - Default
 * 2. Use DiceBear API (Free, generated avatars)
 * 3. Use Replicate API (AI-generated, requires API key)
 */

const fs = require('fs');
const path = require('path');

// Read bot personas
const personasPath = path.join(__dirname, 'bot-personas.json');
const personas = JSON.parse(fs.readFileSync(personasPath, 'utf8'));

// Option 1: UI Avatars (simple, color-coded)
function generateUIAvatar(persona) {
  const name = `${persona.first_name}+${persona.last_name}`;
  return `https://ui-avatars.com/api/?name=${name}&size=400&background=random&bold=true&format=png`;
}

// Option 2: DiceBear (more varied, artistic)
function generateDiceBearAvatar(persona) {
  const seed = persona.username;
  const style = 'avataaars'; // or 'big-smile', 'bottts', 'personas'
  return `https://api.dicebear.com/7.x/${style}/png?seed=${seed}&size=400`;
}

// Update personas with avatar URLs
personas.bots.forEach(bot => {
  // Use DiceBear for more natural looking avatars
  bot.avatar_url = generateDiceBearAvatar(bot);
  console.log(`✅ Generated avatar for ${bot.username}: ${bot.avatar_url}`);
});

// Save updated personas
fs.writeFileSync(personasPath, JSON.stringify(personas, null, 2));

console.log('\n✅ All bot avatars generated!');
console.log('\nNext steps:');
console.log('1. Restart the backend to create/update bot accounts');
console.log('2. (Optional) Replace with AI-generated avatars using Replicate API');

// Instructions for AI-generated avatars (advanced)
console.log('\n📝 To generate AI avatars with Replicate:');
console.log('npm install replicate');
console.log('Set REPLICATE_API_TOKEN environment variable');
console.log('Run: node generate-bot-avatars-ai.js');
