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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 60);
const MAX_BODY_BYTES = 1_500_000;
const MAX_CONTENT_CHARS = 14000;
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const rateLimitBuckets = new Map();

class UpstreamError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
  }
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

function getOpenAIErrorMessage(statusCode, bodyText) {
  const lowerBody = sanitizeText(bodyText, 1200).toLowerCase();

  if (statusCode === 429) {
    if (lowerBody.includes("quota")) {
      return "OpenAI quota was exceeded for this API key. Check your OpenAI billing/quota, wait if you are rate-limited, or switch to the mock/Gemini proxy.";
    }

    return "OpenAI rate limit was reached for this API key. Wait a few minutes, then try again.";
  }

  if (statusCode === 401 || statusCode === 403) {
    return "OpenAI rejected the API key. Check OPENAI_API_KEY in your private .env file, then restart the proxy.";
  }

  return `OpenAI request failed with HTTP ${statusCode}: ${sanitizeText(bodyText, 220)}`;
}

function countWords(value) {
  return Array.from(String(value || "").matchAll(WORD_PATTERN)).length;
}

function estimateReadingTime(wordCount) {
  return `${Math.max(1, Math.ceil(Number(wordCount || 0) / 220))} min read`;
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
      mode: options.mode === "brief" ? "brief" : "standard"
    }
  };
}

function buildInput(payload) {
  const summaryCount = payload.options.mode === "brief" ? "exactly 3" : "4 to 6";

  return [
    `Summarize this webpage in ${summaryCount} concise bullet points.`,
    "Also provide exactly 3 key insights.",
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

function getSummarySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "keyInsights", "readingTime", "wordCount"],
    properties: {
      summary: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: { type: "string" }
      },
      keyInsights: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string" }
      },
      readingTime: { type: "string" },
      wordCount: { type: "number" }
    }
  };
}

async function callOpenAI(payload) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured on the proxy server.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: "You are a careful page summarizer. Return only valid JSON matching the provided schema.",
      input: buildInput(payload),
      max_output_tokens: 1200,
      text: {
        format: {
          type: "json_schema",
          name: "page_summary",
          strict: true,
          schema: getSummarySchema()
        }
      }
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new UpstreamError(getOpenAIErrorMessage(response.status, text), response.status);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("OpenAI returned a non-JSON response.");
  }
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") {
    return data.output_text;
  }

  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (typeof part.text === "string") {
        return part.text;
      }
    }
  }

  return "";
}

function normalizeSummary(openAiData, payload) {
  const text = extractResponseText(openAiData);
  let result;

  try {
    result = JSON.parse(text);
  } catch (error) {
    throw new Error("OpenAI response did not contain parseable summary JSON.");
  }

  const summary = Array.isArray(result.summary)
    ? result.summary.map((item) => sanitizeText(item, 320)).filter(Boolean).slice(0, 6)
    : [];
  const keyInsights = Array.isArray(result.keyInsights)
    ? result.keyInsights.map((item) => sanitizeText(item, 320)).filter(Boolean).slice(0, 3)
    : [];

  if (!summary.length) {
    throw new Error("OpenAI response did not include summary bullets.");
  }

  return {
    summary,
    keyInsights: keyInsights.length ? keyInsights : summary.slice(0, 3),
    readingTime: sanitizeText(result.readingTime || payload.page.readingTime, 40),
    wordCount: Number(result.wordCount || payload.page.wordCount)
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
  const openAiData = await callOpenAI(payload);
  const summary = normalizeSummary(openAiData, payload);
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
      provider: "openai",
      model: OPENAI_MODEL,
      hasApiKey: Boolean(OPENAI_API_KEY),
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
    console.error(`OpenAI proxy error: ${sanitizeText(error.message || "Unknown error", 500)}`);
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
  console.log(`OpenAI proxy running at http://localhost:${PORT}/api/summarize`);
  console.log(OPENAI_API_KEY
    ? "OpenAI API key loaded from .env or the environment."
    : "Set OPENAI_API_KEY in .env or the environment before requesting summaries.");
});
