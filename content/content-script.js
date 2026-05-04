(function registerContentScript(global) {
  "use strict";

  if (global.__AI_PAGE_SUMMARIZER_CONTENT_SCRIPT_READY__) {
    return;
  }

  global.__AI_PAGE_SUMMARIZER_CONTENT_SCRIPT_READY__ = true;

  const namespace = global.AiPageSummarizer || {};
  const constants = namespace.Constants || {};
  const sanitizer = namespace.Sanitizer || {};
  const extractor = namespace.Extractor || {};
  const MESSAGE_TYPES = constants.MESSAGE_TYPES || {};
  const STOP_WORDS = new Set([
    "about",
    "after",
    "again",
    "also",
    "because",
    "before",
    "being",
    "could",
    "every",
    "from",
    "have",
    "into",
    "more",
    "most",
    "only",
    "other",
    "over",
    "page",
    "should",
    "their",
    "there",
    "these",
    "this",
    "through",
    "under",
    "were",
    "when",
    "where",
    "which",
    "while",
    "with",
    "would"
  ]);

  function sendOk(payload) {
    return { ok: true, payload };
  }

  function sendError(message) {
    return { ok: false, error: sanitizer.sanitizeText(message || "The page could not be processed.", 240) };
  }

  function ensureHighlightStyle() {
    if (document.getElementById(constants.HIGHLIGHT_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = constants.HIGHLIGHT_STYLE_ID;
    style.textContent = `
      mark.${constants.HIGHLIGHT_CLASS} {
        background: rgba(221, 54, 182, 0.24);
        border-radius: 3px;
        box-shadow: 0 0 0 1px rgba(49, 80, 254, 0.22);
        color: inherit;
        padding: 0 1px;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function clearHighlights() {
    const marks = Array.from(document.querySelectorAll(`mark.${constants.HIGHLIGHT_CLASS}`));
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) {
        return;
      }

      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    });

    return marks.length;
  }

  function shouldSkipElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return true;
    }

    if (element.closest(`mark.${constants.HIGHLIGHT_CLASS}`)) {
      return true;
    }

    const tagName = element.tagName;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "BUTTON", "SVG", "CANVAS", "IFRAME"].includes(tagName)) {
      return true;
    }

    const signature = `${element.id || ""} ${element.className || ""}`;
    if (/\b(ad|advert|banner|cookie|footer|menu|modal|nav|newsletter|popup|promo|sidebar|social|subscribe)\b/i.test(signature)) {
      return true;
    }

    const style = global.getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden" || style.opacity === "0";
  }

  function getTextNodes() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = sanitizer.sanitizeText(node.nodeValue || "");
        if (text.length < 24 || shouldSkipElement(node.parentElement)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    return nodes;
  }

  function wrapTextNodeRange(node, start, end) {
    if (!node || start < 0 || end <= start || end > node.nodeValue.length) {
      return false;
    }

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);

    const mark = document.createElement("mark");
    mark.className = constants.HIGHLIGHT_CLASS;
    mark.setAttribute("data-ai-page-summarizer", "highlight");
    range.surroundContents(mark);
    return true;
  }

  function highlightExactPhrase(phrase) {
    const loweredPhrase = phrase.toLowerCase();
    const nodes = getTextNodes();

    for (const node of nodes) {
      const index = node.nodeValue.toLowerCase().indexOf(loweredPhrase);
      if (index >= 0 && wrapTextNodeRange(node, index, index + phrase.length)) {
        return true;
      }
    }

    return false;
  }

  function getKeywords(phrase) {
    return sanitizer
      .sanitizeText(phrase)
      .toLowerCase()
      .split(/[^a-z0-9'-]+/i)
      .filter((word) => word.length > 4 && !STOP_WORDS.has(word))
      .slice(0, 10);
  }

  function getSentenceRanges(text) {
    const ranges = [];
    const pattern = /[^.!?]+[.!?]+|[^.!?]+$/g;
    let match = pattern.exec(text);

    while (match) {
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0]
      });
      match = pattern.exec(text);
    }

    return ranges;
  }

  function highlightSentenceByKeywords(phrase) {
    const keywords = getKeywords(phrase);
    if (keywords.length < 2) {
      return false;
    }

    let bestMatch = null;

    getTextNodes().forEach((node) => {
      getSentenceRanges(node.nodeValue).forEach((range) => {
        const sentence = sanitizer.sanitizeText(range.text);
        if (sentence.length < 40 || sentence.length > 320) {
          return;
        }

        const loweredSentence = sentence.toLowerCase();
        const score = keywords.reduce((total, keyword) => {
          return total + (loweredSentence.includes(keyword) ? 1 : 0);
        }, 0);

        if (score >= Math.min(3, keywords.length) && (!bestMatch || score > bestMatch.score)) {
          bestMatch = {
            node,
            start: range.start,
            end: range.end,
            score
          };
        }
      });
    });

    if (!bestMatch) {
      return false;
    }

    return wrapTextNodeRange(bestMatch.node, bestMatch.start, bestMatch.end);
  }

  function highlightKeyPoints(phrases) {
    clearHighlights();
    ensureHighlightStyle();

    const safePhrases = sanitizer.uniqueList(phrases || [], constants.MAX_HIGHLIGHTS, 260);
    let count = 0;

    for (const phrase of safePhrases) {
      if (count >= constants.MAX_HIGHLIGHTS) {
        break;
      }

      const highlighted = highlightExactPhrase(phrase) || highlightSentenceByKeywords(phrase);
      if (highlighted) {
        count += 1;
      }
    }

    return count;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object" || !Object.values(MESSAGE_TYPES).includes(message.type)) {
      return false;
    }

    try {
      if (message.type === MESSAGE_TYPES.PING) {
        sendResponse(sendOk({ ready: true }));
        return true;
      }

      if (message.type === MESSAGE_TYPES.EXTRACT_PAGE_CONTENT) {
        if (typeof extractor.extractPageContent !== "function") {
          sendResponse(sendError("The content extractor is not available on this page."));
          return true;
        }

        const pageContent = extractor.extractPageContent();
        if (!pageContent.text || pageContent.wordCount < constants.MIN_WORD_COUNT) {
          sendResponse(sendError("No readable article-style content was found on this page."));
          return true;
        }

        sendResponse(sendOk(pageContent));
        return true;
      }

      if (message.type === MESSAGE_TYPES.HIGHLIGHT_KEY_POINTS) {
        const count = highlightKeyPoints(message.payload?.phrases || []);
        sendResponse(sendOk({ count }));
        return true;
      }

      if (message.type === MESSAGE_TYPES.CLEAR_HIGHLIGHTS) {
        const count = clearHighlights();
        sendResponse(sendOk({ count }));
        return true;
      }
    } catch (error) {
      sendResponse(sendError(error.message));
      return true;
    }

    return false;
  });
})(globalThis);
