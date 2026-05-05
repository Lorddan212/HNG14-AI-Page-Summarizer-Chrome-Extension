"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      return;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const GEMINI_FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash,gemini-2.0-flash,gemini-2.0-flash-lite")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 60);
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 2);
const MAX_BODY_BYTES = 1_500_000;
const MAX_CONTENT_CHARS = 14000;
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const rateLimitBuckets = new Map();
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const SUMMARY_BULLET_COUNTS = Object.freeze([3, 5, 7]);

class UpstreamError extends Error {
  constructor(message, statusCode, options = {}) {
    super(message);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    this.retryable = options.retryable ?? RETRYABLE_STATUS_CODES.has(statusCode);
    this.fatal = Boolean(options.fatal);
  }
}

function isGeminiQuotaError(statusCode, bodyText) {
  if (statusCode !== 429) {
    return false;
  }

  const lowerBody = sanitizeText(bodyText, 1200).toLowerCase();
  return lowerBody.includes("exceeded your current quota") ||
    lowerBody.includes("quota") ||
    lowerBody.includes("rate-limits");
}

function getGeminiErrorMessage(model, statusCode, bodyText) {
  if (isGeminiQuotaError(statusCode, bodyText)) {
    return `Gemini quota or rate limit reached for this API key while using ${model}. Check your Google AI Studio quota, wait a few minutes, or switch to the mock/OpenAI proxy.`;
  }

  if (statusCode === 401 || statusCode === 403) {
    return "Gemini rejected the API key. Check GEMINI_API_KEY in your private .env file, then restart the proxy.";
  }

  if (statusCode === 503) {
    return `Gemini model ${model} is temporarily unavailable. Try again shortly or use another Gemini model.`;
  }

  return `Gemini model ${model} failed with HTTP ${statusCode}: ${sanitizeText(bodyText, 220)}`;
}

function sanitizeText(value, maxLength = 1000) {
  const text = String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function sanitizeMultiline(value, maxLength = MAX_CONTENT_CHARS) {
  const text = String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function countWords(value) {
  return Array.from(String(value || "").matchAll(WORD_PATTERN)).length;
}

function estimateReadingTime(wordCount) {
  return `${Math.max(1, Math.ceil(Number(wordCount || 0) / 220))} min read`;
}

function normalizeBulletCount(value, fallbackMode) {
  if (fallbackMode === "brief") {
    return 3;
  }

  if (fallbackMode === "standard") {
    return 5;
  }

  const count = Number(value);
  return SUMMARY_BULLET_COUNTS.includes(count) ? count : 5;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getModelList() {
  const seen = new Set();
  return [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS].filter((model) => {
    if (!model || seen.has(model)) {
      return false;
    }

    seen.add(model);
    return true;
  });
}

function getClientId(request) {
  return sanitizeText(
    request.headers["x-forwarded-for"]?.split(",")[0] ||
      request.socket.remoteAddress ||
      "unknown",
    120
  );
}

function checkRateLimit(clientId) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(clientId);

  if (!bucket || now >= bucket.resetAt) {
    rateLimitBuckets.set(clientId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    return true;
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  bucket.count += 1;
  return true;
}

function getAllowedOrigin(request) {
  const origin = request.headers.origin || "";

  if (!origin) {
    return "*";
  }

  if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }

  return "";
}

function sendJson(request, response, statusCode, payload) {
  const allowedOrigin = getAllowedOrigin(request);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };

  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS, GET";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }

  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function validatePayload(payload) {
  const content = sanitizeMultiline(payload.content, MAX_CONTENT_CHARS);
  const page = payload.page && typeof payload.page === "object" ? payload.page : {};
  const options = payload.options && typeof payload.options === "object" ? payload.options : {};
  const wordCount = Number(page.wordCount || countWords(content));

  if (!content || wordCount < 30) {
    throw new Error("The request did not include enough readable page content.");
  }

  return {
    content,
    page: {
      title: sanitizeText(page.title || "Untitled page", 180),
      url: sanitizeText(page.url || "", 600),
      wordCount,
      readingTime: sanitizeText(page.readingTime || estimateReadingTime(wordCount), 40)
    },
    options: {
      bulletCount: normalizeBulletCount(options.bulletCount, options.mode)
    }
  };
}

function buildPrompt(payload) {
  return [
    `Summarize this webpage in exactly ${payload.options.bulletCount} concise bullet points.`,
    "Also provide exactly 3 key insights.",
    "Return JSON only with this shape:",
    "{\"summary\":[\"bullet point\"],\"keyInsights\":[\"insight\"],\"readingTime\":\"4 min read\",\"wordCount\":850}",
    "Use only the supplied page content.",
    "",
    `Title: ${payload.page.title}`,
    `URL: ${payload.page.url}`,
    `Estimated reading time: ${payload.page.readingTime}`,
    `Word count: ${payload.page.wordCount}`,
    "",
    "Page content:",
    payload.content
  ].join("\n");
}

async function callGeminiModel(payload, model) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured on the proxy server.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: buildPrompt(payload)
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1200,
        responseMimeType: "application/json"
      }
    })
  });

  const text = await response.text();

  if (!response.ok) {
    const quotaError = isGeminiQuotaError(response.status, text);
    throw new UpstreamError(getGeminiErrorMessage(model, response.status, text), response.status, {
      retryable: RETRYABLE_STATUS_CODES.has(response.status) && !quotaError,
      fatal: quotaError || response.status === 401 || response.status === 403
    });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Gemini model ${model} returned a non-JSON response.`);
  }
}

async function callGemini(payload) {
  const models = getModelList();
  const errors = [];

  for (const model of models) {
    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
      try {
        const data = await callGeminiModel(payload, model);
        return {
          data,
          model
        };
      } catch (error) {
        errors.push(error.message);

        if (error.fatal) {
          throw error;
        }

        if (!error.retryable || attempt === GEMINI_MAX_RETRIES) {
          break;
        }

        const waitMs = 700 * 2 ** attempt;
        console.warn(`Gemini model ${model} is temporarily unavailable. Retrying in ${waitMs}ms...`);
        await sleep(waitMs);
      }
    }
  }

  throw new Error(`Gemini could not generate a summary after trying ${models.join(", ")}. Last errors: ${errors.slice(-3).join(" | ")}`);
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function splitTextIntoBullets(text, maxItems) {
  const lines = sanitizeMultiline(text, 3000)
    .split(/\n+|(?:^|\s)(?:[-*]|[0-9]+[.)])\s+/)
    .map((item) => sanitizeText(item, 320))
    .filter((item) => countWords(item) >= 5);

  if (lines.length > 1) {
    return lines.slice(0, maxItems);
  }

  return (sanitizeText(text, 3000).match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
    .map((item) => sanitizeText(item, 320))
    .filter((item) => countWords(item) >= 5)
    .slice(0, maxItems);
}

function normalizeSummary(geminiData, payload, model) {
  const text = extractGeminiText(geminiData);
  let result;

  try {
    result = JSON.parse(text);
  } catch (error) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      result = JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } else {
      const bullets = splitTextIntoBullets(text, payload.options.bulletCount + 3);
      const summary = bullets.slice(0, payload.options.bulletCount);
      const keyInsights = bullets.slice(summary.length, summary.length + 3);

      if (!summary.length) {
        const finishReason = geminiData?.candidates?.[0]?.finishReason;
        throw new Error(`Gemini response did not contain parseable summary JSON${finishReason ? ` (finish reason: ${finishReason})` : ""}.`);
      }

      return {
        summary,
        keyInsights: keyInsights.length ? keyInsights : summary.slice(0, 3),
        readingTime: payload.page.readingTime,
        wordCount: payload.page.wordCount,
        model
      };
    }
  }

  const summary = Array.isArray(result.summary)
    ? result.summary.map((item) => sanitizeText(item, 320)).filter(Boolean).slice(0, payload.options.bulletCount)
    : [];
  const keyInsights = Array.isArray(result.keyInsights)
    ? result.keyInsights.map((item) => sanitizeText(item, 320)).filter(Boolean).slice(0, 3)
    : [];

  if (!summary.length) {
    throw new Error("Gemini response did not include summary bullets.");
  }

  return {
    summary,
    keyInsights: keyInsights.length ? keyInsights : summary.slice(0, 3),
    readingTime: sanitizeText(result.readingTime || payload.page.readingTime, 40),
    wordCount: Number(result.wordCount || payload.page.wordCount),
    model
  };
}

async function handleSummarize(request, response) {
  const clientId = getClientId(request);
  if (!checkRateLimit(clientId)) {
    sendJson(request, response, 429, {
      error: "Too many summary requests. Please try again later."
    });
    return;
  }

  const rawBody = await readBody(request);
  const requestPayload = JSON.parse(rawBody || "{}");
  const payload = validatePayload(requestPayload);
  const geminiResult = await callGemini(payload);
  const summary = normalizeSummary(geminiResult.data, payload, geminiResult.model);
  sendJson(request, response, 200, summary);
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(request, response, 204, {});
    return;
  }

  if (request.method === "GET" && (request.url === "/" || request.url === "/health" || request.url === "/api/summarize")) {
    sendJson(request, response, 200, {
      ok: true,
      provider: "gemini",
      model: GEMINI_MODEL,
      fallbackModels: getModelList().slice(1),
      hasApiKey: Boolean(GEMINI_API_KEY),
      endpoint: `http://localhost:${PORT}/api/summarize`,
      usage: "Health checks use GET. Summaries require POST /api/summarize with extracted page content."
    });
    return;
  }

  if (request.url !== "/api/summarize" || request.method !== "POST") {
    sendJson(request, response, 404, { error: "Use POST /api/summarize." });
    return;
  }

  try {
    await handleSummarize(request, response);
  } catch (error) {
    console.error(`Gemini proxy error: ${sanitizeText(error.message || "Unknown error", 500)}`);
    const statusCode = Number(error.statusCode) >= 400 && Number(error.statusCode) < 600
      ? Number(error.statusCode)
      : 500;
    sendJson(request, response, statusCode, {
      error: sanitizeText(error.message || "The AI proxy failed.", 320)
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Only one proxy can run on this port at a time.`);
    console.error(`Open http://localhost:${PORT}/health to see what is already running, or stop the other process before starting this proxy.`);
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, () => {
  console.log(`Gemini proxy running at http://localhost:${PORT}/api/summarize`);
  console.log(GEMINI_API_KEY
    ? "Gemini API key loaded from .env or the environment."
    : "Set GEMINI_API_KEY in .env or the environment before requesting summaries.");
});
