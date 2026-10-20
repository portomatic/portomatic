BEGIN;
-- Carry existing CRM database writers onto the new company tables. No new principals.
DO $$
DECLARE crm_role record;
BEGIN
  FOR crm_role IN SELECT oid,rolname FROM pg_roles WHERE rolcanlogin
    AND has_table_privilege(oid,'crm_people','SELECT') AND has_table_privilege(oid,'crm_people','UPDATE')
  LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON crm_companies,crm_company_aliases,crm_company_domains,crm_company_lists,crm_company_research_imports,crm_company_list_members,crm_company_person_links TO %I',crm_role.rolname);
    EXECUTE format('GRANT SELECT ON crm_company_person_matches TO %I',crm_role.rolname);
  END LOOP;
END $$;
INSERT INTO schema_migrations(migration_name) VALUES('018_crm_company_access.sql');
COMMIT;
