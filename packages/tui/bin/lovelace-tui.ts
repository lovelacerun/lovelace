#!/usr/bin/env node
import { runTui } from '../src/index.js';

runTui(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
