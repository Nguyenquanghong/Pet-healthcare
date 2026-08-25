import crypto from "crypto";
import { Router, Request, Response } from "express";
import { db } from "../db";

export const authRouter = Router();

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HASH_ITERATIONS = 210000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";
const DEMO_ADMIN_USERNAME = "admin";
const DEMO_ADMIN_PASSWORD_HASH = "Csbdv6XeLCUGafp03chOaooQPLVl+OhEPT/B+/Jic30=";
const DEMO_ADMIN_PASSWORD_SALT = "bmlwb25ldG8tZGVtby1hZG1pbi1zYWx0";

function normalizeEmail(email: unknown) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function hashPassword(password: string) {
  const passwordSalt = crypto.randomBytes(16).toString("base64");
  const passwordHash = crypto.pbkdf2Sync(password, Buffer.from(passwordSalt, "base64"), HASH_ITERATIONS, KEY_LENGTH, DIGEST).toString("base64");
  return { passwordHash, passwordSalt };
}

function verifyPassword(password: string, passwordHash?: string, passwordSalt?: string) {
  if (!passwordHash || !passwordSalt) return false;
  const candidateHash = crypto.pbkdf2Sync(password, Buffer.from(passwordSalt, "base64"), HASH_ITERATIONS, KEY_LENGTH, DIGEST);
  const storedHash = Buffer.from(passwordHash, "base64");
  return storedHash.length === candidateHash.length && crypto.timingSafeEqual(storedHash, candidateHash);
}

function publicUser<T extends { passwordHash?: string; passwordSalt?: string }>(user: T) {
  const { passwordHash: _passwordHash, passwordSalt: _passwordSalt, ...safeUser } = user;
  return safeUser;
}

// POST /api/auth/owner/login
authRouter.post("/owner/login", (req: Request, res: Response) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";

  if (!email) return res.status(400).json({ error: "Email is required." });
  if (!emailPattern.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!password) return res.status(400).json({ error: "Password is required." });

  const user = db.get().users.find((u) => u.role === "owner" && normalizeEmail(u.email) === email);
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return res.status(401).json({ error: "The email or password is incorrect." });
  }

  return res.json({
    message: "Signed in successfully.",
    token: `jwt_owner_mock_${user.id}`,
    user: publicUser(user),
  });
});

// POST /api/auth/admin/login
authRouter.post("/admin/login", (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const validAdmin =
    username === DEMO_ADMIN_USERNAME &&
    verifyPassword(password, DEMO_ADMIN_PASSWORD_HASH, DEMO_ADMIN_PASSWORD_SALT);

  if (validAdmin) {
    const adminUser = db.get().users.find((u) => u.role === "admin") || {
      id: "staff_admin",
      fullName: "Admin User",
      role: "admin",
    };
    return res.json({
      message: "Admin signed in successfully.",
      token: "jwt_admin_mock_token",
      user: publicUser(adminUser),
    });
  }
  return res.status(401).json({ error: "The admin username or password is incorrect." });
});

// POST /api/auth/owner/register
authRouter.post("/owner/register", (req: Request, res: Response) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";
  const fullName = typeof req.body.fullName === "string" ? req.body.fullName.trim() : "";
  const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : "";
  const address = typeof req.body.address === "string" ? req.body.address.trim() : "";

  if (!email) return res.status(422).json({ error: "Email is required." });
  if (!emailPattern.test(email)) return res.status(422).json({ error: "Enter a valid email address." });
  if (!password) return res.status(422).json({ error: "Password is required." });
  if (!confirmPassword) return res.status(422).json({ error: "Confirm password is required." });
  if (password !== confirmPassword) return res.status(422).json({ error: "Confirm password must match the password." });

  const existing = db.get().users.find((u) => normalizeEmail(u.email) === email);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const passwordFields = hashPassword(password);
  const newUser = {
    id: `owner_${Date.now()}`,
    phone,
    email,
    ...passwordFields,
    fullName: fullName || email.split("@")[0],
    role: "owner" as const,
    address: address || undefined,
  };

  db.update((draft) => {
    draft.users.push(newUser);
  });

  return res.status(201).json({
    message: "Account created successfully.",
    token: `jwt_owner_mock_${newUser.id}`,
    user: publicUser(newUser),
  });
});
