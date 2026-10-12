export class AdmissionError extends Error { readonly status=503; constructor(){super('Password processing busy. Retry shortly.');} }
type Waiting={start:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
// A deadline removes queued work. Running PBKDF2 retains its slot until it ends;
// a response timeout must never admit another hash onto that occupied slot.
export class Admission {
  private active=0;private waiting:Waiting[]=[];private closed=false;
  readonly stats={active:0,queued:0,rejected:0,completed:0,durationSeconds:0,queueSeconds:0,peakActive:0,peakQueued:0};
  constructor(readonly concurrency=2,readonly pendingLimit=16,readonly queueTimeoutMs=1250){
    if(!Number.isSafeInteger(concurrency)||concurrency<1||!Number.isSafeInteger(pendingLimit)||pendingLimit<0||queueTimeoutMs<1)throw new Error('INVALID_ADMISSION_CONFIGURATION');
  }
  async run<T>(work:()=>Promise<T>):Promise<T>{
    const queuedAt=performance.now();
    if(this.closed)throw this.reject();
    if(this.active>=this.concurrency){
      if(this.waiting.length>=this.pendingLimit)throw this.reject();
      await new Promise<void>((resolve,reject)=>{
        const item:Waiting={start:resolve,reject,timer:setTimeout(()=>{
          const i=this.waiting.indexOf(item);if(i<0)return;this.waiting.splice(i,1);this.stats.queued=this.waiting.length;reject(this.reject());
        },this.queueTimeoutMs)};this.waiting.push(item);this.stats.queued=this.waiting.length;this.stats.peakQueued=Math.max(this.stats.peakQueued,this.stats.queued);
      });
    }else{this.active++;this.stats.active=this.active;this.stats.peakActive=Math.max(this.stats.peakActive,this.active);}
    this.stats.queueSeconds+=(performance.now()-queuedAt)/1000;
    const started=performance.now();
    try{return await work();}finally{
      this.stats.completed++;this.stats.durationSeconds+=(performance.now()-started)/1000;
      const next=this.waiting.shift();this.stats.queued=this.waiting.length;
      if(next){clearTimeout(next.timer);next.start();}else{this.active--;this.stats.active=this.active;}
    }
  }
  private reject(){this.stats.rejected++;return new AdmissionError();}
  close(){this.closed=true;for(const item of this.waiting.splice(0)){clearTimeout(item.timer);item.reject(this.reject());}this.stats.queued=0;}
}
