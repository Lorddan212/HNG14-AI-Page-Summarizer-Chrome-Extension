# AI Page Summarizer Chrome Extension

A real Manifest V3 Chrome Extension that extracts meaningful content from the active webpage, sends it to a configurable AI proxy, displays a structured summary in the popup, caches summaries per URL, and can highlight matching key points on the page.

This project is intended for local learning and testing. Do not upload it to the Chrome Web Store as-is.

## Features

- Manifest V3 service worker architecture
- Minimal permissions: `activeTab`, `scripting`, and `storage`
- Programmatic content-script injection only after user action
- Heuristic article extraction that avoids navigation, ads, footers, forms, sidebars, cookie banners, and low-value page chrome
- Configurable AI proxy endpoint, defaulting to `http://localhost:8787/api/summarize`
- Structured summary rendering with summary bullets, key insights, estimated reading time, and word count
- Cache per URL and summary mode using `chrome.storage.local`
- Copy summary, clear page cache, dark/light mode, and 3-bullet mode
- Optional safe highlighting that wraps matched text nodes with `<mark>` elements without using unsafe HTML injection
- Friendly errors for restricted pages, empty pages, failed messaging, invalid API responses, timeouts, and network failures

## Folder Structure

```text
ai-page-summarizer-extension/
├── manifest.json
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
│   ├── extractor.js
│   ├── sanitizer.js
│   ├── storage.js
│   └── constants.js
├── assets/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
└── proxy/
    └── mock-server.js
```

## Local Installation

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable Developer Mode.
4. Click `Load unpacked`.
5. Select the `ai-page-summarizer-extension` project folder.
6. Pin the extension and open an article page.
7. Click the extension icon and choose `Summarize Page`.

## Configure the AI API Proxy

The extension uses the safer proxy approach. It does not hardcode or expose any AI API key in popup code, content scripts, or committed files.

Default endpoint:

```text
http://localhost:8787/api/summarize
```

## Quick Local Test Without an AI Key

Use the included mock proxy first. It returns extractive JSON summaries, so you can verify the Chrome Extension flow before connecting OpenAI, Gemini, or another provider.

From this project folder, run:

```powershell
node proxy/mock-server.js
```

Keep that terminal open. Then load the extension from `chrome://extensions`, open a normal article page, and click `Summarize Page`.

The mock proxy is only for local testing. For a real AI summary, replace it with your own server-side proxy that keeps provider API keys on the server.

The background service worker sends a `POST` request with this shape:

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

Your proxy should call your chosen AI provider server-side and return either strict JSON:

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

or an OpenAI-style response whose message content contains that JSON. If the proxy returns plain text, the extension will split it into reasonable bullets as a fallback.

If you use a remote proxy instead of localhost, update `host_permissions` in `manifest.json` to include the proxy origin, then reload the extension.

## Architecture

- `popup/popup.js` owns the user workflow, UI state, active tab lookup, cache checks, script injection, and rendering.
- `content/content-script.js` listens for extraction and highlighting messages. It never sends the full DOM.
- `utils/extractor.js` chooses high-signal content containers, strips noisy elements, and returns text plus metadata.
- `background/service-worker.js` validates messages, checks cache again, calls the configured AI proxy, parses JSON or plain text, and writes cache entries.
- `utils/storage.js` wraps `chrome.storage.local` for settings, cached summaries, and the last summary.
- `utils/sanitizer.js` centralizes text cleanup, URL normalization, word counts, and cache key creation.

## Content Extraction

The extractor scores likely content containers such as `article`, `main`, `[role="main"]`, `.entry-content`, `.post-content`, and similar selectors. It removes scripts, styles, navbars, sidebars, footers, forms, cookie banners, comments, ads, social widgets, and newsletter areas. It then collects meaningful headings, paragraphs, list items, and blockquotes.

If no clear article container exists, it falls back to the body after applying the same filtering rules. Very long extracted content is capped before being sent to the proxy, while word count and reading time are computed from the extracted readable text.

## Security Decisions

- No API keys are stored in source code.
- AI calls happen only in `background/service-worker.js`.
- The default design expects a local proxy server to hold API secrets.
- The popup and content script never receive API keys.
- Dynamic popup text is rendered with `textContent`, not `innerHTML`.
- Highlighting uses DOM `Range` and `<mark>` nodes, not HTML string injection.
- Runtime messages are validated by type and payload before use.
- Permissions are intentionally narrow. `activeTab` and `scripting` allow user-initiated extraction without permanent access to every site.
- The only host permission is the default local proxy origin: `http://localhost:8787/*`.

For local experiments only, you could modify the background worker to read a user-saved API key from `chrome.storage.local`, but that is not recommended for production. A server-side proxy is safer.

## Caching

Summaries are stored in `chrome.storage.local` under a normalized URL plus summary mode. URL hashes and common tracking parameters are removed before cache lookup. Cache entries expire after 7 days and the cache is pruned to 40 entries.

The popup checks cache before extracting and calling the proxy. The service worker also checks cache before making the AI request, which prevents duplicate calls if messages are repeated.

Use `Clear Page Cache` to remove cached summaries for the current URL.

## Highlighting Trade-Offs

The AI summary may paraphrase the article, so exact phrase matches are not always available. The content script first tries exact phrase matching, then safely highlights short page sentences that share multiple meaningful keywords with the summary or key insights. This avoids breaking the page layout, but it may highlight fewer sections on heavily paraphrased summaries.

## Troubleshooting

- Opening `popup/popup.html` directly only previews the layout. Chrome APIs such as `chrome.tabs`, `chrome.scripting`, and `chrome.storage` only work after loading the folder as an unpacked extension.
- If the popup says the proxy could not be reached, run `node proxy/mock-server.js` or start your real AI proxy at the endpoint saved in the popup.
- `Chrome blocks extensions from reading this page`: Chrome does not allow content scripts on pages such as `chrome://`, the Chrome Web Store, internal extension pages, and some browser-owned surfaces.
- `The AI proxy could not be reached`: Start your local proxy and confirm the popup endpoint matches it.
- `AI proxy failed with HTTP ...`: Check your proxy logs and AI provider response.
- `No readable article-style content was found`: Try a page with article-like text content. Search pages, dashboards, and media-only pages may not have enough readable text.
- Summary does not update: click `Clear Page Cache`, switch summary mode, or reload the extension from `chrome://extensions`.
- Remote endpoint fails: update `host_permissions` in `manifest.json` for that exact origin and reload the extension.

## Testing on Article Pages

1. Start the local test proxy with `node proxy/mock-server.js`.
2. Open Chrome and go to `chrome://extensions`.
3. Enable Developer Mode.
4. Click `Load unpacked` and select this project folder.
5. Open a news article, documentation page, blog post, or essay. Do not test on `chrome://`, the new tab page, or the Chrome Web Store.
6. Open the extension popup and confirm the current page title appears.
7. Click `Summarize Page`.
8. Confirm summary bullets, key insights, word count, and reading time appear.
9. Click `Copy` and paste into a text editor.
10. Click `Highlight Key Points` and inspect the page.
11. Click `Clear Highlights`.
12. Close and reopen the popup on the same URL to confirm the cached summary appears without another API call.
