import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {googleClient,credentialsFiles,stateDir,settings} from './config.mjs';
import {importItems,sourceStatus,getMembers,email,markSourceUnavailable,associateGoogleAccount} from './store.mjs';
import {queryRows,sqlLiteral as q} from '../../../customers/scripts/lib/db.mjs';

const sessions=new Map(),tokens=new Map();
const scopes=['openid','email','profile','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/drive.readonly'];
const callback='http://localhost:3180/api/google/callback';
const encode=buffer=>buffer.toString('base64url');
const keychainService='com.portomatic.crm.google';
const shellString=s=>'"'+String(s).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n')+'"';
async function secret(account,value){
  return await new Promise((resolve,reject)=>{
    const p=spawn('/usr/bin/security',value===undefined?['find-generic-password','-s',keychainService,'-a',account,'-w']:['-i'],{stdio:['pipe','pipe','pipe']});let out='';
    p.stdout.on('data',b=>out+=b);p.stderr.on('data',()=>{});p.on('error',reject);
    p.on('close',code=>code===0?resolve(out.trim()):reject(new Error('Google credentials could not be read from the Mac login Keychain. Connect this Google account on this Mac.')));
    if(value!==undefined)p.stdin.end(`add-generic-password -U -s ${shellString(keychainService)} -a ${shellString(account)} -w ${shellString(value)}\nquit\n`);else p.stdin.end();
  });
}
export async function beginGoogle(ownerEmail){
  const owner=email(ownerEmail),members=await getMembers();if(!members.some(m=>m.email===owner))throw new Error('Choose a team member');
  const client=googleClient();if(!client)throw new Error('Google OAuth client is not configured. Add a Desktop OAuth client through Connections.');
  const state=encode(crypto.randomBytes(32)),verifier=encode(crypto.randomBytes(48));
  for(const [key,value] of sessions)if(value.expires<Date.now())sessions.delete(key);
  sessions.set(state,{owner,verifier,expires:Date.now()+15*60*1000});
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [key,value] of Object.entries({client_id:client.clientId,redirect_uri:callback,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge:encode(crypto.createHash('sha256').update(verifier).digest()),code_challenge_method:'S256'}))url.searchParams.set(key,value);
  return url.href;
}
async function tokenRequest(params){
  const client=googleClient();
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({...params,client_id:client.clientId,client_secret:client.clientSecret})});
  const body=await response.json();if(!response.ok)throw new Error(body.error_description||body.error||'Google sign-in failed');return body;
}
export async function finishGoogle(query){
  const state=sessions.get(query.get('state'));sessions.delete(query.get('state'));
  if(!state||state.expires<Date.now())throw new Error('Google sign-in expired. Start again from Connections.');
  if(query.get('error'))throw new Error('Google connection was not completed: '+query.get('error'));
  const result=await tokenRequest({code:query.get('code'),code_verifier:state.verifier,redirect_uri:callback,grant_type:'authorization_code'});
  const userResponse=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{authorization:'Bearer '+result.access_token}});
  const user=await userResponse.json();if(!userResponse.ok||!user.email_verified)throw new Error('Google could not verify this account');
  const account=email(user.email),key=state.owner+':'+account;
  let previous={};try{previous=JSON.parse(await secret(key));}catch{}
  if(!result.refresh_token&&!previous.refresh_token)throw new Error('Google did not grant background access. Reconnect and approve the requested read access.');
  const credentials={refresh_token:result.refresh_token||previous.refresh_token,scope:result.scope};
  await secret(key,JSON.stringify(credentials));
  if(JSON.parse(await secret(key)).refresh_token!==credentials.refresh_token)throw new Error('Google credentials could not be saved in Keychain');
  const file=path.join(stateDir,'google',crypto.createHash('sha256').update(key).digest('hex')+'.json');
  credentialsFiles();await fs.writeFile(file,JSON.stringify({ownerEmail:state.owner,account,name:user.name,keychainAccount:key,connectedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
  tokens.set(key,{access_token:result.access_token,expires:Date.now()+(result.expires_in-60)*1000});
  await associateGoogleAccount(state.owner,account,user.name);
  for(const provider of ['gmail','calendar','drive'])await sourceStatus(state.owner,provider,account,'ready',{metadata:{local_authorized:true,scope:result.scope,backfill_pending:true}});
  return {owner:state.owner,account};
}
async function access(account){
  const cached=tokens.get(account.keychainAccount);if(cached?.expires>Date.now())return cached.access_token;
  const credentials=JSON.parse(await secret(account.keychainAccount));
  const result=await tokenRequest({refresh_token:credentials.refresh_token,grant_type:'refresh_token'});
  tokens.set(account.keychainAccount,{access_token:result.access_token,expires:Date.now()+(result.expires_in-60)*1000});
  return result.access_token;
}
async function api(account,url,params={}){
  const u=new URL(url);for(const [key,value] of Object.entries(params))if(value!=null)u.searchParams.set(key,String(value));
  const response=await fetch(u,{headers:{authorization:'Bearer '+await access(account)}});
  const body=await response.json();if(!response.ok){const e=new Error(body.error?.message||'Google sync failed');e.status=response.status;throw e;}return body;
}
const sourceRow=async(a,p)=>(await queryRows(`SELECT cursor,metadata FROM crm_sources s JOIN crm_members m ON s.owner_id=m.member_id WHERE m.email=${q(a.ownerEmail)} AND s.provider=${q(p)} AND s.account=${q(a.account)};`,{rowLimit:1}))[0];
const parsed=v=>typeof v==='string'?JSON.parse(v):v||{};
export function addresses(text){
  const result=[];for(const match of String(text||'').matchAll(/(?:"?([^",<>]+)"?\s*)?<([^<>\s]+@[^<>\s]+)>|([^\s,;<>]+@[^\s,;<>]+)/g)){
    try{result.push({email:email(match[2]||match[3]),name:match[1]?.trim().replace(/^"|"$/g,'')||undefined});}catch{}
  }return result;
}
function messageText(payload){
  const parts=[];
  function walk(p){if(p.mimeType==='text/plain'&&p.body?.data)parts.push(Buffer.from(p.body.data,'base64url').toString('utf8'));for(const child of p.parts||[])walk(child);}
  walk(payload);return parts.join('\n').trim();
}
async function syncGmail(a){
  const row=await sourceRow(a,'gmail'),cursor=parsed(row?.cursor),profile=await api(a,'https://gmail.googleapis.com/gmail/v1/users/me/profile');
  const ids=new Set();let next;
  if(cursor.historyId&&!cursor.pageToken){
    try{const history=await api(a,'https://gmail.googleapis.com/gmail/v1/users/me/history',{startHistoryId:cursor.historyId,historyTypes:'messageAdded',maxResults:250});for(const h of history.history||[])for(const m of h.messagesAdded||[])ids.add(m.message.id);next={historyId:history.nextPageToken?cursor.historyId:history.historyId,historyPage:history.nextPageToken||null};
      if(history.nextPageToken){let page=history.nextPageToken;while(page){const h=await api(a,'https://gmail.googleapis.com/gmail/v1/users/me/history',{startHistoryId:cursor.historyId,historyTypes:'messageAdded',maxResults:250,pageToken:page});for(const x of h.history||[])for(const m of x.messagesAdded||[])ids.add(m.message.id);page=h.nextPageToken;next.historyId=h.historyId;}}
    }catch(e){if(e.status===404){delete cursor.historyId;}else throw e;}
  }
  if(!cursor.historyId){
    const query=cursor.query||settings().gmailQuery;
    const page=await api(a,'https://gmail.googleapis.com/gmail/v1/users/me/messages',{q:query,maxResults:100,pageToken:cursor.pageToken});
    for(const m of page.messages||[])ids.add(m.id);
    next=page.nextPageToken?{pageToken:page.nextPageToken,query,startHistoryId:cursor.startHistoryId||profile.historyId}:{historyId:cursor.startHistoryId||profile.historyId};
  }
  const list=[...ids];let imported=0;
  for(let start=0;start<list.length;start+=10){
    const messages=await Promise.all(list.slice(start,start+10).map(async id=>{try{return await api(a,`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,{format:'full'});}catch(e){if(e.status===404)return null;throw e;}}));
    const items=messages.filter(Boolean).map(m=>{
      const headers=Object.fromEntries((m.payload?.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
      const participants=new Map();for(const type of ['from','to','cc'])for(const p of addresses(headers[type]))participants.set(p.email,{...p,role:type});
      return {kind:'email',externalId:m.id,title:headers.subject||'(No subject)',occurredAt:new Date(Number(m.internalDate)).toISOString(),body:messageText(m.payload)||m.snippet||'',url:`https://mail.google.com/mail/u/${encodeURIComponent(a.account)}/#all/${m.threadId}`,participants:[...participants.values()],raw:m};
    });
    if(items.length)await importItems({ownerEmail:a.ownerEmail,source:'gmail',account:a.account,items});imported+=items.length;
  }
  await sourceStatus(a.ownerEmail,'gmail',a.account,next.pageToken?'ready':'connected',{success:true,cursor:next,metadata:{local_authorized:true,backfill_pending:!!next.pageToken,last_batch:imported}});
}
async function syncCalendar(a){
  const calendars=await api(a,'https://www.googleapis.com/calendar/v3/users/me/calendarList',{maxResults:250});
  const members=await getMembers(),memberEmails=new Set(members.map(m=>m.email));
  const selected=(calendars.items||[]).filter(c=>!/#holiday@|#contacts@/.test(c.id)&&(c.primary||['owner','writer'].includes(c.accessRole)||memberEmails.has(c.id)));
  const row=await sourceRow(a,'calendar'),allCursors=parsed(row?.cursor);
  for(const c of selected){
    let cursor=allCursors[c.id]||{},pageToken=null,items=[];
    do{
      const params={maxResults:250,singleEvents:true,showDeleted:true,pageToken};
      if(cursor.syncToken)params.syncToken=cursor.syncToken;else{params.timeMin=new Date(Date.now()-180*86400000).toISOString();params.timeMax=new Date(Date.now()+365*86400000).toISOString();}
      let response;try{response=await api(a,`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events`,params);}catch(e){
        if(e.status!==410)throw e;
        cursor={};pageToken=null;delete params.syncToken;delete params.pageToken;
        params.timeMin=new Date(Date.now()-180*86400000).toISOString();params.timeMax=new Date(Date.now()+365*86400000).toISOString();
        response=await api(a,`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events`,params);
      }
      await markSourceUnavailable('google-calendar',c.id,(response.items||[]).filter(e=>e.status==='cancelled').map(e=>e.id),'Cancelled');
      for(const event of response.items||[]){
        if(event.status==='cancelled')continue;
        if(!event.start?.dateTime&&!event.start?.date)continue;
        const people=new Map();for(const p of [event.organizer,...(event.attendees||[])].filter(p=>p?.email)){try{people.set(email(p.email),{email:email(p.email),name:p.displayName,role:p===event.organizer?'organizer':'attendee'});}catch{}}
        items.push({kind:'meeting',externalId:event.id,title:event.summary||'Calendar meeting',occurredAt:event.start.dateTime||event.start.date+'T12:00:00Z',endsAt:event.end?.dateTime||null,body:event.description||'',url:event.htmlLink,participants:[...people.values()],raw:{...event,calendar_id:c.id,all_day:!event.start.dateTime}});
      }
      if(items.length){await importItems({ownerEmail:a.ownerEmail,source:'google-calendar',account:c.id,items});items=[];}
      pageToken=response.nextPageToken;if(response.nextSyncToken)allCursors[c.id]={syncToken:response.nextSyncToken};
    }while(pageToken);
  }
  await sourceStatus(a.ownerEmail,'calendar',a.account,'connected',{success:true,cursor:allCursors,metadata:{local_authorized:true,calendars:selected.map(c=>({id:c.id,name:c.summary})),backfill_pending:false}});
}
async function syncDrive(a){
  const row=await sourceRow(a,'drive'),cursor=parsed(row?.cursor);
  if(!cursor.startToken&&!cursor.changeToken)cursor.startToken=(await api(a,'https://www.googleapis.com/drive/v3/changes/startPageToken')).startPageToken;
  let files,next;
  const fields='id,name,mimeType,description,createdTime,modifiedTime,webViewLink,trashed,owners(emailAddress,displayName),sharingUser(emailAddress,displayName),permissions(emailAddress,displayName,type,role)';
  if(cursor.changeToken){const result=await api(a,'https://www.googleapis.com/drive/v3/changes',{pageToken:cursor.changeToken,pageSize:100,fields:`nextPageToken,newStartPageToken,changes(file(${fields}),removed,fileId)`});await markSourceUnavailable('google-drive',a.account,(result.changes||[]).filter(c=>c.removed).map(c=>c.fileId),'Removed from Drive or access ended');files=(result.changes||[]).filter(c=>c.file&&!c.removed).map(c=>c.file);next={changeToken:result.nextPageToken||result.newStartPageToken};}
  else{const result=await api(a,'https://www.googleapis.com/drive/v3/files',{pageSize:100,pageToken:cursor.pageToken,q:"trashed=false and mimeType!='application/vnd.google-apps.folder'",fields:`nextPageToken,files(${fields})`});files=result.files||[];next=result.nextPageToken?{...cursor,pageToken:result.nextPageToken}:{changeToken:cursor.startToken};}
  const items=files.map(f=>{
    const participants=new Map();for(const p of [...(f.owners||[]),f.sharingUser,...(f.permissions||[])].filter(p=>p?.emailAddress)){try{participants.set(email(p.emailAddress),{email:email(p.emailAddress),name:p.displayName,role:p.role||'shared-with'});}catch{}}
    return {kind:'document',externalId:f.id,title:f.name,occurredAt:f.modifiedTime||f.createdTime||new Date().toISOString(),body:f.description||'',url:f.webViewLink||`https://drive.google.com/file/d/${f.id}/view`,participants:[...participants.values()],raw:{...f,index_scope:'Drive file metadata and sharing relationships; source document remains in Drive'}};
  });
  if(items.length)await importItems({ownerEmail:a.ownerEmail,source:'google-drive',account:a.account,items});
  await sourceStatus(a.ownerEmail,'drive',a.account,next.pageToken?'ready':'connected',{success:true,cursor:next,metadata:{local_authorized:true,backfill_pending:!!next.pageToken,last_batch:items.length}});
}
let active=null;
export async function syncAll(){
  if(active)return {already_running:true};
  active=(async()=>{
    const results=[];
    for(const file of credentialsFiles()){
      const a=JSON.parse(await fs.readFile(file,'utf8'));
      for(const [provider,fn] of [['calendar',syncCalendar],['gmail',syncGmail],['drive',syncDrive]]){
        try{await sourceStatus(a.ownerEmail,provider,a.account,'syncing');await fn(a);results.push({account:a.account,provider,ok:true});}
        catch(error){await sourceStatus(a.ownerEmail,provider,a.account,'error',{error:error.message});results.push({account:a.account,provider,ok:false,error:error.message});}
      }
    }
    return results;
  })();
  try{return await active;}finally{active=null;}
}
export async function localGoogleAccounts(){return await Promise.all(credentialsFiles().map(async file=>JSON.parse(await fs.readFile(file,'utf8'))));}
