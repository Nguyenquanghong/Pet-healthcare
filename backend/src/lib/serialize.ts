import type { Appointment, DailyCareNote, HotelBooking, MedicalRecord, Pet, User } from "@prisma/client";

export const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

export function publicUser(user: User) {
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

export function ownerDto(user: User & { pets?: Array<{ id: string }> }) {
  return { ...publicUser(user), petIds: user.pets?.map((pet) => pet.id) ?? [] };
}

export function petDto(pet: Pet) {
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

export function appointmentDto(item: Appointment) {
  return { ...item, date: dateOnly(item.appointmentDate), time: item.appointmentTime, appointmentDate: undefined, appointmentTime: undefined };
}

export function medicalRecordDto(item: MedicalRecord) {
  return {
    ...item,
    visitDate: dateOnly(item.visitDate),
    followUpDate: item.followUpDate ? dateOnly(item.followUpDate) : undefined,
    weightKg: item.weightKg === null ? undefined : Number(item.weightKg),
    temperatureC: item.temperatureC === null ? undefined : Number(item.temperatureC),
  };
}

export function hotelBookingDto(item: HotelBooking & { dailyCareNotes?: Array<{ id: string }> }) {
  return {
    ...item,
    checkIn: dateOnly(item.checkIn),
    checkOut: dateOnly(item.checkOut),
    totalAmount: Number(item.totalAmount),
    dailyCareNoteIds: item.dailyCareNotes?.map((note) => note.id) ?? [],
    dailyCareNotes: undefined,
  };
}

export function careNoteDto(item: DailyCareNote) {
  return { ...item, date: dateOnly(item.noteDate), noteDate: undefined };
}
