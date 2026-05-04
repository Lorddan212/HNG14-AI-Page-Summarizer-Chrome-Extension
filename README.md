# AI Page Summarizer Chrome Extension

A Manifest V3 Chrome Extension that extracts meaningful content from the active webpage, sends it to a secure AI proxy, displays a structured summary in the popup, caches summaries per URL, and can highlight important sections on the page.

This is a local/unpacked extension project. Do not upload it to the Chrome Web Store as-is.

## Requirement Coverage

- Manifest V3 only
- Background service worker for AI requests
- Popup UI with page title, loading state, summary output, copy, reset, dark/light mode, and 3-bullet mode
- Content script with article-focused extraction heuristics
- `chrome.storage.local` caching per URL and summary mode
- Minimal default permissions: `activeTab`, `scripting`, and `storage`
- Local proxy host permissions for testing
- Optional HTTPS proxy permissions requested only when the user saves a hosted endpoint
- No hardcoded API keys
- Message validation and graceful error handling
- Safe popup rendering with `textContent`
- Safe in-page highlighting with DOM ranges and `<mark>` elements

## Folder Structure

The repository root is the Chrome Extension folder that you load in Chrome.

```text
.
├── manifest.json
├── package.json
├── README.md
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── background/
│   └── service-worker.js
├── content/
│   └── content-script.js
├── utils/
│   ├── constants.js
│   ├── extractor.js
│   ├── sanitizer.js
│   └── storage.js
├── assets/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── proxy/
    └── mock-server.js
```

## Does It Need the Terminal Open?

For the bundled local mock proxy, yes. The extension calls `http://localhost:8787/api/summarize`, so a server process must be running on your machine.

To use the extension without keeping a terminal open, use one of these approaches:

- Deploy a real AI proxy to a hosted HTTPS service such as Cloudflare Workers, Render, Railway, Vercel, Netlify Functions, or your own backend.
- Run the proxy as an operating-system background service.
- Use a process manager such as PM2 to keep the proxy running.

The recommended production-like approach is a hosted HTTPS proxy. The extension should not call OpenAI, Gemini, or another AI provider directly with an API key stored in extension code.

## Is `proxy/mock-server.js` Necessary?

It is not required for production. It is included only so reviewers and teammates can test the extension flow without an AI key.

Keep it for local development and grading demos. Replace it with a real server-side AI proxy when you want real AI summaries.

## Local Test Without an AI Key

This test uses the included mock proxy. It creates extractive summaries from the webpage text and proves that extraction, messaging, popup rendering, caching, and highlighting work.

1. Install Node.js if it is not already installed.
2. Open a terminal in this project folder.
3. Start the mock proxy:

```powershell
npm run start:proxy
```

You can also run:

```powershell
node proxy/mock-server.js
```

1. Keep that terminal open.
2. Confirm the proxy is alive by opening:

```text
http://localhost:8787/health
```

You should see JSON with `"ok": true`.

## Install the Extension Locally

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this repository folder, the folder that contains `manifest.json`.
6. Pin the extension from the Chrome toolbar.
7. Open a normal article page, blog post, documentation page, or essay.
8. Click the extension icon.
9. Confirm the page title appears.
10. Click `Summarize Page`.

Do not test on `chrome://` pages, the new tab page, extension pages, or the Chrome Web Store. Chrome blocks content scripts on those pages.

## Use a Hosted AI Proxy

To avoid keeping a local terminal open, deploy your AI proxy to an HTTPS URL.

Your proxy must accept `POST` requests and keep provider API keys on the server. Example endpoint:

```text
https://your-domain.example/api/summarize
```

Then:

1. Open the extension popup.
2. Expand `API settings`.
3. Paste your hosted proxy URL.
4. Click `Save endpoint`.
5. Approve Chrome's permission prompt for that proxy origin.
6. Summarize an article page.

The extension has default host permissions for:

```text
http://localhost:8787/*
http://127.0.0.1:8787/*
```

For hosted proxies, it uses optional HTTPS host permissions and asks only for the exact origin you save.

## Proxy Request Format

The background service worker sends this JSON shape:

```json
{
  "prompt": "Return strict JSON...",
  "content": "Extracted page text...",
  "page": {
    "title": "Page title",
    "url": "https://example.com/article",
    "wordCount": 850,
    "readingTime": "4 min read"
  },
  "options": {
    "mode": "standard",
    "responseFormat": "json"
  }
}
```

Your proxy should return strict JSON:

```json
{
  "summary": [
    "bullet point 1",
    "bullet point 2",
    "bullet point 3"
  ],
  "keyInsights": [
    "insight 1",
    "insight 2",
    "insight 3"
  ],
  "readingTime": "4 min read",
  "wordCount": 850
}
```

The extension can also handle OpenAI-style responses where the assistant message contains that JSON. If the response is plain text, the extension attempts to split it into bullets as a fallback.

## How Someone Else Can Download and Use It

1. Go to the GitHub repository.
2. Click `Code`.
3. Choose `Download ZIP`, or run:

```powershell
git clone <repository-url>
```

1. If downloaded as ZIP, extract it.
2. Open a terminal in the extracted project folder.
3. For local testing, run:

```powershell
npm run start:proxy
```

1. Open Chrome and go to `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the folder that contains `manifest.json`.
5. Open a real article page.
6. Click the extension icon and summarize the page.

For real AI results, the user needs a hosted AI proxy URL or their own local proxy that calls OpenAI, Gemini, or another provider server-side.

## Architecture

- `popup/popup.js` owns UI state, active tab lookup, cache checks, content-script injection, endpoint saving, optional proxy permission requests, and rendering.
- `content/content-script.js` extracts readable page content and performs optional safe highlighting.
- `utils/extractor.js` scores likely article containers, removes noisy page areas, and returns title, URL, text, word count, and reading time.
- `background/service-worker.js` validates messages, checks cache again, calls the configured proxy, normalizes AI responses, and writes cache entries.
- `utils/storage.js` wraps `chrome.storage.local`.
- `utils/sanitizer.js` centralizes text cleanup, URL normalization, word counting, and safe list handling.
- `proxy/mock-server.js` is a local testing proxy only.

## Content Extraction

The extractor prefers `article`, `main`, `[role="main"]`, `.entry-content`, `.post-content`, `.article-content`, and similar high-signal containers. It removes scripts, styles, navbars, sidebars, footers, forms, cookie banners, comments, ads, social widgets, newsletter blocks, and other common clutter.

If no strong article container exists, it falls back to the body after applying filtering. Very long extracted text is capped before sending it to the proxy.

## Security Decisions

- No API keys are committed to the repo.
- AI calls happen from the background service worker to a proxy.
- The popup and content script never receive provider API keys.
- Hosted proxy endpoints must use HTTPS.
- Local HTTP is only supported for `localhost` and `127.0.0.1` testing.
- Popup output uses `textContent`, not `innerHTML`.
- In-page highlights use DOM nodes and sanitized text, not HTML string injection.
- Runtime message types and payloads are validated.
- Default permissions are minimal.
- Hosted proxy access is requested as an optional host permission only when needed.

## Caching

Summaries are cached in `chrome.storage.local` by normalized URL and summary mode. URL hashes and common tracking parameters are removed before cache lookup. Cache entries expire after 7 days and are pruned to 40 entries.

Use `Clear Page Cache` to remove summaries for the current URL.

## Highlighting Trade-Offs

AI summaries may paraphrase the original article. The content script first tries exact phrase matching, then highlights short page sentences that share meaningful keywords with the summary or insights. This is safe and layout-friendly, but it may highlight fewer sections when the summary is heavily paraphrased.

## Troubleshooting

- `The AI proxy could not be reached`: Start the local proxy with `npm run start:proxy`, or save a working hosted HTTPS proxy endpoint.
- `Proxy permission was not granted`: Save the endpoint again and approve Chrome's permission prompt.
- `Chrome blocks extensions from reading this page`: Test on a normal `http` or `https` article page.
- `No readable article-style content was found`: Try a page with article-like text. Dashboards, search pages, and media-only pages may not have enough readable content.
- Summary does not update: click `Clear Page Cache`, switch summary mode, or reload the extension from `chrome://extensions`.
- Manifest changed but behavior did not: go to `chrome://extensions` and click the extension reload icon.

## Verification

Run syntax checks:

```powershell
npm run check
```

Test the local proxy:

```powershell
npm run start:proxy
```

Then open:

```text
http://localhost:8787/health
```

Finally, load the unpacked extension and summarize a real article page.
