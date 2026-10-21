import {realpathSync,lstatSync} from 'node:fs';

export class TrialScopeError extends Error {
  constructor(code='ACTIVITY_TRIAL_SCOPE_REJECTED'){super(code);this.name='TrialScopeError';this.code=code;}
}
const check=(value)=>{if(!value)throw new TrialScopeError();};
export function validateTrialContext(c){
  check(c?.kind==='clinic-activity-d1-native-v1');
  check(typeof c.run==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(c.run));
  const hex=c.run.replaceAll('-','');
  check(c.directory==='/tmp/clinic-activity-d1-'+c.run&&c.pgData===c.directory+'/pgdata');
  check(Number.isInteger(c.pgPort)&&c.pgPort>=1024&&c.pgPort<=65535);
  check(c.schema==='activity_'+hex&&c.marker==='clinic-activity:'+c.run);
  check(c.fixtureRows===10000&&c.seed===20261020&&c.businessDate==='2030-10-20');
  check(c.benchmark===false&&c.authorizedTrialSetup===true);
  check(typeof c.sourceArchiveSha256==='string'&&/^[a-f0-9]{64}$/.test(c.sourceArchiveSha256));
  return hex;
}
export function trialUrl(c,component,access='operator'){
  const hex=validateTrialContext(c);
  check(['core','clinic'].includes(component)&&['operator','api','reader'].includes(access));
  check(!(component==='core'&&access==='reader'));
  let u;try{u=new URL(c.urls?.[component]?.[access]);}catch{throw new TrialScopeError();}
  const role='activity_'+hex+'_'+(access==='operator'?'operator':access==='reader'?'reader':component);
  check(u.protocol==='postgresql:'&&u.hostname==='127.0.0.1'&&u.port===String(c.pgPort));
  check(u.username===role&&u.pathname==='/activity_'+hex+'_'+component);
  check(/^[a-f0-9]{48}$/.test(u.password)&&!u.hash);
  check(u.searchParams.get('schema')===c.schema&&u.searchParams.get('connection_limit')===(access==='reader'?'1':'2'));
  check(u.searchParams.get('pool_timeout')==='1');
  check([...u.searchParams.keys()].every(k=>['schema','connection_limit','pool_timeout'].includes(k)));
  check([...u.searchParams.keys()].every(k=>u.searchParams.getAll(k).length===1));
  return u;
}
export function verifyPrivateContextPath(c,file){
  validateTrialContext(c);
  check(!lstatSync(c.directory).isSymbolicLink()&&realpathSync(c.directory)===c.directory);
  check(!lstatSync(file).isSymbolicLink()&&realpathSync(file)===c.directory+'/context.json');
  check(realpathSync(c.pgData)===c.pgData);
}
// Always call before mutation, and again after migration/role/fixture phases.
// Database/schema markers exist before Prisma sees an otherwise empty schema.
export async function guardDatabase(db,c,component,access='operator'){
  const u=trialUrl(c,component,access);
  const [id]=await db.$queryRaw`SELECT current_database() AS db,current_user AS role,current_schema() AS schema,
    current_setting('port') AS port,current_setting('server_version_num') AS version`;
  check(id?.db===u.pathname.slice(1)&&id.role===u.username&&id.schema===c.schema&&id.port===String(c.pgPort));
  check(/^16\d{4}$/.test(id.version));
  const [marker]=await db.$queryRaw`SELECT obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=${c.schema}`;
  check(marker?.marker===c.marker);
  const [database]=await db.$queryRaw`SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`;
  check(database?.marker===c.marker);
  const [role]=await db.$queryRaw`SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user`;
  check(role?.rolsuper===false&&role.rolcreatedb===false&&role.rolcreaterole===false);
  return {database:id.db,role:id.role,schema:id.schema,port:Number(id.port),serverVersionNumber:id.version,markerVerified:true,nonSuperuser:true};
}
