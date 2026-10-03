import assert from "node:assert/strict";
import test from "node:test";
import { NotificationsService } from "../dist/src/application/services/notifications.js";

const owner = { sub: "owner-1", role: "owner" };
const staff = { sub: "staff-1", role: "staff" };

test("owner inbox is scoped and staff send is validated", async () => {
  const scopes = [];
  const sends = [];
  const service = new NotificationsService({
    list: async (scope) => { scopes.push(scope); return []; },
    send: async (data) => { sends.push(data); return { id: "n-1", ...data }; },
  });
  await service.list(owner);
  await service.list(staff);
  assert.deepEqual(scopes, [{ recipientOwnerId: "owner-1" }, { recipientRole: "admin" }]);
  await assert.rejects(service.send(owner, { recipientOwnerId: "owner-1", title: "Hello", message: "Hi" }), { status: 403 });
  await assert.rejects(service.send(staff, { recipientOwnerId: "owner-1", title: " ", message: "Hi" }), { status: 422 });
  await service.send(staff, { recipientOwnerId: "owner-1", title: " Hello ", message: " Hi " });
  assert.equal(sends[0].title, "Hello");
});

test("owner cannot mark another owner's notification", async () => {
  let ownerId;
  const service = new NotificationsService({
    findVisible: async (_id, scopedOwnerId) => { ownerId = scopedOwnerId; return null; },
    markRead: async () => { throw new Error("must not update"); },
  });
  await assert.rejects(service.markRead(owner, "n-2"), { status: 404 });
  assert.deepEqual(ownerId, { recipientOwnerId: "owner-1" });
});
