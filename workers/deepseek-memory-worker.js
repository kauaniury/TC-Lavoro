const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const WORKER_VERSION = '2026-06-09.1';
const PRIMARY_DEEPSEEK_MODEL = 'deepseek-chat';
const FALLBACK_DEEPSEEK_MODEL = 'deepseek-chat';
const JOB_TTL_SECONDS = 60 * 60 * 6;
const CHUNK_NOTE_MAX_TOKENS = 4000;
const FINAL_RESULT_MAX_TOKENS = 8000;

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
    manifest.chunkNotes.push({
      index: chunkIndex,
      fileName: chunk.fileName,
      chunkLabel: chunk.chunkLabel,
      note,
    });
    manifest.nextChunkIndex = chunkIndex;
    manifest.updatedAt = new Date().toISOString();

    await redisSet(env, jobKey(jobId), manifest, JOB_TTL_SECONDS);
    return jsonResponse({
      ...safeJobResponse(manifest),
      retryAfterMs: 150,
    });
  }

  const finalResult = await synthesizeFinalResult(env, manifest);
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
      chunkNotes: [],
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

async function synthesizeFinalResult(env, manifest) {
  const prompt = buildFinalPrompt(manifest.flow, manifest.fileNames, manifest.chunkNotes);
  const payload = {
    model: PRIMARY_DEEPSEEK_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: FINAL_RESULT_MAX_TOKENS,
  };
  const response = await callDeepSeek(env, payload);
  return extractMessageContent(response);
}

function buildChunkPrompt(flow, fileNames, chunk) {
  const header = `Arquivos: ${fileNames.join(', ')}\nTrecho atual: ${chunk.fileName} / ${chunk.chunkLabel}${chunk.page ? ` / pagina ${chunk.page}` : ''}\n`;
  const content = `${header}\nCONTEUDO DO TRECHO:\n${chunk.content}`;

  if (flow === 'analise-financeira') {
    return `${content}

Analise apenas este trecho e retorne um JSON resumido e compacto com evidencias encontradas neste trecho.
Formato:
{"empresas":[{"empresa":"nome ou null","cnpj":"cnpj ou null","documentos":[{"tipo":"DRE|Balanco Patrimonial|Balancete|null","periodo":"periodo ou null","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"passivo_total":null,"passivo_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null},"observacoes":"evidencias deste trecho"}]}],"alertas":["lista curta de inconsistencias ou riscos encontrados no trecho"]}
Retorne apenas JSON.`;
  }

  if (flow === 'fianca-locaticia') {
    return `${content}

Analise apenas este trecho e retorne um JSON resumido e compacto com fatos deste trecho.
Formato:
{"dados_gerais":{"imovel":null,"locatario":null,"locador":null,"finalidade":null,"valor_aluguel":null,"encargos_mensais":null,"valor_garantia":null,"vigencia_inicio":null,"vigencia_fim":null,"indice_reajuste":null,"multa_rescisao":null,"sub_rogacao":null,"foro":null},"clausulas_criticas":[{"titulo":"...","descricao":"...","fonte":"...","impacto":"Alto|Medio|Baixo"}],"riscos":[{"descricao":"...","fonte":"...","nivel":"Alto|Medio|Baixo"}],"notas":["resumo curto"]}
Retorne apenas JSON.`;
  }

  return `${content}

Analise apenas este trecho e retorne um resumo tecnico estruturado e compacto com:
- Partes e dados gerais identificados
- Modalidades de seguro garantia identificadas
- Clausulas criticas com fonte
- Riscos identificados com nivel e fonte
- Parecer parcial deste trecho

Retorne em markdown enxuto, sem introducao.`;
}

function buildFinalPrompt(flow, fileNames, chunkNotes) {
  const notesBlock = chunkNotes
    .map(note => `### ${note.fileName} / ${note.chunkLabel}\n${note.note}`)
    .join('\n\n');

  if (flow === 'analise-financeira') {
    return `Voce vai consolidar notas parciais de uma analise financeira. Os arquivos completos foram processados em lotes e as notas abaixo representam TODO o documento.

Arquivos analisados: ${fileNames.join(', ')}

Consolide sem perder periodos ou misturar empresas diferentes. Retorne APENAS o JSON final no formato:
{"empresas":[{"empresa":"Nome exato da empresa","cnpj":"XX.XXX.XXX/XXXX-XX ou null","documentos":[{"tipo":"DRE|Balanco Patrimonial|Balancete","periodo":"periodo identificado","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"passivo_total":null,"passivo_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null},"observacoes":"observacoes relevantes sobre este documento"}],"analise_credito":{"classificacao_risco":"Baixo|Moderado|Alto|Critico","resumo_executivo":"...","capacidade_seguro_garantia":"Alta|Moderada|Baixa|Inapta","justificativa_garantia":"...","capacidade_fianca_locaticia":"Alta|Moderada|Baixa|Inapta","justificativa_fianca":"...","pontos_positivos":["..."],"pontos_atencao":["..."],"recomendacao_seguradora":"..."}}]}

NOTAS PARCIAIS:
${notesBlock}`;
  }

  if (flow === 'fianca-locaticia') {
    return `Voce vai consolidar notas parciais de uma analise de fianca locaticia. Os arquivos completos foram processados em lotes e as notas abaixo representam TODO o documento.

Arquivos analisados: ${fileNames.join(', ')}

Retorne APENAS o JSON final no formato:
{"tipo":"Fianca Locaticia","documentos_analisados":["nomes dos arquivos"],"dados_gerais":{"imovel":{"valor":"...","fonte":"..."},"locatario":{"valor":"...","fonte":"..."},"locador":{"valor":"...","fonte":"..."},"finalidade":{"valor":"...","fonte":"..."},"valor_aluguel":{"valor":0.00,"fonte":"..."},"encargos_mensais":{"valor":"...","fonte":"..."},"valor_garantia":{"valor":0.00,"fonte":"..."},"vigencia_inicio":{"valor":"...","fonte":"..."},"vigencia_fim":{"valor":"...","fonte":"..."},"indice_reajuste":{"valor":"...","fonte":"..."},"multa_rescisao":{"valor":"...","fonte":"..."},"sub_rogacao":{"valor":"...","fonte":"..."},"foro":{"valor":"...","fonte":"..."}},"clausulas_criticas":[{"titulo":"...","descricao":"...","fonte":"...","impacto":"Alto"}],"riscos":[{"descricao":"...","fonte":"...","nivel":"Alto"}],"parecer":{"recomendacao":"Emitir | Emitir com ressalvas | Declinar","justificativa":"...","condicoes":["..."]},"resumo":"..."}

NOTAS PARCIAIS:
${notesBlock}`;
  }

  return `Voce vai consolidar notas parciais de uma analise de seguro garantia. Os arquivos completos foram processados em lotes e as notas abaixo representam TODO o documento.

Arquivos analisados: ${fileNames.join(', ')}

Retorne uma analise tecnica detalhada em markdown, em portugues brasileiro, com as secoes:
- Partes e Dados Gerais
- Modalidades de Seguro Garantia Identificadas
- Clausulas Criticas
- Riscos Identificados
- Parecer Geral de Emissao
- Resumo Executivo

Sempre cite a fonte exata quando a nota parcial trouxer evidencia.

NOTAS PARCIAIS:
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

  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/${command.map(encodeURIComponent).join('/')}`, {
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redis error ${response.status}: ${text}`);
  }

  return response.json();
}
