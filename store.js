/* Ascolta · il ponte tra l'app e Supabase.
   Offre all'app la stessa interfaccia del database di claude.ai (collection/doc/onSnapshot), così la logica non cambia.
   Ogni modifica si applica subito alla copia locale e parte verso Supabase appena c'è rete:
   l'app si apre e salva anche offline, e invia tutto quando torna la connessione. */
const Store=(()=>{
  const SB_URL="https://jwbzadaxregnukdevcrm.supabase.co";
  const SB_KEY="sb_publishable_UGraDoUu9WgRlj4arJhjWg_dalxkVvU";
  const COLS=["dischi","ascolti"];
  const K_CACHE="ascolta-cache-v1", K_OUT="ascolta-outbox-v1";
  const sb=supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});

  const load=k=>{try{return JSON.parse(localStorage.getItem(k)||"null");}catch(e){return null;}};
  const save=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}};
  let cache=load(K_CACHE)||{dischi:{},ascolti:{}};
  let outbox=load(K_OUT)||[];
  let lastError=null;
  /* al primo accesso su un dispositivo la copia locale è vuota: si mostra solo dopo il primo scaricamento */
  let pulled=!!load("ascolta-pulled");
  const subs={dischi:[],ascolti:[]}, statusSubs=[];

  function snap(col){return {docs:Object.entries(cache[col]).map(([id,data])=>({id,data:()=>data}))};}
  function emit(col){const s=snap(col);subs[col].forEach(cb=>cb(s));}
  function status(){const st={pending:outbox.length,online:navigator.onLine,error:lastError};statusSubs.forEach(cb=>cb(st));}
  function persist(){save(K_CACHE,cache);save(K_OUT,outbox);status();}

  /* un'operazione per documento: l'ultima vince, perché porta sempre il documento intero */
  function queue(op){outbox=outbox.filter(o=>!(o.col===op.col&&o.id===op.id));outbox.push(op);persist();flush();}

  let flushing=null;
  function flush(){
    if(flushing)return flushing;
    flushing=(async()=>{
      if(!outbox.length||!navigator.onLine)return;
      const {data:{session}}=await sb.auth.getSession();if(!session)return;
      try{
        while(outbox.length){
          const o=outbox[0];
          const r=o.op==="set"
            ?await sb.from(o.col).upsert({id:o.id,data:o.data,updated_at:new Date().toISOString()})
            :await sb.from(o.col).delete().eq("id",o.id);
          if(r.error)throw r.error;
          outbox.shift();lastError=null;persist();
        }
      }catch(e){lastError=e.message||String(e);console.warn("Ascolta: invio rimandato",e);status();}
    })().finally(()=>{flushing=null;});
    return flushing;
  }

  async function pull(){
    if(!navigator.onLine)return;
    await flush();
    const fresh={};
    for(const col of COLS){
      const r=await sb.from(col).select("id,data").limit(10000);
      if(r.error){lastError=r.error.message;status();return;}
      fresh[col]=Object.fromEntries(r.data.map(x=>[x.id,x.data]));
    }
    /* quello che non è ancora partito resta valido sopra i dati del server */
    for(const o of outbox){if(o.op==="set")fresh[o.col][o.id]=o.data;else delete fresh[o.col][o.id];}
    cache=fresh;lastError=null;pulled=true;save("ascolta-pulled",true);persist();COLS.forEach(emit);
  }

  function collection(col){
    const api={
      limit(){return api;},
      onSnapshot(cb){subs[col].push(cb);if(pulled)cb(snap(col));return()=>{subs[col]=subs[col].filter(x=>x!==cb);};},
      async add(data){const id=crypto.randomUUID();cache[col][id]=data;emit(col);queue({op:"set",col,id,data});return {id};}
    };
    return api;
  }
  function doc(path){
    const [col,id]=path.split("/");
    return {
      async update(patch){const cur=cache[col][id];if(!cur)throw new Error("not_found");const data={...cur,...patch};cache[col][id]=data;emit(col);queue({op:"set",col,id,data});},
      async delete(){delete cache[col][id];emit(col);queue({op:"del",col,id});}
    };
  }

  /* accesso con email e password: l'utente si crea dal pannello di Supabase, nessuna email da inviare */
  async function session(){const {data:{session}}=await sb.auth.getSession();return session;}
  async function signIn(email,password){const {error}=await sb.auth.signInWithPassword({email,password});if(error)throw error;}
  async function signOut(){await sb.auth.signOut();cache={dischi:{},ascolti:{}};outbox=[];pulled=false;save("ascolta-pulled",false);persist();}

  let started=false;
  function start(){
    if(started)return;started=true;
    pull();
    window.addEventListener("online",()=>{status();pull();});
    window.addEventListener("offline",status);
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")pull();});
    setInterval(()=>{if(document.visibilityState==="visible")pull();},5*60*1000);
  }

  return {collection,doc,session,signIn,signOut,start,pull,onStatus:cb=>{statusSubs.push(cb);status();}};
})();
