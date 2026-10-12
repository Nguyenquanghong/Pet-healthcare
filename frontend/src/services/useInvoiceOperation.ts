import {useEffect,useRef,useState} from 'react';
import {authToken,request,apiClient} from './apiClient';
import {ApiError} from '../utils/apiError';
import type {Invoice} from '../types/invoice';
type Intent={endpoint:string;body:unknown;key:string;operationId?:string};
type Outcome={invoice?:Invoice;status?:'pending'|'succeeded'|'failed';operationId?:string;error?:string};
function session(){try{const token=authToken.get();if(!token)return'logged-out';const p=JSON.parse(atob(token.split('.')[1]!.replace(/-/g,'+').replace(/_/g,'/')));return[String(p.sub),String(p.role),String(p.iat)].join(':');}catch{return'logged-out';}}
export function useInvoiceOperation(name:string){
  const scope='nipopeto_invoice_pending:'+name+':'+session();
  const read=():Intent|null=>{try{const s=sessionStorage.getItem(scope);if(!s||s.length>96000)return null;const v=JSON.parse(s);if(!['/invoices','/invoices/checkout'].includes(v.endpoint)||typeof v.key!=='string'||v.key.length>128||!v.body||typeof v.body!=='object'||(v.operationId!==undefined&&(typeof v.operationId!=='string'||v.operationId.length>128)))return null;return v;}catch{return null;}};
  const current=useRef<Intent|null>(read()),[pending,setPending]=useState<Intent|null>(current.current);
  useEffect(()=>{current.current=read();setPending(current.current);},[scope]);
  const save=(v:Intent|null)=>{current.current=v;setPending(v);if(v)sessionStorage.setItem(scope,JSON.stringify(v));else sessionStorage.removeItem(scope);};
  const run=async(intent:Intent):Promise<Invoice|null>=>{
    const token=authToken.get();save(intent);
    try{
      let result:Outcome=intent.operationId?await apiClient.get('/operations/'+encodeURIComponent(intent.operationId),{signal:AbortSignal.timeout(5000)}):await request(intent.endpoint,{method:'POST',body:JSON.stringify(intent.body),headers:{'Idempotency-Key':intent.key},signal:AbortSignal.timeout(6500)});
      if(authToken.get()!==token)throw new Error('Phiên đăng nhập đã thay đổi.');
      if(result.operationId){intent={...intent,operationId:result.operationId};save(intent);}
      // Each check is bounded. An unresolved operation remains visible and keeps
      // its key/body across reload; a browser cannot infer failure from timeout.
      for(let n=0;result.status==='pending'&&n<3;n++){
        await new Promise(resolve=>setTimeout(resolve,700));
        if(authToken.get()!==token)throw new Error('Phiên đăng nhập đã thay đổi.');
        result=await apiClient.get('/operations/'+encodeURIComponent(intent.operationId!),{signal:AbortSignal.timeout(5000)});
      }
      if(authToken.get()!==token)throw new Error('Phiên đăng nhập đã thay đổi.');
      if(result.status==='failed'){save(null);throw new Error(result.error||'Yêu cầu lập hóa đơn đã bị hủy.');}
      if(result.invoice){save(null);return result.invoice;}
      if(result.status==='pending')return null;
      throw new Error('Chưa xác định được kết quả hóa đơn. Kiểm tra lại trạng thái.');
    }catch(error){if(authToken.get()===token&&error instanceof ApiError&&error.httpStatus<500)save(null);throw error;}
  };
  return{pending,submit:(endpoint:string,body:unknown)=>run(current.current??{endpoint,body,key:crypto.randomUUID()}),check:()=>current.current?run(current.current):Promise.resolve(null)};
}
