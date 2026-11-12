// Shared by the server and the browser: turns a draft containing @[Name]
// tokens into the right text for each platform.

export const PLATFORMS = ['bluesky', 'linkedin', 'mastodon', 'x'];
export const LABELS = { bluesky: 'Bluesky', linkedin: 'LinkedIn', mastodon: 'Mastodon', x: 'X' };
export const LIMITS = { bluesky: 300, linkedin: 3000, mastodon: 500, x: 280 };

const TOKEN = /@\[([^\[\]\n]+)\]/g;
const URL_RE = /https?:\/\/[^\s]+/g;

/** Names of everyone mentioned in a draft. */
export function mentionedNames(text) {
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1].trim()))];
}

/** How a person appears in a post on one platform. */
export function mentionText(platform, person) {
  const profile = person.profiles?.[platform];
  if (!profile) return person.name;
  // LinkedIn has no text syntax for mentions, so use their name as shown there.
  if (platform === 'linkedin') return profile.displayName || person.name;
  return '@' + profile.handle;
}

/**
 * @param people array of { name, profiles: { [platform]: profile } }
 * @returns { text, mentions: [{ start, end, name, person, profile }] }
 *   start/end are string offsets into the returned text.
 *   profile is null when the person has no profile on this platform.
 */
export function render(text, platform, people) {
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p]));
  const mentions = [];
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const person = byName.get(m[1].trim().toLowerCase());
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    const start = out.length;
    out += person ? mentionText(platform, person) : m[1].trim();
    mentions.push({
      start,
      end: out.length,
      name: m[1].trim(),
      person: person || null,
      profile: person?.profiles?.[platform] || null,
    });
  }
  out += text.slice(last);
  return { text: out, mentions };
}

const graphemes = (s) => [...new Intl.Segmenter().segment(s)].length;
const shortUrls = (s) => s.replace(URL_RE, 'x'.repeat(23));

/** Approximate length as each platform counts it. */
export function count(platform, text) {
  if (platform === 'bluesky') return graphemes(text);
  if (platform === 'x') return [...shortUrls(text)].length;
  if (platform === 'mastodon') {
    // Links count as 23; the @domain part of a mention is free.
    return graphemes(shortUrls(text).replace(/(@[\w.-]+)@[\w.-]+/g, '$1'));
  }
  return text.length;
}
