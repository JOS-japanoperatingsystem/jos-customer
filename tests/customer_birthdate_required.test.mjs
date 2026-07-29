import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const worker = fs.readFileSync(
  new URL('../src/worker.js', import.meta.url),
  'utf8'
);
const page = fs.readFileSync(
  new URL('../public/index.html', import.meta.url),
  'utf8'
);

test('birthday is required and uses year month day selectors', () => {
  assert.doesNotMatch(page, /id="birthday" type="date"/);
  assert.match(page, /id="birthYear"[^>]*required/);
  assert.match(page, /id="birthMonth"[^>]*required/);
  assert.match(page, /id="birthDay"[^>]*required/);
  assert.match(page, /生年月日<span class="required-mark">必須<\/span>/);
  assert.match(page, /function initializeBirthdaySelectors/);
  assert.match(page, /function updateBirthDayOptions/);
  assert.match(page, /birthday:getBirthdayValue\(\)/);
});

test('birthday remains editable after registration', () => {
  assert.match(page, /byId\('birthdayField'\)\.hidden = false/);
  assert.match(page, /setBirthdayValue\(p\.birthday \|\| ''\)/);
  assert.match(page, /id="registeredBirthday"/);
});

test('server rejects blank invalid and future birthdays', () => {
  assert.match(worker, /if \(!profile\.birthday\)/);
  assert.match(worker, /生年月日を選択してください/);
  assert.match(worker, /parsedBirthday\.toISOString\(\)\.slice\(0, 10\) !== profile\.birthday/);
  assert.match(worker, /profile\.birthday < '1900-01-01'/);
  assert.match(worker, /profile\.birthday > tokyoToday/);
});
