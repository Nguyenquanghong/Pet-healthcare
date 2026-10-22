// CQRS maintenance switch. Appointment lists read the source tables directly
// (list study K2v2: the projection was ~25% slower than the source read), so the
// read-revision registry, the read-changed event and the projector are off unless
// an operator turns them on. Turning it back on after a period off needs a rebuild
// first (registry backfill + new generation): nothing was tracked while it was off.
export function readProjectionEnabled(env:NodeJS.ProcessEnv=process.env):boolean{
  const value=env.CLINIC_READ_PROJECTION||'off';
  if(value==='on')return true;
  if(value==='off')return false;
  throw new Error('INVALID_CLINIC_READ_PROJECTION');
}

// Fail fast: a mode that serves from, or compares with, the projection cannot be
// started while nothing maintains it.
export function assertReadProjectionConfig(env:NodeJS.ProcessEnv=process.env){
  if(readProjectionEnabled(env))return;
  if(['projection','shadow'].includes(env.CLINIC_READ_MODE??''))throw new Error('CLINIC_READ_PROJECTION_REQUIRED');
  if(['summary','control'].includes(env.CLINIC_ACTIVITY_MODE??'')||env.CLINIC_ACTIVITY_SUMMARY_EVIDENCE==='1')throw new Error('CLINIC_READ_PROJECTION_REQUIRED');
}
