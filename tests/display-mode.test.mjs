import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc } from './load.mjs';

/*
 * Display-mode decision matrix (the core invariant of v1.0.4):
 *   normal = visible, wide = visible, web fullscreen = hidden,
 *   native fullscreen = hidden. Unknown state fails open (visible).
 *
 * The DOM-mocked watcher tests cover emission on data-screen changes,
 * native-fullscreen events, player rebuild (SPA rebind) and cleanup.
 */

const BS = loadSrc();

const { normalizeScreenMode, shouldHideFloatingUi } = BS.ui.displayMode;

// Objects created inside the loadSrc vm realm fail cross-realm deepEqual;
// project to plain host-realm objects before comparing.
const snap = (list) => list.map((e) => ({ hidden: e.hidden, mode: e.mode }));

test('A: normal mode, no native fullscreen -> visible', () => {
  assert.equal(normalizeScreenMode('normal'), 'normal');
  assert.equal(shouldHideFloatingUi('normal', false), false);
});

test('B: wide mode -> visible (must not be treated as fullscreen)', () => {
  assert.equal(normalizeScreenMode('wide'), 'wide');
  assert.equal(shouldHideFloatingUi('wide', false), false);
});

test('C: web fullscreen -> hidden', () => {
  assert.equal(normalizeScreenMode('web'), 'web');
  assert.equal(shouldHideFloatingUi('web', false), true);
});

test('D: full (player full state) -> hidden', () => {
  assert.equal(normalizeScreenMode('full'), 'full');
  assert.equal(shouldHideFloatingUi('full', false), true);
});

test('E: native fullscreen wins regardless of mode -> hidden', () => {
  assert.equal(shouldHideFloatingUi('normal', true), true);
  assert.equal(shouldHideFloatingUi('wide', true), true);
});

test('F: unknown/missing player state fails open -> visible', () => {
  for (const v of [undefined, null, '', 'fullscreen', 'theater', 'WEB']) {
    assert.equal(normalizeScreenMode(v), 'unknown', String(v));
  }
  assert.equal(shouldHideFloatingUi('unknown', false), false);
});

test('transition matrix: normal<->web, wide<->web, normal<->native full', () => {
  const cases = [
    ['normal', false, false], // visible
    ['web', false, true], // hidden
    ['normal', false, false], // visible again
    ['wide', false, false], // visible
    ['web', false, true], // hidden
    ['wide', false, false], // visible again (wide <-> web)
    ['normal', true, true], // native fullscreen
    ['normal', false, false] // back to visible
  ];
  for (const [mode, nativeFs, expectedHidden] of cases) {
    assert.equal(
      shouldHideFloatingUi(normalizeScreenMode(mode), nativeFs),
      expectedHidden,
      `mode=${mode} nativeFullscreen=${nativeFs}`
    );
  }
});

/*
 * DOM-mocked watcher tests. A minimal document stub plus a recorded
 * MutationObserver let us drive data-screen changes and player rebuilds.
 */
function makeDomStub() {
  const listeners = {};
  const observers = [];
  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {
      this.observed = true;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  let currentPlayer = null;
  const doc = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    querySelector: () => currentPlayer,
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    removeEventListener(type) {
      delete listeners[type];
    }
  };
  return {
    doc,
    listeners,
    observers,
    setPlayer(node) {
      currentPlayer = node;
    },
    FakeMutationObserver
  };
}

const TIMER_STUBS = { setInterval: () => 0, clearInterval: () => {} };

function makePlayer(attrValue) {
  return { getAttribute: (name) => (name === 'data-screen' ? attrValue : null) };
}

function loadWatcher(dom) {
  return loadSrc({
    document: dom.doc,
    MutationObserver: dom.FakeMutationObserver,
    ...TIMER_STUBS
  });
}

test('watcher: syncs immediately at startup (reload during web fullscreen -> hidden)', () => {
  const dom = makeDomStub();
  dom.setPlayer(makePlayer('web'));
  const emissions = [];
  const { ui } = loadWatcher(dom);
  ui.displayMode.watchPlayerScreenMode((s) => emissions.push(s));

  assert.deepEqual(snap(emissions), [{ hidden: true, mode: 'web' }]);
});

test('watcher: data-screen mutations drive visibility (state, not clicks)', () => {
  const dom = makeDomStub();
  let attr = 'normal';
  dom.setPlayer({ getAttribute: (n) => (n === 'data-screen' ? attr : null) });
  const emissions = [];
  const { ui } = loadWatcher(dom);
  ui.displayMode.watchPlayerScreenMode((s) => emissions.push(s));

  assert.deepEqual(snap(emissions).pop(), { hidden: false, mode: 'normal' });

  attr = 'web';
  dom.observers[dom.observers.length - 1].cb();
  assert.deepEqual(snap(emissions).pop(), { hidden: true, mode: 'web' });

  attr = 'wide';
  dom.observers[dom.observers.length - 1].cb();
  assert.deepEqual(snap(emissions).pop(), { hidden: false, mode: 'wide' });

  attr = 'web';
  dom.observers[dom.observers.length - 1].cb();
  assert.deepEqual(snap(emissions).pop(), { hidden: true, mode: 'web' });

  attr = 'normal';
  dom.observers[dom.observers.length - 1].cb();
  assert.deepEqual(snap(emissions).pop(), { hidden: false, mode: 'normal' });
});

test('watcher: native fullscreenchange events toggle visibility', () => {
  const dom = makeDomStub();
  dom.setPlayer(makePlayer('normal'));
  const emissions = [];
  const { ui } = loadWatcher(dom);
  ui.displayMode.watchPlayerScreenMode((s) => emissions.push(s));

  dom.doc.fullscreenElement = {};
  dom.listeners['fullscreenchange']();
  assert.deepEqual(snap(emissions).pop(), { hidden: true, mode: 'normal' });

  dom.doc.fullscreenElement = null;
  dom.listeners['fullscreenchange']();
  assert.deepEqual(snap(emissions).pop(), { hidden: false, mode: 'normal' });
});

test('watcher: player rebuild (SPA) rebinds, old observer disconnected', () => {
  const dom = makeDomStub();
  const firstPlayer = makePlayer('normal');
  dom.setPlayer(firstPlayer);
  const emissions = [];
  const { ui } = loadWatcher(dom);
  const watcher = ui.displayMode.watchPlayerScreenMode((s) => emissions.push(s));

  assert.equal(dom.observers.length, 1);

  // Player node replaced (SPA navigation / part switch), new node in web mode.
  const secondPlayer = makePlayer('web');
  dom.setPlayer(secondPlayer);
  watcher.rebind();

  assert.equal(dom.observers.length, 2, 'exactly one new observer');
  assert.equal(dom.observers[0].disconnected, true, 'old observer disconnected');
  assert.deepEqual(snap(emissions).pop(), { hidden: true, mode: 'web' });
});

test('watcher: missing player fails open, rebind picks it up later', () => {
  const dom = makeDomStub();
  dom.setPlayer(null);
  const emissions = [];
  const { ui } = loadWatcher(dom);
  const watcher = ui.displayMode.watchPlayerScreenMode((s) => emissions.push(s));

  assert.equal(dom.observers.length, 0, 'nothing bound while player absent');
  assert.deepEqual(snap(emissions), [], 'no emission without a player');

  dom.setPlayer(makePlayer('normal'));
  watcher.rebind();
  assert.equal(dom.observers.length, 1);
  assert.deepEqual(snap(emissions), [{ hidden: false, mode: 'normal' }]);
});

test('watcher: destroy disconnects and removes listeners', () => {
  const dom = makeDomStub();
  dom.setPlayer(makePlayer('normal'));
  const { ui } = loadWatcher(dom);
  const watcher = ui.displayMode.watchPlayerScreenMode(() => {});

  watcher.destroy();
  assert.equal(dom.observers[0].disconnected, true);
  assert.equal(dom.listeners['fullscreenchange'], undefined);
});
