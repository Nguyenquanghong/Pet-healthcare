import type { PrismaClient } from "@prisma/client";
import type { UserRepository } from "../../application/ports/auth.js";

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly client: PrismaClient) {}
  findOwnerByEmail(email: string) {
    return this.client.user.findFirst({ where: { email, role: "owner" } });
  }
  findStaffByUsername(username: string) {
    return this.client.user.findFirst({ where: { username, role: { in: ["admin", "doctor", "staff"] } } });
  }
  findByEmail(email: string) {
    return this.client.user.findUnique({ where: { email } });
  }
  findById(id: string) {
    return this.client.user.findUnique({ where: { id } });
  }
  async hasOtherEmail(email: string, currentId: string) {
    return !!await this.client.user.findFirst({ where: { email, id: { not: currentId } }, select: { id: true } });
  }
  async hasOtherPhone(phone: string, currentId: string) {
    return !!await this.client.user.findFirst({ where: { phone, id: { not: currentId } }, select: { id: true } });
  }
  createOwner(data: Parameters<UserRepository["createOwner"]>[0]) {
    return this.client.user.create({ data: { ...data, role: "owner" } });
  }
  updateProfile(id: string, data: Parameters<UserRepository["updateProfile"]>[1]) {
    return this.client.user.update({ where: { id }, data });
  }
  async updatePassword(id: string, data: Parameters<UserRepository["updatePassword"]>[1]) {
    await this.client.user.update({ where: { id }, data });
  }
}
