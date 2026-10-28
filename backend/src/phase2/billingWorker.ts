import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { delay, reconnect, startWorker } from '@nipopeto/messaging';
import { asymmetricConfig } from '../lib/token.js';
import { AppointmentInvoiceBilling, ClinicBillingRemote } from './appointmentBilling.js';
import { prismaClient, serviceOrigin } from '@nipopeto/runtime';
const db = prismaClient(PrismaClient);
await startWorker('core-billing', async signal => {
  try {
    const url = process.env.CLINIC_SERVICE_URL,
      credential = process.env.CLINIC_BILLING_TOKEN ?? process.env.CLINIC_SERVICE_TOKEN;
    if (process.env.PHASE2_RUNTIME_REQUIRED === '1' && !asymmetricConfig()?.keyId)
      throw new Error('BILLING_SIGNING_KEY_ID_REQUIRED');
    if (!url || !credential || credential.length < 32 || credential.length > 512 || !asymmetricConfig()?.privateKey)
      throw new Error('BILLING_RUNTIME_CONFIGURATION_REQUIRED');
    const target = serviceOrigin(url, 'INVALID_CLINIC_SERVICE_URL');
    await db.$connect();
    const worker = randomUUID(),
      billing = new AppointmentInvoiceBilling(db, new ClinicBillingRemote(target, credential));
    process.stdout.write(JSON.stringify({ service: 'core-billing', status: 'worker-ready' }) + '\n');
    await reconnect('core-billing', signal, async () => {
      while (!signal.aborted) {
        await billing.reconcileOnce(worker, 8, process.env.BILLING_OPERATION_ID);
        await delay(500, signal);
      }
    });
  } finally {
    await db.$disconnect();
  }
});
