import { Prisma, type PrismaClient } from "@prisma/client";
import type { BootstrapRepository, BootstrapSummary } from "../../application/ports/bootstrap.js";
import type { AppointmentRecord } from "../../application/ports/appointments.js";
import type { MedicalRecordValue } from "../../application/ports/medicalRecords.js";
import type { NotificationValue } from "../../application/ports/notifications.js";
import { emptyListData } from "./listsRepository.js";
import { notificationCategoryCounts } from "@nipopeto/contracts";
import { todayInVietnam } from "../../domain/validation.js";

type Tx = Prisma.TransactionClient;
type OwnerScope = { ownerId?: string };
type NotificationScope = { recipientRole: string } | { recipientOwnerId: string };

// The appointment, medical record and medical image queries of the dashboard summary, supplied by legacy (see
// legacy/infrastructure/persistence/clinicalSources.ts). Every method returns the Prisma call itself and is never
// `async`: Prisma runs a query when something awaits it, and the Promise.all in `load` starts the queries in its own order.
export interface ClinicalBootstrapSource {
  appointmentCount(tx: Tx, own: OwnerScope): Prisma.PrismaPromise<number>;
  medicalCount(tx: Tx, own: OwnerScope): Prisma.PrismaPromise<number>;
  imageCount(tx: Tx, ownerId: string | undefined, own: OwnerScope): Prisma.PrismaPromise<number>;
  appointmentStatus(tx: Tx, own: OwnerScope): Prisma.PrismaPromise<Array<{ status: string; _count: number }>>;
  todayCount(tx: Tx, own: OwnerScope, today: Date): Prisma.PrismaPromise<number>;
  // Today's appointments and the pending ones, started together.
  adminAppointments(tx: Tx, today: Date): Promise<[AppointmentRecord[], AppointmentRecord[]]>;
  ownerAppointments(tx: Tx, own: OwnerScope, today: Date): Prisma.PrismaPromise<AppointmentRecord[]>;
  medicalRecords(tx: Tx, own: OwnerScope, isAdmin: boolean): Prisma.PrismaPromise<MedicalRecordValue[]>;
}

// The notification queries of the summary, supplied by legacy; same rule: the Prisma call, not `async`.
export interface NotificationBootstrapSource {
  unread(tx: Tx, where: NotificationScope): Prisma.PrismaPromise<number>;
  count(tx: Tx, where: NotificationScope): Prisma.PrismaPromise<number>;
  types(tx: Tx, where: NotificationScope): Prisma.PrismaPromise<Array<{ type: string; _count: number }>>;
  hotelUpdates(tx: Tx, where: NotificationScope): Prisma.PrismaPromise<number>;
  latest(tx: Tx, where: NotificationScope): Prisma.PrismaPromise<NotificationValue[]>;
}

export class PrismaBootstrapRepository implements BootstrapRepository {
  constructor(private readonly client: PrismaClient,private readonly clinical?: ClinicalBootstrapSource,private readonly notifications?: NotificationBootstrapSource) {}
  async load(isAdmin: boolean, ownerId?: string, view: "session" | "dashboard" = "session") {
    return this.client.$transaction(async tx => {
      const data = emptyListData();
      const own = ownerId ? { ownerId } : {};
      const notificationsWhere = isAdmin ? { recipientRole: "admin" } : { recipientOwnerId: ownerId! };
      const summary: BootstrapSummary = { totals: { owners: 0, pets: 0, appointments: 0, medicalRecords: 0, medicalImages: 0, hotelBookings: 0, dailyCareNotes: 0, notifications: 0 }, species: {}, appointmentStatus: {}, hotelStatus: {}, notificationCategory: {}, unread: 0, todayAppointments: 0 };
      if(this.notifications)summary.unread = await this.notifications.unread(tx, notificationsWhere);
      if (ownerId) {
        data.owners = await tx.user.findMany({ where: { id: ownerId }, include: { pets: { select: { id: true }, take: 0 }, _count: { select: { pets: true } } } });
        data.pets = await tx.pet.findMany({ where: own, take: view === "dashboard" ? 6 : 20, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
        summary.totals.pets = await tx.pet.count({ where: own });
      }
      if (view === "dashboard") {
        const today = new Date(`${todayInVietnam()}T00:00:00Z`);
        const [owners, pets, appointments, hotels, medical, images, notes, notifications, species, appointmentStatus, hotelStatus, types, hotelUpdates, todayCount] = await Promise.all([
          tx.user.count({ where: isAdmin ? { role: "owner" } : { id: ownerId } }), tx.pet.count({ where: own }),
          this.clinical?this.clinical.appointmentCount(tx, own):Promise.resolve(0), tx.hotelBooking.count({ where: own }), this.clinical?this.clinical.medicalCount(tx, own):Promise.resolve(0),
          this.clinical?this.clinical.imageCount(tx, ownerId, own):Promise.resolve(0), tx.dailyCareNote.count({ where: ownerId ? { booking: own, visibleToOwner: true } : {} }),
          this.notifications?this.notifications.count(tx, notificationsWhere):Promise.resolve(0), tx.pet.groupBy({ by: ["species"], where: own, _count: true }),
          this.clinical?this.clinical.appointmentStatus(tx, own):Promise.resolve([]), tx.hotelBooking.groupBy({ by: ["status"], where: own, _count: true }),
          this.notifications?this.notifications.types(tx, notificationsWhere):Promise.resolve([]),
          this.notifications?this.notifications.hotelUpdates(tx, notificationsWhere):Promise.resolve(0), this.clinical?this.clinical.todayCount(tx, own, today):Promise.resolve(0),
        ]);
        summary.totals = { owners, pets, appointments, hotelBookings: hotels, medicalRecords: medical, medicalImages: images, dailyCareNotes: notes, notifications };
        summary.species = Object.fromEntries(species.map(row => [row.species, row._count]));
        summary.appointmentStatus = Object.fromEntries(appointmentStatus.map(row => [row.status, row._count]));
        summary.hotelStatus = Object.fromEntries(hotelStatus.map(row => [row.status, row._count]));
        summary.notificationCategory = notificationCategoryCounts(types.map(row => ({ type: row.type, count: row._count })), hotelUpdates);
        summary.todayAppointments = todayCount;
        if (isAdmin) {
          const [todayRows, pendingRows] = this.clinical?await this.clinical.adminAppointments(tx, today):[[],[]];
          data.appointments = [...new Map([...todayRows, ...pendingRows].map(row => [row.id, row])).values()];
          const [pending, active] = await Promise.all([
            tx.hotelBooking.findMany({ where: { status: "pending" }, take: 5, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
            tx.hotelBooking.findMany({ where: { status: "in_stay" }, take: 5, orderBy: [{ checkIn: "asc" }, { id: "asc" }] }),
          ]);
          data.hotelBookings = [...pending, ...active];
        } else {
          if(this.clinical)data.appointments = await this.clinical.ownerAppointments(tx, own, today);
          data.hotelBookings = await tx.hotelBooking.findMany({ where: { ...own, status: { in: ["in_stay", "confirmed"] } }, take: 5, orderBy: [{ checkIn: "asc" }, { id: "asc" }] });
        }
        if(this.clinical)data.medicalRecords = await this.clinical.medicalRecords(tx, own, isAdmin);
        if(this.notifications)data.notifications = await this.notifications.latest(tx, notificationsWhere);
        const ids = [...new Set([...data.appointments, ...data.hotelBookings, ...data.medicalRecords].map(row => row.petId))];
        const relatedPets = await tx.pet.findMany({ where: { id: { in: ids }, ...own } });
        data.pets = [...new Map([...data.pets, ...relatedPets].map(row => [row.id, row])).values()];
        if (isAdmin) data.owners = await tx.user.findMany({ where: { id: { in: [...new Set(data.pets.map(pet => pet.ownerId))] } }, include: { pets: { select: { id: true }, take: 0 } } });
      }
      return { ...data, summary };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
