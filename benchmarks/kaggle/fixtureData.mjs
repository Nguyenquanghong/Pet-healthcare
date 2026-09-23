export async function prepareSyntheticFixture(client, { count, seed, password, hashPassword, signToken }) {
  const users = [];
  for (let index = 0; index < count; index++) {
    const owner = await client.user.create({ data: {
      email: `load-${seed}-${index}@example.test`,
      fullName: `Synthetic owner ${index}`,
      role: "owner",
      ...hashPassword(password),
    } });
    const pet = await client.pet.create({ data: {
      ownerId: owner.id,
      name: `Synthetic pet ${index}`,
      species: "dog",
      allergies: [],
      qrEnabled: true,
      qrToken: `load-${seed}-${index}`,
    } });
    users.push({ token: signToken(owner.id, "owner"), petId: pet.id, qrToken: pet.qrToken });
  }
  return users;
}
