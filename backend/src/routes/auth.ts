import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { publicUser } from "../lib/serialize.js";
import { signToken } from "../lib/token.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

authRouter.post("/owner/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!email) return res.status(422).json({ error: "Email is required." });
  if (!emailPattern.test(email)) return res.status(422).json({ error: "Enter a valid email address." });
  if (!password) return res.status(422).json({ error: "Password is required." });

  const user = await prisma.user.findFirst({ where: { email, role: "owner" } });
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return res.status(401).json({ error: "The email or password is incorrect." });
  }
  return res.json({ token: signToken(user.id, user.role), user: publicUser(user) });
});

authRouter.post("/admin/login", async (req, res) => {
  const username = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!username || !password) return res.status(422).json({ error: "Username and password are required." });

  const user = await prisma.user.findFirst({ where: { username, role: { in: ["admin", "doctor", "staff"] } } });
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return res.status(401).json({ error: "The admin username or password is incorrect." });
  }
  return res.json({ token: signToken(user.id, user.role), user: publicUser(user) });
});

authRouter.post("/owner/register", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";
  if (!email) return res.status(422).json({ error: "Email is required." });
  if (!emailPattern.test(email)) return res.status(422).json({ error: "Enter a valid email address." });
  if (!password) return res.status(422).json({ error: "Password is required." });
  if (!confirmPassword) return res.status(422).json({ error: "Confirm password is required." });
  if (password !== confirmPassword) return res.status(422).json({ error: "Confirm password must match the password." });
  if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ error: "An account with this email already exists." });

  const user = await prisma.user.create({
    data: {
      email,
      phone: typeof req.body.phone === "string" && req.body.phone.trim() ? req.body.phone.trim() : null,
      fullName: typeof req.body.fullName === "string" && req.body.fullName.trim() ? req.body.fullName.trim() : email.split("@")[0],
      address: typeof req.body.address === "string" && req.body.address.trim() ? req.body.address.trim() : null,
      role: "owner",
      ...hashPassword(password),
    },
  });
  return res.status(201).json({ token: signToken(user.id, user.role), user: publicUser(user) });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.sub } });
  if (!user) return res.status(401).json({ error: "User not found." });
  return res.json({ user: publicUser(user) });
});
