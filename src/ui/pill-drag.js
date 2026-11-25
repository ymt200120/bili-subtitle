/*
 * Hover-to-arm dragging, edge-anchored persistence, smart panel placement,
 * and position locking for the floating "字幕" pill (#bs-pill).
 *
 * Interaction model:
 *   - Unlocked by default so users can move the button out of the way right away.
 *   - Hovering over #bs-pill for HOVER_ARM_MS (500 ms) arms dragging
 *     (bs-drag-ready class -> cursor: move + subtle ring). Leaving or pressing
 *     before 500 ms cancels arming so normal quick clicks just toggle the panel.
 *   - Once armed, pressing and moving < DRAG_THRESHOLD_PX (4 px) still acts as
 *     a click; moving >= 4 px drags the pill clamped to the viewport.
 *   - Dropping persists edge-anchored offsets (nearest horizontal/vertical edge)
 *     so window resizes keep the pill anchored and inside the viewport.
 *   - Only { locked, pos } is persisted (never URLs, cookies, or PII).
 *
 * Pure geometry/storage helpers are exported for DOM-free unit testing.
 */

const STORAGE_KEY = 'bili-subtitle.ui.v1';
const HOVER_ARM_MS = 500;
const DRAG_THRESHOLD_PX = 4;
const EDGE_MARGIN = 8;
const PANEL_GAP = 12;
const PANEL_MARGIN = 12;
const DEFAULT_PILL_WIDTH = 56;
const DEFAULT_PILL_HEIGHT = 34;

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); }
  };
}

function defaultStore() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const probe = '__bili_subtitle_ui_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (_) { /* private mode / disabled storage */ }
  return memoryStore();
}

function normalizePosition(pos) {
  if (!pos || typeof pos !== 'object') return null;
  const { anchorX, offsetX, anchorY, offsetY } = pos;
  if (anchorX !== 'left' && anchorX !== 'right') return null;
  if (anchorY !== 'top' && anchorY !== 'bottom') return null;
  if (typeof offsetX !== 'number' || !Number.isFinite(offsetX) || offsetX < 0) return null;
  if (typeof offsetY !== 'number' || !Number.isFinite(offsetY) || offsetY < 0) return null;
  return { anchorX, offsetX, anchorY, offsetY };
}

function loadState(store) {
  let parsed = {};
  try {
    parsed = JSON.parse((store || defaultStore()).getItem(STORAGE_KEY) || '{}') || {};
  } catch (_) {
    parsed = {};
  }
  return {
    locked: Boolean(parsed.locked),
    pos: normalizePosition(parsed.pos)
  };
}

function saveState(state, store) {
  try {
    (store || defaultStore()).setItem(
      STORAGE_KEY,
      JSON.stringify({
        locked: Boolean(state && state.locked),
        pos: normalizePosition(state && state.pos)
      })
    );
  } catch (_) { /* quota / disabled storage: UI position is best-effort */ }
}

function clamp(value, min, max) {
  const hi = Math.max(min, max);
  const lo = Math.min(min, hi);
  const v = Number.isFinite(value) ? value : lo;
  return Math.min(hi, Math.max(lo, v));
}

function normalizeMargin(margin) {
  return Math.max(0, typeof margin === 'number' && Number.isFinite(margin) ? margin : EDGE_MARGIN);
}

function normalizeSize(size) {
  return {
    width: Math.max(1, Number(size && size.width) || DEFAULT_PILL_WIDTH),
    height: Math.max(1, Number(size && size.height) || DEFAULT_PILL_HEIGHT)
  };
}

function normalizeViewport(viewport) {
  return {
    width: Math.max(0, Number(viewport && viewport.width) || 0),
    height: Math.max(0, Number(viewport && viewport.height) || 0)
  };
}

function clampPillCoords(left, top, viewport, pillSize, margin = EDGE_MARGIN) {
  const vp = normalizeViewport(viewport);
  const size = normalizeSize(pillSize);
  const m = normalizeMargin(margin);
  const maxLeft = Math.max(m, vp.width - size.width - m);
  const maxTop = Math.max(m, vp.height - size.height - m);
  return {
    left: Math.round(clamp(left, m, maxLeft)),
    top: Math.round(clamp(top, m, maxTop))
  };
}

function anchorPillPosition(rect, viewport, margin = EDGE_MARGIN) {
  const vp = normalizeViewport(viewport);
  const size = normalizeSize(rect);
  const m = normalizeMargin(margin);
  const clamped = clampPillCoords(
    rect && rect.left,
    rect && rect.top,
    vp,
    size,
    m
  );
  const distLeft = clamped.left;
  const distRight = vp.width - (clamped.left + size.width);
  const distTop = clamped.top;
  const distBottom = vp.height - (clamped.top + size.height);

  const anchorX = distLeft <= distRight ? 'left' : 'right';
  const offsetX = Math.max(m, Math.round(anchorX === 'left' ? distLeft : distRight));
  const anchorY = distTop <= distBottom ? 'top' : 'bottom';
  const offsetY = Math.max(m, Math.round(anchorY === 'top' ? distTop : distBottom));

  return { anchorX, offsetX, anchorY, offsetY };
}

function resolvePillPosition(pos, viewport, pillSize, margin = EDGE_MARGIN) {
  const p = normalizePosition(pos);
  if (!p) return null;
  const vp = normalizeViewport(viewport);
  const size = normalizeSize(pillSize);
  const rawLeft = p.anchorX === 'right' ? vp.width - size.width - p.offsetX : p.offsetX;
  const rawTop = p.anchorY === 'bottom' ? vp.height - size.height - p.offsetY : p.offsetY;
  return clampPillCoords(rawLeft, rawTop, vp, size, margin);
}

function computePanelPlacement(pillRect, viewport, options = {}) {
  const vp = normalizeViewport(viewport);
  const panelMargin = Math.max(
    0,
    typeof options.panelMargin === 'number' && Number.isFinite(options.panelMargin)
      ? options.panelMargin
      : PANEL_MARGIN
  );
  const panelGap = Math.max(
    0,
    typeof options.panelGap === 'number' && Number.isFinite(options.panelGap)
      ? options.panelGap
      : PANEL_GAP
  );

  const pLeft = Number(pillRect && pillRect.left) || 0;
  const pTop = Number(pillRect && pillRect.top) || 0;
  const pWidth = Math.max(1, Number(pillRect && pillRect.width) || DEFAULT_PILL_WIDTH);
  const pHeight = Math.max(1, Number(pillRect && pillRect.height) || DEFAULT_PILL_HEIGHT);
  const pRight = Number.isFinite(pillRect && pillRect.right) ? pillRect.right : pLeft + pWidth;
  const pBottom = Number.isFinite(pillRect && pillRect.bottom) ? pillRect.bottom : pTop + pHeight;

  const fallbackPanelWidth = Math.min(400, Math.max(0, vp.width - 40));
  const rawPanelWidth = Number(options.panelWidth) > 0 ? Number(options.panelWidth) : fallbackPanelWidth;
  const panelWidth = Math.min(rawPanelWidth, Math.max(0, vp.width - 2 * panelMargin));

  const pillCenterX = pLeft + pWidth / 2;
  const rawLeft = pillCenterX >= vp.width / 2 ? pRight - panelWidth : pLeft;
  const maxLeft = Math.max(panelMargin, vp.width - panelWidth - panelMargin);
  const left = Math.round(clamp(rawLeft, panelMargin, maxLeft));

  const maxCap = Number(options.maxPanelHeight) > 0 ? Number(options.maxPanelHeight) : 560;
  const preferredCap = Math.min(Math.round(vp.height * 0.7), maxCap);
  const spaceAbove = Math.max(0, pTop - panelGap - panelMargin);
  const spaceBelow = Math.max(0, vp.height - pBottom - panelGap - panelMargin);

  if (spaceAbove >= preferredCap || spaceAbove >= spaceBelow) {
    return {
      left,
      top: null,
      bottom: Math.round(vp.height - pTop + panelGap),
      maxHeight: Math.round(Math.min(preferredCap, spaceAbove)),
      side: 'above'
    };
  }

  return {
    left,
    top: Math.round(pBottom + panelGap),
    bottom: null,
    maxHeight: Math.round(Math.min(preferredCap, spaceBelow)),
    side: 'below'
  };
}

function attachPillDrag(pill, options = {}) {
  const activeStore = options.store || defaultStore();
  const win = options.win !== undefined
    ? options.win
    : (typeof window !== 'undefined' ? window : null);
  const doc = options.doc !== undefined
    ? options.doc
    : (pill && pill.ownerDocument ? pill.ownerDocument : (typeof document !== 'undefined' ? document : null));
  const hoverDelayMs = typeof options.hoverDelayMs === 'number' && options.hoverDelayMs >= 0
    ? options.hoverDelayMs
    : HOVER_ARM_MS;
  const dragThresholdPx = typeof options.dragThresholdPx === 'number' && options.dragThresholdPx >= 0
    ? options.dragThresholdPx
    : DRAG_THRESHOLD_PX;
  const edgeMargin = normalizeMargin(options.edgeMargin);
  const onMove = typeof options.onMove === 'function' ? options.onMove : null;
  const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;

  const scheduleTimeout = (fn, ms) => (
    win && typeof win.setTimeout === 'function' ? win.setTimeout(fn, ms) : setTimeout(fn, ms)
  );
  const cancelTimeout = (id) => (
    win && typeof win.clearTimeout === 'function' ? win.clearTimeout(id) : clearTimeout(id)
  );

  const state = loadState(activeStore);
  let hoverTimer = null;
  let clickResetTimer = null;
  let pointerInside = false;
  let pointerDownUnarmed = false;
  let dragReady = false;
  let suppressClick = false;
  let activeDrag = null;
  let destroyed = false;

  const eventTarget = doc && typeof doc.addEventListener === 'function' ? doc : win;

  function getViewport() {
    const docEl = doc && doc.documentElement;
    const width = (docEl && docEl.clientWidth) || (win && win.innerWidth) || 0;
    const height = (docEl && docEl.clientHeight) || (win && win.innerHeight) || 0;
    return { width, height };
  }

  function getPillSize() {
    const rect = typeof pill.getBoundingClientRect === 'function'
      ? pill.getBoundingClientRect()
      : null;
    const width = (rect && rect.width > 0 ? rect.width : pill.offsetWidth) || DEFAULT_PILL_WIDTH;
    const height = (rect && rect.height > 0 ? rect.height : pill.offsetHeight) || DEFAULT_PILL_HEIGHT;
    return { width, height };
  }

  function getPillRect() {
    const rect = typeof pill.getBoundingClientRect === 'function'
      ? pill.getBoundingClientRect()
      : null;
    if (rect && rect.width > 0 && rect.height > 0) {
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      };
    }
    const viewport = getViewport();
    const size = getPillSize();
    const resolved = resolvePillPosition(state.pos, viewport, size, edgeMargin);
    const left = resolved ? resolved.left : Math.max(edgeMargin, viewport.width - size.width - 20);
    const top = resolved ? resolved.top : Math.max(edgeMargin, viewport.height - size.height - 84);
    return {
      left,
      top,
      right: left + size.width,
      bottom: top + size.height,
      width: size.width,
      height: size.height
    };
  }

  function applyInlineCoords(coords) {
    pill.style.left = `${coords.left}px`;
    pill.style.top = `${coords.top}px`;
    pill.style.right = 'auto';
    pill.style.bottom = 'auto';
  }

  function clearInlineCoords() {
    pill.style.left = '';
    pill.style.top = '';
    pill.style.right = '';
    pill.style.bottom = '';
  }

  function setReadyClass(on) {
    if (pill.classList) pill.classList.toggle('bs-drag-ready', !!on);
  }

  function setDraggingClass(on) {
    if (pill.classList) pill.classList.toggle('bs-dragging', !!on);
    const docEl = doc && doc.documentElement;
    if (docEl && docEl.classList) docEl.classList.toggle('bs-pill-dragging', !!on);
  }

  function snapshotState() {
    return {
      locked: state.locked,
      hasCustomPos: Boolean(state.pos),
      dragReady,
      dragging: Boolean(activeDrag && activeDrag.dragging)
    };
  }

  function notifyStateChange() {
    if (onStateChange) onStateChange(snapshotState());
  }

  function clearHoverTimer() {
    if (hoverTimer !== null) {
      cancelTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  function clearClickResetTimer() {
    if (clickResetTimer !== null) {
      cancelTimeout(clickResetTimer);
      clickResetTimer = null;
    }
  }

  function startHoverTimer() {
    clearHoverTimer();
    if (destroyed || state.locked || dragReady || activeDrag || pointerDownUnarmed || !pointerInside) {
      return;
    }
    hoverTimer = scheduleTimeout(() => {
      hoverTimer = null;
      if (destroyed || state.locked || activeDrag || pointerDownUnarmed || !pointerInside) return;
      dragReady = true;
      setReadyClass(true);
      notifyStateChange();
    }, hoverDelayMs);
  }

  function disarmDragReady(silent = false) {
    clearHoverTimer();
    if (dragReady) {
      dragReady = false;
      setReadyClass(false);
      if (!silent) notifyStateChange();
    }
  }

  function syncPosition() {
    if (destroyed) return;
    if (state.pos) {
      const resolved = resolvePillPosition(state.pos, getViewport(), getPillSize(), edgeMargin);
      if (resolved) applyInlineCoords(resolved);
    } else {
      clearInlineCoords();
    }
    if (onMove) onMove(getPillRect());
  }

  function cleanupActiveDrag() {
    if (!activeDrag) return;
    const pointerId = activeDrag.pointerId;
    activeDrag = null;
    setDraggingClass(false);
    if (eventTarget && typeof eventTarget.removeEventListener === 'function') {
      eventTarget.removeEventListener('pointermove', onDocPointerMove);
      eventTarget.removeEventListener('pointerup', onDocPointerUp);
      eventTarget.removeEventListener('pointercancel', onDocPointerCancel);
      eventTarget.removeEventListener('keydown', onDocKeyDownCapture, true);
    }
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('blur', onWindowBlur);
    }
    try {
      if (
        typeof pill.releasePointerCapture === 'function' &&
        pointerId !== undefined &&
        (typeof pill.hasPointerCapture !== 'function' || pill.hasPointerCapture(pointerId))
      ) {
        pill.releasePointerCapture(pointerId);
      }
    } catch (_) { /* capture may already be released */ }
  }

  function abortActiveDrag(silent = false) {
    if (!activeDrag) return;
    const wasDragging = activeDrag.dragging;
    cleanupActiveDrag();
    dragReady = false;
    setReadyClass(false);
    if (wasDragging) syncPosition();
    if (!silent) notifyStateChange();
  }

  function onDocPointerMove(e) {
    if (!activeDrag) return;
    if (activeDrag.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== activeDrag.pointerId) {
      return;
    }
    const clientX = Number(e && e.clientX);
    const clientY = Number(e && e.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

    const dx = clientX - activeDrag.startX;
    const dy = clientY - activeDrag.startY;
    if (!activeDrag.dragging) {
      if (Math.hypot(dx, dy) < dragThresholdPx) return;
      activeDrag.dragging = true;
      dragReady = false;
      setReadyClass(false);
      setDraggingClass(true);
      notifyStateChange();
    }

    const clamped = clampPillCoords(
      activeDrag.originLeft + dx,
      activeDrag.originTop + dy,
      getViewport(),
      { width: activeDrag.pillWidth, height: activeDrag.pillHeight },
      edgeMargin
    );
    activeDrag.lastLeft = clamped.left;
    activeDrag.lastTop = clamped.top;
    applyInlineCoords(clamped);
    if (onMove) onMove(getPillRect());
  }

  function onDocPointerUp(e) {
    if (!activeDrag) return;
    if (activeDrag.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== activeDrag.pointerId) {
      return;
    }
    const drag = activeDrag;
    cleanupActiveDrag();
    dragReady = false;
    setReadyClass(false);

    if (drag.dragging) {
      const viewport = getViewport();
      state.pos = anchorPillPosition(
        {
          left: drag.lastLeft,
          top: drag.lastTop,
          width: drag.pillWidth,
          height: drag.pillHeight
        },
        viewport,
        edgeMargin
      );
      saveState(state, activeStore);
      const resolved = resolvePillPosition(
        state.pos,
        viewport,
        { width: drag.pillWidth, height: drag.pillHeight },
        edgeMargin
      );
      if (resolved) applyInlineCoords(resolved);
      suppressClick = true;
      clearClickResetTimer();
      clickResetTimer = scheduleTimeout(() => {
        clickResetTimer = null;
        suppressClick = false;
      }, 50);
      notifyStateChange();
      if (onMove) onMove(getPillRect());
    } else {
      suppressClick = false;
      notifyStateChange();
    }

    if (pointerInside && !state.locked) startHoverTimer();
  }

  function onDocPointerCancel(e) {
    if (!activeDrag) return;
    if (activeDrag.pointerId !== undefined && e && e.pointerId !== undefined && e.pointerId !== activeDrag.pointerId) {
      return;
    }
    abortActiveDrag();
  }

  function onDocKeyDownCapture(e) {
    if (!activeDrag || !e || e.key !== 'Escape') return;
    if (activeDrag.dragging) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      abortActiveDrag();
    }
  }

  function onWindowBlur() {
    pointerInside = false;
    pointerDownUnarmed = false;
    clearHoverTimer();
    abortActiveDrag();
    disarmDragReady();
  }

  function onPointerEnter(e) {
    if (destroyed) return;
    if (e && e.pointerType === 'touch') return;
    pointerInside = true;
    // Do not start arming if the user entered while holding a mouse button down.
    if (e && typeof e.buttons === 'number' && (e.buttons & 1)) return;
    if (!state.locked && !activeDrag && !dragReady) startHoverTimer();
  }

  function onPointerLeave(e) {
    if (e && e.pointerType === 'touch') return;
    pointerInside = false;
    pointerDownUnarmed = false;
    clearHoverTimer();
    if (!activeDrag) disarmDragReady();
  }

  function onPointerDown(e) {
    // Always clear leftover synthetic-click suppression on the next user press.
    clearClickResetTimer();
    suppressClick = false;
    if (destroyed || state.locked) return;
    if (e && e.pointerType === 'touch') return;
    if (e && typeof e.button === 'number' && e.button !== 0) return;

    if (!dragReady) {
      pointerDownUnarmed = true;
      clearHoverTimer();
      return;
    }

    clearHoverTimer();
    const rect = getPillRect();
    activeDrag = {
      pointerId: e ? e.pointerId : undefined,
      startX: Number(e && e.clientX) || 0,
      startY: Number(e && e.clientY) || 0,
      originLeft: rect.left,
      originTop: rect.top,
      pillWidth: rect.width,
      pillHeight: rect.height,
      dragging: false,
      lastLeft: rect.left,
      lastTop: rect.top
    };

    if (eventTarget && typeof eventTarget.addEventListener === 'function') {
      eventTarget.addEventListener('pointermove', onDocPointerMove);
      eventTarget.addEventListener('pointerup', onDocPointerUp);
      eventTarget.addEventListener('pointercancel', onDocPointerCancel);
      eventTarget.addEventListener('keydown', onDocKeyDownCapture, true);
    }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('blur', onWindowBlur);
    }
    try {
      if (typeof pill.setPointerCapture === 'function' && activeDrag.pointerId !== undefined) {
        pill.setPointerCapture(activeDrag.pointerId);
      }
    } catch (_) { /* synthetic events or unsupported element */ }
  }

  function onPillPointerUp() {
    if (!pointerDownUnarmed) return;
    pointerDownUnarmed = false;
    if (pointerInside && !state.locked && !dragReady && !activeDrag) {
      startHoverTimer();
    }
  }

  function onPillPointerCancel() {
    pointerDownUnarmed = false;
  }

  function onResize() {
    if (activeDrag && activeDrag.dragging) return;
    syncPosition();
  }

  function cancelInteraction() {
    pointerInside = false;
    pointerDownUnarmed = false;
    clearHoverTimer();
    clearClickResetTimer();
    suppressClick = false;
    abortActiveDrag(true);
    disarmDragReady(true);
    notifyStateChange();
  }

  function shouldSuppressClick() {
    if (!suppressClick) return false;
    suppressClick = false;
    clearClickResetTimer();
    return true;
  }

  function setLocked(locked) {
    const next = Boolean(locked);
    if (next === state.locked) return state.locked;
    state.locked = next;
    saveState(state, activeStore);
    if (next) {
      pointerDownUnarmed = false;
      clearHoverTimer();
      abortActiveDrag(true);
      disarmDragReady(true);
    } else if (pointerInside && !activeDrag && !dragReady) {
      startHoverTimer();
    }
    notifyStateChange();
    return state.locked;
  }

  function toggleLocked() {
    return setLocked(!state.locked);
  }

  function resetPosition() {
    if (destroyed || state.locked) return false;
    abortActiveDrag(true);
    state.pos = null;
    saveState(state, activeStore);
    syncPosition();
    notifyStateChange();
    return true;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearHoverTimer();
    clearClickResetTimer();
    suppressClick = false;
    pointerInside = false;
    pointerDownUnarmed = false;
    cleanupActiveDrag();
    dragReady = false;
    setReadyClass(false);
    setDraggingClass(false);
    pill.removeEventListener('pointerenter', onPointerEnter);
    pill.removeEventListener('pointerleave', onPointerLeave);
    pill.removeEventListener('pointerdown', onPointerDown);
    pill.removeEventListener('pointerup', onPillPointerUp);
    pill.removeEventListener('pointercancel', onPillPointerCancel);
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('resize', onResize);
    }
  }

  pill.addEventListener('pointerenter', onPointerEnter);
  pill.addEventListener('pointerleave', onPointerLeave);
  pill.addEventListener('pointerdown', onPointerDown);
  pill.addEventListener('pointerup', onPillPointerUp);
  pill.addEventListener('pointercancel', onPillPointerCancel);
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('resize', onResize);
  }

  syncPosition();
  notifyStateChange();

  return {
    getPillRect,
    getViewport,
    syncPosition,
    cancelInteraction,
    shouldSuppressClick,
    isLocked: () => state.locked,
    isDragging: () => Boolean(activeDrag && activeDrag.dragging),
    hasCustomPosition: () => Boolean(state.pos),
    setLocked,
    toggleLocked,
    resetPosition,
    destroy
  };
}

BS.ui = BS.ui || {};
BS.ui.pillDrag = {
  STORAGE_KEY,
  HOVER_ARM_MS,
  DRAG_THRESHOLD_PX,
  EDGE_MARGIN,
  PANEL_GAP,
  PANEL_MARGIN,
  DEFAULT_PILL_WIDTH,
  DEFAULT_PILL_HEIGHT,
  memoryStore,
  defaultStore,
  normalizePosition,
  loadState,
  saveState,
  clamp,
  clampPillCoords,
  anchorPillPosition,
  resolvePillPosition,
  computePanelPlacement,
  attachPillDrag
};
