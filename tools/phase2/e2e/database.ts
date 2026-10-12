import { expect } from '@playwright/test';
import { PrismaClient as Core } from '@prisma/client';
import { PrismaClient as Notification } from '../../../services/notification/src/generated/client/index.js';
export async function database(name:'core'|'notification'){
  expect(process.env.PHASE2_TEST_CONFIRM).toBe('pet-phase2-p1-test');
  const db=name==='core'?new Core({datasourceUrl:'postgresql://p2_core:p2_core_fixture_only@127.0.0.1:55432/p2_core_test?schema=core_runtime_test'}):new Notification({datasourceUrl:'postgresql://p2_notification:p2_notification_fixture_only@127.0.0.1:55432/p2_notification_test?schema=p1_proof'});
  const [identity]=await db.$queryRaw<any[]>`SELECT current_database() AS db,current_user AS role`;
  expect(identity).toEqual({db:`p2_${name}_test`,role:`p2_${name}`});
  const [marker]=await db.$queryRaw<any[]>`SELECT marker FROM public.p2_test_marker`;expect(marker.marker).toBe(`pet-phase2-p1-test:${name}:v1`);return db;
}
