// netlify/functions/reunioes-analise.js
//
// Análise das reuniões do time (aba "Análise de reuniões"). Lê o RESUMO que o HubSpot gera
// por IA a partir da gravação (hs_meeting_summary) e, quando existe, as notas do Fathom
// (hs_internal_meeting_notes), e avalia cada reunião contra um roteiro de boa condução.
//
// IMPORTANTE: a avaliação se baseia no RESUMO, não na gravação inteira. "Não evidenciado"
// quer dizer "o resumo não mostra", e não "o analista não fez" — serve de pista pra ouvir a
// gravação, não de veredito.
//
// Três ações (uma function só, pra facilitar a implantação):
//   GET  ?action=lista&start=ISO&end=ISO  -> reuniões do período com sinais objetivos
//                                            (resumo/gravação, sem conversa, negócio associado)
//   GET  ?action=cache                    -> avaliações já feitas (guardadas no Blobs)
//   POST {action:'avaliar', meetingId}    -> avalia UMA reunião com a IA e guarda o resultado
// Cada avaliação é uma chamada curta e independente: o painel chama uma por vez (3 em
// paralelo) — assim nenhuma chamada se aproxima do limite de 10s do Netlify, e uma reunião
// já avaliada nunca é analisada de novo (a menos que o roteiro mude de versão).

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODELO = 'claude-sonnet-5'; // mesmo modelo das outras functions do painel
const OWNERS = ['99146615', '1901021576', '284204544', '2025841531', '123547319']; // Ana, Beatriz, Emanoella, Alice, Beatryz

// ---------------------------------------------------------------- roteiro (1ª versão)
// É a definição de "conduzir certo". Fica AQUI (fonte única): o painel desenha as colunas e
// os textos a partir do que esta function devolve. Mudou algo? Suba RUBRICA_VERSAO — as
// avaliações antigas deixam de valer e as reuniões são reavaliadas.
const RUBRICA_VERSAO = 1;
const RUBRICA = [
  { id: 'abertura', nome: 'Abertura e apresentação', peso: 10, descricao: 'Se apresentou e explicou o papel e o objetivo do onboarding.' },
  { id: 'diagnostico', nome: 'Diagnóstico do cliente', peso: 25, descricao: 'Entendeu o negócio, o momento atual e o que o cliente espera do sistema.' },
  { id: 'conducao', nome: 'Condução prática', peso: 25, descricao: 'Mostrou ou configurou funcionalidades alinhadas ao negócio do cliente, em vez de uma explicação genérica.' },
  { id: 'duvidas', nome: 'Dúvidas e dificuldades', peso: 15, descricao: 'Identificou as dúvidas ou problemas do cliente e encaminhou uma solução.' },
  { id: 'proximos', nome: 'Próximos passos', peso: 15, descricao: 'Combinou ações claras: o que o cliente faz, o que o analista envia ou retorna, e quando.' },
  { id: 'apoio', nome: 'Apoio e materiais', peso: 10, descricao: 'Apresentou o suporte, a central de ajuda, materiais ou canais de contato.' },
];
const STATUS = ['evidenciado', 'parcial', 'nao_evidenciado', 'nao_se_aplica'];
const VALOR = { evidenciado: 1, parcial: 0.5, nao_evidenciado: 0 };

// Resumo da IA que avisa que NÃO houve conversa (reunião em que ninguém falou)
const SEM_CONVERSA = /n[ãa]o foi poss[ií]vel gerar|imposs[ií]vel gerar|sem contexto ou di[aá]logo|entradas num[ée]ricas|s[ée]rie de n[úu]meros/i;

// ---------------------------------------------------------------- JSON tolerante (ver padroes-notas.js)
function limparControlesDentroDeStrings(s) {
  let out = '';
  let dentro = false;
  let esc = false;
  for (const ch of s) {
    if (dentro) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { dentro = false; out += ch; continue; }
      if (ch === '\n' || ch === '\r' || ch === '\t') { out += ' '; continue; }
      out += ch;
    } else {
      if (ch === '"') dentro = true;
      out += ch;
    }
  }
  return out;
}
function repararJsonCortado(s) {
  s = limparControlesDentroDeStrings(s);
  const pilha = [];
  let dentro = false;
  let esc = false;
  for (const ch of s) {
    if (dentro) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') dentro = false;
      continue;
    }
    if (ch === '"') dentro = true;
    else if (ch === '{' || ch === '[') pilha.push(ch);
    else if (ch === '}' || ch === ']') pilha.pop();
  }
  let r = s;
  if (dentro) r += '"';
  r = r.replace(/[,:]\s*$/, '');
  while (pilha.length) r += pilha.pop() === '{' ? '}' : ']';
  return r;
}
function extrairJson(texto) {
  if (!texto) return null;
  let t = String(texto).replace(/```json|```/gi, '').trim();
  const ini = t.indexOf('{');
  if (ini === -1) return null;
  t = t.slice(ini);
  const fim = t.lastIndexOf('}');
  const candidatos = [t];
  if (fim > 0) candidatos.push(t.slice(0, fim + 1));
  for (const c of candidatos) {
    try { return JSON.parse(c); } catch { /* tenta o próximo */ }
    try { return JSON.parse(limparControlesDentroDeStrings(c)); } catch { /* idem */ }
  }
  try { return JSON.parse(repararJsonCortado(t)); } catch { return null; }
}

// ---------------------------------------------------------------- utilidades
const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textoPuro(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d|ul|ol|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function getStoreSafe() {
  const { getStore } = require('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  if (siteID && token) return getStore({ name: 'onboarding-radar-reunioes', consistency: 'strong', siteID, token });
  return getStore({ name: 'onboarding-radar-reunioes', consistency: 'strong' });
}

async function hs(url, opts = {}, tentativa = 1) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 429 && tentativa <= 4) { await sleep(Math.min(800 * 2 ** tentativa, 6000)); return hs(url, opts, tentativa + 1); }
  return res;
}

function notaDe(criterios) {
  let soma = 0;
  let pesos = 0;
  RUBRICA.forEach((c) => {
    const st = criterios[c.id] && criterios[c.id].status;
    if (st === 'nao_se_aplica' || !(st in VALOR)) return;
    soma += c.peso * VALOR[st];
    pesos += c.peso;
  });
  return pesos ? Math.round((soma / pesos) * 100) : null;
}

// ---------------------------------------------------------------- ação: lista
async function buscarTodas(filters, properties, maxPaginas = 8) {
  let todas = [];
  let after;
  for (let p = 0; p < maxPaginas; p++) {
    const res = await hs('https://api.hubapi.com/crm/v3/objects/meetings/search', {
      method: 'POST',
      body: JSON.stringify({ filterGroups: [{ filters }], properties, sorts: [{ propertyName: 'hs_meeting_start_time', direction: 'DESCENDING' }], limit: 100, ...(after ? { after } : {}) }),
    });
    if (!res.ok) throw new Error(`HubSpot ${res.status}: ${await res.text()}`);
    const data = await res.json();
    todas = todas.concat(data.results || []);
    after = data.paging && data.paging.next ? data.paging.next.after : undefined;
    if (!after) return { itens: todas, truncado: false };
    await sleep(80);
  }
  return { itens: todas, truncado: true };
}

async function acaoLista(params) {
  const agora = new Date();
  const start = params.start || new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString();
  const end = params.end || agora.toISOString();
  if (isNaN(new Date(start)) || isNaN(new Date(end))) return json(400, { error: 'start/end inválidos' });

  const base = [
    { propertyName: 'hubspot_owner_id', operator: 'IN', values: OWNERS },
    { propertyName: 'hs_meeting_start_time', operator: 'GTE', value: start },
    { propertyName: 'hs_meeting_start_time', operator: 'LT', value: end },
  ];
  const [principal, fathom] = await Promise.all([
    buscarTodas(base, ['hubspot_owner_id', 'hs_meeting_title', 'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome', 'hs_meeting_summary']),
    buscarTodas([...base, { propertyName: 'hs_internal_meeting_notes', operator: 'HAS_PROPERTY' }], ['hubspot_owner_id']),
  ]);
  const comFathom = new Set(fathom.itens.map((m) => String(m.id)));

  // negócio de onboarding associado a cada reunião (uma chamada em lote)
  const dealPorReuniao = {};
  try {
    const ids = principal.itens.map((m) => ({ id: String(m.id) }));
    for (let i = 0; i < ids.length; i += 500) {
      const res = await hs('https://api.hubapi.com/crm/v4/associations/meetings/deals/batch/read', { method: 'POST', body: JSON.stringify({ inputs: ids.slice(i, i + 500) }) });
      if (!res.ok) break;
      const data = await res.json();
      (data.results || []).forEach((r) => { if (r.to && r.to.length) dealPorReuniao[String(r.from.id)] = String(r.to[0].toObjectId); });
    }
  } catch { /* sem o vínculo, o painel linka a própria reunião */ }

  const reunioes = principal.itens.map((m) => {
    const p = m.properties;
    const resumo = textoPuro(p.hs_meeting_summary);
    const semConversa = !!resumo && resumo.length < 600 && SEM_CONVERSA.test(resumo);
    return {
      id: String(m.id),
      ownerId: String(p.hubspot_owner_id || ''),
      titulo: (p.hs_meeting_title || '').replace(/^\s*Onboarding\s*\|?\s*/i, '').replace(/\s+e\s+Gest[ãa]oClick\s*$/i, '').trim(),
      inicio: p.hs_meeting_start_time || null,
      fim: p.hs_meeting_end_time || null,
      outcome: p.hs_meeting_outcome || null,
      temResumo: !!resumo,
      temFathom: comFathom.has(String(m.id)),
      semConversa,
      dealId: dealPorReuniao[String(m.id)] || null,
      trecho: semConversa ? '' : resumo.replace(/^Resumo\s*/i, '').split('\n')[0].slice(0, 220),
    };
  });
  return json(200, { versao: RUBRICA_VERSAO, rubrica: RUBRICA, reunioes, truncado: principal.truncado || fathom.truncado });
}

// ---------------------------------------------------------------- ação: cache
async function acaoCache() {
  const store = await getStoreSafe();
  const { blobs } = await store.list({ prefix: 'aval:' });
  const avaliacoes = {};
  for (let i = 0; i < blobs.length; i += 20) {
    const lote = await Promise.all(blobs.slice(i, i + 20).map(async (b) => { try { return await store.get(b.key, { type: 'json' }); } catch { return null; } }));
    lote.forEach((a) => { if (a && a.meetingId && a.versao === RUBRICA_VERSAO) avaliacoes[a.meetingId] = a; });
  }
  return json(200, { versao: RUBRICA_VERSAO, rubrica: RUBRICA, avaliacoes });
}

// ---------------------------------------------------------------- ação: avaliar
function montarPrompt(m, resumo, fathom) {
  const rubricaTxt = RUBRICA.map((c) => `- ${c.id} (${c.nome}): ${c.descricao}`).join('\n');
  return `Você é um coordenador de Customer Success revisando reuniões de onboarding de uma empresa de software de gestão (GestãoClick, ERP pra micro e pequenas empresas). Avalie COMO O ANALISTA CONDUZIU a reunião, com base APENAS nos textos abaixo (um resumo gerado por IA a partir da gravação${fathom ? ' e as notas de outra ferramenta de gravação' : ''}).

REUNIÃO: ${m.titulo} | resultado marcado: ${m.outcome || 'sem resultado'}

RESUMO DA REUNIÃO:
${resumo || '(sem resumo)'}
${fathom ? `\nNOTAS ADICIONAIS DA GRAVAÇÃO:\n${fathom}\n` : ''}
CRITÉRIOS (avalie cada um):
${rubricaTxt}

REGRAS:
- Use só o que está nos textos. Não invente. O resumo pode omitir detalhes: se o texto não mostra o ponto, marque "nao_evidenciado" (isso NÃO é acusar o analista).
- Status de cada critério: "evidenciado" (claramente presente), "parcial" (aparece pela metade ou de forma vaga), "nao_evidenciado", ou "nao_se_aplica" (o tipo da reunião não pede esse ponto — ex.: reunião de feedback com cliente que já usa o sistema não tem "abertura" de onboarding).
- "evidencia": no máximo 14 palavras, paráfrase do texto (vazio se não houver).
- "tipo": "onboarding_inicial", "acompanhamento" (cliente já usando, revisão ou dúvidas) ou "outro".
- "pontosFortes": até 2 itens (máx. 18 palavras cada). "melhorias": até 2 itens, concretos e acionáveis, no tom de coaching (ex.: "Fechar combinando prazo para cada próximo passo"), sem julgar a pessoa.
- "sentimentoCliente": "positivo", "neutro", "negativo" ou "nao_identificado". "sinalRisco": frase curta SOMENTE se o cliente demonstrou insatisfação, intenção de cancelar ou um problema que bloqueia o uso; senão "".

Responda SOMENTE com JSON válido (sem markdown, sem texto antes ou depois, sem quebra de linha dentro dos textos):
{"tipo":"onboarding_inicial","criterios":{${RUBRICA.map((c) => `"${c.id}":{"status":"evidenciado","evidencia":""}`).join(',')}},"pontosFortes":[],"melhorias":[],"sentimentoCliente":"neutro","sinalRisco":""}`;
}

function validarSaida(p) {
  if (!p || typeof p !== 'object' || !p.criterios || typeof p.criterios !== 'object') return null;
  const criterios = {};
  RUBRICA.forEach((c) => {
    const x = p.criterios[c.id] || {};
    criterios[c.id] = {
      status: STATUS.includes(x.status) ? x.status : 'nao_evidenciado',
      evidencia: typeof x.evidencia === 'string' ? x.evidencia.trim().slice(0, 160) : '',
    };
  });
  const lista = (v) => (Array.isArray(v) ? v : []).map((s) => (typeof s === 'string' ? s.trim().slice(0, 200) : '')).filter(Boolean).slice(0, 2);
  return {
    tipo: ['onboarding_inicial', 'acompanhamento', 'outro'].includes(p.tipo) ? p.tipo : 'outro',
    criterios,
    pontosFortes: lista(p.pontosFortes),
    melhorias: lista(p.melhorias),
    sentimentoCliente: ['positivo', 'neutro', 'negativo', 'nao_identificado'].includes(p.sentimentoCliente) ? p.sentimentoCliente : 'nao_identificado',
    sinalRisco: typeof p.sinalRisco === 'string' ? p.sinalRisco.trim().slice(0, 200) : '',
  };
}

async function acaoAvaliar(body) {
  const meetingId = String(body.meetingId || '').replace(/\D/g, '');
  if (!meetingId) return json(400, { error: 'meetingId é obrigatório' });
  if (!ANTHROPIC_API_KEY) return json(500, { error: 'ANTHROPIC_API_KEY não configurada' });

  const store = await getStoreSafe();
  const chave = `aval:${meetingId}`;
  if (!body.force) {
    try {
      const em = await store.get(chave, { type: 'json' });
      if (em && em.versao === RUBRICA_VERSAO) return json(200, { avaliacao: em, doCache: true });
    } catch { /* segue pra avaliar */ }
  }

  const res = await hs(`https://api.hubapi.com/crm/v3/objects/meetings/${meetingId}?properties=hs_meeting_title,hubspot_owner_id,hs_meeting_outcome,hs_meeting_summary,hs_internal_meeting_notes`);
  if (!res.ok) return json(res.status, { error: `Reunião não encontrada no HubSpot (${res.status})` });
  const reuniao = await res.json();
  const p = reuniao.properties || {};
  const resumo = textoPuro(p.hs_meeting_summary).slice(0, 5000);
  const fathom = textoPuro(p.hs_internal_meeting_notes).slice(0, 5000);
  const m = { titulo: (p.hs_meeting_title || '').trim(), outcome: p.hs_meeting_outcome || null };
  const base = { meetingId, versao: RUBRICA_VERSAO, geradoEm: new Date().toISOString(), ownerId: String(p.hubspot_owner_id || ''), outcome: m.outcome };

  // sem texto nenhum, ou o resumo diz que não houve conversa: nem chama a IA
  const semConversa = !fathom && resumo.length < 600 && SEM_CONVERSA.test(resumo);
  if ((!resumo && !fathom) || semConversa) {
    const a = { ...base, semConteudo: !resumo && !fathom, semConversa };
    await store.set(chave, JSON.stringify(a));
    return json(200, { avaliacao: a });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000); // responde antes de o Netlify cortar a function
  let aiRes;
  try {
    aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELO, max_tokens: 900, messages: [{ role: 'user', content: montarPrompt(m, resumo, fathom) }] }),
    });
  } catch (err) {
    return json(504, { error: err && err.name === 'AbortError' ? 'A IA demorou demais — tente de novo' : String(err) });
  } finally {
    clearTimeout(timer);
  }
  if (!aiRes.ok) return json(aiRes.status, { error: 'Falha ao avaliar', detail: (await aiRes.text()).slice(0, 300) });

  const aiData = await aiRes.json();
  const bloco = (aiData.content || []).find((c) => c.type === 'text');
  const saida = validarSaida(extrairJson(bloco && bloco.text));
  if (!saida) return json(502, { error: 'A IA respondeu fora do formato esperado — tente de novo' });

  const avaliacao = { ...base, ...saida, nota: notaDe(saida.criterios), base: fathom ? 'resumo+fathom' : 'resumo' };
  await store.set(chave, JSON.stringify(avaliacao));
  return json(200, { avaliacao });
}

// ---------------------------------------------------------------- entrada
exports.handler = async function (event) {
  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      if (q.action === 'cache') return await acaoCache();
      return await acaoLista(q);
    }
    if (event.httpMethod === 'POST') {
      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'JSON inválido' }); }
      if (body.action === 'avaliar') return await acaoAvaliar(body);
      return json(400, { error: 'action inválida' });
    }
    return json(405, { error: 'Método não suportado' });
  } catch (err) {
    return json(500, { error: String((err && err.message) || err) });
  }
};

exports._internals = { RUBRICA, notaDe, textoPuro, validarSaida, SEM_CONVERSA };
