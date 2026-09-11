import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Export reviewed application sources without the private Sites repository history.
const destination = resolve(process.argv[2] || 'work/github-pages-source');
if (existsSync(destination)) throw new Error('Choose a new, empty destination.');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(Boolean).filter((file) => !file.startsWith('.openai/'));
files.push('index.html', 'app/pages-entry.tsx', 'lib/paper-layout.ts',
  'vite.pages.config.ts', '.github/workflows/pages.yml', 'tools/prepare-pages-source.mjs');
for (const file of new Set(files)) {
  const target = resolve(destination, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
}
mkdirSync(resolve(destination, '.openai'), { recursive: true });
writeFileSync(resolve(destination, '.openai/hosting.json'), '{"d1":null,"r2":null}\n');
console.log(destination);
