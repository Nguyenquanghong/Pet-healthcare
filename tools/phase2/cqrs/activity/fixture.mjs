import {createHash} from 'node:crypto';
export const activityFixtureTypes=['general_checkup','vaccination','dental','dermatology','surgery','hotel_consultation','spa_bath','spa_grooming','spa_combo','other'];
export const activityFixtureStatuses=['pending','confirmed','checked_in','in_progress','completed','cancelled','no_show'];
const day=86400000, iso=ms=>new Date(ms).toISOString().slice(0,10);
const uuid=value=>{const s=createHash('sha256').update(value).digest('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-4${s.slice(13,16)}-8${s.slice(17,20)}-${s.slice(20,32)}`;};
// Pure fixture builder, never a seed command. A guarded trial must supply/map
// these synthetic identities to real Core owners/pets before database insertion.
export function buildActivityFixture({rows=10000,seed=20261020,businessDate='2030-10-20'}={}){
  if(!Number.isInteger(rows)||rows<1||rows>100000||!Number.isInteger(seed)||!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))throw new Error('INVALID_ACTIVITY_FIXTURE');
  const anchor=Date.parse(businessDate+'T00:00:00Z');if(!Number.isFinite(anchor)||iso(anchor)!==businessDate)throw new Error('INVALID_ACTIVITY_FIXTURE_DATE');
  let state=seed>>>0;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const typeWeights=[40,15,3,8,1,3,12,10,6,2],statusWeights=[6,8,2,2,65,12,5];
  const weighted=(values,weights)=>{let at=random()*100;for(let i=0;i<weights.length;i++){at-=weights[i];if(at<0)return values[i];}return values.at(-1);};
  const owners=Array.from({length:64},(_,i)=>({id:uuid(seed+':owner:'+i),fullName:'Synthetic owner '+i,role:'owner'}));
  const pets=Array.from({length:256},(_,i)=>({id:uuid(seed+':pet:'+i),ownerId:owners[i%64].id,name:'Synthetic pet '+i,species:i%2?'cat':'dog'}));
  const appointments=Array.from({length:rows},(_,i)=>{
    const hot=random()<.002;let date=anchor;
    // Product history stays roughly 80 visits per populated day at 100k/4y.
    // The busy anchor is modest; 40k/day contention belongs to a separate fault fixture.
    if(!hot){do{date=anchor-Math.floor(random()*1461)*day;}while(new Date(date).getUTCMonth()===1||new Date(date).getUTCDay()===0||date===anchor-7*day);}
    const minute=Math.floor(i/pets.length),pet=pets[i%pets.length];
    return {id:uuid(seed+':appointment:'+i),petId:pet.id,ownerId:pet.ownerId,doctorId:null,
      type:i<70?activityFixtureTypes[i%10]:weighted(activityFixtureTypes,typeWeights),status:i<70?activityFixtureStatuses[Math.floor(i/10)%7]:weighted(activityFixtureStatuses,statusWeights),statusRevision:0,
      serviceName:'Synthetic activity visit '+i,clinicName:'Synthetic clinic',appointmentDate:iso(date),
      appointmentTime:String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0'),
      ownerNote:null,internalNote:null,createdBy:'staff',createdAt:new Date(date-2*day).toISOString(),updatedAt:new Date(date-day).toISOString()};
  });
  return {manifest:{format:'clinic-activity-fixture-v1',rows,seed,businessDate,syntheticOnly:true,
    distribution:{historyDays:1461,busyAnchorProbability:.002,excludedHistoryMonth:2,excludedWeekday:0,typeWeights,statusWeights,first70CoverAllEnumPairs:true},
    contentSha256:createHash('sha256').update(JSON.stringify({owners,pets,appointments})).digest('hex')},owners,pets,appointments};
}
