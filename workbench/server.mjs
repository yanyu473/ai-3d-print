import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { imageLimit, idPattern, ProjectError, Projects, root } from './projects.mjs';

const appId = 'local-3d-workbench-v1';
const host = '127.0.0.1';
const port = Number(process.env.WORKBENCH_PORT ?? 4790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WORKBENCH_PORT 须为有效端口。');
const address = `http://${host}:${port}`;
const loopbackHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
const bodyLimit = Math.ceil(imageLimit / 3) * 4 + 8192;
const webRoot = join(root, 'workbench', 'web');
const html = await readFile(join(webRoot, 'index.html'), 'utf8');
const importMap = html.match(/<script\s+type=["']importmap["']\s*>(.*?)<\/script>/s)?.[1];
if (!importMap) throw new Error('工作台页面缺少 Three.js 的本地导入配置。');
const importHash = createHash('sha256').update(importMap).digest('base64');

const routes = new Map([
  ['/', join(webRoot, 'index.html')], ['/index.html', join(webRoot, 'index.html')],
  ...['styles.css', 'app.js', 'viewer.js', 'layers.js'].map(name => [`/${name}`, join(webRoot, name)]),
  ...['bracket.png', 'tray.png', 'washer.png'].map(name => [`/specimens/${name}`, join(webRoot, 'specimens', name)]),
]);
for (const name of [
  'LICENSE', 'build/three.module.js', 'build/three.core.js', 'examples/jsm/controls/OrbitControls.js',
  'examples/jsm/loaders/GLTFLoader.js', 'examples/jsm/utils/BufferGeometryUtils.js',
  'examples/jsm/utils/SkeletonUtils.js',
]) {
  routes.set(`/vendor/three/${name}`, join(root, 'preview', 'vendor', 'three', name));
}
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.step': 'application/step', '.stl': 'model/stl',
  '.glb': 'model/gltf-binary', '.gcode': 'text/plain; charset=utf-8', '.png': 'image/png',
};

const projects = new Projects(process.env.WORKBENCH_DATA_DIR);

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

async function readBody(request, limit = bodyLimit) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ProjectError('请求须使用 JSON 格式。', 415);
  }
  const limitMessage = limit === bodyLimit ? '请求超过 10 MB 图片限制。' : '结构预览参数太长。';
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new ProjectError(limitMessage, 413);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > limit) {
      request.resume();
      throw new ProjectError(limitMessage, 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProjectError('无法读取这项请求。');
  }
}

async function sendFile(request, response, path, mime, download = false) {
  const info = await stat(path);
  if (!info.isFile()) throw new ProjectError('找不到文件。', 404);
  const headers = {
    'Content-Type': mime ?? contentTypes[extname(path)] ?? 'text/plain; charset=utf-8',
    'Content-Length': info.size,
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${basename(path)}"`;
  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(path), response);
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'sha256-${importHash}'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  try {
    const origin = request.headers.origin;
    const literalHost = request.headers.host;
    const path = request.url.split('?', 1)[0];
    if (!loopbackHosts.has(literalHost) ||
        (path.startsWith('/api/') && request.headers['sec-fetch-site'] === 'cross-site') ||
        (origin !== undefined && origin !== `http://${literalHost}`)) {
      throw new ProjectError('工作台仅接受本机页面的请求。', 403);
    }
    await ready;
    const revision = /^\/api\/projects\/([0-9a-f-]+)\/(resize|rebuild|preview)$/.exec(path);
    if (request.method === 'POST' && path === '/api/projects') {
      const item = await projects.create(await readBody(request));
      json(response, 202, { project: item });
    } else if (request.method === 'POST' && revision && idPattern.test(revision[1])) {
      const [, id, action] = revision;
      if (action === 'preview') {
        const preview = await projects.preview(id, await readBody(request, 8192));
        json(response, 200, { preview });
      } else {
        const item = await projects[action](id, await readBody(request));
        json(response, 202, { project: item });
      }
    } else if (request.method === 'GET' && path === '/api/health') {
      json(response, 200, { app: appId });
    } else if (request.method === 'GET' && path === '/api/projects') {
      json(response, 200, { projects: projects.list() });
    } else if (['GET', 'HEAD'].includes(request.method)) {
      const match = /^\/api\/projects\/([0-9a-f-]+)(?:\/files\/([a-z]+))?$/.exec(path);
      const preview = /^\/api\/previews\/([0-9a-f-]+)\/model\.glb$/.exec(path);
      if (match && idPattern.test(match[1])) {
        const [, id, key] = match;
        if (!key && request.method === 'GET') json(response, 200, { project: projects.get(id) });
        else if (key) {
          const file = projects.file(id, key);
          await sendFile(request, response, file.path, file.mime, ['stl', 'step', 'gcode', 'input'].includes(key));
        } else throw new ProjectError('找不到页面。', 404);
      } else if (preview) {
        const glb = projects.previewGlb(preview[1]);
        response.writeHead(200, { 'Content-Type': contentTypes['.glb'], 'Content-Length': glb.byteLength });
        response.end(request.method === 'HEAD' ? undefined : glb);
      } else if (routes.has(path)) {
        await sendFile(request, response, routes.get(path));
      } else {
        throw new ProjectError('找不到页面。', 404);
      }
    } else {
      throw new ProjectError('此操作暂不支持。', 405);
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof ProjectError) json(response, error.status, { error: error.message });
    else if (error.code === 'ENOENT') json(response, 404, { error: '找不到文件。' });
    else {
      console.error(error);
      json(response, 500, { error: '工作台遇到本机错误，请查看控制台。' });
    }
  }
});
server.requestTimeout = 60_000;

function openBrowser() {
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', address],
    { windowsHide: true, detached: true, stdio: 'ignore' });
  browser.on('error', () => console.log(`请在浏览器打开 ${address}`));
  browser.unref();
}

await access(join(root, '.venv', 'Scripts', 'python.exe'));
const ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, async () => {
    try {
      await projects.load();
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
try {
  await ready;
} catch (error) {
  server.close();
  if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) {
    const health = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (health.ok && (await health.json()).app === appId) {
      openBrowser();
      process.exitCode = 0;
    } else throw error;
  } else throw error;
}
if (server.listening) {
  console.log(`3D 打印工作台 ${address}`);
  if (process.argv.includes('--open')) openBrowser();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      projects.stop();
      server.close();
    });
  }
}
