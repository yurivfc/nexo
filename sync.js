/*
 * Nexo — sincronização na nuvem (Firebase Firestore + login Google)
 * Como usar: coloque este arquivo ao lado do index.html e adicione, antes de </body>:
 *   <script type="module" src="sync.js" async></script>
 * Os dados continuam no aparelho (funciona offline). Quando há internet, tudo é
 * sincronizado com a sua conta: usuarios/{seu-uid}/itens/{tipo~id}
 */
const CONFIG = {
  apiKey: 'AIzaSyCxcyDNnfNbFtLvIoO4UD4igQqg6PTrwhc',
  authDomain: 'nexo-756ec.firebaseapp.com',
  projectId: 'nexo-756ec',
  storageBucket: 'nexo-756ec.firebasestorage.app',
  messagingSenderId: '736669881240',
  appId: '1:736669881240:web:59a164c47c1390ffda51ed'
};
const CDN = window.__NEXO_CDN || 'https://www.gstatic.com/firebasejs/10.12.2/';
const KEY = 'nexo3', KBASE = 'nexo3-sync-base', KUID = 'nexo3-sync-uid';
const COLS = ['contas', 'pessoas', 'lanc', 'recs', 'receb', 'pags', 'metas', 'ativos', 'regras', 'cats'];

// ============================================================ lógica pura (merge de 3 vias)
export const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + '.' + s.length.toString(36); };
const chave = (c, id) => c + '~' + String(id).replace(/\//g, '_');
export function paraMapa(S) {
  const m = {}, ord = {};
  if (!S) return { m, ord };
  COLS.forEach(c => (S[c] || []).forEach((it, i) => { if (!it || it.id == null) return; const k = chave(c, it.id); m[k] = JSON.stringify(it); ord[k] = i; }));
  m['meta~cfg'] = JSON.stringify({ v: S.v || 1, criado: S.criado || '', cfg: S.cfg || {} }); ord['meta~cfg'] = 0;
  return { m, ord };
}
export function deMapa(m, ord) {
  const S = { v: 1, criado: '', cfg: { conciliadoEm: '', backupEm: '' } };
  COLS.forEach(c => { S[c] = []; });
  Object.keys(m).sort((a, b) => (ord[a] || 0) - (ord[b] || 0)).forEach(k => {
    const c = k.split('~')[0], o = JSON.parse(m[k]);
    if (c === 'meta') { S.v = o.v || 1; S.criado = o.criado || ''; S.cfg = o.cfg || S.cfg; }
    else if (S[c]) S[c].push(o);
  });
  return S;
}
/* L = {m,ord} local · R = {k:{d,o,h}} nuvem · B = {k:hash} último estado comum · primeira = este aparelho nunca sincronizou */
export function reconciliar(L, R, B, primeira) {
  const out = {}, ord = {}, push = [], del = [], nb = {}; let mudou = false;
  const ks = new Set([...Object.keys(L.m), ...Object.keys(R), ...Object.keys(B)]);
  ks.forEach(k => {
    const l = L.m[k], hl = l !== undefined ? hash(l) : undefined, r = R[k], hr = r ? r.h : undefined, b = B[k];
    const usaL = () => { out[k] = l; ord[k] = L.ord[k] || 0; nb[k] = hl; if (hl !== hr) push.push(k); };
    const usaR = () => { out[k] = r.d; ord[k] = r.o || 0; nb[k] = hr; if (hr !== hl) mudou = true; };
    if (hl === hr) { if (l !== undefined) { out[k] = l; ord[k] = L.ord[k] || 0; nb[k] = hl; } return; }
    const lc = hl !== b, rc = hr !== b;
    if (lc && !rc) { if (l !== undefined) usaL(); else if (r) del.push(k); }          // só mudou aqui
    else if (!lc && rc) { if (r) usaR(); else if (l !== undefined) mudou = true; }     // só mudou na nuvem
    else if (primeira) { if (r) usaR(); else usaL(); }                                  // 1º login: nuvem prevalece, o resto é somado
    else if (l !== undefined) usaL(); else usaR();                                      // conflito: este aparelho prevalece (exclusão perde para edição)
  });
  const vistos = {};  // regras duplicadas (mesmo texto) viram uma só
  Object.keys(out).filter(k => k.startsWith('regras~')).sort((a, b) => ord[a] - ord[b]).forEach(k => {
    const p = JSON.parse(out[k]).padrao;
    if (!vistos[p]) { vistos[p] = 1; return; }
    delete out[k]; delete nb[k]; const i = push.indexOf(k); if (i >= 0) push.splice(i, 1);
    if (R[k]) del.push(k); if (L.m[k] !== undefined) mudou = true;
  });
  return { out, ord, push, del, nb, mudou };
}

// ============================================================ integração com o app
const EST = { user: null, servidorOk: false, pend: false, cache: true, n: 0, erro: '', ultimo: '' };
let fb = null, db = null, auth = null, col = null, unsub = null, remoto = null, timer = null;
const setOrig = Storage.prototype.setItem;
Storage.prototype.setItem = function (k, v) {
  setOrig.call(this, k, v);
  if (k === KEY && this === window.localStorage) { clearTimeout(timer); timer = setTimeout(() => remoto && executar(remoto), 700); }
};
const ocupado = () => !!document.querySelector('#sheet') || !!document.querySelector('#syncSheet') ||
  (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.activeElement.closest('#syncSheet'));

function executar(R) {
  const baseTxt = localStorage.getItem(KBASE), primeira = baseTxt === null;
  if (primeira && !EST.servidorOk) return;               // 1ª vez: espera a resposta do servidor
  if (ocupado()) { clearTimeout(timer); timer = setTimeout(() => remoto && executar(remoto), 1500); return; }
  let S = null; try { S = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { S = null; }
  const B = primeira ? {} : JSON.parse(baseTxt);
  const r = reconciliar(paraMapa(S), R, B, primeira);
  const ops = r.push.map(k => ['set', k]).concat(r.del.map(k => ['del', k]));
  for (let i = 0; i < ops.length; i += 400) {
    const bt = fb.writeBatch(db);
    ops.slice(i, i + 400).forEach(([t, k]) => {
      const ref = fb.doc(col, k);
      if (t === 'set') { bt.set(ref, { c: k.split('~')[0], d: r.out[k], o: r.ord[k] || 0, ts: fb.serverTimestamp() }); R[k] = { d: r.out[k], o: r.ord[k] || 0, h: r.nb[k] }; }
      else { bt.delete(ref); delete R[k]; }
    });
    bt.commit().catch(e => { EST.erro = e.message; pintar(); });
  }
  if (ops.length) EST.pend = true;
  setOrig.call(localStorage, KBASE, JSON.stringify(r.nb));
  if (r.mudou) {
    setOrig.call(localStorage, KEY, JSON.stringify(deMapa(r.out, r.ord)));
    const U = window.U || {};
    sessionStorage.setItem('nexo3-sync-volta', JSON.stringify({ tab: U.tab, pag: U.pag, mes: U.mes }));
    location.reload();
  }
  pintar();
}

async function iniciar() {
  pintar();
  try {
    const [a, au, fs] = await Promise.all([import(CDN + 'firebase-app.js'), import(CDN + 'firebase-auth.js'), import(CDN + 'firebase-firestore.js')]);
    fb = Object.assign({}, a, au, fs);
  } catch (e) { EST.erro = 'Sem internet: sincroniza quando voltar.'; pintar(); return; }
  const app = fb.initializeApp(CONFIG);
  try { db = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) }); }
  catch (e) { db = fb.getFirestore(app); }
  auth = fb.getAuth(app);
  fb.getRedirectResult(auth).catch(erroLogin);
  fb.onAuthStateChanged(auth, user => {
    if (unsub) { unsub(); unsub = null; }
    remoto = null; EST.user = user; EST.servidorOk = false; EST.erro = '';
    if (!user) { pintar(); return; }
    if (localStorage.getItem(KUID) !== user.uid) { localStorage.removeItem(KBASE); setOrig.call(localStorage, KUID, user.uid); }
    col = fb.collection(db, 'usuarios', user.uid, 'itens');
    unsub = fb.onSnapshot(col, { includeMetadataChanges: true }, snap => {
      const R = {};
      snap.forEach(d => { const x = d.data(); if (typeof x.d === 'string') R[d.id] = { d: x.d, o: x.o || 0, h: hash(x.d) }; });
      remoto = R; EST.n = snap.size; EST.pend = snap.metadata.hasPendingWrites; EST.cache = snap.metadata.fromCache;
      if (!snap.metadata.fromCache) { EST.servidorOk = true; if (!snap.metadata.hasPendingWrites) EST.ultimo = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
      executar(R);
    }, e => { EST.erro = /permission/i.test(e.code || e.message) ? 'Sem permissão: confira as Regras do Firestore.' : e.message; pintar(); });
    pintar();
  });
}

// ============================================================ interface (botão na barra do topo)
function pintar() {
  let b = document.getElementById('syncBtn');
  const top = document.querySelector('header.top');
  if (!b && top) {
    b = document.createElement('button'); b.id = 'syncBtn'; b.className = 'btn sec sm'; b.style.cssText = 'padding:0 9px;white-space:nowrap';
    b.onclick = abrir; top.insertBefore(b, document.getElementById('mesnav'));
  }
  if (!b) return;
  let t, cor = '';
  if (!fb && !EST.erro) t = '☁ …';
  else if (!EST.user) t = '☁ Entrar';
  else if (EST.erro) { t = '☁ !'; cor = 'var(--bad)'; }
  else if (!EST.servidorOk || EST.pend) t = '☁ ⟳';
  else { t = '☁ ✓'; cor = 'var(--ok)'; }
  b.textContent = t; b.style.color = cor;
  if (document.getElementById('syncSheet')) abrir();
}
function abrir() {
  let bg = document.getElementById('syncSheet');
  if (!bg) { bg = document.createElement('div'); bg.id = 'syncSheet'; bg.className = 'sheet-bg'; bg.addEventListener('mousedown', e => { if (e.target === bg) bg.remove(); }); document.body.appendChild(bg); }
  const u = EST.user;
  const st = !fb ? 'Carregando o módulo de nuvem…' : !u ? 'Não conectado. Seus dados estão só neste aparelho.' : EST.erro ? '⚠️ ' + EST.erro : !EST.servidorOk ? 'Sem conexão com o servidor. As alterações ficam guardadas e sobem quando a internet voltar.' : EST.pend ? 'Enviando alterações…' : '✅ Tudo sincronizado' + (EST.ultimo ? ' (' + EST.ultimo + ')' : '') + '.';
  bg.innerHTML = `<div class="sheet"><div class="grab"></div><h2>Nuvem<button class="btn ghost sm" id="sxX">✕</button></h2>
    <div class="alert ${u && !EST.erro && EST.servidorOk ? 'a-ok' : EST.erro ? 'a-bad' : 'a-info'}">${st}</div>
    ${u ? `<p class="mut" style="margin:12px 0">Conta: <b>${String(u.email || '').replace(/</g, '')}</b> · ${EST.n} itens na nuvem</p>
      <div class="btns"><button class="btn" id="sxSync">Sincronizar agora</button><button class="btn sec" id="sxSair">Sair</button></div>
      <p class="mut">Use a mesma conta Google no celular e no computador. As alterações aparecem no outro aparelho em segundos; a tela recarrega sozinha quando chega algo novo.</p>`
    : `<p class="mut" style="margin:12px 0">Entre com sua conta Google para usar o Nexo no celular e no computador. No primeiro login, o que já está neste aparelho é somado ao que está na nuvem: nada é apagado.</p>
      <button class="btn full" id="sxEntrar" ${fb ? '' : 'disabled'}>Entrar com Google</button>`}</div>`;
  bg.querySelector('#sxX').onclick = () => bg.remove();
  const q = s => bg.querySelector(s);
  if (q('#sxEntrar')) q('#sxEntrar').onclick = entrar;
  if (q('#sxSair')) q('#sxSair').onclick = async () => { if (!confirm('Sair da nuvem? Os dados continuam neste aparelho, mas param de sincronizar.')) return; localStorage.removeItem(KBASE); localStorage.removeItem(KUID); await fb.signOut(auth); };
  if (q('#sxSync')) q('#sxSync').onclick = async () => {
    try { const snap = await fb.getDocsFromServer(col); const R = {}; snap.forEach(d => { const x = d.data(); if (typeof x.d === 'string') R[d.id] = { d: x.d, o: x.o || 0, h: hash(x.d) }; }); EST.servidorOk = true; remoto = R; bg.remove(); executar(R); toastS('Sincronizado ✓'); }
    catch (e) { toastS('⚠️ Sem conexão com o servidor'); }
  };
}
async function entrar() {
  const p = new fb.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  try { await fb.signInWithPopup(auth, p); const s = document.getElementById('syncSheet'); if (s) s.remove(); toastS('Conectado! Sincronizando…'); }
  catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') { try { await fb.signInWithRedirect(auth, p); } catch (e2) { erroLogin(e2); } }
    else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') erroLogin(e);
  }
}
function erroLogin(e) {
  if (!e) return;
  EST.erro = e.code === 'auth/unauthorized-domain' ? 'Domínio não autorizado: no Firebase, vá em Authentication › Configurações › Domínios autorizados e adicione ' + location.hostname
    : e.code === 'auth/operation-not-allowed' ? 'Ative o login com Google em Authentication › Método de login.' : (e.message || String(e));
  pintar(); toastS('⚠️ ' + EST.erro);
}
function toastS(t) { if (window.toast) return window.toast(t); const el = document.createElement('div'); el.className = 'toast'; el.textContent = t; document.body.appendChild(el); setTimeout(() => el.remove(), 3000); }

function voltarTela() {
  const v = sessionStorage.getItem('nexo3-sync-volta'); if (!v) return;
  sessionStorage.removeItem('nexo3-sync-volta');
  try { const o = JSON.parse(v); if (window.U && window.render) { Object.assign(window.U, { tab: o.tab || 'inicio', pag: o.pag || '', mes: o.mes || window.U.mes }); window.render(); } } catch (e) { }
  toastS('Atualizado com o outro aparelho ☁');
}
if (!window.__NEXO_TESTE) {
  const go = () => { voltarTela(); iniciar(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else setTimeout(go, 0);
}
