import type { PrismaClient } from './generated/client/index.js';
import { createRuntime, type Actor } from '@nipopeto/runtime';
import { runtimeQueues } from '@nipopeto/messaging';
import { clinicRouteLabel } from './http/routeLabel.js';
import { runtimeProbe } from './infrastructure/persistence/runtimeProbe.js';
export const clinicRuntime = (db: PrismaClient, verify: (token: string) => Actor) =>
  createRuntime({
    service: 'clinic',
    verify,
    limitRules: [],
    routeLabel: clinicRouteLabel,
    queues: runtimeQueues(['clinic']),
    probe: runtimeProbe(db),
  });
