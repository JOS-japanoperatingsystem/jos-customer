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

async function verifyLine(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== requestUrl.origin) {
    return json({ ok: false, message: '許可されていない接続元です。' }, 403);
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 20000) {
    return json({ ok: false, message: '送信データが大きすぎます。' }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, message: '送信形式が正しくありません。' }, 400);
  }

  const idToken = typeof body.idToken === 'string' ? body.idToken.trim() : '';
  if (!idToken || idToken.length > 10000) {
    return json({ ok: false, message: 'LINE認証情報を取得できませんでした。' }, 400);
  }

  const form = new URLSearchParams();
  form.set('id_token', idToken);
  form.set('client_id', LINE_CHANNEL_ID);

  let lineResponse;
  try {
    lineResponse = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form
    });
  } catch (_) {
    return json({ ok: false, message: 'LINE公式サーバーへ接続できませんでした。' }, 502);
  }

  let verified;
  try {
    verified = await lineResponse.json();
  } catch (_) {
    return json({ ok: false, message: 'LINE公式サーバーの応答を確認できませんでした。' }, 502);
  }

  if (!lineResponse.ok || !verified || !verified.sub || String(verified.aud) !== LINE_CHANNEL_ID) {
    return json({ ok: false, message: 'LINE本人確認に失敗しました。もう一度ログインしてください。' }, 401);
  }

  return json({
    ok: true,
    displayName: String(verified.name || ''),
    verifiedAt: new Date().toISOString()
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/verify-line') {
      if (request.method !== 'POST') {
        return json({ ok: false, message: 'POSTのみ利用できます。' }, 405);
      }
      return verifyLine(request);
    }
    return env.ASSETS.fetch(request);
  }
};
