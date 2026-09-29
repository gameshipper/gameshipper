// What a `check` run measures in the running game. Imported by core for its types, so it must never import
// `electron`.
import type { Size } from './capture.js';

export interface OffscreenElement {
  /** tag#id.class */
  element: string;
  text: string;
  /** left, top, right, bottom in CSS pixels */
  rect: [number, number, number, number];
}

export interface LayoutProbe {
  viewport: Size;
  /** document.documentElement.scrollWidth and scrollHeight */
  scroll: Size;
  /** Whether the page hides overflow (so no scrollbar appears) on each axis. */
  overflowHidden: { x: boolean; y: boolean };
  /** Visible text, canvases, images and controls that stick out past the screen (at most MAX_OFFSCREEN). */
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
 * Runs inside the game's page (main.ts sends it as source text with executeJavaScript), so it must not use
 * anything from outside its own body.
 */
export function layoutProbe(): LayoutProbe {
  const TOLERANCE = 2;
  const MAX_ELEMENTS = 3000;
  const LIMIT = 10;
  const de = document.documentElement;
  const body = document.body;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hides = (value: string): boolean => value === 'hidden' || value === 'clip';
  const htmlStyle = getComputedStyle(de);
  const bodyStyle = body ? getComputedStyle(body) : null;
  // body's overflow applies to the viewport when html's is 'visible' (CSS overflow propagation).
  const axisHidden = (axis: 'overflowX' | 'overflowY'): boolean =>
    hides(htmlStyle[axis]) || (htmlStyle[axis] === 'visible' && bodyStyle !== null && hides(bodyStyle[axis]));
  const offscreen: OffscreenElement[] = [];
  const elements = body ? Array.from(body.querySelectorAll('*')).slice(0, MAX_ELEMENTS) : [];
  for (const el of elements) {
    if (offscreen.length >= LIMIT) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const onScreen = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    const sticksOut = r.left < -TOLERANCE || r.top < -TOLERANCE || r.right > vw + TOLERANCE || r.bottom > vh + TOLERANCE;
    // Elements entirely off screen are usually hidden on purpose (off-canvas menus, screen-reader text).
    if (!onScreen || !sticksOut) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
    const media = /^(CANVAS|IMG|VIDEO|BUTTON|INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (!ownText && !media) continue;
    const id = el.id ? `#${el.id}` : '';
    const classes = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    offscreen.push({
      element: `${el.tagName.toLowerCase()}${id}${classes}`,
      text: (el.textContent ?? '').trim().slice(0, 60),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    });
  }
  const textInputs = document.querySelectorAll(
    'input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=tel], input[type=password], input[type=number], textarea, [contenteditable]:not([contenteditable=false])',
  ).length;
  return {
    viewport: { width: vw, height: vh },
    scroll: { width: de.scrollWidth, height: de.scrollHeight },
    overflowHidden: { x: axisHidden('overflowX'), y: axisHidden('overflowY') },
    offscreen,
    textInputs,
  };
}

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
      return { element: text(o.element, MAX_ELEMENT_CHARS), text: text(o.text, MAX_TEXT_CHARS), rect: [px(rect[0]), px(rect[1]), px(rect[2]), px(rect[3])] };
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
