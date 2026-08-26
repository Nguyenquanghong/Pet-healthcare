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

authRouter.patch("/me", requireAuth, async (req, res) => {
  const userId = req.auth!.sub;
  const fullName = typeof req.body.fullName === "string" ? req.body.fullName.trim() : "";
  const email = normalizeEmail(req.body.email);
  const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : "";
  const address = typeof req.body.address === "string" ? req.body.address.trim() : "";

  if (!fullName) return res.status(422).json({ error: "Full name is required." });
  if (!email) return res.status(422).json({ error: "Email is required." });
  if (!emailPattern.test(email)) return res.status(422).json({ error: "Enter a valid email address." });

  const [emailOwner, phoneOwner] = await Promise.all([
    prisma.user.findFirst({ where: { email, id: { not: userId } }, select: { id: true } }),
    phone ? prisma.user.findFirst({ where: { phone, id: { not: userId } }, select: { id: true } }) : null,
  ]);
  if (emailOwner) return res.status(409).json({ error: "An account with this email already exists." });
  if (phoneOwner) return res.status(409).json({ error: "An account with this phone number already exists." });

  const user = await prisma.user.update({
    where: { id: userId },
    data: { fullName, email, phone: phone || null, address: address || null },
  });
  return res.json({ user: publicUser(user) });
});

authRouter.post("/me/password", requireAuth, async (req, res) => {
  const currentPassword = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
  const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
  const confirmPassword = typeof req.body.confirmPassword === "string" ? req.body.confirmPassword : "";

  if (!currentPassword) return res.status(422).json({ error: "Current password is required." });
  if (!newPassword) return res.status(422).json({ error: "New password is required." });
  if (newPassword.length < 8) return res.status(422).json({ error: "New password must be at least 8 characters." });
  if (!confirmPassword) return res.status(422).json({ error: "Confirm password is required." });
  if (newPassword !== confirmPassword) return res.status(422).json({ error: "Confirm password must match the new password." });
  if (newPassword === currentPassword) return res.status(422).json({ error: "New password must be different from the current password." });

  const user = await prisma.user.findUnique({ where: { id: req.auth!.sub } });
  if (!user) return res.status(401).json({ error: "User not found." });
  if (!verifyPassword(currentPassword, user.passwordHash, user.passwordSalt)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  await prisma.user.update({ where: { id: user.id }, data: hashPassword(newPassword) });
  return res.status(204).send();
});
