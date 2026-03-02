import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import Mocha from 'mocha';

const root = process.cwd();
const testDir = join(root, 'test');
const files = (await readdir(testDir))
  .filter((name) => name.endsWith('.spec.ts'))
  .sort()
  .map((name) => join(testDir, name));

const mocha = new Mocha({ timeout: 10000 });
for (const file of files) {
  mocha.addFile(file);
}

await mocha.loadFilesAsync();

const failures = await new Promise((resolve) => {
  mocha.run((count) => resolve(count));
});

process.exitCode = failures > 0 ? 1 : 0;
