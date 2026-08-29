/*
 * SPA navigation detection for www.bilibili.com (no polling).
 *
 * Bilibili routes through history.pushState/replaceState; wrapping them
 * plus popstate/hashchange covers video-to-video jumps, multi-page
 * switches and player rebuilds without touching MutationObserver.
 */

function installSpaHooks(onNavigate) {
  const wrapped = [];

  function wrapMethod(obj, name) {
    if (!obj || typeof obj[name] !== 'function') return;
    const original = obj[name];
    try {
      obj[name] = function (...args) {
        const result = original.apply(this, args);
        onNavigate();
        return result;
      };
      wrapped.push([obj, name, original]);
    } catch (e) {
      BS.warn('SPA hook 失败', name, e && e.message);
    }
  }

  wrapMethod(window.history, 'pushState');
  wrapMethod(window.history, 'replaceState');

  window.addEventListener('popstate', onNavigate);
  window.addEventListener('hashchange', onNavigate);

  return function uninstall() {
    for (const [obj, name, original] of wrapped) {
      try {
        obj[name] = original;
      } catch (_) { /* ignore */ }
    }
    window.removeEventListener('popstate', onNavigate);
    window.removeEventListener('hashchange', onNavigate);
  };
}

BS.installSpaHooks = installSpaHooks;
