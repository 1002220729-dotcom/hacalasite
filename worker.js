import {HttpError,denied,randomToken,hash,verifyGoogle,normalizeEmail,authenticate,membership} from './auth.js';
const ORIGINS=new Set(['https://hacalasite.pages.dev','https://1002220729-dotcom.github.io']);
const NAV=new Set(['__navsys__','__nav_sys__']);
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
const run=(db,sql,...args)=>stmt(db,sql,...args).run();
const first=(db,sql,...args)=>stmt(db,sql,...args).first();
const rows=async(db,sql,...args)=>(await stmt(db,sql,...args).all()).results||[];
const adminOnly=s=>{if(s.portal_role!=='admin')denied();};
const manageOnly=s=>{if(!['admin','instructor'].includes(s.portal_role))denied();};
function text(v,max=200){if(typeof v!=='string'||!v.trim()||v.length>max||/[<>\u0000-\u001f]/.test(v))throw new HttpError(400,'שדה חסר או לא תקין');return v.trim();}
async function bodyOf(r){const raw=await r.text();if(raw.length>2_000_000)throw new HttpError(413,'המסמך גדול מדי');try{const b=JSON.parse(raw);if(!b||Array.isArray(b)||typeof b!=='object')throw 0;return b;}catch{throw new HttpError(400,'בקשה לא תקינה');}}
const audit=(db,actor,action,target)=>run(db,'INSERT INTO auth_audit(actor,action,target,created_at) VALUES(?,?,?,?)',actor,action,target,new Date().toISOString());
async function schoolsFor(db,s){
  if(s.portal_role==='admin')return rows(db,"SELECT DISTINCT schoolname,year FROM plans WHERE schoolname NOT IN ('__navsys__','__nav_sys__') ORDER BY schoolname");
  const [table,key]={instructor:['instructor_schools','instructor_email'],supervisor:['supervisor_schools','supervisor_email'],principal:['admin_schools','admin_email']}[s.portal_role];
  const list=await rows(db,`SELECT schoolname,year FROM ${table} WHERE lower(${key})=? ORDER BY schoolname`,s.email);
  if(s.portal_role==='principal'&&s.member.school&&s.member.year&&!list.some(v=>v.schoolname===s.member.school&&v.year===s.member.year))list.push({schoolname:s.member.school,year:s.member.year});
  return list;
}
async function hasSchool(db,s,school,year){return s.portal_role==='admin'||(!NAV.has(school)&&(await schoolsFor(db,s)).some(v=>v.schoolname===school&&(!year||v.year===year)));}
async function profile(db,s){
  const schools=await schoolsFor(db,s);
  const p={...s.member,email:s.email,portalRole:s.portal_role,name:s.member.name,picture:'',schools,expiresAt:s.expires_at};
  if(s.portal_role==='supervisor')p.supervisor=s.member;
  delete p.google_sub;return p;
}
export default{async fetch(request,env){
  const origin=request.headers.get('Origin');let response;
  try{if(origin&&!ORIGINS.has(origin))denied();response=request.method==='OPTIONS'?new Response(null,{status:204}):await handle(request,env.DB);}
  catch(e){response=String(e.message).includes('LAST_SYSTEM_ADMIN')?json({error:'לא ניתן להסיר את המנהל האחרון. יש להוסיף מנהל נוסף ולוודא שנכנס בהצלחה'},409):json({error:e instanceof HttpError?e.message:'הפעולה לא הושלמה. נסו שוב'},e instanceof HttpError?e.status:500);}
  const headers=new Headers(response.headers);headers.set('Vary','Origin');headers.set('Cache-Control','no-store');
  if(ORIGINS.has(origin)){headers.set('Access-Control-Allow-Origin',origin);headers.set('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');headers.set('Access-Control-Allow-Headers','Authorization, Content-Type');headers.set('Access-Control-Max-Age','600');}
  return new Response(response.body,{status:response.status,headers});
}};
async function handle(request,db){
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(path==='/api/auth/challenge'&&method==='POST'){
    const nonce=randomToken();await db.batch([stmt(db,'DELETE FROM auth_challenges WHERE expires_at<=?',Date.now()),stmt(db,'DELETE FROM auth_sessions WHERE expires_at<=?',Date.now()),stmt(db,'INSERT INTO auth_challenges(nonce,expires_at) VALUES(?,?)',nonce,Date.now()+600000)]);return json({nonce});
  }
  if(path==='/api/auth/google'&&method==='POST'){
    const b=await bodyOf(request);
    if(!['admin','instructor','supervisor','principal'].includes(b.role)||!/^[a-f0-9]{64}$/.test(b.nonce||''))throw new HttpError(400,'בקשת כניסה לא תקינה');
    if(!await first(db,'SELECT nonce FROM auth_challenges WHERE nonce=? AND expires_at>?',b.nonce,Date.now()))throw new HttpError(401,'בקשת הכניסה פגה. נסו שוב');
    const identity=await verifyGoogle(b.credential,b.nonce);await membership(db,b.role,identity.email,identity.sub);
    if((await run(db,'DELETE FROM auth_challenges WHERE nonce=? AND expires_at>?',b.nonce,Date.now())).meta.changes!==1)throw new HttpError(401,'בקשת הכניסה כבר נוצלה');
    await run(db,'INSERT OR IGNORE INTO auth_identities(email,google_sub) VALUES(?,?)',identity.email,identity.sub);
    const bound=await first(db,'SELECT google_sub FROM auth_identities WHERE email=?',identity.email);if(!bound||bound.google_sub!==identity.sub)denied();
    if(b.role==='admin'){await run(db,'UPDATE system_admins SET google_sub=?,confirmed_at=COALESCE(confirmed_at,?) WHERE email=? AND (google_sub IS NULL OR google_sub=?)',identity.sub,new Date().toISOString(),identity.email,identity.sub);await membership(db,'admin',identity.email,identity.sub);await audit(db,identity.email,'admin_login',identity.email);}
    const token=randomToken(),expiresAt=Date.now()+14400000;
    await run(db,'INSERT INTO auth_sessions(token_hash,email,google_sub,portal_role,expires_at) VALUES(?,?,?,?,?)',await hash(token),identity.email,identity.sub,b.role,expiresAt);
    const s={email:identity.email,google_sub:identity.sub,portal_role:b.role,expires_at:expiresAt,member:await membership(db,b.role,identity.email,identity.sub)};
    return json({...await profile(db,s),name:identity.name,picture:identity.picture,token});
  }
  const s=await authenticate(request,db);
  if(path==='/api/auth/session'&&method==='GET')return json(await profile(db,s));
  if(path==='/api/auth/logout'&&method==='POST'){await run(db,'DELETE FROM auth_sessions WHERE token_hash=?',s.token_hash);return json({ok:true});}
  if(path==='/api/system-admins'){
    adminOnly(s);
    if(method==='GET')return json(await rows(db,'SELECT email,name,created_at,confirmed_at FROM system_admins ORDER BY created_at,email'));
    if(method==='POST'){
      const b=await bodyOf(request),email=normalizeEmail(b.email),name=text(b.name);
      if(!(await run(db,'INSERT OR IGNORE INTO system_admins(email,name,created_at) VALUES(?,?,?)',email,name,new Date().toISOString())).meta.changes)throw new HttpError(409,'החשבון כבר מופיע ברשימת המנהלים');
      await audit(db,s.email,'admin_invited',email);return json({ok:true});
    }
    if(method==='DELETE'){
      const email=normalizeEmail(url.searchParams.get('email'));
      await db.batch([stmt(db,'DELETE FROM system_admins WHERE email=?',email),stmt(db,"DELETE FROM auth_sessions WHERE email=? AND portal_role='admin'",email),stmt(db,'INSERT INTO auth_audit(actor,action,target,created_at) VALUES(?,?,?,?)',s.email,'admin_removed',email,new Date().toISOString())]);return json({ok:true});
    }
  }
  if(path==='/api/plans'&&method==='GET'){
    const school=text(url.searchParams.get('school')),year=url.searchParams.get('year'),doctype=url.searchParams.get('doctype');
    if(NAV.has(school))return json((await rows(db,"SELECT * FROM plans WHERE schoolname=? AND year='cfg' AND doctype='nav_vis'",school)).map(v=>({...v,content:JSON.parse(v.content)})));
    if(!await hasSchool(db,s,school,year))denied();
    let query='SELECT * FROM plans WHERE schoolname=?',params=[school];if(year){query+=' AND year=?';params.push(year);}if(doctype){query+=' AND doctype=?';params.push(doctype);}
    const allowed=await schoolsFor(db,s);
    return json((await rows(db,query,...params)).filter(v=>s.portal_role==='admin'||allowed.some(a=>a.schoolname===v.schoolname&&a.year===v.year)).map(v=>({...v,content:JSON.parse(v.content)})));
  }
  if(path==='/api/plans'&&method==='POST'){
    manageOnly(s);const b=await bodyOf(request),school=text(b.schoolname),year=text(b.year,30),doctype=text(b.doctype,40);
    if(NAV.has(school))adminOnly(s);else if(!await hasSchool(db,s,school,year))denied();
    let content=b.content;if(typeof content==='string'){try{content=JSON.parse(content);}catch{throw new HttpError(400,'תוכן המסמך אינו תקין');}}
    if(!content||Array.isArray(content)||typeof content!=='object')throw new HttpError(400,'תוכן המסמך אינו תקין');
    const updatedat=new Date().toISOString();await savePlan(db,school,year,doctype,content,updatedat,s.email);return json({ok:true,updatedat});
  }
  if(path==='/api/principal/school-data'&&method==='POST'){
    if(s.portal_role!=='principal')denied();const b=await bodyOf(request),school=text(b.school),year=text(b.year,30);if(!await hasSchool(db,s,school,year))denied();
    const ops=[];for(const doctype of ['hakala','yesodi']){
      const plan=await first(db,'SELECT content FROM plans WHERE schoolname=? AND year=? AND doctype=?',school,year,doctype),content=plan?JSON.parse(plan.content):{};
      for(const key of ['schoolName','city','principalName','numStudents','numClasses','specialClasses',doctype==='hakala'?'coordinatorName':'yesodiCoordinatorName']){const value=b.patches?.[doctype]?.[key];if(typeof value==='string'&&value.length<=500)content[key]=value;}
      ops.push(planStatement(db,school,year,doctype,content,new Date().toISOString(),s.email));
    }await db.batch(ops);return json({ok:true});
  }
  if(path==='/api/schools'&&method==='GET')return json(await schoolsFor(db,s));
  if(path==='/api/instructor/schools'&&method==='GET'){
    const email=normalizeEmail(url.searchParams.get('email'));if(s.portal_role!=='admin'&&(s.portal_role!=='instructor'||email!==s.email))denied();return json(await rows(db,'SELECT schoolname,year FROM instructor_schools WHERE lower(instructor_email)=? ORDER BY schoolname',email));
  }
  if(['/api/instructor','/api/supervisor','/api/principal','/api/admin'].includes(path)&&method==='GET'){
    const email=normalizeEmail(url.searchParams.get('email')),role=path==='/api/admin'?'principal':path.split('/').pop();
    if(s.portal_role!=='admin'&&(s.portal_role!==role||email!==s.email))denied();
    const member=await membership(db,role,email,s.google_sub),target={...s,email,member,portal_role:role};
    if(role==='supervisor')return json({supervisor:member,schools:await rows(db,'SELECT ss.schoolname,ss.year,p.doctype FROM supervisor_schools ss LEFT JOIN plans p ON p.schoolname=ss.schoolname AND p.year=ss.year WHERE lower(ss.supervisor_email)=? ORDER BY ss.schoolname',email)});
    return json({...member,schools:await schoolsFor(db,target)});
  }
  const c={'/api/instructors':{table:'instructors',map:'instructor_schools',key:'instructor_email'},'/api/supervisors':{table:'supervisors',map:'supervisor_schools',key:'supervisor_email'},'/api/admins':{table:'admins',map:'admin_schools',key:'admin_email'}}[path];
  if(c){
    manageOnly(s);if(c.table==='instructors')adminOnly(s);
    if(method==='GET'){
      let list;const filter=s.portal_role==='instructor'?s.email:url.searchParams.get('instructor');
      if(filter&&c.table==='supervisors')list=await rows(db,'SELECT DISTINCT v.* FROM supervisors v JOIN supervisor_schools ss ON lower(ss.supervisor_email)=lower(v.email) WHERE lower(ss.instructor_email)=? ORDER BY v.name',normalizeEmail(filter));
      else if(filter&&c.table==='admins')list=await rows(db,'SELECT * FROM admins WHERE lower(instructor_email)=? ORDER BY name',normalizeEmail(filter));
      else list=await rows(db,`SELECT * FROM ${c.table} ORDER BY name`);
      const own=s.portal_role==='instructor'?await schoolsFor(db,s):null;
      for(const member of list){member.schools=await rows(db,`SELECT schoolname,year${c.table==='supervisors'?',instructor_email':''} FROM ${c.map} WHERE lower(${c.key})=?`,member.email.toLowerCase());if(own)member.schools=member.schools.filter(v=>own.some(a=>a.schoolname===v.schoolname&&a.year===v.year)&&(c.table!=='supervisors'||v.instructor_email?.toLowerCase()===s.email));}
      return json(list);
    }
    if(method==='POST')return manageSave(db,s,c,await bodyOf(request));
    if(method==='DELETE'){
      const email=normalizeEmail(url.searchParams.get('email'));
      if(s.portal_role==='instructor'&&c.table==='supervisors')await db.batch([stmt(db,'DELETE FROM supervisor_schools WHERE lower(supervisor_email)=? AND lower(instructor_email)=?',email,s.email),stmt(db,'DELETE FROM supervisors WHERE lower(email)=? AND NOT EXISTS(SELECT 1 FROM supervisor_schools WHERE lower(supervisor_email)=?)',email,email)]);
      else{if(s.portal_role==='instructor'&&(await first(db,'SELECT instructor_email FROM admins WHERE lower(email)=?',email))?.instructor_email?.toLowerCase()!==s.email)denied();await db.batch([stmt(db,`DELETE FROM ${c.map} WHERE lower(${c.key})=?`,email),stmt(db,`DELETE FROM ${c.table} WHERE lower(email)=?`,email)]);}
      return json({ok:true});
    }
  }
  throw new HttpError(404,'הכתובת לא נמצאה');
}
const planStatement=(db,school,year,doctype,content,date,email)=>stmt(db,'INSERT INTO plans(schoolname,year,doctype,content,updatedat,updatedby) VALUES(?,?,?,?,?,?) ON CONFLICT(schoolname,year,doctype) DO UPDATE SET content=excluded.content,updatedat=excluded.updatedat,updatedby=excluded.updatedby',school,year,doctype,JSON.stringify(content),date,email);
const savePlan=(...args)=>planStatement(...args).run();
async function manageSave(db,s,c,b){
  const email=normalizeEmail(b.email),name=text(b.name),role=b.role?text(b.role):'',old=await first(db,`SELECT * FROM ${c.table} WHERE lower(email)=?`,email);
  const schools=Array.isArray(b.schools)?b.schools:b.school&&b.year?[{schoolname:b.school,year:b.year}]:[];
  if(schools.length>200)throw new HttpError(400,'יותר מדי שיוכים');
  for(const v of schools){text(v.schoolname);text(v.year,30);if(NAV.has(v.schoolname))denied();}
  if(s.portal_role==='instructor'){
    for(const v of schools)if(!await hasSchool(db,s,v.schoolname,v.year))denied();
    if(c.table==='admins'&&old&&old.instructor_email?.toLowerCase()!==s.email)denied();
    if(c.table==='supervisors'&&old&&(old.name!==name||old.role!==role)&&await first(db,'SELECT id FROM supervisor_schools WHERE lower(supervisor_email)=? AND (instructor_email IS NULL OR lower(instructor_email)<>?)',email,s.email))denied();
  }
  const ops=[],storedEmail=old?.email||email,owner=s.portal_role==='instructor'?s.email:null;
  if(c.table==='admins'){
    const instructor=owner||(b.instructor_email||b.instructoremail||null);if(instructor)normalizeEmail(instructor);
    ops.push(stmt(db,'INSERT INTO admins(email,name,role,createdat,instructor_email,school,year) VALUES(?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role,instructor_email=excluded.instructor_email,school=excluded.school,year=excluded.year',storedEmail,name,role,new Date().toISOString(),instructor,schools[0]?.schoolname||null,schools[0]?.year||null));
  }else ops.push(stmt(db,`INSERT INTO ${c.table}(email,name,role,createdat) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role=excluded.role`,storedEmail,name,role,new Date().toISOString()));
  if(c.table==='supervisors'&&owner)ops.push(stmt(db,'DELETE FROM supervisor_schools WHERE lower(supervisor_email)=? AND lower(instructor_email)=?',email,owner));
  else ops.push(stmt(db,`DELETE FROM ${c.map} WHERE lower(${c.key})=?`,email));
  for(const v of schools)ops.push(c.table==='supervisors'?stmt(db,'INSERT INTO supervisor_schools(supervisor_email,schoolname,year,instructor_email) VALUES(?,?,?,?) ON CONFLICT(supervisor_email,schoolname,year) DO NOTHING',storedEmail,v.schoolname,v.year,owner):stmt(db,`INSERT OR IGNORE INTO ${c.map}(${c.key},schoolname,year) VALUES(?,?,?)`,storedEmail,v.schoolname,v.year));
  await db.batch(ops);return json({ok:true});
}
