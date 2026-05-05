# AI Page Summarizer Chrome Extension

A Manifest V3 Chrome Extension that extracts readable content from the current webpage, sends it to a secure AI proxy, displays a structured summary, caches summaries per URL, and can optionally highlight key points on the page.

This is a local/unpacked extension project. Do not upload it to the Google Chrome Extension Store as-is.

## Setup Instructions

### 1. Install locally in Chrome

1. Download or clone this repository.
2. Open Chrome.
3. Go to `chrome://extensions`.
4. Enable `Developer mode`.
5. Click `Load unpacked`.
6. Select this project folder, the folder that contains `manifest.json`.
7. Pin the extension from the Chrome toolbar.
8. Open a normal article page, blog post, documentation page, or essay.
9. Click the extension icon and choose `Summarize Page`.

Do not test on `chrome://` pages, the new tab page, extension pages, or the Chrome Web Store. Chrome blocks content scripts on those pages.

### 2. Create a private `.env` file for real AI

Copy `.env.example` to a new file named `.env`.

```powershell
Copy-Item .env.example .env
```

Add your own provider key to `.env`. Use a fresh key from your own AI provider account.

```text
GEMINI_API_KEY=your_gemini_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
GEMINI_FALLBACK_MODELS=gemini-2.5-flash,gemini-2.0-flash,gemini-2.0-flash-lite

OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini

PORT=8787
```

Do not commit `.env`. It is ignored by git.

### 3. Run real Gemini summaries

Open a terminal inside the project folder, the same folder that contains `package.json`, then start the Gemini proxy:

```powershell
npm run start:gemini-proxy
```

If Windows PowerShell blocks `npm` with `npm.ps1 cannot be loaded because running scripts is disabled`, use the npm command shim instead:

```powershell
npm.cmd run start:gemini-proxy
```

You can also use Git Bash or Command Prompt from the project folder.

Available proxy commands:

```powershell
npm run dev                 # starts the OpenAI proxy
npm run dev:openai          # starts the OpenAI proxy
npm run dev:gemini          # starts the Gemini proxy
npm run dev:mock            # starts the mock proxy without an AI key
npm run start:openai-proxy  # same as dev:openai
npm run start:gemini-proxy  # same as dev:gemini
```

Run only one proxy at a time. They all use port `8787` by default. If you see `EADDRINUSE`, another proxy is already running on that port. Open `http://localhost:8787/health` to check it, or stop the existing process before starting another provider.

Then open:

```text
http://localhost:8787/health
```

Confirm `"provider": "gemini"` and `"hasApiKey": true`.

If the health response shows `"model": "gemini-2.5-flash"` but you want the lighter default, change your private `.env` to:

```text
GEMINI_MODEL=gemini-2.5-flash-lite
```

Then stop and restart the proxy. Gemini errors such as HTTP `429` mean the API key has hit quota or rate limits; HTTP `503` means the selected model is temporarily unavailable. Those are provider-side limits, not Chrome extension install failures.

Opening `http://localhost:8787/api/summarize` directly in a browser is only a health-style check. Real summaries use `POST /api/summarize`, which the Chrome extension sends automatically after extracting page content.

In the popup, keep the proxy endpoint as:

```text
http://localhost:8787/api/summarize
```

### 4. Optional local test without an AI key

The mock proxy verifies extraction, Chrome messaging, popup rendering, caching, and highlighting without using Gemini or OpenAI.

```powershell
npm run start:proxy
```

Keep that terminal open, then open:

```text
http://localhost:8787/health
```

You should see JSON with `"ok": true`.

### 5. How to get, load, and run my extension on your PC

This is a local Chrome Extension, so you will load it manually in Chrome and run one local proxy server. You can use the mock server, Gemini server, or OpenAI server. If you use Gemini or OpenAI, use your own API key. Do not use or share my `.env` file.

#### Step 1: Install what you need

Install:

- Google Chrome
- Node.js from `https://nodejs.org`
- VS Code, if you want to run it from the VS Code terminal
- Git, if you want to clone the repository instead of downloading a ZIP

After installing Node.js, open PowerShell and check:

```powershell
node -v
```

You should see a Node version number.

#### Step 2: Get the project

You can get the project in either of these ways.

Option A: Download ZIP

1. Open my GitHub repository.
2. Click `Code`.
3. Click `Download ZIP`.
4. Unzip the folder.
5. Make sure the folder contains `manifest.json`.

Option B: Clone with Git

```powershell
cd "$env:USERPROFILE\Desktop"
git clone https://github.com/your-username/ai-page-summarizer-extension.git
cd ".\ai-page-summarizer-extension"
```

Replace the GitHub URL above with the repository link I shared with you.

#### Step 3: Open the project in VS Code or PowerShell

Using VS Code:

1. Open VS Code.
2. Click `File` > `Open Folder`.
3. Select the project folder that contains `manifest.json`.
4. Click `Terminal` > `New Terminal`.

Using PowerShell:

```powershell
cd "C:\path\to\ai-page-summarizer-extension"
```

Replace the path with the real folder path on your PC.

#### Step 4: Create your private `.env` file

Run this from the project folder:

```powershell
Copy-Item .env.example .env
notepad .env
```

If you want Gemini, add your Gemini key:

```text
GEMINI_API_KEY=your_gemini_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
```

If you want OpenAI, add your OpenAI key:

```text
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-4.1-mini
```

Save the `.env` file. Do not commit or share it.

#### Step 5: Choose one server to run

Run only one server at a time because they all use port `8787`.

Mock server, no API key needed:

```powershell
npm.cmd run start:proxy
```

Gemini server:

```powershell
npm.cmd run start:gemini-proxy
```

OpenAI server:

```powershell
npm.cmd run start:openai-proxy
```

Keep that VS Code terminal or PowerShell window open while using the extension.

If `npm` works normally on your PC, you can use `npm run ...`. If PowerShell blocks `npm.ps1`, use `npm.cmd run ...` exactly as shown above.

#### Step 6: Check the server health result

Open this URL in Chrome:

```text
http://localhost:8787/health
```

If you started the mock server, the expected result should look like this:

```json
{
  "ok": true,
  "message": "Mock AI proxy is running. The Chrome Extension should POST to /api/summarize.",
  "endpoint": "http://localhost:8787/api/summarize",
  "usage": "Health checks use GET. Summaries require POST /api/summarize with extracted page content."
}
```

If you started the Gemini server, the expected result should look like this:

```json
{
  "ok": true,
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite",
  "fallbackModels": [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite"
  ],
  "hasApiKey": true,
  "endpoint": "http://localhost:8787/api/summarize",
  "usage": "Health checks use GET. Summaries require POST /api/summarize with extracted page content."
}
```

If you started the OpenAI server, the expected result should look like this:

```json
{
  "ok": true,
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "hasApiKey": true,
  "endpoint": "http://localhost:8787/api/summarize",
  "usage": "Health checks use GET. Summaries require POST /api/summarize with extracted page content."
}
```

If `"hasApiKey"` is `false`, your `.env` file is missing the key or the server was not restarted after editing `.env`.

#### Step 7: Load the extension in Chrome

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select the project folder that contains `manifest.json`.
6. Pin the extension from the Chrome toolbar.

#### Step 8: Test the extension

1. Open a normal article page or blog post.
2. Do not test on `chrome://` pages, the Chrome Web Store, or the new tab page.
3. Click the extension icon.
4. Click `Summarize Page`.
5. If you used the mock server, you should see a test summary.
6. If you used Gemini or OpenAI, you should see an AI-generated summary, key insights, reading time, and word count.

For production-style use without keeping a terminal open, deploy `proxy/gemini-server.js`, `proxy/openai-server.js`, or an equivalent backend to an HTTPS host and save that hosted endpoint in the popup.

## Architecture Explanation

```text
.
├── manifest.json
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
    ├── mock-server.js
    ├── gemini-server.js
    └── openai-server.js
```

- `manifest.json` defines the Manifest V3 extension, popup, service worker, icons, permissions, and local/optional proxy host permissions.
- `popup/popup.js` manages the user workflow, active tab lookup, cache checks, content-script injection, endpoint saving, optional HTTPS proxy permission requests, and rendering.
- `content/content-script.js` extracts readable content from the active webpage and optionally highlights matched key points.
- `utils/extractor.js` prefers `article`, `main`, `[role="main"]`, and common article containers, removes noisy areas, and returns title, URL, text, word count, and reading time.
- `background/service-worker.js` receives validated popup messages, checks cache, calls the configured AI proxy, normalizes responses, and stores summaries.
- `utils/storage.js` wraps `chrome.storage.local` for cache, settings, and the last summary.
- `utils/sanitizer.js` centralizes text cleanup, URL normalization, word counting, and safe list handling.
- `proxy/mock-server.js` is a development-only proxy for testing without an AI key.
- `proxy/gemini-server.js` is a production-style Gemini proxy template.
- `proxy/openai-server.js` is a production-style OpenAI proxy template.

## AI Integration Explanation

The extension does not call Gemini, OpenAI, or any AI provider directly from popup or content scripts. The popup sends extracted page content to the background service worker. The background service worker sends that content to a configurable proxy endpoint.

Default local endpoint:

```text
http://localhost:8787/api/summarize
```

The proxy receives:

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
    "bulletCount": 5,
    "responseFormat": "json"
  }
}
```

The proxy should return:

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

`proxy/gemini-server.js` calls Gemini from the server using `GEMINI_API_KEY` from `.env` or the server environment. It uses Gemini's `generateContent` endpoint and sends the key in the `x-goog-api-key` header.

`proxy/openai-server.js` calls OpenAI from the server using `OPENAI_API_KEY` from `.env` or the server environment.

For hosted use, deploy one proxy to HTTPS, paste its URL into the popup settings, click `Save endpoint`, and approve Chrome's permission prompt.

## Security Decisions

- No API keys are committed to the repository.
- API keys must live only in `.env` locally or server environment variables in production.
- Popup scripts and content scripts never receive provider API keys.
- AI requests are handled by the background service worker and a secure proxy.
- Hosted proxy endpoints must use HTTPS.
- Local HTTP is allowed only for `localhost` and `127.0.0.1` testing.
- Default extension permissions are minimal: `activeTab`, `scripting`, and `storage`.
- Hosted proxy access uses optional host permissions requested only when the endpoint is saved.
- Runtime messages are validated by type and payload before use.
- Popup output uses `textContent`, not unsafe HTML injection.
- In-page highlighting uses DOM ranges and sanitized text.
- `.env` files are ignored by git.

If an API key is exposed publicly, revoke it immediately and create a new one.

## Trade-Offs

- The extension uses a proxy instead of direct AI API calls. This adds setup work, but it prevents exposing API keys in extension code.
- The local mock proxy is useful for testing and grading, but it does not produce real AI summaries.
- The extractor uses heuristics instead of a full readability library. This keeps the extension lightweight, but some unusual page layouts may produce less accurate extraction.
- Summaries are cached for speed and to prevent duplicate API calls. Users may need to click `Clear Page Cache` to force a fresh summary.
- Highlighting uses exact phrase matching first and keyword-based sentence matching second. This is safer for page layout, but paraphrased AI insights may not always match text on the page.
- A hosted proxy is recommended for production use. Without one, a local terminal process must remain open while testing.
