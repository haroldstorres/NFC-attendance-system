// Lets the Tap-In app open with no internet. Pages: network first, then the saved copy.
// Firebase scripts and fonts (versioned files that never change): saved copy first.
const CACHE='tapin-app-v2';
const SHELL=['./','./index.html','./display.html','./manifest.json','./tapin-icon-192.png','./tapin-icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))));self.clients.claim()});
const LIBS=/^https:\/\/(www\.gstatic\.com\/firebasejs\/|fonts\.(googleapis|gstatic)\.com\/)/;
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(LIBS.test(r.url)){
    e.respondWith(caches.match(r).then(hit=>hit||fetch(r).then(res=>{if(res.ok){const c=res.clone();caches.open(CACHE).then(x=>x.put(r,c))}return res})));return}
  if(u.origin!==location.origin||u.pathname.indexOf('/parent/')!==-1)return; // the parent app has its own worker
  e.respondWith(fetch(r).then(res=>{if(res.ok){const c=res.clone();caches.open(CACHE).then(x=>x.put(r,c))}return res}).catch(()=>caches.match(r,{ignoreSearch:true}).then(h=>h||(r.mode==='navigate'?caches.match('./index.html'):undefined))));
});

// Phone notifications for advisers (new absence note from a parent).
self.addEventListener('push',e=>{
  let j={};try{j=e.data?e.data.json():{}}catch(_){}
  const d=j.data||j.notification||j;
  e.waitUntil(self.registration.showNotification(d.title||'Tap-In',{body:d.body||'',icon:'tapin-icon-192.png',badge:'tapin-icon-192.png',tag:d.tag||undefined}));
});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c)return c.focus()}return clients.openWindow('./')}))});
