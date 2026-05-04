(function attachExtractor(global) {
  "use strict";

  const namespace = global.AiPageSummarizer || {};
  const constants = namespace.Constants || {};
  const sanitizer = namespace.Sanitizer || {};

  const CANDIDATE_SELECTORS = [
    "article",
    "main",
    "[role='main']",
    ".article",
    ".article-body",
    ".article-content",
    ".entry-content",
    ".post-content",
    ".story-content",
    ".content",
    "#content"
  ];

  const REMOVAL_SELECTOR = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "iframe",
    "nav",
    "aside",
    "footer",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "[hidden]",
    "[aria-hidden='true']",
    "[role='banner']",
    "[role='navigation']",
    "[role='contentinfo']",
    "[role='complementary']",
    "[data-nosnippet]",
    ".ad",
    ".ads",
    ".advert",
    ".advertisement",
    ".banner",
    ".breadcrumb",
    ".breadcrumbs",
    ".cookie",
    ".cookie-banner",
    ".comments",
    ".modal",
    ".newsletter",
    ".popup",
    ".promo",
    ".related",
    ".share",
    ".sharing",
    ".sidebar",
    ".social",
    ".sponsored",
    ".subscribe"
  ].join(",");

  const BOILERPLATE_PATTERN = /\b(cookie|accept all|privacy policy|terms of use|subscribe|newsletter|sign up|log in|advertisement|sponsored|share this|all rights reserved|enable javascript|related articles|recommended for you)\b/i;
  const NEGATIVE_CLASS_PATTERN = /\b(ad|ads|advert|banner|breadcrumb|comment|cookie|footer|menu|modal|newsletter|promo|related|share|sidebar|social|sponsor|subscribe)\b/i;
  const POSITIVE_CLASS_PATTERN = /\b(article|body|content|entry|main|post|story|text)\b/i;

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const style = global.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function getElementSignature(element) {
    return `${element.id || ""} ${element.className || ""}`;
  }

  function getLinkDensity(element) {
    const textLength = sanitizer.sanitizeText(element.innerText || element.textContent || "").length;
    if (!textLength) {
      return 0;
    }

    const linkTextLength = Array.from(element.querySelectorAll("a")).reduce((total, link) => {
      return total + sanitizer.sanitizeText(link.innerText || link.textContent || "").length;
    }, 0);

    return linkTextLength / textLength;
  }

  function scoreCandidate(element) {
    const text = sanitizer.sanitizeText(element.innerText || element.textContent || "", constants.MAX_EXTRACTED_CHARS);
    const textLength = text.length;
    if (textLength < 120 || !isVisible(element)) {
      return Number.NEGATIVE_INFINITY;
    }

    const paragraphCount = element.querySelectorAll("p").length;
    const headingCount = element.querySelectorAll("h1,h2,h3").length;
    const signature = getElementSignature(element);
    const linkDensity = getLinkDensity(element);
    let score = textLength + paragraphCount * 160 + headingCount * 80 - linkDensity * textLength * 1.25;

    if (element.matches("article")) {
      score += 1400;
    }

    if (element.matches("main,[role='main']")) {
      score += 800;
    }

    if (POSITIVE_CLASS_PATTERN.test(signature)) {
      score += 500;
    }

    if (NEGATIVE_CLASS_PATTERN.test(signature)) {
      score -= 1600;
    }

    return score;
  }

  function selectBestCandidate() {
    const candidates = Array.from(document.querySelectorAll(CANDIDATE_SELECTORS.join(",")));
    if (document.body) {
      candidates.push(document.body);
    }

    return candidates
      .filter(Boolean)
      .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))[0] || document.body;
  }

  function cleanClone(element) {
    if (!element) {
      return document.createElement("div");
    }

    const clone = element.cloneNode(true);
    clone.querySelectorAll(REMOVAL_SELECTOR).forEach((node) => node.remove());
    clone.querySelectorAll("*").forEach((node) => {
      const signature = getElementSignature(node);
      if (NEGATIVE_CLASS_PATTERN.test(signature)) {
        node.remove();
      }
    });

    return clone;
  }

  function isUsefulBlock(text, tagName) {
    const wordCount = sanitizer.countWords(text);
    const isHeading = /^H[1-3]$/.test(tagName);

    if (!text || wordCount < (isHeading ? 2 : 5)) {
      return false;
    }

    if (BOILERPLATE_PATTERN.test(text) && text.length < 260) {
      return false;
    }

    if (text.length < 35 && !isHeading) {
      return false;
    }

    if (text.length > 7000) {
      return false;
    }

    return true;
  }

  function extractBlocksFromElement(element) {
    if (!element) {
      return [];
    }

    const clone = cleanClone(element);
    const blocks = [];
    const seen = new Set();
    const blockElements = Array.from(clone.querySelectorAll("h1,h2,h3,p,li,blockquote"));

    blockElements.forEach((node) => {
      const text = sanitizer.sanitizeText(node.textContent || "", 1000);
      const key = text.toLowerCase();

      if (!isUsefulBlock(text, node.tagName) || seen.has(key)) {
        return;
      }

      seen.add(key);
      blocks.push(text);
    });

    if (blocks.length >= 3) {
      return blocks;
    }

    return sanitizer
      .sanitizeMultilineText(clone.innerText || clone.textContent || "", constants.MAX_EXTRACTED_CHARS)
      .split(/\n{2,}/)
      .map((block) => sanitizer.sanitizeText(block, 1000))
      .filter((block) => isUsefulBlock(block, "P"))
      .filter((block) => {
        const key = block.toLowerCase();
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      });
  }

  function extractTitle() {
    const metaTitle = document.querySelector("meta[property='og:title'], meta[name='twitter:title']")?.content;
    const heading = document.querySelector("h1")?.textContent;
    return sanitizer.sanitizeText(metaTitle || document.title || heading || "Untitled page", 180);
  }

  function extractPageContent() {
    const title = extractTitle();
    const url = global.location.href;
    const bestCandidate = selectBestCandidate();
    if (!bestCandidate) {
      return {
        title,
        url,
        text: "",
        wordCount: 0,
        readingTime: sanitizer.estimateReadingTime(0),
        isTruncated: false
      };
    }

    let blocks = extractBlocksFromElement(bestCandidate);

    if (sanitizer.countWords(blocks.join(" ")) < constants.MIN_WORD_COUNT && bestCandidate !== document.body) {
      blocks = extractBlocksFromElement(document.body);
    }

    const fullText = sanitizer.sanitizeMultilineText(blocks.join("\n\n"));
    const wordCount = sanitizer.countWords(fullText);
    const isTruncated = fullText.length > constants.MAX_EXTRACTED_CHARS;
    const text = sanitizer.truncateText(fullText, constants.MAX_EXTRACTED_CHARS);

    return {
      title,
      url,
      text,
      wordCount,
      readingTime: sanitizer.estimateReadingTime(wordCount),
      isTruncated
    };
  }

  namespace.Extractor = Object.freeze({
    extractPageContent
  });

  global.AiPageSummarizer = namespace;
})(globalThis);
