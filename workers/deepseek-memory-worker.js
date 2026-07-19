const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const WORKER_VERSION = '2026-07-18.1';
const PRIMARY_DEEPSEEK_MODEL = 'deepseek-chat';
const FALLBACK_DEEPSEEK_MODEL = 'deepseek-chat';
const JOB_TTL_SECONDS = 60 * 60 * 6;
const CHUNK_NOTE_MAX_TOKENS = 4000;
const FINAL_RESULT_MAX_TOKENS = 8000;
const FINAL_RESULT_MAX_TOKENS_SG = 10000;

const JNS_BASE = 'https://api.jnsseguros.com.br/igc/v1';
const JUNTO_BASE = 'https://ms-gateway.juntoseguros.com/guarantee/api/v2';
const ONPOINT_BASE = 'https://gateway.onpoint.com.br/prod/garantia/api/plugv2';
const ONPOINT_AXA_BASE = 'https://gateway.onpoint.com.br/axa/garantia/api/plugv2';
const FATOR_AUTH_URL = 'https://api.asgardeo.io/t/fatorseguradora/oauth2/token';
const FATOR_QUERY_URL = 'https://api-pdp.fatorseguradora.com.br/hbup/ConsultarLimiteTomador/v1/ConsultarLimiteTomador';

const INSURER_LABELS = {
  jns: 'JNS Seguros',
  junto: 'Junto Seguros',
  essor: 'Essor Seguros',
  sombrero: 'Sombrero Seguros',
  newe: 'NEWE Seguros',
  mitsui: 'Mitsui Sumitomo Seguros',
  axa: 'AXA Seguros',
  fator: 'Fator Seguradora',
};
const ALL_INSURER_KEYS = Object.keys(INSURER_LABELS);
// Onpoint rejeita chamadas paralelas para o mesmo CNPJ — essas seguradoras rodam em sequência
const ONPOINT_FAMILY = ['essor', 'sombrero', 'newe', 'mitsui', 'axa'];
const ONPOINT_INSURERS = {
  essor: { name: 'Essor Seguros S.A.', id: '406fecd8-bfd7-4cba-a9bd-87efcfd38288', axaRoute: false },
  sombrero: { name: 'SOMBRERO SEGUROS S/A', id: '7e3b3e1a-e0db-4067-876f-350f73a38acd', axaRoute: false },
  newe: { name: 'NEWE Seguros S.A.', id: 'd53bda2d-0710-4bff-b5be-51f2ab377362', axaRoute: false },
  mitsui: { name: 'Mitsui Sumitomo Seguros S.A.', id: 'ff4a046b-d047-4bec-9253-1e3bc83c2df1', axaRoute: false },
  axa: { name: 'AXA Seguros S.A.', id: '555b5249-1f74-4681-9f49-5958ad720cfb', axaRoute: true },
};
const LIMITS_TOKEN_TTL_SECONDS = 60 * 25;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return withCors(jsonResponse({
          ok: true,
          worker: 'lucky-hat-b241',
          version: WORKER_VERSION,
        }));
      }

      if (request.method === 'POST' && url.pathname === '/v1/analysis-jobs') {
        return withCors(await handleCreateJob(request, env));
      }

      if (request.method === 'POST' && url.pathname === '/v1/limits/query') {
        return withCors(await handleLimitsQuery(request, env));
      }

      const jobMatch = url.pathname.match(/^\/v1\/analysis-jobs\/([^/]+)$/);
      if (request.method === 'GET' && jobMatch) {
        return withCors(await handleGetJob(jobMatch[1], env));
      }

      const runMatch = url.pathname.match(/^\/v1\/analysis-jobs\/([^/]+)\/run$/);
      if (request.method === 'POST' && runMatch) {
        return withCors(await handleRunJob(runMatch[1], env));
      }

      if (request.method === 'POST' && url.pathname === '/') {
        return withCors(await handleLegacyProxy(request, env));
      }

      return withCors(jsonResponse({ error: 'Not found' }, 404));
    } catch (err) {
      return withCors(jsonResponse({ error: err.message || 'Internal error' }, 500));
    }
  },
};

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function handleLegacyProxy(request, env) {
  const payload = await request.json();
  const data = await callDeepSeek(env, payload);
  return jsonResponse(data);
}

async function handleCreateJob(request, env) {
  const body = await request.json();
  validateCreateJobBody(body);

  const jobId = crypto.randomUUID();
  const { manifest, chunks } = buildJobManifest(jobId, body);

  await redisSet(env, jobKey(jobId), manifest, JOB_TTL_SECONDS);
  for (const chunk of chunks) {
    await redisSet(env, chunkKey(jobId, chunk.index), chunk, JOB_TTL_SECONDS);
  }

  return jsonResponse({
    jobId,
    status: manifest.status,
    totalChunks: manifest.totalChunks,
    createdAt: manifest.createdAt,
    version: WORKER_VERSION,
  }, 201);
}

async function handleGetJob(jobId, env) {
  const manifest = await requireJob(env, jobId);
  return jsonResponse(safeJobResponse(manifest));
}

async function handleRunJob(jobId, env) {
  const manifest = await requireJob(env, jobId);
  if (manifest.status === 'completed') return jsonResponse(safeJobResponse(manifest));
  if (manifest.status === 'failed') return jsonResponse(safeJobResponse(manifest), 500);

  if (manifest.nextChunkIndex < manifest.totalChunks) {
    const chunkIndex = manifest.nextChunkIndex + 1;
    const chunk = await redisGet(env, chunkKey(jobId, chunkIndex));
    if (!chunk) throw new Error(`Chunk ${chunkIndex} nao encontrado.`);

    manifest.status = 'processing';
    manifest.updatedAt = new Date().toISOString();
    await redisSet(env, jobKey(jobId), manifest, JOB_TTL_SECONDS);

    const note = await analyzeChunk(env, manifest, chunk);
    // Nota armazenada como chave separada: manifest não cresce com o número de arquivos
    await redisSet(env, noteKey(jobId, chunkIndex), {
      index: chunkIndex,
      fileName: chunk.fileName,
      chunkLabel: chunk.chunkLabel,
      note,
    }, JOB_TTL_SECONDS);
    manifest.nextChunkIndex = chunkIndex;
    manifest.updatedAt = new Date().toISOString();

    await redisSet(env, jobKey(jobId), manifest, JOB_TTL_SECONDS);
    return jsonResponse({
      ...safeJobResponse(manifest),
      retryAfterMs: 150,
    });
  }

  const finalResult = await synthesizeFinalResult(env, manifest, jobId);
  manifest.status = 'completed';
  manifest.result = finalResult;
  manifest.updatedAt = new Date().toISOString();
  await redisSet(env, jobKey(jobId), manifest, JOB_TTL_SECONDS);

  return jsonResponse(safeJobResponse(manifest));
}

function validateCreateJobBody(body) {
  if (!body || typeof body !== 'object') throw new Error('Body invalido.');
  if (!['analise-financeira', 'seguro-garantia', 'fianca-locaticia'].includes(body.flow)) {
    throw new Error('Flow invalido.');
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    throw new Error('Envie ao menos um arquivo.');
  }
}

function buildJobManifest(jobId, body) {
  const createdAt = new Date().toISOString();
  const chunks = [];
  const images = [];

  body.files.forEach(file => {
    if (file.tipo === 'imagem') {
      images.push({ nome: file.nome, conteudo: file.conteudo });
      return;
    }

    const partes = Array.isArray(file.partes) && file.partes.length > 0
      ? file.partes
      : [{ indice: 1, rotulo: 'Parte 1', conteudo: file.conteudo || '' }];

    partes.forEach((parte, idx) => {
      const textContent = typeof parte.conteudo === 'string'
        ? parte.conteudo
        : (typeof file.conteudo === 'string' ? file.conteudo : '');

      if (!textContent.trim()) return;

      chunks.push({
        index: chunks.length + 1,
        fileName: file.nome,
        chunkLabel: parte.rotulo || `Parte ${idx + 1}`,
        page: parte.pagina || null,
        content: textContent,
      });
    });
  });

  if (chunks.length === 0 && images.length > 0) {
    chunks.push({
      index: 1,
      fileName: images.map(image => image.nome).join(', '),
      chunkLabel: 'Imagens enviadas',
      page: null,
      content: '[Documento composto somente por imagens. Use as imagens anexadas como fonte principal.]',
    });
  }

  return {
    manifest: {
      jobId,
      flow: body.flow,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
      totalChunks: chunks.length,
      nextChunkIndex: 0,
      images,
      fileNames: body.files.map(file => file.nome),
      result: null,
      error: null,
      chunks: chunks.map(({ content, ...rest }) => rest),
    },
    chunks,
  };
}

async function analyzeChunk(env, manifest, chunk) {
  const prompt = buildChunkPrompt(manifest.flow, manifest.fileNames, chunk);
  const content = [
    { type: 'text', text: prompt },
    ...manifest.images.map(image => ({ type: 'image_url', image_url: { url: image.conteudo } })),
  ];
  // Usa deepseek-chat para chunks: mais rápido, sem overhead de reasoning, evita content vazio
  const payload = {
    model: FALLBACK_DEEPSEEK_MODEL,
    messages: [
      { role: 'user', content },
    ],
    max_tokens: CHUNK_NOTE_MAX_TOKENS,
  };
  const response = await callDeepSeek(env, payload);
  return extractMessageContent(response);
}

async function synthesizeFinalResult(env, manifest, jobId) {
  // Busca cada nota individualmente do Redis — evita carregar tudo no manifest
  const chunkNotes = [];
  for (let i = 1; i <= manifest.nextChunkIndex; i++) {
    const noteData = await redisGet(env, noteKey(jobId, i));
    if (noteData) chunkNotes.push(noteData);
  }
  const prompt = buildFinalPrompt(manifest.flow, manifest.fileNames, chunkNotes);
  const maxTokens = manifest.flow === 'seguro-garantia' ? FINAL_RESULT_MAX_TOKENS_SG : FINAL_RESULT_MAX_TOKENS;
  const payload = {
    model: PRIMARY_DEEPSEEK_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  };
  const response = await callDeepSeek(env, payload);
  return extractMessageContent(response);
}

function buildChunkPrompt(flow, fileNames, chunk) {
  const header = `Arquivos: ${fileNames.join(', ')}\nTrecho atual: ${chunk.fileName} / ${chunk.chunkLabel}${chunk.page ? ` / pagina ${chunk.page}` : ''}\n`;
  const content = `${header}\nCONTEUDO DO TRECHO:\n${chunk.content}`;

  if (flow === 'analise-financeira') {
    return `${content}

Analise apenas este trecho e retorne um JSON resumido com as evidencias financeiras encontradas.

REGRA CRITICA DE ESCALA: Verifique se o titulo, cabecalho, rodape ou qualquer linha do trecho menciona "em milhares", "R$ Mil", "Em R$ Mil", "valores em mil", "cifras em mil" ou expressao similar. Se sim, registre "escala":"milhares" — isso indica que TODOS os valores monetarios deste documento estao em milhares de reais e devem ser multiplicados por 1.000 na sintese final. Se nao encontrar essa indicacao, registre "escala":"reais".

Formato: {"escala":"reais|milhares","empresas":[{"empresa":"nome ou null","cnpj":"cnpj ou null","documentos":[{"tipo":"DRE|Balanco Patrimonial|Balancete|null","periodo":"periodo ou null","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"passivo_total":null,"passivo_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null},"observacoes":"evidencias deste trecho"}]}],"alertas":["inconsistencias"]}
Retorne apenas JSON.`;
  }

  if (flow === 'fianca-locaticia') {
    return `${content}

Analise apenas este trecho e retorne um JSON resumido com os fatos contratuais encontrados.
Cite sempre o trecho exato do documento como fonte.

Formato: {"dados_gerais":{"imovel":null,"locatario":null,"locador":null,"finalidade":null,"valor_aluguel":null,"encargos_mensais":null,"valor_garantia":null,"vigencia_inicio":null,"vigencia_fim":null,"indice_reajuste":null,"multa_rescisao":null,"sub_rogacao":null,"foro":null},"clausulas_criticas":[{"titulo":"...","descricao":"...","fonte":"trecho exato do documento","impacto":"Alto|Medio|Baixo"}],"riscos":[{"descricao":"...","fonte":"trecho exato do documento","nivel":"Alto|Medio|Baixo"}],"notas":["resumo curto"]}
Retorne apenas JSON.`;
  }

  // seguro-garantia
  return `${content}

Voce e um especialista em Seguro Garantia. Analise APENAS este trecho e extraia em markdown estruturado e compacto:

**Partes identificadas:** Tomador, Segurado, Beneficiario, Contratante, Contratada com CNPJ/CPF quando disponiveis. Cite o trecho exato como fonte.

**Modalidade identificada:** Qual modalidade de Seguro Garantia este trecho indica (ou sugere). Nivel de confianca.

**Valores e prazos:** Valor do contrato, percentual de garantia, importancia segurada, datas de inicio/termino, prazo de execucao, prazo adicional. Cite o trecho exato.

**Clausulas criticas:** Para cada clausula relevante para emissao, informe titulo, trecho exato e nivel de risco (Alto/Medio/Baixo).

**Riscos identificados:** Inconsistencias, divergencias ou pontos de atencao encontrados NESTE trecho. Nivel (Alto/Medio/Baixo/Critico).

**Nota parcial:** Resumo tecnico deste trecho para uso na sintese final.

Nao invente dados. Se nao encontrar uma informacao, omita o campo. Retorne em markdown enxuto.`;
}

function buildFinalPrompt(flow, fileNames, chunkNotes) {
  const notesBlock = chunkNotes
    .map(note => `### ${note.fileName} / ${note.chunkLabel}\n${note.note}`)
    .join('\n\n');

  if (flow === 'analise-financeira') {
    return `Voce e um especialista em analise financeira para corretora de seguros no Brasil. Os documentos foram processados em lotes. As notas abaixo representam TODO o conteudo dos arquivos enviados.

Arquivos analisados: ${fileNames.join(', ')}

REGRA CRITICA — ESCALA DOS VALORES:
Se qualquer nota parcial registrar "escala: milhares", "escala":"milhares", ou mencionar "em milhares", "R$ Mil", "valores em mil" ou expressao similar para um determinado documento, significa que os valores monetarios DAQUELE documento estao em milhares de reais. Nesse caso:
- Multiplique TODOS os valores monetarios daquele documento por 1.000 antes de incluir no JSON final.
- Exemplo: Ativo Total anotado como 1.500 com escala milhares = registre 1500000 no JSON.
- Informe o ajuste realizado em "observacoes" do documento correspondente.
- Nao misture empresas nem periodos diferentes.
- Consolide dados do mesmo periodo sem perder informacoes.
- Calcule indicadores derivados (margens, ratios) quando os dados basicos estiverem disponiveis.

Retorne APENAS o JSON final:
{"empresas":[{"empresa":"Nome exato da empresa","cnpj":"XX.XXX.XXX/XXXX-XX ou null","documentos":[{"tipo":"DRE|Balanco Patrimonial|Balancete","periodo":"periodo identificado","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"passivo_total":null,"passivo_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null},"observacoes":"observacoes incluindo ajuste de escala se houver"}],"analise_credito":{"classificacao_risco":"Baixo|Moderado|Alto|Critico","resumo_executivo":"...","capacidade_seguro_garantia":"Alta|Moderada|Baixa|Inapta","justificativa_garantia":"...","capacidade_fianca_locaticia":"Alta|Moderada|Baixa|Inapta","justificativa_fianca":"...","pontos_positivos":["..."],"pontos_atencao":["..."],"recomendacao_seguradora":"..."}}]}

NOTAS PARCIAIS:
${notesBlock}`;
  }

  if (flow === 'fianca-locaticia') {
    return `Voce e um especialista em Fianca Locaticia no Brasil, atuando como analista tecnico de corretora de seguros. Os documentos foram processados em lotes. As notas abaixo representam TODO o conteudo dos arquivos enviados.

Arquivos analisados: ${fileNames.join(', ')}

Consolide as notas e retorne APENAS o JSON final completo. Para cada campo de "dados_gerais", preencha "fonte" com o trecho exato do documento onde a informacao foi encontrada. Se a informacao nao foi localizada, use null para "valor" e "Nao localizado no documento" para "fonte".

Analise criticamente: clausulas de multa por rescisao, indice de reajuste, sub-rogacao, vigencia, encargos e responsabilidades. O parecer deve ser tecnicamente justificado.

{"tipo":"Fianca Locaticia","documentos_analisados":["nomes dos arquivos"],"dados_gerais":{"imovel":{"valor":"...ou null","fonte":"trecho exato"},"locatario":{"valor":"...ou null","fonte":"trecho exato"},"locador":{"valor":"...ou null","fonte":"trecho exato"},"finalidade":{"valor":"...ou null","fonte":"trecho exato"},"valor_aluguel":{"valor":0.00,"fonte":"trecho exato"},"encargos_mensais":{"valor":"...ou null","fonte":"trecho exato"},"valor_garantia":{"valor":0.00,"fonte":"trecho exato"},"vigencia_inicio":{"valor":"DD/MM/AAAA ou null","fonte":"trecho exato"},"vigencia_fim":{"valor":"DD/MM/AAAA ou null","fonte":"trecho exato"},"indice_reajuste":{"valor":"...ou null","fonte":"trecho exato"},"multa_rescisao":{"valor":"...ou null","fonte":"trecho exato"},"sub_rogacao":{"valor":"...ou null","fonte":"trecho exato"},"foro":{"valor":"...ou null","fonte":"trecho exato"}},"clausulas_criticas":[{"titulo":"...","descricao":"...","fonte":"trecho exato do documento","impacto":"Alto|Medio|Baixo"}],"riscos":[{"descricao":"...","fonte":"trecho exato do documento","nivel":"Alto|Medio|Baixo"}],"parecer":{"recomendacao":"Emitir | Emitir com ressalvas | Declinar","justificativa":"...","condicoes":["..."]},"resumo":"..."}

NOTAS PARCIAIS:
${notesBlock}`;
  }

  // seguro-garantia
  return `Voce e um especialista em Seguro Garantia no Brasil, atuando como analista tecnico de corretora de seguros. Os documentos foram processados em lotes e as notas abaixo representam TODO o conteudo dos arquivos enviados.

Arquivos analisados: ${fileNames.join(', ')}

Com base nas notas parciais, produza uma ANALISE TECNICA COMPLETA para emissao de Seguro Garantia, em portugues brasileiro, no formato abaixo. Nao invente dados. Quando uma informacao nao estiver nas notas, escreva "Nao localizado no documento." Quando inferida, escreva "Inferido com base em...". Sempre cite a fonte exata (trecho do documento) nas tabelas.

# Analise para Seguro Garantia

## 1. Classificacao do documento
Informe o(s) tipo(s) de documento e se sao relevantes para Seguro Garantia: Relacionado diretamente / Relacionado indiretamente / Documento complementar util / Documento irrelevante.

## 2. Modalidade sugerida
Informe a modalidade mais provavel e justifique com base no objeto, partes e clausulas identificadas. Informe o nivel de confianca: Alto / Medio / Baixo.

## 3. Partes identificadas
| Papel | Nome/Razao Social | CPF/CNPJ | Fonte no documento |
|-------|-------------------|----------|--------------------|

## 4. Dados principais para emissao
| Campo | Informacao encontrada | Fonte/Trecho | Confianca |
|-------|----------------------|--------------|-----------|
Incluir obrigatoriamente: Tomador, Segurado, Beneficiario, Modalidade, Valor base, Percentual de garantia, Importancia segurada sugerida, Vigencia do contrato/obrigacao, Vigencia sugerida da apolice, Objeto.

## 5. Calculo da importancia segurada
Explique o calculo realizado. Se o documento nao permitir calculo conclusivo, informe exatamente o que esta faltando.

## 6. Vigencia recomendada
Explique a logica de definicao da vigencia. Diferencie claramente: vigencia expressa no documento / vigencia inferida / prazo adicional sugerido / ponto que precisa de validacao com a seguradora.

## 7. Objeto sugerido para a apolice
Escreva o objeto em texto pronto para emissao ou cadastro. Use [informacao nao localizada no documento] para campos ausentes.

## 8. Clausulas e coberturas recomendadas
| Clausula/Ponto | Impacto na apolice | Cobertura recomendada | Risco |
|----------------|--------------------|-----------------------|-------|

## 9. Pontos de atencao
Liste todos os riscos, inconsistencias e duvidas com nivel de classificacao: Baixo / Medio / Alto / Critico.

## 10. Documentos ou informacoes pendentes
Liste o que precisa ser solicitado ao cliente ou validado antes de seguir com cotacao ou emissao.

## 11. Conclusao operacional
Responda objetivamente:
- Pode seguir para cotacao?
- Pode seguir para emissao direta?
- Precisa de validacao ou documentos adicionais?
- Esta incompleto ou incompativel com Seguro Garantia?

## 12. Resumo final para cadastro
Tomador:
Segurado:
Modalidade:
Importancia segurada:
Vigencia sugerida:
Objeto:
Coberturas/clausulas principais:
Pendencias:
Nivel de confianca da analise:

NOTAS PARCIAIS DOS DOCUMENTOS:
${notesBlock}`;
}

function extractMessageContent(data) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  // deepseek-reasoner pode retornar content vazio e apenas reasoning_content
  const content = (msg && msg.content) || (msg && msg.reasoning_content) || '';
  if (!content) throw new Error('Resposta vazia da DeepSeek.');
  return String(content)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function callDeepSeek(env, payload) {
  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    if (shouldRetryWithFallbackModel(response.status, text, payload.model)) {
      const fallbackPayload = { ...payload, model: FALLBACK_DEEPSEEK_MODEL };
      const fallbackResponse = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(fallbackPayload),
      });

      if (!fallbackResponse.ok) {
        const fallbackText = await fallbackResponse.text();
        throw new Error(`DeepSeek error ${fallbackResponse.status}: ${fallbackText}`);
      }

      return fallbackResponse.json();
    }

    throw new Error(`DeepSeek error ${response.status}: ${text}`);
  }

  return response.json();
}

function shouldRetryWithFallbackModel(status, text, model) {
  if (model !== PRIMARY_DEEPSEEK_MODEL) return false;
  if (status !== 400 && status !== 404) return false;

  const raw = String(text || '').toLowerCase();
  return raw.includes('model') && (
    raw.includes('not found') ||
    raw.includes('does not exist') ||
    raw.includes('invalid') ||
    raw.includes('unsupported')
  );
}

// ── Consulta de Limites por Seguradora ──

async function handleLimitsQuery(request, env) {
  const body = await request.json();
  const cnpj = normalizeCnpj(body.cnpj);
  if (cnpj.length !== 14) throw new Error('Informe um CNPJ valido com 14 digitos.');

  const requested = Array.isArray(body.seguradoras) && body.seguradoras.length > 0
    ? body.seguradoras.filter(key => ALL_INSURER_KEYS.includes(key))
    : ALL_INSURER_KEYS;
  if (requested.length === 0) throw new Error('Nenhuma seguradora valida informada.');

  const resultados = [];

  const parallelKeys = requested.filter(key => !ONPOINT_FAMILY.includes(key));
  const sequentialKeys = requested.filter(key => ONPOINT_FAMILY.includes(key));

  const parallelResults = await Promise.all(parallelKeys.map(key => queryInsurer(env, cnpj, key)));
  resultados.push(...parallelResults);

  // Onpoint/AXA nao aceitam chamadas paralelas para o mesmo CNPJ
  for (const key of sequentialKeys) {
    resultados.push(await queryInsurer(env, cnpj, key));
  }

  resultados.sort((a, b) => requested.indexOf(a.seguradora) - requested.indexOf(b.seguradora));

  return jsonResponse({
    version: WORKER_VERSION,
    cnpj,
    consultadoEm: new Date().toISOString(),
    resultados,
  });
}

async function queryInsurer(env, cnpj, key) {
  try {
    let dados;
    if (key === 'jns') dados = await queryJns(env, cnpj);
    else if (key === 'junto') dados = await queryJunto(env, cnpj);
    else if (key === 'fator') dados = await queryFator(env, cnpj);
    else if (ONPOINT_FAMILY.includes(key)) dados = await queryOnpoint(env, cnpj, key);
    else throw new Error(`Seguradora desconhecida: ${key}`);

    return { seguradora: key, label: INSURER_LABELS[key], status: 'ok', dados };
  } catch (err) {
    return { seguradora: key, label: INSURER_LABELS[key], status: 'erro', erro: err.message || 'Erro desconhecido' };
  }
}

function normalizeCnpj(value) {
  return String(value || '').replace(/\D/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -- JNS Seguros --

async function getJnsToken(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await redisGet(env, 'limits:token:jns');
    if (cached && cached.token) return cached.token;
  }

  const res = await fetch(`${JNS_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-cache' },
    body: JSON.stringify({
      username: env.JNS_USERNAME,
      password: env.JNS_PASSWORD,
      token: env.JNS_TOKEN,
    }),
  });
  if (!res.ok) throw new Error(`JNS login error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const token = data.token || data.access_token || (data.data && data.data.token);
  if (!token) throw new Error('JNS: token nao encontrado na resposta de login.');

  await redisSet(env, 'limits:token:jns', { token }, LIMITS_TOKEN_TTL_SECONDS);
  return token;
}

async function queryJns(env, cnpj) {
  let token = await getJnsToken(env);
  let res = await fetch(`${JNS_BASE}/issuer?document=${cnpj}`, {
    headers: { Authorization: `Bearer ${token}`, 'cache-control': 'no-cache' },
  });

  if (res.status === 401) {
    token = await getJnsToken(env, true);
    res = await fetch(`${JNS_BASE}/issuer?document=${cnpj}`, {
      headers: { Authorization: `Bearer ${token}`, 'cache-control': 'no-cache' },
    });
  }

  if (!res.ok) throw new Error(`JNS issuer error ${res.status}: ${await res.text()}`);
  return res.json();
}

// -- Junto Seguros --

async function getJuntoToken(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await redisGet(env, 'limits:token:junto');
    if (cached && cached.token) return cached.token;
  }

  const res = await fetch(`${JUNTO_BASE}/authentication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json-patch+json', Accept: '*/*' },
    body: JSON.stringify({
      clientId: env.JUNTO_CLIENT_ID,
      clientSecret: env.JUNTO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Junto auth error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const token = data.accessToken;
  if (!token) throw new Error('Junto: accessToken nao encontrado na resposta de autenticacao.');
  const expiresIn = Number(data.expiresIn) || 300;

  await redisSet(env, 'limits:token:junto', { token }, Math.max(60, expiresIn - 30));
  return token;
}

async function queryJunto(env, cnpj) {
  let token = await getJuntoToken(env);
  const authHeaders = () => ({ Authorization: `Bearer ${token}`, Accept: '*/*' });

  let res = await fetch(`${JUNTO_BASE}/policyholders/${cnpj}/modalities`, { headers: authHeaders() });

  if (res.status === 401) {
    token = await getJuntoToken(env, true);
    res = await fetch(`${JUNTO_BASE}/policyholders/${cnpj}/modalities`, { headers: authHeaders() });
  }

  if (res.status === 400 || res.status === 404) {
    // Tomador ainda nao cadastrado na Junto — cadastra e tenta novamente apos propagacao
    const createRes = await fetch(`${JUNTO_BASE}/policyholders`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ federalId: cnpj }),
    });
    if (createRes.ok) {
      await sleep(2000);
      res = await fetch(`${JUNTO_BASE}/policyholders/${cnpj}/modalities`, { headers: authHeaders() });
    }
  }

  if (!res.ok) throw new Error(`Junto modalities error ${res.status}: ${await res.text()}`);
  return res.json();
}

// -- Onpoint (Essor / Sombrero / NEWE / Mitsui) e AXA --

async function queryOnpoint(env, cnpj, key) {
  const insurer = ONPOINT_INSURERS[key];
  if (!insurer) throw new Error(`Seguradora Onpoint desconhecida: ${key}`);

  const base = insurer.axaRoute ? ONPOINT_AXA_BASE : ONPOINT_BASE;
  const res = await fetch(`${base}/GetPolicyHolderLimitsAndRates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'application-key-v2': env.ONPOINT_APPLICATION_KEY_V2,
    },
    body: JSON.stringify({
      BrokerCnpj: env.ONPOINT_BROKER_CNPJ,
      InsuranceUniqueId: insurer.id,
      PolicyHolderCnpj: cnpj,
      Options: {},
    }),
  });

  if (!res.ok) throw new Error(`Onpoint (${insurer.name}) error ${res.status}: ${await res.text()}`);
  return res.json();
}

// -- Fator Seguradora --

async function getFatorToken(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await redisGet(env, 'limits:token:fator');
    if (cached && cached.token) return cached.token;
  }

  const basic = btoa(`${env.FATOR_CLIENT_ID}:${env.FATOR_CLIENT_SECRET}`);
  const res = await fetch(FATOR_AUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Fator auth error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const token = data.access_token;
  if (!token) throw new Error('Fator: access_token nao encontrado na resposta de autenticacao.');
  const expiresIn = Number(data.expires_in) || 900;

  await redisSet(env, 'limits:token:fator', { token }, Math.max(60, expiresIn - 30));
  return token;
}

async function queryFator(env, cnpj) {
  let token = await getFatorToken(env);
  const buildUrl = () => `${FATOR_QUERY_URL}?id_corretor=${encodeURIComponent(env.FATOR_CORRETOR_ID)}&nm_login=${encodeURIComponent(env.FATOR_NM_LOGIN)}&nr_cnpj_cpf=${cnpj}`;

  let res = await fetch(buildUrl(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });

  if (res.status === 401) {
    token = await getFatorToken(env, true);
    res = await fetch(buildUrl(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  }

  if (!res.ok) throw new Error(`Fator consulta error ${res.status}: ${await res.text()}`);
  return res.json();
}

function safeJobResponse(manifest) {
  return {
    version: WORKER_VERSION,
    jobId: manifest.jobId,
    flow: manifest.flow,
    status: manifest.status,
    totalChunks: manifest.totalChunks,
    processedChunks: manifest.nextChunkIndex,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    result: manifest.result,
    error: manifest.error,
  };
}

async function requireJob(env, jobId) {
  const manifest = await redisGet(env, jobKey(jobId));
  if (!manifest) throw new Error('Job nao encontrado.');
  return manifest;
}

function jobKey(jobId) {
  return `deepseek:job:${jobId}`;
}

function chunkKey(jobId, index) {
  return `deepseek:job:${jobId}:chunk:${index}`;
}

function noteKey(jobId, index) {
  return `deepseek:job:${jobId}:note:${index}`;
}

async function redisGet(env, key) {
  const res = await redisCall(env, ['GET', key]);
  return res.result ? JSON.parse(res.result) : null;
}

async function redisSet(env, key, value, ttlSeconds) {
  await redisCall(env, ['SETEX', key, String(ttlSeconds), JSON.stringify(value)]);
}

async function redisCall(env, command) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Configure UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN no Worker.');
  }

  // POST body evita limite de tamanho de URL ao armazenar manifests grandes (chunkNotes acumulados)
  const response = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redis error ${response.status}: ${text}`);
  }

  return response.json();
}
