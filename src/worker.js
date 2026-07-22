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
  if (contentLength > 20000) throw new Error('送信データが大きすぎます。');
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
