export interface KeyInput {
  type: string;
  key: string;
  alt: boolean;
  control?: boolean;
  shift?: boolean;
  meta?: boolean;
  /** True for the repeated key-downs sent while a key is held. */
  isAutoRepeat?: boolean;
}

export function isFullscreenToggle(input: KeyInput): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false;
  return input.key === 'F11' || (input.key === 'Enter' && input.alt);
}

/** F12 on its own, once per press: holding it down doesn't take a burst of screenshots. */
export function isScreenshotKey(input: KeyInput): boolean {
  return input.type === 'keyDown' && input.key === 'F12' && !input.alt && !input.control && !input.shift && !input.meta && !input.isAutoRepeat;
}
