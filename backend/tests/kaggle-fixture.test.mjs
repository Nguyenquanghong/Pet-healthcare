import assert from "node:assert/strict";
import test from "node:test";
import { prepareSyntheticFixture } from "../../benchmarks/kaggle/fixtureData.mjs";

test("Kaggle prepares 100 synthetic owners outside the rate-limited auth API", async () => {
  const owners = [];
  const pets = [];
  const client = {
    user: { create: async ({ data }) => {
      owners.push(data);
      return { id: `owner-${owners.length}`, ...data };
    } },
    pet: { create: async ({ data }) => {
      pets.push(data);
      return { id: `pet-${pets.length}`, ...data };
    } },
  };
  const fixture = await prepareSyntheticFixture(client, {
    count: 100, seed: "phase1", password: "synthetic",
    hashPassword: () => ({ passwordHash: "hash", passwordSalt: "salt" }),
    signToken: (id, role) => `${role}:${id}`,
  });
  assert.equal(owners.length, 100);
  assert.equal(pets.length, 100);
  assert.equal(fixture.length, 100);
  assert.equal(fixture[0].token, "owner:owner-1");
  assert.equal(fixture[99].qrToken, "load-phase1-99");
  assert.ok(pets.every((pet, index) => pet.ownerId === `owner-${index + 1}`));
});
