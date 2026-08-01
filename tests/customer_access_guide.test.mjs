import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('customer home contains ordered parking and shop access guidance', () => {
  assert.match(html, /駐車場から店舗まで/);
  assert.match(html, /お客様は12番をご利用ください/);
  assert.match(html, /ハイクレスト山の田/);
  assert.doesNotMatch(html, /ハイグレスト山の田/);
  assert.match(html, /access_building\.jpg/);
  assert.match(html, /access_parking_entrance\.jpg/);
  assert.match(html, /access_parking_12\.jpg/);
  assert.match(html, /access_shop_entrance\.jpg/);
  assert.match(html, /youtube\.com\/embed\/DfoXTrJNv6o/);
});
