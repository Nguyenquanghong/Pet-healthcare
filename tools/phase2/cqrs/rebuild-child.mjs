import {context,client,guard} from './q3-trial.mjs';
import {AppointmentRebuild} from '../../../services/clinic/dist/readRebuild.js';
const c=context(process.env.CQRS_Q3_CONTEXT),db=client(c),engine=new AppointmentRebuild(db);
try{await guard(db,c,{workersStopped:true});await engine.claim(process.env.Q3_RUN,process.env.Q3_GENERATION);await engine.batch(process.env.Q3_RUN,17);process.send({stage:'batch-committed'});await new Promise(()=>{});}
catch{process.send?.({stage:'failed'});await db.$disconnect();process.exitCode=1;}
