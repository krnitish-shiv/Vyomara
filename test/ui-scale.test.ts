import assert from 'node:assert/strict';
import test from 'node:test';
import { uiZoomFor } from '../src/desktop/ui-scale.ts';

test('laptop screens stay at 1x; small windows never shrink below 1x', () => {
  assert.equal(uiZoomFor({ width: 1200, height: 820 }, { width: 1512, height: 945 }), 1);
  assert.equal(uiZoomFor({ width: 1512, height: 945 }, { width: 1512, height: 945 }), 1.05, 'a maximized 14" MacBook barely grows');
  assert.equal(uiZoomFor({ width: 1280, height: 777 }, { width: 1280, height: 777 }), 1, '13" laptop');
  assert.equal(uiZoomFor({ width: 800, height: 600 }, { width: 2560, height: 1415 }), 1, 'a small window on a big monitor keeps 1x');
});

test('a window maximized on an external monitor grows with it', () => {
  assert.equal(uiZoomFor({ width: 2560, height: 1415 }, { width: 2560, height: 1415 }), 1.55, '27" 1440p');
  assert.equal(uiZoomFor({ width: 1920, height: 1055 }, { width: 1920, height: 1055 }), 1.15, '1080p / 4K at default scaling');
  assert.equal(uiZoomFor({ width: 3840, height: 2135 }, { width: 3840, height: 2135 }), 1.75, 'capped on very large screens');
  assert.equal(uiZoomFor({ width: 1800, height: 1100 }, { width: 2560, height: 1415 }), 1.25, 'a large but not maximized window');
});

test('nonsense sizes fall back to 1x', () => {
  assert.equal(uiZoomFor({ width: 0, height: 0 }, { width: 0, height: 0 }), 1);
  assert.equal(uiZoomFor({ width: Number.NaN, height: 800 }, { width: 1440, height: 900 }), 1);
});
