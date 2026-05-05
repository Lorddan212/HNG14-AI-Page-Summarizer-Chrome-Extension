importScripts(
  "/utils/constants.js",
  "/utils/sanitizer.js",
  "/utils/storage.js"
);

(function registerServiceWorker(global) {
  "use strict";

  const namespace = global.AiPageSummarizer || {};
  const constants = namespace.Constants;
  const sanitizer = namespace.Sanitizer;
  const storage = namespace.Storage;
  const MESSAGE_TYPES = constants.MESSAGE_TYPES;
  const SUMMARY_MODES = constants.SUMMARY_MODES;

  function responseOk(payload) {
    return { ok: true, ...payload };
  }

  function responseError(message) {
    return {
      ok: false,
      error: sanitizer.sanitizeText(message || "The summary could not be generated.", 320)
    };
  }

  function validatePageContent(extraction) {
    if (!extraction || typeof extraction !== "object") {
      throw new Error("Missing page content.");
    }

    if (!sanitizer.isHttpUrl(extraction.url)) {
      throw new Error("This page type cannot be summarized. Try a normal http or https webpage.");
    }

    const text = sanitizer.sanitizeMultilineText(extraction.text, constants.MAX_EXTRACTED_CHARS);
    const wordCount = Number(extraction.wordCount || sanitizer.countWords(text));

    if (!text || wordCount < constants.MIN_WORD_COUNT) {
      throw new Error("No readable content was found on this page.");
    }

    return {
      title: sanitizer.sanitizeText(extraction.title || "Untitled page", 180),
      url: sanitizer.normalizeUrlForCache(extraction.url),
      text,
      wordCount,
      readingTime: extraction.readingTime || sanitizer.estimateReadingTime(wordCount),
      isTruncated: Boolean(extraction.isTruncated)
    };
  }

  function normalizeSummaryMode(mode) {
    return Object.values(SUMMARY_MODES).includes(mode) ? mode : SUMMARY_MODES.STANDARD;
  }

  function buildPrompt(extraction, mode) {
    const bulletInstruction = mode === SUMMARY_MODES.BRIEF
      ? "Write exactly 3 concise summary bullet points."
      : "Write 4 to 6 concise summary bullet points.";

    return [
      "You are an AI page summarizer for a Chrome Extension.",
      "Use only the page content provided by the user.",
      bulletInstruction,
      "Also return 3 key insights.",
      "Return strict JSON only, with no markdown fences or commentary.",
      "The JSON shape must be:",
      "{\"summary\":[\"bullet point\"],\"keyInsights\":[\"insight\"],\"readingTime\":\"4 min read\",\"wordCount\":850}",
      "",
      `Title: ${extraction.title}`,
      `URL: ${extraction.url}`,
      `Original word count: ${extraction.wordCount}`,
      `Estimated reading time: ${extraction.readingTime}`,
      "",
      "Page content:",
      sanitizer.truncateText(extraction.text, constants.MAX_API_CHARS)
    ].join("\n");
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, {
      ...options,
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));
  }

  async function safeReadResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    const rawText = await response.text();

    if (contentType.includes("application/json")) {
      try {
        return JSON.parse(rawText);
      } catch (error) {
        return rawText;
      }
    }

    return rawText;
  }

  function getErrorDetail(data) {
    if (typeof data === "string") {
      return sanitizer.sanitizeText(data, 240);
    }

    if (data && typeof data === "object") {
      const message = data.error || data.message || data.detail || data.details;
      if (typeof message === "string") {
        return sanitizer.sanitizeText(message, 240);
      }

      if (message && typeof message === "object") {
        return sanitizer.sanitizeText(JSON.stringify(message), 240);
      }
    }

    return "";
  }

  async function requestAiSummary(endpoint, extraction, mode) {
    const prompt = buildPrompt(extraction, mode);
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt,
        content: sanitizer.truncateText(extraction.text, constants.MAX_API_CHARS),
        page: {
          title: extraction.title,
          url: extraction.url,
          wordCount: extraction.wordCount,
          readingTime: extraction.readingTime
        },
        options: {
          mode,
          responseFormat: "json"
        }
      })
    }, constants.API_TIMEOUT_MS);

    const data = await safeReadResponse(response);
    if (!response.ok) {
      const detail = getErrorDetail(data);
      throw new Error(`AI proxy failed with HTTP ${response.status}.${detail ? ` ${detail}` : ""}`);
    }

    return data;
  }

  function extractContentStringFromObject(value) {
    if (!value || typeof value !== "object") {
      return "";
    }

    if (typeof value.content === "string") {
      return value.content;
    }

    if (typeof value.text === "string") {
      return value.text;
    }

    if (typeof value.output === "string") {
      return value.output;
    }

    if (typeof value.response === "string") {
      return value.response;
    }

    const choiceContent = value.choices?.[0]?.message?.content || value.choices?.[0]?.text;
    if (typeof choiceContent === "string") {
      return choiceContent;
    }

    return "";
  }

  function parseJsonFromText(text) {
    const cleaned = sanitizer.sanitizeMultilineText(text)
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");

      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        } catch (innerError) {
          return null;
        }
      }
    }

    return null;
  }

  function coerceList(value, maxItems) {
    if (Array.isArray(value)) {
      return sanitizer.uniqueList(value, maxItems, 320);
    }

    if (typeof value === "string") {
      return sanitizer.splitIntoBullets(value, maxItems);
    }

    return [];
  }

  function normalizeAiResult(rawResult, extraction, mode) {
    const maxSummaryItems = mode === SUMMARY_MODES.BRIEF ? 3 : 6;
    let result = rawResult;
    let plainText = "";

    if (typeof rawResult === "string") {
      plainText = rawResult;
      result = parseJsonFromText(rawResult);
    } else if (rawResult && typeof rawResult === "object") {
      if (rawResult.result && typeof rawResult.result === "object") {
        result = rawResult.result;
      } else if (rawResult.data && typeof rawResult.data === "object") {
        result = rawResult.data;
      } else {
        plainText = extractContentStringFromObject(rawResult);
        const parsedTextResult = plainText ? parseJsonFromText(plainText) : null;
        if (parsedTextResult) {
          result = parsedTextResult;
        } else if (plainText) {
          result = null;
        }
      }
    }

    if (!result || typeof result !== "object") {
      const bullets = sanitizer.splitIntoBullets(plainText || String(rawResult || ""), maxSummaryItems + 3);
      const fallbackSummary = bullets.slice(0, maxSummaryItems).length
        ? bullets.slice(0, maxSummaryItems)
        : ["The AI proxy returned text, but it could not be parsed into useful summary bullets."];
      const fallbackInsights = bullets.slice(maxSummaryItems, maxSummaryItems + 3).length
        ? bullets.slice(maxSummaryItems, maxSummaryItems + 3)
        : fallbackSummary.slice(0, 3);

      return {
        summary: fallbackSummary,
        keyInsights: fallbackInsights,
        readingTime: extraction.readingTime,
        wordCount: extraction.wordCount,
        generatedAt: new Date().toISOString()
      };
    }

    const summary = coerceList(result.summary, maxSummaryItems);
    const keyInsights = coerceList(result.keyInsights || result.insights || result.key_points, 3);

    return {
      summary: summary.length ? summary : ["The AI proxy returned a response, but it did not include summary bullets."],
      keyInsights: keyInsights.length ? keyInsights : summary.slice(0, 3),
      readingTime: sanitizer.sanitizeText(result.readingTime || extraction.readingTime, 40),
      wordCount: Number(result.wordCount || extraction.wordCount),
      generatedAt: new Date().toISOString()
    };
  }

  async function handleSummarizeMessage(payload) {
    const extraction = validatePageContent(payload?.extraction);
    const mode = normalizeSummaryMode(payload?.summaryMode);
    const cached = await storage.getCachedSummary(extraction.url, mode);

    if (cached?.result) {
      return responseOk({
        result: cached.result,
        cached: true
      });
    }

    const settings = await storage.getSettings();
    const endpoint = sanitizer.sanitizeText(settings.apiEndpoint, 600);

    if (!sanitizer.isHttpUrl(endpoint)) {
      throw new Error("Configure a valid http or https AI proxy endpoint in the popup settings.");
    }

    let aiResponse;
    try {
      aiResponse = await requestAiSummary(endpoint, extraction, mode);
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("The AI proxy timed out. Try again or increase the proxy reliability.");
      }

      throw error;
    }

    const result = normalizeAiResult(aiResponse, extraction, mode);
    const entry = await storage.setCachedSummary(extraction.url, mode, result, {
      title: extraction.title,
      wordCount: extraction.wordCount
    });

    await storage.setLastSummary({
      url: extraction.url,
      title: extraction.title,
      mode,
      result
    });

    return responseOk({
      result: entry.result,
      cached: false
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object" || message.type !== MESSAGE_TYPES.SUMMARIZE_PAGE) {
      return false;
    }

    (async () => {
      try {
        const response = await handleSummarizeMessage(message.payload || {});
        sendResponse(response);
      } catch (error) {
        sendResponse(responseError(error.message));
      }
    })();

    return true;
  });
})(globalThis);
