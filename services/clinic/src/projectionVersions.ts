// Projection schemaVersion, not the event envelope schemaVersion (still 1).
// V1 = appointment read rows only. V2 = the same rows plus AppointmentDailySummary
// under one transaction/inbox invariant. A generation never changes version in place.
export const projectionVersions=[1,2] as const;
export type ProjectionVersion=(typeof projectionVersions)[number];
export const isProjectionVersion=(v:unknown):v is ProjectionVersion=>v===1||v===2;
export const maintainsDailySummary=(v:ProjectionVersion)=>v===2;
// V1 keeps its historical namespace; V2 is distinct so a V1 inbox row can never
// suppress a V2 summary update for the same event.
export function projectionInbox(generation:{id:string;schemaVersion:number}){
  if(!isProjectionVersion(generation.schemaVersion))throw new Error('READ_PROJECTION_VERSION_UNSUPPORTED');
  return 'clinic-read-v'+generation.schemaVersion+':'+generation.id;
}
// Explicit binary capability. '1' is the V1-only runtime (row-only, no summary
// maintenance) for a separate V1 trial; it refuses any V2 target instead of
// ACKing events it cannot fully apply. Default/'1,2' maintains both.
export function projectionCapability(raw=process.env.CLINIC_READ_PROJECTION_VERSIONS):readonly ProjectionVersion[]{
  if(raw===undefined||raw==='1,2')return projectionVersions;
  if(raw==='1')return [1];
  throw new Error('INVALID_CLINIC_READ_PROJECTION_VERSIONS');
}
export function assertProjectionTargets(capability:readonly ProjectionVersion[],targets:readonly {schemaVersion:number}[]){
  if(targets.some(g=>!isProjectionVersion(g.schemaVersion)||!capability.includes(g.schemaVersion)))throw new Error('READ_PROJECTION_CAPABILITY_MISMATCH');
}
export const capabilityReport=(capability:readonly ProjectionVersion[])=>({projectionVersions:[...capability],summaryEnabled:capability.some(maintainsDailySummary)});
