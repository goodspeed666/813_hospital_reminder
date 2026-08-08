// Web Push（RFC 8291 aes128gcm + RFC 8292 VAPID），純 WebCrypto 實作。
// Cloudflare Workers 沒有 Node 的 crypto，npm 的 web-push 套件無法使用，
// 因此這裡自己實作；所有步驟都有對應的往返測試。

const enc = new TextEncoder();

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let bin = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/** HKDF：RFC 5869，這裡輸出長度都 <= 32，所以只需要一輪 expand */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

/** 把 base64url 的 P-256 公私鑰組成 WebCrypto 可匯入的 JWK */
function toJwk(publicB64url, privateB64url) {
  const pub = b64urlToBytes(publicB64url);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID 公鑰格式錯誤：必須是 65 bytes 的未壓縮 P-256 點');
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true
  };
  if (privateB64url) jwk.d = privateB64url;
  return jwk;
}

/** 產生一組 VAPID 金鑰（base64url 公鑰 / 私鑰），部署前跑一次即可 */
export async function generateVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ]);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: bytesToB64url(pub), privateKey: jwk.d };
}

/** 建立 VAPID Authorization header（RFC 8292） */
export async function vapidAuthHeader(endpoint, { publicKey, privateKey, subject }) {
  const aud = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject
  };
  const signingInput =
    bytesToB64url(enc.encode(JSON.stringify(header))) +
    '.' +
    bytesToB64url(enc.encode(JSON.stringify(payload)));

  const key = await crypto.subtle.importKey(
    'jwk',
    toJwk(publicKey, privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  // WebCrypto 的 ECDSA 直接輸出 r||s（64 bytes），正是 JWS 需要的格式
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput))
  );
  const jwt = signingInput + '.' + bytesToB64url(sig);
  return `vapid t=${jwt}, k=${publicKey}`;
}

/**
 * 依 RFC 8291 加密推播內容。
 * @param {string} plaintext 要送的內容（通常是 JSON 字串）
 * @param {{p256dh:string, auth:string}} keys 來自瀏覽器訂閱物件
 * @param {Uint8Array} [salt] 測試用，正式使用請留空由函式隨機產生
 * @param {CryptoKeyPair} [asKeyPair] 測試用
 */
export async function encryptPayload(plaintext, keys, salt, asKeyPair) {
  const uaPublicRaw = b64urlToBytes(keys.p256dh);
  const authSecret = b64urlToBytes(keys.auth);

  const uaPublic = await crypto.subtle.importKey(
    'raw',
    uaPublicRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const as =
    asKeyPair ||
    (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublic }, as.privateKey, 256)
  );

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(
    enc.encode('WebPush: info'),
    new Uint8Array([0]),
    uaPublicRaw,
    asPublicRaw
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const realSalt = salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    realSalt,
    ikm,
    concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])),
    16
  );
  const nonce = await hkdf(
    realSalt,
    ikm,
    concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])),
    12
  );

  // 最後一筆記錄的分隔符號是 0x02
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded)
  );

  // Header: salt(16) || rs(4) || idlen(1) || keyid(as_public, 65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(realSalt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

/** 測試用：用訂閱端的私鑰把上面加密的內容解回來 */
export async function decryptPayload(body, uaPrivateKey, authSecretB64url) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublicRaw = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const authSecret = b64urlToBytes(authSecretB64url);

  const uaPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', uaPrivateKey.publicKeyForTest)
  );
  const asPublic = await crypto.subtle.importKey(
    'raw',
    asPublicRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asPublic }, uaPrivateKey.privateKey, 256)
  );
  const keyInfo = concat(
    enc.encode('WebPush: info'),
    new Uint8Array([0]),
    uaPublicRaw,
    asPublicRaw
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])),
    16
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])),
    12
  );
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext)
  );
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end--;
  if (end > 0 && padded[end - 1] === 2) end--;
  return new TextDecoder().decode(padded.slice(0, end));
}

/**
 * 送出一則推播。
 * @returns {{ok:boolean, status:number, gone:boolean}} gone=true 代表訂閱已失效，應刪除
 */
export async function sendPush(subscription, payload, vapid, ttl = 600) {
  const body = await encryptPayload(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    subscription.keys
  );
  const auth = await vapidAuthHeader(subscription.endpoint, vapid);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high'
    },
    body
  });
  // 404 / 410 代表訂閱已被瀏覽器撤銷
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
