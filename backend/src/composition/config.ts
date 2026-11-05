import { credential, serviceOrigin } from '@nipopeto/runtime';
import { asymmetricConfig } from '../lib/token.js';

export type CoreConfig = {
  notificationUrl?: string;
  notificationToken?: string;
  clinicUrl?: string;
  clinicToken?: string;
  directoryToken?: string;
  evidenceToken?: string;
};

export const coreConfigFromEnv = (): CoreConfig => ({
  notificationUrl: process.env.NOTIFICATION_SERVICE_URL,
  notificationToken: process.env.CORE_NOTIFICATION_SEND_TOKEN ?? process.env.NOTIFICATION_SERVICE_TOKEN,
  clinicUrl: process.env.CLINIC_SERVICE_URL,
  clinicToken: process.env.CLINIC_BILLING_TOKEN ?? process.env.CLINIC_SERVICE_TOKEN,
  directoryToken: process.env.CORE_DIRECTORY_TOKEN,
  evidenceToken: process.env.CORE_BILLING_EVIDENCE_TOKEN,
});

export const corsOrigins = (): string[] =>
  process.env.CORS_ORIGIN?.split(',')
    .map(value => value.trim())
    .filter(Boolean) ?? [];

export type CoreSettings = { config: CoreConfig; clinic: URL | null; notification: URL | null };

// The required RSA keys and the service URLs, checked before a runtime or a route exists. A split service URL needs the
// RSA private key and a token of 32 to 512 characters, and is parsed only after its token passes.
export function coreSettings(config: CoreConfig): CoreSettings {
  const jwt = asymmetricConfig();
  if (process.env.PHASE2_RUNTIME_REQUIRED === '1') {
    if (!jwt?.privateKey || !jwt.keyId) throw new Error('CORE_RSA_SIGNING_CONFIGURATION_REQUIRED');
    const scoped = [
      'CORE_DIRECTORY_TOKEN',
      'CORE_BILLING_EVIDENCE_TOKEN',
      'CLINIC_BILLING_TOKEN',
      'CORE_NOTIFICATION_SEND_TOKEN',
    ].map(credential);
    if (new Set(scoped).size !== scoped.length) throw new Error('DISTINCT_SERVICE_CREDENTIALS_REQUIRED');
    if (!config.clinicUrl || !config.notificationUrl) throw new Error('SPLIT_SERVICE_URLS_REQUIRED');
  }
  if (
    config.clinicUrl &&
    (!jwt?.privateKey || !config.clinicToken || config.clinicToken.length < 32 || config.clinicToken.length > 512)
  )
    throw new Error('SPLIT_CLINIC_CONFIGURATION_REQUIRED');
  const clinic = config.clinicUrl ? serviceOrigin(config.clinicUrl, 'INVALID_CLINIC_SERVICE_URL') : null;
  if (
    config.notificationUrl &&
    (!jwt?.privateKey ||
      !config.notificationToken ||
      config.notificationToken.length < 32 ||
      config.notificationToken.length > 512)
  )
    throw new Error('SPLIT_NOTIFICATION_CONFIGURATION_REQUIRED');
  const notification = config.notificationUrl
    ? serviceOrigin(config.notificationUrl, 'INVALID_NOTIFICATION_SERVICE_URL')
    : null;
  return { config, clinic, notification };
}

// Whether this process serves the clinical routes itself. With a Clinic URL the Clinic service owns the appointment, medical
// record and notification-list routes and Core never mounts them, nor the repository sources that read their tables. The same
// setting decides the Clinic proxy and appointment billing in mountSplitRoutes, so the two cannot disagree.
export const servesClinical = (settings: Pick<CoreSettings, 'clinic'>): boolean => !settings.clinic;
