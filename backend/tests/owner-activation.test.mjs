import assert from "node:assert/strict";
import test from "node:test";
import { OwnerActivationService } from "../dist/src/application/services/ownerActivation.js";
import { activationTokenAdapter } from "../dist/src/infrastructure/security/activationToken.js";

const staff = { sub: "staff-id", role: "staff" };
function fixture() {
  const owner = { id: "existing-owner", role: "owner", fullName: "Khách tại quầy", email: null, loginEnabled: false };
  let now = new Date("2026-10-01T00:00:00Z"), taken = false, credentials = null;
  const invitations = [];
  const repository = {
    findInvitation: async hash => invitations.find(item => item.tokenHash === hash) || null,
    run: async (id, work) => {
      assert.equal(id, owner.id);
      return work({ owner, emailTaken: async () => taken,
        findInvitation: repository.findInvitation,
        revokePending: async time => invitations.forEach(item => { if (!item.usedAt && !item.revokedAt) item.revokedAt = time; }),
        createInvitation: async data => invitations.push({ id: String(invitations.length), ownerId: owner.id, owner, usedAt: null, revokedAt: null, ...data }),
        setCredentials: async (email, data) => { credentials = data; owner.email = email; owner.loginEnabled = true; },
        markUsed: async (id, time) => { invitations.find(item => item.id === id).usedAt = time; },
      });
    },
  };
  const service = new OwnerActivationService(repository, activationTokenAdapter, {
    hash: password => ({ passwordHash: `hashed:${password}`, passwordSalt: "unique-salt" }),
  }, () => now);
  return { service, owner, invitations, get credentials() { return credentials; }, advance: ms => { now = new Date(now.getTime() + ms); }, takeEmail: () => { taken = true; } };
}

test("activation issue requires a verified customer, staff role and valid email", async () => {
  const { service, invitations } = fixture();
  for (const role of ["owner", "doctor"]) await assert.rejects(service.issue({ sub: "x", role }, "existing-owner", { email: "a@example.test", customerVerified: true }), { status: 403 });
  for (const input of [{}, { email: "a@example.test" }, { email: "bad", customerVerified: true }, { email: "a@example.test", customerVerified: "true" }])
    await assert.rejects(service.issue(staff, "existing-owner", input), { status: 422 });
  assert.equal(invitations.length, 0);
});

test("issue stores only a digest, expires in 30 minutes, and reissue revokes the old token", async () => {
  const { service, owner, invitations } = fixture();
  const first = await service.issue(staff, owner.id, { email: " CUSTOMER@EXAMPLE.TEST ", customerVerified: true });
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invitations[0].tokenHash, activationTokenAdapter.hash(first.token));
  assert.equal(invitations[0].token, undefined);
  assert.equal(first.expiresAt, "2026-10-01T00:30:00.000Z");
  assert.equal(owner.email, null);
  assert.equal(owner.loginEnabled, false);
  const second = await service.issue(staff, owner.id, { email: "customer@example.test", customerVerified: true });
  assert.notEqual(second.token, first.token);
  await assert.rejects(service.inspect({ token: first.token }), { status: 422 });
  assert.deepEqual(await service.inspect({ token: second.token }), { email: "customer@example.test", expiresAt: second.expiresAt });
});

test("expired and malformed activation tokens cannot change credentials", async () => {
  const f = fixture();
  const invitation = await f.service.issue(staff, f.owner.id, { email: "a@example.test", customerVerified: true });
  f.advance(30 * 60_000);
  for (const token of [undefined, {}, "", "x".repeat(43), invitation.token]) {
    await assert.rejects(f.service.inspect({ token }), { status: 422 });
    await assert.rejects(f.service.activate({ token, password: "secure123", confirmPassword: "secure123" }), { status: 422 });
  }
  assert.equal(f.credentials, null);
});

test("customer sets a password on the same profile; the consumed token cannot reset it", async () => {
  const f = fixture();
  const { token } = await f.service.issue(staff, f.owner.id, { email: "customer@example.test", customerVerified: true });
  for (const input of [{ password: "short", confirmPassword: "short" }, { password: "x".repeat(129), confirmPassword: "x".repeat(129) }, { password: "secure123", confirmPassword: "different" }])
    await assert.rejects(f.service.activate({ token, ...input }), { status: 422 });
  const result = await f.service.activate({ token, password: "secure123", confirmPassword: "secure123" });
  assert.equal(result.token, undefined);
  assert.equal(f.owner.id, "existing-owner");
  assert.equal(f.owner.email, "customer@example.test");
  assert.equal(f.credentials.passwordHash, "hashed:secure123");
  assert.ok(f.invitations[0].usedAt);
  await assert.rejects(f.service.activate({ token, password: "overwrite123", confirmPassword: "overwrite123" }), { status: 422 });
  await assert.rejects(f.service.issue(staff, f.owner.id, { email: "new@example.test", customerVerified: true }), { status: 409 });
  assert.equal(f.credentials.passwordHash, "hashed:secure123");
});

test("email conflicts block issue or activation without consuming the invitation", async () => {
  const f = fixture();
  const { token } = await f.service.issue(staff, f.owner.id, { email: "a@example.test", customerVerified: true });
  f.takeEmail();
  await assert.rejects(f.service.issue(staff, f.owner.id, { email: "a@example.test", customerVerified: true }), { status: 409 });
  assert.equal(f.invitations[0].revokedAt, null);
  await assert.rejects(f.service.activate({ token, password: "secure123", confirmPassword: "secure123" }), { status: 409 });
  assert.equal(f.credentials, null);
  assert.equal(f.invitations[0].usedAt, null);
});
