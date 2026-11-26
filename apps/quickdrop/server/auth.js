import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError, hashToken, randomToken } from './http.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'qd_session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, n, r, p, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

// Used so unknown emails take as long to reject as wrong passwords.
const DUMMY_HASH = await hashPassword(randomToken(16));

export class AuthService {
  constructor(db) {
    this.db = db;
    this.q = {
      userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
      userById: db.prepare('SELECT id, email, created_at FROM users WHERE id = ?'),
      insertUser: db.prepare('INSERT INTO users (id, email, pass_hash, created_at) VALUES (?, ?, ?, ?)'),
      insertSession: db.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ),
      session: db.prepare(
        'SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
      ),
      deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    };
  }

  static validate(email, password) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) {
      throw new HttpError(400, 'invalid_email', 'Enter a valid email address');
    }
    const pw = String(password || '');
    if (pw.length < 8 || pw.length > 200) {
      throw new HttpError(400, 'weak_password', 'Password must be at least 8 characters');
    }
    return { email: cleanEmail, password: pw };
  }

  async signup(email, password) {
    const input = AuthService.validate(email, password);
    if (this.q.userByEmail.get(input.email)) {
      throw new HttpError(409, 'email_taken', 'An account with this email already exists');
    }
    const id = randomToken(12);
    const passHash = await hashPassword(input.password);
    try {
      this.q.insertUser.run(id, input.email, passHash, Date.now());
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      }
      throw err;
    }
    return { id, email: input.email };
  }

  async login(email, password) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    const row = this.q.userByEmail.get(cleanEmail);
    const ok = await verifyPassword(String(password || ''), row ? row.pass_hash : DUMMY_HASH);
    if (!row || !ok) throw new HttpError(401, 'invalid_credentials', 'Wrong email or password');
    return { id: row.id, email: row.email };
  }

  createSession(userId) {
    const token = randomToken(32);
    const now = Date.now();
    const expires = now + SESSION_DAYS * 86400_000;
    this.q.insertSession.run(hashToken(token), userId, now, expires);
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  userForToken(token) {
    if (!token) return null;
    const row = this.q.session.get(hashToken(token), Date.now());
    return row ? { id: row.id, email: row.email } : null;
  }

  destroySession(token) {
    if (token) this.q.deleteSession.run(hashToken(token));
  }

  sweep() {
    this.q.purgeSessions.run(Date.now());
  }
}
