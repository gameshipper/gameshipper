#!/usr/bin/env node
import { start } from './start.js';

process.exitCode = await start(process.argv.slice(2), () => import('../dist/cli/main.js'));
