import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const publicHtml = fs.readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8'
);
const fallbackHtml = fs.readFileSync(
  new URL('../index.html', import.meta.url),
  'utf8'
);

test('customer registration screens do not show test-only labels', () => {
  assert.doesNotMatch(publicHtml, /限定登録テスト|限定ログインテスト/);
  assert.doesNotMatch(fallbackHtml, /限定登録テスト|限定ログインテスト/);
  assert.match(publicHtml, /LINE本人確認後、最初の一度だけお客様情報をご登録ください。/);
});
