// 驗證 Web Push 加密：自己加密 → 自己解密 → 內容要一致。
// 這是能在本機做到最強的驗證：如果 HKDF、ECDH、AES-GCM 任何一步寫錯，往返就對不起來。
import {
  b64urlToBytes,
  bytesToB64url,
  encryptPayload,
  decryptPayload,
  vapidAuthHeader,
  generateVapidKeys
} from '../worker/src/push.js';

let failed = 0;
const check = (n, c, d) => {
  if (c) console.log('  ✓ ' + n);
  else {
    failed++;
    console.log('  ✗ ' + n + (d ? '  → ' + d : ''));
  }
};

console.log('\nbase64url 編解碼');
{
  const bytes = crypto.getRandomValues(new Uint8Array(65));
  const round = b64urlToBytes(bytesToB64url(bytes));
  check('任意位元組往返一致', Buffer.from(bytes).equals(Buffer.from(round)));
  check('沒有 + / = 這些非 url-safe 字元', !/[+/=]/.test(bytesToB64url(bytes)));
  // 各種長度（測 padding 處理）
  let allOk = true;
  for (let n = 1; n <= 40; n++) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    if (!Buffer.from(b).equals(Buffer.from(b64urlToBytes(bytesToB64url(b))))) allOk = false;
  }
  check('長度 1~40 的 padding 都正確', allOk);
}

console.log('\n推播內容加密（RFC 8291 aes128gcm）');
{
  // 模擬瀏覽器端的訂閱金鑰
  const uaKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits'
  ]);
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const subKeys = { p256dh: bytesToB64url(uaPublicRaw), auth: bytesToB64url(authSecret) };

  const message = JSON.stringify({
    title: '快輪到你了！還剩 3 位',
    body: '家庭醫學科／家醫內科一診（下午）\n目前叫號 57，你的號碼 60'
  });

  const body = await encryptPayload(message, subKeys);

  check('輸出長度合理（>= header 86 bytes）', body.length >= 86, String(body.length));
  check('salt 為 16 bytes、記錄大小欄位為 4096', new DataView(body.buffer, 16, 4).getUint32(0, false) === 4096);
  check('金鑰 ID 長度標示為 65', body[20] === 65, String(body[20]));
  check('金鑰 ID 是未壓縮 P-256 點（0x04 開頭）', body[21] === 0x04);

  const decrypted = await decryptPayload(
    body,
    { privateKey: uaKeys.privateKey, publicKeyForTest: uaKeys.publicKey },
    subKeys.auth
  );
  check('解密後與原文完全一致', decrypted === message, decrypted.slice(0, 60));

  // 每次加密的 salt / 臨時金鑰都不同 → 密文必須不同
  const body2 = await encryptPayload(message, subKeys);
  check('兩次加密結果不同（salt 與臨時金鑰有隨機化）', !Buffer.from(body).equals(Buffer.from(body2)));
  const decrypted2 = await decryptPayload(
    body2,
    { privateKey: uaKeys.privateKey, publicKeyForTest: uaKeys.publicKey },
    subKeys.auth
  );
  check('第二次也能正確解密', decrypted2 === message);

  // 用錯的 auth secret 必須解不開
  let rejected = false;
  try {
    await decryptPayload(
      body,
      { privateKey: uaKeys.privateKey, publicKeyForTest: uaKeys.publicKey },
      bytesToB64url(crypto.getRandomValues(new Uint8Array(16)))
    );
  } catch (e) {
    rejected = true;
  }
  check('auth secret 錯誤時解密失敗（金鑰確實有綁定）', rejected);

  // 中文與長內容
  const longMsg = JSON.stringify({ title: '測試', body: '中文內容測試 '.repeat(80) });
  const longBody = await encryptPayload(longMsg, subKeys);
  const longOut = await decryptPayload(
    longBody,
    { privateKey: uaKeys.privateKey, publicKeyForTest: uaKeys.publicKey },
    subKeys.auth
  );
  check('長中文內容往返一致（UTF-8 無損）', longOut === longMsg, String(longOut.length));
}

console.log('\nVAPID 授權標頭（RFC 8292）');
{
  const vapid = await generateVapidKeys();
  check('產生的公鑰為 65 bytes 未壓縮點', b64urlToBytes(vapid.publicKey).length === 65);
  check('產生的私鑰為 32 bytes', b64urlToBytes(vapid.privateKey).length === 32);

  const header = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc123', {
    ...vapid,
    subject: 'mailto:test@example.com'
  });
  check('格式為 vapid t=<jwt>, k=<key>', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(header), header.slice(0, 40));

  const jwt = header.match(/t=([^,]+)/)[1];
  const [h, p, s] = jwt.split('.');
  const headerObj = JSON.parse(Buffer.from(b64urlToBytes(h)).toString());
  const payloadObj = JSON.parse(Buffer.from(b64urlToBytes(p)).toString());
  check('JWT header 為 ES256', headerObj.alg === 'ES256' && headerObj.typ === 'JWT');
  check('aud 為推播端點的 origin', payloadObj.aud === 'https://fcm.googleapis.com', payloadObj.aud);
  check('sub 有帶入', payloadObj.sub === 'mailto:test@example.com');
  const hours = (payloadObj.exp - Math.floor(Date.now() / 1000)) / 3600;
  check('exp 在 12 小時左右（未超過規範上限 24 小時）', hours > 11.9 && hours <= 24, String(hours));
  check('簽章為 r||s 共 64 bytes', b64urlToBytes(s).length === 64, String(b64urlToBytes(s).length));

  // 用公鑰實際驗簽
  const pub = b64urlToBytes(vapid.publicKey);
  const verifyKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    b64urlToBytes(s),
    new TextEncoder().encode(h + '.' + p)
  );
  check('簽章可用對應公鑰驗證通過', valid);

  // 不同端點要有不同的 aud
  const h2 = await vapidAuthHeader('https://updates.push.services.mozilla.com/wpush/v2/xyz', {
    ...vapid,
    subject: 'mailto:test@example.com'
  });
  const p2 = JSON.parse(
    Buffer.from(b64urlToBytes(h2.match(/t=([^,]+)/)[1].split('.')[1])).toString()
  );
  check('換推播服務時 aud 跟著換', p2.aud === 'https://updates.push.services.mozilla.com', p2.aud);
}

console.log(failed === 0 ? '\n全部通過 ✅' : `\n${failed} 項失敗 ❌`);
process.exit(failed === 0 ? 0 : 1);
