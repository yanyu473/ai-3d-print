import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = process.env.WORKBENCH_VISUAL_ORIGIN || 'http://127.0.0.1:4790';
const evidence = join(root, 'evidence', 'workbench');
const { chromium } = await import('file:///C:/Users/yan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const specimens = [
  {
    key: 'bracket', kind: 'reinforced_bracket', dimensions: [48, 38, 36],
    defaults: { rib_count: '1', base_hole_count: '2', upright_hole_count: '2' },
    changes: { rib_count: '2', base_hole_count: '4', upright_hole_count: '0' },
    summary: /底板 4 孔 · 立板 0 孔 · 加强筋 2 条/,
    check(features) {
      assert.equal(features.gussets.count, 2);
      assert.equal(features.base_holes.count, 4);
      assert.equal(features.upright_holes.count, 0);
    },
  },
  {
    key: 'tray', kind: 'electronics_tray', dimensions: [62, 44, 20],
    defaults: { compartment_count: '1', post_count: '4', cable_notch: '0' },
    changes: { compartment_count: '3', post_count: '0', cable_notch: '1' },
    summary: /3 仓 · 无螺丝柱 · 带出线口/,
    check(features) {
      assert.equal(features.dividers.count, 2);
      assert.equal(features.screw_posts.count, 0);
      assert.equal(features.cable_notch.enabled, true);
    },
  },
];

async function api(path) {
  const response = await fetch(new URL(path, origin));
  assert.ok(response.ok);
  return response.json();
}

async function bytes(path) {
  const response = await fetch(new URL(path, origin));
  assert.ok(response.ok);
  return Buffer.from(await response.arrayBuffer());
}

const { projects: existing } = await api('/api/projects');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--disable-background-networking', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 970 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  for (const specimen of specimens) {
    const candidates = await Promise.all(existing.filter(item => item.status === 'completed' && item.model?.kind === specimen.kind)
      .map(async item => (await api(`/api/projects/${item.id}`)).project));
    const archive = candidates.find(item =>
      specimen.dimensions.every((measure, axis) => Math.abs(item.model.assets?.step?.checks?.dimensions_mm_xyz?.[axis] - measure) < .002) &&
      Object.entries(specimen.defaults).every(([key, expected]) => String(item.model.parameters[key]?.value ?? expected) === expected));
    assert.ok(archive, `Missing archived ${specimen.kind} sample`);
    await page.goto(`${origin}/?project=${archive.id}`);
    await page.locator('#model-hint').waitFor({ state: 'visible' });
    const previewButton = page.getByRole('button', { name: '预览结构', exact: true });
    assert.ok(await previewButton.isDisabled());
    for (const [key, value] of Object.entries(specimen.defaults)) {
      assert.equal(await page.locator(`#structure-${key}`).inputValue(), value);
    }
    for (const [key, value] of Object.entries(specimen.changes)) await page.locator(`#structure-${key}`).selectOption(value);
    assert.equal(await page.locator('#size-editor').getAttribute('data-dirty'), 'true');
    const previewResponse = page.waitForResponse(response => response.url().endsWith(`/api/projects/${archive.id}/preview`) && response.request().method() === 'POST');
    await previewButton.click();
    const response = await previewResponse;
    assert.equal(response.status(), 200, await response.text());
    const { preview } = await response.json();
    const previewBytes = await bytes(preview.glb);
    assert.equal(previewBytes.subarray(0, 4).toString(), 'glTF');
    assert.notDeepEqual(previewBytes, await bytes(archive.files.glb));
    assert.ok(specimen.dimensions.every((measure, axis) => Math.abs(preview.dimensions_mm_xyz[axis] - measure) < .002));
    specimen.check(preview.features);
    const summary = page.locator('#preview-summary[data-state=ready]');
    await summary.waitFor({ state: 'visible' });
    assert.match(await summary.textContent(), specimen.summary);
    assert.match(await page.locator('#model-hint').textContent(), /未归档预览/);
    assert.equal(await page.locator('#view-layers').textContent(), '已归档刀路');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(evidence, `variants-${specimen.key}.png`), animations: 'disabled' });
    if (specimen.key === 'tray') {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
      await page.screenshot({ path: join(evidence, 'variants-mobile.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 970 });
    }
    await page.getByRole('button', { name: '恢复参数', exact: true }).click();
    await page.locator('#model-hint').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#size-editor').getAttribute('data-dirty'), 'false');
    assert.equal(await page.locator('#view-layers').textContent(), '分层刀路');
    assert.ok(await previewButton.isDisabled());
    assert.equal(await summary.count(), 0);
    console.log(`${specimen.kind}: ${previewBytes.length} byte GLB confirmed; restored archived model`);
  }
  assert.deepEqual((await api('/api/projects')).projects.map(item => item.id), existing.map(item => item.id));
  assert.deepEqual(errors, []);
  console.log('Desktop and 390 px layout verified. Preview generated real geometry and left archived projects unchanged.');
} finally {
  await browser.close();
}
