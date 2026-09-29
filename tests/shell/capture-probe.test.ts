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
import { cleanCounters, cleanLayout, LAYOUT_PROBE_JS, layoutProbe, PROBE_ARG, READ_COUNTERS_JS, screenCut, type LayoutProbe } from '../../src/shell/probe.js';

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
  /** Where the element's own text is drawn, as a Range around it measures it. Default: inside its box. */
  textRect?: Rect;
  style?: Record<string, string>;
  /** Index of the parent element in `elements`; default: body. */
  parent?: number;
}

function fakeDom(opts: {
  html?: Record<string, string>;
  body?: Record<string, string>;
  bodyRect?: Rect;
  elements: FakeEl[];
  inputs?: number;
  scroll?: [number, number];
}): void {
  const style = (s: Record<string, string> = {}) => ({
    visibility: 'visible',
    opacity: '1',
    overflowX: 'visible',
    overflowY: 'visible',
    position: 'static',
    transform: 'none',
    ...s,
  });
  const domRect = (r: Rect) => ({ left: r[0], top: r[1], right: r[2], bottom: r[3], width: r[2] - r[0], height: r[3] - r[1] });
  const [sw, sh] = opts.scroll ?? [1280, 800];
  const documentElement = { scrollWidth: sw, scrollHeight: sh, style: style(opts.html), parentElement: null };
  const body: Record<string, unknown> = { style: style(opts.body), parentElement: documentElement, getBoundingClientRect: () => domRect(opts.bodyRect ?? [0, 0, 1280, 800]) };
  const elements: Record<string, unknown>[] = [];
  for (const e of opts.elements) {
    elements.push({
      tagName: e.tag.toUpperCase(),
      id: e.id ?? '',
      className: e.className ?? '',
      textContent: e.text ?? '',
      childNodes: e.text ? [{ nodeType: 3, textContent: e.text, drawnAt: e.textRect ?? e.rect }] : [],
      getBoundingClientRect: () => domRect(e.rect),
      style: style(e.style),
      parentElement: e.parent === undefined ? body : elements[e.parent],
    });
  }
  body.querySelectorAll = () => elements;
  const createRange = () => {
    let node: { drawnAt: Rect } | null = null;
    return { selectNodeContents: (n: { drawnAt: Rect }) => (node = n), getBoundingClientRect: () => domRect(node!.drawnAt) };
  };
  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal('Node', { TEXT_NODE: 3 });
  vi.stubGlobal('getComputedStyle', (el: { style: object }) => el.style);
  vi.stubGlobal('document', { documentElement, body, createRange, querySelectorAll: () => ({ length: opts.inputs ?? 0 }) });
}

/** Runs the probe the way main.ts does: as source text in the page. */
const probeInPage = () => (new Function(`return ${LAYOUT_PROBE_JS};`) as () => unknown)();

describe('screenCut', () => {
  const deck = { width: 1280, height: 800 };
  const noClip = { x: false, y: false };
  // A HUD at right: 20px, width: 320px, white-space: nowrap, whose text is longer than its box.
  const hud = { box: [940, 20, 1260, 57] as Rect, text: [940, 20, 1720, 57] as Rect, media: false, clip: noClip };

  it('finds text running past the screen edge from a box that fits', () => {
    expect(screenCut(deck, hud, [])).toBe('text');
    expect(screenCut(deck, { ...hud, text: [940, 20, 1250, 57] }, [])).toBeNull();
  });

  it('text its own box, or a box inside the screen, clips is not cut off by the screen', () => {
    expect(screenCut(deck, { ...hud, clip: { x: true, y: false } }, [])).toBeNull();
    expect(screenCut(deck, hud, [{ rect: [900, 0, 1270, 100], x: true, y: false }])).toBeNull();
    // Clipping on the other axis doesn't help.
    expect(screenCut(deck, hud, [{ rect: [900, 0, 1270, 100], x: false, y: true }])).toBe('text');
    // A box that clips at (or past) the screen edge leaves the text cut off at the screen edge.
    expect(screenCut(deck, hud, [{ rect: [0, 0, 1280, 800], x: true, y: true }])).toBe('text');
    expect(screenCut(deck, hud, [{ rect: [-100, 0, 1500, 800], x: true, y: true }])).toBe('text');
  });

  it('finds elements that stick out, when they have text or are media', () => {
    const canvas = { box: [8, 8, 1288, 808] as Rect, text: null, media: true, clip: noClip };
    expect(screenCut(deck, canvas, [])).toBe('box');
    expect(screenCut(deck, { ...canvas, media: false }, [])).toBeNull();
    expect(screenCut(deck, { box: [1200, 700, 1300, 900] as Rect, text: [1200, 700, 1250, 720] as Rect, media: false, clip: noClip }, [])).toBe('box');
    expect(screenCut(deck, canvas, [{ rect: [0, 0, 1000, 700], x: true, y: true }])).toBeNull();
  });

  it('ignores anything entirely off screen and a couple of pixels of overhang', () => {
    expect(screenCut(deck, { box: [-9999, 0, -9000, 20], text: [-9999, 0, -9000, 20], media: false, clip: noClip }, [])).toBeNull();
    expect(screenCut(deck, { ...hud, text: [940, 20, 1282, 57] }, [])).toBeNull();
    expect(screenCut(deck, { ...hud, text: [940, 760, 1200, 830] }, [])).toBe('text');
  });
});

describe('layoutProbe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports nothing for a game that fills the screen and hides overflow', () => {
    fakeDom({ html: { overflowX: 'hidden', overflowY: 'hidden' }, elements: [{ tag: 'canvas', rect: [0, 0, 1280, 800] }], scroll: [1280, 804] });
    expect(probeInPage()).toEqual({
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
    const probe = probeInPage() as LayoutProbe;
    expect(probe.overflowHidden).toEqual({ x: false, y: true });
    expect(probe.textInputs).toBe(2);
    expect(probe.offscreen).toEqual([
      { element: 'div#hud.hud.top', text: 'Score: 0 | Lives: 3', rect: [900, 20, 1487, 57], cut: 'box' },
      { element: 'canvas', text: '', rect: [8, 8, 1288, 808], cut: 'box' },
    ]);
  });

  it('finds HUD text that runs off the screen from a box that fits, unless something inside the screen clips it', () => {
    const long = 'Score: 000000 · Lives: 3 · Level: 1 · Best: 999999';
    fakeDom({
      // With html's overflow visible, body's overflow is the screen's (CSS overflow propagation): body clips nothing.
      body: { overflowX: 'hidden', overflowY: 'hidden' },
      bodyRect: [8, 8, 1272, 792],
      elements: [
        { tag: 'div', id: 'hud', text: long, rect: [940, 20, 1260, 57], textRect: [940, 20, 1712, 57], style: { position: 'absolute' } },
        { tag: 'div', className: 'title', text: long, rect: [100, 100, 400, 140], textRect: [100, 100, 1500, 140], style: { overflowX: 'hidden', overflowY: 'hidden' } },
        { tag: 'div', id: 'panel', rect: [800, 200, 1200, 600], style: { overflowX: 'auto', overflowY: 'auto' } },
        { tag: 'p', text: long, rect: [820, 220, 1180, 260], textRect: [820, 220, 1400, 260], parent: 2 },
        { tag: 'span', id: 'toast', text: long, rect: [900, 700, 1200, 740], textRect: [900, 700, 1600, 740], style: { position: 'fixed' }, parent: 2 },
      ],
    });
    expect((probeInPage() as LayoutProbe).offscreen).toEqual([
      { element: 'div#hud', text: long.slice(0, 60), rect: [940, 20, 1712, 57], cut: 'text' },
      // A fixed element isn't clipped by the scrolling panel it sits in.
      { element: 'span#toast', text: long.slice(0, 60), rect: [900, 700, 1600, 740], cut: 'text' },
    ]);
  });

  it('counts body as a box that clips when its overflow is its own', () => {
    fakeDom({
      html: { overflowX: 'hidden', overflowY: 'hidden' },
      body: { overflowX: 'hidden', overflowY: 'hidden' },
      bodyRect: [8, 8, 1272, 792],
      elements: [{ tag: 'div', id: 'hud', text: 'Score', rect: [940, 20, 1260, 57], textRect: [940, 20, 1712, 57] }],
    });
    expect((probeInPage() as LayoutProbe).offscreen).toEqual([]);
  });

  it('is self-contained, so it can run in the page as source text', () => {
    fakeDom({ elements: [{ tag: 'div', text: 'Score', rect: [1200, 0, 1400, 20] }] });
    // new Function sees only globals, as the page does: using anything else from probe.ts would throw here.
    expect(probeInPage()).toEqual(layoutProbe(screenCut));
  });
});

describe('cleaning what the page answered', () => {
  it('keeps a well-formed layout as it is', () => {
    const layout: LayoutProbe = {
      viewport: { width: 1280, height: 800 },
      scroll: { width: 1300, height: 800 },
      overflowHidden: { x: false, y: true },
      offscreen: [
        { element: 'div#hud', text: 'Score', rect: [900, 20, 1487, 57], cut: 'box' },
        { element: 'div#hud2', text: 'Lives', rect: [900, 60, 1487, 97], cut: 'text' },
      ],
      textInputs: 1,
    };
    expect(cleanLayout(layout)).toEqual(layout);
  });

  it('bounds whatever a page that replaced the probe’s functions sent back', () => {
    const raw = {
      viewport: { width: '1280', height: 800.4 },
      scroll: null,
      overflowHidden: { x: 'yes' },
      offscreen: Array.from({ length: 50 }, () => ({ element: 'x'.repeat(5000), text: 'y'.repeat(5000), rect: [1, 'two', 3.6], cut: 'everything' })),
      textInputs: -4,
    };
    const clean = cleanLayout(raw)!;
    expect(clean.viewport).toEqual({ width: 0, height: 800 });
    expect(clean.scroll).toEqual({ width: 0, height: 0 });
    expect(clean.overflowHidden).toEqual({ x: false, y: false });
    expect(clean.offscreen).toHaveLength(10);
    expect(clean.offscreen[0]).toEqual({ element: 'x'.repeat(100), text: 'y'.repeat(60), rect: [1, 0, 4, 0], cut: 'box' });
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
