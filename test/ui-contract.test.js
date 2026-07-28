import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const releaseScript = await readFile(new URL('../script/package_release.sh', import.meta.url), 'utf8');

test('preserves the complete story production workflow', () => {
  for (const component of [
    'ProjectForm',
    'CharactersPanel',
    'ScreenplayPanel',
    'StoryboardPanel',
    'AgentFlowPanel',
    'ModelManagerPanel',
    'ExportPanel'
  ]) {
    assert.match(source, new RegExp(`function ${component}\\(`));
  }

  for (const anchor of [
    'movie-setup',
    'reference-library',
    'screenplay',
    'storyboard',
    'export'
  ]) {
    assert.match(source, new RegExp(`(?:id=|href=\"#)\"?${anchor}`));
  }
});

test('restores first-run splash and reopenable How It Works guide', () => {
  assert.match(source, /function IntroSplash\(/);
  assert.match(source, /function HowItWorks\(/);
  assert.match(source, /pitchdeck-local-intro-seen/);
  assert.match(source, /Start Generating/);
  assert.match(source, /Enter the Story Maker/);
  assert.match(source, /onClick=\{\(\) => setView\('guide'\)\}/);
  assert.match(source, /const \[project, setProject\] = useLocalProject\(\)/);
});

test('uses the canonical abandonedmuse vaporwave palette', () => {
  for (const token of [
    '#ff006e',
    '#00f5ff',
    '#0a0a0a',
    '#1a0033',
    '#8338ec',
    '#39ff14',
    '#ff10f0',
    '#00ffff'
  ]) {
    assert.ok(styles.toLowerCase().includes(token), `missing canonical color ${token}`);
  }

  assert.match(styles, /background-size:\s*4px 4px/);
  assert.match(styles, /repeating-linear-gradient/);
  assert.match(styles, /"Courier New"/);
});

test('keeps the interface readable and motion-safe', () => {
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /body\s*\{[^}]*animation:\s*flicker/s);
  assert.match(source, /aria-label="Story workflow"/);
  assert.match(source, /aria-label="Local production systems"/);
  assert.match(source, /aria-live="polite"/);
});

test('builds releases from a clean lockfile tree and rejects Finder duplicates', () => {
  assert.match(releaseScript, /pitchdeck-clean-build/);
  assert.match(releaseScript, /npm ci --no-audit --no-fund/);
  assert.match(releaseScript, /FINDER_DUPLICATE_PATTERN=/);
  assert.match(releaseScript, /"\$ASAR_TOOL" list "\$archive_path" > "\$archive_listing"/);
  assert.match(releaseScript, /validate_asar "\$APP_PATH"/);
  assert.match(releaseScript, /validate_asar "\$VALIDATION_ROOT/);
  assert.doesNotMatch(releaseScript, /node_modules\/\*\s+2/);
});
