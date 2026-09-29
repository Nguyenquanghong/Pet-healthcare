import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function prepareFixture(client, appRoot, config) {
  const before = await counts(client);
  if (Object.values(before).some((count) => count !== 0)) throw new Error(`Refusing nonempty synthetic DB: ${JSON.stringify(before)}`);
  const fixedTime = new Date("2026-09-01T00:00:00.000Z");
  const { signToken } = await import(pathToFileURL(join(resolve(appRoot), "backend", "dist", "src", "lib", "token.js")));
  const owners = [];
  for (let index = 0; index < config.owners; index++) {
    const ownerId = `phase2-owner-${String(index).padStart(3, "0")}`;
    const petId = `phase2-pet-${String(index).padStart(3, "0")}`;
    await client.user.create({ data: { id: ownerId, email: `phase2-${index}@example.test`, fullName: `Phase2 synthetic ${index}`, role: "owner", passwordHash: "synthetic-unused", passwordSalt: "synthetic-unused", createdAt: fixedTime, updatedAt: fixedTime } });
    await client.pet.create({ data: { id: petId, ownerId, name: `Synthetic pet ${index}`, species: "dog", allergies: [], qrToken: `phase2-qr-${index}`, createdAt: fixedTime, updatedAt: fixedTime } });
    for (let j = 0; j < config.businessPerOwner; j++) {
      await client.appointment.create({ data: { id: `phase2-appointment-${index}-${j}`, ownerId, petId, type: "general_checkup", serviceName: "Synthetic checkup", clinicName: "Phase2 test", appointmentDate: new Date(`2030-01-${String(j + 1).padStart(2, "0")}T00:00:00.000Z`), appointmentTime: "09:00", createdAt: fixedTime, updatedAt: fixedTime } });
      await client.medicalRecord.create({ data: { id: `phase2-medical-${index}-${j}`, ownerId, petId, doctorName: "Synthetic doctor", visitDate: new Date(`2025-01-${String(j + 1).padStart(2, "0")}T00:00:00.000Z`), title: "Synthetic visit", diagnosis: "Synthetic", treatment: "Synthetic", createdAt: fixedTime, updatedAt: fixedTime } });
      await client.hotelBooking.create({ data: { id: `phase2-hotel-${index}-${j}`, ownerId, petId, checkIn: new Date(`2031-01-${String(j + 1).padStart(2, "0")}T00:00:00.000Z`), checkOut: new Date(`2031-01-${String(j + 2).padStart(2, "0")}T00:00:00.000Z`), nights: 1, roomType: "standard", serviceKeys: [], totalAmount: 100000, createdAt: fixedTime, updatedAt: fixedTime } });
    }
    for (let j = 0; j < config.notificationsPerOwner; j++) {
      await client.notification.create({ data: { id: `phase2-notification-${index}-${j}`, recipientOwnerId: ownerId, recipientRole: "owner", type: "general", title: "Synthetic", message: `Owner ${index} message ${j}`, status: "sent", actionUrl: "/owner/notifications", createdAt: fixedTime, sentAt: fixedTime } });
    }
    owners.push({ ownerId, petId, token: signToken(ownerId, "owner") });
  }
  for (let j = 0; j < config.adminNotifications; j++) {
    await client.notification.create({ data: { id: `phase2-admin-${j}`, recipientRole: "admin", type: "general", title: "Synthetic admin", message: `Admin message ${j}`, actionUrl: "/admin/notifications", createdAt: fixedTime, sentAt: fixedTime } });
  }
  return { owners, counts: await counts(client), config };
}

export async function counts(client) {
  const [users, pets, appointments, medicalRecords, hotelBookings, notifications, ownerNotifications, adminNotifications] = await Promise.all([
    client.user.count(), client.pet.count(), client.appointment.count(), client.medicalRecord.count(), client.hotelBooking.count(), client.notification.count(),
    client.notification.count({ where: { recipientRole: "owner" } }), client.notification.count({ where: { recipientRole: "admin" } }),
  ]);
  return { users, pets, appointments, medicalRecords, hotelBookings, notifications, ownerNotifications, adminNotifications };
}
