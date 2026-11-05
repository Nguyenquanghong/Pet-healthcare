import type { AppointmentInvoiceSource } from '../../../infrastructure/persistence/invoiceRepository.js';

// The appointment side of invoice issuing, moved out of PrismaInvoiceRepository unchanged. It runs on the issuing
// transaction (`tx`), never on the client, so the row lock lasts until the invoice is written.
export const appointmentInvoiceSource: AppointmentInvoiceSource = async (tx, id) => {
  await tx.$queryRaw`SELECT id FROM appointments WHERE id = ${id} FOR UPDATE`;
  const item = await tx.appointment.findUnique({ where: { id } });
  return item
    ? {
        ownerId: item.ownerId,
        petId: item.petId,
        status: item.status,
        description: item.serviceName,
        serviceType: item.type,
      }
    : null;
};
