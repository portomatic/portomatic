import {enqueueSalesFeedback,claimSalesFeedback,processSalesFeedback} from './lib/sales-feedback.mjs';
const once=process.argv.includes('--once'),index=process.argv.indexOf('--job'),jobId=index>=0?process.argv[index+1]:null;
let running=0,scheduling=false,stopping=false,lastEnqueue=0;
process.on('SIGTERM',()=>{stopping=true;if(!running&&!scheduling)process.exit(0);});
async function tick(){
 if(scheduling||stopping)return;scheduling=true;
 try{
  if(!jobId&&Date.now()-lastEnqueue>60000){await enqueueSalesFeedback();lastEnqueue=Date.now();}
  while(!stopping&&running<2){const job=await claimSalesFeedback(jobId);if(!job)break;
   if(once){await processSalesFeedback(job);return;}
   running++;void processSalesFeedback(job).catch(e=>console.error('Sales feedback job:',e.message)).finally(()=>{running--;if(stopping&&!running)process.exit(0);if(!stopping)void tick();});
  }
 }catch(e){console.error('Sales feedback worker:',e.message);}finally{scheduling=false;}
}
await tick();if(!once)setInterval(()=>void tick(),15000);
