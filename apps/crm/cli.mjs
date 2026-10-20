#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {settings,saveSettings} from './lib/config.mjs';
import {parseArgs} from '../../customers/scripts/lib/cli.mjs';
import {state,initMembers,refreshArchive,importItems,addNote,getMembers,email} from './lib/store.mjs';
import {queryRows,sqlLiteral as q} from '../../customers/scripts/lib/db.mjs';
import {uuid} from './lib/store.mjs';
import {enqueueTranscription} from './lib/transcription.mjs';
import {enqueueSpeakerJobs,speakerStatus} from './lib/speakers.mjs';
import {resolveSpeakerModel} from './lib/openai.mjs';
import {enqueueSalesFeedback,salesFeedbackStatus,salesFeedbackReport} from './lib/sales-feedback.mjs';
import {importCompanyResearch,companiesState,updateCompany,linkCompanyPerson} from './lib/companies.mjs';

const [command='status',...argv]=process.argv.slice(2),args=parseArgs(argv);
try{
  let result;
  if(command.startsWith('imessage-')){
    const {runImessage}=await import('./lib/imessage.mjs');result=await runImessage(command.slice('imessage-'.length),args);
  }
  else if(command==='init'){await initMembers();await refreshArchive();result={initialized:true};}
  else if(command==='settings'){
    const updates={};
    if(args.owner){updates.ownerEmail=email(args.owner);if(!(await getMembers()).some(m=>m.email===updates.ownerEmail))throw new Error('Choose an existing founder');}
    if(args.folder){updates.recordingFolder=path.resolve(args.folder);if(!fs.statSync(updates.recordingFolder).isDirectory())throw new Error('Recording folder must be a directory');}
    if(args.watch!==undefined)updates.watchRecordings=args.watch!==false&&args.watch!=='false';
    result=Object.keys(updates).length?saveSettings(updates):settings();
  }
  else if(command==='research-import'){
    if(!args.file)throw new Error('Usage: crm research-import --file research-data.json [--slug yc-slack-bots] [--name "List name"]');
    result=await importCompanyResearch(JSON.parse(fs.readFileSync(args.file,'utf8')),{slug:args.slug,name:args.name});
  }else if(command==='companies'){
    result=await companiesState({search:args.query||'',company:args.company,list:args.list,evidence:args.evidence,category:args.category,owner:args.owner});
  }else if(command==='company-update'){
    if(!args.file)throw new Error('Use --file with JSON containing id, relationship, nextStep, notes, ownerId');
    const v=JSON.parse(fs.readFileSync(args.file,'utf8'));result=await updateCompany(v.id,v,settings().ownerEmail);
  }else if(command==='company-person'){
    result=await linkCompanyPerson({companyId:args.company,personId:args.person,status:args.status},settings().ownerEmail);
  }else if(command==='list'||command==='status'||command==='timeline'||command==='search'){
    const data=await state({search:args.query||args._.join(' '),person:args.person,owner:args.owner,kind:args.kind,limit:args.limit||100});
    result=command==='status'?{counts:data.counts,members:data.members,sources:data.sources}:command==='list'?data.people:data.timeline;
  }else if(command==='import'){
    const input=args.file?fs.readFileSync(args.file,'utf8'):fs.readFileSync(0,'utf8');result=await importItems(JSON.parse(input));
  }else if(command==='linkedin'){
    if(!args.file||!args.owner)throw new Error('Usage: crm linkedin --file /path/export.zip --owner founder@example.com');
    const {importLinkedin}=await import('./lib/linkedin.mjs');result=await importLinkedin(args.file,args.owner,{exportedAt:args.date||null});
  }else if(command==='recording'){
    if(!args.file||!args.owner)throw new Error('Usage: crm recording --file /path/recording.mov --owner founder@example.com');
    const {archiveRecording}=await import('./lib/archive.mjs');result=await archiveRecording(args.file,args.owner);
  }else if(command==='sync'){
    const {syncAll}=await import('./lib/google.mjs');result=await syncAll();
  }
  else if(command==='note')result=await addNote(args.person,args.text,args.owner);
  else if(command==='transcribe'){
    if(!args.recording&&!args.backfill)throw new Error('Use --recording TOUCHPOINT_UUID or --backfill');
    result=await enqueueTranscription(args.recording||null,{automatic:!!args.backfill,requestedBy:args.owner||settings().ownerEmail});
  }else if(command==='name-speakers'){
    if(!args.recording&&!args.backfill)throw new Error('Use --recording TOUCHPOINT_UUID or --backfill');
    const {model}=await resolveSpeakerModel({force:!!args['refresh-model']});
    result=await enqueueSpeakerJobs({recordingId:args.recording||null,model,force:!!args.force});
  }else if(command==='speaker-status')result=await speakerStatus();
  else if(command==='sales-feedback')result=await enqueueSalesFeedback(args.recording||null);
  else if(command==='sales-feedback-status')result=await salesFeedbackStatus(args.recording||null);
  else if(command==='sales-feedback-report'){if(!args.recording)throw Error('Use --recording TOUCHPOINT_UUID');result=await salesFeedbackReport(args.recording);}
  else if(command==='transcripts'){
    const where=['tr.is_current'];
    if(args.recording)where.push(`tr.touchpoint_id=${uuid(args.recording)}`);
    const query=args.query||args._.join(' ');
    if(query)where.push(`(s.search_document @@ websearch_to_tsquery('english',${q(query)}) OR s.transcript ILIKE ${q('%'+query+'%')})`);
    result=await queryRows(`SELECT t.touchpoint_id,t.title,t.storage_uri,tr.run_id,tr.provider,tr.model,s.start_ms,s.end_ms,s.display_speaker AS speaker,s.original_speaker,s.inferred_name,s.name_confidence,s.name_reason,s.name_evidence,s.speaker_model,s.transcript,s.confidence FROM crm_named_transcript_segments s JOIN crm_transcripts tr USING(run_id) JOIN crm_touchpoints t USING(touchpoint_id) WHERE ${where.join(' AND ')} ORDER BY t.occurred_at DESC,s.sequence LIMIT ${Math.min(1000,Math.max(1,Number(args.limit)||100))};`);
  }else if(command==='transcription-status')result=await queryRows(`SELECT j.job_id,t.title,j.provider,j.model,j.status,j.attempts,j.error,j.created_at,j.finished_at FROM crm_transcription_jobs j JOIN crm_touchpoints t USING(touchpoint_id) ORDER BY j.created_at DESC;`);
  else throw new Error('Commands: init, settings, status, list, timeline, search, import, research-import, companies, company-update, company-person, linkedin, recording, sync, note, transcribe, transcripts, transcription-status, name-speakers, speaker-status, sales-feedback, sales-feedback-status, sales-feedback-report, imessage-prepare, imessage-probe, imessage-classify, imessage-status, imessage-sync, imessage-sync-status, imessage-sync-configure, imessage-sync-init');
  console.log(JSON.stringify(result||{ok:true},null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
