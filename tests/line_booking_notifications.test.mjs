import fs from 'node:fs';
import assert from 'node:assert/strict';

const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(
  new URL('../migrations/0016_line_booking_notifications.sql', import.meta.url),
  'utf8'
);
const recipientMigration = fs.readFileSync(
  new URL('../migrations/0017_line_notification_recipients.sql', import.meta.url),
  'utf8'
);
const actionMigration = fs.readFileSync(
  new URL('../migrations/0018_reservation_action_notifications.sql', import.meta.url),
  'utf8'
);

assert.match(worker, /oauth2\/v3\/token/);
assert.match(worker, /v2\/bot\/message\/push/);
assert.match(worker, /notifyStoreOfBooking/);
assert.match(worker, /【新しい予約が入りました】/);
assert.match(worker, /予定料金\$\{price\}円/);
assert.match(worker, /受付ID：\$\{booking\.requestId\}/);
assert.match(worker, /\.join\('\\n'\)/);
assert.match(worker, /\/api\/admin\/line-notifications\/recipient/);
assert.match(worker, /\/api\/admin\/line-notifications\/test/);
assert.match(worker, /\/api\/admin\/bookings\/recent/);
assert.match(worker, /\/webhook\/line/);
assert.match(worker, /x-line-signature/);
assert.match(worker, /JOS通知登録/);
assert.match(worker, /notifyStoreOfReservationAction/);
assert.match(worker, /【予約変更が入りました】/);
assert.match(worker, /TimeTreeの変更をお願いします/);
assert.match(worker, /\/api\/admin\/reservation-actions\/recent/);
assert.match(worker, /customerNeedsInitialCounseling/);
assert.match(worker, /SELECT treatment_time FROM menu_catalog/);
assert.match(worker, /menuTreatmentTime \+ firstVisitMinutes/);
assert.match(worker, /needsInitialCounseling \? 15 : 0/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS line_notification_settings/);
assert.match(recipientMigration, /CREATE TABLE IF NOT EXISTS line_notification_recipients/);
assert.match(actionMigration, /ADD COLUMN customer_name/);
console.log('LINE booking notifications and recent booking API: OK');
