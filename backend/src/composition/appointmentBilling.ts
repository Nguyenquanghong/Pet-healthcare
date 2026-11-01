import type { PrismaClient } from '@prisma/client';
import { AppointmentInvoices } from '../application/services/appointmentInvoices.js';
import type { BillingRemote } from '../application/ports/appointmentBilling.js';
import { PrismaBillingOperationStore } from '../infrastructure/persistence/appointmentBillingRepository.js';
import { invoiceDto } from '../lib/serialize.js';

// The saga over Prisma. Until the routes map the invoice themselves, the result of a finished operation is shaped here.
export class AppointmentInvoiceBilling extends AppointmentInvoices {
  constructor(db: PrismaClient, remote: BillingRemote) {
    super(new PrismaBillingOperationStore(db), remote, invoiceDto);
  }
}
