import { Prisma, type PrismaClient, type AppointmentStatus, type PetSpecies, type PetHealthStatus, type HotelBookingStatus, type RoomType, type PaymentStatus } from "@prisma/client";
import type { ListsRepository, ListData, ListQuery, ListResource, ListScope } from "../../application/ports/lists.js";

export const emptyListData = (): ListData => ({ owners: [], pets: [], appointments: [], hotelBookings: [], medicalRecords: [], medicalImages: [], dailyCareNotes: [], notifications: [], invoices: [] });
const spaTypes = ["spa_bath", "spa_grooming", "spa_combo"] as const;
const notificationTypes: Record<string, string[]> = {
  appointments: ["appointment_created", "appointment_confirmed", "appointment_reminder", "appointment_cancelled", "appointment_rescheduled"],
  hotel: ["hotel_booking_created", "hotel_booking_confirmed", "hotel_booking_cancelled", "hotel_daily_update", "hotel_checked_out"],
  medical: ["medical_record_updated", "vaccination_reminder"], promo: ["promotion", "general"],
};

export class PrismaListsRepository implements ListsRepository {
  constructor(private readonly client: PrismaClient) {}
  async page(resource: ListResource, scope: ListScope, query: ListQuery) {
    return this.client.$transaction(async tx => {
      const data = emptyListData();
      const bounds = { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
      const ownerId = scope.ownerId ?? query.ownerId;
      const identity = { ...(query.id ? { id: query.id } : {}) };
      const owner = { ...(ownerId ? { ownerId } : {}), ...(query.petId ? { petId: query.petId } : {}) };
      const text = (field: string) => ({ [field]: { contains: query.q!, mode: "insensitive" as const } });
      const contact = (): Prisma.UserWhereInput => ({ OR: [text("fullName"), text("phone"), text("email"), text("id")] });
      const petSearch = (): Prisma.PetWhereInput => ({ OR: [text("name"), text("breed"), text("microchipId"), text("id"), { owner: contact() }] });
      const joinedSearch = () => query.q ? [{ pet: petSearch() }, { owner: contact() }] : [];
      let total = 0;
      let counts: Record<string, number> = {};
      if (resource === "owners") {
        const where: Prisma.UserWhereInput = { role: "owner", ...(ownerId ? { id: ownerId } : {}), ...identity, ...(query.q ? contact() : {}) };
        [total, data.owners] = await Promise.all([tx.user.count({ where }), tx.user.findMany({ where, ...bounds, include: { pets: { select: { id: true }, take: 0 }, _count: { select: { pets: true } } }, orderBy: [{ fullName: "asc" }, { id: "asc" }] })]);
      } else if (resource === "pets") {
        const where: Prisma.PetWhereInput = { ...(ownerId ? { ownerId } : {}), ...identity,
          ...(query.species ? { species: query.species as PetSpecies } : {}), ...(query.healthStatus ? { healthStatus: query.healthStatus as PetHealthStatus } : {}), ...(query.q ? petSearch() : {}) };
        [total, data.pets] = await Promise.all([tx.pet.count({ where }), tx.pet.findMany({ where, ...bounds, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })]);
      } else if (resource === "appointments") {
        const base: Prisma.AppointmentWhereInput = { ...owner, ...identity,
          ...(query.date ? { appointmentDate: new Date(`${query.date}T00:00:00Z`) } : {}),
          ...(query.category ? { type: query.category === "spa" ? { in: [...spaTypes] } : { notIn: [...spaTypes] } } : {}),
          ...(query.mode === "unbilled" ? { status: "completed", invoices: { none: {} } } : {}),
          ...(query.q ? { OR: [...joinedSearch(), text("serviceName"), text("id")] } : {}) };
        const groupStatuses: Record<string, AppointmentStatus[]> = { pending: ["pending", "confirmed", "checked_in", "in_progress"], completed: ["completed"], cancelled: ["cancelled", "no_show"] };
        const where: Prisma.AppointmentWhereInput = { AND: [base, ...(query.statusGroup ? [{ status: { in: groupStatuses[query.statusGroup] } }] : []), ...(query.status ? [{ status: query.status as AppointmentStatus }] : [])] };
        const groups = await tx.appointment.groupBy({ by: ["status"], where: base, _count: true });
        counts = Object.fromEntries(groups.map(group => [group.status, group._count]));
        [total, data.appointments] = await Promise.all([tx.appointment.count({ where }), tx.appointment.findMany({ where, ...bounds, orderBy: [{ status: "asc" }, { appointmentDate: "desc" }, { appointmentTime: "desc" }, { id: "desc" }] })]);
      } else if (resource === "hotelBookings") {
        const base: Prisma.HotelBookingWhereInput = { ...owner, ...identity,
          ...(query.roomType ? { roomType: query.roomType as RoomType } : {}),
          ...(query.mode === "unbilled" ? { status: { in: ["in_stay", "checked_out"] }, invoices: { none: {} } } : {}),
          ...(query.q ? { OR: [...joinedSearch(), text("id")] } : {}) };
        const where: Prisma.HotelBookingWhereInput = { AND: [base, ...(query.status ? [{ status: query.status as HotelBookingStatus }] : [])] };
        const groups = await tx.hotelBooking.groupBy({ by: ["status"], where: base, _count: true });
        counts = Object.fromEntries(groups.map(group => [group.status, group._count]));
        [total, data.hotelBookings] = await Promise.all([tx.hotelBooking.count({ where }), tx.hotelBooking.findMany({ where, ...bounds, include: { dailyCareNotes: { select: { id: true }, take: 0 } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }, { id: "desc" }] })]);
      } else if (resource === "medicalRecords") {
        const where: Prisma.MedicalRecordWhereInput = { ...owner, ...identity, ...(query.q ? { OR: [...joinedSearch(), text("title"), text("doctorName"), text("diagnosis")] } : {}) };
        [total, data.medicalRecords] = await Promise.all([tx.medicalRecord.count({ where }), tx.medicalRecord.findMany({ where, ...bounds, orderBy: [{ visitDate: "desc" }, { id: "desc" }] })]);
      } else if (resource === "medicalImages") {
        const where: Prisma.MedicalImageWhereInput = { ...identity, ...(scope.ownerId ? { pet: { ownerId: scope.ownerId } } : {}), ...(query.petId ? { petId: query.petId } : {}), ...(query.q ? { OR: [text("title"), { pet: petSearch() }] } : {}) };
        [total, data.medicalImages] = await Promise.all([tx.medicalImage.count({ where }), tx.medicalImage.findMany({ where, ...bounds, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })]);
      } else if (resource === "dailyCareNotes") {
        const where: Prisma.DailyCareNoteWhereInput = { ...identity, ...(scope.ownerId ? { booking: { ownerId: scope.ownerId }, visibleToOwner: true } : {}), ...(query.bookingId ? { bookingId: query.bookingId } : {}) };
        [total, data.dailyCareNotes] = await Promise.all([tx.dailyCareNote.count({ where }), tx.dailyCareNote.findMany({ where, ...bounds, orderBy: [{ noteDate: "desc" }, { id: "desc" }] })]);
      } else if (resource === "notifications") {
        const base: Prisma.NotificationWhereInput = { ...identity, ...(scope.ownerId ? { recipientOwnerId: scope.ownerId } : { recipientRole: scope.recipientRole ?? "admin" }),
          ...(query.category ? { type: { in: notificationTypes[query.category] } } : {}), ...(query.q ? { OR: [text("title"), text("message")] } : {}) };
        const where = { ...base, ...(query.status ? { status: query.status } : {}) };
        const groups = await tx.notification.groupBy({ by: ["status"], where: base, _count: true });
        counts = Object.fromEntries(groups.map(group => [group.status, group._count]));
        const types = await tx.notification.groupBy({ by: ["type"], where: { ...base, type: undefined }, _count: true });
        for (const type of types) { const category = Object.entries(notificationTypes).find(([, values]) => values.includes(type.type))?.[0]; if (category) counts[`category:${category}`] = (counts[`category:${category}`] ?? 0) + type._count; }
        counts["category:all"] = types.reduce((sum, row) => sum + row._count, 0);
        [total, data.notifications] = await Promise.all([tx.notification.count({ where }), tx.notification.findMany({ where, ...bounds, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })]);
      } else if (resource === "invoices") {
        const base: Prisma.InvoiceWhereInput = { ...owner, ...identity, ...(query.bookingId ? { hotelBookingId: query.bookingId } : {}),
          ...(query.q ? { OR: [...joinedSearch(), text("invoiceCode"), text("transferCode"), text("id")] } : {}) };
        const where = { ...base, ...(query.status ? { paymentStatus: query.status as PaymentStatus } : {}) };
        const groups = await tx.invoice.groupBy({ by: ["paymentStatus"], where: base, _count: true });
        counts = Object.fromEntries(groups.map(group => [group.paymentStatus, group._count]));
        [total, data.invoices] = await Promise.all([tx.invoice.count({ where }), tx.invoice.findMany({ where, ...bounds, include: { items: true }, orderBy: [{ issuedAt: "desc" }, { id: "desc" }] })]);
      }
      // Fetch only relations of rows on this page, instead of all owners/pets in the database.
      const rows = [...data.appointments, ...data.hotelBookings, ...data.medicalRecords, ...data.medicalImages, ...data.invoices];
      if (resource === "medicalRecords") data.appointments = await tx.appointment.findMany({ where: { id: { in: data.medicalRecords.flatMap(row => row.appointmentId ? [row.appointmentId] : []) }, ...(scope.ownerId ? { ownerId: scope.ownerId } : {}) } });
      if (resource === "hotelBookings" && data.hotelBookings.length) data.invoices = await tx.invoice.findMany({ where: { hotelBookingId: { in: data.hotelBookings.map(row => row.id) }, ...(scope.ownerId ? { ownerId: scope.ownerId } : {}) }, include: { items: true } });
      const petIds = [...new Set(rows.map(row => row.petId))];
      if (resource !== "pets" && petIds.length) data.pets = await tx.pet.findMany({ where: { id: { in: petIds }, ...(scope.ownerId ? { ownerId: scope.ownerId } : {}) } });
      const ownerIds = [...new Set([...data.pets.map(pet => pet.ownerId), ...data.appointments.map(row => row.ownerId), ...data.hotelBookings.map(row => row.ownerId), ...data.invoices.map(row => row.ownerId)])];
      if (resource !== "owners" && ownerIds.length) data.owners = await tx.user.findMany({ where: { id: { in: ownerIds }, ...(scope.ownerId ? { id: scope.ownerId } : {}) }, include: { pets: { select: { id: true }, take: 0 } } });
      return { data, total, counts };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async billingFigures(month?: string) {
    let range: { gte: Date; lt: Date } | undefined;
    if (month) {
      const [year, number] = month.split("-").map(Number);
      range = { gte: new Date(Date.UTC(year!, number! - 1, 1) - 7 * 3_600_000), lt: new Date(Date.UTC(year!, number!, 1) - 7 * 3_600_000) };
    }
    return this.client.$transaction(async tx => {
      const paid = await tx.invoice.groupBy({ by: ["type"], where: { paymentStatus: "paid", ...(range ? { paidAt: range } : {}) }, _sum: { totalAmount: true }, _count: true });
      const unpaid = await tx.invoice.aggregate({ where: { paymentStatus: "unpaid", ...(range ? { issuedAt: range } : {}) }, _sum: { totalAmount: true }, _count: true });
      const sum = (type?: string) => paid.filter(row => !type || row.type === type).reduce((total, row) => total + Number(row._sum.totalAmount ?? 0), 0);
      return { received: sum(), hotel: sum("hotel_booking"), appointment: sum("appointment"), outstanding: Number(unpaid._sum.totalAmount ?? 0), paidCount: paid.reduce((total, row) => total + row._count, 0), unpaidCount: unpaid._count };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async calendar(scope: ListScope, month: string, category?: string) {
    const [year, number] = month.split("-").map(Number);
    const rows = await this.client.appointment.groupBy({ by: ["appointmentDate"], where: {
      ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
      ...(category ? { type: category === "spa" ? { in: [...spaTypes] } : { notIn: [...spaTypes] } } : {}),
      appointmentDate: { gte: new Date(Date.UTC(year!, number! - 1, 1)), lt: new Date(Date.UTC(year!, number!, 1)) },
    }, _count: true });
    return Object.fromEntries(rows.map(row => [row.appointmentDate.toISOString().slice(0, 10), row._count]));
  }
}
