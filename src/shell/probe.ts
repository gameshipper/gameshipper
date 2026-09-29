// What a `check` run measures in the running game. Imported by core for its types, so it must never import
// `electron`.
import type { Size } from './capture.js';

/** left, top, right, bottom in CSS pixels */
export type Rect = [number, number, number, number];

export interface OffscreenElement {
  /** tag#id.class */
  element: string;
  text: string;
  /** Where it is cut off: the element's box, or its text when only the text runs past the screen edge. */
  rect: Rect;
  /** 'box': the element sticks out past the screen edge. 'text': its box fits, but its text runs past the edge. */
  cut: 'box' | 'text';
}

/** A box that clips what overflows it (overflow other than visible) on the axes marked true. */
export interface ClipBox {
  rect: Rect;
  x: boolean;
  y: boolean;
}

/** What layoutProbe measured of one element. */
export interface MeasuredElement {
  box: Rect;
  /** Around the element's own text (a Range around each of its text nodes), or null when it has none. */
  text: Rect | null;
  /** A canvas, image, video or form control: its box counts even without text. */
  media: boolean;
  /** The axes on which the element clips its own content. */
  clip: { x: boolean; y: boolean };
}

export interface LayoutProbe {
  viewport: Size;
  /** document.documentElement.scrollWidth and scrollHeight */
  scroll: Size;
  /** Whether the page hides overflow (so no scrollbar appears) on each axis. */
  overflowHidden: { x: boolean; y: boolean };
  /** Visible text, canvases, images and controls the screen's edge cuts off (at most MAX_OFFSCREEN). */
  offscreen: OffscreenElement[];
  /** Text fields on the page at the end of the run. */
  textInputs: number;
}

export interface InputCounters {
  /** Calls to navigator.getGamepads(). */
  getGamepads: number;
  /** gamepadconnected / gamepaddisconnected listeners added. */
  gamepadListeners: number;
}

/** What a `check` run measured at its end, stored in the smoke summary as `probe`. */
export interface ProbeReport {
  /** The fixed size the page was laid out at, or null when it couldn't be fixed. */
  viewport: Size | null;
  /** PNG of the last frame at exactly `viewport`, or null if it couldn't be captured. */
  frame: string | null;
  layout: LayoutProbe | null;
  /** null when the preload's counters weren't there. */
  counters: InputCounters | null;
  /** Anything that went wrong while measuring. */
  errors: string[];
}

/** Given to the page through webPreferences.additionalArguments; preload.ts checks for the same literal. */
export const PROBE_ARG = '--gameshipper-probe';

/** Reads the counters preload.ts keeps under navigator[Symbol.for('gameshipper.probe')]. */
export const READ_COUNTERS_JS =
  "(() => { const read = navigator[Symbol.for('gameshipper.probe')]; return typeof read === 'function' ? read() : null; })()";

export const MAX_OFFSCREEN = 10;
const MAX_ELEMENT_CHARS = 100;
const MAX_TEXT_CHARS = 60;

/**
 * Whether the screen's edge cuts off an element ('box': it sticks out) or, when its box fits, its own text ('text':
 * it runs past the edge), or neither (null). Something a box clips before it reaches the screen edge isn't cut off
 * by the screen: `clips` are the ancestors that clip the element, and the element clips its own text on the axes
 * in `el.clip`. Only boxes and text partly on screen count: something entirely off screen is usually hidden on
 * purpose (off-canvas menus, screen-reader text). A box counts only with its own text, or as media.
 *
 * Runs inside the game's page with layoutProbe, so it must not use anything from outside its own body.
 */
export function screenCut(viewport: Size, el: MeasuredElement, clips: ClipBox[]): 'box' | 'text' | null {
  const TOLERANCE = 2;
  const vw = viewport.width;
  const vh = viewport.height;
  const onScreen = (r: Rect): boolean => r[2] > 0 && r[3] > 0 && r[0] < vw && r[1] < vh;
  // Past an edge of the screen, with no clipping box's edge inside the screen on that side first.
  const cutOff = (r: Rect, boxes: ClipBox[]): boolean =>
    onScreen(r) &&
    ((r[0] < -TOLERANCE && !boxes.some((c) => c.x && c.rect[0] > TOLERANCE)) ||
      (r[2] > vw + TOLERANCE && !boxes.some((c) => c.x && c.rect[2] < vw - TOLERANCE)) ||
      (r[1] < -TOLERANCE && !boxes.some((c) => c.y && c.rect[1] > TOLERANCE)) ||
      (r[3] > vh + TOLERANCE && !boxes.some((c) => c.y && c.rect[3] < vh - TOLERANCE)));
  if ((el.text || el.media) && cutOff(el.box, clips)) return 'box';
  if (el.text && cutOff(el.text, [...clips, { rect: el.box, x: el.clip.x, y: el.clip.y }])) return 'text';
  return null;
}

/**
 * Runs inside the game's page (main.ts sends LAYOUT_PROBE_JS with executeJavaScript), so it must not use anything
 * from outside its own body: screenCut comes in as `cut`.
 */
export function layoutProbe(cut: typeof screenCut): LayoutProbe {
  const MAX_ELEMENTS = 3000;
  const LIMIT = 10;
  const de = document.documentElement;
  const body = document.body;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const hides = (value: string): boolean => value === 'hidden' || value === 'clip';
  const htmlStyle = getComputedStyle(de);
  const bodyStyle = body ? getComputedStyle(body) : null;
  // body's overflow applies to the viewport when html's is 'visible' (CSS overflow propagation).
  const propagated = htmlStyle.overflowX === 'visible' && htmlStyle.overflowY === 'visible';
  const axisHidden = (axis: 'overflowX' | 'overflowY'): boolean =>
    hides(htmlStyle[axis]) || (propagated && bodyStyle !== null && hides(bodyStyle[axis]));
  const rectOf = (r: { left: number; top: number; right: number; bottom: number }): Rect => [r.left, r.top, r.right, r.bottom];
  /** Around the element's own text nodes, or null when it has no text of its own. */
  const ownText = (el: Element): Rect | null => {
    let around: Rect | null = null;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? '').trim() === '') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      around = around
        ? [Math.min(around[0], r.left), Math.min(around[1], r.top), Math.max(around[2], r.right), Math.max(around[3], r.bottom)]
        : rectOf(r);
    }
    return around;
  };
  /**
   * The ancestors that clip the element: those with overflow other than visible (auto and scroll clip too) in its
   * chain of containing blocks. A position: absolute element skips ancestors below its positioned one, and a
   * position: fixed element all but transformed ones.
   */
  const clipsOf = (el: Element, position: string): ClipBox[] => {
    const boxes: ClipBox[] = [];
    for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
      const style = getComputedStyle(a);
      const transformed = style.transform !== 'none';
      const contains = position === 'fixed' ? transformed : position === 'absolute' ? transformed || style.position !== 'static' : true;
      if (!contains) continue;
      position = style.position;
      if (a === body && propagated) continue;
      const x = style.overflowX !== 'visible';
      const y = style.overflowY !== 'visible';
      if (x || y) boxes.push({ rect: rectOf(a.getBoundingClientRect()), x, y });
    }
    return boxes;
  };
  const offscreen: OffscreenElement[] = [];
  const elements = body ? Array.from(body.querySelectorAll('*')).slice(0, MAX_ELEMENTS) : [];
  for (const el of elements) {
    if (offscreen.length >= LIMIT) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const media = /^(CANVAS|IMG|VIDEO|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    const measured: MeasuredElement = { box: rectOf(r), text: ownText(el), media, clip: { x: false, y: false } };
    // Cheap first: nothing is cut off even if nothing clips it.
    if (!cut(viewport, measured, [])) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    measured.clip = { x: style.overflowX !== 'visible', y: style.overflowY !== 'visible' };
    const where = cut(viewport, measured, clipsOf(el, style.position));
    if (!where) continue;
    const rect = where === 'text' && measured.text ? measured.text : measured.box;
    const id = el.id ? `#${el.id}` : '';
    const classes = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    offscreen.push({
      element: `${el.tagName.toLowerCase()}${id}${classes}`,
      text: (el.textContent ?? '').trim().slice(0, 60),
      rect: [Math.round(rect[0]), Math.round(rect[1]), Math.round(rect[2]), Math.round(rect[3])],
      cut: where,
    });
  }
  const textInputs = document.querySelectorAll(
    'input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=password], input[type=number], textarea, [contenteditable]:not([contenteditable=false])',
  ).length;
  return {
    viewport,
    scroll: { width: de.scrollWidth, height: de.scrollHeight },
    overflowHidden: { x: axisHidden('overflowX'), y: axisHidden('overflowY') },
    offscreen,
    textInputs,
  };
}

/** What main.ts runs in the page to measure it. */
export const LAYOUT_PROBE_JS = `(${layoutProbe.toString()})(${screenCut.toString()})`;

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const px = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const size = (v: unknown): Size => ({ width: count(record(v).width), height: count(record(v).height) });

/**
 * layoutProbe's answer as trusted data. The page may have replaced the functions the probe uses, so this keeps
 * the shape and the limits (MAX_OFFSCREEN elements, short texts) whatever came back. null for no answer.
 */
export function cleanLayout(raw: unknown): LayoutProbe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = record(raw);
  const hidden = record(r.overflowHidden);
  const offscreen = Array.isArray(r.offscreen) ? r.offscreen.slice(0, MAX_OFFSCREEN) : [];
  return {
    viewport: size(r.viewport),
    scroll: size(r.scroll),
    overflowHidden: { x: hidden.x === true, y: hidden.y === true },
    offscreen: offscreen.map((item) => {
      const o = record(item);
      const rect = Array.isArray(o.rect) ? o.rect : [];
      return {
        element: text(o.element, MAX_ELEMENT_CHARS),
        text: text(o.text, MAX_TEXT_CHARS),
        rect: [px(rect[0]), px(rect[1]), px(rect[2]), px(rect[3])],
        cut: o.cut === 'text' ? 'text' : 'box',
      };
    }),
    textInputs: count(r.textInputs),
  };
}

/** The preload's counters as trusted data, or null when the page had none. */
export function cleanCounters(raw: unknown): InputCounters | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = record(raw);
  return { getGamepads: count(r.getGamepads), gamepadListeners: count(r.gamepadListeners) };
}
