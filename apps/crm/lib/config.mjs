import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export const appDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const stateDir=path.join(appDir,'.state');
fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
const filename=path.join(stateDir,'settings.json');
export function settings(){
  const saved=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  return {port:3180,sharedCatalogInCloud:true,recordingFolder:path.join(os.homedir(),'Desktop'),watchRecordings:true,watchFrom:new Date().toISOString(),gmailQuery:'newer_than:180d -in:spam -in:trash -category:promotions -category:social',...saved,...(process.env.CRM_HOSTED==='true'?{watchRecordings:false}:{}),ownerEmail:process.env.PORTOMATIC_CRM_MEMBER_EMAIL||saved.ownerEmail||'kevin@portomatic.com'};
}
export function saveSettings(values){
  const s={...settings(),...values};
  fs.writeFileSync(filename,JSON.stringify(s,null,2)+'\n',{mode:0o600});
  return s;
}
if(!fs.existsSync(filename))saveSettings({watchFrom:new Date().toISOString()});

export function googleClient(){
  const candidates=[process.env.PORTOMATIC_CRM_GOOGLE_CLIENT_FILE,path.join(stateDir,'google-client.json'),path.join(os.homedir(),'.config/gws/client_secret.json')].filter(Boolean);
  for(const filename of candidates){
    if(!fs.existsSync(filename))continue;
    const data=JSON.parse(fs.readFileSync(filename,'utf8'));
    const client=data.installed||data.web||data;
    if(client.client_id)return {clientId:client.client_id,clientSecret:client.client_secret,projectId:client.project_id,filename};
  }
  return null;
}
export function credentialsFiles(){
  const dir=path.join(stateDir,'google');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  return fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>path.join(dir,n));
}
