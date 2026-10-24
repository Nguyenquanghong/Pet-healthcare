import type { DirectoryEntry } from '@nipopeto/contracts';
import type { ProjectionEntry } from './inbox.js';
import { traceHeaders } from '@nipopeto/runtime';
import { TransientError } from '@nipopeto/messaging';
// P03: Core not answering, or not yet at the event's version, heals with a retry.
export class DirectorySync {
  private readonly origin:URL;
  constructor(url:string,private readonly token:string){this.origin=new URL(url);if(!['http:','https:'].includes(this.origin.protocol)||this.origin.pathname!=='/'||this.origin.search||this.origin.hash||this.origin.username||this.origin.password||token.length<32||token.length>512)throw new Error('INVALID_DIRECTORY_SYNC_CONFIGURATION');}
  async page(kind:string,cursor?:string,id?:string){
    const url=new URL('/internal/directory/export',this.origin);url.searchParams.set('kind',kind);url.searchParams.set('limit','50');if(cursor)url.searchParams.set('cursor',cursor);if(id)url.searchParams.set('id',id);
    const response=await fetch(url,{headers:{...traceHeaders(),'X-Service-Token':this.token},redirect:'error',signal:AbortSignal.timeout(2000)}).catch(()=>{throw new TransientError('DIRECTORY_SYNC_UNAVAILABLE');});if(response.status!==200)throw new TransientError('DIRECTORY_SYNC_UNAVAILABLE');
    const data=await response.json() as {kind:string;items:ProjectionEntry[];nextCursor:string|null};
    if(data.kind!==kind||!Array.isArray(data.items)||data.items.length>50||data.items.some(p=>typeof p.id!=='string'||!p.id||!Number.isSafeInteger(p.sourceVersion)||p.sourceVersion<1||typeof p.displayName!=='string'||!p.displayName||kind==='pet'&&typeof p.ownerId!=='string')||data.nextCursor!==null&&typeof data.nextCursor!=='string')throw new Error('INVALID_DIRECTORY_SYNC');return data;
  }
  async hydrate(kind:string,p:DirectoryEntry){const page=await this.page(kind,undefined,p.id),row=page.items.find(r=>r.id===p.id);if(!row||row.sourceVersion<p.sourceVersion)throw new TransientError('DIRECTORY_SOURCE_NOT_CURRENT');return row;}
}
