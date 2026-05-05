(function attachConstants(global) {
  "use strict";

  const namespace = global.AiPageSummarizer || {};

  const MESSAGE_TYPES = Object.freeze({
    PING: "AI_PAGE_SUMMARIZER_PING",
    EXTRACT_PAGE_CONTENT: "AI_PAGE_SUMMARIZER_EXTRACT_PAGE_CONTENT",
    SUMMARIZE_PAGE: "AI_PAGE_SUMMARIZER_SUMMARIZE_PAGE",
    HIGHLIGHT_KEY_POINTS: "AI_PAGE_SUMMARIZER_HIGHLIGHT_KEY_POINTS",
    CLEAR_HIGHLIGHTS: "AI_PAGE_SUMMARIZER_CLEAR_HIGHLIGHTS"
  });

  const STORAGE_KEYS = Object.freeze({
    CACHE: "aiPageSummarizer.cache.v1",
    SETTINGS: "aiPageSummarizer.settings.v1",
    LAST_SUMMARY: "aiPageSummarizer.lastSummary.v1"
  });

  const SUMMARY_BULLET_COUNTS = Object.freeze([3, 5, 7]);

  const DEFAULT_SETTINGS = Object.freeze({
    apiEndpoint: "http://localhost:8787/api/summarize",
    summaryBulletCount: 5,
    theme: "light"
  });

  namespace.Constants = Object.freeze({
    APP_NAME: "AI Page Summarizer",
    API_TIMEOUT_MS: 25000,
    CACHE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
    MAX_CACHE_ENTRIES: 40,
    MAX_EXTRACTED_CHARS: 45000,
    MAX_API_CHARS: 14000,
    MAX_HIGHLIGHTS: 8,
    MIN_WORD_COUNT: 30,
    WORDS_PER_MINUTE: 220,
    HIGHLIGHT_CLASS: "ai-page-summarizer-highlight",
    HIGHLIGHT_STYLE_ID: "ai-page-summarizer-highlight-style",
    MESSAGE_TYPES,
    STORAGE_KEYS,
    SUMMARY_BULLET_COUNTS,
    DEFAULT_SETTINGS
  });

  global.AiPageSummarizer = namespace;
})(globalThis);
