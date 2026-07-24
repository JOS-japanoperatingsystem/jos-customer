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
      const row = await env.jos_customer_db.prepare(
        `SELECT reservation_id, reservation_date, start_time, end_time,
                menu_name, price, reservation_status
           FROM customer_next_reservations
          WHERE jos_customer_id = ?`
      ).bind(profile.jos_customer_id).first();
      return json({ ok: true, reservation: publicReservation(row) });
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
        `SELECT jos_customer_id FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }

      const date = validateCustomerBookingDate(body.date);
      const treatmentMinutes = Math.max(1, Math.min(780, Math.round(Number(body.treatmentMinutes || 0))));

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

    if (pathname === '/api/booking/request') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id, last_name, first_name
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
      const existingReservation = await env.jos_customer_db.prepare(
        `SELECT reservation_id FROM customer_next_reservations
          WHERE jos_customer_id = ?
          LIMIT 1`
      ).bind(profile.jos_customer_id).first();
      const pendingBooking = await env.jos_customer_db.prepare(
        `SELECT request_id FROM customer_booking_requests
          WHERE jos_customer_id = ? AND status = 'pending'
          LIMIT 1`
      ).bind(profile.jos_customer_id).first();
      if (existingReservation || pendingBooking) {
        return json({
          ok: false,
          message: '現在の予約があります。「予約確認」から日時変更またはキャンセルを行ってください。'
        }, 409);
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

      const treatmentTime = menus.reduce((sum, menu) => sum + Number(menu.treatment_time || 0), 0);
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
      const tokyoNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const tokyoToday = tokyoNow.toISOString().slice(0, 10);
      const currentMinutes = tokyoNow.getUTCHours() * 60 + tokyoNow.getUTCMinutes();
      if (date === tokyoToday && start <= currentMinutes) {
        throw new Error('過ぎた時間は予約できません。');
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
      const tokyoNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const today = tokyoNow.toISOString().slice(0, 10);
      const currentMinutes = tokyoNow.getUTCHours() * 60 + tokyoNow.getUTCMinutes();
      for (let start = 10 * 60; start + treatmentMinutes <= 23 * 60; start += 30) {
        const end = start + treatmentMinutes;
        const isPast = date === today && start <= currentMinutes;
        const slotTime = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
        const isCurrent = date === reservation.reservation_date &&
          slotTime === reservation.start_time;
        if (!isPast && !isCurrent && !busy.some(item => start < item.end && end > item.start)) {
          slots.push(slotTime);
        }
      }
      return json({ ok: true, date, treatmentMinutes, slots });
    }

    if (pathname === '/api/reservation/change/request') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM customer_profiles
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
        `SELECT reservation_date, start_time, end_time FROM customer_next_reservations
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
      const tokyoNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const tokyoToday = tokyoNow.toISOString().slice(0, 10);
      const currentMinutes = tokyoNow.getUTCHours() * 60 + tokyoNow.getUTCMinutes();
      if (date === tokyoToday && start <= currentMinutes) {
        throw new Error('過ぎた時間には変更できません。');
      }
      const endTime = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
      const actionId = crypto.randomUUID().replace(/-/g, '');
      const now = new Date().toISOString();
      const insert = await env.jos_customer_db.prepare(
        `INSERT INTO customer_reservation_actions
           (action_id, line_sub, jos_customer_id, reservation_id,
            action_type, cancel_status, status, created_at, updated_at,
            requested_date, requested_start_time, requested_end_time)
         SELECT ?, ?, ?, ?, 'change', '', 'pending', ?, ?, ?, ?, ?
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
        date, `R-${reservationId}`, startTime, endTime,
        date, startTime, endTime,
        date, reservationId, startTime, endTime
      ).run();
      if (!insert.meta || Number(insert.meta.changes || 0) !== 1) {
        return json({ ok: false, message: '選択中に予約が入りました。別の時間を選択してください。' }, 409);
      }
      return json({ ok: true, actionId, status: 'pending' });
    }

    if (pathname === '/api/reservation/cancel/request') {
      const profile = await env.jos_customer_db.prepare(
        `SELECT jos_customer_id FROM customer_profiles
          WHERE line_sub = ? AND link_status = 'approved'`
      ).bind(identity.sub).first();
      if (!profile || !profile.jos_customer_id) {
        return json({ ok: false, message: '店舗連携完了後に利用できます。' }, 403);
      }
      const reservationId = normalizeText(body.reservationId, 80);
      const reservation = await env.jos_customer_db.prepare(
        `SELECT reservation_date FROM customer_next_reservations
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
              action_type, cancel_status, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'cancel', ?, 'pending', ?, ?)`
        ).bind(
          actionId, identity.sub, profile.jos_customer_id,
          reservationId, cancelStatus, now, now
        ).run();
      } catch (_) {
        return json({ ok: false, message: 'この予約のキャンセル処理を受付済みです。' }, 409);
      }
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
    if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url.pathname);
    if (url.pathname.startsWith('/api/')) return api(request, env, url.pathname);
    return env.ASSETS.fetch(request);
  }
};
