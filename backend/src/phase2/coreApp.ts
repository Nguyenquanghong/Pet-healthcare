import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';
import { asymmetricConfig, verifyToken } from '../lib/token.js';
import { mountDirectory } from './directoryApi.js';
import { mountAppointmentBilling } from './billingApi.js';
import { mountDashboards } from './dashboardApi.js';
import { coreRuntime } from './runtime.js';
import { createCoreDomains } from './coreDomains.js';
import { credential } from '@nipopeto/runtime';
import { serviceProxy } from './serviceProxy.js';
import { allows, deniedMessage } from '@nipopeto/contracts';
import { createAuthRouter } from '../routes/auth.js';
import { AuthService } from '../application/services/auth.js';
import { OwnerActivationService } from '../application/services/ownerActivation.js';
import { PrismaUserRepository } from '../infrastructure/persistence/userRepository.js';
import { PrismaOwnerActivationRepository } from '../infrastructure/persistence/ownerActivationRepository.js';
import { activationTokenAdapter } from '../infrastructure/security/activationToken.js';
import { passwordAdapter, tokenAdapter } from '../infrastructure/security/authAdapters.js';
import { currentAccount } from './currentAccount.js';

// Paths the gateway forwards to Clinic; the proxy checks them again after resolving the URL.
const clinicPrefixes = ['/api/appointments', '/api/medical-records', '/api/dashboard/clinic'] as const;

// Keep the user's app.ts intact. This composition owns the split service route
// and the private Core authorization endpoint before mounting existing domains.
export function createCoreApp(db: PrismaClient, config: {notificationUrl?:string;notificationToken?:string;clinicUrl?:string;clinicToken?:string;directoryToken?:string;evidenceToken?:string} = {
  notificationUrl: process.env.NOTIFICATION_SERVICE_URL,
  notificationToken: process.env.CORE_NOTIFICATION_SEND_TOKEN??process.env.NOTIFICATION_SERVICE_TOKEN,
  clinicUrl:process.env.CLINIC_SERVICE_URL,
  clinicToken:process.env.CLINIC_BILLING_TOKEN??process.env.CLINIC_SERVICE_TOKEN,
  directoryToken:process.env.CORE_DIRECTORY_TOKEN,
  evidenceToken:process.env.CORE_BILLING_EVIDENCE_TOKEN,
}) {
  const app = express(); app.disable('x-powered-by');
  const origins = process.env.CORS_ORIGIN?.split(',').map(value => value.trim()).filter(Boolean);
  app.use(helmet()); app.use(cors({ origin: origins?.length ? origins : false, credentials: true, exposedHeaders:['X-Clinic-Read-Token','X-Clinic-Read-Source','X-Clinic-Projection-Generation','X-Service-Degraded','Retry-After'] }));
  const jwt = asymmetricConfig();
  if(process.env.PHASE2_RUNTIME_REQUIRED==='1'){
    if(!jwt?.privateKey||!jwt.keyId)throw new Error('CORE_RSA_SIGNING_CONFIGURATION_REQUIRED');
    const scoped=['CORE_DIRECTORY_TOKEN','CORE_BILLING_EVIDENCE_TOKEN','CLINIC_BILLING_TOKEN','CLINIC_BOOTSTRAP_TOKEN','CORE_NOTIFICATION_SEND_TOKEN'].map(credential);
    if(new Set(scoped).size!==scoped.length)throw new Error('DISTINCT_SERVICE_CREDENTIALS_REQUIRED');
    if(!config.clinicUrl||!config.notificationUrl)throw new Error('SPLIT_SERVICE_URLS_REQUIRED');
  }
  const runtime=coreRuntime(db);runtime?.install(app);
  app.use('/api',currentAccount(db));
  if(runtime)app.use('/api/auth',createAuthRouter(new AuthService({users:new PrismaUserRepository(db),passwords:passwordAdapter,tokens:tokenAdapter}),new OwnerActivationService(new PrismaOwnerActivationRepository(db),activationTokenAdapter,passwordAdapter)));
  mountDirectory(app,db,config.directoryToken??config.clinicToken);
  if(config.clinicUrl&&(!jwt?.privateKey||!config.clinicToken||config.clinicToken.length<32||config.clinicToken.length>512))throw new Error('SPLIT_CLINIC_CONFIGURATION_REQUIRED');
  const clinic=config.clinicUrl?new URL(config.clinicUrl):null;
  if(clinic&&(!['http:','https:'].includes(clinic.protocol)||clinic.username||clinic.password||clinic.pathname!=='/'||clinic.search||clinic.hash))throw new Error('INVALID_CLINIC_SERVICE_URL');
  mountDashboards(app,db,Boolean(clinic));
  if(clinic){
    app.use([...clinicPrefixes],express.json({limit:'8mb'}),serviceProxy({name:'clinic',origin:clinic,prefixes:clinicPrefixes,
      forwardRequestHeaders:['authorization','idempotency-key','x-clinic-min-version','x-clinic-read-consistency'],
      forwardResponseHeaders:['x-service-instance','x-service-degraded','retry-after','x-clinic-read-token','x-clinic-read-source','x-clinic-projection-generation','cache-control'],
      timeoutMs:6000,unavailableMessage:'Clinic service unavailable. Retry the same request key.',notFoundMessage:'Clinic route not found.'}));
    mountAppointmentBilling(app,db,clinic,config.clinicToken!,config.evidenceToken);
  }
  if (config.notificationUrl && (!jwt?.privateKey || !config.notificationToken || config.notificationToken.length < 32 || config.notificationToken.length > 512)) throw new Error('SPLIT_NOTIFICATION_CONFIGURATION_REQUIRED');
  const target = config.notificationUrl ? new URL(config.notificationUrl) : null;
  if (target && (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash)) throw new Error('INVALID_NOTIFICATION_SERVICE_URL');

  app.post('/internal/notifications/authorize-send', express.json({ limit: '8kb' }), async (req, res) => {
    if (!config.notificationToken || config.notificationToken.length < 32) { res.status(503).json({ error: 'Internal authorization unavailable.' }); return; }
    const credential = req.headers['x-service-token'];
    if (typeof credential !== 'string' || credential.length > 512 || !timingSafeEqual(createHash('sha256').update(credential).digest(), createHash('sha256').update(config.notificationToken).digest())) { res.status(401).json({ error: 'Service authentication required.' }); return; }
    let actor;
    try {
      const token = req.headers.authorization;
      if (!token?.startsWith('Bearer ') || token.length > 8192) throw new Error('INVALID_TOKEN');
      actor = verifyToken(token.slice(7));
    } catch { res.status(401).json({ error: 'Invalid actor context.' }); return; }
    if (!allows(actor.role, 'notification.send')) { res.status(403).json({ error: deniedMessage('notification.send') }); return; }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || typeof req.body.recipientOwnerId !== 'string' || !req.body.recipientOwnerId || req.body.recipientOwnerId.length > 200 || Object.keys(req.body).some(k => k !== 'recipientOwnerId')) { res.status(422).json({ error: 'Invalid recipient request.' }); return; }
    try {
      const sender = await db.user.findUnique({ where: { id: actor.sub }, select: { id: true, role: true } });
      if (!sender || sender.role !== actor.role) { res.status(403).json({ error: 'Staff access is required.' }); return; }
      const recipient = await db.user.findUnique({ where: { id: req.body.recipientOwnerId }, select: { id: true, role: true } });
      if (!recipient || recipient.role !== 'owner') { res.status(404).json({ error: 'Recipient not found.' }); return; }
      res.json({ actorId: sender.id, actorRole: sender.role, recipientOwnerId: recipient.id, authorized: true });
    } catch { res.status(503).json({ error: 'Core authorization unavailable.' }); }
  });

  const notificationProxy = target ? serviceProxy({ name: 'notification', origin: target, prefixes: ['/api/notifications'],
    forwardRequestHeaders: ['authorization', 'idempotency-key'], forwardResponseHeaders: ['retry-after', 'x-service-degraded', 'x-service-instance'],
    timeoutMs: 4000, unavailableMessage: 'Notification service unavailable. Retry the same request key.', notFoundMessage: 'Notification route not found.' }) : null;
  app.use('/api/notifications', express.json({ limit: '96kb' }), (req, res, next) => {
    if (!notificationProxy) { res.status(503).json({ error: 'Notification service is not configured.' }); return; }
    return notificationProxy(req, res, next);
  });
  app.use(runtime?createCoreDomains(db):createApp(db));
  app.use((error: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if(res.headersSent){res.end();return;}
    res.status(error?.type === 'entity.parse.failed' ? 400 : error?.type === 'entity.too.large' ? 413 : 503).json({ error: 'Request unavailable or invalid.' });
  });
  return app;
}
