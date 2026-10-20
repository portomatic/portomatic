import {createRemoteJWKSet,jwtVerify} from 'jose';

export const founders=new Set(['kevin@portomatic.com','zach@portomatic.com']);
export function createAccess({issuer=process.env.CRM_ACCESS_ISSUER,audience=process.env.CRM_ACCESS_AUDIENCE,keys}={}){
  if(!issuer||!audience)throw new Error('Hosted CRM requires Access issuer and audience');
  const jwks=keys||createRemoteJWKSet(new URL('/cdn-cgi/access/certs',issuer));
  return async token=>{
    const {payload}=await jwtVerify(token,jwks,{issuer,audience,algorithms:['RS256'],requiredClaims:['exp','iat','sub','email']});
    const email=String(payload.email).toLowerCase();
    if(!founders.has(email))throw new Error('Access denied');
    return email;
  };
}
