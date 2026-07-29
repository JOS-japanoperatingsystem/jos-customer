import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8'
);

test('customer home greeting uses Japan time and three dayparts', () => {
  assert.match(html, /id="homeGreeting"/);
  assert.match(html, /timeZone:'Asia\/Tokyo'/);
  assert.match(html, /hour >= 5 && hour < 11/);
  assert.match(html, /hour >= 18 \|\| hour < 5/);
  assert.match(html, /return 'おはようございます'/);
  assert.match(html, /return 'こんにちは'/);
  assert.match(html, /return 'こんばんは'/);
  assert.match(
    html,
    /byId\('homeGreeting'\)\.textContent = getTokyoGreeting\(\)/
  );
});
