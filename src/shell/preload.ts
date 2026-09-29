// Electron's sandboxed preload may only require('electron'), so this file deliberately has no
// import/export statements: TypeScript then emits no module helpers beyond one
// `exports.__esModule` marker, which the sandboxed preload wrapper tolerates.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const callSaves = (op: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke('gameshipper:saves', op, ...args);

contextBridge.exposeInMainWorld('gameshipper', {
  version: 1,
  saves: {
    save: (slot: string, data: unknown) => callSaves('save', slot, data),
    load: (slot: string) => callSaves('load', slot),
    list: () => callSaves('list'),
    delete: (slot: string) => callSaves('delete', slot),
  },
});
