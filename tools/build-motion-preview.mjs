import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = process.argv[2];
if (!output || !path.isAbsolute(output))
  throw new Error('An absolute preview output path is required.');
const bundle = await build({
  entryPoints: ['tools/motion-preview.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  minify: true,
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
});
const assets = await readdir('dist/client/_next/static/css');
const cssFiles = assets.filter((file) => file.endsWith('.css'));
if (!cssFiles.length)
  throw new Error('Build the app before exporting its preview.');
const css = (
  await Promise.all(
    cssFiles.map((file) =>
      readFile(path.join('dist/client/_next/static/css', file), 'utf8'),
    ),
  )
).join('\n');
const template = await readFile('tools/motion-preview.fragment.html', 'utf8');
const fragment = template
  .replace('/* APPLICATION_CSS */', () => css)
  .replace('/* APPLICATION_SCRIPT */', () =>
    bundle.outputFiles[0].text.replaceAll('</script', '<\\/script'),
  );
if (Buffer.byteLength(fragment) > 1000000)
  throw new Error('Preview exceeds the inline size limit.');
await writeFile(output, fragment, 'utf8');
console.log(`Preview ready (${Buffer.byteLength(fragment)} bytes)`);
