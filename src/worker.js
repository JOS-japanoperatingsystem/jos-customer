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

function validateProfile(input) {
  const profile = {
    lastName: normalizeText(input.lastName, 40),
    firstName: normalizeText(input.firstName, 40),
    lastKana: normalizeText(input.lastKana, 40),
    firstKana: normalizeText(input.firstKana, 40),
    phone: String(input.phone || '').replace(/[^0-9]/g, '')
  };

  if (!profile.lastName || !profile.firstName) throw new Error('姓と名を入力してください。');
  if (!profile.lastKana || !profile.firstKana) throw new Error('セイとメイを入力してください。');
  const kana = profile.lastKana + profile.firstKana;
  if (!/^[ァ-ヶー・\s]+$/.test(kana)) throw new Error('フリガナはカタカナで入力してください。');
  if (!/^0\d{9,10}$/.test(profile.phone)) throw new Error('電話番号を正しく入力してください。');
  return profile;
}

function publicProfile(row) {
  if (!row) return null;
  return {
    lastName: row.last_name,
    firstName: row.first_name,
    lastKana: row.last_kana,
    firstKana: row.first_kana,
    phone: row.phone,
    linkStatus: row.link_status
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
            link_status, jos_customer_id
       FROM customer_profiles
      WHERE line_sub = ?`
  ).bind(identity.sub).first();
  return json({ ok: true, exists: Boolean(row), profile: publicProfile(row) });
}

async function saveProfile(env, identity, input) {
  const profile = validateProfile(input);
  const now = new Date().toISOString();
  const existing = await env.jos_customer_db.prepare(
    'SELECT link_status FROM customer_profiles WHERE line_sub = ?'
  ).bind(identity.sub).first();

  if (existing && existing.link_status === 'approved') {
    return json({ ok: false, message: '連携済みの情報変更は次の開発段階で対応します。' }, 409);
  }

  const approvalKey = crypto.randomUUID().replace(/-/g, '');

  await env.jos_customer_db.prepare(
    `INSERT INTO customer_profiles
       (line_sub, line_display_name, last_name, first_name, last_kana,
        first_kana, phone, link_status, approval_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(line_sub) DO UPDATE SET
       line_display_name = excluded.line_display_name,
       last_name = excluded.last_name,
       first_name = excluded.first_name,
       last_kana = excluded.last_kana,
       first_kana = excluded.first_kana,
       phone = excluded.phone,
       updated_at = excluded.updated_at`
  ).bind(
    identity.sub,
    identity.displayName,
    profile.lastName,
    profile.firstName,
    profile.lastKana,
    profile.firstKana,
    profile.phone,
    approvalKey,
    now,
    now
  ).run();

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
    if (pathname === '/api/admin/pending') {
      const result = await env.jos_customer_db.prepare(
        `SELECT approval_key, line_display_name, last_name, first_name,
                last_kana, first_kana, phone, created_at, updated_at
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
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }))
      });
    }

    if (pathname === '/api/admin/approved') {
      const result = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id
           FROM customer_profiles
          WHERE link_status = 'approved' AND jos_customer_id IS NOT NULL
          ORDER BY approved_at ASC
          LIMIT 1000`
      ).all();
      return json({
        ok: true,
        profiles: (result.results || []).map(row => ({ customerId: row.jos_customer_id }))
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

    if (pathname === '/api/admin/approve') {
      const body = await readJson(request);
      const approvalKey = normalizeText(body.approvalKey, 80);
      const customerId = normalizeText(body.customerId, 80);
      if (!approvalKey || !customerId) throw new Error('連携対象が正しくありません。');

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
      return json({ ok: true });
    }

    return json({ ok: false, message: '管理APIが見つかりません。' }, 404);
  } catch (error) {
    return json({ ok: false, message: String(error && error.message ? error.message : '処理に失敗しました。') }, 400);
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
    if (pathname === '/api/profile/save') return saveProfile(env, identity, body.profile || {});
    if (pathname === '/api/next-reservation') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }
      const row = await env.jos_customer_db.prepare(
        `SELECT reservation_id, reservation_date, start_time, end_time,
                menu_name, price, reservation_status
           FROM customer_next_reservations
          WHERE jos_customer_id = ?`
      ).bind(profile.jos_customer_id).first();
      return json({ ok: true, reservation: publicReservation(row) });
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
        `SELECT jos_customer_id FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }

      const date = normalizeText(body.date, 10);
      const treatmentMinutes = Math.max(1, Math.min(780, Math.round(Number(body.treatmentMinutes || 0))));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('予約日が正しくありません。');

      const result = await env.jos_customer_db.prepare(
        `SELECT start_time, end_time FROM availability_busy
          WHERE busy_date = ? ORDER BY start_time ASC`
      ).bind(date).all();
      const toMinutes = value => {
        const parts = String(value || '').split(':');
        return Number(parts[0]) * 60 + Number(parts[1]);
      };
      const busy = (result.results || []).map(row => ({
        start: toMinutes(row.start_time),
        end: toMinutes(row.end_time)
      }));
      const slots = [];
      const tokyoNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const today = tokyoNow.toISOString().slice(0, 10);
      const currentMinutes = tokyoNow.getUTCHours() * 60 + tokyoNow.getUTCMinutes();
      for (let start = 10 * 60; start + treatmentMinutes <= 23 * 60; start += 30) {
        const end = start + treatmentMinutes;
        const isPast = date === today && start <= currentMinutes;
        if (!isPast && !busy.some(item => start < item.end && end > item.start)) {
          slots.push(`${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`);
        }
      }
      return json({ ok: true, date, treatmentMinutes, slots });
    }

    return json({ ok: false, message: 'APIが見つかりません。' }, 404);
  } catch (error) {
    return json({ ok: false, message: String(error && error.message ? error.message : '処理に失敗しました。') }, 400);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url.pathname);
    if (url.pathname.startsWith('/api/')) return api(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  }
};
