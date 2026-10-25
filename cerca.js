/* Enlist · cercare un disco e capire dove si lega alla rete.
   Apple Music (iTunes Search API) dà copertina, anno, numero di brani e link.
   MusicBrainz dà i crediti: chi ha scritto, prodotto, suonato, chi compare come ospite.
   I legami con gli altri dischi si calcolano confrontando i nomi dei crediti. Tutto gratuito, senza chiavi. */

const norm=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/\(.*?\)|\[.*?\]/g," ").replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").trim();
/* i tipi di credito di MusicBrainz, raccolti in poche famiglie, e quanto pesano in un legame */
const ROLE={producer:"produzione","co-producer":"produzione",programming:"produzione",writer:"scrittura",composer:"scrittura",lyricist:"scrittura",arranger:"arrangiamento",orchestrator:"arrangiamento",mix:"mix",vocal:"musicisti",instrument:"musicisti",performer:"musicisti",engineer:"tecnica",recording:"tecnica",mastering:"tecnica"};
const WEIGHT={produzione:3,scrittura:2,feat:2,arrangiamento:2,musicisti:1.5,mix:1,tecnica:.5};

/* ---------- Apple Music ---------- */
/* Apple concede circa 20 richieste al minuto: in sottofondo si va piano, mentre cerchi tu si risponde subito */
let appleLast=0;
async function apple(path,params,slow){
  if(slow){const wait=Math.max(0,appleLast+3100-Date.now());if(wait)await new Promise(r=>setTimeout(r,wait));}
  appleLast=Date.now();
  const r=await fetch("https://itunes.apple.com/"+path+"?"+new URLSearchParams(Object.assign({country:"it"},params)));
  if(!r.ok)throw new Error("apple "+r.status);
  return (await r.json()).results||[];
}
function toAlbum(a){
  const raw=a.collectionName||"";
  return {title:raw.replace(/ - (Single|EP)$/,""),artist:a.artistName||"",year:(a.releaseDate||"").slice(0,4),
    meta:{itunesId:a.collectionId,cover:(a.artworkUrl100||"").replace("100x100bb","300x300bb"),url:a.collectionViewUrl||"",tracks:a.trackCount||0,genre:a.primaryGenreName||"",kind:/ - Single$/.test(raw)?"singolo":/ - EP$/.test(raw)?"EP":"album"}};
}
/* tutti gli album di un artista: la ricerca libera di Apple spesso non trova gli album famosi, l'elenco dell'artista sì */
async function artistAlbums(name,slow){
  const arts=await apple("search",{entity:"musicArtist",term:name,limit:3},slow);
  const a=arts.find(x=>norm(x.artistName)===norm(name))||arts[0];
  if(!a)return [];
  const res=await apple("lookup",{id:a.artistId,entity:"album",limit:200},slow);
  return res.filter(x=>x.wrapperType==="collection").map(toAlbum);
}
async function searchApple(q){
  const nq=norm(q),words=nq.split(" ");
  const [byTerm,arts]=await Promise.all([apple("search",{entity:"album",term:q,limit:25}),apple("search",{entity:"musicArtist",term:q,limit:5})]);
  /* se nella ricerca c'è il nome di un artista, guardo anche il suo elenco di album */
  const art=arts.find(x=>nq.includes(norm(x.artistName)))||arts.find(x=>norm(x.artistName).startsWith(nq));
  let byArtist=[];
  if(art){
    const rest=nq.replace(norm(art.artistName),"").trim();
    const all=(await apple("lookup",{id:art.artistId,entity:"album",limit:200})).filter(x=>x.wrapperType==="collection").map(toAlbum);
    byArtist=rest?all.filter(a=>rest.split(" ").every(w=>norm(a.title).includes(w))):all;
  }
  const seen=new Set(),out=[];
  const rank=a=>(a.meta.kind==="album"?0:a.meta.kind==="EP"?1:2);
  const termHits=byTerm.map(toAlbum).filter(a=>words.every(w=>norm(a.title+" "+a.artist).includes(w)));
  for(const a of [...byArtist.sort((x,y)=>rank(x)-rank(y)||(y.year||"").localeCompare(x.year||"")),...termHits.sort((x,y)=>rank(x)-rank(y))]){
    if(seen.has(a.meta.itunesId))continue;seen.add(a.meta.itunesId);out.push(a);
  }
  return out.slice(0,10);
}
/* per i dischi già presenti: cerco nell'elenco dell'artista lo stesso titolo */
async function matchApple(d){
  const t=norm(d.title);
  const first=String(d.artist).split(/\s+(?:&|and|e|feat\.?|x)\s+|,\s*/i)[0];
  let hit=(await artistAlbums(first,true)).find(a=>norm(a.title)===t);
  if(!hit){
    const res=(await apple("search",{entity:"album",term:d.artist+" "+d.title,limit:25},true)).map(toAlbum);
    hit=res.find(a=>norm(a.title)===t&&(norm(a.artist).includes(norm(first))||norm(first).includes(norm(a.artist))));
  }
  return hit?hit.meta:{none:true,at:Date.now()};
}

/* ---------- MusicBrainz ---------- */
let mbLast=0;
async function mb(path,tries=3){
  /* MusicBrainz chiede al massimo una richiesta al secondo; se risponde "troppe richieste" aspetto e riprovo */
  const wait=Math.max(0,mbLast+1400-Date.now());if(wait)await new Promise(r=>setTimeout(r,wait));
  mbLast=Date.now();
  const r=await fetch("https://musicbrainz.org/ws/2/"+path+(path.includes("?")?"&":"?")+"fmt=json");
  if(r.status===503&&tries>1){await new Promise(res=>setTimeout(res,4000));return mb(path,tries-1);}
  if(!r.ok)throw new Error("musicbrainz "+r.status);
  return r.json();
}
async function fetchCredits(title,artist){
  const q='release:"'+title.replace(/"/g,"")+'" AND artist:"'+artist.replace(/"/g,"")+'"';
  const s=await mb("release/?limit=10&query="+encodeURIComponent(q));
  const cands=(s.releases||[]).filter(r=>r.score>=80&&norm(r.title)===norm(title));
  const pick=cands.find(r=>r.status==="Official")||cands[0];
  if(!pick)return {none:true,at:Date.now()};
  const rel=await mb("release/"+pick.id+"?inc=artist-credits+recordings+artist-rels+recording-level-rels+work-rels+work-level-rels+recording-rels");
  const main=new Set((rel["artist-credit"]||[]).map(c=>norm(c.name||(c.artist&&c.artist.name))));
  const map=new Map();
  const add=(name,role,trk)=>{const k=norm(name);if(!k||main.has(k))return;let e=map.get(k);if(!e){e={n:name,r:new Set(),t:new Set()};map.set(k,e);}e.r.add(role);if(trk)e.t.add(trk);};
  for(const r of rel.relations||[]){const role=ROLE[r.type];if(role&&r.artist)add(r.artist.name,role,0);}
  let n=0;
  for(const m of rel.media||[])for(const t of m.tracks||[]){
    n++;const rec=t.recording||{};
    for(const c of rec["artist-credit"]||[])add(c.name||(c.artist&&c.artist.name),"feat",n);
    for(const r of rec.relations||[]){
      const role=ROLE[r.type];if(role&&r.artist)add(r.artist.name,role,n);
      if(r.work)for(const w of r.work.relations||[]){const wr=ROLE[w.type];if(wr&&w.artist)add(w.artist.name,wr,n);}
    }
  }
  const weight=e=>Math.max(...e.r.map(x=>WEIGHT[x]||1));
  const list=[...map.values()].map(e=>({n:e.n,r:[...e.r],k:e.t.size}))/* prima chi ha prodotto e scritto, poi chi ha suonato, in fondo i tecnici; a parità, chi è in più brani */
  .sort((a,b)=>weight(b)*(1+b.k)-weight(a)*(1+a.k)).slice(0,40);
  return {mb:pick.id,tracks:n,list,at:Date.now()};
}

/* ---------- i legami tra due dischi ---------- */
function linkOf(a,b){
  const out={score:0,same:false,cross:[],shared:[]};
  const na=norm(a.artist),nb=norm(b.artist);
  if(na&&na===nb){out.same=true;out.score+=4;}
  const ca=new Map(((a.credits&&a.credits.list)||[]).map(e=>[norm(e.n),e]));
  const cb=new Map(((b.credits&&b.credits.list)||[]).map(e=>[norm(e.n),e]));
  if(!out.same){
    if(cb.has(na)){out.cross.push(a.artist+" compare nei crediti di "+b.title);out.score+=3;}
    if(ca.has(nb)){out.cross.push(b.artist+" compare nei crediti di "+a.title);out.score+=3;}
  }
  for(const [k,e] of ca){
    const f=cb.get(k);if(!f)continue;
    const roles=[...new Set([...e.r,...f.r])];
    out.shared.push({n:e.n,r:roles});
    out.score+=Math.max(...roles.map(r=>WEIGHT[r]||1));
  }
  out.shared.sort((x,y)=>Math.max(...y.r.map(r=>WEIGHT[r]||1))-Math.max(...x.r.map(r=>WEIGHT[r]||1)));
  return out;
}
function linkText(l){
  const parts=[];
  if(l.same)parts.push("stesso artista");
  parts.push(...l.cross);
  if(l.shared.length)parts.push("in comune: "+l.shared.slice(0,4).map(s=>s.n+" ("+s.r.join(", ")+")").join(", ")+(l.shared.length>4?" e altri "+(l.shared.length-4):""));
  return parts.join(" · ");
}
/* i dischi più legati a d, tra quelli indicati */
function linksFor(d,pool){
  return pool.filter(x=>x.id!==d.id).map(x=>({d:x,l:linkOf(d,x)})).filter(x=>x.l.score>0).sort((a,b)=>b.l.score-a.l.score);
}

/* ---------- copertina, crediti e legami nella scheda di un disco ---------- */
function coverImg(d,cls){
  const c=d&&d.meta&&d.meta.cover;
  return c?'<img class="cover '+(cls||"")+'" src="'+esc(c)+'" alt="" loading="lazy" decoding="async">':'';
}
function creditsBlock(d){
  const open=ui.openCred.has(d.id),cr=d.credits,links=linksFor(d,[...discs.values()].filter(x=>x.credits||x.artist)).slice(0,3);
  let h='';
  if(links.length)h+='<ul class="links">'+links.map(x=>'<li><b>↔ '+esc(x.d.title)+'</b> <span>'+esc(linkText(x.l))+'</span></li>').join("")+'</ul>';
  const n=cr&&cr.list?cr.list.length:0;
  const btns=(n?'<button class="linkbtn" data-act="cred" data-id="'+esc(d.id)+'" aria-expanded="'+open+'">'+(open?'Chiudi i crediti':'Crediti ('+n+')')+'</button>':'')+
    (d.meta&&d.meta.url?'<a class="linkbtn" href="'+esc(d.meta.url)+'" target="_blank" rel="noopener">Apri in Musica</a>':'');
  if(btns)h+='<div class="actions">'+btns+'</div>';
  if(open&&n)h+='<ul class="credits">'+cr.list.slice(0,16).map(e=>'<li><b>'+esc(e.n)+'</b><span>'+esc(e.r.join(", "))+(e.k?' · '+e.k+(e.k===1?' brano':' brani'):'')+'</span></li>').join("")+'</ul><p class="src">Crediti da MusicBrainz, un archivio aperto: a volte sono incompleti.</p>';
  return h;
}

/* ---------- la ricerca, dentro un modulo ---------- */
function attachSearch(input,results,onPick){
  let t=null,seq=0;
  input.addEventListener("input",()=>{
    clearTimeout(t);const q=input.value.trim();
    if(q.length<3){results.innerHTML="";return;}
    t=setTimeout(async()=>{
      const my=++seq;results.innerHTML='<p class="src">Cerco su Apple Music…</p>';
      try{
        const res=await searchApple(q);if(my!==seq)return;
        if(!res.length){results.innerHTML='<p class="src">Nessun risultato. Prova con titolo e artista, oppure compila tu i campi qui sotto.</p>';return;}
        results.innerHTML=res.map((a,i)=>'<button type="button" class="res" data-i="'+i+'">'+(a.meta.cover?'<img src="'+esc(a.meta.cover)+'" alt="" loading="lazy">':'<span class="ph-cover"></span>')+'<span><b>'+esc(a.title)+'</b><small>'+esc(a.artist)+(a.year?' · '+esc(a.year):'')+(a.meta.kind!=="album"?' · '+a.meta.kind:'')+'</small></span></button>').join("");
        results.querySelectorAll(".res").forEach(b=>b.addEventListener("click",()=>{results.innerHTML="";input.value="";onPick(res[Number(b.dataset.i)]);}));
      }catch(e){if(my===seq)results.innerHTML='<p class="src">Non riesco a raggiungere Apple Music. Controlla la connessione, oppure compila tu i campi qui sotto.</p>';}
    },650);
  });
}

/* modulo "Aggiungi un disco": scelto il disco, legge i crediti e propone dove collegarlo */
let addPick=null;
function setupAddSearch(){
  const q=document.getElementById("af-q");if(!q||q.dataset.ready)return;q.dataset.ready="1";
  attachSearch(q,document.getElementById("af-results"),async a=>{
    addPick={meta:a.meta,credits:null};
    $("#af-title").value=a.title;$("#af-artist").value=a.artist;$("#af-year").value=a.year;
    const box=document.getElementById("af-picked");
    const head='<div class="picked">'+(a.meta.cover?'<img class="cover" src="'+esc(a.meta.cover)+'" alt="">':'')+'<div><b>'+esc(a.title)+'</b><small>'+esc(a.artist)+(a.year?' · '+esc(a.year):'')+(a.meta.tracks?' · '+a.meta.tracks+' brani':'')+'</small></div></div>';
    box.innerHTML=head+'<p class="src">Leggo i crediti su MusicBrainz…</p>';
    const pick=addPick;
    try{pick.credits=await fetchCredits(a.title,a.artist);}catch(e){pick.credits=null;}
    if(addPick!==pick)return;
    const probe={id:"__new",title:a.title,artist:a.artist,credits:pick.credits};
    const studio=[...discs.values()].filter(isActive);
    const sug=linksFor(probe,studio).slice(0,3);
    const other=linksFor(probe,[...discs.values()].filter(x=>!isActive(x))).slice(0,2);
    const found=pick.credits&&pick.credits.list?pick.credits.list.length:0;
    let h=head+'<p class="src">'+(found?found+' nomi nei crediti.':'Su MusicBrainz non ho trovato i crediti di questo disco: posso solo confrontare gli artisti.')+'</p>';
    if(sug.length){
      h+='<fieldset class="linkpick"><legend>Collegalo alla rete di</legend>'+sug.map((x,i)=>'<label><input type="radio" name="af-link" value="'+esc(x.d.id)+'"'+(i===0?' checked':'')+'><span><b>'+esc(x.d.title)+'</b><small>'+esc(linkText(x.l))+'</small></span></label>').join("")+
        '<label><input type="radio" name="af-link" value=""><span><b>Nessun collegamento</b><small>Entra in coda da solo</small></span></label></fieldset>';
      $("#af-parent").value=sug[0].d.id;
    } else {
      h+='<p class="src">Non vedo legami con i dischi che stai studiando. Se ne conosci uno, sceglilo qui sotto in "Arriva dalla rete di".</p>';
    }
    if(other.length)h+='<p class="src">Legato anche a: '+other.map(x=>esc(x.d.title)).join(", ")+'.</p>';
    box.innerHTML=h;
    box.querySelectorAll('input[name="af-link"]').forEach(r=>r.addEventListener("change",()=>{$("#af-parent").value=r.value;}));
  });
}

/* "Un disco nuovo" dentro Segna un ascolto: basta copertina e dati, i crediti arrivano dopo */
let logPick=null;
function setupLogSearch(){
  const q=document.getElementById("lf-n-q");if(!q||q.dataset.ready)return;q.dataset.ready="1";
  attachSearch(q,document.getElementById("lf-n-results"),a=>{
    logPick={meta:a.meta};
    $("#lf-n-title").value=a.title;$("#lf-n-artist").value=a.artist;$("#lf-n-year").value=a.year;
  });
}

/* ---------- arricchire i dischi già presenti, uno alla volta, in sottofondo ---------- */
let enriching=false;
const RETRY=30*864e5;
function needs(d){
  const m=!d.meta||(d.meta.none&&Date.now()-d.meta.at>RETRY);
  const c=!d.credits||(d.credits.none&&Date.now()-d.credits.at>RETRY);
  return m||c;
}
async function enrichAll(){
  if(enriching||!db||!navigator.onLine)return;
  enriching=true;
  try{
    for(const d of [...discs.values()].filter(needs)){
      if(!navigator.onLine||document.visibilityState!=="visible")break;
      const patch={};
      if(!d.meta||(d.meta.none&&Date.now()-d.meta.at>RETRY))patch.meta=await matchApple(d);
      if(!d.credits||(d.credits.none&&Date.now()-d.credits.at>RETRY))patch.credits=await fetchCredits(d.title,d.artist);
      if(discs.has(d.id))await db.doc("dischi/"+d.id).update(patch);
    }
  }catch(e){console.warn("Enlist: arricchimento rimandato",e);}
  finally{enriching=false;}
}
