const CAMARA = 'https://dadosabertos.camara.leg.br/api/v2';
const SENADO = 'https://legis.senado.leg.br/dadosabertos';
const CACHE_KEY = 'politicosbr_cache_v1';
const state = { view: 'home', query: '', results: [], selected: null, detail: null };

const $ = s => document.querySelector(s);
const main = () => $('#main');

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  setTimeout(() => t.hidden = true, ms);
}

function swalBase(opts) {
  return Swal.fire({
    background: '#1e293b', color: '#f1f5f9',
    confirmButtonColor: '#f59e0b', ...opts
  });
}

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function searchCamara(nome) {
  try {
    const data = await fetchJSON(`${CAMARA}/deputados?nome=${encodeURIComponent(nome)}&itens=30&ordem=ASC&ordenarPor=nome`);
    return (data.dados || []).map(d => ({
      id: d.id, source: 'camara', nome: d.nome, nomeCivil: d.nomeCivil || d.nome,
      partido: d.siglaPartido, uf: d.siglaUf, foto: d.urlFoto,
      cargo: 'Deputado(a) Federal', status: d.email ? 'Em exercício' : 'Histórico'
    }));
  } catch (e) { console.warn('Camara', e); return []; }
}

async function searchSenado(nome) {
  try {
    const data = await fetchJSON(`${SENADO}/senador/lista/atual.json`);
    const list = data?.ListaParlamentarEmExercicio?.Parlamentares?.Parlamentar || [];
    const q = nome.toLowerCase();
    return list
      .filter(p => {
        const id = p.IdentificacaoParlamentar || {};
        return (id.NomeParlamentar || '').toLowerCase().includes(q) ||
               (id.NomeCompletoParlamentar || '').toLowerCase().includes(q);
      })
      .map(p => {
        const id = p.IdentificacaoParlamentar;
        return {
          id: id.CodigoParlamentar, source: 'senado',
          nome: id.NomeParlamentar, nomeCivil: id.NomeCompletoParlamentar,
          partido: id.SiglaPartidoParlamentar, uf: id.UfParlamentar,
          foto: id.UrlFotoParlamentar, cargo: 'Senador(a)', status: 'Em exercício'
        };
      });
  } catch (e) { console.warn('Senado', e); return []; }
}

async function doSearch(q) {
  if (!q || q.length < 2) {
    await swalBase({ title: 'Atenção', text: 'Digite pelo menos 2 caracteres.', icon: 'warning' });
    return;
  }
  state.query = q; state.view = 'results'; state.results = [];
  render();
  const [cam, sen] = await Promise.all([searchCamara(q), searchSenado(q)]);
  const seen = new Set();
  state.results = [...cam, ...sen].filter(r => {
    const k = (r.nome + r.source).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    c[q.toLowerCase()] = { t: Date.now(), results: state.results };
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {}
  render();
  if (state.results.length === 0) toast('Nenhum resultado');
  else toast(`${state.results.length} encontrado(s)`);
}

async function loadDetail(person) {
  state.selected = person; state.view = 'detail'; state.detail = null;
  render();
  try {
    if (person.source === 'camara') {
      const [dep, props] = await Promise.all([
        fetchJSON(`${CAMARA}/deputados/${person.id}`),
        fetchJSON(`${CAMARA}/proposicoes?idDeputadoAutor=${person.id}&itens=20&ordem=DESC&ordenarPor=id`)
      ]);
      const d = dep.dados || {};
      state.detail = {
        ...person,
        bio: d,
        mandatos: d.ultimoStatus ? '1+' : '—',
        proposicoes: (props.dados || []).map(p => ({
          id: p.id, sigla: p.siglaTipo, numero: p.numero, ano: p.ano, ementa: p.ementa
        })),
        votos: { sim: '—', nao: '—', abst: '—', total: '—' },
        processos: []
      };
    } else {
      const [det, mats] = await Promise.all([
        fetchJSON(`${SENADO}/senador/${person.id}.json`).catch(() => null),
        fetchJSON(`${SENADO}/senador/${person.id}/autorias.json`).catch(() => null)
      ]);
      const matsList = mats?.MateriasAutorias?.Materia || mats?.Autorias?.Autoria || [];
      const arr = Array.isArray(matsList) ? matsList : (matsList ? [matsList] : []);
      state.detail = {
        ...person,
        bio: det,
        mandatos: '1+',
        proposicoes: arr.slice(0, 20).map(m => ({
          id: m.Codigo || m.IdentificacaoMateria?.CodigoMateria,
          sigla: m.IdentificacaoMateria?.SiglaSubtipoMateria || m.Sigla || '',
          numero: m.IdentificacaoMateria?.NumeroMateria || m.Numero || '',
          ano: m.IdentificacaoMateria?.AnoMateria || m.Ano || '',
          ementa: m.EmentaMateria || m.Ementa || ''
        })),
        votos: { sim: '—', nao: '—', abst: '—', total: '—' },
        processos: []
      };
    }
  } catch (e) {
    console.error(e);
    await swalBase({ title: 'Erro', text: 'Falha ao carregar detalhes.', icon: 'error' });
    state.view = 'results';
  }
  render();
}

function renderHome() {
  main().innerHTML = `
    <div class="card">
      <div class="card-title">Pesquisar político</div>
      <div class="search-wrap">
        <input type="search" id="q" placeholder="Ex: Bolsonaro, Lula, Marina..." value="${state.query || ''}" autocomplete="off">
        <button class="btn btn-primary btn-sm" id="btn-search" style="width:auto;padding:0 18px">Buscar</button>
      </div>
    </div>
    <div class="note">Fontes oficiais: Dados Abertos da Câmara dos Deputados e Senado Federal. Votações nominais e processos judiciais são limitados nas APIs públicas.</div>
  `;
  $('#btn-search').onclick = () => doSearch($('#q').value.trim());
  $('#q').onkeydown = e => { if (e.key === 'Enter') doSearch(e.target.value.trim()); };
}

function renderResults() {
  const list = state.results;
  main().innerHTML = `
    <button class="btn btn-outline btn-sm back" id="btn-back">← Voltar</button>
    <div class="card-title">Resultados para “${state.query}” (${list.length})</div>
    ${list.length === 0 ? `<div class="empty">Nenhum resultado. Tente outro nome.</div>` : `
      <div class="list">
        ${list.map((r, i) => `
          <div class="item" data-i="${i}">
            <img src="${r.foto || ''}" alt="" onerror="this.style.display='none'">
            <div class="item-info">
              <div class="item-name">${r.nome}</div>
              <div class="item-meta">${r.cargo} · ${r.partido || '—'} / ${r.uf || '—'} · ${r.status}</div>
            </div>
            <span class="badge">${r.source === 'camara' ? 'CD' : 'SF'}</span>
          </div>
        `).join('')}
      </div>
    `}
  `;
  $('#btn-back').onclick = () => { state.view = 'home'; render(); };
  document.querySelectorAll('.item').forEach(el => {
    el.onclick = () => loadDetail(state.results[+el.dataset.i]);
  });
}

function renderDetail() {
  const p = state.selected;
  const d = state.detail;
  if (!d) {
    main().innerHTML = `<div class="loading"><div class="spinner"></div>Carregando...</div>`;
    return;
  }
  main().innerHTML = `
    <button class="btn btn-outline btn-sm back" id="btn-back">← Resultados</button>
    <div class="card" style="text-align:center">
      <img src="${p.foto || ''}" style="width:96px;height:96px;border-radius:50%;object-fit:cover;margin-bottom:12px;background:var(--elev)" onerror="this.style.display='none'">
      <h2>${p.nome}</h2>
      <div class="item-meta">${p.nomeCivil || ''} · ${p.partido || '—'} / ${p.uf || '—'}</div>
      <div style="margin-top:8px"><span class="badge">${p.cargo}</span></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-val">${d.mandatos}</div><div class="stat-label">Mandatos</div></div>
      <div class="stat"><div class="stat-val">${d.proposicoes.length}</div><div class="stat-label">Projetos (amostra)</div></div>
      <div class="stat"><div class="stat-val">${d.votos.sim}</div><div class="stat-label">Votos Sim*</div></div>
      <div class="stat"><div class="stat-val">${d.votos.abst}</div><div class="stat-label">Abstenções*</div></div>
    </div>
    <div class="note">* Votações nominais exigem agregação de centenas de endpoints; resumo completo não disponível em tempo real via API pública.</div>
    <div class="card section">
      <div class="card-title">Projetos / Matérias recentes</div>
      ${d.proposicoes.length === 0 ? '<div class="empty" style="padding:16px">Nenhum encontrado</div>' : `
        <ul class="simple">
          ${d.proposicoes.map(pr => `
            <li><strong>${pr.sigla || ''} ${pr.numero || ''}/${pr.ano || ''}</strong><br>
            <span style="color:var(--muted);font-size:.85rem">${(pr.ementa || '').slice(0, 140)}${(pr.ementa || '').length > 140 ? '…' : ''}</span></li>
          `).join('')}
        </ul>
      `}
    </div>
    <div class="card section">
      <div class="card-title">Processos</div>
      <div class="note">APIs legislativas não expõem processos judiciais. Consulte CNJ / tribunais ou Portal da Transparência.</div>
    </div>
  `;
  $('#btn-back').onclick = () => { state.view = 'results'; render(); };
}

function render() {
  if (state.view === 'home') renderHome();
  else if (state.view === 'results') renderResults();
  else if (state.view === 'detail') renderDetail();
}

$('#btn-about').onclick = () => swalBase({
  title: 'PoliticosBR',
  html: 'PWA offline-capable.<br>Fontes: Dados Abertos Câmara + Senado.<br>Design system dark amber.',
  icon: 'info'
});
render();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
