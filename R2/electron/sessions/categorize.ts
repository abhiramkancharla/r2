import type { SessionEventKind } from './types';

// Pure deterministic categorization. No LLM, no inference.
// Order matters — first match wins. ai_chat checked before browser so that
// ChatGPT-in-Chrome lands under ai_chat, not generic browser.

type Input = {
  app: string | null;
  title: string | null;
  url: string | null;
  bundleId?: string | null;
};

const AI_CHAT_TITLE = /(chatgpt|claude|gemini|perplexity|copilot\.microsoft|poe\.com|mistral|grok)/i;
const AI_CHAT_URL = /(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|perplexity\.ai|poe\.com|copilot\.microsoft\.com|grok\.com|x\.ai)/i;
const AI_CHAT_BUNDLE = /(openai|anthropic|claude|chatgpt)/i;

const CODING_APPS = /^(Cursor|Code|Visual Studio Code|Xcode|Sublime Text|IntelliJ IDEA|PyCharm|WebStorm|GoLand|RubyMine|Android Studio|Zed|Nova|Fleet|Terminal|iTerm2|Warp|Ghostty|Alacritty|Kitty|Hyper)$/i;

const BROWSER_APPS = /^(Google Chrome|Safari|Arc|Firefox|Microsoft Edge|Brave Browser|Opera|Vivaldi|Chromium|DuckDuckGo Browser|Orion)$/i;

const MESSAGING_APPS = /^(Slack|Discord|Messages|Telegram|WhatsApp|Signal|Microsoft Teams|Zoom|Skype|Element|iMessage)$/i;
const MESSAGING_URL = /(slack\.com|discord\.com|web\.whatsapp\.com|web\.telegram\.org|messages\.google\.com|teams\.microsoft\.com|instagram\.com\/direct|x\.com\/messages|messenger\.com)/i;

const NOTES_APPS = /^(Notion|Obsidian|Notes|Bear|Craft|Logseq|Roam|Apple Notes|Evernote|UpNote|Reflect)$/i;
const NOTES_URL = /(notion\.so|obsidian\.md|roamresearch\.com|reflect\.app|craft\.do)/i;

const DESIGN_APPS = /^(Figma|Sketch|Adobe Photoshop|Photoshop|Adobe Illustrator|Illustrator|Adobe XD|Affinity Designer|Affinity Photo|Pixelmator Pro|Procreate)$/i;
const DESIGN_URL = /(figma\.com|sketch\.com)/i;

const MEDIA_APPS = /^(Spotify|Music|TV|Apple Music|VLC|IINA|QuickTime Player|Netflix|YouTube|Plex|Vinyl|Sonos)$/i;
const MEDIA_URL = /(youtube\.com|netflix\.com|hulu\.com|disneyplus\.com|spotify\.com|music\.apple\.com|hbomax\.com|primevideo\.com|twitch\.tv)/i;

const SEARCH_URL = /(google\.com\/search|duckduckgo\.com\/?\?|bing\.com\/search|kagi\.com\/search|youtube\.com\/results)/i;

const SOCIAL_URL = /(twitter\.com|x\.com|reddit\.com|instagram\.com|tiktok\.com|threads\.net|bsky\.app|linkedin\.com|facebook\.com|mastodon)/i;

const MAIL_APPS = /^(Mail|Spark|Superhuman|Airmail|Outlook|Microsoft Outlook|HEY)$/i;
const MAIL_URL = /(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|hey\.com|fastmail\.com)/i;

export function categorize(input: Input): string {
  const app = input.app ?? '';
  const title = input.title ?? '';
  const url = input.url ?? '';
  const bundle = input.bundleId ?? '';
  const haystack = `${title} ${url} ${app}`;

  // AI chat first (overrides browser when ChatGPT etc is in a tab)
  if (AI_CHAT_BUNDLE.test(bundle) || AI_CHAT_URL.test(url) || AI_CHAT_TITLE.test(title)) {
    return 'ai_chat';
  }

  if (CODING_APPS.test(app)) return 'coding';

  if (MESSAGING_APPS.test(app) || MESSAGING_URL.test(haystack)) return 'messaging';

  if (NOTES_APPS.test(app) || NOTES_URL.test(haystack)) return 'notes';

  if (DESIGN_APPS.test(app) || DESIGN_URL.test(haystack)) return 'design';

  if (MAIL_APPS.test(app) || MAIL_URL.test(haystack)) return 'mail';

  if (MEDIA_APPS.test(app) || MEDIA_URL.test(haystack)) return 'media';

  // Within-browser context shows up via URL even if app isn't classified above
  if (SEARCH_URL.test(url)) return 'search';
  if (SOCIAL_URL.test(haystack)) return 'social';

  if (BROWSER_APPS.test(app)) return 'browser';

  return 'unknown';
}

// Sub-classify an explicit submission event based on the current session
// context. Keeps event.kind precise so consumers don't need to re-derive.
export function classifySubmission(category: string, url: string | null, title: string | null): SessionEventKind {
  if (category === 'ai_chat') return 'ai_message';
  if (category === 'messaging') return 'message_sent';
  if (category === 'notes') return 'note_saved';
  if (category === 'search') return 'search_query';
  if (category === 'browser') {
    // browser without search/social hits — could still be a search if title hints
    if (url && SEARCH_URL.test(url)) return 'search_query';
    if (title && /youtube/i.test(title) && url && /youtube\.com/i.test(url)) return 'search_query';
  }
  return 'submit';
}
