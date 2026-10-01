import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { AuthDependencies, UserAccount } from "../ports/auth.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";

export type LoginInput = { email?: unknown; username?: unknown; password?: unknown };
export type RegisterInput = { email?: unknown; password?: unknown; confirmPassword?: unknown; phone?: unknown; fullName?: unknown; address?: unknown };
export type ProfileInput = { email?: unknown; phone?: unknown; fullName?: unknown; address?: unknown };
export type ChangePasswordInput = { currentPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown };

export class AuthService {
  constructor(private readonly deps: AuthDependencies) {}

  async ownerLogin(input: LoginInput): Promise<{ token: string; user: UserAccount }> {
    const email = normalizeEmail(input.email);
    const password = typeof input.password === "string" ? input.password : "";
    if (!email) throw new BusinessError(422, "Email is required.");
    if (!emailPattern.test(email)) throw new BusinessError(422, "Enter a valid email address.");
    if (!password) throw new BusinessError(422, "Password is required.");
    const user = await this.deps.users.findOwnerByEmail(email);
    if (!user || !user.passwordHash || !user.passwordSalt || !this.deps.passwords.verify(password, user.passwordHash, user.passwordSalt)) throw new BusinessError(401, "The email or password is incorrect.");
    return { token: this.deps.tokens.sign(user.id, user.role), user };
  }

  async adminLogin(input: LoginInput): Promise<{ token: string; user: UserAccount }> {
    const username = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!username || !password) throw new BusinessError(422, "Username and password are required.");
    const user = await this.deps.users.findStaffByUsername(username);
    if (!user || !this.deps.passwords.verify(password, user.passwordHash, user.passwordSalt)) throw new BusinessError(401, "The admin username or password is incorrect.");
    return { token: this.deps.tokens.sign(user.id, user.role), user };
  }

  async registerOwner(input: RegisterInput): Promise<{ token: string; user: UserAccount }> {
    const email = normalizeEmail(input.email);
    const password = typeof input.password === "string" ? input.password : "";
    const confirmPassword = typeof input.confirmPassword === "string" ? input.confirmPassword : "";
    if (!email) throw new BusinessError(422, "Email is required.");
    if (!emailPattern.test(email)) throw new BusinessError(422, "Enter a valid email address.");
    if (!password) throw new BusinessError(422, "Password is required.");
    if (!confirmPassword) throw new BusinessError(422, "Confirm password is required.");
    if (password !== confirmPassword) throw new BusinessError(422, "Confirm password must match the password.");
    if (await this.deps.users.findByEmail(email)) throw new BusinessError(409, "An account with this email already exists.");
    const user = await this.deps.users.createOwner({
      email,
      phone: typeof input.phone === "string" && input.phone.trim() ? input.phone.trim() : null,
      fullName: typeof input.fullName === "string" && input.fullName.trim() ? input.fullName.trim() : email.split("@")[0],
      address: typeof input.address === "string" && input.address.trim() ? input.address.trim() : null,
      ...this.deps.passwords.hash(password),
    });
    return { token: this.deps.tokens.sign(user.id, user.role), user };
  }

  async me(actor: Actor): Promise<UserAccount> {
    const user = await this.deps.users.findById(actor.sub);
    if (!user) throw new BusinessError(401, "User not found.");
    return user;
  }

  async updateProfile(actor: Actor, input: ProfileInput): Promise<UserAccount> {
    const fullName = typeof input.fullName === "string" ? input.fullName.trim() : "";
    const email = normalizeEmail(input.email);
    const phone = typeof input.phone === "string" ? input.phone.trim() : "";
    const address = typeof input.address === "string" ? input.address.trim() : "";
    if (!fullName) throw new BusinessError(422, "Full name is required.");
    if (!email) throw new BusinessError(422, "Email is required.");
    if (!emailPattern.test(email)) throw new BusinessError(422, "Enter a valid email address.");
    const [emailOwner, phoneOwner] = await Promise.all([
      this.deps.users.hasOtherEmail(email, actor.sub),
      phone ? this.deps.users.hasOtherPhone(phone, actor.sub) : false,
    ]);
    if (emailOwner) throw new BusinessError(409, "An account with this email already exists.");
    if (phoneOwner) throw new BusinessError(409, "An account with this phone number already exists.");
    return this.deps.users.updateProfile(actor.sub, { fullName, email, phone: phone || null, address: address || null });
  }

  async changePassword(actor: Actor, input: ChangePasswordInput): Promise<void> {
    const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
    const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
    const confirmPassword = typeof input.confirmPassword === "string" ? input.confirmPassword : "";
    if (!currentPassword) throw new BusinessError(422, "Current password is required.");
    if (!newPassword) throw new BusinessError(422, "New password is required.");
    if (newPassword.length < 8) throw new BusinessError(422, "New password must be at least 8 characters.");
    if (!confirmPassword) throw new BusinessError(422, "Confirm password is required.");
    if (newPassword !== confirmPassword) throw new BusinessError(422, "Confirm password must match the new password.");
    if (newPassword === currentPassword) throw new BusinessError(422, "New password must be different from the current password.");
    const user = await this.deps.users.findById(actor.sub);
    if (!user) throw new BusinessError(401, "User not found.");
    if (!this.deps.passwords.verify(currentPassword, user.passwordHash, user.passwordSalt)) throw new BusinessError(401, "Current password is incorrect.");
    await this.deps.users.updatePassword(user.id, this.deps.passwords.hash(newPassword));
  }
}
