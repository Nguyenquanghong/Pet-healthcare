type Saved={id:string;serviceName:string;status:string;date?:string;time?:string};
let session:string|null=null,epoch=0,tokens:string[]=[],forceSource=false,saved:Saved[]=[];
let controller=new AbortController();
let highest=new Map<string,number>();
const listeners=new Set<()=>void>();
const notify=()=>listeners.forEach(fn=>fn());
export const clinicReadState={
  sync(token:string|null){if(token!==session){controller.abort();controller=new AbortController();session=token;epoch++;tokens=[];forceSource=false;saved=[];highest=new Map();notify();}},
  signal:()=>controller.signal,
  epoch:()=>epoch,
  headers:():Record<string,string>=>forceSource?{'X-Clinic-Read-Consistency':'authoritative'}:tokens.length?{'X-Clinic-Min-Version':tokens.join(',')}:{},
  expired(){tokens=[];forceSource=true;},
  mutation(token:string|null,data:unknown){
    epoch++;
    if(token&&!tokens.includes(token))tokens.push(token);
    if(!token||tokens.length>16||tokens.join(',').length>4096){tokens=[];forceSource=true;}
    const value=data as {appointment?:Saved;record?:{appointmentId?:string;title?:string}};
    const item=value?.appointment??(value?.record?.appointmentId?{id:value.record.appointmentId,serviceName:value.record.title??'Khám bệnh',status:'completed'}:undefined);
    if(item){
      // Only a display-order hint from a server response; never authorization.
      // The backend still verifies every signed token used on a subsequent GET.
      let version=0;try{version=JSON.parse(atob(token!.split('.')[0]!.replace(/-/g,'+').replace(/_/g,'/'))).versions[item.id]??0;}catch{/* Historical responses have no token. */}
      if(version<(highest.get(item.id)??0))return;
      highest.set(item.id,version);if(highest.size>100)highest.delete(highest.keys().next().value!);
      const {id,serviceName,status,date,time}=item;
      saved=[{id,serviceName,status,date,time},...saved.filter(s=>s.id!==id)].slice(0,16);notify();
    }
  },
  confirmed(data:unknown){
    const items=(data as {items?:Saved[]})?.items;if(!Array.isArray(items))return;
    const next=saved.filter(s=>!items.some(i=>i.id===s.id&&i.status===s.status&&(!s.date||i.date===s.date)&&(!s.time||i.time===s.time)));
    if(next.length!==saved.length){saved=next;notify();}
  },
  subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
  saved:()=>saved,
};
