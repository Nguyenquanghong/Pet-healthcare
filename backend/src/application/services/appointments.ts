import { BusinessError } from "../../domain/error.js";
import type { Actor } from "../../domain/auth.js";
import {
  appointmentStatuses, appointmentTypes,
  type AppointmentDependencies, type AppointmentRecord, type AppointmentStatus, type AppointmentType,
} from "../ports/appointments.js";

export type CreateAppointmentInput = {
  petId?: string; type?: string; date?: string; time?: string; serviceName?: string;
  doctorId?: string; clinicName?: string; ownerNote?: string;
};
export type RescheduleInput = { date?: string; time?: string; ownerNote?: string | null };
export type StatusInput = { status?: string; internalNote?: string | null };
export type CancelInput = { ownerNote?: string };

const spaTypes = new Set<string>(["spa_bath", "spa_grooming", "spa_combo"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return datePattern.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function appointmentDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export class AppointmentService {
  constructor(private readonly deps: AppointmentDependencies) {}

  list(actor: Actor, requestedOwnerId?: string) {
    const ownerId = actor.role === "owner" ? actor.sub : requestedOwnerId;
    return this.deps.appointments.list(ownerId);
  }

  async create(actor: Actor, input: CreateAppointmentInput): Promise<AppointmentRecord> {
    const pet = await this.deps.appointments.findPet(String(input.petId || ""));
    if (!pet) throw new BusinessError(404, "Pet not found.");
    if (actor.role === "owner" && pet.ownerId !== actor.sub) throw new BusinessError(403, "You cannot book for this pet.");
    const type = String(input.type || "other");
    const date = String(input.date || "");
    const time = String(input.time || "");
    const serviceName = String(input.serviceName || "").trim();
    if (!date || !time || !serviceName) throw new BusinessError(422, "Pet, service, date, and time are required.");
    if (!appointmentTypes.includes(type as AppointmentType)) throw new BusinessError(422, "Select a valid appointment service.");
    if (!validDate(date)) throw new BusinessError(422, "Enter a valid appointment date.");
    if (!timePattern.test(time)) throw new BusinessError(422, "Enter a valid appointment time.");
    if (date < new Date().toISOString().slice(0, 10)) throw new BusinessError(422, "The appointment date cannot be in the past.");
    if (await this.deps.appointments.hasSlot(pet.id, appointmentDate(date), time)) throw new BusinessError(409, "This pet already has an appointment at the selected time.");

    return this.deps.unitOfWork.run(async ({ appointments, notifications }) => {
      const created = await appointments.create({
        petId: pet.id, ownerId: pet.ownerId, doctorId: input.doctorId || null,
        type: type as AppointmentType, serviceName,
        clinicName: String(input.clinicName || "Nippon Pet Care"),
        appointmentDate: appointmentDate(date), appointmentTime: time,
        ownerNote: input.ownerNote?.trim() || null,
        createdBy: actor.role === "owner" ? "owner" : "staff",
      });
      const serviceKind = spaTypes.has(type) ? "spa booking" : "appointment";
      await notifications.create({
        recipientRole: "admin", type: "appointment_created",
        title: spaTypes.has(type) ? "New spa booking" : "New appointment",
        message: `${pet.name} has a new ${serviceKind} on ${date} at ${time}.`,
        actionUrl: "/admin/appointments", relatedPetId: pet.id, relatedAppointmentId: created.id,
      });
      return created;
    });
  }

  async changeStatus(actor: Actor, id: string, input: StatusInput): Promise<AppointmentRecord> {
    if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
    const status = String(input.status || "");
    if (!appointmentStatuses.includes(status as AppointmentStatus)) throw new BusinessError(422, "Select a valid appointment status.");
    const existing = await this.deps.appointments.findWithPet(id);
    if (!existing) throw new BusinessError(404, "Appointment not found.");
    return this.deps.unitOfWork.run(async ({ appointments, notifications }) => {
      const updated = await appointments.update(existing.appointment.id, {
        status: status as AppointmentStatus,
        internalNote: input.internalNote ?? existing.appointment.internalNote,
      });
      const isSpa = spaTypes.has(existing.appointment.type);
      await notifications.create({
        recipientOwnerId: existing.appointment.ownerId, recipientRole: "owner", type: `appointment_${status}`,
        title: isSpa ? "Spa booking updated" : "Appointment updated",
        message: `${existing.pet.name}'s ${isSpa ? "spa booking" : "appointment"} is now ${status}.`,
        actionUrl: isSpa ? "/owner/spa-booking" : "/owner/appointments",
        relatedPetId: existing.appointment.petId, relatedAppointmentId: existing.appointment.id,
      });
      return updated;
    });
  }

  async reschedule(actor: Actor, id: string, input: RescheduleInput): Promise<AppointmentRecord> {
    const existing = await this.deps.appointments.find(id);
    if (!existing) throw new BusinessError(404, "Appointment not found.");
    if (actor.role === "owner" && existing.ownerId !== actor.sub) throw new BusinessError(403, "You cannot reschedule this appointment.");
    const date = String(input.date || "");
    const time = String(input.time || "");
    if (!validDate(date)) throw new BusinessError(422, "Enter a valid appointment date.");
    if (!timePattern.test(time)) throw new BusinessError(422, "Enter a valid appointment time.");
    if (date < new Date().toISOString().slice(0, 10)) throw new BusinessError(422, "The appointment date cannot be in the past.");
    if (await this.deps.appointments.hasSlot(existing.petId, appointmentDate(date), time, existing.id)) throw new BusinessError(409, "This pet already has an appointment at the selected time.");
    return this.deps.unitOfWork.run(async ({ appointments, notifications }) => {
      const updated = await appointments.update(existing.id, {
        appointmentDate: appointmentDate(date), appointmentTime: time,
        ownerNote: input.ownerNote ?? existing.ownerNote, status: "pending",
      });
      await notifications.create({
        recipientRole: "admin", type: "appointment_rescheduled",
        title: spaTypes.has(existing.type) ? "Spa booking rescheduled" : "Appointment rescheduled",
        message: `${existing.serviceName} was moved to ${date} at ${time}.`,
        actionUrl: "/admin/appointments", relatedPetId: existing.petId, relatedAppointmentId: existing.id,
      });
      return updated;
    });
  }

  async cancel(actor: Actor, id: string, input: CancelInput): Promise<AppointmentRecord> {
    const existing = await this.deps.appointments.find(id);
    if (!existing) throw new BusinessError(404, "Appointment not found.");
    if (actor.role === "owner" && existing.ownerId !== actor.sub) throw new BusinessError(403, "You cannot cancel this appointment.");
    return this.deps.appointments.update(existing.id, {
      status: "cancelled",
      ownerNote: input.ownerNote ? `Cancellation reason: ${input.ownerNote}` : existing.ownerNote,
    });
  }

  async sendReminder(actor: Actor, id: string): Promise<void> {
    if (actor.role === "owner") throw new BusinessError(403, "Staff access is required.");
    const item = await this.deps.appointments.findWithPet(id);
    if (!item) throw new BusinessError(404, "Appointment not found.");
    const isSpa = spaTypes.has(item.appointment.type);
    await this.deps.notifications.create({
      recipientOwnerId: item.appointment.ownerId, recipientRole: "owner", type: "appointment_reminder",
      title: isSpa ? "Spa booking reminder" : "Appointment reminder",
      message: `${item.pet.name} has a ${isSpa ? "spa booking" : "appointment"} at ${item.appointment.appointmentTime}.`,
      actionUrl: isSpa ? "/owner/spa-booking" : "/owner/appointments",
      relatedPetId: item.appointment.petId, relatedAppointmentId: item.appointment.id,
    });
  }
}
