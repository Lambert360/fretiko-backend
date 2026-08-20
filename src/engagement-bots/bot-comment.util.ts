const STOPWORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'have', 'been', 'were', 'they', 'them',
  'their', 'what', 'when', 'where', 'which', 'while', 'about', 'after', 'before',
  'just', 'like', 'into', 'over', 'your', 'you', 'are', 'was', 'for', 'and', 'but',
  'not', 'all', 'any', 'can', 'had', 'has', 'his', 'her', 'she', 'him', 'its',
  'our', 'out', 'who', 'how', 'why', 'will', 'would', 'could', 'should', 'than',
  'then', 'too', 'very', 'also', 'more', 'some', 'such', 'only', 'other', 'new',
  'one', 'two', 'via', 'rss', 'http', 'https', 'www', 'com',
]);

const GENERIC_COMMENT = /^(nice one|great post|this is fire|love this|facts!?|correct!?|wow!?|interesting take|good stuff|thanks for sharing|i like this|chai, this is interesting)\b/i;

export function cleanPostText(content: string): string {
  return (content || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[#@]\w+/g, ' ')
    .replace(/📷[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function postTitle(content: string): string {
  const first = (content || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
  return cleanPostText(first);
}

export function extractDetails(content: string): string[] {
  const text = cleanPostText(content);
  if (!text) return [];

  const details: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const value = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').trim();
    if (value.length < 3 || value.length > 48) return;
    const key = value.toLowerCase();
    if (seen.has(key) || STOPWORDS.has(key)) return;
    seen.add(key);
    details.push(value);
  };

  for (const match of text.match(/"([^"]{3,48})"/g) || []) {
    push(match.replace(/"/g, ''));
  }

  for (const match of text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/g) || []) {
    push(match);
  }

  for (const match of text.match(/\b\d+(?:\.\d+)?(?:\s?[-–]\s?\d+)?(?:%|k|m)?\b/gi) || []) {
    push(match);
  }

  return details.slice(0, 8);
}

export function snippetFromPost(content: string, maxWords = 8): string {
  const title = postTitle(content);
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return title;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

export function sanitizeComment(raw: string, content: string): string | null {
  let text = (raw || '').trim();
  if (!text) return null;

  text = text.replace(/^["'`“”]+|["'`“”]+$/g, '');
  text = text.replace(/^(comment|reply)\s*:\s*/i, '');
  text = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  text = text.replace(/https?:\/\/\S+/gi, '').replace(/#\w+/g, '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'`“”]+|["'`“”]+$/g, '');

  if (text.length < 8) return null;
  if (text.length > 180) {
    text = `${text.slice(0, 177).replace(/\s+\S*$/, '')}…`;
  }

  if (GENERIC_COMMENT.test(text) && extractDetails(content).length > 0) {
    return null;
  }

  return text;
}

function pick<T>(items: T[], seed: number): T {
  return items[Math.abs(seed) % items.length];
}

export function fallbackComment(content: string, seed = 0): string {
  const snippet = snippetFromPost(content);
  const details = extractDetails(content);
  const detail = details[0] || snippet;
  const second = details[1];

  const options = [
    `This gist about ${detail} no be small thing.`,
    `I had to pause at "${snippet}".`,
    `So ${detail} is really the story here? Okay.`,
    `${detail} sef… I no expect this one at all.`,
    `The way them talk ${detail} here is actually important.`,
    `People go still dey argue ${detail} by tomorrow.`,
  ];

  if (second) {
    options.push(`${detail} and ${second} in one post? Make una sit down.`);
    options.push(`I get the ${detail} part, but ${second} is what surprised me.`);
  }

  if (snippet && snippet !== detail) {
    options.push(`"${snippet}" — this one actually concerns us.`);
  }

  return pick(options, seed);
}

export function fallbackReply(content: string, parentComment: string, seed = 0): string {
  const detail = extractDetails(content)[0] || snippetFromPost(content);
  const parentBit = cleanPostText(parentComment).split(/\s+/).slice(0, 6).join(' ');
  const options = [
    `True, especially with ${detail}.`,
    `That’s why ${detail} no go just die down.`,
    `You mentioned "${parentBit}" — that’s the exact point on ${detail}.`,
    `I dey with you on that, ${detail} too obvious here.`,
  ];
  return pick(options, seed);
}

export function buildCommentPrompt(content: string, parentComment?: string): { system: string; user: string } {
  const system = [
    'You write one short social comment as a young Nigerian on Fretiko.',
    'React to a concrete detail in the post (person, place, event, claim, score, food, team, or vibe).',
    'One sentence, max 140 characters. Light Nigerian English or Pidgin is fine.',
    'No hashtags, no URLs, no quotation marks wrapping the whole comment, at most one emoji.',
    'Do not write generic praise like "great post", "nice one", "this is fire", or "love this".',
  ].join(' ');

  if (parentComment) {
    return {
      system,
      user: `Original post:\n${content.slice(0, 700)}\n\nSomeone commented:\n${parentComment.slice(0, 220)}\n\nWrite a reply that agrees or adds a thought, still about the post. Return only the reply.`,
    };
  }

  return {
    system,
    user: `Post:\n${content.slice(0, 700)}\n\nWrite one comment that clearly refers to this post. Return only the comment.`,
  };
}
