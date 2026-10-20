#!/usr/bin/env python3
"""Produce a private, filtered Messages snapshot for the Cloud SQL importer."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys

import imessage_classify as classifier

STATE = classifier.STATE

def clean_text(text):
    # Credential values do not belong in a shared customer history.
    text=re.sub(r'(?i)\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b','[API key redacted]',text)
    text=re.sub(r'(?im)((?:password|passcode|api[_ -]?key|access[_ -]?token)\s*[:=]\s*)\S+',r'\1[redacted]',text)
    return text.replace('\x00','')

def export_snapshot(*, db_path, book_path, policy_path, output_path, mode, classify_new=False):
    if mode not in ['text','metadata']:
        raise RuntimeError('Choose text or metadata sync.')
    if not Path(policy_path).is_file() or not classifier.MANUAL_REVIEWS.is_file():
        raise RuntimeError('Required local exclusions or reviewed-contact ledger missing; sync stopped.')
    policy=json.loads(Path(policy_path).read_text())
    if not all(isinstance(policy.get(s),list) and policy[s] for s in ['contacts','privacy_holds','private_service_senders']):
        raise RuntimeError('Incomplete exclusion policy; sync stopped.')
    decisions_path=STATE/'sync-decisions.json'
    cached=json.loads(decisions_path.read_text()) if decisions_path.exists() else {}
    reviews=classifier.load_manual_reviews(classifier.MANUAL_REVIEWS)
    baseline_path=classifier.MANUAL_REVIEWS.with_name('decisions-baseline.json')
    if not baseline_path.exists():
        raise RuntimeError('Required exclusion identity baseline missing; sync stopped.')
    baseline=json.loads(baseline_path.read_text())
    required_reviews={c['id'] for c in baseline['contacts'] if c.get('decisions')}
    if not reviews or not required_reviews.issubset(reviews):
        raise RuntimeError('Manual verification ledger is incomplete; sync stopped.')
    # Keep excluded aliases blocked even if an address-book record is later deleted
    # or recreated under a different ID. Never infer aliases from a shared name.
    for c in baseline['contacts']:
        review=reviews.get(c['id'])
        if review and review['manual_verdict']!='business_or_mixed':
            policy['privacy_holds'].append({'category':'manual_sync_exclusion','observed_identifiers':c['identifiers']})
    for cached_decision in cached.values():
        if cached_decision['status']!='business_or_mixed':
            policy['privacy_holds'].append({'category':'automatic_sync_exclusion','observed_identifiers':cached_decision.get('identifiers',[])})
    effective_policy=STATE/'sync-effective-policy.json'
    classifier.private_write(effective_policy,policy)
    plan,payloads=classifier.build_catalog(db_path,book_path,effective_policy,manual_review_path=classifier.MANUAL_REVIEWS,continuous_sync=True)
    client=None
    approved=[]
    retained=[]
    metrics={}
    for c in plan['contacts']:
        messages=payloads.get(c['id'],[])
        if c['status']=='pending_api':
            previous=cached.get(c['id'])
            if previous and previous.get('identity_fingerprint')!=classifier.identity_fingerprint(c):
                c.update(status='held_identity')
            elif previous and (previous['status']!='business_or_mixed' or previous['source_fingerprint']==classifier.digest(messages)):
                c.update(status=previous['status'])
            elif classify_new:
                if client is None:
                    api_key=classifier.load_api_key(STATE/'api-config.json')
                    if api_key:
                        client=classifier.Decisions(api_key,STATE/'cache')
                if client is None:
                    c.update(status='held_api_error')
                else:
                    try:
                        result=classifier.classify_contact(messages,client)
                        c.update(result)
                        cached[c['id']]={**result,'identifiers':c['identifiers'],'identity_fingerprint':classifier.identity_fingerprint(c),'source_fingerprint':classifier.digest(messages),'evaluated_at':dt.datetime.now(dt.timezone.utc).isoformat()}
                        classifier.private_write(decisions_path,cached)
                    except Exception:
                        c.update(status='held_api_error')
            else:
                c.update(status='held_new_contact')
        metrics[c['status']]=metrics.get(c['status'],0)+1
        if c['status'] in ['held_decode','held_api_error']:
            retained.append(c['id'])
        if c['status']!='business_or_mixed':
            continue
        if not messages or not c.get('nonreaction_outgoing'):
            raise RuntimeError('Allowed contact lacks a complete eligible source history; sync stopped.')
        review=c.get('manual_review',{})
        exported=[]
        for m in messages:
            # Native tapbacks are already excluded by the source query. Do the same
            # for migrated text tapbacks; they are not new authored messages.
            if classifier.is_text_reaction(m['text']):
                continue
            text=clean_text(m['text']) if mode=='text' else ''
            item={'guid':m['guid'],'date':m['date'],'direction':'outgoing' if m['speaker']=='YOU' else 'incoming','text':text}
            item['fingerprint']=classifier.digest({'contact':c['id'],'mode':mode,**item})
            exported.append(item)
        approved.append({'id':c['id'],'name':c['name'],'identifiers':c['identifiers'],'threads':c['threads'],'basis':'manual_source_review' if review else 'automatic_relationship_classification','outreachSuppressed':bool(review.get('outreach_suppressed')),'preferredChannel':review.get('preferred_outreach_channel'),'messages':exported})
    export={'version':1,'createdAt':dt.datetime.now(dt.timezone.utc).isoformat(),'mode':mode,'policyHash':plan['policy_hash'],'reviewHash':classifier.digest(classifier.load_manual_reviews(classifier.MANUAL_REVIEWS)),'contacts':approved,'retainedContactIds':retained,'counts':{'contacts':len(approved),'messages':sum(len(c['messages']) for c in approved),'sourceStatuses':metrics,'groupThreadsHeld':plan['counts'].get('group_threads_held_separate',0),'combinedRecordsHeld':plan['counts'].get('held_combined_records',0),'remoteRequests':client.requests if client else 0},'scope':'Direct conversations with authored outgoing activity, after local never-sync and relationship exclusions. No attachments or group records.'}
    classifier.private_write(output_path,export)
    return {'export':str(output_path),'mode':mode,'counts':export['counts'],'policyHash':export['policyHash']}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db',default='~/Library/Messages/chat.db')
    p.add_argument('--address-book',default='~/Library/Application Support/AddressBook')
    p.add_argument('--policy',default=str(classifier.ROOT/'.state/never-sync-research.json'))
    p.add_argument('--output',default=str(STATE/'sync-export.json'))
    p.add_argument('--mode',choices=['text','metadata'],required=True)
    p.add_argument('--classify-new',action='store_true')
    a=p.parse_args()
    print(json.dumps(export_snapshot(db_path=a.db,book_path=a.address_book,policy_path=a.policy,output_path=a.output,mode=a.mode,classify_new=a.classify_new)))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'error':str(error) if isinstance(error,RuntimeError) else type(error).__name__}),file=sys.stderr)
        sys.exit(1)
