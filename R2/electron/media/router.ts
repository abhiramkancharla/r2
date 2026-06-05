import type { MediaSite, MediaEvent, MediaEventKind } from './types';

export type RoutedVisit = {
  site: MediaSite;
  kind: MediaEventKind;
  params: Partial<MediaEvent>;
};

// Map a URL (browser tab) to a media site + an event kind + extracted IDs.
// Returns null if the URL isn't a supported media site.
export function routeUrl(url: string | null, title: string | null): RoutedVisit | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname;
  const search = u.search;
  const t = title ?? '';

  // ------ YouTube ------
  if (host === 'youtube.com' || host === 'm.youtube.com' || host.endsWith('.youtube.com')) {
    const sp = u.searchParams;
    if (path === '/watch' && sp.get('v')) {
      return { site: 'youtube', kind: 'yt_video', params: { videoId: sp.get('v') ?? undefined, title: stripSuffix(t, ' - YouTube') } };
    }
    const shortM = path.match(/^\/shorts\/([^/]+)/);
    if (shortM) return { site: 'youtube', kind: 'yt_short', params: { videoId: shortM[1], title: stripSuffix(t, ' - YouTube') } };
    if (path === '/results' && sp.get('search_query')) {
      return { site: 'youtube', kind: 'yt_search', params: { query: sp.get('search_query') ?? undefined } };
    }
    const handleM = path.match(/^\/@([^/]+)/);
    if (handleM) return { site: 'youtube', kind: 'yt_channel_visit', params: { channelHandle: '@' + handleM[1], channelName: stripSuffix(t, ' - YouTube') } };
    const channelM = path.match(/^\/channel\/([^/]+)/);
    if (channelM) return { site: 'youtube', kind: 'yt_channel_visit', params: { channelHandle: channelM[1], channelName: stripSuffix(t, ' - YouTube') } };
    if (path === '/playlist' && sp.get('list')) {
      return { site: 'youtube', kind: 'yt_playlist', params: { playlistId: sp.get('list') ?? undefined, title: stripSuffix(t, ' - YouTube') } };
    }
    if (path === '/feed/subscriptions') return { site: 'youtube', kind: 'yt_subs_browse', params: {} };
    if (path === '/' || path === '/feed/home') return { site: 'youtube', kind: 'yt_home_browse', params: {} };
    return { site: 'youtube', kind: 'other_visit', params: { url } };
  }

  // ------ Instagram ------
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    if (path === '/' || path === '') return { site: 'instagram', kind: 'ig_feed_browse', params: {} };
    if (path === '/reels/' || path === '/reels') return { site: 'instagram', kind: 'ig_reels_browse', params: {} };
    const reelM = path.match(/^\/reels?\/([^/]+)/);
    if (reelM) return { site: 'instagram', kind: 'ig_reel', params: { reelId: reelM[1] } };
    if (path === '/explore/' || path === '/explore') return { site: 'instagram', kind: 'ig_explore_browse', params: {} };
    const tagM = path.match(/^\/explore\/tags\/([^/]+)/);
    if (tagM) return { site: 'instagram', kind: 'ig_hashtag_visit', params: { hashtag: tagM[1] } };
    const postM = path.match(/^\/p\/([^/]+)/);
    if (postM) return { site: 'instagram', kind: 'ig_post_visit', params: { postId: postM[1] } };
    const dmM = path.match(/^\/direct\/t\/([^/]+)/);
    if (dmM) return { site: 'instagram', kind: 'ig_dm_thread', params: { threadId: dmM[1], otherHandle: extractDmOtherHandle(t) } };
    if (path.startsWith('/direct')) return { site: 'instagram', kind: 'ig_dm_thread', params: { threadId: 'inbox' } };
    const profileM = path.match(/^\/([^/]+)\/?$/);
    if (profileM && !/^(accounts|reels|explore|direct|p|stories|reel)$/.test(profileM[1])) {
      return { site: 'instagram', kind: 'ig_profile_visit', params: { handle: profileM[1], displayName: stripSuffix(t, ' • Instagram') } };
    }
    return { site: 'instagram', kind: 'other_visit', params: { url } };
  }

  // ------ X / Twitter ------
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) {
    if (path === '/home' || path === '/') return { site: 'x', kind: 'x_feed_browse', params: { feed: 'home' } };
    if (path.startsWith('/explore')) return { site: 'x', kind: 'x_explore_browse', params: {} };
    if (path.startsWith('/notifications')) return { site: 'x', kind: 'x_notifications_browse', params: {} };
    const tweetM = path.match(/^\/([^/]+)\/status\/(\d+)/);
    if (tweetM) return { site: 'x', kind: 'x_tweet_view', params: { author: tweetM[1], tweetId: tweetM[2], title: stripSuffix(t, ' / X').trim() } };
    if (path === '/search' || path === '/search/') return { site: 'x', kind: 'x_search', params: { query: u.searchParams.get('q') ?? undefined } };
    const dmM = path.match(/^\/messages(?:\/(.+))?/);
    if (dmM) return { site: 'x', kind: 'x_dm_thread', params: { threadId: dmM[1] || 'inbox' } };
    const commM = path.match(/^\/i\/communities\/(\d+)/);
    if (commM) return { site: 'x', kind: 'x_community_visit', params: { threadId: commM[1] } };
    const profileM = path.match(/^\/([^/]+)\/?$/);
    if (profileM && !/^(home|explore|notifications|messages|i|compose|search|settings)$/.test(profileM[1])) {
      return { site: 'x', kind: 'x_profile_visit', params: { handle: profileM[1], displayName: stripSuffix(t, ' / X') } };
    }
    return { site: 'x', kind: 'other_visit', params: { url } };
  }

  // ------ LinkedIn ------
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    if (path.startsWith('/feed')) return { site: 'linkedin', kind: 'li_feed_browse', params: {} };
    const profileM = path.match(/^\/in\/([^/]+)/);
    if (profileM) return { site: 'linkedin', kind: 'li_profile_visit', params: { handle: profileM[1], displayName: stripSuffix(t, ' | LinkedIn').replace(/\s*\|.*$/, '') } };
    const companyM = path.match(/^\/company\/([^/]+)/);
    if (companyM) return { site: 'linkedin', kind: 'li_company_visit', params: { slug: companyM[1], company: stripSuffix(t, ' | LinkedIn') } };
    const jobViewM = path.match(/^\/jobs\/view\/(\d+)/);
    if (jobViewM) return { site: 'linkedin', kind: 'li_job_view', params: { jobId: jobViewM[1], jobTitle: stripSuffix(t, ' | LinkedIn') } };
    if (path.startsWith('/jobs')) return { site: 'linkedin', kind: 'li_jobs_browse', params: {} };
    if (path.startsWith('/search/results')) return { site: 'linkedin', kind: 'li_search', params: { query: u.searchParams.get('keywords') ?? undefined } };
    const postM = path.match(/^\/posts\/([^/]+)/);
    if (postM) return { site: 'linkedin', kind: 'li_post_view', params: { postId: postM[1] } };
    if (path.startsWith('/messaging')) return { site: 'linkedin', kind: 'li_dm_thread', params: { threadId: 'inbox' } };
    if (path.startsWith('/notifications')) return { site: 'linkedin', kind: 'li_notifications_browse', params: {} };
    return { site: 'linkedin', kind: 'other_visit', params: { url } };
  }

  // ------ Reddit ------
  if (host === 'reddit.com' || host === 'old.reddit.com' || host.endsWith('.reddit.com')) {
    if (path === '/' || path === '') return { site: 'reddit', kind: 'rd_home_browse', params: {} };
    const postM = path.match(/^\/r\/([^/]+)\/comments\/([^/]+)/);
    if (postM) return { site: 'reddit', kind: 'rd_post_view', params: { subreddit: postM[1], postId: postM[2], title: stripSuffix(t, ' : ' + postM[1]).replace(/ - Reddit$/, '') } };
    const subM = path.match(/^\/r\/([^/]+)\/?$/);
    if (subM) return { site: 'reddit', kind: 'rd_sub_browse', params: { subreddit: subM[1] } };
    const userM = path.match(/^\/user\/([^/]+)/);
    if (userM) return { site: 'reddit', kind: 'rd_user_visit', params: { username: userM[1] } };
    if (path === '/search' || path === '/search/') return { site: 'reddit', kind: 'rd_search', params: { query: u.searchParams.get('q') ?? undefined } };
    if (path.startsWith('/message')) return { site: 'reddit', kind: 'rd_dm_browse', params: {} };
    return { site: 'reddit', kind: 'other_visit', params: { url } };
  }

  // ------ TikTok ------
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    if (path === '/foryou' || path === '/' || path === '') return { site: 'tiktok', kind: 'tt_fyp_browse', params: {} };
    const videoM = path.match(/^\/@([^/]+)\/video\/(\d+)/);
    if (videoM) return { site: 'tiktok', kind: 'tt_video', params: { handle: '@' + videoM[1], videoId: videoM[2], title: stripSuffix(t, ' | TikTok') } };
    const profileM = path.match(/^\/@([^/]+)\/?$/);
    if (profileM) return { site: 'tiktok', kind: 'tt_profile_visit', params: { handle: '@' + profileM[1] } };
    const topicM = path.match(/^\/discover\/([^/]+)/);
    if (topicM) return { site: 'tiktok', kind: 'tt_topic_browse', params: { topic: topicM[1] } };
    if (path === '/search' || path.startsWith('/search')) return { site: 'tiktok', kind: 'tt_search', params: { query: u.searchParams.get('q') ?? undefined } };
    return { site: 'tiktok', kind: 'other_visit', params: { url } };
  }

  return null;
}

// When an AX sentence fires while the user is on a media site, the kind of
// event we should log depends on the current URL context.
export function routeSentence(url: string | null, _title: string | null): { site: MediaSite; kind: MediaEventKind } | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname;

  if (host.endsWith('youtube.com')) {
    if (path === '/results') return { site: 'youtube', kind: 'yt_search' };
    return { site: 'youtube', kind: 'text_submit' };
  }
  if (host.endsWith('instagram.com')) {
    if (path.startsWith('/direct')) return { site: 'instagram', kind: 'ig_dm_sent' };
    return { site: 'instagram', kind: 'ig_search' };
  }
  if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) {
    if (path.startsWith('/messages')) return { site: 'x', kind: 'x_dm_sent' };
    if (path === '/compose/tweet' || path.startsWith('/compose')) return { site: 'x', kind: 'x_tweet_drafted' };
    if (path === '/search' || path === '/search/') return { site: 'x', kind: 'x_search' };
    return { site: 'x', kind: 'text_submit' };
  }
  if (host.endsWith('linkedin.com')) {
    if (path.startsWith('/messaging')) return { site: 'linkedin', kind: 'li_dm_sent' };
    if (path.startsWith('/search/results')) return { site: 'linkedin', kind: 'li_search' };
    if (path.startsWith('/posts') || path.startsWith('/feed')) return { site: 'linkedin', kind: 'li_comment_drafted' };
    return { site: 'linkedin', kind: 'text_submit' };
  }
  if (host.endsWith('reddit.com')) {
    if (path === '/search' || path === '/search/') return { site: 'reddit', kind: 'rd_search' };
    if (/\/comments\//.test(path)) return { site: 'reddit', kind: 'rd_comment_drafted' };
    if (path.startsWith('/submit')) return { site: 'reddit', kind: 'rd_post_drafted' };
    return { site: 'reddit', kind: 'text_submit' };
  }
  if (host.endsWith('tiktok.com')) {
    if (path.startsWith('/search')) return { site: 'tiktok', kind: 'tt_search' };
    return { site: 'tiktok', kind: 'text_submit' };
  }
  return null;
}

function stripSuffix(s: string, suffix: string): string {
  if (s.endsWith(suffix)) return s.slice(0, s.length - suffix.length).trim();
  return s.trim();
}

// IG DM window titles look like "Inbox" or "Chat with someone (1) • Instagram"
function extractDmOtherHandle(title: string): string | undefined {
  const m = title.match(/Chat with (.+?)\s*(?:\(|•|$)/i);
  return m ? m[1].trim() : undefined;
}
