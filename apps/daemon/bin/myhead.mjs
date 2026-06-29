#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.MYHEAD_CLI_ENTRY = '1';
require('../dist/index.js');
