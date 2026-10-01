import type { Actor } from "../../domain/auth.js";
import { BusinessError } from "../../domain/error.js";
import type { OwnerRepository } from "../ports/owners.js";

export type CounterOwnerInput = { fullName?: unknown; phone?: unknown; email?: unknown; address?: unknown };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export class OwnersService {
  constructor(private readonly owners: OwnerRepository) {}
  async create(actor: Actor, input: CounterOwnerInput) {
    if (actor.role !== "admin" && actor.role !== "staff") throw new BusinessError(403, "Chỉ quản trị viên hoặc nhân viên được tạo khách tại quầy.");
    if ((input.email !== undefined && typeof input.email !== "string") || (input.address !== undefined && typeof input.address !== "string"))
      throw new BusinessError(422, "Email và địa chỉ phải là chuỗi ký tự.");
    const fullName = text(input.fullName);
    const digits = text(input.phone).replace(/[\s.()-]/g, "");
    const phone = /^\+?84\d{9}$/.test(digits) ? `0${digits.slice(-9)}` : digits;
    const email = text(input.email).toLowerCase();
    const address = text(input.address);
    if (!fullName || fullName.length > 100) throw new BusinessError(422, "Nhập họ tên khách (tối đa 100 ký tự).");
    if (!/^0\d{9}$/.test(phone)) throw new BusinessError(422, "Nhập số điện thoại Việt Nam gồm 10 chữ số hoặc dạng +84.");
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new BusinessError(422, "Email không hợp lệ.");
    if (address.length > 500) throw new BusinessError(422, "Địa chỉ tối đa 500 ký tự.");
    if (await this.owners.findByContact(phone, email || null))
      throw new BusinessError(409, "Đã có hồ sơ dùng số điện thoại hoặc email này. Hãy tìm và chọn khách đã có.");
    return this.owners.createCounterOwner({ fullName, phone, email: email || null, address: address || null });
  }
}
