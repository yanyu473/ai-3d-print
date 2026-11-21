import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const runtime = 'file:///C:/Users/yan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(runtime);
const python = join(root, '.venv', 'Scripts', 'python.exe');
const port = 4796;
const origin = `http://127.0.0.1:${port}`;
const evidence = join(root, 'evidence', 'workbench');
const exec = promisify(execFile);

async function ensureTestPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

function start(dataPath) {
  const child = spawn(process.execPath, [join(root, 'workbench', 'server.mjs')], {
    cwd: root,
    env: { ...process.env, WORKBENCH_PORT: String(port), WORKBENCH_DATA_DIR: dataPath },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  const append = (chunk) => { output = (output + chunk).slice(-14_000); };
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', append);
  child.on('error', (error) => append(String(error)));
  const closed = new Promise((resolve) => child.once('close', resolve));
  return {
    async ready() {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && child.exitCode === null) {
        if (output.includes(origin)) return;
        await delay(100);
      }
      throw new Error(`Local QA server startup failed.\n${output}`);
    },
    async close() {
      if (child.exitCode === null) child.kill();
      await closed;
    },
    log: () => output,
  };
}

async function project(page, id) {
  const response = await page.request.get(`${origin}/api/projects/${id}`);
  assert.equal(response.status(), 200);
  return (await response.json()).project;
}

async function submit(page, route, button) {
  const responsePromise = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === route);
  await button.click();
  const response = await responsePromise;
  assert.equal(response.status(), 202, `Expected HTTP 202, got ${response.status()} ${await response.text()}`);
  const { project: item } = await response.json();
  await page.waitForURL((url) => url.searchParams.get('project') === item.id);
  await page.locator('#task-status[data-status=completed]').waitFor({ state: 'visible', timeout: 90_000 });
  return project(page, item.id);
}

async function inspectModel(page, model) {
  await page.locator('#model-hint').waitFor({ state: 'visible' });
  const canvas = page.getByLabel('生成模型的三维画面');
  await canvas.waitFor({ state: 'visible' });
  const response = await page.request.get(`${origin}${model.files.glb}`);
  assert.equal(response.status(), 200);
  assert.equal((await response.body()).toString('ascii', 0, 4), 'glTF');
  return canvas;
}

async function compareRender(first, stable, resized) {
  const source = `
from PIL import Image, ImageChops
import json, sys

first, stable, resized = [Image.open(p).convert('RGB') for p in sys.argv[1:]]
assert first.size == stable.size == resized.size
def changed_fraction(a, b):
    count = sum(max(rgb) >= 12 for rgb in ImageChops.difference(a, b).getdata())
    return count / (a.width * a.height)
print(json.dumps({'width': first.width, 'height': first.height,
    'colors': len(first.getcolors(first.width * first.height)),
    'stable_delta': changed_fraction(first, stable), 'resize_delta': changed_fraction(stable, resized)}))
`;
  const { stdout } = await exec(python, ['-B', '-c', source, first, stable, resized], { cwd: root, windowsHide: true });
  const metrics = JSON.parse(stdout);
  assert.ok(metrics.colors > 30, 'The loaded WebGL canvas must contain rendered detail');
  assert.ok(metrics.stable_delta < 0.002, JSON.stringify(metrics));
  assert.ok(metrics.resize_delta > 0.025, JSON.stringify(metrics));
  return metrics;
}

async function verifySyntheticCamera(page) {
  await page.getByRole('tab', { name: '拍照' }).click();
  await page.getByRole('button', { name: '打开相机' }).click();
  const capture = page.getByRole('button', { name: '使用这张照片' });
  await page.locator('#capture-photo:enabled').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.syntheticCamera.track.readyState), 'live');
  await capture.click();
  await page.getByAltText('建模输入预览').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.syntheticCamera.track.readyState), 'ended');
  assert.equal(await page.locator('#camera-panel').isHidden(), true);
  await page.locator('#input-width').fill('48');
  await page.locator('#input-thickness').fill('3');
  const captured = await submit(page, '/api/projects', page.getByRole('button', { name: '生成模型' }));
  assert.equal(captured.source, 'photo');
  assert.equal(captured.model.source.format, 'JPEG');
  assert.equal(captured.model.source.through_hole_count, 1);
  assert.equal(captured.slice.layer_count, 15);
  console.log('Synthetic camera stream was requested, captured as JPEG, stopped after capture, and produced 15 real slice layers.');
}

async function verifyImageUpload(page) {
  await page.getByRole('tab', { name: '图片' }).click();
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const paint = canvas.getContext('2d');
    paint.fillStyle = 'black';
    paint.fillRect(24, 20, 112, 80);
    paint.clearRect(54, 44, 18, 32);
    paint.clearRect(92, 44, 18, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#gallery-file').setInputFiles({
    name: 'two-hole-fixture.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64'),
  });
  await page.getByAltText('建模输入预览').waitFor({ state: 'visible' });
  await page.locator('#input-width').fill('48');
  await page.locator('#input-thickness').fill('3');
  const uploaded = await submit(page, '/api/projects', page.getByRole('button', { name: '生成模型' }));
  assert.equal(uploaded.source, 'image');
  assert.equal(uploaded.model.source.format, 'PNG');
  assert.equal(uploaded.model.source.through_hole_count, 2);
  assert.equal(uploaded.slice.layer_count, 15);
  console.log('The image uploader turned both transparent openings in a PNG into real through-holes and produced a 15-layer slice.');
}

await ensureTestPort();
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(root, '.workbench-visual-'));
const server = start(join(directory, 'data'));
let browser;
try {
  await server.ready();
  browser = await chromium.launchPersistentContext(join(directory, 'chrome-profile'), {
    executablePath: chrome, headless: true, viewport: { width: 1440, height: 1080 }, serviceWorkers: 'block',
    args: ['--disable-background-networking', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  await browser.route('**/*', (route) => (new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort()));
  const errors = [];
  const desktop = await browser.newPage();
  desktop.on('pageerror', (error) => errors.push(error.message));
  await desktop.goto(origin);
  await desktop.getByRole('button', { name: '四孔板', exact: true }).click();
  const base = await submit(desktop, '/api/projects', desktop.getByRole('button', { name: '生成模型' }));
  assert.equal(base.source, 'text');
  const canvas = await inspectModel(desktop, base);
  const scale = desktop.getByRole('slider', { name: '平面比例' });
  await scale.waitFor({ state: 'visible' });
  assert.equal(await scale.inputValue(), '100');

  await desktop.evaluate(() => window.scrollTo(0, 0));
  await desktop.screenshot({ path: join(evidence, 'studio-desktop.png'), animations: 'disabled' });
  const before = [join(directory, 'original.png'), join(directory, 'baseline-repeat.png')];
  for (const path of before) await canvas.screenshot({ path });
  const thickness = desktop.getByRole('slider', { name: '厚度' });
  await thickness.press('End');
  assert.match(await desktop.locator('#edit-dimensions').innerText(), /60 × 40 × 15 mm/);
  const thicker = join(directory, 'thicker.png');
  await canvas.screenshot({ path: thicker });
  const thickMetrics = await compareRender(...before, thicker);
  console.log(`Thickness adjustment from 5 to 15 mm changed ${(thickMetrics.resize_delta * 100).toFixed(2)}% of pixels.`);
  await desktop.getByRole('button', { name: '恢复尺寸' }).click();
  assert.match(await desktop.locator('#edit-dimensions').innerText(), /60 × 40 × 5 mm/);
  await scale.focus();
  for (let index = 0; index < 20; index += 1) await desktop.keyboard.press('ArrowRight');
  assert.equal(await scale.inputValue(), '120');
  assert.match(await desktop.locator('#edit-dimensions').innerText(), /72 × 48 × 5 mm/);
  assert.equal((await desktop.request.get(`${origin}/api/projects`).then((reply) => reply.json())).projects.length, 1);
  const enlarged = join(directory, 'resized.png');
  await canvas.screenshot({ path: enlarged });
  const metrics = await compareRender(...before, enlarged);
  console.log(`Desktop WebGL canvas valid: ${metrics.width}×${metrics.height}, baseline ${(metrics.stable_delta * 100).toFixed(2)}%, scale adjustment changed ${(metrics.resize_delta * 100).toFixed(2)}% of pixels.`);
  await desktop.evaluate(() => window.scrollTo(0, 0));
  await desktop.screenshot({ path: join(evidence, 'studio-live-resize.png'), animations: 'disabled' });

  const resized = await submit(desktop, `/api/projects/${base.id}/rebuild`, desktop.getByRole('button', { name: '应用并重建' }));
  assert.equal(resized.parent_id, base.id);
  assert.notEqual(resized.model.assets.stl.sha256, base.model.assets.stl.sha256);
  assert.notEqual(resized.slice.gcode_file.sha256, base.slice.gcode_file.sha256);
  assert.deepEqual(await desktop.locator('#model-dimensions dd').allInnerTexts(), ['72', '48', '5']);
  assert.equal(await desktop.locator('#history-list .history-entry').count(), 2);
  await desktop.getByRole('button', { name: '分层刀路' }).click();
  await desktop.locator('#layer-canvas').waitFor({ state: 'visible' });
  const layers = desktop.getByRole('slider', { name: '打印层' });
  await layers.press('End');
  assert.equal(await layers.inputValue(), String(resized.slice.layer_count));
  console.log(`Applied 120% geometry, 72×48×5 mm, ${resized.slice.layer_count} visible layers, and two history entries with new STL and G-code hashes.`);

  await desktop.getByRole('button', { name: '三维模型' }).click();
  const detailedCanvas = await inspectModel(desktop, resized);
  const detailedBefore = [join(directory, 'details-base.png'), join(directory, 'details-repeat.png')];
  for (const path of detailedBefore) await detailedCanvas.screenshot({ path });
  await desktop.locator('#parameter-length').fill('78');
  await desktop.locator('#parameter-hole_diameter').fill('7.5');
  await desktop.locator('#process-layer-height').fill('0.25');
  await desktop.locator('#process-infill').fill('25');
  assert.match(await desktop.locator('#edit-dimensions').innerText(), /78 × 48 × 5 mm/);
  const detailedAfter = join(directory, 'details-draft.png');
  await detailedCanvas.screenshot({ path: detailedAfter });
  await compareRender(...detailedBefore, detailedAfter);
  const edited = await submit(desktop, `/api/projects/${resized.id}/rebuild`, desktop.getByRole('button', { name: '应用并重建' }));
  assert.equal(edited.parent_id, resized.id);
  assert.equal(edited.model.parameters.hole_diameter.value, 7.5);
  assert.notEqual(edited.model.assets.stl.sha256, resized.model.assets.stl.sha256);
  assert.notEqual(edited.slice.gcode_file.sha256, resized.slice.gcode_file.sha256);
  assert.deepEqual(edited.process, { layer_height: 0.25, infill_percent: 25 });
  assert.equal(edited.slice.layer_count, 20);
  assert.deepEqual(await desktop.locator('#model-dimensions dd').allInnerTexts(), ['78', '48', '5']);
  await desktop.getByRole('button', { name: '上一版', exact: true }).click();
  await desktop.waitForURL(url => url.searchParams.get('project') === resized.id);
  assert.deepEqual(await desktop.locator('#model-dimensions dd').allInnerTexts(), ['72', '48', '5']);
  console.log('Independent length and 7.5 mm holes rebuilt a new STL, 0.25 mm layers and 25% infill generated a new 20-layer G-code, and the parent remained selectable.');

  const mobile = await browser.newPage();
  mobile.on('pageerror', (error) => errors.push(error.message));
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async (constraints) => {
      if (!constraints.video || constraints.audio) throw new Error('Unexpected synthetic camera request');
      const frame = document.createElement('canvas');
      frame.width = 240;
      frame.height = 180;
      const context = frame.getContext('2d');
      const draw = () => {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, 240, 180);
        context.fillStyle = '#000';
        context.fillRect(42, 31, 156, 118);
        context.fillStyle = '#fff';
        context.fillRect(96, 70, 48, 40);
      };
      draw();
      const stream = frame.captureStream(20);
      const [track] = stream.getVideoTracks();
      window.syntheticCamera = { track };
      const timer = setInterval(() => {
        if (track.readyState === 'ended') clearInterval(timer);
        else draw();
      }, 50);
      return stream;
    } });
  });
  await mobile.goto(`${origin}/?project=${edited.id}`);
  await mobile.locator('#task-status[data-status=completed]').waitFor({ state: 'visible' });
  const mobileCanvas = await inspectModel(mobile, edited);
  assert.ok((await mobileCanvas.boundingBox()).width > 300);
  assert.deepEqual(await mobile.locator('#model-dimensions dd').allInnerTexts(), ['78', '48', '5']);
  const layout = await mobile.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.equal(layout.width, 390);
  assert.equal(layout.scroll, 390);
  await mobile.evaluate(() => window.scrollTo(0, 0));
  await mobile.screenshot({ path: join(evidence, 'studio-mobile.png'), fullPage: true, animations: 'disabled' });
  console.log('390px browser viewport showed the archived 3D revision with no horizontal overflow.');
  await verifySyntheticCamera(mobile);
  await verifyImageUpload(mobile);
  assert.deepEqual(errors, []);
} catch (error) {
  console.error(server.log());
  throw error;
} finally {
  await browser?.close();
  await server.close();
  const testDirectory = await realpath(directory);
  assert.equal(dirname(testDirectory), await realpath(root));
  await rm(testDirectory, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}
