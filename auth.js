// Google ID tokens are verified only on the server. No password or token secret.
export const GOOGLE_CLIENT_ID = '492239820935-ov9bvrgcf05jejdsnburactcnpm9d5qb.apps.googleusercontent.com';
let keyCache = { until: 0, keys: [] };
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const denied = () => { throw new HttpError(403, 'אין הרשאה לפעולה זו'); };
const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const parse = value => JSON.parse(new TextDecoder().decode(decode(value)));
export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
}
async function googleKey(kid) {
  if (Date.now() >= keyCache.until) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new HttpError(503, 'שירות ההזדהות אינו זמין כעת');
    const data = await r.json();
    const seconds = Math.min(Number(r.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1]) || 300, 3600);
    keyCache = { until: Date.now() + seconds * 1000, keys: data.keys || [] };
  }
  const jwk = keyCache.keys.find(k => k.kid === kid && k.kty === 'RSA' && k.alg === 'RS256' && k.use === 'sig');
  if (!jwk) throw new HttpError(401, 'נדרש להיכנס מחדש דרך Google');
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}
// Key resolver argument is used by cryptographic tests; production always uses Google's HTTPS JWKS.
export async function verifyGoogle(token, nonce, keyResolver = googleKey) {
  try {
    if (typeof token !== 'string' || token.length > 16000) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const header = parse(parts[0]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit) throw new Error();
    const key = await keyResolver(header.kid);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) throw new Error();
    const p = parse(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(p.iss) || p.aud !== GOOGLE_CLIENT_ID || (p.azp && p.azp !== GOOGLE_CLIENT_ID)) throw new Error();
    if (!Number.isInteger(p.exp) || p.exp <= now || !Number.isInteger(p.iat) || p.iat > now + 60 || p.iat < now - 3600 || (p.nbf && p.nbf > now + 60)) throw new Error();
    if (p.nonce !== nonce || !nonce || typeof p.sub !== 'string' || !/^[0-9]{1,255}$/.test(p.sub) || p.email_verified !== true) throw new Error();
    const email = normalizeEmail(p.email);
    // Google is authoritative for verified Workspace accounts (hd) and Gmail.
    if (!email.endsWith('@gmail.com') && (typeof p.hd !== 'string' || !p.hd)) throw new HttpError(403, 'יש להשתמש בחשבון Google ארגוני או Gmail מאומת');
    return { sub: p.sub, email, name: typeof p.name === 'string' ? p.name.slice(0, 160) : email,
      picture: typeof p.picture === 'string' && p.picture.startsWith('https://') ? p.picture : '' };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(401, 'הזדהות Google לא אומתה. יש להיכנס מחדש');
  }
}
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'נדרשת כתובת דוא״ל תקינה');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(email)) throw new HttpError(400, 'נדרשת כתובת דוא״ל תקינה');
  return email;
}
export const roleTables = { admin: 'system_admins', instructor: 'instructors', supervisor: 'supervisors', principal: 'admins' };
export async function membership(db, role, email, sub) {
  const table = roleTables[role];
  if (!table) denied();
  const member = await db.prepare(`SELECT * FROM ${table} WHERE lower(email)=?`).bind(email).first();
  if (!member || (role === 'admin' && member.google_sub && member.google_sub !== sub)) denied();
  return member;
}
export async function authenticate(request, db) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new HttpError(401, 'נדרשת כניסה למערכת');
  const session = await db.prepare('SELECT * FROM auth_sessions WHERE token_hash=? AND expires_at>?').bind(await hash(token), Date.now()).first();
  if (!session) throw new HttpError(401, 'הכניסה פגה. יש להיכנס מחדש');
  const identity = await db.prepare('SELECT google_sub FROM auth_identities WHERE email=?').bind(session.email).first();
  if (!identity || identity.google_sub !== session.google_sub) denied();
  const member = await membership(db, session.portal_role, session.email, session.google_sub);
  return { ...session, member };
}
