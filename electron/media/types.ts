export type MediaSite =
  | 'youtube'
  | 'instagram'
  | 'x'
  | 'linkedin'
  | 'reddit'
  | 'tiktok';

export type MediaEventKind =
  // YouTube
  | 'yt_video' | 'yt_short' | 'yt_channel_visit' | 'yt_search'
  | 'yt_playlist' | 'yt_home_browse' | 'yt_subs_browse'
  // Instagram
  | 'ig_feed_browse' | 'ig_profile_visit' | 'ig_reels_browse' | 'ig_reel'
  | 'ig_post_visit' | 'ig_explore_browse' | 'ig_hashtag_visit'
  | 'ig_dm_thread' | 'ig_dm_sent' | 'ig_search'
  // X
  | 'x_feed_browse' | 'x_profile_visit' | 'x_tweet_view' | 'x_search'
  | 'x_dm_thread' | 'x_community_visit' | 'x_explore_browse'
  | 'x_notifications_browse' | 'x_dm_sent' | 'x_tweet_drafted'
  // LinkedIn
  | 'li_feed_browse' | 'li_profile_visit' | 'li_company_visit'
  | 'li_jobs_browse' | 'li_job_view' | 'li_search' | 'li_post_view'
  | 'li_dm_thread' | 'li_dm_sent' | 'li_notifications_browse'
  | 'li_comment_drafted'
  // Reddit
  | 'rd_home_browse' | 'rd_sub_browse' | 'rd_post_view' | 'rd_user_visit'
  | 'rd_search' | 'rd_dm_browse' | 'rd_post_drafted' | 'rd_comment_drafted'
  // TikTok
  | 'tt_fyp_browse' | 'tt_profile_visit' | 'tt_video' | 'tt_topic_browse'
  | 'tt_search'
  // Generic catch-all
  | 'other_visit'
  | 'text_submit';

export type MediaEvent = {
  ts: number;
  kind: MediaEventKind;
  dwellMs?: number;
  url?: string;
  title?: string;
  // True when this is a yt_video / yt_short / tt_video session with dwell
  // ≥ 60s — i.e. user actively viewed long enough to count as watch history.
  watchHistory?: boolean;
  // Extracted IDs / params — varies by kind, all optional.
  videoId?: string;
  channelHandle?: string;
  channelName?: string;
  handle?: string;
  displayName?: string;
  postId?: string;
  reelId?: string;
  hashtag?: string;
  threadId?: string;
  otherHandle?: string;
  playlistId?: string;
  subreddit?: string;
  username?: string;
  jobId?: string;
  jobTitle?: string;
  company?: string;
  slug?: string;
  category?: string;
  topic?: string;
  tweetId?: string;
  author?: string;
  query?: string;
  text?: string;
  feed?: string;
};

export type MediaDayLog = {
  site: MediaSite;
  date: string;          // YYYY-MM-DD (local)
  startedAt: number;
  updatedAt: number;
  totalDwellMs: number;
  events: MediaEvent[];
};
