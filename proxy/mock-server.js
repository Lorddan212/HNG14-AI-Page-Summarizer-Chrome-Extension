"use strict";

const http = require("node:http");

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = 1_500_000;
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'-]*/gu;
const SUMMARY_BULLET_COUNTS = Object.freeze([3, 5, 7]);

function sanitizeText(value, maxLength = 1000) {
  const text = String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function getSentences(content) {
  const sentences = String(content || "").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const seen = new Set();

  return sentences
    .map((sentence) => sanitizeText(sentence, 280))
    .filter((sentence) => countWords(sentence) >= 8)
    .filter((sentence) => {
      const key = sentence.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function scoreSentence(sentence, index) {
  const text = sentence.toLowerCase();
  let score = 100 - index;

  if (/\b(important|key|because|therefore|however|research|data|study|result|growth|risk|change|announced)\b/.test(text)) {
    score += 45;
  }

  const words = countWords(sentence);
  if (words >= 12 && words <= 36) {
    score += 25;
  }

  return score;
}

function summarize(payload) {
  const content = sanitizeText(payload.content, 120000);
  const maxSummaryItems = normalizeBulletCount(payload.options?.bulletCount, payload.options?.mode);
  const wordCount = Number(payload.page?.wordCount || countWords(content));
  const sentences = getSentences(content);
  const rankedSentences = sentences
    .map((sentence, index) => ({ sentence, score: scoreSentence(sentence, index) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.sentence);

  const summary = rankedSentences.slice(0, maxSummaryItems);
  const keyInsights = rankedSentences.slice(maxSummaryItems, maxSummaryItems + 3);

  if (!summary.length) {
    for (let index = 1; index <= maxSummaryItems; index += 1) {
      summary.push(`Mock summary bullet ${index}: the proxy received page content but could not extract enough sentence-like text.`);
    }
  }

  while (summary.length > 0 && summary.length < maxSummaryItems) {
    summary.push(`This mock summary item confirms the page content was extracted and requested as a ${maxSummaryItems}-bullet summary.`);
  }

  return {
    summary,
    keyInsights: keyInsights.length ? keyInsights : summary.slice(0, 3),
    readingTime: payload.page?.readingTime || estimateReadingTime(wordCount),
    wordCount
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && (request.url === "/" || request.url === "/api/summarize" || request.url === "/health")) {
    sendJson(response, 200, {
      ok: true,
      message: "Mock AI proxy is running. The Chrome Extension should POST to /api/summarize.",
      endpoint: `http://localhost:${PORT}/api/summarize`,
      usage: "Health checks use GET. Summaries require POST /api/summarize with extracted page content."
    });
    return;
  }

  if (request.url !== "/api/summarize" || request.method !== "POST") {
    sendJson(response, 404, { error: "Use POST /api/summarize." });
    return;
  }

  try {
    const rawBody = await readBody(request);
    const payload = JSON.parse(rawBody || "{}");

    if (!payload.content || countWords(payload.content) < 20) {
      sendJson(response, 400, { error: "The request did not include enough page content." });
      return;
    }

    sendJson(response, 200, summarize(payload));
  } catch (error) {
    sendJson(response, 500, { error: sanitizeText(error.message, 220) });
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
  console.log(`Mock AI proxy running at http://localhost:${PORT}/api/summarize`);
  console.log("Keep this terminal open while testing the extension.");
});
