import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export async function runImessage(command,args={}){
  if(['sync','sync-status','sync-configure','sync-init'].includes(command)){
    const sync=await import('./imessage-sync.mjs');
    if(command==='sync')return sync.syncImessage({mode:args.mode,dryRun:!!args['dry-run'],classifyNew:args['classify-new']===undefined?undefined:args['classify-new']!==false&&args['classify-new']!=='false'});
    if(command==='sync-status')return sync.imessageSyncStatus();
    if(command==='sync-init')return sync.initImessageSchema();
    return sync.configureImessageSync({mode:args.mode,enabled:args.enabled!==false&&args.enabled!=='false',ownerEmail:args.owner});
  }
  if(!['prepare','classify','status','probe'].includes(command))throw new Error('Unknown iMessage command');
  const localPython=path.join(root,'.state/imessage-research-venv/bin/python');
  const python=process.env.PORTOMATIC_IMESSAGE_PYTHON||(fs.existsSync(localPython)?localPython:'python3');
  const argv=[path.join(root,'scripts/imessage_classify.py'),command];
  for(const option of ['limit','workers'])if(args[option]!==undefined){
    const value=Number(args[option]);
    if(!Number.isSafeInteger(value)||value<0)throw new Error(`Invalid --${option}`);
    argv.push(`--${option}`,String(value));
  }
  return new Promise((resolve,reject)=>{
    const child=spawn(python,argv,{stdio:['ignore','pipe','inherit']});
    let stdout='';
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
    child.once('error',reject);
    child.once('exit',code=>{
      if(code!==0)return reject(new Error(`Local iMessage ${command} did not complete (exit ${code}); see its status output.`));
      try{resolve(JSON.parse(stdout));}catch{reject(new Error('Invalid iMessage command output'));}
    });
  });
}
