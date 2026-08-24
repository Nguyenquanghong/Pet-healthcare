import { Router, Request, Response } from "express";
import { db } from "../db";

export const authRouter = Router();

// POST /api/auth/owner/login
authRouter.post("/owner/login", (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "Vui lòng nhập số điện thoại" });
  }

  const user = db.get().users.find((u) => u.phone.trim() === phone.trim());
  if (!user) {
    return res.status(401).json({ error: "Số điện thoại chưa được đăng ký trong hệ thống" });
  }

  return res.json({
    message: "Đăng nhập thành công",
    token: `jwt_owner_mock_${user.id}`,
    user,
  });
});

// POST /api/auth/admin/login
authRouter.post("/admin/login", (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (username === "admin" && password === "admin123") {
    const adminUser = db.get().users.find((u) => u.role === "admin") || {
      id: "staff_admin",
      fullName: "Admin Quản Trị",
      role: "admin",
    };
    return res.json({
      message: "Đăng nhập quản trị thành công",
      token: "jwt_admin_mock_token",
      user: adminUser,
    });
  }
  return res.status(401).json({ error: "Sai tên đăng nhập hoặc mật khẩu quản trị" });
});

// POST /api/auth/owner/register
authRouter.post("/owner/register", (req: Request, res: Response) => {
  const { fullName, phone, email, address } = req.body;
  if (!fullName || !phone) {
    return res.status(422).json({ error: "Họ tên và số điện thoại là bắt buộc" });
  }

  const existing = db.get().users.find((u) => u.phone.trim() === phone.trim());
  if (existing) {
    return res.status(409).json({ error: "Số điện thoại này đã được đăng ký tài khoản" });
  }

  const newUser = {
    id: `owner_${Date.now()}`,
    phone: phone.trim(),
    email: email?.trim(),
    fullName: fullName.trim(),
    role: "owner" as const,
    address: address?.trim(),
  };

  db.update((draft) => {
    draft.users.push(newUser);
  });

  return res.status(201).json({
    message: "Đăng ký tài khoản thành công",
    token: `jwt_owner_mock_${newUser.id}`,
    user: newUser,
  });
});
