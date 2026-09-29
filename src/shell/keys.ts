export interface KeyInput {
  type: string;
  key: string;
  alt: boolean;
}

export function isFullscreenToggle(input: KeyInput): boolean {
  if (input.type !== 'keyDown') return false;
  return input.key === 'F11' || (input.key === 'Enter' && input.alt);
}
