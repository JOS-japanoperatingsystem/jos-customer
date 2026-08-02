import {
  activatePcSync,
  expirePcSyncRuns,
  getPcAdminCustomers,
  getPcSnapshotManifest,
  getPcSyncStatus,
  receivePcCustomerPage,
  receivePcMetricPage,
  rollbackPcSync,
  startPcSync,
  validatePcSync
} from './pc-sync-admin.js';

const LINE_CHANNEL_ID = '2010784641';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    }
  });
}

async function readJson(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 500000) throw new Error('送信データが大きすぎます。');
  try {
    return await request.json();
  } catch (_) {
    throw new Error('送信形式が正しくありません。');
  }
}

async function readAnnouncementJson(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 3000000) throw new Error('画像を含む送信データが大きすぎます。');
  try {
    return await request.json();
  } catch (_) {
    throw new Error('送信形式が正しくありません。');
  }
}

function checkSameOrigin(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  return !origin || origin === requestUrl.origin;
}

async function verifyLineIdToken(idToken) {
  idToken = typeof idToken === 'string' ? idToken.trim() : '';
  if (!idToken || idToken.length > 10000) {
    throw new Error('LINE認証情報を取得できませんでした。');
  }

  const form = new URLSearchParams();
  form.set('id_token', idToken);
  form.set('client_id', LINE_CHANNEL_ID);

  let response;
  try {
    response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form
    });
  } catch (_) {
    throw new Error('LINE公式サーバーへ接続できませんでした。');
  }

  let verified;
  try {
    verified = await response.json();
  } catch (_) {
    throw new Error('LINE公式サーバーの応答を確認できませんでした。');
  }

  if (!response.ok || !verified || !verified.sub || String(verified.aud) !== LINE_CHANNEL_ID) {
    throw new Error('LINE本人確認に失敗しました。もう一度ログインしてください。');
  }

  return {
    sub: String(verified.sub),
    displayName: String(verified.name || '')
  };
}

function normalizeText(value, maxLength) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function normalizeLineMessage(value, maxLength) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalizeIsoDateOnly(value) {
  const text = normalizeText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? '' : text;
}

function addIsoDays(value, days) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function japanDateOnly() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

async function issueLineMessagingToken(env) {
  const channelId = normalizeText(env.LINE_MESSAGING_CHANNEL_ID, 40);
  const channelSecret = normalizeText(env.LINE_MESSAGING_CHANNEL_SECRET, 200);
  if (!channelId || !channelSecret) {
    throw new Error('LINE予約通知の秘密設定が未完了です。');
  }
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: channelId,
    client_secret: channelSecret
  });
  const response = await fetch('https://api.line.me/oauth2/v3/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error('LINE予約通知の送信認証に失敗しました。');
  }
  return String(data.access_token);
}

async function pushLineText(env, lineSub, text) {
  const token = await issueLineMessagingToken(env);
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      to: normalizeText(lineSub, 100),
      messages: [{ type: 'text', text: normalizeLineMessage(text, 4500) }]
    })
  });
  if (!response.ok) {
    const detail = normalizeText(await response.text(), 300);
    throw new Error(`LINE予約通知を送信できませんでした（${response.status}）${detail ? `：${detail}` : '。'}`);
  }
}

async function verifyLineWebhookSignature(request, channelSecret, rawBody) {
  const signature = String(request.headers.get('x-line-signature') || '');
  if (!signature || !channelSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  let signatureBytes;
  try {
    signatureBytes = Uint8Array.from(atob(signature), character => character.charCodeAt(0));
  } catch (_) {
    return false;
  }
  return crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    new TextEncoder().encode(rawBody)
  );
}

async function getLineMessagingProfile(env, token, lineUserId) {
  const response = await fetch(
    `https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!response.ok) return { displayName: 'LINE通知先' };
  const profile = await response.json();
  return { displayName: normalizeText(profile.displayName, 100) || 'LINE通知先' };
}

function followupAdminTestMessage(messageType) {
  if (messageType === 'reservation_reminder') {
    return [
      '【管理者本人向け・前日リマインド18時予約テスト】',
      '予約した時刻に管理者LINEへ届くことを確認するテストです。お客様には送信されていません。',
      '',
      '〇〇 様',
      '',
      '明日のご予約についてお知らせいたします。',
      '',
      '予約日時：20XX-XX-XX 10:00',
      '店舗：下関店',
      'メニュー：テスト表示',
      '',
      'ご予約内容は、下記のお客様ページからご確認いただけます。',
      'https://jos-customer.japan-operating-system.workers.dev/',
      '',
      '日時変更やキャンセルをご希望の場合は、お早めにお手続きください。',
      '',
      '明日のご来店をお待ちしております。'
    ].join('\n');
  }
  const treatmentLabel = messageType === 'beard' ? 'ひげ脱毛' : '体・VIO脱毛';
  return [
    '【管理者本人向けテスト】',
    'このメッセージは後追いLINEの表示確認用です。お客様には送信されていません。',
    '',
    '〇〇 様',
    '',
    'いつもメンズ脱毛JAPANをご利用いただきありがとうございます。',
    `前回の${treatmentLabel}から、次回ご来店の目安となる時期になりました。`,
    '',
    'ご予約は、下記のお客様ページを開き、画面下の「予約する」からお申し込みいただけます。',
    'https://jos-customer.japan-operating-system.workers.dev/',
    '',
    '※すでにご予約・ご連絡済みの場合は、行き違いのためご容赦ください。'
  ].join('\n');
}

async function replyLineText(token, replyToken, text) {
  if (!replyToken) return;
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text: normalizeText(text, 4500) }]
    })
  });
}

async function lineWebhook(request, env) {
  if (request.method !== 'POST') return new Response('OK');
  const rawBody = await request.text();
  const channelSecret = normalizeText(env.LINE_MESSAGING_CHANNEL_SECRET, 200);
  if (!await verifyLineWebhookSignature(request, channelSecret, rawBody)) {
    return new Response('Invalid signature', { status: 401 });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (_) {
    return new Response('Invalid JSON', { status: 400 });
  }
  const registrationEvents = (Array.isArray(payload.events) ? payload.events : [])
    .filter(event =>
      event &&
      event.type === 'message' &&
      event.message &&
      event.message.type === 'text' &&
      normalizeText(event.message.text, 100) === 'JOS通知登録' &&
      event.source &&
      event.source.type === 'user' &&
      event.source.userId
    );
  if (!registrationEvents.length) return new Response('OK');

  const token = await issueLineMessagingToken(env);
  for (const event of registrationEvents) {
    const lineUserId = normalizeText(event.source.userId, 100);
    const profile = await getLineMessagingProfile(env, token, lineUserId);
    const now = new Date().toISOString();
    await env.jos_customer_db.prepare(
      `INSERT INTO line_notification_recipients
         (line_user_id, display_name, registered_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(line_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`
    ).bind(lineUserId, profile.displayName, now, now).run();
    await replyLineText(
      token,
      event.replyToken,
      'JOSの予約通知先として登録を受け付けました。\nPC管理画面で通知先を選択してください。'
    );
  }
  return new Response('OK');
}

async function notifyStoreOfBooking(env, booking) {
  await flushPendingCustomerLifecycleNotifications(env, 10);
  const setting = await env.jos_customer_db.prepare(
    `SELECT recipient_line_sub FROM line_notification_settings WHERE setting_id = 1`
  ).first();
  if (!setting || !setting.recipient_line_sub) return { sent: false, reason: 'not-configured' };
  const price = Number(booking.price || 0).toLocaleString('ja-JP');
  const dateParts = String(booking.date || '').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const dateLabel = dateParts
    ? `${dateParts[1]}年${Number(dateParts[2])}月${Number(dateParts[3])}日`
    : String(booking.date || '');
  const menus = String(booking.menuNames || '').split(/[,、\/\n]+/)
    .map(value => value.trim()).filter(Boolean).join('、');
  const message = [
    '【新しい予約が入りました】',
    `${dateLabel}　${booking.startTime}〜${booking.endTime}`,
    `${booking.customerName} 様`,
    menus,
    `予定料金${price}円`,
    `受付ID：${booking.requestId}`
  ].join('\n');
  const now = new Date().toISOString();
  try {
    await pushLineText(env, setting.recipient_line_sub, message);
    await env.jos_customer_db.prepare(
      `UPDATE line_notification_settings
          SET last_sent_at = ?, last_error = '', updated_at = ?
        WHERE setting_id = 1`
    ).bind(now, now).run();
    return { sent: true };
  } catch (error) {
    await env.jos_customer_db.prepare(
      `UPDATE line_notification_settings
          SET last_error = ?, updated_at = ?
        WHERE setting_id = 1`
    ).bind(normalizeText(error && error.message, 500), now).run();
    return { sent: false, reason: 'send-failed' };
  }
}

function customerLifecycleMessage(type, customer) {
  const name = [customer.lastName, customer.firstName].filter(Boolean).join(' ') ||
    customer.lineDisplayName || '氏名未登録';
  const kana = [customer.lastKana, customer.firstKana].filter(Boolean).join(' ');
  const details = [
    `${name} 様`,
    kana ? `フリガナ：${kana}` : '',
    customer.phone ? `電話番号：${customer.phone}` : '',
    customer.customerId ? `顧客ID：${customer.customerId}` : ''
  ].filter(Boolean);
  if (type === 'new-registration') {
    return ['【新規顧客が登録されました】', ...details,
      'JOSへ自動登録・連携されます。'].join('\n');
  }
  return ['【お客様ページ連携申請】', ...details,
    'お客様ページ連携確認をしてください。'].join('\n');
}

async function deliverCustomerLifecycleNotification(env, row) {
  const setting = await env.jos_customer_db.prepare(
    `SELECT recipient_line_sub FROM line_notification_settings WHERE setting_id = 1`
  ).first();
  if (!setting || !setting.recipient_line_sub) return { sent: false, reason: 'not-configured' };
  const payload = JSON.parse(row.payload_json || '{}');
  const now = new Date().toISOString();
  try {
    await pushLineText(env, setting.recipient_line_sub, customerLifecycleMessage(row.notification_type, payload));
    await env.jos_customer_db.prepare(
      `UPDATE customer_lifecycle_notifications
          SET status = 'sent', sent_at = ?, last_error = ''
        WHERE event_key = ? AND status = 'pending'`
    ).bind(now, row.event_key).run();
    await env.jos_customer_db.prepare(
      `UPDATE line_notification_settings
          SET last_sent_at = ?, last_error = '', updated_at = ? WHERE setting_id = 1`
    ).bind(now, now).run();
    return { sent: true };
  } catch (error) {
    const message = normalizeText(error && error.message, 500);
    await env.jos_customer_db.prepare(
      `UPDATE customer_lifecycle_notifications SET last_error = ? WHERE event_key = ?`
    ).bind(message, row.event_key).run();
    await env.jos_customer_db.prepare(
      `UPDATE line_notification_settings SET last_error = ?, updated_at = ? WHERE setting_id = 1`
    ).bind(message, now).run();
    return { sent: false, reason: 'send-failed' };
  }
}

async function queueCustomerLifecycleNotification(env, type, lineSub, customer) {
  const eventKey = `${type}:${lineSub}`;
  const now = new Date().toISOString();
  await env.jos_customer_db.prepare(
    `INSERT OR IGNORE INTO customer_lifecycle_notifications
       (event_key, line_sub, notification_type, status, payload_json, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  ).bind(eventKey, lineSub, type, JSON.stringify(customer || {}), now).run();
  const row = await env.jos_customer_db.prepare(
    `SELECT event_key, notification_type, status, payload_json
       FROM customer_lifecycle_notifications WHERE event_key = ?`
  ).bind(eventKey).first();
  if (!row || row.status === 'sent') return { sent: true, duplicate: true };
  return deliverCustomerLifecycleNotification(env, row);
}

async function flushPendingCustomerLifecycleNotifications(env, limit = 20) {
  const pending = await env.jos_customer_db.prepare(
    `SELECT event_key, notification_type, status, payload_json
       FROM customer_lifecycle_notifications
      WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
  ).bind(Math.max(1, Math.min(100, Number(limit) || 20))).all();
  for (const row of pending.results || []) await deliverCustomerLifecycleNotification(env, row);
}

async function notifyStoreOfReservationAction(env, action) {
  const setting = await env.jos_customer_db.prepare(
    `SELECT recipient_line_sub FROM line_notification_settings WHERE setting_id = 1`
  ).first();
  if (!setting || !setting.recipient_line_sub) return { sent: false, reason: 'not-configured' };
  const message = action.actionType === 'change'
    ? [
        '【予約変更が入りました】',
        '',
        `${action.customerName} 様`,
        `変更前：${action.originalDate} ${action.originalStartTime}〜${action.originalEndTime}`,
        `変更後：${action.requestedDate} ${action.requestedStartTime}〜${action.requestedEndTime}`,
        action.menuName,
        '',
        'TimeTreeの変更をお願いします。'
      ].join('\n')
    : [
        `【${action.cancelStatus}が入りました】`,
        '',
        `${action.customerName} 様`,
        `${action.originalDate} ${action.originalStartTime}〜${action.originalEndTime}`,
        action.menuName,
        '',
        'TimeTreeの変更をお願いします。'
      ].join('\n');
  const now = new Date().toISOString();
  try {
    await pushLineText(env, setting.recipient_line_sub, message);
    await env.jos_customer_db.prepare(
      `UPDATE line_notification_settings
          SET last_sent_at = ?, last_error = '', updated_at = ?
        WHERE setting_id = 1`
    ).bind(now, now).run();
    return { sent: true };
  } catch (error) {
    await env.jos_customer_db.prepare(
      `UPDATE line_notification_settings
          SET last_error = ?, updated_at = ?
        WHERE setting_id = 1`
    ).bind(normalizeText(error && error.message, 500), now).run();
    return { sent: false, reason: 'send-failed' };
  }
}

function normalizeKana(value, maxLength) {
  return normalizeText(value, maxLength).replace(/[ぁ-ゖ]/g, character =>
    String.fromCharCode(character.charCodeAt(0) + 0x60)
  );
}

function validateCustomerBookingDate(date) {
  date = normalizeText(date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('予約日が正しくありません。');
  }
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error('予約日が正しくありません。');
  }
  const tokyoNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const today = tokyoNow.toISOString().slice(0, 10);
  const maxDate = new Date(Date.UTC(
    tokyoNow.getUTCFullYear(),
    tokyoNow.getUTCMonth(),
    tokyoNow.getUTCDate() + 90
  )).toISOString().slice(0, 10);
  if (date < today || date > maxDate) {
    throw new Error('予約日は本日から90日以内で選択してください。');
  }
  return date;
}

const DEFAULT_BOOKING_LEAD_MINUTES = 60;
const MAX_BOOKING_LEAD_MINUTES = 1440;

function normalizeBookingLeadMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_BOOKING_LEAD_MINUTES) {
    throw new Error('直前予約受付時間は0〜1440分の整数で入力してください。');
  }
  return minutes;
}

async function getBookingLeadMinutes(env) {
  try {
    const setting = await env.jos_customer_db.prepare(
      `SELECT lead_minutes FROM booking_settings WHERE setting_id = 1`
    ).first();
    return normalizeBookingLeadMinutes(
      setting && setting.lead_minutes !== null
        ? Number(setting.lead_minutes)
        : DEFAULT_BOOKING_LEAD_MINUTES
    );
  } catch (error) {
    return DEFAULT_BOOKING_LEAD_MINUTES;
  }
}

function isInsideBookingLeadTime(date, startTime, leadMinutes, nowMs) {
  const startAt = Date.parse(`${date}T${startTime}:00+09:00`);
  if (!Number.isFinite(startAt)) return true;
  const cutoffAt = startAt - normalizeBookingLeadMinutes(leadMinutes) * 60 * 1000;
  return Number(nowMs === undefined ? Date.now() : nowMs) >= cutoffAt;
}

function validateProfile(input) {
  const profile = {
    lastName: normalizeText(input.lastName, 40),
    firstName: normalizeText(input.firstName, 40),
    lastKana: normalizeKana(input.lastKana, 40),
    firstKana: normalizeKana(input.firstKana, 40),
    phone: String(input.phone || '').replace(/[^0-9]/g, ''),
    registrationType: normalizeText(input.registrationType, 20),
    customerType: normalizeText(input.customerType, 10),
    birthday: normalizeText(input.birthday, 10)
  };

  if (!profile.lastName || !profile.firstName) throw new Error('姓と名を入力してください。');
  if (!profile.lastKana || !profile.firstKana) throw new Error('セイとメイを入力してください。');
  const kana = profile.lastKana + profile.firstKana;
  if (!/^[ァ-ヶー・\s]+$/.test(kana)) throw new Error('フリガナはカタカナで入力してください。');
  if (!/^0\d{9,10}$/.test(profile.phone)) throw new Error('電話番号を正しく入力してください。');
  if (!['new', 'existing'].includes(profile.registrationType)) {
    throw new Error('当店のご利用状況を選択してください。');
  }
  if (profile.registrationType === 'new' &&
      !['一般', '学生'].includes(profile.customerType)) {
    throw new Error('一般または学生を選択してください。');
  }
  if (!profile.birthday) {
    throw new Error('生年月日を選択してください。');
  }
  const parsedBirthday = new Date(`${profile.birthday}T00:00:00Z`);
  const tokyoToday = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.birthday) ||
      isNaN(parsedBirthday.getTime()) ||
      parsedBirthday.toISOString().slice(0, 10) !== profile.birthday ||
      profile.birthday < '1900-01-01' ||
      profile.birthday > tokyoToday) {
    throw new Error('生年月日を正しく選択してください。');
  }
  return profile;
}

function publicProfile(row, needsInitialCounseling = false) {
  if (!row) return null;
  return {
    lastName: row.last_name,
    firstName: row.first_name,
    lastKana: row.last_kana,
    firstKana: row.first_kana,
    phone: row.phone,
    linkStatus: row.link_status,
    registrationType: row.registration_type || 'existing',
    customerType: row.customer_type || '',
    birthday: row.birthday || '',
    needsInitialCounseling
  };
}

function publicReservation(row) {
  if (!row) return null;
  return {
    reservationId: row.reservation_id,
    date: row.reservation_date,
    startTime: row.start_time,
    endTime: row.end_time,
    menu: row.menu_name,
    price: Number(row.price || 0),
    status: row.reservation_status
  };
}

async function getProfile(env, identity) {
  const row = await env.jos_customer_db.prepare(
    `SELECT last_name, first_name, last_kana, first_kana, phone,
            link_status, jos_customer_id, registration_type,
            customer_type, birthday
       FROM customer_profiles
      WHERE line_sub = ?`
  ).bind(identity.sub).first();
  const needsInitialCounseling = await customerNeedsInitialCounseling(env, row);
  return json({
    ok: true,
    exists: Boolean(row),
    profile: publicProfile(row, needsInitialCounseling)
  });
}

async function customerNeedsInitialCounseling(env, profile) {
  if (!profile || profile.registration_type !== 'new' || !profile.jos_customer_id) {
    return false;
  }
  const booking = await env.jos_customer_db.prepare(
    `SELECT request_id FROM customer_booking_requests
      WHERE jos_customer_id = ? AND status IN ('pending', 'confirmed')
      LIMIT 1`
  ).bind(profile.jos_customer_id).first();
  return !booking;
}

export async function getCustomerAnnouncements(env, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const nowIso = now.toISOString();
  const result = await env.jos_customer_db.prepare(
    `SELECT announcement_id, title, body, published_at, expires_at, image_key
       FROM customer_announcements
      WHERE is_published = 1
        AND published_at <= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY published_at DESC, announcement_id DESC
      LIMIT 20`
  ).bind(nowIso, nowIso).all();

  return {
    ok: true,
    announcements: (result.results || []).map(row => ({
      announcementId: String(row.announcement_id || ''),
      title: String(row.title || ''),
      body: String(row.body || ''),
      imageUrl: row.image_key
        ? `/api/announcement-image/${encodeURIComponent(String(row.image_key))}`
        : '',
      publishedAt: String(row.published_at || ''),
      expiresAt: row.expires_at ? String(row.expires_at) : ''
    }))
  };
}

function announcementImageInput(input) {
  const match = String(input || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('画像はJPG・PNG・WebP形式で選択してください。');
  const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
  if (!bytes.length || bytes.length > 2000000) {
    throw new Error('画像は2MB以下にしてください。');
  }
  return { bytes, contentType: match[1] };
}

export async function saveCustomerAnnouncement(env, input, options = {}) {
  input = input && typeof input === 'object' ? input : {};
  const now = options.now instanceof Date ? options.now : new Date();
  const nowIso = now.toISOString();
  const announcementId = normalizeText(input.announcementId, 100) ||
    crypto.randomUUID().replace(/-/g, '');
  const title = normalizeText(input.title, 120);
  const body = normalizeText(input.body, 3000);
  const publishedAt = normalizeText(input.publishedAt, 40) || nowIso;
  const expiresAt = normalizeText(input.expiresAt, 40) || null;
  const isPublished = input.isPublished === true ? 1 : 0;
  let imageKey = normalizeText(input.existingImageKey, 200) || null;
  let imageContentType = null;

  if (input.removeImage === true) imageKey = null;
  if (input.imageData) {
    const image = announcementImageInput(input.imageData);
    const extension = image.contentType === 'image/png'
      ? 'png'
      : image.contentType === 'image/webp' ? 'webp' : 'jpg';
    imageKey = `${announcementId}/${crypto.randomUUID()}.${extension}`;
    imageContentType = image.contentType;
    await env.ANNOUNCEMENT_IMAGES.put(imageKey, image.bytes, {
      httpMetadata: { contentType: image.contentType }
    });
  }

  if (!title && !body && !imageKey) {
    throw new Error('画像または文字を1つ以上入力してください。');
  }
  if (Number.isNaN(Date.parse(publishedAt)) ||
      (expiresAt && Number.isNaN(Date.parse(expiresAt)))) {
    throw new Error('公開日時が正しくありません。');
  }
  if (expiresAt && expiresAt <= publishedAt) {
    throw new Error('公開終了は公開開始より後にしてください。');
  }

  await env.jos_customer_db.prepare(
    `INSERT INTO customer_announcements
       (announcement_id, title, body, published_at, expires_at, is_published,
        created_at, updated_at, image_key, image_content_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(announcement_id) DO UPDATE SET
       title = excluded.title,
       body = excluded.body,
       published_at = excluded.published_at,
       expires_at = excluded.expires_at,
       is_published = excluded.is_published,
       updated_at = excluded.updated_at,
       image_key = excluded.image_key,
       image_content_type = COALESCE(excluded.image_content_type, image_content_type)`
  ).bind(
    announcementId, title, body, publishedAt, expiresAt, isPublished,
    nowIso, nowIso, imageKey, imageContentType
  ).run();

  return {
    ok: true,
    announcementId,
    isPublished: isPublished === 1,
    hasImage: Boolean(imageKey)
  };
}

export async function listCustomerAnnouncementsForAdmin(env) {
  const result = await env.jos_customer_db.prepare(
    `SELECT announcement_id, title, body, published_at, expires_at,
            is_published, image_key
       FROM customer_announcements
      ORDER BY updated_at DESC
      LIMIT 100`
  ).all();
  return {
    ok: true,
    announcements: (result.results || []).map(row => ({
      announcementId: String(row.announcement_id || ''),
      title: String(row.title || ''),
      body: String(row.body || ''),
      publishedAt: String(row.published_at || ''),
      expiresAt: row.expires_at ? String(row.expires_at) : '',
      isPublished: Number(row.is_published) === 1,
      imageKey: String(row.image_key || ''),
      imageUrl: row.image_key
        ? `/api/announcement-image/${encodeURIComponent(String(row.image_key))}`
        : ''
    }))
  };
}

export async function setCustomerAnnouncementPublished(env, input, options = {}) {
  input = input && typeof input === 'object' ? input : {};
  const announcementId = normalizeText(input.announcementId, 100);
  if (!announcementId) throw new Error('お知らせIDが正しくありません。');
  const isPublished = input.isPublished === true ? 1 : 0;
  const now = options.now instanceof Date ? options.now : new Date();
  const result = await env.jos_customer_db.prepare(
    `UPDATE customer_announcements
        SET is_published = ?, updated_at = ?
      WHERE announcement_id = ?`
  ).bind(isPublished, now.toISOString(), announcementId).run();
  if (!result.meta || Number(result.meta.changes) !== 1) {
    throw new Error('対象のお知らせが見つかりません。');
  }
  return {
    ok: true,
    announcementId,
    isPublished: isPublished === 1
  };
}

export async function deleteCustomerAnnouncement(env, input) {
  input = input && typeof input === 'object' ? input : {};
  const announcementId = normalizeText(input.announcementId, 100);
  if (!announcementId) throw new Error('お知らせIDが正しくありません。');
  const row = await env.jos_customer_db.prepare(
    `SELECT image_key
       FROM customer_announcements
      WHERE announcement_id = ?`
  ).bind(announcementId).first();
  if (!row) throw new Error('対象のお知らせが見つかりません。');

  const result = await env.jos_customer_db.prepare(
    `DELETE FROM customer_announcements
      WHERE announcement_id = ?`
  ).bind(announcementId).run();
  if (!result.meta || Number(result.meta.changes) !== 1) {
    throw new Error('お知らせを削除できませんでした。');
  }
  const imageKey = String(row.image_key || '');
  if (imageKey) await env.ANNOUNCEMENT_IMAGES.delete(imageKey);
  return {
    ok: true,
    announcementId,
    imageDeleted: Boolean(imageKey)
  };
}

async function getAnnouncementImage(request, env, pathname) {
  if (request.method !== 'GET') {
    return json({ ok: false, message: 'GETのみ利用できます。' }, 405);
  }
  const prefix = '/api/announcement-image/';
  const key = decodeURIComponent(pathname.slice(prefix.length));
  if (!key || key.includes('..') || key.startsWith('/')) {
    return json({ ok: false, message: '画像が見つかりません。' }, 404);
  }
  const object = await env.ANNOUNCEMENT_IMAGES.get(key);
  if (!object) return json({ ok: false, message: '画像が見つかりません。' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=86400');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.body, { headers });
}

async function saveProfile(env, identity, input) {
  const profile = validateProfile(input);
  const now = new Date().toISOString();
  const existing = await env.jos_customer_db.prepare(
    `SELECT link_status, jos_customer_id
       FROM customer_profiles WHERE line_sub = ?`
  ).bind(identity.sub).first();

  if (existing && existing.link_status === 'approved') {
    const requestId = crypto.randomUUID().replace(/-/g, '');
    try {
      await env.jos_customer_db.prepare(
        `INSERT INTO customer_profile_update_requests
           (request_id, line_sub, jos_customer_id, last_name, first_name,
            last_kana, first_kana, phone, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      ).bind(
        requestId,
        identity.sub,
        existing.jos_customer_id,
        profile.lastName,
        profile.firstName,
        profile.lastKana,
        profile.firstKana,
        profile.phone,
        now,
        now
      ).run();
    } catch (_) {
      return json({
        ok: false,
        message: '登録情報の変更を受付済みです。反映まで少しお待ちください。'
      }, 409);
    }
    return json({
      ok: true,
      pendingUpdate: true,
      requestId,
      profile: { ...profile, linkStatus: 'approved' }
    });
  }

  const approvalKey = crypto.randomUUID().replace(/-/g, '');

  await env.jos_customer_db.prepare(
    `INSERT INTO customer_profiles
       (line_sub, line_display_name, last_name, first_name, last_kana,
        first_kana, phone, registration_type, customer_type, birthday,
        link_status, approval_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(line_sub) DO UPDATE SET
       line_display_name = excluded.line_display_name,
       last_name = excluded.last_name,
       first_name = excluded.first_name,
       last_kana = excluded.last_kana,
       first_kana = excluded.first_kana,
       phone = excluded.phone,
       registration_type = excluded.registration_type,
       customer_type = excluded.customer_type,
       birthday = excluded.birthday,
       updated_at = excluded.updated_at`
  ).bind(
    identity.sub,
    identity.displayName,
    profile.lastName,
    profile.firstName,
    profile.lastKana,
    profile.firstKana,
    profile.phone,
    profile.registrationType,
    profile.customerType,
    profile.birthday,
    approvalKey,
    now,
    now
  ).run();

  {
    const lifecycleType = profile.registrationType === 'new'
      ? 'new-registration' : 'existing-link-request';
    await queueCustomerLifecycleNotification(env, lifecycleType, identity.sub, {
      lineDisplayName: identity.displayName,
      lastName: profile.lastName,
      firstName: profile.firstName,
      lastKana: profile.lastKana,
      firstKana: profile.firstKana,
      phone: profile.phone
    });
  }

  return json({ ok: true, profile: { ...profile, linkStatus: 'pending' } });
}

function adminAuthorized(request, env) {
  const expected = String(env.JOS_ADMIN_SECRET || '');
  const supplied = String(request.headers.get('authorization') || '');
  return expected.length >= 32 && supplied === `Bearer ${expected}`;
}

async function adminApi(request, env, pathname) {
  if (request.method !== 'POST') return json({ ok: false, message: 'POSTのみ利用できます。' }, 405);
  if (!adminAuthorized(request, env)) return json({ ok: false, message: '管理認証に失敗しました。' }, 401);

  try {
    if (pathname === '/api/admin/booking-settings/get') {
      return json({
        ok: true,
        leadMinutes: await getBookingLeadMinutes(env)
      });
    }

    if (pathname === '/api/admin/booking-settings/save') {
      const body = await readJson(request);
      const leadMinutes = normalizeBookingLeadMinutes(body.leadMinutes);
      const now = new Date().toISOString();
      await env.jos_customer_db.prepare(
        `INSERT INTO booking_settings (setting_id, lead_minutes, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(setting_id) DO UPDATE SET
           lead_minutes = excluded.lead_minutes,
           updated_at = excluded.updated_at`
      ).bind(leadMinutes, now).run();
      return json({ ok: true, leadMinutes, updatedAt: now });
    }

    if (pathname === '/api/admin/line-notifications/status') {
      await flushPendingCustomerLifecycleNotifications(env, 20);
      const setting = await env.jos_customer_db.prepare(
        `SELECT recipient_line_sub, recipient_display_name, last_sent_at,
                last_error, updated_at
           FROM line_notification_settings WHERE setting_id = 1`
      ).first();
      const candidates = await env.jos_customer_db.prepare(
        `SELECT line_user_id, display_name
           FROM line_notification_recipients
          ORDER BY display_name ASC, registered_at ASC
          LIMIT 1000`
      ).all();
      return json({
        ok: true,
        configured: Boolean(setting && setting.recipient_line_sub),
        recipientDisplayName: setting && setting.recipient_display_name || '',
        lastSentAt: setting && setting.last_sent_at || '',
        lastError: setting && setting.last_error || '',
        updatedAt: setting && setting.updated_at || '',
        candidates: (candidates.results || []).map(row => ({
          lineSub: row.line_user_id,
          lineDisplayName: row.display_name || '',
          customerName: ''
        }))
      });
    }

    if (pathname === '/api/admin/line-notifications/recipient') {
      const body = await readJson(request);
      const lineSub = normalizeText(body.lineSub, 100);
      if (!lineSub) throw new Error('通知先LINEを選択してください。');
      const profile = await env.jos_customer_db.prepare(
        `SELECT display_name FROM line_notification_recipients
          WHERE line_user_id = ?`
      ).bind(lineSub).first();
      if (!profile) throw new Error('公式LINEで登録した通知先を確認できませんでした。');
      const now = new Date().toISOString();
      await env.jos_customer_db.prepare(
        `INSERT INTO line_notification_settings
           (setting_id, recipient_line_sub, recipient_display_name, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(setting_id) DO UPDATE SET
           recipient_line_sub = excluded.recipient_line_sub,
           recipient_display_name = excluded.recipient_display_name,
           last_error = '',
           updated_at = excluded.updated_at`
      ).bind(lineSub, profile.display_name || '', now).run();
      return json({ ok: true, recipientDisplayName: profile.display_name || '' });
    }

    if (pathname === '/api/admin/line-notifications/test') {
      const setting = await env.jos_customer_db.prepare(
        `SELECT recipient_line_sub FROM line_notification_settings WHERE setting_id = 1`
      ).first();
      if (!setting || !setting.recipient_line_sub) throw new Error('通知先LINEが未設定です。');
      await pushLineText(env, setting.recipient_line_sub,
        '【JOS通知テスト】\n予約通知の受信設定が完了しました。');
      return json({ ok: true });
    }

    if (pathname === '/api/admin/followups/admin-test-status') {
      const setting = await env.jos_customer_db.prepare(
        `SELECT recipient_line_sub, recipient_display_name
           FROM line_notification_settings WHERE setting_id = 1`
      ).first();
      return json({
        ok: true,
        configured: Boolean(setting && setting.recipient_line_sub),
        recipientDisplayName: setting && setting.recipient_display_name || ''
      });
    }

    if (pathname === '/api/admin/followups/admin-test-send') {
      const body = await readJson(request);
      const testId = normalizeText(body.testId, 80);
      const messageType = normalizeText(body.messageType, 20);
      const confirmation = normalizeText(body.confirmation, 100);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(testId)) {
        throw new Error('管理者テスト送信IDを確認できません。');
      }
      if (!['beard', 'body_vio', 'reservation_reminder'].includes(messageType)) {
        throw new Error('管理者テストの文章種別を確認できません。');
      }
      if (confirmation !== '管理者本人へテスト送信') {
        throw new Error('管理者本人へのテスト送信確認がありません。');
      }
      const testTable = messageType === 'reservation_reminder'
        ? 'reservation_reminder_admin_tests' : 'followup_admin_tests';
      const existing = await env.jos_customer_db.prepare(
        `SELECT status FROM ${testTable} WHERE test_id = ?`
      ).bind(testId).first();
      if (existing) {
        if (existing.status === 'sent') {
          return json({ ok: true, sent: true, idempotent: true });
        }
        throw new Error('同じテスト送信は再実行できません。');
      }
      const setting = await env.jos_customer_db.prepare(
        `SELECT recipient_line_sub, recipient_display_name
           FROM line_notification_settings WHERE setting_id = 1`
      ).first();
      if (!setting || !setting.recipient_line_sub) {
        throw new Error('管理者の通知先LINEが未設定です。');
      }
      const message = followupAdminTestMessage(messageType);
      const now = new Date().toISOString();
      if (messageType === 'reservation_reminder') {
        await env.jos_customer_db.prepare(
          `INSERT INTO reservation_reminder_admin_tests
             (test_id, recipient_line_sub, recipient_display_name,
              message_text, status, created_at)
           VALUES (?, ?, ?, ?, 'sending', ?)`
        ).bind(testId, setting.recipient_line_sub,
          setting.recipient_display_name || '', message, now).run();
      } else {
        await env.jos_customer_db.prepare(
          `INSERT INTO followup_admin_tests
             (test_id, message_type, recipient_line_sub, recipient_display_name,
              message_text, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'sending', ?)`
        ).bind(testId, messageType, setting.recipient_line_sub,
          setting.recipient_display_name || '', message, now).run();
      }
      try {
        await pushLineText(env, setting.recipient_line_sub, message);
        const sentAt = new Date().toISOString();
        await env.jos_customer_db.prepare(
          `UPDATE ${testTable}
              SET status = 'sent', sent_at = ?, last_error = ''
            WHERE test_id = ? AND status = 'sending'`
        ).bind(sentAt, testId).run();
        return json({
          ok: true,
          sent: true,
          idempotent: false,
          recipientDisplayName: setting.recipient_display_name || ''
        });
      } catch (error) {
        await env.jos_customer_db.prepare(
          `UPDATE ${testTable}
              SET status = 'failed', last_error = ?
            WHERE test_id = ? AND status = 'sending'`
        ).bind(normalizeText(error && error.message, 500), testId).run();
        throw error;
      }
    }

    if (pathname === '/api/admin/reminders/batches') {
      const body = await readJson(request);
      const targetDate = normalizeIsoDateOnly(body.targetDate);
      if (!targetDate) throw new Error('前日リマインドの対象日を確認できません。');
      const batch = await env.jos_customer_db.prepare(
        `SELECT batch_id, target_date, scheduled_for, status, candidate_count,
                created_at, approved_at, completed_at, cancelled_at, last_error
           FROM reservation_reminder_batches
          WHERE target_date = ?
          ORDER BY created_at DESC LIMIT 1`
      ).bind(targetDate).first();
      if (!batch) return json({ ok: true, batch: null });
      const counts = await env.jos_customer_db.prepare(
        `SELECT status, COUNT(*) AS count
           FROM reservation_reminder_deliveries
          WHERE batch_id = ? GROUP BY status`
      ).bind(batch.batch_id).all();
      return json({
        ok: true,
        batch: {
          batchId: batch.batch_id,
          targetDate: batch.target_date,
          scheduledFor: batch.scheduled_for,
          status: batch.status,
          candidateCount: Number(batch.candidate_count || 0),
          createdAt: batch.created_at,
          approvedAt: batch.approved_at || '',
          completedAt: batch.completed_at || '',
          cancelledAt: batch.cancelled_at || '',
          lastError: batch.last_error || '',
          deliveryCounts: Object.fromEntries((counts.results || []).map(row => [
            row.status, Number(row.count || 0)
          ]))
        }
      });
    }

    if (pathname === '/api/admin/reminders/batch-save') {
      const body = await readJson(request);
      const batchId = normalizeText(body.batchId, 80);
      const targetDate = normalizeIsoDateOnly(body.targetDate);
      const confirmation = normalizeText(body.confirmation, 100);
      const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
      if (!/^[A-Za-z0-9-]{16,80}$/.test(batchId)) {
        throw new Error('前日リマインドの保存IDを確認できません。');
      }
      if (confirmation !== '送信せず18時予定を保存') {
        throw new Error('送信しない予定保存の確認がありません。');
      }
      if (targetDate !== addIsoDays(japanDateOnly(), 1) || !items.length) {
        throw new Error('翌日の送信候補を確認できません。');
      }
      const existingId = await env.jos_customer_db.prepare(
        `SELECT batch_id, status FROM reservation_reminder_batches WHERE batch_id = ?`
      ).bind(batchId).first();
      if (existingId) {
        if (existingId.status === 'draft') {
          return json({ ok: true, saved: true, idempotent: true, batchId });
        }
        throw new Error('同じ保存IDは再利用できません。');
      }
      const active = await env.jos_customer_db.prepare(
        `SELECT batch_id FROM reservation_reminder_batches
          WHERE target_date = ? AND status IN ('draft', 'scheduled', 'processing') LIMIT 1`
      ).bind(targetDate).first();
      if (active) throw new Error('同じ対象日の18時送信予定がすでにあります。');
      const reservationIds = new Set();
      const customerIds = new Set();
      const normalizedItems = [];
      for (const item of items) {
        const reservationId = normalizeText(item && item.reservationId, 100);
        const customerId = normalizeText(item && item.customerId, 100);
        const reservationDate = normalizeIsoDateOnly(item && item.reservationDate);
        const startTime = normalizeText(item && item.startTime, 20);
        const endTime = normalizeText(item && item.endTime, 20);
        const store = normalizeText(item && item.store, 100);
        const menu = normalizeText(item && item.menu, 300);
        const customerName = normalizeText(item && item.customerName, 100);
        const messageText = normalizeLineMessage(item && item.messageText, 4500);
        const deliveryId = normalizeText(item && item.deliveryId, 80);
        if (!/^[A-Za-z0-9-]{16,80}$/.test(deliveryId) || !reservationId || !customerId ||
            reservationDate !== targetDate || !/^\d{1,2}:\d{2}$/.test(startTime) ||
            !store || !menu || !customerName || !messageText) {
          throw new Error('保存する予約情報に不足があります。');
        }
        if (reservationIds.has(reservationId) || customerIds.has(customerId)) {
          throw new Error('同じ予約またはお客様が重複しています。');
        }
        reservationIds.add(reservationId);
        customerIds.add(customerId);
        const profiles = await env.jos_customer_db.prepare(
          `SELECT line_sub FROM customer_profiles
            WHERE jos_customer_id = ? AND link_status = 'approved' LIMIT 2`
        ).bind(customerId).all();
        if ((profiles.results || []).filter(row => row.line_sub).length !== 1) {
          throw new Error('お客様のLINE連携を1件に特定できません。');
        }
        normalizedItems.push({ deliveryId, reservationId, customerId, reservationDate,
          startTime, endTime, store, menu, customerName, messageText });
      }
      const now = new Date().toISOString();
      const scheduledFor = new Date(`${japanDateOnly()}T18:00:00+09:00`).toISOString();
      const statements = [env.jos_customer_db.prepare(
        `INSERT INTO reservation_reminder_batches
           (batch_id, target_date, scheduled_for, status, candidate_count, created_at)
         VALUES (?, ?, ?, 'draft', ?, ?)`
      ).bind(batchId, targetDate, scheduledFor, normalizedItems.length, now)];
      normalizedItems.forEach(item => statements.push(env.jos_customer_db.prepare(
        `INSERT INTO reservation_reminder_deliveries
           (delivery_id, batch_id, reservation_id, jos_customer_id,
            reservation_date, start_time, end_time, store_name, menu_name,
            customer_name, message_text, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
      ).bind(item.deliveryId, batchId, item.reservationId, item.customerId,
        item.reservationDate, item.startTime, item.endTime, item.store, item.menu,
        item.customerName, item.messageText, now)));
      await env.jos_customer_db.batch(statements);
      return json({ ok: true, saved: true, idempotent: false, batchId,
        candidateCount: normalizedItems.length, scheduledFor });
    }

    if (pathname === '/api/admin/reminders/batch-cancel') {
      const body = await readJson(request);
      const batchId = normalizeText(body.batchId, 80);
      const confirmation = normalizeText(body.confirmation, 100);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(batchId) ||
          confirmation !== '未送信の18時予定を取り消す') {
        throw new Error('取消対象または確認内容が正しくありません。');
      }
      const batch = await env.jos_customer_db.prepare(
        `SELECT status FROM reservation_reminder_batches WHERE batch_id = ?`
      ).bind(batchId).first();
      if (!batch) throw new Error('取り消す18時送信予定が見つかりません。');
      if (batch.status === 'cancelled') {
        return json({ ok: true, cancelled: true, idempotent: true });
      }
      if (batch.status !== 'draft') throw new Error('下書き状態以外は取り消せません。');
      const now = new Date().toISOString();
      await env.jos_customer_db.batch([
        env.jos_customer_db.prepare(
          `UPDATE reservation_reminder_batches SET status = 'cancelled', cancelled_at = ?
            WHERE batch_id = ? AND status = 'draft'`
        ).bind(now, batchId),
        env.jos_customer_db.prepare(
          `UPDATE reservation_reminder_deliveries SET status = 'cancelled'
            WHERE batch_id = ? AND status = 'draft'`
        ).bind(batchId)
      ]);
      return json({ ok: true, cancelled: true, idempotent: false });
    }

    if (pathname === '/api/admin/reminders/batch-approve') {
      const body = await readJson(request);
      const batchId = normalizeText(body.batchId, 80);
      const confirmation = normalizeText(body.confirmation, 120);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(batchId) ||
          confirmation !== '確認済み候補を本日18時に送信予約') {
        throw new Error('18時送信予約の対象または確認内容が正しくありません。');
      }
      const batch = await env.jos_customer_db.prepare(
        `SELECT target_date, scheduled_for, status, candidate_count
           FROM reservation_reminder_batches WHERE batch_id = ?`
      ).bind(batchId).first();
      if (!batch) throw new Error('承認する18時送信予定が見つかりません。');
      if (batch.status === 'scheduled') {
        return json({ ok: true, scheduled: true, idempotent: true });
      }
      if (batch.status !== 'draft') throw new Error('未承認の予定以外は承認できません。');
      if (normalizeIsoDateOnly(batch.target_date) !== addIsoDays(japanDateOnly(), 1)) {
        throw new Error('翌日分以外の予定は承認できません。');
      }
      const japanTime = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(new Date());
      if (japanTime >= '18:00') throw new Error('18時を過ぎているため送信予約できません。');
      const deliveries = await env.jos_customer_db.prepare(
        `SELECT delivery_id, jos_customer_id FROM reservation_reminder_deliveries
          WHERE batch_id = ? AND status = 'draft' ORDER BY start_time ASC`
      ).bind(batchId).all();
      if ((deliveries.results || []).length !== Number(batch.candidate_count || 0)) {
        throw new Error('保存人数と送信予定人数が一致しません。');
      }
      for (const delivery of deliveries.results || []) {
        const profiles = await env.jos_customer_db.prepare(
          `SELECT line_sub FROM customer_profiles
            WHERE jos_customer_id = ? AND link_status = 'approved' LIMIT 2`
        ).bind(delivery.jos_customer_id).all();
        if ((profiles.results || []).filter(row => row.line_sub).length !== 1) {
          throw new Error('LINE連携を1件に特定できないお客様がいるため承認していません。');
        }
      }
      const now = new Date().toISOString();
      await env.jos_customer_db.batch([
        env.jos_customer_db.prepare(
          `UPDATE reservation_reminder_batches
              SET status = 'scheduled', approved_at = ?, last_error = ''
            WHERE batch_id = ? AND status = 'draft'`
        ).bind(now, batchId),
        env.jos_customer_db.prepare(
          `UPDATE reservation_reminder_deliveries SET status = 'scheduled'
            WHERE batch_id = ? AND status = 'draft'`
        ).bind(batchId)
      ]);
      return json({ ok: true, scheduled: true, idempotent: false,
        candidateCount: Number(batch.candidate_count || 0), scheduledFor: batch.scheduled_for });
    }

    if (pathname === '/api/admin/reminders/batch-due') {
      const now = new Date();
      const batch = await env.jos_customer_db.prepare(
        `SELECT batch_id, target_date, scheduled_for, status
           FROM reservation_reminder_batches
          WHERE status = 'scheduled' AND scheduled_for <= ?
          ORDER BY scheduled_for ASC LIMIT 1`
      ).bind(now.toISOString()).first();
      if (!batch) return json({ ok: true, batch: null, deliveries: [] });
      if (normalizeIsoDateOnly(batch.target_date) !== addIsoDays(japanDateOnly(), 1)) {
        throw new Error('送信対象日が翌日ではないため安全停止しました。');
      }
      const deliveries = await env.jos_customer_db.prepare(
        `SELECT delivery_id, reservation_id, jos_customer_id, reservation_date,
                start_time, end_time, store_name, menu_name, customer_name,
                message_text, status
           FROM reservation_reminder_deliveries
          WHERE batch_id = ? AND status = 'scheduled'
          ORDER BY start_time ASC, reservation_id ASC LIMIT 100`
      ).bind(batch.batch_id).all();
      return json({
        ok: true,
        batch: { batchId: batch.batch_id, targetDate: batch.target_date,
          scheduledFor: batch.scheduled_for, status: batch.status },
        deliveries: (deliveries.results || []).map(row => ({
          deliveryId: row.delivery_id, reservationId: row.reservation_id,
          customerId: row.jos_customer_id, reservationDate: row.reservation_date,
          startTime: row.start_time, endTime: row.end_time,
          store: row.store_name, menu: row.menu_name,
          customerName: row.customer_name, messageText: row.message_text,
          status: row.status
        }))
      });
    }

    if (pathname === '/api/admin/reminders/delivery-suppress') {
      const body = await readJson(request);
      const deliveryId = normalizeText(body.deliveryId, 80);
      const reason = normalizeText(body.reason, 500);
      const confirmation = normalizeText(body.confirmation, 100);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(deliveryId) || !reason ||
          confirmation !== '送信直前確認で除外') {
        throw new Error('送信除外の情報を確認できません。');
      }
      const result = await env.jos_customer_db.prepare(
        `UPDATE reservation_reminder_deliveries
            SET status = 'suppressed', last_error = ?
          WHERE delivery_id = ? AND status = 'scheduled'`
      ).bind(reason, deliveryId).run();
      return json({ ok: true, suppressed: Number(result && result.meta && result.meta.changes || 0) === 1 });
    }

    if (pathname === '/api/admin/reminders/delivery-fail') {
      const body = await readJson(request);
      const deliveryId = normalizeText(body.deliveryId, 80);
      const reason = normalizeText(body.reason, 500);
      const confirmation = normalizeText(body.confirmation, 100);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(deliveryId) || !reason ||
          confirmation !== '送信失敗を記録し自動再送しない') {
        throw new Error('送信失敗の記録情報を確認できません。');
      }
      const result = await env.jos_customer_db.prepare(
        `UPDATE reservation_reminder_deliveries
            SET status = 'failed', last_error = ?
          WHERE delivery_id = ? AND status = 'scheduled'`
      ).bind(reason, deliveryId).run();
      return json({ ok: true, failed: Number(result && result.meta && result.meta.changes || 0) === 1 });
    }

    if (pathname === '/api/admin/reminders/delivery-send') {
      const body = await readJson(request);
      const deliveryId = normalizeText(body.deliveryId, 80);
      const confirmation = normalizeText(body.confirmation, 100);
      const revalidatedAt = new Date(normalizeText(body.revalidatedAt, 40));
      const age = Date.now() - revalidatedAt.getTime();
      if (!/^[A-Za-z0-9-]{16,80}$/.test(deliveryId) ||
          confirmation !== '18時予定の確認済み1件を送信') {
        throw new Error('18時送信対象または確認内容が正しくありません。');
      }
      if (Number.isNaN(revalidatedAt.getTime()) || age < -5000 || age > 60000) {
        throw new Error('JOSの送信直前確認が期限切れです。');
      }
      const delivery = await env.jos_customer_db.prepare(
        `SELECT d.jos_customer_id, d.reservation_date, d.message_text, d.status,
                b.status AS batch_status, b.scheduled_for
           FROM reservation_reminder_deliveries d
           JOIN reservation_reminder_batches b ON b.batch_id = d.batch_id
          WHERE d.delivery_id = ?`
      ).bind(deliveryId).first();
      if (!delivery) throw new Error('18時送信対象が見つかりません。');
      if (delivery.status === 'sent') return json({ ok: true, sent: true, idempotent: true });
      if (delivery.status !== 'scheduled' || delivery.batch_status !== 'scheduled') {
        throw new Error('承認済みの送信予定以外は送信できません。');
      }
      if (normalizeIsoDateOnly(delivery.reservation_date) !== addIsoDays(japanDateOnly(), 1) ||
          new Date(delivery.scheduled_for).getTime() > Date.now()) {
        throw new Error('18時送信の日時条件を満たしていません。');
      }
      const profiles = await env.jos_customer_db.prepare(
        `SELECT line_sub FROM customer_profiles
          WHERE jos_customer_id = ? AND link_status = 'approved' LIMIT 2`
      ).bind(delivery.jos_customer_id).all();
      const linked = (profiles.results || []).filter(row => row.line_sub);
      if (linked.length !== 1) throw new Error('送信先LINEを1件に特定できません。');
      const claimAt = new Date().toISOString();
      const claim = await env.jos_customer_db.prepare(
        `UPDATE reservation_reminder_deliveries
            SET status = 'sending', attempt_count = attempt_count + 1,
                last_attempt_at = ?, last_error = ''
          WHERE delivery_id = ? AND status = 'scheduled'`
      ).bind(claimAt, deliveryId).run();
      if (Number(claim && claim.meta && claim.meta.changes || 0) !== 1) {
        throw new Error('送信開始を安全に記録できませんでした。送信していません。');
      }
      try {
        await pushLineText(env, linked[0].line_sub, delivery.message_text);
      } catch (error) {
        await env.jos_customer_db.prepare(
          `UPDATE reservation_reminder_deliveries SET status = 'failed', last_error = ?
            WHERE delivery_id = ? AND status = 'sending'`
        ).bind(normalizeText(error && error.message, 500), deliveryId).run();
        throw error;
      }
      const sentAt = new Date().toISOString();
      const finalized = await env.jos_customer_db.prepare(
        `UPDATE reservation_reminder_deliveries
            SET status = 'sent', sent_at = ?, last_error = ''
          WHERE delivery_id = ? AND status = 'sending'`
      ).bind(sentAt, deliveryId).run();
      if (Number(finalized && finalized.meta && finalized.meta.changes || 0) !== 1) {
        throw new Error('LINE送信後の記録に失敗しました。自動再送は行いません。');
      }
      return json({ ok: true, sent: true, idempotent: false, sentAt });
    }

    if (pathname === '/api/admin/reminders/batch-finalize') {
      const body = await readJson(request);
      const batchId = normalizeText(body.batchId, 80);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(batchId)) throw new Error('完了対象を確認できません。');
      const counts = await env.jos_customer_db.prepare(
        `SELECT status, COUNT(*) AS count FROM reservation_reminder_deliveries
          WHERE batch_id = ? GROUP BY status`
      ).bind(batchId).all();
      const values = Object.fromEntries((counts.results || []).map(row => [row.status, Number(row.count || 0)]));
      if (Number(values.scheduled || 0) || Number(values.sending || 0)) {
        return json({ ok: true, finalized: false, deliveryCounts: values });
      }
      const hasFailure = Number(values.failed || 0) > 0;
      const status = hasFailure ? 'partial' : 'completed';
      const now = new Date().toISOString();
      await env.jos_customer_db.prepare(
        `UPDATE reservation_reminder_batches SET status = ?, completed_at = ?
          WHERE batch_id = ? AND status = 'scheduled'`
      ).bind(status, now, batchId).run();
      return json({ ok: true, finalized: true, status, deliveryCounts: values });
    }

    if (pathname === '/api/admin/followups/draft-save') {
      const body = await readJson(request);
      const draftId = normalizeText(body.draftId, 80);
      const customerId = normalizeText(body.customerId, 100);
      const lastVisitDate = normalizeIsoDateOnly(body.lastVisitDate);
      const timingGroup = normalizeText(body.timingGroup, 20);
      const dueDate = normalizeIsoDateOnly(body.dueDate);
      const messageText = normalizeLineMessage(body.messageText, 4500);
      const confirmation = normalizeText(body.confirmation, 100);
      const partNames = Array.isArray(body.partNames)
        ? body.partNames.slice(0, 100).map(value => normalizeText(value, 100)).filter(Boolean)
        : [];
      if (!/^[A-Za-z0-9-]{16,80}$/.test(draftId)) {
        throw new Error('下書きIDを確認できません。');
      }
      if (!customerId || !lastVisitDate || !dueDate || !messageText || !partNames.length) {
        throw new Error('下書きに必要な施術情報を確認できません。');
      }
      if (!['beard', 'body_vio'].includes(timingGroup)) {
        throw new Error('施術区分を確認できません。');
      }
      if (confirmation !== '送信せず下書き保存') {
        throw new Error('下書き保存の確認がありません。');
      }
      const expectedDueDate = addIsoDays(lastVisitDate, timingGroup === 'beard' ? 21 : 42);
      if (dueDate !== expectedDueDate || dueDate > japanDateOnly()) {
        throw new Error('送信予定日が安全条件と一致しません。');
      }
      const approved = await env.jos_customer_db.prepare(
        `SELECT COUNT(*) AS matching_count
           FROM customer_profiles
          WHERE jos_customer_id = ? AND link_status = 'approved'`
      ).bind(customerId).first();
      if (Number(approved && approved.matching_count || 0) !== 1) {
        throw new Error('お客様のLINE連携を1件に特定できません。');
      }
      const optOut = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM followup_opt_outs WHERE jos_customer_id = ?`
      ).bind(customerId).first();
      if (optOut) throw new Error('LINE配信停止中のため下書きを保存できません。');
      const existing = await env.jos_customer_db.prepare(
        `SELECT delivery_id, status
           FROM followup_deliveries
          WHERE jos_customer_id = ? AND last_visit_date = ? AND timing_group = ?`
      ).bind(customerId, lastVisitDate, timingGroup).first();
      if (existing) {
        if (existing.status === 'draft') {
          return json({ ok: true, saved: true, idempotent: true, deliveryId: existing.delivery_id });
        }
        throw new Error('同じ施術にはすでに下書きまたは送信記録があります。');
      }
      const campaignId = 'manual-followup-review-v1';
      const now = new Date().toISOString();
      const trackingToken = crypto.randomUUID().replace(/-/g, '');
      await env.jos_customer_db.batch([
        env.jos_customer_db.prepare(
          `INSERT OR IGNORE INTO followup_campaigns
             (campaign_id, campaign_name, status, message_template, created_at)
           VALUES (?, 'JOS PC 個別確認', 'draft', '', ?)`
        ).bind(campaignId, now),
        env.jos_customer_db.prepare(
          `INSERT INTO followup_deliveries
             (delivery_id, campaign_id, jos_customer_id, last_visit_date,
              timing_group, due_date, part_names_json, message_text,
              tracking_token, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
        ).bind(
          draftId, campaignId, customerId, lastVisitDate, timingGroup, dueDate,
          JSON.stringify(partNames), messageText, trackingToken, now
        )
      ]);
      return json({ ok: true, saved: true, idempotent: false, deliveryId: draftId });
    }

    if (pathname === '/api/admin/followups/drafts') {
      const result = await env.jos_customer_db.prepare(
        `SELECT delivery_id, jos_customer_id, last_visit_date, timing_group,
                due_date, part_names_json, message_text, status, attempt_count,
                created_at, approved_at, sending_started_at, sent_at,
                last_attempt_at, last_error
           FROM followup_deliveries
          WHERE status IN ('draft', 'approved', 'sending', 'sent', 'failed')
          ORDER BY created_at DESC
          LIMIT 500`
      ).all();
      return json({
        ok: true,
        readOnly: true,
        drafts: (result.results || []).map(row => {
          let partNames = [];
          try {
            const parsed = JSON.parse(row.part_names_json || '[]');
            if (Array.isArray(parsed)) partNames = parsed.map(value => normalizeText(value, 100));
          } catch (_) {
            partNames = [];
          }
          return {
            deliveryId: row.delivery_id,
            customerId: row.jos_customer_id,
            lastVisitDate: row.last_visit_date,
            timingGroup: row.timing_group,
            dueDate: row.due_date,
            partNames,
            messageText: row.message_text,
            status: row.status,
            attemptCount: Number(row.attempt_count || 0),
            createdAt: row.created_at,
            approvedAt: row.approved_at || '',
            sendingStartedAt: row.sending_started_at || '',
            sentAt: row.sent_at || '',
            lastAttemptAt: row.last_attempt_at || '',
            lastError: row.last_error || ''
          };
        })
      });
    }

    if (pathname === '/api/admin/followups/draft-approve') {
      const body = await readJson(request);
      const deliveryId = normalizeText(body.deliveryId, 80);
      const confirmation = normalizeText(body.confirmation, 100);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(deliveryId)) {
        throw new Error('承認対象の下書きIDを確認できません。');
      }
      if (confirmation !== '送信せず承認済みにする') {
        throw new Error('下書き承認の確認がありません。');
      }
      const existing = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, due_date, status
           FROM followup_deliveries WHERE delivery_id = ?`
      ).bind(deliveryId).first();
      if (!existing) throw new Error('承認対象の下書きが見つかりません。');
      if (existing.status === 'approved') {
        return json({ ok: true, approved: true, idempotent: true });
      }
      if (existing.status !== 'draft') {
        throw new Error('下書き以外の記録は承認できません。');
      }
      if (normalizeIsoDateOnly(existing.due_date) > japanDateOnly()) {
        throw new Error('まだ承認できる送信予定日ではありません。');
      }
      const approvedProfile = await env.jos_customer_db.prepare(
        `SELECT COUNT(*) AS matching_count
           FROM customer_profiles
          WHERE jos_customer_id = ? AND link_status = 'approved'`
      ).bind(existing.jos_customer_id).first();
      if (Number(approvedProfile && approvedProfile.matching_count || 0) !== 1) {
        throw new Error('お客様のLINE連携を1件に特定できません。');
      }
      const optOut = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM followup_opt_outs WHERE jos_customer_id = ?`
      ).bind(existing.jos_customer_id).first();
      if (optOut) throw new Error('LINE配信停止中のため承認できません。');
      const now = new Date().toISOString();
      await env.jos_customer_db.prepare(
        `UPDATE followup_deliveries
            SET status = 'approved', approved_at = ?, last_error = ''
          WHERE delivery_id = ? AND status = 'draft'`
      ).bind(now, deliveryId).run();
      return json({ ok: true, approved: true, idempotent: false });
    }

    if (pathname === '/api/admin/followups/single-send') {
      const body = await readJson(request);
      const deliveryId = normalizeText(body.deliveryId, 80);
      const confirmation = normalizeText(body.confirmation, 100);
      const revalidatedAtText = normalizeText(body.revalidatedAt, 40);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(deliveryId)) {
        throw new Error('送信対象の承認記録を確認できません。');
      }
      if (confirmation !== '承認済みのお客様1人へ送信') {
        throw new Error('お客様1人への送信確認がありません。');
      }
      const revalidatedAt = new Date(revalidatedAtText);
      const validationAge = Date.now() - revalidatedAt.getTime();
      if (Number.isNaN(revalidatedAt.getTime()) || validationAge < -5000 || validationAge > 60000) {
        throw new Error('JOSの送信直前確認が期限切れです。候補を更新してください。');
      }
      const delivery = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, due_date, message_text, status
           FROM followup_deliveries WHERE delivery_id = ?`
      ).bind(deliveryId).first();
      if (!delivery) throw new Error('送信対象の承認記録が見つかりません。');
      if (delivery.status === 'sent') {
        return json({ ok: true, sent: true, idempotent: true });
      }
      if (delivery.status !== 'approved') {
        throw new Error('承認済み以外の記録は送信できません。');
      }
      if (normalizeIsoDateOnly(delivery.due_date) > japanDateOnly()) {
        throw new Error('まだ送信予定日ではありません。');
      }
      const profiles = await env.jos_customer_db.prepare(
        `SELECT line_sub
           FROM customer_profiles
          WHERE jos_customer_id = ? AND link_status = 'approved'
          LIMIT 2`
      ).bind(delivery.jos_customer_id).all();
      const linkedProfiles = (profiles.results || []).filter(row => row.line_sub);
      if (linkedProfiles.length !== 1) {
        throw new Error('お客様の送信先LINEを1件に特定できません。');
      }
      const optOut = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM followup_opt_outs WHERE jos_customer_id = ?`
      ).bind(delivery.jos_customer_id).first();
      if (optOut) throw new Error('LINE配信停止中のため送信できません。');
      const cooldownSince = new Date(Date.now() - 14 * 86400000).toISOString();
      const recentSent = await env.jos_customer_db.prepare(
        `SELECT delivery_id FROM followup_deliveries
          WHERE jos_customer_id = ? AND status = 'sent' AND sent_at >= ?
          LIMIT 1`
      ).bind(delivery.jos_customer_id, cooldownSince).first();
      if (recentSent) throw new Error('最近LINEを送信しているため送信できません。');
      const now = new Date().toISOString();
      const claim = await env.jos_customer_db.prepare(
        `UPDATE followup_deliveries
            SET status = 'sending', attempt_count = attempt_count + 1,
                sending_started_at = ?, last_attempt_at = ?, last_error = ''
          WHERE delivery_id = ? AND status = 'approved'`
      ).bind(now, now, deliveryId).run();
      if (Number(claim && claim.meta && claim.meta.changes || 0) !== 1) {
        throw new Error('送信開始を安全に記録できませんでした。送信していません。');
      }
      try {
        await pushLineText(env, linkedProfiles[0].line_sub, delivery.message_text);
      } catch (error) {
        await env.jos_customer_db.prepare(
          `UPDATE followup_deliveries
              SET status = 'failed', last_error = ?
            WHERE delivery_id = ? AND status = 'sending'`
        ).bind(normalizeText(error && error.message, 500), deliveryId).run();
        throw error;
      }
      const sentAt = new Date().toISOString();
      const finalized = await env.jos_customer_db.prepare(
        `UPDATE followup_deliveries
            SET status = 'sent', sent_at = ?, last_error = ''
          WHERE delivery_id = ? AND status = 'sending'`
      ).bind(sentAt, deliveryId).run();
      if (Number(finalized && finalized.meta && finalized.meta.changes || 0) !== 1) {
        throw new Error('LINE送信後の記録を完了できませんでした。自動再送は行いません。');
      }
      return json({ ok: true, sent: true, idempotent: false, sentAt });
    }

    if (pathname === '/api/admin/followups/draft-cancel') {
      const body = await readJson(request);
      const deliveryId = normalizeText(body.deliveryId, 80);
      const confirmation = normalizeText(body.confirmation, 100);
      if (!/^[A-Za-z0-9-]{16,80}$/.test(deliveryId)) {
        throw new Error('取消対象の下書きIDを確認できません。');
      }
      if (confirmation !== '下書きを取り消す') {
        throw new Error('下書き取消の確認がありません。');
      }
      const existing = await env.jos_customer_db.prepare(
        `SELECT status FROM followup_deliveries WHERE delivery_id = ?`
      ).bind(deliveryId).first();
      if (!existing) throw new Error('取消対象の下書きが見つかりません。');
      if (existing.status === 'cancelled') {
        return json({ ok: true, cancelled: true, idempotent: true });
      }
      if (existing.status !== 'draft') {
        throw new Error('下書き以外の記録は取り消せません。');
      }
      await env.jos_customer_db.prepare(
        `UPDATE followup_deliveries
            SET status = 'cancelled', last_error = ''
          WHERE delivery_id = ? AND status = 'draft'`
      ).bind(deliveryId).run();
      return json({ ok: true, cancelled: true, idempotent: false });
    }

    if (pathname === '/api/admin/bookings/recent') {
      const result = await env.jos_customer_db.prepare(
        `SELECT request_id, customer_name, menu_names, reservation_date,
                start_time, end_time, status, final_price, created_at
           FROM customer_booking_requests
          ORDER BY created_at DESC
          LIMIT 20`
      ).all();
      return json({
        ok: true,
        requests: (result.results || []).map(row => ({
          requestId: row.request_id,
          customerName: row.customer_name || '',
          menuNames: row.menu_names || '',
          date: row.reservation_date || '',
          startTime: row.start_time || '',
          endTime: row.end_time || '',
          status: row.status || '',
          finalPrice: row.final_price === null ? null : Number(row.final_price),
          createdAt: row.created_at || ''
        }))
      });
    }

    if (pathname === '/api/admin/reservation-actions/recent') {
      const result = await env.jos_customer_db.prepare(
        `SELECT action_id, action_type, cancel_status, status,
                customer_name, original_date, original_start_time,
                original_end_time, menu_name, requested_date,
                requested_start_time, requested_end_time, created_at
           FROM customer_reservation_actions
          ORDER BY created_at DESC
          LIMIT 20`
      ).all();
      return json({
        ok: true,
        actions: (result.results || []).map(row => ({
          actionId: row.action_id,
          actionType: row.action_type || '',
          cancelStatus: row.cancel_status || '',
          status: row.status || '',
          customerName: row.customer_name || '',
          originalDate: row.original_date || '',
          originalStartTime: row.original_start_time || '',
          originalEndTime: row.original_end_time || '',
          menuName: row.menu_name || '',
          requestedDate: row.requested_date || '',
          requestedStartTime: row.requested_start_time || '',
          requestedEndTime: row.requested_end_time || '',
          createdAt: row.created_at || ''
        }))
      });
    }

    if (pathname === '/api/admin/announcements/list') {
      return json(await listCustomerAnnouncementsForAdmin(env));
    }

    if (pathname === '/api/admin/announcements/save') {
      const body = await readAnnouncementJson(request);
      return json(await saveCustomerAnnouncement(env, body));
    }

    if (pathname === '/api/admin/announcements/publish-status') {
      const body = await readJson(request);
      return json(await setCustomerAnnouncementPublished(env, body));
    }

    if (pathname === '/api/admin/announcements/delete') {
      const body = await readJson(request);
      return json(await deleteCustomerAnnouncement(env, body));
    }

    if (pathname === '/api/admin/pc-sync/start') {
      const body = await readJson(request);
      return json(await startPcSync(env, body));
    }

    if (pathname === '/api/admin/pc-sync/customers') {
      const body = await readJson(request);
      return json(await receivePcCustomerPage(env, body));
    }

    if (pathname === '/api/admin/pc-sync/metrics') {
      const body = await readJson(request);
      return json(await receivePcMetricPage(env, body));
    }

    if (pathname === '/api/admin/pc-sync/validate') {
      const body = await readJson(request);
      return json(await validatePcSync(env, body));
    }

    if (pathname === '/api/admin/pc-sync/activate') {
      const body = await readJson(request);
      return json(await activatePcSync(env, body));
    }

    if (pathname === '/api/admin/pc-sync/rollback') {
      const body = await readJson(request);
      return json(await rollbackPcSync(env, body));
    }

    if (pathname === '/api/admin/pc-sync/status') {
      return json(await getPcSyncStatus(env));
    }

    if (pathname === '/api/admin/pc-sync/expire') {
      return json(await expirePcSyncRuns(env));
    }

    if (pathname === '/api/admin/pc/snapshot-manifest') {
      return json(await getPcSnapshotManifest(env));
    }

    if (pathname === '/api/admin/pc/customers') {
      const body = await readJson(request);
      return json(await getPcAdminCustomers(env, body));
    }

    if (pathname === '/api/admin/profile-updates/pending') {
      const result = await env.jos_customer_db.prepare(
        `SELECT request_id, jos_customer_id, last_name, first_name,
                last_kana, first_kana, phone
           FROM customer_profile_update_requests
          WHERE status = 'pending'
          ORDER BY created_at ASC
          LIMIT 100`
      ).all();
      return json({
        ok: true,
        requests: (result.results || []).map(row => ({
          requestId: row.request_id,
          customerId: row.jos_customer_id,
          lastName: row.last_name,
          firstName: row.first_name,
          lastKana: row.last_kana,
          firstKana: row.first_kana,
          phone: row.phone
        }))
      });
    }

    if (pathname === '/api/admin/profile-updates/complete') {
      const body = await readJson(request);
      const requestId = normalizeText(body.requestId, 100);
      if (!requestId) throw new Error('変更申請IDがありません。');
      const row = await env.jos_customer_db.prepare(
        `SELECT line_sub, last_name, first_name, last_kana, first_kana, phone
           FROM customer_profile_update_requests
          WHERE request_id = ? AND status = 'pending'`
      ).bind(requestId).first();
      if (!row) return json({ ok: true });
      const now = new Date().toISOString();
      const accepted = body.accepted === true;
      const statements = [
        env.jos_customer_db.prepare(
          `UPDATE customer_profile_update_requests
              SET status = ?, result_message = ?, updated_at = ?
            WHERE request_id = ? AND status = 'pending'`
        ).bind(
          accepted ? 'completed' : 'rejected',
          normalizeText(body.message, 300),
          now,
          requestId
        )
      ];
      if (accepted) {
        statements.push(env.jos_customer_db.prepare(
          `UPDATE customer_profiles
              SET last_name = ?, first_name = ?, last_kana = ?,
                  first_kana = ?, phone = ?, updated_at = ?
            WHERE line_sub = ? AND link_status = 'approved'`
        ).bind(
          row.last_name,
          row.first_name,
          row.last_kana,
          row.first_kana,
          row.phone,
          now,
          row.line_sub
        ));
      }
      await env.jos_customer_db.batch(statements);
      return json({ ok: true });
    }

    if (pathname === '/api/admin/policies/controls') {
      const result = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, manual_restricted, manual_restriction_note,
                policy_reset_at
           FROM customer_booking_policy
          ORDER BY jos_customer_id ASC
          LIMIT 1000`
      ).all();
      return json({
        ok: true,
        controls: (result.results || []).map(row => ({
          customerId: row.jos_customer_id,
          manualRestricted: Number(row.manual_restricted || 0) === 1,
          manualRestrictionNote: row.manual_restriction_note || '',
          policyResetAt: row.policy_reset_at || ''
        }))
      });
    }

    if (pathname === '/api/admin/policy/get') {
      const body = await readJson(request);
      const customerId = normalizeText(body.customerId, 80);
      if (!customerId) throw new Error('顧客IDがありません。');
      const linked = await env.jos_customer_db.prepare(
        `SELECT 1 AS linked FROM customer_profiles
          WHERE jos_customer_id = ? AND link_status = 'approved'`
      ).bind(customerId).first();
      if (!linked) {
        return json({ ok: true, linked: false, policy: null });
      }
      const row = await env.jos_customer_db.prepare(
        `SELECT normal_cancel_count, same_day_count, no_show_count,
                automatic_restricted, manual_restricted,
                manual_restriction_note, policy_reset_at, synced_at
           FROM customer_booking_policy
          WHERE jos_customer_id = ?`
      ).bind(customerId).first();
      const policy = row || {};
      return json({
        ok: true,
        linked: true,
        policy: {
          normalCancelCount: Number(policy.normal_cancel_count || 0),
          sameDayCount: Number(policy.same_day_count || 0),
          noShowCount: Number(policy.no_show_count || 0),
          automaticRestricted: Number(policy.automatic_restricted || 0) === 1,
          manualRestricted: Number(policy.manual_restricted || 0) === 1,
          manualRestrictionNote: policy.manual_restriction_note || '',
          policyResetAt: policy.policy_reset_at || '',
          syncedAt: policy.synced_at || ''
        }
      });
    }

    if (pathname === '/api/admin/policy/manual-update') {
      const body = await readJson(request);
      const customerId = normalizeText(body.customerId, 80);
      const restricted = body.restricted === true;
      const note = normalizeText(body.note, 300);
      if (!customerId) throw new Error('顧客IDがありません。');
      const linked = await env.jos_customer_db.prepare(
        `SELECT 1 AS linked FROM customer_profiles
          WHERE jos_customer_id = ? AND link_status = 'approved'`
      ).bind(customerId).first();
      if (!linked) throw new Error('お客様ページと連携されていません。');
      const now = new Date().toISOString();

      if (restricted) {
        await env.jos_customer_db.prepare(
          `INSERT INTO customer_booking_policy
             (jos_customer_id, manual_restricted, manual_restriction_note, synced_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(jos_customer_id) DO UPDATE SET
             manual_restricted = 1,
             manual_restriction_note = excluded.manual_restriction_note,
             synced_at = excluded.synced_at`
        ).bind(customerId, note, now).run();
      } else {
        await env.jos_customer_db.prepare(
          `INSERT INTO customer_booking_policy
             (jos_customer_id, normal_cancel_count, same_day_count, no_show_count,
              automatic_restricted, manual_restricted, manual_restriction_note,
              policy_reset_at, synced_at)
           VALUES (?, 0, 0, 0, 0, 0, '', ?, ?)
           ON CONFLICT(jos_customer_id) DO UPDATE SET
             normal_cancel_count = 0,
             same_day_count = 0,
             no_show_count = 0,
             automatic_restricted = 0,
             manual_restricted = 0,
             manual_restriction_note = '',
             policy_reset_at = excluded.policy_reset_at,
             synced_at = excluded.synced_at`
        ).bind(customerId, now, now).run();
      }
      return json({ ok: true, restricted, resetAt: restricted ? '' : now });
    }

    if (pathname === '/api/admin/pending') {
      const result = await env.jos_customer_db.prepare(
        `SELECT approval_key, line_display_name, last_name, first_name,
                last_kana, first_kana, phone, registration_type,
                customer_type, birthday, created_at, updated_at
           FROM customer_profiles
          WHERE link_status = 'pending'
          ORDER BY created_at ASC
          LIMIT 100`
      ).all();

      return json({
        ok: true,
        profiles: (result.results || []).map(row => ({
          approvalKey: row.approval_key,
          lineDisplayName: row.line_display_name,
          lastName: row.last_name,
          firstName: row.first_name,
          lastKana: row.last_kana,
          firstKana: row.first_kana,
          phone: row.phone,
          registrationType: row.registration_type || 'existing',
          customerType: row.customer_type || '',
          birthday: row.birthday || '',
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      });
    }

    if (pathname === '/api/admin/followups/safety-state') {
      const approved = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id
           FROM customer_profiles
          WHERE link_status = 'approved' AND jos_customer_id IS NOT NULL
          ORDER BY approved_at ASC
          LIMIT 1000`
      ).all();
      const optOuts = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id
           FROM followup_opt_outs
          ORDER BY updated_at DESC
          LIMIT 1000`
      ).all();
      const deliveries = await env.jos_customer_db.prepare(
        `SELECT delivery_id, jos_customer_id, last_visit_date, timing_group,
                due_date, sent_at, status
           FROM followup_deliveries
          WHERE status IN ('draft', 'approved', 'sending', 'sent', 'failed')
          ORDER BY created_at DESC
          LIMIT 5000`
      ).all();
      return json({
        ok: true,
        readOnly: true,
        approvedProfiles: (approved.results || []).map(row => ({
          customerId: row.jos_customer_id
        })),
        optOutCustomerIds: (optOuts.results || []).map(row => row.jos_customer_id),
        deliveries: (deliveries.results || []).map(row => ({
          deliveryId: row.delivery_id,
          customerId: row.jos_customer_id,
          lastVisitDate: row.last_visit_date,
          timingGroup: row.timing_group,
          dueDate: row.due_date,
          sentAt: row.sent_at || '',
          status: row.status
        }))
      });
    }

    if (pathname === '/api/admin/approved') {
      const result = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, last_name, first_name
           FROM customer_profiles
          WHERE link_status = 'approved' AND jos_customer_id IS NOT NULL
          ORDER BY approved_at ASC
          LIMIT 1000`
      ).all();
      return json({
        ok: true,
        profiles: (result.results || []).map(row => ({
          customerId: row.jos_customer_id,
          registeredCustomerName: `${row.last_name || ''} ${row.first_name || ''}`.trim()
        }))
      });
    }

    if (pathname === '/api/admin/reservations/sync') {
      const body = await readJson(request);
      const customerIds = Array.isArray(body.customerIds) ? body.customerIds.slice(0, 1000) : [];
      const reservations = Array.isArray(body.reservations) ? body.reservations.slice(0, 1000) : [];
      const allowed = new Set(customerIds.map(value => normalizeText(value, 80)).filter(Boolean));
      const now = new Date().toISOString();
      const statements = [env.jos_customer_db.prepare('DELETE FROM customer_next_reservations')];

      reservations.forEach(item => {
        const customerId = normalizeText(item.customerId, 80);
        if (!customerId || !allowed.has(customerId)) return;
        statements.push(env.jos_customer_db.prepare(
          `INSERT INTO customer_next_reservations
             (jos_customer_id, reservation_id, reservation_date, start_time,
              end_time, menu_name, price, reservation_status, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          customerId,
          normalizeText(item.reservationId, 80),
          normalizeText(item.date, 20),
          normalizeText(item.startTime, 10),
          normalizeText(item.endTime, 10),
          normalizeText(item.menu, 300),
          Number(item.price || 0),
          normalizeText(item.status, 40),
          now
        ));
      });
      await env.jos_customer_db.batch(statements);
      return json({ ok: true, reservationCount: statements.length - 1 });
    }

    if (pathname === '/api/admin/policies/sync') {
      const body = await readJson(request);
      const policies = Array.isArray(body.policies) ? body.policies.slice(0, 1000) : [];
      const now = new Date().toISOString();
      const statements = [];
      policies.forEach(item => {
        const customerId = normalizeText(item.customerId, 80);
        if (!customerId) return;
        statements.push(env.jos_customer_db.prepare(
          `INSERT INTO customer_booking_policy
             (jos_customer_id, normal_cancel_count, same_day_count,
              no_show_count, automatic_restricted, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(jos_customer_id) DO UPDATE SET
             normal_cancel_count = excluded.normal_cancel_count,
             same_day_count = excluded.same_day_count,
             no_show_count = excluded.no_show_count,
             automatic_restricted = excluded.automatic_restricted,
             synced_at = excluded.synced_at`
        ).bind(
          customerId,
          Math.max(0, Number(item.normalCancelCount || 0)),
          Math.max(0, Number(item.sameDayCount || 0)),
          Math.max(0, Number(item.noShowCount || 0)),
          item.automaticRestricted === true ? 1 : 0,
          now
        ));
      });
      if (statements.length) await env.jos_customer_db.batch(statements);
      return json({ ok: true, policyCount: statements.length });
    }

    if (pathname === '/api/admin/menus/sync') {
      const body = await readJson(request);
      const menus = Array.isArray(body.menus) ? body.menus.slice(0, 1000) : [];
      const now = new Date().toISOString();
      const statements = [env.jos_customer_db.prepare('DELETE FROM menu_catalog')];

      menus.forEach((item, index) => {
        const menuId = normalizeText(item.menuId, 80);
        const menuName = normalizeText(item.menuName, 200);
        if (!menuId || !menuName) return;
        statements.push(env.jos_customer_db.prepare(
          `INSERT INTO menu_catalog
             (menu_id, menu_name, category, normal_price, student_price,
              treatment_time, sort_order, is_active, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          menuId,
          menuName,
          normalizeText(item.category, 120),
          Math.max(0, Math.round(Number(item.normalPrice || 0))),
          Math.max(0, Math.round(Number(item.studentPrice || 0))),
          Math.max(0, Math.round(Number(item.treatmentTime || 0))),
          Math.round(Number(item.sortOrder || index + 1)),
          item.isActive === false ? 0 : 1,
          now
        ));
      });

      await env.jos_customer_db.batch(statements);
      return json({ ok: true, menuCount: statements.length - 1 });
    }

    if (pathname === '/api/admin/availability/sync') {
      const body = await readJson(request);
      const busy = Array.isArray(body.busy) ? body.busy.slice(0, 5000) : [];
      const now = new Date().toISOString();
      const statements = [env.jos_customer_db.prepare('DELETE FROM availability_busy')];

      busy.forEach((item, index) => {
        const date = normalizeText(item.date, 10);
        const startTime = normalizeText(item.startTime, 5);
        const endTime = normalizeText(item.endTime, 5);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            !/^\d{2}:\d{2}$/.test(startTime) ||
            !/^\d{2}:\d{2}$/.test(endTime) ||
            endTime <= startTime) return;
        statements.push(env.jos_customer_db.prepare(
          `INSERT INTO availability_busy
             (busy_id, busy_date, start_time, end_time, busy_type, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          normalizeText(item.busyId, 100) || `${date}-${startTime}-${endTime}-${index}`,
          date,
          startTime,
          endTime,
          normalizeText(item.busyType, 30) || 'reservation',
          now
        ));
      });

      await env.jos_customer_db.batch(statements);
      return json({ ok: true, busyCount: statements.length - 1 });
    }

    if (pathname === '/api/admin/bookings/pending') {
      const result = await env.jos_customer_db.prepare(
        `SELECT request_id, jos_customer_id, customer_name, menu_ids,
                reservation_date, start_time, end_time, treatment_time, created_at
           FROM customer_booking_requests
          WHERE status = 'pending'
          ORDER BY created_at ASC LIMIT 100`
      ).all();
      return json({
        ok: true,
        requests: (result.results || []).map(row => ({
          requestId: row.request_id,
          customerId: row.jos_customer_id,
          customerName: row.customer_name,
          menuIds: String(row.menu_ids || '').split(',').filter(Boolean),
          date: row.reservation_date,
          startTime: row.start_time,
          endTime: row.end_time,
          treatmentTime: Number(row.treatment_time || 0),
          createdAt: row.created_at
        }))
      });
    }

    if (pathname === '/api/admin/bookings/complete') {
      const body = await readJson(request);
      const requestId = normalizeText(body.requestId, 100);
      const accepted = body.accepted === true;
      if (!requestId) throw new Error('予約リクエストIDがありません。');
      const now = new Date().toISOString();
      const result = await env.jos_customer_db.prepare(
        `UPDATE customer_booking_requests
            SET status = ?, reservation_id = ?, final_price = ?,
                result_message = ?, updated_at = ?
          WHERE request_id = ? AND status = 'pending'`
      ).bind(
        accepted ? 'confirmed' : 'rejected',
        normalizeText(body.reservationId, 100),
        accepted ? Math.max(0, Math.round(Number(body.finalPrice || 0))) : null,
        normalizeText(body.message, 500),
        now,
        requestId
      ).run();
      return json({ ok: true, updated: Number(result.meta && result.meta.changes || 0) });
    }

    if (pathname === '/api/admin/approve') {
      const body = await readJson(request);
      const approvalKey = normalizeText(body.approvalKey, 80);
      const customerId = normalizeText(body.customerId, 80);
      if (!approvalKey || !customerId) throw new Error('連携対象が正しくありません。');

      const target = await env.jos_customer_db.prepare(
        `SELECT line_sub, line_display_name, last_name, first_name, last_kana,
                first_kana, phone, registration_type
           FROM customer_profiles
          WHERE approval_key = ? AND link_status = 'pending'`
      ).bind(approvalKey).first();
      const now = new Date().toISOString();
      const result = await env.jos_customer_db.prepare(
        `UPDATE customer_profiles
            SET link_status = 'approved', jos_customer_id = ?,
                approved_at = ?, updated_at = ?
          WHERE approval_key = ? AND link_status = 'pending'`
      ).bind(customerId, now, now, approvalKey).run();

      if (!result.meta || Number(result.meta.changes || 0) !== 1) {
        return json({ ok: false, message: '対象が見つからないか、すでに連携済みです。' }, 409);
      }
      // 承認操作の完了通知は送らない。申請通知はお客様の登録時点で送信済み。
      return json({ ok: true });
    }

    if (pathname === '/api/admin/reservation-actions/pending') {
      const result = await env.jos_customer_db.prepare(
        `SELECT action_id, reservation_id, action_type, cancel_status,
                requested_date, requested_start_time, requested_end_time
           FROM customer_reservation_actions
          WHERE status = 'pending'
          ORDER BY created_at ASC LIMIT 100`
      ).all();
      return json({
        ok: true,
        actions: (result.results || []).map(row => ({
          actionId: row.action_id,
          reservationId: row.reservation_id,
          actionType: row.action_type,
          cancelStatus: row.cancel_status,
          requestedDate: row.requested_date,
          requestedStartTime: row.requested_start_time,
          requestedEndTime: row.requested_end_time
        }))
      });
    }

    if (pathname === '/api/admin/reservation-actions/complete') {
      const body = await readJson(request);
      const actionId = normalizeText(body.actionId, 100);
      if (!actionId) throw new Error('操作IDがありません。');
      await env.jos_customer_db.prepare(
        `UPDATE customer_reservation_actions
            SET status = ?, result_message = ?, updated_at = ?
          WHERE action_id = ? AND status = 'pending'`
      ).bind(
        body.accepted === true ? 'completed' : 'rejected',
        normalizeText(body.message, 300),
        new Date().toISOString(),
        actionId
      ).run();
      return json({ ok: true });
    }

    return json({ ok: false, message: '管理APIが見つかりません。' }, 404);
  } catch (error) {
    return json({
      ok: false,
      errorCode: error && error.code ? String(error.code) : 'request_failed',
      message: String(error && error.message ? error.message : '処理に失敗しました。')
    }, 400);
  }
}

async function api(request, env, pathname) {
  if (request.method !== 'POST') return json({ ok: false, message: 'POSTのみ利用できます。' }, 405);
  if (!checkSameOrigin(request)) return json({ ok: false, message: '許可されていない接続元です。' }, 403);

  try {
    const body = await readJson(request);
    const identity = await verifyLineIdToken(body.idToken);

    if (pathname === '/api/verify-line') {
      return json({ ok: true, displayName: identity.displayName, verifiedAt: new Date().toISOString() });
    }
    if (pathname === '/api/profile') return getProfile(env, identity);
    if (pathname === '/api/announcements') {
      return json(await getCustomerAnnouncements(env));
    }
    if (pathname === '/api/profile/save') return saveProfile(env, identity, body.profile || {});
    if (pathname === '/api/profile/update/status') {
      const requestId = normalizeText(body.requestId, 100);
      const row = await env.jos_customer_db.prepare(
        `SELECT status, result_message
           FROM customer_profile_update_requests
          WHERE request_id = ? AND line_sub = ?`
      ).bind(requestId, identity.sub).first();
      if (!row) throw new Error('変更状況を確認できませんでした。');
      return json({
        ok: true,
        update: {
          status: row.status,
          message: row.result_message || ''
        }
      });
    }
    if (pathname === '/api/next-reservation') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }
      const result = await env.jos_customer_db.prepare(
        `SELECT reservation_id, reservation_date, start_time, end_time,
                menu_name, price, reservation_status
           FROM customer_next_reservations
          WHERE jos_customer_id = ?`
          + ` ORDER BY reservation_date ASC, start_time ASC`
      ).bind(profile.jos_customer_id).all();
      const reservations = (result.results || []).map(publicReservation);
      return json({
        ok: true,
        reservation: reservations[0] || null,
        reservations
      });
    }
    if (pathname === '/api/booking-policy') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }
      const row = await env.jos_customer_db.prepare(
        `SELECT normal_cancel_count, same_day_count, no_show_count,
                automatic_restricted, manual_restricted
           FROM customer_booking_policy WHERE jos_customer_id = ?`
      ).bind(profile.jos_customer_id).first();
      const policy = row || {};
      const sameDayCount = Number(policy.same_day_count || 0);
      const noShowCount = Number(policy.no_show_count || 0);
      const restricted = Number(policy.automatic_restricted || 0) === 1 ||
        Number(policy.manual_restricted || 0) === 1;
      return json({
        ok: true,
        policy: {
          normalCancelCount: Number(policy.normal_cancel_count || 0),
          sameDayCount,
          noShowCount,
          restricted,
          warning: !restricted && (sameDayCount === 2 || noShowCount === 1)
        }
      });
    }
    if (pathname === '/api/menus') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();

      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }

      const result = await env.jos_customer_db.prepare(
        `SELECT menu_id, menu_name, category, normal_price, student_price, treatment_time
           FROM menu_catalog WHERE is_active = 1
          ORDER BY sort_order ASC, menu_name ASC`
      ).all();

      return json({
        ok: true,
        menus: (result.results || []).map((row) => ({
          menuId: row.menu_id,
          menuName: row.menu_name,
          category: row.category,
          normalPrice: Number(row.normal_price || 0),
          studentPrice: Number(row.student_price || 0),
          treatmentTime: Number(row.treatment_time || 0)
        }))
      });
    }
    if (pathname === '/api/availability') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, registration_type FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }

      const date = validateCustomerBookingDate(body.date);
      const menuIds = Array.isArray(body.menuIds)
        ? [...new Set(body.menuIds.map(value => normalizeText(value, 80)).filter(Boolean))].slice(0, 30)
        : [];
      if (!menuIds.length) throw new Error('メニューを選択してください。');
      const placeholders = menuIds.map(() => '?').join(',');
      const menuResult = await env.jos_customer_db.prepare(
        `SELECT treatment_time FROM menu_catalog
          WHERE is_active = 1 AND menu_id IN (${placeholders})`
      ).bind(...menuIds).all();
      const menus = menuResult.results || [];
      if (menus.length !== menuIds.length) {
        throw new Error('選択されたメニューを確認できませんでした。');
      }
      const menuMinutes = menus.reduce(
        (sum, menu) => sum + Number(menu.treatment_time || 0), 0
      );
      const needsInitialCounseling = await customerNeedsInitialCounseling(env, profile);
      const firstVisitMinutes = needsInitialCounseling ? 15 : 0;
      const treatmentMinutes = menuMinutes + firstVisitMinutes;
      if (treatmentMinutes <= 0 || treatmentMinutes > 780) {
        throw new Error('予約枠時間を確認できませんでした。');
      }

      const result = await env.jos_customer_db.prepare(
        `SELECT start_time, end_time FROM availability_busy
          WHERE busy_date = ?
          UNION ALL
         SELECT start_time, end_time FROM customer_booking_requests
          WHERE reservation_date = ? AND status = 'pending'
          ORDER BY start_time ASC`
      ).bind(date, date).all();
      const toMinutes = value => {
        const parts = String(value || '').split(':');
        return Number(parts[0]) * 60 + Number(parts[1]);
      };
      const busy = (result.results || []).map(row => ({
        start: toMinutes(row.start_time),
        end: toMinutes(row.end_time)
      }));
      const slots = [];
      const leadMinutes = await getBookingLeadMinutes(env);
      const nowMs = Date.now();
      for (let start = 10 * 60; start + treatmentMinutes <= 23 * 60; start += 30) {
        const end = start + treatmentMinutes;
        const slotTime = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
        const isClosed = isInsideBookingLeadTime(date, slotTime, leadMinutes, nowMs);
        if (!isClosed && !busy.some(item => start < item.end && end > item.start)) {
          slots.push(slotTime);
        }
      }
      return json({ ok: true, date, treatmentMinutes, leadMinutes, slots });
    }

    if (pathname === '/api/booking/request') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, last_name, first_name, customer_type, registration_type
           FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }
      if (body.policyAccepted !== true) {
        return json({ ok: false, message: '予約規定への同意が必要です。' }, 400);
      }
      const policy = await env.jos_customer_db.prepare(
        `SELECT automatic_restricted, manual_restricted
           FROM customer_booking_policy WHERE jos_customer_id = ?`
      ).bind(profile.jos_customer_id).first();
      if (policy && (
        Number(policy.automatic_restricted || 0) === 1 ||
        Number(policy.manual_restricted || 0) === 1
      )) {
        return json({
          ok: false,
          message: '現在オンライン予約をご利用いただけません。店舗へお問い合わせください。'
        }, 403);
      }
      const menuIds = Array.isArray(body.menuIds)
        ? [...new Set(body.menuIds.map(value => normalizeText(value, 80)).filter(Boolean))].slice(0, 30)
        : [];
      const date = validateCustomerBookingDate(body.date);
      const startTime = normalizeText(body.startTime, 5);
      if (!menuIds.length) throw new Error('メニューを選択してください。');
      if (!/^\d{2}:\d{2}$/.test(startTime)) throw new Error('開始時間が正しくありません。');

      const placeholders = menuIds.map(() => '?').join(',');
      const menuResult = await env.jos_customer_db.prepare(
        `SELECT menu_id, menu_name, normal_price, student_price, treatment_time
           FROM menu_catalog
          WHERE is_active = 1 AND menu_id IN (${placeholders})`
      ).bind(...menuIds).all();
      const menus = menuResult.results || [];
      if (menus.length !== menuIds.length) throw new Error('選択されたメニューを確認できませんでした。');

      const menuTreatmentTime = menus.reduce(
        (sum, menu) => sum + Number(menu.treatment_time || 0), 0
      );
      const needsInitialCounseling = await customerNeedsInitialCounseling(env, profile);
      const firstVisitMinutes = needsInitialCounseling ? 15 : 0;
      const treatmentTime = menuTreatmentTime + firstVisitMinutes;
      const normalTotal = menus.reduce((sum, menu) => sum + Number(menu.normal_price || 0), 0);
      const studentTotal = menus.reduce((sum, menu) => sum + Number(menu.student_price || menu.normal_price || 0), 0);
      const toMinutes = value => {
        const parts = String(value || '').split(':');
        return Number(parts[0]) * 60 + Number(parts[1]);
      };
      const start = toMinutes(startTime);
      const end = start + treatmentTime;
      if (treatmentTime <= 0 || start < 10 * 60 || end > 23 * 60 || start % 30 !== 0) {
        throw new Error('選択された予約時間を確認できませんでした。');
      }
      const leadMinutes = await getBookingLeadMinutes(env);
      if (isInsideBookingLeadTime(date, startTime, leadMinutes)) {
        throw new Error(`この時間の受付は予約開始の${leadMinutes}分前で終了しました。`);
      }
      const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
      const requestId = crypto.randomUUID().replace(/-/g, '');
      const now = new Date().toISOString();
      const customerName = `${normalizeText(profile.last_name, 40)} ${normalizeText(profile.first_name, 40)}`.trim();
      const insert = await env.jos_customer_db.prepare(
        `INSERT INTO customer_booking_requests
           (request_id, line_sub, jos_customer_id, customer_name, menu_ids,
            menu_names, reservation_date, start_time, end_time, treatment_time,
            normal_total, student_total, status, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM availability_busy
             WHERE busy_date = ? AND ? < end_time AND ? > start_time
          )
            AND NOT EXISTS (
            SELECT 1 FROM customer_booking_requests
             WHERE reservation_date = ? AND status IN ('pending', 'confirmed')
               AND ? < end_time AND ? > start_time
          )`
      ).bind(
        requestId,
        identity.sub,
        profile.jos_customer_id,
        customerName,
        menuIds.join(','),
        menus.map(menu => menu.menu_name).join('、'),
        date,
        startTime,
        endTime,
        treatmentTime,
        normalTotal,
        studentTotal,
        now,
        now,
        date,
        startTime,
        endTime,
        date,
        startTime,
        endTime
      ).run();
      if (!insert.meta || Number(insert.meta.changes || 0) !== 1) {
        return json({ ok: false, message: '選択中に予約が入りました。別の時間を選択してください。' }, 409);
      }
      await notifyStoreOfBooking(env, {
        requestId,
        customerName,
        menuNames: menus.map(menu => menu.menu_name).join('、'),
        date,
        startTime,
        endTime,
        price: profile.customer_type === '学生' ? studentTotal : normalTotal
      });
      return json({ ok: true, requestId, status: 'pending' });
    }

    if (pathname === '/api/booking/status') {
      const requestId = normalizeText(body.requestId, 100);
      const row = await env.jos_customer_db.prepare(
        `SELECT status, reservation_id, final_price, result_message,
                reservation_date, start_time, end_time, menu_names
           FROM customer_booking_requests
          WHERE request_id = ? AND line_sub = ?`
      ).bind(requestId, identity.sub).first();
      if (!row) throw new Error('予約状況を確認できませんでした。');
      return json({
        ok: true,
        booking: {
          status: row.status,
          reservationId: row.reservation_id,
          finalPrice: row.final_price === null ? null : Number(row.final_price),
          message: row.result_message,
          date: row.reservation_date,
          startTime: row.start_time,
          endTime: row.end_time,
          menuNames: row.menu_names
        }
      });
    }

    if (pathname === '/api/reservation/change/availability') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }
      const reservationId = normalizeText(body.reservationId, 80);
      const date = validateCustomerBookingDate(body.date);
      const reservation = await env.jos_customer_db.prepare(
        `SELECT reservation_date, start_time, end_time FROM customer_next_reservations
          WHERE jos_customer_id = ? AND reservation_id = ?`
      ).bind(profile.jos_customer_id, reservationId).first();
      if (!reservation) throw new Error('対象の予約を確認できませんでした。');

      const toMinutes = value => {
        const parts = String(value || '').split(':');
        return Number(parts[0]) * 60 + Number(parts[1]);
      };
      const treatmentMinutes = toMinutes(reservation.end_time) - toMinutes(reservation.start_time);
      if (treatmentMinutes <= 0) throw new Error('予約枠時間を確認できませんでした。');
      const busyResult = await env.jos_customer_db.prepare(
        `SELECT start_time, end_time FROM availability_busy
          WHERE busy_date = ? AND busy_id <> ?
          UNION ALL
         SELECT start_time, end_time FROM customer_booking_requests
          WHERE reservation_date = ? AND status = 'pending'
          UNION ALL
         SELECT requested_start_time AS start_time, requested_end_time AS end_time
           FROM customer_reservation_actions
          WHERE requested_date = ? AND action_type = 'change' AND status = 'pending'
            AND reservation_id <> ?
          ORDER BY start_time ASC`
      ).bind(date, `R-${reservationId}`, date, date, reservationId).all();
      const busy = (busyResult.results || []).map(row => ({
        start: toMinutes(row.start_time),
        end: toMinutes(row.end_time)
      }));
      const slots = [];
      const leadMinutes = await getBookingLeadMinutes(env);
      const nowMs = Date.now();
      for (let start = 10 * 60; start + treatmentMinutes <= 23 * 60; start += 30) {
        const end = start + treatmentMinutes;
        const slotTime = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
        const isClosed = isInsideBookingLeadTime(date, slotTime, leadMinutes, nowMs);
        const isCurrent = date === reservation.reservation_date &&
          slotTime === reservation.start_time;
        if (!isClosed && !isCurrent && !busy.some(item => start < item.end && end > item.start)) {
          slots.push(slotTime);
        }
      }
      return json({ ok: true, date, treatmentMinutes, leadMinutes, slots });
    }

    if (pathname === '/api/reservation/change/request') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, last_name, first_name FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }
      const policy = await env.jos_customer_db.prepare(
        `SELECT automatic_restricted, manual_restricted
           FROM customer_booking_policy WHERE jos_customer_id = ?`
      ).bind(profile.jos_customer_id).first();
      if (policy && (
        Number(policy.automatic_restricted || 0) === 1 ||
        Number(policy.manual_restricted || 0) === 1
      )) {
        return json({
          ok: false,
          message: '現在オンラインでの予約変更をご利用いただけません。店舗へお問い合わせください。'
        }, 403);
      }

      const reservationId = normalizeText(body.reservationId, 80);
      const date = validateCustomerBookingDate(body.date);
      const startTime = normalizeText(body.startTime, 5);
      if (!/^\d{2}:\d{2}$/.test(startTime)) throw new Error('開始時間が正しくありません。');
      const reservation = await env.jos_customer_db.prepare(
        `SELECT reservation_date, start_time, end_time, menu_name
           FROM customer_next_reservations
          WHERE jos_customer_id = ? AND reservation_id = ?`
      ).bind(profile.jos_customer_id, reservationId).first();
      if (!reservation) throw new Error('対象の予約を確認できませんでした。');
      if (reservation.reservation_date === date && reservation.start_time === startTime) {
        throw new Error('現在と異なる日時を選択してください。');
      }
      const toMinutes = value => {
        const parts = String(value || '').split(':');
        return Number(parts[0]) * 60 + Number(parts[1]);
      };
      const treatmentMinutes = toMinutes(reservation.end_time) - toMinutes(reservation.start_time);
      const start = toMinutes(startTime);
      const end = start + treatmentMinutes;
      if (treatmentMinutes <= 0 || start < 10 * 60 || end > 23 * 60 || start % 30 !== 0) {
        throw new Error('変更後の時間を確認できませんでした。');
      }
      const leadMinutes = await getBookingLeadMinutes(env);
      if (isInsideBookingLeadTime(date, startTime, leadMinutes)) {
        throw new Error(`この時間への変更受付は予約開始の${leadMinutes}分前で終了しました。`);
      }
      const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
      const actionId = crypto.randomUUID().replace(/-/g, '');
      const now = new Date().toISOString();
      const insert = await env.jos_customer_db.prepare(
          `INSERT INTO customer_reservation_actions
           (action_id, line_sub, jos_customer_id, reservation_id,
            action_type, cancel_status, status, created_at, updated_at,
            requested_date, requested_start_time, requested_end_time,
            customer_name, original_date, original_start_time,
            original_end_time, menu_name)
         SELECT ?, ?, ?, ?, 'change', '', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM availability_busy
             WHERE busy_date = ? AND busy_id <> ?
               AND ? < end_time AND ? > start_time
          )
            AND NOT EXISTS (
            SELECT 1 FROM customer_booking_requests
             WHERE reservation_date = ? AND status = 'pending'
               AND ? < end_time AND ? > start_time
          )
            AND NOT EXISTS (
            SELECT 1 FROM customer_reservation_actions
             WHERE requested_date = ? AND action_type = 'change' AND status = 'pending'
               AND reservation_id <> ?
               AND ? < requested_end_time AND ? > requested_start_time
          )`
      ).bind(
        actionId, identity.sub, profile.jos_customer_id, reservationId,
        now, now, date, startTime, endTime,
        `${profile.last_name || ''} ${profile.first_name || ''}`.trim(),
        reservation.reservation_date, reservation.start_time,
        reservation.end_time, reservation.menu_name || '',
        date, `R-${reservationId}`, startTime, endTime,
        date, startTime, endTime,
        date, reservationId, startTime, endTime
      ).run();
      if (!insert.meta || Number(insert.meta.changes || 0) !== 1) {
        return json({ ok: false, message: '選択中に予約が入りました。別の時間を選択してください。' }, 409);
      }
      await notifyStoreOfReservationAction(env, {
        actionType: 'change',
        customerName: `${profile.last_name || ''} ${profile.first_name || ''}`.trim(),
        originalDate: reservation.reservation_date,
        originalStartTime: reservation.start_time,
        originalEndTime: reservation.end_time,
        requestedDate: date,
        requestedStartTime: startTime,
        requestedEndTime: endTime,
        menuName: reservation.menu_name || ''
      });
      return json({ ok: true, actionId, status: 'pending' });
    }

    if (pathname === '/api/reservation/cancel/request') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, last_name, first_name FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }
      const reservationId = normalizeText(body.reservationId, 80);
      const reservation = await env.jos_customer_db.prepare(
        `SELECT reservation_date, start_time, end_time, menu_name
           FROM customer_next_reservations
          WHERE jos_customer_id = ? AND reservation_id = ?`
      ).bind(profile.jos_customer_id, reservationId).first();
      if (!reservation) throw new Error('対象の予約を確認できませんでした。');

      const tokyoToday = new Date(Date.now() + 9 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const cancelStatus = reservation.reservation_date === tokyoToday
        ? '当日キャンセル' : 'キャンセル';
      const actionId = crypto.randomUUID().replace(/-/g, '');
      const now = new Date().toISOString();
      try {
        await env.jos_customer_db.prepare(
          `INSERT INTO customer_reservation_actions
             (action_id, line_sub, jos_customer_id, reservation_id,
              action_type, cancel_status, status, created_at, updated_at,
              customer_name, original_date, original_start_time,
              original_end_time, menu_name)
           VALUES (?, ?, ?, ?, 'cancel', ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          actionId, identity.sub, profile.jos_customer_id,
          reservationId, cancelStatus, now, now,
          `${profile.last_name || ''} ${profile.first_name || ''}`.trim(),
          reservation.reservation_date, reservation.start_time,
          reservation.end_time, reservation.menu_name || ''
        ).run();
      } catch (_) {
        return json({ ok: false, message: 'この予約のキャンセル処理を受付済みです。' }, 409);
      }
      await notifyStoreOfReservationAction(env, {
        actionType: 'cancel',
        cancelStatus,
        customerName: `${profile.last_name || ''} ${profile.first_name || ''}`.trim(),
        originalDate: reservation.reservation_date,
        originalStartTime: reservation.start_time,
        originalEndTime: reservation.end_time,
        menuName: reservation.menu_name || ''
      });
      return json({ ok: true, actionId, cancelStatus, status: 'pending' });
    }

    if (pathname === '/api/reservation/action/status') {
      const actionId = normalizeText(body.actionId, 100);
      const row = await env.jos_customer_db.prepare(
        `SELECT status, result_message, action_type, cancel_status,
                requested_date, requested_start_time, requested_end_time
           FROM customer_reservation_actions
          WHERE action_id = ? AND line_sub = ?`
      ).bind(actionId, identity.sub).first();
      if (!row) throw new Error('キャンセル状況を確認できませんでした。');
      return json({
        ok: true,
        action: {
          status: row.status,
          message: row.result_message,
          actionType: row.action_type,
          cancelStatus: row.cancel_status,
          requestedDate: row.requested_date,
          requestedStartTime: row.requested_start_time,
          requestedEndTime: row.requested_end_time
        }
      });
    }

    return json({ ok: false, message: 'APIが見つかりません。' }, 404);
  } catch (error) {
    return json({ ok: false, message: String(error && error.message ? error.message : '処理に失敗しました。') }, 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/webhook/line') return lineWebhook(request, env);
    if (url.pathname.startsWith('/api/announcement-image/')) {
      return getAnnouncementImage(request, env, url.pathname);
    }
    if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url.pathname);
    if (url.pathname.startsWith('/api/')) return api(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  }
};
