import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:4790';
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { chromium } = await import('file:///C:/Users/yan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const specimens = [
  { key: 'tray', kind: 'electronics_tray', prompt: '电子盒底座，长 62 mm，宽 44 mm，高 20 mm，壁厚 2.4 mm，螺丝柱直径 7 mm，孔径 2.8 mm', dimensions: [62, 44, 20] },
  { key: 'washer', kind: 'washer', prompt: '外径 36 mm，内径 16 mm，厚 6 mm 的垫圈', dimensions: [36, 36, 6] },
  { key: 'bracket', kind: 'reinforced_bracket', prompt: '加强角码，长 48 mm，宽 38 mm，高 36 mm，壁厚 4 mm，孔径 5 mm', dimensions: [48, 38, 36] },
];
const exec = promisify(execFile);

async function api(path, payload) {
  const response = await fetch(origin + path, payload ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  } : {});
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function finish(id) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { project } = await api(`/api/projects/${id}`);
    if (project.status === 'completed') return project;
    assert.ok(!['blocked', 'failed'].includes(project.status), `${project.title}: ${project.error}`);
    await delay(700);
  }
  throw new Error(`Timed out waiting for project ${id}`);
}

async function openModel(page, project) {
  await page.goto(`${origin}/?project=${project.id}`);
  await page.locator('#task-status[data-status=completed]').waitFor({ state: 'visible' });
  await page.locator('#model-hint').waitFor({ state: 'visible' });
  const canvas = page.getByLabel('生成模型的三维画面');
  await canvas.waitFor({ state: 'visible' });
  return canvas;
}

async function captureStage(page, canvas, path) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  // Keep the rendered object and ground while omitting the viewport toolbar and hint.
  await page.screenshot({
    path, clip: {
      x: Math.ceil(bounds.x + bounds.width * .09), y: Math.ceil(bounds.y + bounds.height * .10),
      width: Math.floor(bounds.width * .82), height: Math.floor(bounds.height * .80),
    },
  });
}

async function compareSection(first, repeat, clipped, restored) {
  const source = `
from PIL import Image, ImageChops
import json, sys

first, repeat, clipped, restored = [Image.open(path).convert('RGB') for path in sys.argv[1:]]
assert first.size == repeat.size == clipped.size == restored.size
def difference(other):
    return sum(max(rgb) >= 12 for rgb in ImageChops.difference(first, other).getdata()) / (first.width * first.height)
print(json.dumps([difference(repeat), difference(clipped), difference(restored)]))
`;
  const { stdout } = await exec(join(root, '.venv', 'Scripts', 'python.exe'),
    ['-B', '-c', source, first, repeat, clipped, restored], { cwd: root, windowsHide: true });
  const [baseline, cut, reset] = JSON.parse(stdout);
  assert.ok(baseline < .005, `unstable baseline: ${baseline}`);
  assert.ok(cut > .03 && cut > baseline * 10, `section did not visibly move: ${cut}`);
  assert.ok(reset < .005, `failed to restore original view: ${reset}`);
  console.log(`Section drag changed ${(cut * 100).toFixed(2)}% of stage pixels; reset differs by ${(reset * 100).toFixed(2)}%.`);
}

const health = await api('/api/health');
assert.equal(health.app, 'local-3d-workbench-v1');
const { projects: existing } = await api('/api/projects');
for (const specimen of specimens) {
  const archived = existing.find(project => project.input.text === specimen.prompt && !['failed', 'blocked'].includes(project.status));
  specimen.id = archived?.id ?? (await api('/api/projects', { source: 'text', text: specimen.prompt })).project.id;
}
for (const specimen of specimens) {
  const project = await finish(specimen.id);
  assert.equal(project.model.kind, specimen.kind);
  const measurements = project.model.assets.step.checks.dimensions_mm_xyz;
  assert.ok(measurements.every((value, axis) => Math.abs(value - specimen.dimensions[axis]) < 0.002));
  assert.ok(project.model.assets.stl.checks.watertight);
  assert.ok(project.slice.layer_count > 0);
  console.log(`${specimen.kind} ${project.id}: ${measurements.join(' × ')} mm, ${project.slice.layer_count} layers; STEP ${project.model.assets.step.sha256.slice(0, 12)}`);
}

const evidence = join(root, 'evidence', 'workbench');
const thumbnails = join(root, 'workbench', 'web', 'specimens');
await mkdir(thumbnails, { recursive: true });
const folder = await mkdtemp(join(root, '.specimen-visual-'));
const browser = await chromium.launchPersistentContext(join(folder, 'chrome-profile'), {
  executablePath: chrome, headless: true, viewport: { width: 1440, height: 1080 }, serviceWorkers: 'block',
  args: ['--disable-background-networking', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  await browser.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const specimen of specimens) {
    const canvas = await openModel(page, specimen);
    await captureStage(page, canvas, join(thumbnails, `${specimen.key}.png`));
  }

  const bracket = specimens.at(-1);
  const canvas = await openModel(page, bracket);
  await page.locator('#specimen-list img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, 'specimen-studio.png'), fullPage: true, animations: 'disabled' });
  const full = join(folder, 'full.png');
  const repeat = join(folder, 'repeat.png');
  const restored = join(folder, 'restored.png');
  await captureStage(page, canvas, full);
  await captureStage(page, canvas, repeat);
  await page.getByRole('button', { name: '剖切', exact: true }).click();
  const depth = page.locator('#section-position');
  await depth.press('Home');
  for (let i = 0; i < 50; i += 1) await depth.press('ArrowRight');
  assert.equal(await depth.inputValue(), '55');
  const clipped = join(evidence, 'specimen-section.png');
  await captureStage(page, canvas, clipped);
  await page.getByRole('button', { name: '剖切', exact: true }).click();
  await captureStage(page, canvas, restored);
  await compareSection(full, repeat, clipped, restored);
  const projectCount = (await api('/api/projects')).projects.length;
  await page.locator('#specimen-list [data-specimen="tray"]').click();
  await page.waitForURL(url => url.searchParams.get('project') === specimens[0].id);
  await page.locator('#model-hint').waitFor({ state: 'visible' });
  assert.equal((await api('/api/projects')).projects.length, projectCount, 'Selecting a saved specimen should reopen its existing project');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, 'specimen-tray.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '剖切', exact: true }).click();
  await page.getByLabel('生成模型的三维画面').screenshot({ path: join(evidence, 'specimen-tray-section.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await openModel(page, bracket);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({ path: join(evidence, 'specimen-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log('Captured three actual GLBs; adjustable clipping changed and restored the render, gallery recalled saved projects, narrow layout stayed within 390px.');
} finally {
  await browser.close();
  const testFolder = await realpath(folder);
  assert.equal(dirname(testFolder), await realpath(root));
  await rm(testFolder, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
}
