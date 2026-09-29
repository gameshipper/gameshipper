import * as fs from 'node:fs';
import * as path from 'node:path';

const plist = (exe: string, id: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${exe}</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`;

/** Where the mini app keeps its stand-in for a native module (like koffi.node) unpacked from the asar. */
export const MINI_NATIVE = 'Contents/Resources/app.asar.unpacked/node_modules/native/native.node';

/**
 * A tiny stand-in for an Electron .app (macOS only): a main executable, one helper app and one native
 * module in app.asar.unpacked, all copies of /usr/bin/true. Signing it takes well under a second.
 */
export function makeMiniApp(dir: string, name = 'Mini'): string {
  const app = path.join(dir, `${name}.app`);
  const helper = path.join(app, 'Contents', 'Frameworks', `${name} Helper.app`);
  for (const [bundle, exe, id] of [
    [app, name, 'local.gameshipper.mini'],
    [helper, `${name} Helper`, 'local.gameshipper.mini.helper'],
  ] as const) {
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    fs.copyFileSync('/usr/bin/true', path.join(bundle, 'Contents', 'MacOS', exe));
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plist(exe, id));
  }
  const native = path.join(app, ...MINI_NATIVE.split('/'));
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.copyFileSync('/usr/bin/true', native);
  return app;
}
