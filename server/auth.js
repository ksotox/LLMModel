// Profiles and sign-in. Each profile has its own collection. Passwords are stored as scrypt
// hashes; a signed-in browser holds a random session token in an HttpOnly cookie (only its
// SHA-256 is kept in the database). The first profile is the owner: it is created on the setup
// screen, takes over a collection made before profiles existed, and can add other profiles.

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const COOKIE = 'pokedex_session';
const SESSION_DAYS = 30;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), 64);
  const expected = Buffer.from(hash, 'base64');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** A profile as the browser sees it (never the password hash). */
export const publicUser = (u) => u && ({
  id: u.id, username: u.username, display_name: u.display_name, is_owner: Boolean(u.is_owner),
  settings: (() => { try { return JSON.parse(u.settings || '{}'); } catch { return {}; } })(),
});

export function validateProfile({ username, display_name, password }, { needPassword = true } = {}) {
  const name = String(username ?? '').trim();
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(name)) return 'Usernames are 3–32 letters, numbers, dots, dashes or underscores.';
  if (display_name !== undefined && !String(display_name).trim()) return 'Give the profile a display name.';
  if (needPassword && String(password ?? '').length < 6) return 'Passwords need at least 6 characters.';
  return null;
}

export function createAuth(store, { secureCookie = false } = {}) {
  // Slow down password guessing: 5 failed sign-ins per username / address per 10 minutes.
  const failures = new Map();
  const tooMany = (key) => (failures.get(key) ?? []).filter((t) => Date.now() - t < 10 * 60 * 1000).length >= 5;
  const failed = (key) => failures.set(key, [...(failures.get(key) ?? []), Date.now()].slice(-10));

  const setCookie = (res, token) => {
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureCookie ? '; Secure' : ''}`);
  };

  return {
    /** Who is signed in (or null). */
    userFor(req) {
      const token = readCookie(req);
      return token ? store.userForSession(sha256(token)) : null;
    },

    startSession(res, userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      store.createSession(sha256(token), userId, SESSION_DAYS);
      setCookie(res, token);
    },

    endSession(req, res) {
      const token = readCookie(req);
      if (token) store.deleteSession(sha256(token));
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    },

    currentHash(req) {
      const token = readCookie(req);
      return token ? sha256(token) : null;
    },

    async login(username, password, address) {
      const keys = [`u:${String(username).toLowerCase()}`, `a:${address}`];
      if (keys.some(tooMany)) return { error: 'Too many attempts. Wait a few minutes and try again.', status: 429 };
      const user = store.getUserByName(String(username ?? '').trim());
      // Hash something even for unknown names, so timing doesn't reveal which usernames exist.
      const ok = await checkPassword(password, user?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');
      if (!user || !ok) {
        keys.forEach(failed);
        return { error: 'Wrong username or password.', status: 401 };
      }
      keys.forEach((k) => failures.delete(k));
      return { user };
    },
  };
}
