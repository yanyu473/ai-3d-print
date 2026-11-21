import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const appFile = path => new URL(path, import.meta.url);
const cadFile = name => appFile(`../evidence/cad/${name}`);
const sliceFile = name => appFile(`../evidence/slicing-wasm/${name}`);
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', glb: 'model/gltf-binary', step: 'application/step', stl: 'model/stl' };
const pages = new Map([
  ['/', appFile('index.html')],
  ['/index.html', appFile('index.html')],
  ['/style.css', appFile('style.css')],
  ['/preview.js', appFile('preview.js')],
  ['/toolpath.js', appFile('toolpath.js')],
  ['/cad/verification.json', cadFile('verification.json')],
  ['/cad/model.glb', cadFile('model.glb')],
  ['/cad/model.step', cadFile('model.step')],
  ['/cad/model.stl', cadFile('model.stl')],
  ['/slice/verification.json', sliceFile('verification.json')],
  ['/slice/toolpath-preview.json', sliceFile('toolpath-preview.json')],
  ['/slice/toolpath.gcode', sliceFile('toolpath.gcode')],
  ['/vendor/three/LICENSE', appFile('vendor/three/LICENSE')],
]);

for (const name of ['build/three.module.js', 'build/three.core.js', 'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/utils/BufferGeometryUtils.js', 'examples/jsm/utils/SkeletonUtils.js']) {
  const url = `/vendor/three/${name}`;
  pages.set(url, appFile(`.${url}`));
}

const html = readFileSync(appFile('index.html'), 'utf8');
const importMap = html.match(/<script type="importmap">(.*?)<\/script>/s)?.[1];
if (!importMap) throw new Error('The local module import map is missing.');
const importMapHash = createHash('sha256').update(importMap).digest('base64');

const port = Number(process.env.CAD_PREVIEW_PORT ?? 4783);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CAD_PREVIEW_PORT must be between 1 and 65535.');

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'sha256-${importMapHash}'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const asset = pages.get(request.url);
  if (!asset) {
    response.writeHead(404).end();
    return;
  }
  try {
    const info = await stat(asset);
    const extension = asset.pathname.split('.').at(-1);
    response.writeHead(200, { 'Content-Type': types[extension] ?? 'text/plain; charset=utf-8', 'Content-Length': info.size });
    if (request.method === 'HEAD') response.end();
    else await pipeline(createReadStream(asset), response);
  } catch (error) {
    if (response.headersSent) response.destroy();
    else response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
});

server.on('error', error => {
  console.error(`CAD preview server: ${error.code ?? error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`CAD 样件预览 http://127.0.0.1:${port}/`));
