import {executeSql,sqlIdentifier as i} from '../../../customers/scripts/lib/db.mjs';
const role=i('portomatic-crm@affable-heading-498721-f4.iam');
await executeSql(`
  GRANT CONNECT ON DATABASE portomatic_calls TO ${role};
  GRANT USAGE ON SCHEMA public TO ${role};
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};
  GRANT INSERT,UPDATE ON crm_members,crm_sources,crm_people,crm_person_emails,crm_touchpoints,crm_touchpoint_people,crm_links,crm_audit_log,crm_transcription_jobs,crm_transcripts,crm_transcript_segments,crm_speaker_jobs,crm_speaker_assignments,crm_sales_feedback_jobs TO ${role};
  GRANT UPDATE ON crm_person_profiles TO ${role};
  GRANT DELETE ON crm_touchpoint_people TO ${role};
  GRANT INSERT ON media_archive_assets TO ${role};
  GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
  DO $$ BEGIN IF to_regclass('crm_companies') IS NOT NULL THEN
    GRANT INSERT,UPDATE ON crm_companies,crm_company_person_links TO ${role};
  END IF; END $$;
`,{bootstrap:true,application:'crm_runtime_grants'});
console.log('Granted CRM runtime database permissions');
