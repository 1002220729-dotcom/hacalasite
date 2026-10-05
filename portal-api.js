/* Shared by the portal and report tabs. Session tokens stay in per-tab storage. */
(() => {
  const base='https://hacala-api.1002220729.workers.dev', key='portalRoleSession';
  const get=()=>{try{return JSON.parse(sessionStorage.getItem(key));}catch{return null;}};
  const set=s=>sessionStorage.setItem(key,JSON.stringify(s));
  const clear=()=>{sessionStorage.removeItem(key);sessionStorage.removeItem('smAdminUnlocked');sessionStorage.removeItem('smInstructorSession');};
  let channel;
  try {
    channel=new BroadcastChannel('hacala-auth-v1');
    channel.addEventListener('message',e=>{
      const s=get();
      if(e.data?.type==='request'&&s?.token&&s.expiresAt>Date.now())channel.postMessage({type:'response',id:e.data.id,session:s});
      if(e.data?.type==='logout'){clear();window.dispatchEvent(new Event('portal-auth-expired'));}
    });
  } catch {}
  async function tabSession(){
    if(get()?.token)return get();
    if(!channel)return null;
    return new Promise(resolve=>{
      const id=crypto.randomUUID();
      const done=s=>{clearTimeout(timer);channel.removeEventListener('message',listener);if(s)set(s);resolve(s);};
      const listener=e=>{if(e.data?.type==='response'&&e.data.id===id&&e.data.session?.token)done(e.data.session);};
      const timer=setTimeout(()=>done(null),700);channel.addEventListener('message',listener);channel.postMessage({type:'request',id});
    });
  }
  async function request(input,options={}){
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    // Never attach a session token to an external service.
    if(url.origin!==base)return fetch(input,options);
    const headers=new Headers(options.headers);
    const s=await tabSession();if(s?.token)headers.set('Authorization','Bearer '+s.token);
    const res=await fetch(input,{...options,headers,cache:'no-store'});
    if(res.status===401&&s?.token){clear();window.dispatchEvent(new Event('portal-auth-expired'));}
    if(!res.ok && options.method && options.method !== 'GET') {
      const error=await res.clone().json().catch(()=>({}));
      throw new Error(error.error || 'הפעולה לא הושלמה');
    }
    return res;
  }
  async function restore(){
    const saved=await tabSession();if(!saved?.token||saved.expiresAt<=Date.now()){clear();return null;}
    try{const res=await request(base+'/api/auth/session');if(!res.ok){clear();return null;}const verified=await res.json();const session={...verified,token:saved.token,picture:saved.picture||''};set(session);return session;}catch{return null;}
  }
  async function logout(){try{await request(base+'/api/auth/logout',{method:'POST'});}finally{clear();channel?.postMessage({type:'logout'});}}
  window.PortalAPI={base,get,set,clear,restore,logout,tabSession};
  window.portalFetch=request;
})();
