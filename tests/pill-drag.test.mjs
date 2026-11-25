import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSrc } from './load.mjs';

const BS = loadSrc();
const pd = BS.ui.pillDrag;

// Project vm-realm objects into plain host-realm objects before assert.deepEqual.
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => now,
    setTimeout(fn, delay = 0) {
      const id = nextId++;
      timers.set(id, { id, fn, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advanceBy(ms) {
      const target = now + ms;
      while (true) {
        let next = null;
        for (const t of timers.values()) {
          if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) {
            next = t;
          }
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pendingCount: () => timers.size
  };
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle(name, force) {
      if (force === undefined) {
        if (set.has(name)) {
          set.delete(name);
          return false;
        }
        set.add(name);
        return true;
      }
      if (force) set.add(name);
      else set.delete(name);
      return Boolean(force);
    },
    contains: (name) => set.has(name)
  };
}

function makeEmitter() {
  const listeners = new Map();
  function key(type, capture) {
    return `${type}:${capture ? 'cap' : 'bub'}`;
  }
  return {
    addEventListener(type, fn, capture = false) {
      const k = key(type, Boolean(capture));
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
    },
    removeEventListener(type, fn, capture = false) {
      const k = key(type, Boolean(capture));
      const bucket = listeners.get(k);
      if (bucket) bucket.delete(fn);
    },
    dispatch(type, event = {}, capture = false) {
      const k = key(type, Boolean(capture));
      const bucket = listeners.get(k);
      if (!bucket) return;
      for (const fn of [...bucket]) fn(event);
    },
    listenerCount(type, capture = false) {
      const bucket = listeners.get(key(type, Boolean(capture)));
      return bucket ? bucket.size : 0;
    }
  };
}

function makeDomEnv({ width = 1280, height = 800, pillWidth = 56, pillHeight = 34 } = {}) {
  const clock = makeFakeClock();
  const docEmitter = makeEmitter();
  const winEmitter = makeEmitter();
  const pillEmitter = makeEmitter();

  const docEl = {
    clientWidth: width,
    clientHeight: height,
    classList: makeClassList()
  };

  const doc = {
    documentElement: docEl,
    addEventListener: docEmitter.addEventListener,
    removeEventListener: docEmitter.removeEventListener,
    dispatch: (type, event = {}) => {
      let stopped = false;
      const wrapped = {
        ...event,
        preventDefault() { wrapped.defaultPrevented = true; },
        stopPropagation() { stopped = true; },
        stopImmediatePropagation() { stopped = true; }
      };
      docEmitter.dispatch(type, wrapped, true);
      if (!stopped) docEmitter.dispatch(type, wrapped, false);
      return wrapped;
    },
    listenerCount: docEmitter.listenerCount
  };

  const win = {
    innerWidth: width,
    innerHeight: height,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    addEventListener: winEmitter.addEventListener,
    removeEventListener: winEmitter.removeEventListener,
    dispatch: winEmitter.dispatch,
    listenerCount: winEmitter.listenerCount,
    resizeTo(nextW, nextH) {
      docEl.clientWidth = nextW;
      docEl.clientHeight = nextH;
      win.innerWidth = nextW;
      win.innerHeight = nextH;
      winEmitter.dispatch('resize', {});
    }
  };

  const capturedPointers = new Set();
  const style = { left: '', top: '', right: '', bottom: '' };
  let hidden = false;

  const pill = {
    ownerDocument: doc,
    style,
    classList: makeClassList(),
    offsetWidth: pillWidth,
    offsetHeight: pillHeight,
    addEventListener: pillEmitter.addEventListener,
    removeEventListener: pillEmitter.removeEventListener,
    dispatch: pillEmitter.dispatch,
    listenerCount: pillEmitter.listenerCount,
    setPointerCapture(id) { capturedPointers.add(id); },
    releasePointerCapture(id) { capturedPointers.delete(id); },
    hasPointerCapture(id) { return capturedPointers.has(id); },
    setHidden(v) { hidden = Boolean(v); },
    getBoundingClientRect() {
      if (hidden) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      const hasInline = style.left.endsWith('px') && style.top.endsWith('px');
      const left = hasInline ? parseFloat(style.left) : docEl.clientWidth - pillWidth - 20;
      const top = hasInline ? parseFloat(style.top) : docEl.clientHeight - pillHeight - 84;
      return {
        left,
        top,
        right: left + pillWidth,
        bottom: top + pillHeight,
        width: pillWidth,
        height: pillHeight
      };
    }
  };

  return { clock, doc, docEl, win, pill, capturedPointers };
}

/* ---------- Storage tests ---------- */

test('storage: empty store defaults to unlocked with null pos', () => {
  const store = pd.memoryStore();
  assert.deepEqual(plain(pd.loadState(store)), { locked: false, pos: null });
});

test('storage: malformed JSON and invalid fields degrade safely', () => {
  const store = pd.memoryStore();
  store.setItem(pd.STORAGE_KEY, '{not-json');
  assert.deepEqual(plain(pd.loadState(store)), { locked: false, pos: null });

  const invalidPositions = [
    null,
    'left',
    { anchorX: 'center', offsetX: 10, anchorY: 'top', offsetY: 10 },
    { anchorX: 'left', offsetX: 10, anchorY: 'middle', offsetY: 10 },
    { anchorX: 'left', offsetX: -5, anchorY: 'top', offsetY: 10 },
    { anchorX: 'left', offsetX: null, anchorY: 'top', offsetY: 10 },
    { anchorX: 'left', offsetX: 10, anchorY: 'top', offsetY: '10' },
    { anchorX: 'left', offsetX: Number.NaN, anchorY: 'top', offsetY: 10 }
  ];
  for (const badPos of invalidPositions) {
    store.setItem(pd.STORAGE_KEY, JSON.stringify({ locked: 1, pos: badPos }));
    assert.deepEqual(plain(pd.loadState(store)), { locked: true, pos: null });
  }
});

test('storage: saveState and loadState round-trip valid state', () => {
  const store = pd.memoryStore();
  const pos = { anchorX: 'left', offsetX: 24, anchorY: 'top', offsetY: 40 };
  pd.saveState({ locked: true, pos }, store);
  assert.deepEqual(plain(pd.loadState(store)), { locked: true, pos });
});

test('storage: throwing store never throws on loadState or saveState', () => {
  const throwingStore = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); }
  };
  assert.deepEqual(plain(pd.loadState(throwingStore)), { locked: false, pos: null });
  assert.doesNotThrow(() => pd.saveState({ locked: true, pos: null }, throwingStore));
});

/* ---------- Geometry tests ---------- */

test('geometry: clampPillCoords clamps all four edges and tiny viewports', () => {
  const vp = { width: 1280, height: 800 };
  const sz = { width: 56, height: 34 };
  assert.deepEqual(plain(pd.clampPillCoords(-50, -20, vp, sz)), { left: 8, top: 8 });
  assert.deepEqual(plain(pd.clampPillCoords(2000, 2000, vp, sz)), {
    left: 1280 - 56 - 8,
    top: 800 - 34 - 8
  });
  assert.deepEqual(plain(pd.clampPillCoords(300, 200, vp, sz)), { left: 300, top: 200 });
  assert.deepEqual(plain(pd.clampPillCoords(100, 100, { width: 40, height: 30 }, sz)), {
    left: 8,
    top: 8
  });
});

test('geometry: anchorPillPosition picks nearest edge in all four quadrants', () => {
  const vp = { width: 1000, height: 800 };
  assert.deepEqual(plain(pd.anchorPillPosition({ left: 20, top: 30, width: 56, height: 34 }, vp)), {
    anchorX: 'left',
    offsetX: 20,
    anchorY: 'top',
    offsetY: 30
  });
  assert.deepEqual(plain(pd.anchorPillPosition({ left: 900, top: 25, width: 56, height: 34 }, vp)), {
    anchorX: 'right',
    offsetX: 44,
    anchorY: 'top',
    offsetY: 25
  });
  assert.deepEqual(plain(pd.anchorPillPosition({ left: 15, top: 700, width: 56, height: 34 }, vp)), {
    anchorX: 'left',
    offsetX: 15,
    anchorY: 'bottom',
    offsetY: 66
  });
  assert.deepEqual(plain(pd.anchorPillPosition({ left: 924, top: 682, width: 56, height: 34 }, vp)), {
    anchorX: 'right',
    offsetX: 20,
    anchorY: 'bottom',
    offsetY: 84
  });
});

test('geometry: resolvePillPosition preserves edge offset across shrink and re-expand', () => {
  const pos = { anchorX: 'right', offsetX: 20, anchorY: 'bottom', offsetY: 84 };
  const sz = { width: 56, height: 34 };

  const shrunk = pd.resolvePillPosition(pos, { width: 100, height: 100 }, sz);
  assert.deepEqual(plain(shrunk), { left: 24, top: 8 });

  const expanded = pd.resolvePillPosition(pos, { width: 1920, height: 1080 }, sz);
  assert.deepEqual(plain(expanded), { left: 1920 - 56 - 20, top: 1080 - 34 - 84 });

  assert.equal(pd.resolvePillPosition(null, { width: 1000, height: 800 }, sz), null);
});

test('geometry: computePanelPlacement aligns per quadrant and never overlaps pill or viewport', () => {
  const vp = { width: 1280, height: 800 };

  // Default bottom-right pill
  const br = pd.computePanelPlacement(
    { left: 1204, top: 682, right: 1260, bottom: 716, width: 56, height: 34 },
    vp,
    { panelWidth: 400 }
  );
  assert.deepEqual(plain(br), {
    left: 860,
    top: null,
    bottom: 130,
    maxHeight: 560,
    side: 'above'
  });

  // Top-left pill -> opens below, left-aligned
  const tl = pd.computePanelPlacement(
    { left: 20, top: 20, right: 76, bottom: 54, width: 56, height: 34 },
    vp,
    { panelWidth: 400 }
  );
  assert.deepEqual(plain(tl), {
    left: 20,
    top: 66,
    bottom: null,
    maxHeight: 560,
    side: 'below'
  });

  // Top-right pill -> opens below, right-aligned
  const tr = pd.computePanelPlacement(
    { left: 1200, top: 16, right: 1256, bottom: 50, width: 56, height: 34 },
    vp,
    { panelWidth: 400 }
  );
  assert.deepEqual(plain(tr), {
    left: 856,
    top: 62,
    bottom: null,
    maxHeight: 560,
    side: 'below'
  });

  // Bottom-left pill -> opens above, left-aligned
  const bl = pd.computePanelPlacement(
    { left: 16, top: 730, right: 72, bottom: 764, width: 56, height: 34 },
    vp,
    { panelWidth: 400 }
  );
  assert.deepEqual(plain(bl), {
    left: 16,
    top: null,
    bottom: 82,
    maxHeight: 560,
    side: 'above'
  });

  // Mid-screen where below has slightly more space -> picks below and caps maxHeight
  const mid = pd.computePanelPlacement(
    { left: 600, top: 300, right: 656, bottom: 334, width: 56, height: 34 },
    vp,
    { panelWidth: 400 }
  );
  assert.equal(mid.side, 'below');
  assert.equal(mid.top, 346);
  assert.equal(mid.maxHeight, 800 - 334 - 12 - 12);

  // Narrow & short viewport -> clamped left >= 12 and maxHeight capped to available room
  const tight = pd.computePanelPlacement(
    { left: 10, top: 20, right: 66, bottom: 54, width: 56, height: 34 },
    { width: 320, height: 260 },
    { panelWidth: 400 }
  );
  assert.equal(tight.left, 12);
  assert.equal(tight.side, 'below');
  assert.equal(tight.top, 66);
  assert.equal(tight.maxHeight, Math.min(Math.round(260 * 0.7), 260 - 54 - 12 - 12));
});

/* ---------- Controller interaction tests ---------- */

test('controller: hover < 500ms does not arm, pressing cancels pending timer, normal click works', () => {
  const env = makeDomEnv();
  const store = pd.memoryStore();
  const ctrl = pd.attachPillDrag(env.pill, { store, win: env.win, doc: env.doc });

  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(499);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);

  // Pressing before 500ms cancels the pending timer and does not arm even after waiting longer
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1220, clientY: 700, pointerId: 1 });
  env.clock.advanceBy(600);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);
  assert.equal(ctrl.isDragging(), false);

  env.pill.dispatch('pointerup', { pointerType: 'mouse', button: 0, pointerId: 1 });
  assert.equal(ctrl.shouldSuppressClick(), false);

  // Keeping cursor over pill after release waits a full fresh 500ms before arming
  env.clock.advanceBy(250);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);
  env.clock.advanceBy(250);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), true);

  ctrl.destroy();
});

test('controller: hover >= 500ms arms drag, pointerleave disarms, touch & right-click ignored', () => {
  const env = makeDomEnv();
  const ctrl = pd.attachPillDrag(env.pill, { store: pd.memoryStore(), win: env.win, doc: env.doc });

  // Touch hover ignored
  env.pill.dispatch('pointerenter', { pointerType: 'touch' });
  env.clock.advanceBy(600);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);

  // Mouse hover arms after 500ms
  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(500);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), true);

  // Non-primary button ignored
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 2, clientX: 1220, clientY: 700, pointerId: 1 });
  env.doc.dispatch('pointermove', { clientX: 900, clientY: 500, pointerId: 1 });
  assert.equal(ctrl.isDragging(), false);

  // Pointerleave clears armed state
  env.pill.dispatch('pointerleave', { pointerType: 'mouse' });
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);

  ctrl.destroy();
});

test('controller: armed press with movement < 4px acts as normal click', () => {
  const env = makeDomEnv();
  const store = pd.memoryStore();
  let moves = 0;
  const ctrl = pd.attachPillDrag(env.pill, {
    store,
    win: env.win,
    doc: env.doc,
    onMove: () => { moves++; }
  });

  const initialMoves = moves;
  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(500);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), true);

  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1220, clientY: 700, pointerId: 1 });
  env.doc.dispatch('pointermove', { clientX: 1222, clientY: 702, pointerId: 1 }); // dist ~2.83 < 4
  assert.equal(ctrl.isDragging(), false);
  assert.equal(moves, initialMoves);

  env.doc.dispatch('pointerup', { clientX: 1222, clientY: 702, pointerId: 1 });
  assert.equal(ctrl.isDragging(), false);
  assert.equal(ctrl.hasCustomPosition(), false);
  assert.equal(ctrl.shouldSuppressClick(), false);
  assert.equal(env.pill.style.left, '');

  ctrl.destroy();
});

test('controller: drag >= 4px clamps, persists, suppresses trailing click once, and re-arms inside pill', () => {
  const env = makeDomEnv();
  const store = pd.memoryStore();
  let moveCalls = 0;
  const ctrl = pd.attachPillDrag(env.pill, {
    store,
    win: env.win,
    doc: env.doc,
    onMove: () => { moveCalls++; }
  });

  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(500);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), true);

  const movesBefore = moveCalls;
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1220, clientY: 700, pointerId: 7 });
  assert.equal(env.capturedPointers.has(7), true);

  // Move beyond top-left boundary -> clamps to (8, 8)
  env.doc.dispatch('pointermove', { clientX: -1000, clientY: -1000, pointerId: 7 });
  assert.equal(ctrl.isDragging(), true);
  assert.equal(env.pill.classList.contains('bs-dragging'), true);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);
  assert.equal(env.docEl.classList.contains('bs-pill-dragging'), true);
  assert.equal(env.pill.style.left, '8px');
  assert.equal(env.pill.style.top, '8px');
  assert.ok(moveCalls > movesBefore);

  // Move to (100, 120) from origin (1204, 682): dx = -1120, dy = -580 -> (84, 102)
  env.doc.dispatch('pointermove', { clientX: 100, clientY: 120, pointerId: 7 });
  assert.equal(env.pill.style.left, '84px');
  assert.equal(env.pill.style.top, '102px');

  // Drop
  env.doc.dispatch('pointerup', { clientX: 100, clientY: 120, pointerId: 7 });
  assert.equal(ctrl.isDragging(), false);
  assert.equal(env.pill.classList.contains('bs-dragging'), false);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);
  assert.equal(env.docEl.classList.contains('bs-pill-dragging'), false);
  assert.equal(env.capturedPointers.has(7), false);
  assert.equal(ctrl.hasCustomPosition(), true);

  const saved = plain(pd.loadState(store));
  assert.deepEqual(saved, {
    locked: false,
    pos: { anchorX: 'left', offsetX: 84, anchorY: 'top', offsetY: 102 }
  });

  // Trailing synthetic click suppressed once
  assert.equal(ctrl.shouldSuppressClick(), true);
  assert.equal(ctrl.shouldSuppressClick(), false);

  // Pointer still inside pill -> re-arms after 500ms
  env.clock.advanceBy(500);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), true);

  // Second drag to test 50ms auto-clear of click suppression when no synthetic click arrives
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 90, clientY: 110, pointerId: 8 });
  env.doc.dispatch('pointermove', { clientX: 110, clientY: 130, pointerId: 8 });
  env.doc.dispatch('pointerup', { clientX: 110, clientY: 130, pointerId: 8 });
  env.clock.advanceBy(50);
  assert.equal(ctrl.shouldSuppressClick(), false);

  ctrl.destroy();
});

test('controller: Escape, pointercancel, and blur mid-drag revert position and do not save', () => {
  const env = makeDomEnv();
  const store = pd.memoryStore();
  const ctrl = pd.attachPillDrag(env.pill, { store, win: env.win, doc: env.doc });

  // 1. Escape cancels drag without closing panel (stopPropagation + preventDefault)
  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(500);
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1220, clientY: 700, pointerId: 1 });
  env.doc.dispatch('pointermove', { clientX: 500, clientY: 300, pointerId: 1 });
  assert.equal(ctrl.isDragging(), true);

  let bubbleEscCalled = false;
  const bubbleListener = () => { bubbleEscCalled = true; };
  env.doc.addEventListener('keydown', bubbleListener, false);
  const escEv = env.doc.dispatch('keydown', { key: 'Escape' });
  env.doc.removeEventListener('keydown', bubbleListener, false);

  assert.equal(escEv.defaultPrevented, true);
  assert.equal(bubbleEscCalled, false);
  assert.equal(ctrl.isDragging(), false);
  assert.equal(env.docEl.classList.contains('bs-pill-dragging'), false);
  assert.equal(env.pill.style.left, '');
  assert.equal(ctrl.hasCustomPosition(), false);

  // 2. pointercancel reverts
  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(500);
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1220, clientY: 700, pointerId: 2 });
  env.doc.dispatch('pointermove', { clientX: 500, clientY: 300, pointerId: 2 });
  env.doc.dispatch('pointercancel', { pointerId: 2 });
  assert.equal(ctrl.isDragging(), false);
  assert.equal(env.pill.style.left, '');
  assert.equal(ctrl.hasCustomPosition(), false);

  // 3. window.blur reverts
  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(500);
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1220, clientY: 700, pointerId: 3 });
  env.doc.dispatch('pointermove', { clientX: 500, clientY: 300, pointerId: 3 });
  env.win.dispatch('blur', {});
  assert.equal(ctrl.isDragging(), false);
  assert.equal(env.docEl.classList.contains('bs-pill-dragging'), false);
  assert.equal(env.pill.style.left, '');
  assert.equal(ctrl.hasCustomPosition(), false);

  ctrl.destroy();
});

test('controller: lock blocks hovering/dragging and cancels active drag; unlock re-arms if inside', () => {
  const env = makeDomEnv();
  const store = pd.memoryStore();
  const states = [];
  const ctrl = pd.attachPillDrag(env.pill, {
    store,
    win: env.win,
    doc: env.doc,
    onStateChange: (s) => states.push(plain(s))
  });

  // Start hovering & dragging, then lock mid-drag
  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(500);
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1220, clientY: 700, pointerId: 1 });
  env.doc.dispatch('pointermove', { clientX: 500, clientY: 300, pointerId: 1 });
  assert.equal(ctrl.isDragging(), true);

  ctrl.setLocked(true);
  assert.equal(ctrl.isLocked(), true);
  assert.equal(ctrl.isDragging(), false);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);
  assert.equal(env.docEl.classList.contains('bs-pill-dragging'), false);
  assert.equal(env.pill.style.left, '');
  assert.equal(plain(pd.loadState(store)).locked, true);

  // Hovering while locked does not arm
  env.pill.dispatch('pointerleave', { pointerType: 'mouse' });
  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(1000);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);

  // Unlocking while pointer is still inside schedules hover arming
  ctrl.setLocked(false);
  assert.equal(ctrl.isLocked(), false);
  env.clock.advanceBy(500);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), true);
  assert.ok(states.some((s) => s.locked === true));

  ctrl.destroy();
});

test('controller: resetPosition is no-op while locked and restores default when unlocked', () => {
  const env = makeDomEnv();
  const store = pd.memoryStore();
  pd.saveState(
    { locked: true, pos: { anchorX: 'left', offsetX: 50, anchorY: 'top', offsetY: 60 } },
    store
  );
  const ctrl = pd.attachPillDrag(env.pill, { store, win: env.win, doc: env.doc });

  assert.equal(env.pill.style.left, '50px');
  assert.equal(env.pill.style.top, '60px');

  assert.equal(ctrl.resetPosition(), false);
  assert.equal(ctrl.hasCustomPosition(), true);
  assert.equal(env.pill.style.left, '50px');

  ctrl.setLocked(false);
  assert.equal(ctrl.resetPosition(), true);
  assert.equal(ctrl.hasCustomPosition(), false);
  assert.equal(env.pill.style.left, '');
  assert.equal(env.pill.style.top, '');
  assert.equal(env.pill.style.right, '');
  assert.equal(env.pill.style.bottom, '');
  assert.deepEqual(plain(pd.loadState(store)), { locked: false, pos: null });

  ctrl.destroy();
});

test('controller: window.resize re-clamps pill without overwriting stored offsets', () => {
  const env = makeDomEnv({ width: 1280, height: 800 });
  const store = pd.memoryStore();
  pd.saveState(
    { locked: false, pos: { anchorX: 'right', offsetX: 20, anchorY: 'bottom', offsetY: 84 } },
    store
  );
  const ctrl = pd.attachPillDrag(env.pill, { store, win: env.win, doc: env.doc });
  assert.equal(env.pill.style.left, '1204px');
  assert.equal(env.pill.style.top, '682px');

  env.win.resizeTo(100, 100);
  assert.equal(env.pill.style.left, '24px');
  assert.equal(env.pill.style.top, '8px');
  assert.deepEqual(plain(pd.loadState(store)).pos, {
    anchorX: 'right',
    offsetX: 20,
    anchorY: 'bottom',
    offsetY: 84
  });

  env.win.resizeTo(1920, 1080);
  assert.equal(env.pill.style.left, '1844px');
  assert.equal(env.pill.style.top, '962px');

  ctrl.destroy();
});

test('controller: cancelInteraction and destroy clean up state, classes, timers, and listeners', () => {
  const env = makeDomEnv();
  const ctrl = pd.attachPillDrag(env.pill, { store: pd.memoryStore(), win: env.win, doc: env.doc });

  env.pill.dispatch('pointerenter', { pointerType: 'mouse' });
  env.clock.advanceBy(500);
  env.pill.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 1220, clientY: 700, pointerId: 1 });
  env.doc.dispatch('pointermove', { clientX: 500, clientY: 300, pointerId: 1 });
  assert.equal(ctrl.isDragging(), true);

  // Fullscreen hide calls cancelInteraction()
  ctrl.cancelInteraction();
  assert.equal(ctrl.isDragging(), false);
  assert.equal(env.pill.classList.contains('bs-dragging'), false);
  assert.equal(env.pill.classList.contains('bs-drag-ready'), false);
  assert.equal(env.docEl.classList.contains('bs-pill-dragging'), false);
  assert.equal(env.clock.pendingCount(), 0);

  // Destroy removes all pill/window/doc listeners and ignores further events
  ctrl.destroy();
  assert.equal(env.pill.listenerCount('pointerenter'), 0);
  assert.equal(env.pill.listenerCount('pointerleave'), 0);
  assert.equal(env.pill.listenerCount('pointerdown'), 0);
  assert.equal(env.win.listenerCount('resize'), 0);
  assert.equal(env.doc.listenerCount('pointermove'), 0);
  assert.equal(env.doc.listenerCount('keydown', true), 0);
});
