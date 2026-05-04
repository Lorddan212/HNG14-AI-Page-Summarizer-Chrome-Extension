(function attachSanitizer(global) {
  "use strict";

  const namespace = global.AiPageSummarizer || {};

  const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  const WHITESPACE = /\s+/g;
  const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
  const TRACKING_PARAMS = [
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
    "utm_campaign",
    "utm_content",
    "utm_medium",
    "utm_source",
    "utm_term"
  ];

  function sanitizeText(value, maxLength) {
    const safeMaxLength = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 0;
    const normalized = String(value || "")
      .replace(CONTROL_CHARS, " ")
      .replace(WHITESPACE, " ")
      .trim();

    if (!safeMaxLength || normalized.length <= safeMaxLength) {
      return normalized;
    }

    return `${normalized.slice(0, safeMaxLength).trim()}... [truncated]`;
  }

  function sanitizeMultilineText(value, maxLength) {
    const safeMaxLength = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : 0;
    const normalized = String(value || "")
      .replace(CONTROL_CHARS, " ")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(WHITESPACE, " ").trim())
      .filter(Boolean)
      .join("\n\n");

    if (!safeMaxLength || normalized.length <= safeMaxLength) {
      return normalized;
    }

    return `${normalized.slice(0, safeMaxLength).trim()}... [truncated]`;
  }

  function countWords(value) {
    const text = sanitizeText(value);
    return Array.from(text.matchAll(WORD_PATTERN)).length;
  }

  function estimateReadingTime(wordCount, wordsPerMinute) {
    const constants = namespace.Constants || {};
    const rate = wordsPerMinute || constants.WORDS_PER_MINUTE || 220;
    const minutes = Math.max(1, Math.ceil(Number(wordCount || 0) / rate));
    return `${minutes} min read`;
  }

  function truncateText(value, maxLength) {
    return sanitizeMultilineText(value, maxLength);
  }

  function isHttpUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (error) {
      return false;
    }
  }

  function normalizeUrlForCache(url) {
    try {
      const parsed = new URL(String(url || ""));
      parsed.hash = "";
      TRACKING_PARAMS.forEach((param) => parsed.searchParams.delete(param));
      return parsed.toString();
    } catch (error) {
      return sanitizeText(url, 500);
    }
  }

  function makeCacheKey(url, mode) {
    const constants = namespace.Constants || {};
    const summaryModes = constants.SUMMARY_MODES || {};
    const selectedMode = mode || summaryModes.STANDARD || "standard";
    return `${normalizeUrlForCache(url)}::${selectedMode}`;
  }

  function safeHostname(url) {
    try {
      return new URL(String(url || "")).hostname;
    } catch (error) {
      return "";
    }
  }

  function escapeRegExp(value) {
    return sanitizeText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function uniqueList(values, maxItems, maxLength) {
    const seen = new Set();
    const output = [];

    (Array.isArray(values) ? values : [values]).forEach((value) => {
      const text = sanitizeText(value, maxLength || 280);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) {
        return;
      }

      seen.add(key);
      output.push(text);
    });

    return output.slice(0, maxItems || output.length);
  }

  function splitIntoBullets(value, maxItems) {
    const text = sanitizeMultilineText(value);
    if (!text) {
      return [];
    }

    const lineItems = text
      .split(/\n+|(?:^|\s)(?:[-*]|[0-9]+[.)])\s+/)
      .map((item) => sanitizeText(item, 320))
      .filter((item) => item.length > 8);

    if (lineItems.length > 1) {
      return uniqueList(lineItems, maxItems || 6, 320);
    }

    const sentences = text
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((sentence) => sanitizeText(sentence, 320))
      .filter((sentence) => sentence.length > 8) || [];

    return uniqueList(sentences, maxItems || 6, 320);
  }

  namespace.Sanitizer = Object.freeze({
    sanitizeText,
    sanitizeMultilineText,
    countWords,
    estimateReadingTime,
    truncateText,
    isHttpUrl,
    normalizeUrlForCache,
    makeCacheKey,
    safeHostname,
    escapeRegExp,
    uniqueList,
    splitIntoBullets
  });

  global.AiPageSummarizer = namespace;
})(globalThis);
