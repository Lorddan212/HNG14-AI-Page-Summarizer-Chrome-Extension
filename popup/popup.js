(function registerPopup(global) {
  "use strict";

  const namespace = global.AiPageSummarizer || {};
  const constants = namespace.Constants;
  const sanitizer = namespace.Sanitizer;
  const storage = namespace.Storage;
  const MESSAGE_TYPES = constants.MESSAGE_TYPES;
  const SUMMARY_MODES = constants.SUMMARY_MODES;

  const CONTENT_SCRIPT_FILES = [
    "utils/constants.js",
    "utils/sanitizer.js",
    "utils/extractor.js",
    "content/content-script.js"
  ];

  const state = {
    tab: null,
    settings: { ...constants.DEFAULT_SETTINGS },
    currentResult: null,
    currentExtraction: null,
    isLoading: false
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    bindEvents();

    if (!isExtensionContext()) {
      enterPreviewMode();
      return;
    }

    await loadSettings();
    applyTheme(state.settings.theme);
    await loadActiveTab();
    await showCachedSummaryForCurrentMode();
  }

  function isExtensionContext() {
    return Boolean(
      global.chrome?.runtime?.id &&
      global.chrome?.tabs &&
      global.chrome?.scripting &&
      global.chrome?.storage?.local
    );
  }

  function enterPreviewMode() {
    applyTheme("light");
    els.pageTitle.textContent = "Extension preview";
    els.pageUrl.textContent = "Load this folder from chrome://extensions to test the real popup.";
    els.endpointInput.value = constants.DEFAULT_SETTINGS.apiEndpoint;
    setStatus("Preview only");
    setError("This file was opened outside Chrome's extension runtime. Use chrome://extensions > Load unpacked, then open an http or https article page.");
    resetResultView();

    [
      els.themeToggle,
      els.summarizeBtn,
      els.endpointInput,
      els.saveEndpointBtn,
      els.copyBtn,
      els.highlightBtn,
      els.clearHighlightsBtn,
      els.clearBtn
    ].forEach((control) => {
      if (control) {
        control.disabled = true;
      }
    });

    document.querySelectorAll("input[name='summaryMode']").forEach((input) => {
      input.disabled = true;
    });
  }

  function cacheElements() {
    [
      "statusLine",
      "themeToggle",
      "pageTitle",
      "pageUrl",
      "summarizeBtn",
      "endpointInput",
      "saveEndpointBtn",
      "alertBox",
      "loadingBox",
      "resultsPanel",
      "readingTime",
      "wordCount",
      "summaryList",
      "insightsList",
      "copyBtn",
      "highlightBtn",
      "clearHighlightsBtn",
      "clearBtn"
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    els.summarizeBtn.addEventListener("click", summarizeCurrentPage);
    els.copyBtn.addEventListener("click", copySummary);
    els.highlightBtn.addEventListener("click", highlightKeyPoints);
    els.clearHighlightsBtn.addEventListener("click", clearHighlights);
    els.clearBtn.addEventListener("click", clearCurrentCache);
    els.saveEndpointBtn.addEventListener("click", saveEndpoint);
    els.themeToggle.addEventListener("click", toggleTheme);

    document.querySelectorAll("input[name='summaryMode']").forEach((input) => {
      input.addEventListener("change", async () => {
        const mode = getSelectedMode();
        state.settings = await storage.saveSettings({ summaryMode: mode });
        await showCachedSummaryForCurrentMode();
      });
    });
  }

  async function loadSettings() {
    state.settings = await storage.getSettings();
    els.endpointInput.value = state.settings.apiEndpoint || constants.DEFAULT_SETTINGS.apiEndpoint;

    const modeInput = document.querySelector(`input[name='summaryMode'][value='${state.settings.summaryMode}']`);
    if (modeInput) {
      modeInput.checked = true;
    }
  }

  async function loadActiveTab() {
    try {
      state.tab = await getActiveTab();
      const title = sanitizer.sanitizeText(state.tab.title || "Untitled page", 180);
      els.pageTitle.textContent = title;
      els.pageUrl.textContent = sanitizer.safeHostname(state.tab.url) || state.tab.url || "";

      if (!isSupportedPage(state.tab.url)) {
        setError("This page cannot be summarized. Open a normal http or https webpage and try again.");
        els.summarizeBtn.disabled = true;
      }
    } catch (error) {
      setError(error.message || "Chrome could not read the active tab.");
      els.summarizeBtn.disabled = true;
    }
  }

  async function showCachedSummaryForCurrentMode() {
    if (!state.tab?.url || !isSupportedPage(state.tab.url)) {
      return;
    }

    const cached = await storage.getCachedSummary(state.tab.url, getSelectedMode());
    if (cached?.result) {
      renderResult(cached.result, { cached: true });
      setStatus("Showing cached summary");
      return;
    }

    resetResultView();
    setStatus("Ready");
  }

  function getSelectedMode() {
    return document.querySelector("input[name='summaryMode']:checked")?.value || SUMMARY_MODES.STANDARD;
  }

  function isSupportedPage(url) {
    return sanitizer.isHttpUrl(url);
  }

  function getEndpointUrl(endpoint) {
    try {
      return new URL(endpoint);
    } catch (error) {
      return null;
    }
  }

  function isBundledLocalEndpoint(endpoint) {
    const parsed = getEndpointUrl(endpoint);
    if (!parsed) {
      return false;
    }

    return parsed.protocol === "http:" &&
      parsed.port === "8787" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  }

  function isInsecureRemoteEndpoint(endpoint) {
    const parsed = getEndpointUrl(endpoint);
    if (!parsed) {
      return true;
    }

    return parsed.protocol === "http:" && !isBundledLocalEndpoint(endpoint);
  }

  function getEndpointOriginPattern(endpoint) {
    const parsed = getEndpointUrl(endpoint);
    return parsed ? `${parsed.origin}/*` : "";
  }

  function ensureEndpointPermission(endpoint) {
    if (isBundledLocalEndpoint(endpoint)) {
      return Promise.resolve(true);
    }

    const origin = getEndpointOriginPattern(endpoint);
    if (!origin) {
      return Promise.reject(new Error("Use a valid proxy endpoint URL."));
    }

    if (!chrome.permissions?.contains || !chrome.permissions?.request) {
      return Promise.reject(new Error("Chrome could not request permission for this proxy endpoint."));
    }

    return new Promise((resolve, reject) => {
      chrome.permissions.contains({ origins: [origin] }, (hasPermission) => {
        const containsError = chrome.runtime.lastError;
        if (containsError) {
          reject(new Error(containsError.message));
          return;
        }

        if (hasPermission) {
          resolve(true);
          return;
        }

        chrome.permissions.request({ origins: [origin] }, (granted) => {
          const requestError = chrome.runtime.lastError;
          if (requestError) {
            reject(new Error(requestError.message));
            return;
          }

          if (!granted) {
            reject(new Error("Proxy permission was not granted. The extension cannot call this endpoint."));
            return;
          }

          resolve(true);
        });
      });
    });
  }

  function getActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        if (!tabs?.[0]) {
          reject(new Error("No active tab was found."));
          return;
        }

        resolve(tabs[0]);
      });
    });
  }

  function executeScripts(tabId, files) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript({
        target: { tabId },
        files
      }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      });
    });
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(response);
      });
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(response);
      });
    });
  }

  async function ensureContentScript() {
    if (!state.tab?.id || !isSupportedPage(state.tab.url)) {
      throw new Error("Open a normal http or https webpage before summarizing.");
    }

    try {
      const ping = await sendTabMessage(state.tab.id, { type: MESSAGE_TYPES.PING });
      if (ping?.ok) {
        return;
      }
    } catch (error) {
      await executeScripts(state.tab.id, CONTENT_SCRIPT_FILES);
    }
  }

  async function summarizeCurrentPage() {
    if (state.isLoading || !state.tab?.url) {
      return;
    }

    clearError();
    setLoading(true);

    try {
      const mode = getSelectedMode();
      const cached = await storage.getCachedSummary(state.tab.url, mode);
      if (cached?.result) {
        renderResult(cached.result, { cached: true });
        setStatus("Showing cached summary");
        return;
      }

      await ensureContentScript();
      const extractionResponse = await sendTabMessage(state.tab.id, {
        type: MESSAGE_TYPES.EXTRACT_PAGE_CONTENT
      });

      if (!extractionResponse?.ok) {
        throw new Error(extractionResponse?.error || "Could not extract readable content from the page.");
      }

      state.currentExtraction = extractionResponse.payload;
      const summaryResponse = await sendRuntimeMessage({
        type: MESSAGE_TYPES.SUMMARIZE_PAGE,
        payload: {
          extraction: state.currentExtraction,
          summaryMode: mode
        }
      });

      if (!summaryResponse?.ok) {
        throw new Error(summaryResponse?.error || "The AI proxy did not return a summary.");
      }

      renderResult(summaryResponse.result, { cached: Boolean(summaryResponse.cached) });
      setStatus(summaryResponse.cached ? "Showing cached summary" : "Summary ready");
    } catch (error) {
      setError(toFriendlyError(error));
      setStatus("Needs attention");
    } finally {
      setLoading(false);
    }
  }

  function renderResult(result, options) {
    state.currentResult = normalizeResultForDisplay(result);
    els.resultsPanel.hidden = false;
    els.readingTime.textContent = state.currentResult.readingTime;
    els.wordCount.textContent = String(state.currentResult.wordCount || "-");
    renderList(els.summaryList, state.currentResult.summary);
    renderList(els.insightsList, state.currentResult.keyInsights);

    els.copyBtn.disabled = false;
    els.highlightBtn.disabled = false;
    els.clearHighlightsBtn.disabled = false;
    els.clearBtn.disabled = false;

    if (options?.cached) {
      setStatus("Showing cached summary");
    }
  }

  function normalizeResultForDisplay(result) {
    return {
      summary: sanitizer.uniqueList(result?.summary || [], 6, 320),
      keyInsights: sanitizer.uniqueList(result?.keyInsights || [], 3, 320),
      readingTime: sanitizer.sanitizeText(result?.readingTime || "-", 40),
      wordCount: Number(result?.wordCount || 0)
    };
  }

  function renderList(container, items) {
    container.replaceChildren();

    items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      container.appendChild(li);
    });
  }

  function resetResultView() {
    state.currentResult = null;
    els.resultsPanel.hidden = true;
    els.summaryList.replaceChildren();
    els.insightsList.replaceChildren();
    els.copyBtn.disabled = true;
    els.highlightBtn.disabled = true;
    els.clearHighlightsBtn.disabled = true;
    els.clearBtn.disabled = true;
  }

  function setLoading(isLoading) {
    state.isLoading = isLoading;
    els.loadingBox.hidden = !isLoading;
    els.summarizeBtn.disabled = isLoading || !isSupportedPage(state.tab?.url);
    els.saveEndpointBtn.disabled = isLoading;
  }

  function setStatus(message) {
    els.statusLine.textContent = sanitizer.sanitizeText(message, 80);
  }

  function setError(message) {
    els.alertBox.textContent = sanitizer.sanitizeText(message, 320);
    els.alertBox.hidden = false;
  }

  function clearError() {
    els.alertBox.textContent = "";
    els.alertBox.hidden = true;
  }

  function toFriendlyError(error) {
    const message = error?.message || "";

    if (/cannot access|chrome:|extensions gallery|webstore|Cannot access contents/i.test(message)) {
      return "Chrome blocks extensions from reading this page. Try an article on a normal website.";
    }

    if (/Receiving end does not exist/i.test(message)) {
      return "The content script could not start on this page. Refresh the tab and try again.";
    }

    if (/Failed to fetch|NetworkError|ERR_FAILED/i.test(message)) {
      return "The AI proxy could not be reached. Run `node proxy/mock-server.js`, keep that terminal open, and confirm the popup endpoint is http://localhost:8787/api/summarize.";
    }

    return message || "Something went wrong while summarizing the page.";
  }

  function formatSummaryForClipboard() {
    if (!state.currentResult) {
      return "";
    }

    const lines = [
      "Summary",
      ...state.currentResult.summary.map((item) => `- ${item}`),
      "",
      "Key insights",
      ...state.currentResult.keyInsights.map((item) => `- ${item}`),
      "",
      `Reading time: ${state.currentResult.readingTime}`,
      `Word count: ${state.currentResult.wordCount}`
    ];

    return lines.join("\n");
  }

  async function copySummary() {
    clearError();
    const text = formatSummaryForClipboard();
    if (!text) {
      setError("There is no summary to copy yet.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied summary");
    } catch (error) {
      fallbackCopy(text);
      setStatus("Copied summary");
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  async function highlightKeyPoints() {
    clearError();
    if (!state.currentResult) {
      setError("Summarize the page before highlighting key points.");
      return;
    }

    try {
      await ensureContentScript();
      const phrases = [
        ...state.currentResult.keyInsights,
        ...state.currentResult.summary
      ];
      const response = await sendTabMessage(state.tab.id, {
        type: MESSAGE_TYPES.HIGHLIGHT_KEY_POINTS,
        payload: { phrases }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "The page could not be highlighted.");
      }

      setStatus(response.payload.count ? `Highlighted ${response.payload.count} section${response.payload.count === 1 ? "" : "s"}` : "No matching text found");
    } catch (error) {
      setError(toFriendlyError(error));
    }
  }

  async function clearHighlights() {
    clearError();
    try {
      await ensureContentScript();
      const response = await sendTabMessage(state.tab.id, {
        type: MESSAGE_TYPES.CLEAR_HIGHLIGHTS
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Highlights could not be cleared.");
      }

      setStatus("Highlights cleared");
    } catch (error) {
      setError(toFriendlyError(error));
    }
  }

  async function clearCurrentCache() {
    clearError();
    if (!state.tab?.url) {
      return;
    }

    await storage.clearCachedSummary(state.tab.url);
    await storage.clearLastSummary();
    resetResultView();
    setStatus("Page cache cleared");
  }

  async function saveEndpoint() {
    clearError();
    const endpoint = sanitizer.sanitizeText(els.endpointInput.value, 600);

    if (!sanitizer.isHttpUrl(endpoint)) {
      setError("Use a valid http or https endpoint.");
      return;
    }

    if (isInsecureRemoteEndpoint(endpoint)) {
      setError("Use HTTPS for hosted proxy endpoints. HTTP is only supported for the bundled localhost test proxy.");
      return;
    }

    try {
      await ensureEndpointPermission(endpoint);
    } catch (error) {
      setError(error.message || "Chrome could not grant access to that proxy endpoint.");
      return;
    }

    state.settings = await storage.saveSettings({ apiEndpoint: endpoint });
    els.endpointInput.value = state.settings.apiEndpoint;
    setStatus("Endpoint saved");
  }

  async function toggleTheme() {
    const nextTheme = state.settings.theme === "dark" ? "light" : "dark";
    state.settings = await storage.saveSettings({ theme: nextTheme });
    applyTheme(nextTheme);
  }

  function applyTheme(theme) {
    const selectedTheme = theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = selectedTheme;
    els.themeToggle.textContent = selectedTheme === "dark" ? "Light" : "Dark";
    els.themeToggle.setAttribute("aria-pressed", String(selectedTheme === "dark"));
  }
})(globalThis);
