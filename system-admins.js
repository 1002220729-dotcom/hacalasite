(() => {
  let dialog;
  const el=(tag,value)=>{const e=document.createElement(tag);if(value)e.textContent=value;return e;};
  const api=async(path,options)=>{const res=await portalFetch(PortalAPI.base+path,options),data=await res.json();if(!res.ok)throw new Error(data.error||'הפעולה לא הושלמה');return data;};
  window.openSystemAdmins=async()=>{
    if(PortalAPI.get()?.portalRole!=='admin')return;
    if(!dialog){
      dialog=el('dialog');dialog.dir='rtl';dialog.className='system-admin-dialog';dialog.style.cssText='margin:auto;border:0;border-radius:16px;padding:26px;max-width:650px;width:90%;max-height:85vh;overflow:auto;font-family:Heebo,sans-serif';
      const style=el('style');style.textContent='.system-admin-dialog::backdrop{background:rgba(0,0,0,.45)}.system-admin-dialog button{padding:8px 14px;border:1px solid #d4dce5;border-radius:8px;cursor:pointer;font:inherit;background:#f7f9fc;color:#2c3e50}.system-admin-dialog button:disabled{opacity:.5;cursor:default}.system-admin-dialog button[type=submit]{background:#246c9d;color:white}.system-admin-dialog h2{margin-bottom:12px}.system-admin-dialog input{max-width:100%;box-sizing:border-box}';document.head.append(style);
      const title=el('h2','מנהלי מערכת');dialog.append(title,el('p','להעברת הניהול: הוסף את חשבון Google של המנהל החדש, ודא שנכנס בהצלחה, ואז הסר את הרשאתך אם תרצה.'));
      const form=el('form');form.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin:20px 0';
      const name=el('input'),email=el('input');name.placeholder='שם מלא';name.required=true;name.maxLength=160;email.placeholder='כתובת חשבון Google';email.type='email';email.required=true;email.dir='ltr';
      for(const input of [name,email])input.style.cssText='padding:10px;border:1px solid #ccc;border-radius:8px';
      const save=el('button','הוספת מנהל');save.type='submit';form.append(name,email,save);
      const status=el('p');status.setAttribute('role','status');const list=el('div');list.id='systemAdminList';
      form.onsubmit=async e=>{e.preventDefault();save.disabled=true;status.textContent='';try{await api('/api/system-admins',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.value,email:email.value})});form.reset();status.textContent='ההרשאה נוספה. המנהל החדש יכול להיכנס דרך Google.';await load();}catch(e){status.textContent=e.message;}finally{save.disabled=false;}};
      const close=el('button','סגירה');close.type='button';close.onclick=()=>dialog.close();dialog.append(form,status,list,close);document.body.append(dialog);
      async function load(){
        list.replaceChildren();const members=await api('/api/system-admins');
        const confirmed=members.filter(m=>m.confirmed_at).length;
        for(const m of members){
          const row=el('div');row.style.cssText='border:1px solid #ddd;border-radius:10px;margin:10px 0;padding:12px';
          row.append(el('strong',m.name),el('div',m.email),el('div',m.confirmed_at?'נכנס בהצלחה דרך Google':'ממתין לכניסה ראשונה'));
          const remove=el('button',m.email===PortalAPI.get()?.email?'הסרת ההרשאה שלי':'הסרת הרשאה');remove.type='button';
          remove.disabled=members.length===1||!!m.confirmed_at&&confirmed<=1;
          if(remove.disabled)remove.title='נדרש מנהל נוסף שכבר נכנס בהצלחה';
          remove.onclick=async()=>{if(!confirm('להסיר את הרשאת מנהל המערכת של '+m.email+'?'))return;remove.disabled=true;try{await api('/api/system-admins?email='+encodeURIComponent(m.email),{method:'DELETE'});if(m.email===PortalAPI.get()?.email){await PortalAPI.logout();location.reload();return;}await load();}catch(e){status.textContent=e.message;remove.disabled=false;}};
          row.append(remove);list.append(row);
        }
      }
      dialog.load=load;
    }
    dialog.showModal();try{await dialog.load();}catch(e){dialog.querySelector('#systemAdminList').textContent=e.message;}
  };
})();
