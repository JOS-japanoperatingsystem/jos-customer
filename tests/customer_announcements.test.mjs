import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getCustomerAnnouncements } from '../src/worker.js';

const now = new Date('2026-07-28T04:00:00.000Z');
let boundValues = [];
const env = {
  jos_customer_db: {
    prepare(sql) {
      assert.match(sql, /is_published = 1/);
      assert.match(sql, /published_at <= \?/);
      assert.match(sql, /expires_at IS NULL OR expires_at > \?/);
      return {
        bind(...values) {
          boundValues = values;
          return this;
        },
        async all() {
          return {
            results: [{
              announcement_id: 'notice-1',
              title: '営業時間のお知らせ',
              body: '8月1日は17時まで営業します。',
              image_key: null,
              published_at: '2026-07-28T03:00:00.000Z',
              expires_at: '2026-08-02T00:00:00.000Z',
              internal_note: '返してはいけない管理メモ'
            }]
          };
        }
      };
    }
  }
};

const result = await getCustomerAnnouncements(env, { now });
assert.deepEqual(boundValues, [now.toISOString(), now.toISOString()]);
assert.equal(result.ok, true);
assert.equal(result.announcements.length, 1);
assert.deepEqual(result.announcements[0], {
  announcementId: 'notice-1',
  title: '営業時間のお知らせ',
  body: '8月1日は17時まで営業します。',
  imageUrl: '',
  publishedAt: '2026-07-28T03:00:00.000Z',
  expiresAt: '2026-08-02T00:00:00.000Z'
});
assert.equal(JSON.stringify(result).includes('internal_note'), false);
assert.equal(JSON.stringify(result).includes('管理メモ'), false);

const html = await readFile(
  new URL('../public/index.html', import.meta.url),
  'utf8'
);
const homeStart = html.indexOf('<div id="homeView"');
const mypageStart = html.indexOf('<div id="mypageView"');
const announcementStart = html.indexOf('<div id="announcementSection"');
assert.ok(homeStart >= 0);
assert.ok(announcementStart > homeStart);
assert.ok(announcementStart < mypageStart);
assert.match(html, /if \(viewName === 'home'\) loadAnnouncements\(\)/);
assert.doesNotMatch(html, /現在のお知らせはありません。/);
assert.match(html, /if \(announcements\.length > 0\)/);

console.log('Customer announcements API: OK');
