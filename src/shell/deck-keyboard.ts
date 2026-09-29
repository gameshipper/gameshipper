/** What the preload reports when a text field in the game gets focus, or is tapped while it has it. */
export interface FocusInfo {
  tag: string;
  /** An input's normalized type (el.type: lowercase, "text" when missing or unknown); "" otherwise. */
  type: string;
  editable: boolean;
  /** A read-only input or textarea takes no typing, so it gets no keyboard. */
  readOnly?: boolean;
  /** getBoundingClientRect() in CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
  /** window.devicePixelRatio */
  scale: number;
}

/** Steam's EFloatingGamepadTextInputMode values. */
export const KEYBOARD_MODE = { singleLine: 0, multipleLines: 1, email: 2, numeric: 3 } as const;

const SINGLE_LINE_INPUTS = new Set(['', 'text', 'search', 'url', 'password']);

function modeFor(tag: unknown, type: unknown, editable: unknown): number | null {
  if (editable === true || tag === 'textarea') return KEYBOARD_MODE.multipleLines;
  if (tag !== 'input') return null;
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  if (t === 'email') return KEYBOARD_MODE.email;
  if (t === 'number' || t === 'tel') return KEYBOARD_MODE.numeric;
  return SINGLE_LINE_INPUTS.has(t) ? KEYBOARD_MODE.singleLine : null;
}

/**
 * Arguments for Steam's ShowFloatingGamepadTextInput(mode, x, y, width, height) when a text
 * field gets focus on a Steam Deck: the keyboard avoids covering that area (window pixels).
 * Null when the focused element doesn't take text.
 */
export function floatingKeyboardArgs(info: unknown): [number, number, number, number, number] | null {
  if (!info || typeof info !== 'object') return null;
  const { tag, type, editable, readOnly, rect, scale } = info as Partial<FocusInfo>;
  if (readOnly === true) return null;
  const mode = modeFor(tag, type, editable);
  if (mode === null) return null;
  const s = typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
  // Anything that isn't a finite number of pixels counts as 0: the keyboard still opens, just anywhere.
  const px = (v: unknown) => {
    const scaled = typeof v === 'number' ? Math.round(v * s) : Number.NaN;
    return Number.isFinite(scaled) ? scaled : 0;
  };
  return [mode, px(rect?.x), px(rect?.y), px(rect?.width), px(rect?.height)];
}
