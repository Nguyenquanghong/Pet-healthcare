import type { Role } from "../../domain/auth.js";

export type UserAccount = {
  id: string; username: string | null; phone: string | null; email: string | null;
  passwordHash: string; passwordSalt: string; fullName: string; role: Role;
  address: string | null; avatarUrl: string | null; createdAt: Date; updatedAt: Date;
};

export interface UserRepository {
  findOwnerByEmail(email: string): Promise<UserAccount | null>;
  findStaffByUsername(username: string): Promise<UserAccount | null>;
  findByEmail(email: string): Promise<UserAccount | null>;
  findById(id: string): Promise<UserAccount | null>;
  hasOtherEmail(email: string, currentId: string): Promise<boolean>;
  hasOtherPhone(phone: string, currentId: string): Promise<boolean>;
  createOwner(data: { email: string; phone: string | null; fullName: string; address: string | null; passwordHash: string; passwordSalt: string }): Promise<UserAccount>;
  updateProfile(id: string, data: { fullName: string; email: string; phone: string | null; address: string | null }): Promise<UserAccount>;
  updatePassword(id: string, data: { passwordHash: string; passwordSalt: string }): Promise<void>;
}

export interface PasswordPort {
  hash(password: string): { passwordHash: string; passwordSalt: string };
  verify(password: string, hash: string, salt: string): boolean;
}

export interface TokenPort {
  sign(userId: string, role: Role): string;
}

export interface AuthDependencies {
  users: UserRepository;
  passwords: PasswordPort;
  tokens: TokenPort;
}
