// Per serving reader. Wait before opening a transaction, never while holding
// a Prisma connection or a RepeatableRead snapshot. A granted slot is retained
// until the transaction (including rollback/commit) has completed.
// `slots` concurrent projected transactions (default 1, the ADR-05 decision).
// One slot made B queue behind itself at ~0.8 utilisation on the query-heavy
// trace (list study v2: B/A p95 1.25), while A ran up to its pool size.
export class ProjectionAdmission{
  private active=0;
  private readonly waiting:Array<{grant:()=>void;cancel:()=>void}>=[];
  constructor(private readonly now=()=>performance.now(),readonly slots=1){
    if(!Number.isSafeInteger(slots)||slots<1||slots>4)throw new Error('INVALID_PROJECTION_SLOTS');
  }
  get busy(){return this.active>=this.slots;}
  async acquire(deadline:number):Promise<()=>void>{
    if(this.now()>=deadline)throw new Error('PROJECTION_ADMISSION_BUSY');
    if(this.active<this.slots){this.active++;return this.releaseOnce();}
    // A cold aggregate can spend most of a request budget computing reusable
    // counts. Eight pending slots rejected otherwise timely reads in bursts.
    // Retain at most sixteen callers outside Prisma; this adds no active SQL
    // or connections. Every waiter still expires on its original deadline.
    if(this.waiting.length>=16)throw new Error('PROJECTION_ADMISSION_BUSY');
    return new Promise((resolve,reject)=>{
      // Admission covers a whole projected snapshot, not one aggregate SQL.
      // Spend only the caller's existing end-to-end budget; the SQL timeout is
      // still 200ms and the transaction receives only the remaining time.
      const end=deadline;
      let timer:ReturnType<typeof setTimeout>;
      const entry={
        grant:()=>{
          clearTimeout(timer);
          // A delayed timer must not grant an expired request a transaction.
          if(this.now()>=end){reject(new Error('PROJECTION_ADMISSION_BUSY'));this.next();}
          else resolve(this.releaseOnce());
        },
        cancel:()=>{
          const index=this.waiting.indexOf(entry);
          if(index>=0)this.waiting.splice(index,1);
          reject(new Error('PROJECTION_ADMISSION_BUSY'));
        },
      };
      timer=setTimeout(entry.cancel,Math.max(0,end-this.now()));
      this.waiting.push(entry);
    });
  }
  private releaseOnce(){
    let released=false;
    return ()=>{if(!released){released=true;this.next();}};
  }
  private next(){
    const entry=this.waiting.shift();
    if(entry)entry.grant();else this.active--;
  }
}
