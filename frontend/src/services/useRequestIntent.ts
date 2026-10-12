import {useRef} from 'react';
import {authToken} from './apiClient';

// Keep a request key through an uncertain HTTP result. Each form owns its
// intent; a changed payload/session or a confirmed commit starts a new one.
export function useRequestIntent(){
  const current=useRef<{payload:string;token:string|null;key:string}|null>(null);
  return{
    key:(input:unknown)=>{const payload=JSON.stringify(input),token=authToken.get();if(current.current?.payload!==payload||current.current.token!==token)current.current={payload,token,key:crypto.randomUUID()};return current.current.key;},
    complete:()=>{current.current=null;},
  };
}
