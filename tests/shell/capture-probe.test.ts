import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_ENV_NAMES,
  captureEnv,
  captureSettings,
  isAllowedOffline,
  noticeLine,
  noticesIn,
  shellCaptureSettings,
  parseSecondsList,
  parseSize,
  screenshotFileName,
  type CaptureSettings,
} from '../../src/shell/capture.js';
import { isFullscreenToggle, isScreenshotKey } from '../../src/shell/keys.js';
import { cleanCounters, cleanLayout, layoutProbe, PROBE_ARG, READ_COUNTERS_JS } from '../../src/shell/probe.js';

describe('capture settings', () => {
  it('parseSize reads WxH', () => {
    expect(parseSize('1280x800')).toEqual({ width: 1280, height: 800 });
    expect(parseSize('1280')).toBeNull();
    expect(parseSize(undefined)).toBeNull();
  });

  it('parseSecondsList keeps positive numbers', () => {
    expect(parseSecondsList('3, 6.5,9')).toEqual([3, 6.5, 9]);
    expect(parseSecondsList('0,-1,x,,4')).toEqual([4]);
    expect(parseSecondsList(undefined)).toEqual([]);
  });

  it('go to the shell as environment variables and come back unchanged', () => {
    const all: CaptureSettings = {
      screenshotDir: '/p/out/store/screenshots',
      screenshotAt: [2, 4.5],
      viewport: { width: 1920, height: 1080 },
      offline: true,
      probeDir: '/p/.gameshipper/check',
    };
    const env = captureEnv(all);
    expect(env).toEqual({
      GAMESHIPPER_SCREENSHOT_DIR: '/p/out/store/screenshots',
      GAMESHIPPER_SCREENSHOT_AT: '2,4.5',
      GAMESHIPPER_VIEWPORT: '1920x1080',
      GAMESHIPPER_OFFLINE: '1',
      GAMESHIPPER_PROBE_DIR: '/p/.gameshipper/check',
    });
    expect(Object.keys(env).sort()).toEqual([...CAPTURE_ENV_NAMES].sort());
    expect(captureSettings(env)).toEqual(all);
    expect(captureEnv({})).toEqual({});
    expect(captureSettings({})).toEqual({});
  });

  it('a shipped game honours them only in a smoke or check run; the unpackaged app `play` runs always does', () => {
    const env = captureEnv({ screenshotDir: '/p/out/store/screenshots', offline: true });
    // A player launching the shipped game with these set in their environment gets none of it.
    expect(shellCaptureSettings(env, true)).toEqual({});
    expect(shellCaptureSettings({ ...env, GAMESHIPPER_SMOKE_SECONDS: '0' }, true)).toEqual({});
    expect(shellCaptureSettings({ ...env, GAMESHIPPER_SMOKE_SECONDS: '15' }, true)).toEqual({ screenshotDir: '/p/out/store/screenshots', offline: true });
    expect(shellCaptureSettings(env, false)).toEqual({ screenshotDir: '/p/out/store/screenshots', offline: true });
  });

  it('notices for the person playing are single lines found in the output, wherever the chunks split', () => {
    expect(noticeLine("Couldn't save the screenshot:\nno frame")).toBe("gameshipper-notice: Couldn't save the screenshot: no frame\n");
    const found: string[] = [];
    const feed = noticesIn((m) => found.push(m));
    const text = `[1234:ERROR] gpu\n${noticeLine('first')}plain line\n${noticeLine('second')}`;
    for (const chunk of [text.slice(0, 20), text.slice(20, 41), text.slice(41)]) feed(chunk);
    expect(found).toEqual(['first', 'second']);
  });

  it('screenshotFileName is sortable and file-safe', () => {
    expect(screenshotFileName(new Date('2026-09-29T10:15:30.123Z'))).toBe('screenshot-2026-09-29T10-15-30-123Z.png');
  });

  it('offline mode allows only the game and in-memory URLs', () => {
    for (const url of ['app://game/index.html', 'data:text/plain,hi', 'blob:app://game/1234', 'about:blank']) expect(isAllowedOffline(url), url).toBe(true);
    for (const url of ['https://unpkg.com/three', 'http://127.0.0.1:8080/x', 'wss://example.com/socket', 'file:///etc/hosts']) {
      expect(isAllowedOffline(url), url).toBe(false);
    }
  });
});

describe('isScreenshotKey', () => {
  const key = (k: object) => ({ type: 'keyDown', key: 'F12', alt: false, ...k });
  it('F12 alone, once per press', () => {
    expect(isScreenshotKey(key({}))).toBe(true);
    expect(isScreenshotKey(key({ type: 'keyUp' }))).toBe(false);
    expect(isScreenshotKey(key({ isAutoRepeat: true }))).toBe(false);
    expect(isScreenshotKey(key({ shift: true }))).toBe(false);
    expect(isScreenshotKey(key({ control: true }))).toBe(false);
    expect(isScreenshotKey(key({ key: 'F11' }))).toBe(false);
    // F11 still toggles fullscreen with the new fields present.
    expect(isFullscreenToggle(key({ key: 'F11', shift: false, control: false, meta: false }))).toBe(true);
  });
});

type Rect = [number, number, number, number];
interface FakeEl {
  tag: string;
  rect: Rect;
  id?: string;
  className?: string;
  text?: string;
  style?: Record<string, string>;
}

function fakeDom(opts: { html?: Record<string, string>; body?: Record<string, string>; elements: FakeEl[]; inputs?: number; scroll?: [number, number] }): void {
  const style = (s: Record<string, string> = {}) => ({ visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible', ...s });
  const elements = opts.elements.map((e) => ({
    tagName: e.tag.toUpperCase(),
    id: e.id ?? '',
    className: e.className ?? '',
    textContent: e.text ?? '',
    childNodes: e.text ? [{ nodeType: 3, textContent: e.text }] : [],
    getBoundingClientRect: () => ({ left: e.rect[0], top: e.rect[1], right: e.rect[2], bottom: e.rect[3], width: e.rect[2] - e.rect[0], height: e.rect[3] - e.rect[1] }),
    style: style(e.style),
  }));
  const [sw, sh] = opts.scroll ?? [1280, 800];
  const documentElement = { scrollWidth: sw, scrollHeight: sh, style: style(opts.html) };
  const body = { style: style(opts.body), querySelectorAll: () => elements };
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal('Node', { TEXT_NODE: 3 });
  vi.stubGlobal('getComputedStyle', (el: { style: object }) => el.style);
  vi.stubGlobal('document', { documentElement, body, querySelectorAll: () => ({ length: opts.inputs ?? 0 }) });
}

describe('layoutProbe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports nothing for a game that fills the screen and hides overflow', () => {
    fakeDom({ html: { overflowX: 'hidden', overflowY: 'hidden' }, elements: [{ tag: 'canvas', rect: [0, 0, 1280, 800] }], scroll: [1280, 804] });
    expect(layoutProbe()).toEqual({
      viewport: { width: 1280, height: 800 },
      scroll: { width: 1280, height: 804 },
      overflowHidden: { x: true, y: true },
      offscreen: [],
      textInputs: 0,
    });
  });

  it('lists visible text and canvases that stick out, ignoring hidden and fully off-screen elements', () => {
    fakeDom({
      body: { overflowY: 'hidden' },
      inputs: 2,
      elements: [
        { tag: 'div', id: 'hud', className: 'hud top', text: 'Score: 0 | Lives: 3', rect: [900, 20, 1487, 57] },
        { tag: 'canvas', rect: [8, 8, 1288, 808] },
        { tag: 'div', text: 'screen reader only', rect: [-9999, 0, -9000, 20] },
        { tag: 'div', text: 'faded', rect: [1200, 0, 1400, 20], style: { opacity: '0' } },
        { tag: 'div', rect: [1200, 0, 1400, 20] },
      ],
    });
    const probe = layoutProbe();
    expect(probe.overflowHidden).toEqual({ x: false, y: true });
    expect(probe.textInputs).toBe(2);
    expect(probe.offscreen).toEqual([
      { element: 'div#hud.hud.top', text: 'Score: 0 | Lives: 3', rect: [900, 20, 1487, 57] },
      { element: 'canvas', text: '', rect: [8, 8, 1288, 808] },
    ]);
  });

  it('is self-contained, so it can run in the page as source text', () => {
    fakeDom({ elements: [{ tag: 'div', text: 'Score', rect: [1200, 0, 1400, 20] }] });
    // new Function sees only globals, as the page does: using anything else from probe.ts would throw here.
    const inPage = new Function(`return (${layoutProbe.toString()})();`) as () => unknown;
    expect(inPage()).toEqual(layoutProbe());
  });
});

describe('cleaning what the page answered', () => {
  it('keeps a well-formed layout as it is', () => {
    const layout = {
      viewport: { width: 1280, height: 800 },
      scroll: { width: 1300, height: 800 },
      overflowHidden: { x: false, y: true },
      offscreen: [{ element: 'div#hud', text: 'Score', rect: [900, 20, 1487, 57] as Rect }],
      textInputs: 1,
    };
    expect(cleanLayout(layout)).toEqual(layout);
  });

  it('bounds whatever a page that replaced the probe’s functions sent back', () => {
    const raw = {
      viewport: { width: '1280', height: 800.4 },
      scroll: null,
      overflowHidden: { x: 'yes' },
      offscreen: Array.from({ length: 50 }, () => ({ element: 'x'.repeat(5000), text: 'y'.repeat(5000), rect: [1, 'two', 3.6] })),
      textInputs: -4,
    };
    const clean = cleanLayout(raw)!;
    expect(clean.viewport).toEqual({ width: 0, height: 800 });
    expect(clean.scroll).toEqual({ width: 0, height: 0 });
    expect(clean.overflowHidden).toEqual({ x: false, y: false });
    expect(clean.offscreen).toHaveLength(10);
    expect(clean.offscreen[0]).toEqual({ element: 'x'.repeat(100), text: 'y'.repeat(60), rect: [1, 0, 4, 0] });
    expect(clean.textInputs).toBe(0);
    expect(cleanLayout('nope')).toBeNull();
    expect(cleanCounters({ getGamepads: 3, gamepadListeners: 'x' })).toEqual({ getGamepads: 3, gamepadListeners: 0 });
    expect(cleanCounters(null)).toBeNull();
  });
});

describe('preload ↔ probe', () => {
  it('the preload counts gamepad use only for the probe argument, where READ_COUNTERS_JS reads it', () => {
    const preload = fs.readFileSync(fileURLToPath(new URL('../../src/shell/preload.ts', import.meta.url)), 'utf8');
    expect(preload).toContain(`process.argv.includes('${PROBE_ARG}')`);
    expect(preload).toContain("Symbol.for('gameshipper.probe')");
    expect(READ_COUNTERS_JS).toContain("Symbol.for('gameshipper.probe')");
  });
});
