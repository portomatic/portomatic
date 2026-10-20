#!/usr/bin/env python3
"""Configure only CRM Access, tunnel and DNS; never modify Pool resources."""
import json, pathlib, urllib.request, secrets, base64, sys
state=pathlib.Path(__file__).resolve().parents[1]/'.state'
creds=dict(l.split('=',1) for l in (pathlib.Path.home()/'.supapool/cloudflare-global').read_text().splitlines() if '=' in l)
headers={'X-Auth-Email':creds['EMAIL'].strip('" '),'X-Auth-Key':creds['GLOBAL_API_KEY'].strip('" '),'Content-Type':'application/json'}
def api(route, method='GET', body=None):
    req=urllib.request.Request('https://api.cloudflare.com/client/v4/'+route,headers=headers,method=method,data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req,timeout=30) as r: result=json.load(r)
    if not result.get('success'): raise RuntimeError(str(result.get('errors')))
    return result['result']
z=api('zones?name=portomatic.com')[0]; account=z['account']['id']; zone=z['id']; root=f'accounts/{account}'
apps=api(root+'/access/apps'); app=next((a for a in apps if a.get('domain')=='crm.portomatic.com'),None)
if not app:
    app=api(root+'/access/apps','POST',{'name':'Portomatic CRM','domain':'crm.portomatic.com','type':'self_hosted','session_duration':'720h','auto_redirect_to_identity':True,'http_only_cookie_attribute':True,'same_site_cookie_attribute':'strict'})
policies=api(root+f'/access/apps/{app["id"]}/policies')
policy={'name':'CRM founders','decision':'allow','precedence':1,'include':[{'email':{'email':e}} for e in ['kevin@portomatic.com','zach@portomatic.com']]}
if not policies: api(root+f'/access/apps/{app["id"]}/policies','POST',policy)
else:
    if len(policies)!=1 or policies[0]['decision']!='allow' or sorted(x.get('email',{}).get('email') for x in policies[0]['include'])!=['kevin@portomatic.com','zach@portomatic.com']:
        raise RuntimeError('Unexpected CRM access policy; refusing DNS change')
tunnels=api(root+'/cfd_tunnel?is_deleted=false'); tunnel=next((t for t in tunnels if t['name']=='portomatic-crm'),None)
if not tunnel: tunnel=api(root+'/cfd_tunnel','POST',{'name':'portomatic-crm','config_src':'cloudflare','tunnel_secret':base64.b64encode(secrets.token_bytes(32)).decode()})
api(root+f'/cfd_tunnel/{tunnel["id"]}/configurations','PUT',{'config':{'ingress':[{'hostname':'crm.portomatic.com','service':'http://127.0.0.1:3180'},{'service':'http_status:404'}]}})
org=api(root+'/access/organizations')
config={'account_id':account,'zone_id':zone,'app_id':app['id'],'audience':app['aud'],'issuer':'https://'+org['auth_domain'],'tunnel_id':tunnel['id']}
(state/'cloud-deployment.json').write_text(json.dumps(config,indent=2)); (state/'cloud-deployment.json').chmod(0o600)
if '--dns' in sys.argv:
    records=api(f'zones/{zone}/dns_records?name=crm.portomatic.com')
    record={'type':'CNAME','name':'crm.portomatic.com','content':tunnel['id']+'.cfargotunnel.com','proxied':True,'ttl':1}
    if records:
        if len(records)!=1 or records[0]['content']!=record['content']: raise RuntimeError('Unexpected CRM DNS destination')
    else: api(f'zones/{zone}/dns_records','POST',record)
    print('CRM DNS points to its protected tunnel')
else:
    token=api(root+f'/cfd_tunnel/{tunnel["id"]}/token')
    (state/'tunnel-token').write_text(token); (state/'tunnel-token').chmod(0o600)
    print('Created CRM Access protection and separate tunnel; DNS not enabled yet')
