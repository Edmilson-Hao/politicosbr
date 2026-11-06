const CAMARA = 'https://dadosabertos.camara.leg.br/api/v2';
const SENADO = 'https://legis.senado.leg.br/dadosabertos';
const CACHE_KEY = 'politicosbr_cache_v1';
const state = {
  view: 'home',
  query: '',
  results: [],
  selected: null,
  detail: null,
  loading: false,
  searchId: 0
};

// aliases para figuras muito conhecidas que a API de deputados atuais não retorna bem
const ALIASES = {
  'lula': ['Luiz Inacio', 'Lula da Silva', 'Luiz Inácio'],
  'bolsonaro': ['Bolsonaro', 'Jair Messias'],
  'dilma': ['Dilma Rousseff', 'Dilma']
};

const $ = s => document.querySelector(s);
const main = () => $('#main');

function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

function swalBase(opts) {
  return Swal.fire({
    background: '#1e293b',
    color: '#f1f5f9',
    confirmButtonColor: '#f59e0b',
    ...opts
  });
}

async function fetchJSON(url, signal) {
  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function searchCamara(nome, signal) {
  const terms = [nome];
  const key = nome.toLowerCase().trim();
  if (ALIASES[key]) terms.push(...ALIASES[key]);

  const all = [];
  const seenIds = new Set();

  for (const term of terms) {
    try {
      // página 1 + 2 para pegar mais resultados
      for (let pagina = 1; pagina <= 2; pagina++) {
        const data = await fetchJSON(
          `${CAMARA}/deputados?nome=${encodeURIComponent(term)}&itens=100&pagina=${pagina}&ordem=ASC&ordenarPor=nome`,
          signal
        );
        for (const d of (data.dados || [])) {
          if (seenIds.has(d.id)) continue;
          seenIds.add(d.id);
          all.push({
            id: d.id,
            source: 'camara',
            nome: d.nome,
            nomeCivil: d.nomeCivil || d.nome,
            partido: d.siglaPartido,
            uf: d.siglaUf,
            foto: d.urlFoto,
            cargo: 'Deputado(a) Federal',
            status: d.email ? 'Em exercício' : 'Histórico',
            uri: d.uri
          });
        }
        if (!(data.dados || []).length || (data.dados || []).length < 100) break;
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('Camara term', term, e);
    }
  }
  return all;
}

async function searchSenado(nome, signal) {
  try {
    const data = await fetchJSON(`${SENADO}/senador/lista/atual.json`, signal);
    const list = data?.ListaParlamentarEmExercicio?.Parlamentares?.Parlamentar || [];
    const q = nome.toLowerCase();
    const terms = [q];
    if (ALIASES[q]) terms.push(...ALIASES[q].map(t => t.toLowerCase()));

    return list
      .filter(p => {
        const id = p.IdentificacaoParlamentar || {};
        const n = (id.NomeParlamentar || '').toLowerCase();
        const nc = (id.NomeCompletoParlamentar || '').toLowerCase();
        return terms.some(t => n.includes(t) || nc.includes(t));
      })
      .map(p => {
        const id = p.IdentificacaoParlamentar;
        return {
          id: id.CodigoParlamentar,
          source: 'senado',
          nome: id.NomeParlamentar,
          nomeCivil: id.NomeCompletoParlamentar,
          partido: id.SiglaPartidoParlamentar,
          uf: id.UfParlamentar,
          foto: id.UrlFotoParlamentar,
          cargo: 'Senador(a)',
          status: 'Em exercício',
          uri: id.UrlPaginaParlamentar
        };
      });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('Senado', e);
    return [];
  }
}

let currentController = null;

async function doSearch(q) {
  q = (q || '').trim();
  if (q.length < 2) {
    await swalBase({ title: 'Atenção', text: 'Digite pelo menos 2 caracteres.', icon: 'warning' });
    return;
  }

  // cancela busca anterior
  if (currentController) currentController.abort();
  currentController = new AbortController();
  const signal = currentController.signal;
  const myId = ++state.searchId;

  state.query = q;
  state.view = 'results';
  state.results = [];
  state.loading = true;
  render();

  try {
    const [cam, sen] = await Promise.all([
      searchCamara(q, signal),
      searchSenado(q, signal)
    ]);

    // se outra busca começou, ignora
    if (myId !== state.searchId) return;

    const seen = new Set();
    state.results = [...cam, ...sen].filter(r => {
      const k = `${r.source}-${r.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      c[q.toLowerCase()] = { t: Date.now(), results: state.results };
      localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    } catch {}

    state.loading = false;
    render();
    toast(state.results.length ? `${state.results.length} encontrado(s)` : 'Nenhum resultado');
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (myId !== state.searchId) return;
    state.loading = false;
    state.results = [];
    render();
    await swalBase({ title: 'Erro', text: 'Falha na busca. Verifique a conexão.', icon: 'error' });
  }
}

async function loadDetail(person) {
  state.selected = person;
  state.view = 'detail';
  state.detail = null;
  state.loading = true;
  render();

  try {
    if (person.source === 'camara') {
      const [dep, props] = await Promise.all([
        fetchJSON(`${CAMARA}/deputados/${person.id}`),
        fetchJSON(`${CAMARA}/proposicoes?idDeputadoAutor=${person.id}&itens=30&ordem=DESC&ordenarPor=id`)
      ]);
      const d = dep.dados || {};
      state.detail = {
        ...person,
        bio: d,
        mandatos: d.ultimoStatus ? '1+' : '—',
        proposicoes: (props.dados || []).map(p => ({
          id: p.id,
          sigla: p.siglaTipo,
          numero: p.numero,
          ano: p.ano,
          ementa: p.ementa || '',
          uri: p.uri || `https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=${p.id}`
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
        proposicoes: arr.slice(0, 30).map(m => {
          const idMat = m.Codigo || m.IdentificacaoMateria?.CodigoMateria;
          return {
            id: idMat,
            sigla: m.IdentificacaoMateria?.SiglaSubtipoMateria || m.Sigla || '',
            numero: m.IdentificacaoMateria?.NumeroMateria || m.Numero || '',
            ano: m.IdentificacaoMateria?.AnoMateria || m.Ano || '',
            ementa: m.EmentaMateria || m.Ementa || '',
            uri: idMat
              ? `https://www25.senado.leg.br/web/atividade/materias/-/materia/${idMat}`
              : null
          };
        }),
        votos: { sim: '—', nao: '—', abst: '—', total: '—' },
        processos: []
      };
    }
  } catch (e) {
    console.error(e);
    await swalBase({ title: 'Erro', text: 'Falha ao carregar detalhes.', icon: 'error' });
    state.view = 'results';
  }
  state.loading = false;
  render();
}

function openProposicao(pr) {
  if (pr.uri) {
    window.open(pr.uri, '_blank', 'noopener');
    return;
  }
  swalBase({
    title: `${pr.sigla || ''} ${pr.numero || ''}/${pr.ano || ''}`,
    html: `<p style="text-align:left;font-size:.9rem;color:#94a3b8">${pr.ementa || 'Sem ementa.'}</p>`,
    icon: 'info'
  });
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
    <div class="note">Fontes: Dados Abertos da Câmara e Senado. Busca cobre deputados (atuais + históricos via nome) e senadores em exercício. Presidentes/executivo sem mandato legislativo atual podem não aparecer.</div>
  `;
  const input = $('#q');
  $('#btn-search').onclick = () => doSearch(input.value);
  input.onkeydown = e => { if (e.key === 'Enter') doSearch(input.value); };
  input.focus();
}

function renderResults() {
  if (state.loading) {
    main().innerHTML = `
      <button class="btn btn-outline btn-sm back" id="btn-back">← Voltar</button>
      <div class="loading">
        <div class="spinner"></div>
        <div>Pesquisando “${state.query}”…</div>
        <div style="font-size:.8rem;margin-top:8px;color:var(--muted)">Câmara + Senado</div>
      </div>
    `;
    $('#btn-back').onclick = () => {
      if (currentController) currentController.abort();
      state.loading = false;
      state.view = 'home';
      render();
    };
    return;
  }

  const list = state.results;
  main().innerHTML = `
    <button class="btn btn-outline btn-sm back" id="btn-back">← Voltar</button>
    <div class="card-title">Resultados para “${state.query}” (${list.length})</div>
    ${list.length === 0 ? `
      <div class="empty">Nenhum parlamentar encontrado com esse nome nas bases legislativas.</div>
      <div class="note">Dica: tente o nome parlamentar ou civil completo. Presidentes e cargos do Executivo não constam como deputado/senador atual.</div>
    ` : `
      <div class="list">
        ${list.map((r, i) => `
          <div class="item" data-i="${i}">
            <img src="${r.foto || ''}" alt="" loading="lazy" onerror="this.style.display='none'">
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
  $('#btn-back').onclick = () => {
    state.view = 'home';
    render();
  };
  document.querySelectorAll('.item').forEach(el => {
    el.onclick = () => loadDetail(state.results[+el.dataset.i]);
  });
}

function renderDetail() {
  const p = state.selected;
  const d = state.detail;

  if (state.loading || !d) {
    main().innerHTML = `
      <button class="btn btn-outline btn-sm back" id="btn-back">← Resultados</button>
      <div class="loading"><div class="spinner"></div>Carregando detalhes…</div>
    `;
    $('#btn-back').onclick = () => { state.view = 'results'; state.loading = false; render(); };
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
    <div class="note">* Votações nominais exigem agregação de centenas de endpoints; resumo completo não disponível em tempo real.</div>
    <div class="card section">
      <div class="card-title">Projetos / Matérias recentes</div>
      ${d.proposicoes.length === 0 ? '<div class="empty" style="padding:16px">Nenhum encontrado</div>' : `
        <ul class="simple" id="prop-list">
          ${d.proposicoes.map((pr, i) => `
            <li class="prop-item" data-i="${i}" style="cursor:pointer">
              <strong style="color:var(--accent)">${pr.sigla || ''} ${pr.numero || ''}/${pr.ano || ''}</strong>
              <br><span style="color:var(--muted);font-size:.85rem">${(pr.ementa || '').slice(0, 140)}${(pr.ementa || '').length > 140 ? '…' : ''}</span>
              <div style="font-size:.72rem;color:var(--accent);margin-top:4px">Toque para abrir →</div>
            </li>
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
  document.querySelectorAll('.prop-item').forEach(el => {
    el.onclick = () => openProposicao(d.proposicoes[+el.dataset.i]);
  });
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
