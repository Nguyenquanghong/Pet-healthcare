import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "../dist/src/application/services/auth.js";

const user = { id: "owner-1", email: "owner@example.test", username: null, phone: null, passwordHash: "hash", passwordSalt: "salt", fullName: "Owner", role: "owner", address: null, avatarUrl: null, createdAt: new Date(), updatedAt: new Date() };
const actor = { sub: user.id, role: "owner" };

function fixture(overrides = {}) {
  let updatedPassword;
  const users = {
    findOwnerByEmail: async () => user,
    findStaffByUsername: async () => null,
    findByEmail: async () => null,
    findById: async () => user,
    hasOtherEmail: async () => false,
    hasOtherPhone: async () => false,
    createOwner: async (data) => ({ ...user, ...data }),
    updateProfile: async (_id, data) => ({ ...user, ...data }),
    updatePassword: async (_id, data) => { updatedPassword = data; },
    ...overrides,
  };
  return {
    service: new AuthService({ users, passwords: { verify: (password) => password === "valid-pass", hash: () => ({ passwordHash: "new-hash", passwordSalt: "new-salt" }) }, tokens: { sign: () => "test-token" } }),
    get updatedPassword() { return updatedPassword; },
  };
}

test("owner login normalizes email and rejects wrong password", async () => {
  let searched;
  const deps = fixture({ findOwnerByEmail: async (email) => { searched = email; return user; } });
  const result = await deps.service.ownerLogin({ email: " OWNER@EXAMPLE.TEST ", password: "valid-pass" });
  assert.equal(searched, "owner@example.test");
  assert.equal(result.token, "test-token");
  await assert.rejects(deps.service.ownerLogin({ email: user.email, password: "wrong" }), { status: 401 });
});

test("register detects duplicate email before create", async () => {
  const deps = fixture({ findByEmail: async () => user, createOwner: async () => { throw new Error("must not create"); } });
  await assert.rejects(deps.service.registerOwner({ email: user.email, password: "valid-pass", confirmPassword: "valid-pass" }), { status: 409 });
});

test("profile duplicate check and password validation retain responses", async () => {
  const deps = fixture({ hasOtherPhone: async () => true });
  await assert.rejects(deps.service.updateProfile(actor, { fullName: "Owner", email: user.email, phone: "123" }), { status: 409 });
  await assert.rejects(deps.service.changePassword(actor, { currentPassword: "valid-pass", newPassword: "short", confirmPassword: "short" }), { status: 422 });
  await deps.service.changePassword(actor, { currentPassword: "valid-pass", newPassword: "long-pass-2", confirmPassword: "long-pass-2" });
  assert.deepEqual(deps.updatedPassword, { passwordHash: "new-hash", passwordSalt: "new-salt" });
});
