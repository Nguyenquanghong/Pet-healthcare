import type { PrismaClient } from '@prisma/client';
import { AppointmentInvoices } from '../application/services/appointmentInvoices.js';
import type { BillingRemote } from '../application/ports/appointmentBilling.js';
import { PrismaBillingOperationStore } from '../infrastructure/persistence/appointmentBillingRepository.js';

export class AppointmentInvoiceBilling extends AppointmentInvoices {
  constructor(db: PrismaClient, remote: BillingRemote) {
    super(new PrismaBillingOperationStore(db), remote);
  }
}
