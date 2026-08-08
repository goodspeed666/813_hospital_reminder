// 產生一組 VAPID 金鑰。執行： node scripts/gen-vapid.mjs
import { generateVapidKeys } from '../worker/src/push.js';
const k = await generateVapidKeys();
console.log('\n把下面兩個值分別設定成 Worker 的 secret：\n');
console.log('  npx wrangler secret put VAPID_PUBLIC_KEY');
console.log('  ' + k.publicKey + '\n');
console.log('  npx wrangler secret put VAPID_PRIVATE_KEY');
console.log('  ' + k.privateKey + '\n');
