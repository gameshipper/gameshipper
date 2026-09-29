import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDiagnostics, MAX_INFO_EVENTS } from '../../src/shell/diagnostics.js';
import { entryUrl } from '../../src/shell/runtime-config.js';
import { makeTmpDir } from '../helpers/tmp.js';

describe('createDiagnostics', () => {
  it('keeps events and appends them to a JSONL log', () => {
    const log = path.join(makeTmpDir(), 'events.jsonl');
    const d = createDiagnostics(log);
    d.record({ kind: 'missing-file', url: 'app://game/a.png' });
    d.record({ kind: 'console', level: 'error', message: 'Uncaught TypeError: x', source: 'app://game/main.js', line: 3 });
    expect(d.summary().events).toHaveLength(2);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[1]).toMatchObject({ kind: 'console', level: 'error', line: 3 });
    expect(typeof lines[0].at).toBe('string');
  });

  it('caps chatty info/debug console events but never drops errors', () => {
    const d = createDiagnostics(null);
    for (let i = 0; i < MAX_INFO_EVENTS + 50; i++) d.record({ kind: 'console', level: 'info', message: `tick ${i}`, source: '', line: 0 });
    d.record({ kind: 'console', level: 'error', message: 'boom', source: '', line: 0 });
    const s = d.summary();
    expect(s.droppedInfo).toBe(50);
    expect(s.events).toHaveLength(MAX_INFO_EVENTS + 1);
    expect(s.events.at(-1)).toMatchObject({ level: 'error' });
  });
});

describe('entryUrl', () => {
  it('encodes each path segment', () => {
    expect(entryUrl('index.html')).toBe('app://game/index.html');
    expect(entryUrl('levels/My Game.html')).toBe('app://game/levels/My%20Game.html');
  });
});
