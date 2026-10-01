import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { PasswordPort } from "../ports/auth.js";
import type { ActivationTokenPort, OwnerActivationRepository, OwnerInvitation } from "../ports/ownerActivation.js";

const INVALID_LINK = "Liên kết kích hoạt không hợp lệ, đã hết hạn hoặc đã được sử dụng. Liên hệ cửa hàng để được cấp lại.";
const tokenValue = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new BusinessError(422, INVALID_LINK);
  return value;
};
function usable(invitation: OwnerInvitation | null, now: Date): asserts invitation is OwnerInvitation {
  if (!invitation || invitation.usedAt || invitation.revokedAt || invitation.expiresAt <= now ||
      invitation.owner.role !== "owner" || invitation.owner.loginEnabled) throw new BusinessError(422, INVALID_LINK);
}

export class OwnerActivationService {
  constructor(private readonly repository: OwnerActivationRepository, private readonly tokens: ActivationTokenPort,
    private readonly passwords: PasswordPort, private readonly now: () => Date = () => new Date()) {}

  async issue(actor: Actor, ownerId: string, input: { email?: unknown; customerVerified?: unknown }) {
    if (actor.role !== "admin" && actor.role !== "staff") throw new BusinessError(403, "Chỉ admin hoặc nhân viên được cấp liên kết kích hoạt.");
    if (input.customerVerified !== true) throw new BusinessError(422, "Cần xác minh đúng khách và email trước khi cấp liên kết.");
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BusinessError(422, "Nhập email hợp lệ để khách đăng nhập.");
    const generated = this.tokens.create();
    return this.repository.run(ownerId, async tx => {
      if (tx.owner.role !== "owner") throw new BusinessError(422, "Hồ sơ này không phải chủ nuôi.");
      if (tx.owner.loginEnabled) throw new BusinessError(409, "Khách đã có tài khoản đăng nhập. Chức năng này chỉ kích hoạt hồ sơ tại quầy.");
      if (await tx.emailTaken(email)) throw new BusinessError(409, "Email đã thuộc hồ sơ khác. Kiểm tra lại email của khách.");
      const now = this.now(), expiresAt = new Date(now.getTime() + 30 * 60_000);
      await tx.revokePending(now);
      await tx.createInvitation({ tokenHash: generated.tokenHash, email, expiresAt, issuedBy: actor.sub, createdAt: now });
      return { token: generated.token, email, expiresAt: expiresAt.toISOString() };
    });
  }

  async inspect(input: { token?: unknown }) {
    const invitation = await this.repository.findInvitation(this.tokens.hash(tokenValue(input.token)));
    usable(invitation, this.now());
    return { email: invitation.email, expiresAt: invitation.expiresAt.toISOString() };
  }

  async activate(input: { token?: unknown; password?: unknown; confirmPassword?: unknown }) {
    const tokenHash = this.tokens.hash(tokenValue(input.token));
    const password = typeof input.password === "string" ? input.password : "";
    if (password.length < 8 || password.length > 128) throw new BusinessError(422, "Mật khẩu cần từ 8 đến 128 ký tự.");
    if (input.confirmPassword !== password) throw new BusinessError(422, "Mật khẩu xác nhận chưa khớp.");
    const invitation = await this.repository.findInvitation(tokenHash);
    usable(invitation, this.now());
    const credentials = this.passwords.hash(password);
    return this.repository.run(invitation.ownerId, async tx => {
      const current = await tx.findInvitation(tokenHash), now = this.now();
      usable(current, now);
      if (tx.owner.loginEnabled || tx.owner.role !== "owner") throw new BusinessError(422, INVALID_LINK);
      if (await tx.emailTaken(current.email)) throw new BusinessError(409, "Email đã được dùng bởi hồ sơ khác. Liên hệ cửa hàng để cấp lại liên kết với email đúng.");
      await tx.setCredentials(current.email, credentials);
      await tx.markUsed(current.id, now);
      await tx.revokePending(now);
      return { email: current.email, message: "Đã kích hoạt tài khoản. Bạn có thể đăng nhập bằng email và mật khẩu vừa đặt." };
    });
  }
}
