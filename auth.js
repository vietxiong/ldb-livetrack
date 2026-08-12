// auth.js — password hashing + JWT tokens.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-jwt-secret';
const TOKEN_TTL = '30d';

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain, hash) {
  try { return bcrypt.compareSync(plain, hash); } catch { return false; }
}

export function signToken(user) {
  return jwt.sign(
    { id: user.userId, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

export function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
