import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  listCustomerAnnouncementsForAdmin,
  saveCustomerAnnouncement
} from '../src/worker.js';

let savedBinding = [];
let uploaded = null;
const env = {
  ANNOUNCEMENT_IMAGES: {
    async put(key, bytes, options) {
      uploaded = { key, bytes: [...bytes], options };
    }
  },
  jos_customer_db: {
    prepare(sql) {
      if (/INSERT INTO customer_announcements/.test(sql)) {
        return {
          bind(...values) {
            savedBinding = values;
            return this;
          },
          async run() {
            return { success: true };
          }
        };
      }
      assert.match(sql, /ORDER BY updated_at DESC/);
      return {
        async all() {
          return {
            results: [{
              announcement_id: 'notice-image',
              title: '',
              body: '',
              published_at: '2026-07-28T10:00:00.000Z',
              expires_at: null,
              is_published: 1,
              image_key: 'notice-image/example.png'
            }]
          };
        }
      };
    }
  }
};

const imageOnly = await saveCustomerAnnouncement(env, {
  imageData: 'data:image/png;base64,iVBORw0KGgo=',
  isPublished: false
}, { now: new Date('2026-07-28T10:00:00.000Z') });
assert.equal(imageOnly.ok, true);
assert.equal(imageOnly.hasImage, true);
assert.equal(imageOnly.isPublished, false);
assert.equal(uploaded.options.httpMetadata.contentType, 'image/png');
assert.match(uploaded.key, /\.png$/);
assert.equal(savedBinding[1], '');
assert.equal(savedBinding[2], '');

const textOnly = await saveCustomerAnnouncement(env, {
  title: '営業日のお知らせ',
  body: '通常どおり営業します。'
}, { now: new Date('2026-07-28T10:00:00.000Z') });
assert.equal(textOnly.ok, true);
assert.equal(textOnly.hasImage, false);

await assert.rejects(
  saveCustomerAnnouncement(env, {}, {
    now: new Date('2026-07-28T10:00:00.000Z')
  }),
  /画像または文字/
);

const list = await listCustomerAnnouncementsForAdmin(env);
assert.equal(list.announcements[0].imageUrl,
  '/api/announcement-image/notice-image%2Fexample.png');

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
assert.match(html, /if \(item\.imageUrl\)/);
assert.match(html, /if \(item\.title\)/);
assert.match(html, /if \(item\.body\)/);

const config = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
assert.match(config, /"binding": "ANNOUNCEMENT_IMAGES"/);
assert.match(config, /"bucket_name": "jos-customer-announcements"/);

console.log('Customer announcement management API: OK');
