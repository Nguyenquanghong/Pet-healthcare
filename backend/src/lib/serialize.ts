import type { UserAccount } from "../application/ports/auth.js";
import type { AppointmentRecord } from "../application/ports/appointments.js";
import type { MedicalRecordValue } from "../application/ports/medicalRecords.js";
import type { CareNoteValue, HotelBookingValue } from "../application/ports/hotelBookings.js";
import type { PetValue } from "../application/ports/pets.js";

export const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

export function publicUser(user: UserAccount) {
  return {
    id: user.id,
    username: user.username ?? undefined,
    phone: user.phone ?? "",
    email: user.email ?? undefined,
    fullName: user.fullName,
    role: user.role,
    address: user.address ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
  };
}

export function ownerDto(user: UserAccount & { pets?: Array<{ id: string }> }) {
  return { ...publicUser(user), petIds: user.pets?.map((pet) => pet.id) ?? [] };
}

export function petDto(pet: PetValue) {
  return {
    id: pet.id,
    ownerId: pet.ownerId,
    name: pet.name,
    species: pet.species,
    breed: pet.breed ?? "",
    gender: pet.gender,
    ageLabel: pet.ageLabel ?? "",
    weightKg: pet.weightKg === null ? undefined : Number(pet.weightKg),
    microchipId: pet.microchipId ?? undefined,
    avatarUrl: pet.avatarUrl ?? undefined,
    healthStatus: pet.healthStatus,
    allergies: pet.allergies,
    notes: pet.notes ?? undefined,
    identifyingMarks: pet.identifyingMarks ?? undefined,
    lastSeenLocation: pet.lastSeenLocation ?? undefined,
    qrToken: pet.qrToken ?? undefined,
    qrEnabled: pet.qrEnabled,
    publicProfile: {
      showOwnerPhone: pet.showOwnerPhone,
      showOwnerEmail: pet.showOwnerEmail,
      showOwnerAddress: pet.showOwnerAddress,
      showMedicalAlerts: pet.showMedicalAlerts,
      rescueNote: pet.rescueNote ?? undefined,
    },
  };
}

export function publicPetDto(pet: PetValue) {
  return {
    id: pet.id,
    name: pet.name,
    species: pet.species,
    breed: pet.breed ?? "",
    gender: pet.gender,
    ageLabel: pet.ageLabel ?? "",
    microchipId: pet.microchipId ?? undefined,
    avatarUrl: pet.avatarUrl ?? undefined,
    identifyingMarks: pet.identifyingMarks ?? undefined,
    lastSeenLocation: pet.lastSeenLocation ?? undefined,
    qrEnabled: pet.qrEnabled,
    ...(pet.showMedicalAlerts ? { healthStatus: pet.healthStatus, allergies: pet.allergies } : {}),
    publicProfile: {
      showOwnerPhone: pet.showOwnerPhone,
      showOwnerEmail: pet.showOwnerEmail,
      showOwnerAddress: pet.showOwnerAddress,
      showMedicalAlerts: pet.showMedicalAlerts,
      rescueNote: pet.rescueNote ?? undefined,
    },
  };
}

export function appointmentDto(item: AppointmentRecord) {
  return { ...item, date: dateOnly(item.appointmentDate), time: item.appointmentTime, appointmentDate: undefined, appointmentTime: undefined };
}

export function medicalRecordDto(item: MedicalRecordValue) {
  return {
    ...item,
    visitDate: dateOnly(item.visitDate),
    followUpDate: item.followUpDate ? dateOnly(item.followUpDate) : undefined,
    weightKg: item.weightKg === null ? undefined : Number(item.weightKg),
    temperatureC: item.temperatureC === null ? undefined : Number(item.temperatureC),
  };
}

export function hotelBookingDto(item: HotelBookingValue) {
  return {
    ...item,
    checkIn: dateOnly(item.checkIn),
    checkOut: dateOnly(item.checkOut),
    totalAmount: Number(item.totalAmount),
    dailyCareNoteIds: item.dailyCareNotes?.map((note) => note.id) ?? [],
    dailyCareNotes: undefined,
  };
}

export function careNoteDto(item: CareNoteValue) {
  return { ...item, date: dateOnly(item.noteDate), noteDate: undefined };
}
