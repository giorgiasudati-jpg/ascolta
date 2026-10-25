/* Enlist · service worker: tiene una copia dell'app sul telefono, così si apre anche senza rete.
   I dati non passano da qui: li gestisce store.js. Quando cambia l'app, alzare VERSION. */
const VERSION="ascolta-v6";
const CORE=["./","index.html","store.js","cerca.js","manifest.webmanifest","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png"];

self.addEventListener("install",e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});

function withTimeout(p,ms){return Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),ms))]);}

self.addEventListener("fetch",e=>{
  const req=e.request,url=new URL(req.url);
  if(req.method!=="GET"||url.hostname.endsWith("supabase.co"))return;
  /* l'app stessa: prima la rete (per avere sempre l'ultima versione), la copia se la rete manca o è lenta */
  if(url.origin===location.origin){
    e.respondWith(withTimeout(fetch(req),3000).then(res=>{const copy=res.clone();caches.open(VERSION).then(c=>c.put(req,copy));return res;})
      .catch(()=>caches.match(req,{ignoreSearch:true}).then(r=>r||caches.match("index.html"))));
    return;
  }
  /* librerie (con la versione nell'indirizzo) e font esterni: cambiano di rado, quindi basta la copia */
  e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(res=>{const copy=res.clone();caches.open(VERSION).then(c=>c.put(req,copy));return res;})));
});
