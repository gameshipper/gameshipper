import { parse, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

/** Where the shim lives inside the web folder of a mobile build. */
export const SHIM_FILE = '_gameshipper/mobile.js';
export const SHIM_TAG = `<script src="/${SHIM_FILE}"></script>`;
/** Added when the page has none: without it phones lay the page out 980px wide and zoom out. */
export const VIEWPORT_TAG = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">';

/**
 * window.gameshipper for iOS/Android builds, with the desktop preload's API ({ version, saves, plugins }) and,
 * like it, an ordinary global a game's own `gameshipper` replaces. window.steam stays undefined, and no plugins
 * run on phones. Saves go to Capacitor Preferences (UserDefaults / SharedPreferences), which the OS never evicts
 * and device backups include. Capacitor's bridge is looked up at each call; outside a Capacitor app saves fall
 * back to localStorage. Plain ES2017 in a string: it's written into the game as a file, not compiled.
 */
export const MOBILE_SHIM_JS = `(function () {
  'use strict';
  if (window.gameshipper) return;
  var PREFIX = 'gameshipper.saves.';
  var SLOT = /^[A-Za-z0-9_-]{1,64}$/;
  function bridge() {
    var cap = window.Capacitor;
    return cap && typeof cap.nativePromise === 'function' && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() ? cap : null;
  }
  function check(slot) {
    if (typeof slot !== 'string' || !SLOT.test(slot)) {
      throw new Error('Invalid save slot name "' + String(slot) + '": use 1-64 letters, numbers, "-" or "_".');
    }
  }
  var kv = {
    get: async function (key) {
      var cap = bridge();
      if (!cap) return window.localStorage.getItem(key);
      var r = await cap.nativePromise('Preferences', 'get', { key: key });
      return r && r.value != null ? r.value : null;
    },
    set: async function (key, value) {
      var cap = bridge();
      if (!cap) return window.localStorage.setItem(key, value);
      await cap.nativePromise('Preferences', 'set', { key: key, value: value });
    },
    remove: async function (key) {
      var cap = bridge();
      if (!cap) return window.localStorage.removeItem(key);
      await cap.nativePromise('Preferences', 'remove', { key: key });
    },
    keys: async function () {
      var cap = bridge();
      if (cap) {
        var r = await cap.nativePromise('Preferences', 'keys', {});
        return (r && r.keys) || [];
      }
      var out = [];
      for (var i = 0; i < window.localStorage.length; i++) out.push(window.localStorage.key(i));
      return out;
    }
  };
  var saves = Object.freeze({
    save: async function (slot, data) {
      check(slot);
      var json = JSON.stringify(data);
      if (json === undefined) throw new Error('Save data must be JSON-serializable (got undefined).');
      await kv.set(PREFIX + slot, json);
    },
    load: async function (slot) {
      check(slot);
      var json = await kv.get(PREFIX + slot);
      return json == null ? null : JSON.parse(json);
    },
    list: async function () {
      return (await kv.keys())
        .filter(function (k) { return k.indexOf(PREFIX) === 0; })
        .map(function (k) { return k.slice(PREFIX.length); })
        .filter(function (slot) { return SLOT.test(slot); })
        .sort();
    },
    delete: async function (slot) {
      check(slot);
      await kv.remove(PREFIX + slot);
    }
  });
  var api = Object.freeze({ version: 1, saves: saves, plugins: Object.freeze({}) });
  Object.defineProperty(window, 'gameshipper', { value: api, writable: true, configurable: true, enumerable: true });
})();
`;

const isElement = (n: Node, name: string): n is Element => n.nodeName === name;

/**
 * Inserts the shim <script> as the first thing in <head>, so it runs before any game script,
 * plus a mobile viewport tag when the page has none.
 */
export function injectShim(html: string): string {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const htmlEl = doc.childNodes.find((n): n is Element => isElement(n, 'html'));
  const head = htmlEl?.childNodes.find((n): n is Element => isElement(n, 'head'));
  const doctype = doc.childNodes.find((n) => n.nodeName === '#documentType');
  const at = head?.sourceCodeLocation?.startTag?.endOffset ?? htmlEl?.sourceCodeLocation?.startTag?.endOffset ?? doctype?.sourceCodeLocation?.endOffset ?? 0;
  const viewport = /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(html) ? '' : VIEWPORT_TAG;
  return `${html.slice(0, at)}${viewport}${SHIM_TAG}${html.slice(at)}`;
}
