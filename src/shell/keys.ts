export interface KeyInput {
  type: string;
  key: string;
  alt: boolean;
  /** True for the repeated key-downs sent while a key is held. */
  isAutoRepeat?: boolean;
}

export function isFullscreenToggle(input: KeyInput): boolean {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return false;
  return input.key === 'F11' || (input.key === 'Enter' && input.alt);
}
