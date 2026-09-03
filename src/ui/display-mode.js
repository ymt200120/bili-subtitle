/*
 * Bilibili player display-mode watcher (UI only, no subtitle logic).
 *
 * Bilibili's "web fullscreen" (网页全屏) is NOT the Fullscreen API: it is a
 * player layout state exposed as the data-screen attribute on
 * .bpx-player-container (normal | wide | web | full). Native fullscreen
 * hides body-level UI naturally (only the fullscreened subtree renders),
 * but web fullscreen does not — so the floating subtitle UI must hide
 * itself based on player state.
 *
 * State-driven, never click-driven: the data-screen attribute and the
 * standard fullscreenchange event are the source of truth (keyboard
 * shortcuts and player-internal API calls change the attribute too).
 * Unknown/missing player state fails open (UI stays visible) — a future
 * selector change may temporarily show the button, never lose the script.
 *
 * Pure decision helpers (normalizeScreenMode / shouldHideFloatingUi /
 * isNativeFullscreen) are unit-tested without a DOM;
 * watchPlayerScreenMode only touches the DOM when invoked at runtime.
 */

const PLAYER_CONTAINER_SELECTOR = '.bpx-player-container';
const HIDE_MODES = ['web', 'full'];

function normalizeScreenMode(value) {
  return value === 'normal' || value === 'wide' || value === 'full' || value === 'web'
    ? value
    : 'unknown';
}

function shouldHideFloatingUi(mode, nativeFullscreen) {
  if (nativeFullscreen) return true;
  return HIDE_MODES.indexOf(mode) !== -1;
}

function isNativeFullscreen(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  return Boolean(d && (d.fullscreenElement || d.webkitFullscreenElement));
}

/*
 * Observe the player container and report visibility changes via
 * onChange({ hidden, mode }). Syncs immediately at startup (covers script
 * reload while already in web fullscreen), keeps a short bounded retry for
 * late player mounts (never a permanent timer), and handles player rebuilds
 * (SPA / part switch) through rebind().
 */
function watchPlayerScreenMode(onChange) {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return { rebind() {}, destroy() {} };
  }

  let player = null;
  let observer = null;
  let bootstrap = null;

  function emit() {
    const mode = normalizeScreenMode(player && player.getAttribute('data-screen'));
    const hidden = shouldHideFloatingUi(mode, isNativeFullscreen(document));
    if (onChange) onChange({ hidden, mode });
  }

  function bind() {
    const next = document.querySelector(PLAYER_CONTAINER_SELECTOR);
    if (!next || next === player) return false;
    if (observer) observer.disconnect();
    player = next;
    observer = new MutationObserver(emit);
    observer.observe(player, { attributes: true, attributeFilter: ['data-screen'] });
    return true;
  }

  function ensureBound() {
    if (bind()) {
      emit();
      return true;
    }
    return false;
  }

  if (!ensureBound()) {
    let tries = 0;
    bootstrap = setInterval(() => {
      if (ensureBound() || ++tries >= 20) clearInterval(bootstrap);
    }, 500);
  }

  document.addEventListener('fullscreenchange', emit);
  document.addEventListener('webkitfullscreenchange', emit);

  return {
    rebind: ensureBound,
    destroy() {
      if (bootstrap) clearInterval(bootstrap);
      if (observer) observer.disconnect();
      document.removeEventListener('fullscreenchange', emit);
      document.removeEventListener('webkitfullscreenchange', emit);
    }
  };
}

BS.ui = BS.ui || {};
BS.ui.displayMode = {
  PLAYER_CONTAINER_SELECTOR,
  normalizeScreenMode,
  shouldHideFloatingUi,
  isNativeFullscreen,
  watchPlayerScreenMode
};
