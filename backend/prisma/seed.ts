import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ownerPassword = { passwordHash: "2AaUO5pi+D5fOIXcKJSLzJYmMZFmJ0whrUQyh4Tz9DM=", passwordSalt: "bmlwb25ldG8tZGVtby1vd25lci1zYWx0" };
const adminPassword = { passwordHash: "Csbdv6XeLCUGafp03chOaooQPLVl+OhEPT/B+/Jic30=", passwordSalt: "bmlwb25ldG8tZGVtby1hZG1pbi1zYWx0" };

async function main() {
  await prisma.user.upsert({ where: { id: "owner_1" }, update: ownerPassword, create: { id: "owner_1", email: "owner@example.com", phone: "0901234567", fullName: "Nguyen Van A", role: "owner", address: "My Dinh, Ha Noi", ...ownerPassword } });
  await prisma.user.upsert({ where: { id: "staff_admin" }, update: adminPassword, create: { id: "staff_admin", username: "admin", phone: "0999888777", fullName: "NIPOPETO Admin", role: "admin", ...adminPassword } });
  await prisma.user.upsert({ where: { id: "doctor_mai" }, update: adminPassword, create: { id: "doctor_mai", username: "dr.mai", phone: "0912345678", fullName: "Dr. Mai Nguyen", role: "doctor", ...adminPassword } });

  await prisma.pet.upsert({ where: { id: "pet_mochi" }, update: {}, create: { id: "pet_mochi", ownerId: "owner_1", name: "Mochi", species: "dog", breed: "Shiba Inu", gender: "male", ageLabel: "2 tuoi", healthStatus: "healthy", allergies: [], qrToken: "mochi-rescue-demo", qrEnabled: true, rescueNote: "Please keep Mochi safe and contact me." } });
  await prisma.pet.upsert({ where: { id: "pet_yuki" }, update: {}, create: { id: "pet_yuki", ownerId: "owner_1", name: "Yuki", species: "dog", breed: "Shiba Inu", gender: "female", ageLabel: "1 tuoi", healthStatus: "stable", allergies: ["Beef"], qrToken: "yuki-rescue-demo", qrEnabled: true } });

  await prisma.appointment.upsert({ where: { id: "appointment_1" }, update: {}, create: { id: "appointment_1", petId: "pet_mochi", ownerId: "owner_1", doctorId: "doctor_mai", type: "general_checkup", serviceName: "General checkup", clinicName: "Nippon Pet Care", appointmentDate: new Date("2026-11-02T00:00:00.000Z"), appointmentTime: "09:00", status: "confirmed", createdBy: "owner" } });
  await prisma.medicalRecord.upsert({ where: { id: "record_1" }, update: {}, create: { id: "record_1", petId: "pet_mochi", ownerId: "owner_1", appointmentId: "appointment_1", doctorName: "Dr. Mai Nguyen", visitDate: new Date("2026-10-28T00:00:00.000Z"), title: "Annual Checkup & Vaccination", symptoms: "Routine examination.", diagnosis: "Stable health.", treatment: "Booster vaccination and nutrition advice.", medications: "Multivitamin for 7 days", vaccineName: "DHPPi + Lepto", followUpDate: new Date("2027-04-28T00:00:00.000Z"), weightKg: 8.4, temperatureC: 38.2, heartRateBpm: 92 } });
  await prisma.hotelBooking.upsert({ where: { id: "booking_1" }, update: {}, create: { id: "booking_1", petId: "pet_yuki", ownerId: "owner_1", checkIn: new Date("2026-11-10T00:00:00.000Z"), checkOut: new Date("2026-11-13T00:00:00.000Z"), nights: 3, roomType: "deluxe", serviceKeys: ["special_diet"], totalAmount: 2_070_000, status: "pending", ownerNote: "Low-sodium diet." } });
}

main().finally(() => prisma.$disconnect());
