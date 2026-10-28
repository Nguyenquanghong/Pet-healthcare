import type { UserAccount } from "../application/ports/auth.js";
import type { AppointmentRecord } from "../application/ports/appointments.js";
import type { MedicalRecordValue } from "../application/ports/medicalRecords.js";
import type { CareNoteValue, HotelBookingValue } from "../application/ports/hotelBookings.js";
import type { PetValue } from "../application/ports/pets.js";
import type { InvoiceValue } from "../application/ports/invoices.js";
import { allowedActions, permissionsFor } from "@nipopeto/contracts";
import type { Actor } from "../domain/auth.js";

// Who reads a booking: owners get the owner view; everyone gets the actions their
// permissions allow (P01 allowedActions; the server still checks each one).
export type Viewer = Pick<Actor, "role" | "sub">;

export const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

function publicUser(user: UserAccount) {
  return {
    id: user.id,
    username: user.username ?? undefined,
    phone: user.phone ?? "",
    email: user.email ?? undefined,
    fullName: user.fullName,
    role: user.role,
    address: user.address ?? undefined,
    avatarUrl: user.avatarUrl ?? undefined,
    ...(user.directoryRevision?{directoryVersion:user.directoryRevision}:{}),
  };
}
// AQ-05: the signed-in user also gets what the matrix lets them do, so clients hide
// actions instead of hard-coding roles. Every request is still checked server-side.
export function sessionUser(user: UserAccount) {
  return { ...publicUser(user), permissions: permissionsFor(user.role) };
}

export function ownerDto(user: UserAccount & { pets?: Array<{ id: string }>; _count?: { pets: number } }) {
  return { ...publicUser(user), petIds: user.pets?.map((pet) => pet.id) ?? [], ...(user._count ? { petCount: user._count.pets } : {}), loginEnabled: Boolean(user.passwordHash && user.passwordSalt) };
}

export function petDto(pet: PetValue) {
  return {
    id: pet.id,
    ownerId: pet.ownerId,
    ...(pet.directoryRevision?{directoryVersion:pet.directoryRevision}:{}),
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

export function appointmentDto(item: AppointmentRecord, viewer: Viewer) {
  const { internalNote, ...visible } = item, owner = viewer.role === "owner";
  return { ...visible, ...(owner ? {} : { internalNote }), date: dateOnly(item.appointmentDate), time: item.appointmentTime, appointmentDate: undefined, appointmentTime: undefined,
    allowedActions: allowedActions("appointment", item.status, viewer.role, owner && item.ownerId === viewer.sub) };
}

export function medicalRecordDto(item: MedicalRecordValue, owner = false) {
  const { internalNote, ...visible } = item;
  return {
    ...visible, ...(owner ? {} : { internalNote }),
    visitDate: dateOnly(item.visitDate),
    followUpDate: item.followUpDate ? dateOnly(item.followUpDate) : undefined,
    weightKg: item.weightKg === null ? undefined : Number(item.weightKg),
    temperatureC: item.temperatureC === null ? undefined : Number(item.temperatureC),
  };
}

export function hotelBookingDto(item: HotelBookingValue, viewer: Viewer) {
  const { internalNote, ...visible } = item, owner = viewer.role === "owner";
  return {
    ...visible, ...(owner ? {} : { internalNote }),
    checkIn: dateOnly(item.checkIn),
    checkOut: dateOnly(item.checkOut),
    totalAmount: Number(item.totalAmount),
    dailyCareNoteIds: item.dailyCareNotes?.map((note) => note.id) ?? [],
    dailyCareNotes: undefined,
    allowedActions: allowedActions("hotel", item.status, viewer.role, owner && item.ownerId === viewer.sub),
  };
}

// One invoice wire shape for every route (lists, invoice actions, Phase 2 billing
// operations): Decimal amounts become numbers, line items always present.
export function invoiceDto(item: InvoiceValue & { sourceSnapshot?: unknown }) {
  return { ...item, transferContent: item.transferCode || item.invoiceCode.replaceAll("-", ""), subtotal: Number(item.subtotal), taxAmount: Number(item.taxAmount),
    discountAmount: Number(item.discountAmount), totalAmount: Number(item.totalAmount),
    items: item.items?.map(line => ({ ...line, unitPrice: Number(line.unitPrice), amount: Number(line.amount) })) ?? [] };
}

export function careNoteDto(item: CareNoteValue) {
  return { ...item, date: dateOnly(item.noteDate), noteDate: undefined };
}
