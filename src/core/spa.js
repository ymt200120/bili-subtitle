/*
 * SPA navigation detection for www.bilibili.com (no polling).
 *
 * Bilibili routes through history.pushState/replaceState; wrapping them
 * plus popstate/hashchange covers video-to-video jumps, multi-page
 * switches and player rebuilds without touching MutationObserver.
 *
 * The reset callback only fires when the VIDEO IDENTITY changed
 * (bvid/page derived from the URL). Bilibili also issues changeState
 * calls for URL normalization, share params, seek timestamps etc.;
 * resetting on those would needlessly wipe results mid-viewing.
 * Leaving a video page (identity becomes null) still counts as a change.
 */

function videoIdentityKey() {
  if (typeof BS.parseVideoUrl !== 'function') return null;
  const parsed = BS.parseVideoUrl(location.href);
  return parsed ? `${parsed.bvid}:${parsed.page || 1}` : null;
}

function installSpaHooks(onNavigate) {
  const wrapped = [];
  let lastKey = videoIdentityKey();

  function fireIfIdentityChanged() {
    const key = videoIdentityKey();
    if (key === lastKey) return;
    lastKey = key;
    onNavigate();
  }

  function wrapMethod(obj, name) {
    if (!obj || typeof obj[name] !== 'function') return;
    const original = obj[name];
    try {
      obj[name] = function (...args) {
        const result = original.apply(this, args);
        fireIfIdentityChanged();
        return result;
      };
      wrapped.push([obj, name, original]);
    } catch (e) {
      BS.warn('SPA hook 失败', name, e && e.message);
    }
  }

  wrapMethod(window.history, 'pushState');
  wrapMethod(window.history, 'replaceState');

  window.addEventListener('popstate', fireIfIdentityChanged);
  window.addEventListener('hashchange', fireIfIdentityChanged);

  return function uninstall() {
    for (const [obj, name, original] of wrapped) {
      try {
        obj[name] = original;
      } catch (_) { /* ignore */ }
    }
    window.removeEventListener('popstate', fireIfIdentityChanged);
    window.removeEventListener('hashchange', fireIfIdentityChanged);
  };
}

BS.installSpaHooks = installSpaHooks;
