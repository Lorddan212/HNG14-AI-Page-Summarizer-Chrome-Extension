(function attachStorage(global) {
  "use strict";

  const namespace = global.AiPageSummarizer || {};
  const constants = namespace.Constants || {};
  const sanitizer = namespace.Sanitizer || {};
  const STORAGE_KEYS = constants.STORAGE_KEYS || {};
  const DEFAULT_SETTINGS = constants.DEFAULT_SETTINGS || {};

  function getStorageArea() {
    if (!global.chrome?.storage?.local) {
      throw new Error("Chrome local storage is not available in this context.");
    }

    return global.chrome.storage.local;
  }

  function getLocal(keys) {
    return new Promise((resolve, reject) => {
      getStorageArea().get(keys, (items) => {
        const error = global.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve(items || {});
      });
    });
  }

  function setLocal(items) {
    return new Promise((resolve, reject) => {
      getStorageArea().set(items, () => {
        const error = global.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      });
    });
  }

  function removeLocal(keys) {
    return new Promise((resolve, reject) => {
      getStorageArea().remove(keys, () => {
        const error = global.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        resolve();
      });
    });
  }

  async function getSettings() {
    const items = await getLocal(STORAGE_KEYS.SETTINGS);
    return {
      ...DEFAULT_SETTINGS,
      ...(items[STORAGE_KEYS.SETTINGS] || {})
    };
  }

  async function saveSettings(partialSettings) {
    const currentSettings = await getSettings();
    const nextSettings = {
      ...currentSettings,
      ...(partialSettings || {})
    };

    if (typeof nextSettings.apiEndpoint === "string") {
      nextSettings.apiEndpoint = sanitizer.sanitizeText(nextSettings.apiEndpoint, 600);
    }

    await setLocal({
      [STORAGE_KEYS.SETTINGS]: nextSettings
    });

    return nextSettings;
  }

  async function getCache() {
    const items = await getLocal(STORAGE_KEYS.CACHE);
    const cache = items[STORAGE_KEYS.CACHE];
    return cache && typeof cache === "object" ? cache : {};
  }

  function pruneCache(cache) {
    const maxEntries = constants.MAX_CACHE_ENTRIES || 40;
    const entries = Object.entries(cache);
    if (entries.length <= maxEntries) {
      return cache;
    }

    return entries
      .sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0))
      .slice(0, maxEntries)
      .reduce((nextCache, [key, value]) => {
        nextCache[key] = value;
        return nextCache;
      }, {});
  }

  async function getCachedSummary(url, mode) {
    const cache = await getCache();
    const key = sanitizer.makeCacheKey(url, mode);
    const entry = cache[key];

    if (!entry) {
      return null;
    }

    const ttl = constants.CACHE_TTL_MS || 0;
    if (ttl && Date.now() - Number(entry.createdAt || 0) > ttl) {
      delete cache[key];
      await setLocal({ [STORAGE_KEYS.CACHE]: cache });
      return null;
    }

    return entry;
  }

  async function setCachedSummary(url, mode, result, metadata) {
    const cache = await getCache();
    const key = sanitizer.makeCacheKey(url, mode);
    cache[key] = {
      url: sanitizer.normalizeUrlForCache(url),
      mode,
      createdAt: Date.now(),
      result,
      metadata: metadata || {}
    };

    await setLocal({
      [STORAGE_KEYS.CACHE]: pruneCache(cache)
    });

    return cache[key];
  }

  async function clearCachedSummary(url, mode) {
    const cache = await getCache();
    const normalizedUrl = sanitizer.normalizeUrlForCache(url);
    let removed = 0;

    Object.keys(cache).forEach((key) => {
      const shouldRemove = mode
        ? key === sanitizer.makeCacheKey(url, mode)
        : key.startsWith(`${normalizedUrl}::`);

      if (shouldRemove) {
        delete cache[key];
        removed += 1;
      }
    });

    await setLocal({
      [STORAGE_KEYS.CACHE]: cache
    });

    return removed;
  }

  async function setLastSummary(summary) {
    await setLocal({
      [STORAGE_KEYS.LAST_SUMMARY]: {
        ...summary,
        savedAt: Date.now()
      }
    });
  }

  async function getLastSummary() {
    const items = await getLocal(STORAGE_KEYS.LAST_SUMMARY);
    return items[STORAGE_KEYS.LAST_SUMMARY] || null;
  }

  async function clearLastSummary() {
    await removeLocal(STORAGE_KEYS.LAST_SUMMARY);
  }

  namespace.Storage = Object.freeze({
    getLocal,
    setLocal,
    removeLocal,
    getSettings,
    saveSettings,
    getCache,
    getCachedSummary,
    setCachedSummary,
    clearCachedSummary,
    setLastSummary,
    getLastSummary,
    clearLastSummary
  });

  global.AiPageSummarizer = namespace;
})(globalThis);
