import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import worker from '../worker.js';
import {hash,GOOGLE_CLIENT_ID} from '../auth.js';

class D1 {
  constructor(){this.db=new DatabaseSync(':memory:');this.db.exec(fs.readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));this.db.exec(fs.readFileSync(new URL('../migrations/0001_auth.sql',import.meta.url),'utf8'));}
  prepare(sql){const db=this.db;let args=[];const q={bind(...a){args=a;return q;},async all(){return {results:db.prepare(sql).all(...args)};},async first(){return db.prepare(sql).get(...args)||null;},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};},execute(){return db.prepare(sql).run(...args);}};return q;}
  async batch(statements){this.db.exec('BEGIN');try{const result=statements.map(s=>({meta:{changes:Number(s.execute().changes)}}));this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
}
const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'test-key',alg:'RS256',use:'sig'};
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,...rest)=>url==='https://www.googleapis.com/oauth2/v3/certs'?new Response(JSON.stringify({keys:[jwk]}),{headers:{'cache-control':'max-age=3600'}}):originalFetch(url,...rest);
const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
async function jwt(nonce,claims={},header={}){
  const now=Math.floor(Date.now()/1000),parts=[enc({alg:'RS256',kid:'test-key',...header}),enc({iss:'https://accounts.google.com',aud:GOOGLE_CLIENT_ID,sub:'111111',email:'owner@educ.org.il',email_verified:true,hd:'educ.org.il',iat:now,exp:now+3600,nonce,...claims})];
  parts.push(Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,new TextEncoder().encode(parts.join('.')))).toString('base64url'));return parts.join('.');
}
async function call(db,path,options={}){const{token,body,origin,...rest}=options;return worker.fetch(new Request('https://hacala-api.1002220729.workers.dev'+path,{...rest,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})}),{DB:db});}
function setup(){const db=new D1();db.db.prepare('INSERT INTO system_admins(email,name,created_at) VALUES(?,?,?)').run('owner@educ.org.il','Owner','now');return db;}
async function login(db,claims={},role='admin'){
  const r=await call(db,'/api/auth/challenge',{method:'POST'}),{nonce}=await r.json();
  const res=await call(db,'/api/auth/google',{method:'POST',body:{role,nonce,credential:await jwt(nonce,claims)}});return {res,data:await res.json(),nonce};
}
async function syntheticSession(db,email,sub,role){const token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');db.db.prepare('INSERT OR IGNORE INTO auth_identities(email,google_sub) VALUES(?,?)').run(email,sub);db.db.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?,?)').run(await hash(token),email,sub,role,Date.now()+3600000);return token;}

test('all legacy management and data routes require a server session',async()=>{
  const db=setup();for(const route of ['/api/plans?school=A','/api/schools','/api/instructors','/api/supervisors','/api/admins','/api/principal?email=owner@educ.org.il','/api/system-admins','/api/nav-config'])assert.equal((await call(db,route)).status,401,route);
  for(const path of ['/api/instructors','/api/supervisors','/api/admins','/api/plans','/api/system-admins'])for(const method of ['POST','DELETE'])assert.equal((await call(db,path,{method,body:method==='POST'?{}:undefined})).status,401);
});
test('Google signature, issuer, audience, expiry, nonce and verified authoritative email are enforced',async()=>{
  const db=setup();for(const claims of [{iss:'evil'},{aud:'other'},{exp:1},{iat:1},{email_verified:false},{nonce:'replay'},{hd:undefined,email:'owner@example.com'},{sub:'bad-sub'}])assert.ok([401,403].includes((await login(db,claims)).res.status));
  const {nonce}=await (await call(db,'/api/auth/challenge',{method:'POST'})).json();
  const signed=await jwt(nonce);const forged=signed.split('.');forged[1]=enc({email:'owner@educ.org.il',sub:'111111',nonce});
  assert.equal((await call(db,'/api/auth/google',{method:'POST',body:{role:'admin',nonce,credential:forged.join('.')}})).status,401);
  const good=await login(db);assert.equal(good.res.status,200);assert.equal(good.data.portalRole,'admin');assert.ok(good.data.token);
  assert.equal((await call(db,'/api/auth/google',{method:'POST',body:{role:'admin',nonce:good.nonce,credential:await jwt(good.nonce)}})).status,401);
  assert.equal((await login(db,{email:'unlisted@educ.org.il',sub:'222222'})).res.status,403);
  assert.equal((await login(db,{sub:'333333'})).res.status,403);
});
test('admin transfer requires a confirmed replacement, protects last admin, revokes removed sessions',async()=>{
  const db=setup();const owner=(await login(db)).data.token;
  assert.equal((await call(db,'/api/system-admins',{method:'POST',token:owner,body:{email:'next@educ.org.il',name:'Next'}})).status,200);
  assert.equal((await call(db,'/api/system-admins?email=owner@educ.org.il',{method:'DELETE',token:owner})).status,409);
  const next=await login(db,{email:'next@educ.org.il',sub:'222222'});assert.equal(next.res.status,200);
  const removed=await call(db,'/api/system-admins?email=owner@educ.org.il',{method:'DELETE',token:next.data.token});assert.equal(removed.status,200);
  assert.equal((await call(db,'/api/system-admins',{token:owner})).status,401);
  assert.equal((await call(db,'/api/system-admins?email=next@educ.org.il',{method:'DELETE',token:next.data.token})).status,409);
  assert.equal((await login(db)).res.status,403);
});
test('concurrent removals cannot erase every confirmed admin',async()=>{
  const db=setup();const a=(await login(db)).data.token;
  await call(db,'/api/system-admins',{method:'POST',token:a,body:{email:'next@educ.org.il',name:'Next'}});const b=(await login(db,{email:'next@educ.org.il',sub:'222222'})).data.token;
  const result=await Promise.all([call(db,'/api/system-admins?email=owner@educ.org.il',{method:'DELETE',token:a}),call(db,'/api/system-admins?email=next@educ.org.il',{method:'DELETE',token:b})]);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM system_admins WHERE google_sub IS NOT NULL').get().n,1);assert.ok(result.some(r=>r.status===409));
});
test('role and school boundaries, audit identity, principal field whitelist, and logout',async()=>{
  const db=setup();db.db.exec(`INSERT INTO instructors(email,name,createdat) VALUES('inst@educ.org.il','Inst','now'),('other@educ.org.il','Other','now'); INSERT INTO instructor_schools(instructor_email,schoolname,year) VALUES('inst@educ.org.il','A','2026'),('other@educ.org.il','B','2026'); INSERT INTO supervisors(email,name,createdat) VALUES('sup@educ.org.il','Sup','now'); INSERT INTO supervisor_schools(supervisor_email,schoolname,year,instructor_email) VALUES('sup@educ.org.il','A','2026','inst@educ.org.il'),('sup@educ.org.il','B','2026','other@educ.org.il'); INSERT INTO admins(email,name,createdat,instructor_email,school,year) VALUES('principal@educ.org.il','Principal','now','inst@educ.org.il','A','2026'); INSERT INTO admin_schools(admin_email,schoolname,year) VALUES('principal@educ.org.il','A','2026');`);
  const inst=await syntheticSession(db,'inst@educ.org.il','444444','instructor'),sup=await syntheticSession(db,'sup@educ.org.il','555555','supervisor'),principal=await syntheticSession(db,'principal@educ.org.il','666666','principal');
  const plan={schoolname:'A',year:'2026',doctype:'hakala',content:{goals:'Keep',city:'City'},updatedby:'spoof'};
  assert.equal((await call(db,'/api/plans',{method:'POST',token:inst,body:plan})).status,200);assert.equal(db.db.prepare('SELECT updatedby FROM plans').get().updatedby,'inst@educ.org.il');
  for(const token of [sup,principal])assert.equal((await call(db,'/api/plans',{method:'POST',token,body:plan})).status,403);
  assert.equal((await call(db,'/api/plans?school=B&year=2026',{token:inst})).status,403);
  assert.equal((await call(db,'/api/plans?school=A&year=2027',{token:sup})).status,403);
  assert.equal((await call(db,'/api/instructors',{token:inst})).status,403);assert.equal((await call(db,'/api/system-admins',{token:inst})).status,403);
  assert.equal((await call(db,'/api/supervisors',{method:'POST',token:inst,body:{email:'sup@educ.org.il',name:'Sup',schools:[{schoolname:'B',year:'2026'}],instructor_email:'other@educ.org.il'}})).status,403);
  await call(db,'/api/supervisors?email=sup@educ.org.il',{method:'DELETE',token:inst});assert.equal(db.db.prepare("SELECT COUNT(*) n FROM supervisor_schools WHERE schoolname='B'").get().n,1);
  assert.equal((await call(db,'/api/principal/school-data',{method:'POST',token:principal,body:{school:'A',year:'2026',patches:{hakala:{city:'New city',goals:'Injected'}}}})).status,200);
  const content=JSON.parse(db.db.prepare("SELECT content FROM plans WHERE doctype='hakala'").get().content);assert.equal(content.city,'New city');assert.equal(content.goals,'Keep');
  assert.equal((await call(db,'/api/principal/school-data',{method:'POST',token:principal,body:{school:'B',year:'2026',patches:{}}})).status,403);
  assert.equal((await call(db,'/api/plans',{method:'POST',token:inst,body:{...plan,schoolname:'__navsys__'}})).status,403);
  assert.equal((await call(db,'/api/auth/logout',{method:'POST',token:inst})).status,200);assert.equal((await call(db,'/api/auth/session',{token:inst})).status,401);
});
test('expired sessions and disallowed origins fail; CORS is restricted and responses cannot be cached',async()=>{
  const db=setup(),{data}=await login(db);db.db.prepare('UPDATE auth_sessions SET expires_at=1').run();assert.equal((await call(db,'/api/auth/session',{token:data.token})).status,401);
  const bad=await call(db,'/api/auth/challenge',{method:'POST',origin:'https://evil.example'});assert.equal(bad.status,403);assert.equal(bad.headers.get('Access-Control-Allow-Origin'),null);
  const good=await call(db,'/api/auth/challenge',{method:'POST',origin:'https://hacalasite.pages.dev'});assert.equal(good.headers.get('Access-Control-Allow-Origin'),'https://hacalasite.pages.dev');assert.equal(good.headers.get('Cache-Control'),'no-store');
});
