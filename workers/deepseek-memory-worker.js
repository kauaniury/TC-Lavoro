const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const WORKER_VERSION = '2026-07-24.1';
const PRIMARY_DEEPSEEK_MODEL = 'deepseek-chat';
const FALLBACK_DEEPSEEK_MODEL = 'deepseek-chat';
const JOB_TTL_SECONDS = 60 * 60 * 6;
const CHUNK_NOTE_MAX_TOKENS = 4000;
const FINAL_RESULT_MAX_TOKENS_DEFAULT = 8000;
const FINAL_RESULT_MAX_TOKENS_SG = 10000;
const FINAL_RESULT_MAX_TOKENS_AF = 12000;

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
// Seguradoras que passam pelo endpoint compartilhado da Onpoint (dispatch em queryInsurer)
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
    const noteData = {
      index: chunkIndex,
      fileName: chunk.fileName,
      chunkLabel: chunk.chunkLabel,
      note,
    };
    await redisSet(env, noteKey(jobId, chunkIndex), noteData, JOB_TTL_SECONDS);
    manifest.chunkNotes.push({
      index: chunkIndex,
      fileName: chunk.fileName,
      chunkLabel: chunk.chunkLabel,
      noteKey: noteKey(jobId, chunkIndex),
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
  if (!['analise-financeira', 'seguro-garantia', 'fianca-locaticia', 'analise-apolice'].includes(body.flow)) {
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
  const chunkNotes = await loadChunkNotes(env, manifest);
  const prompt = buildFinalPrompt(manifest.flow, manifest.fileNames, chunkNotes);
  const maxTokens = manifest.flow === 'seguro-garantia'
    ? FINAL_RESULT_MAX_TOKENS_SG
    : manifest.flow === 'analise-financeira'
      ? FINAL_RESULT_MAX_TOKENS_AF
      : FINAL_RESULT_MAX_TOKENS_DEFAULT;
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

Voce e um analista financeiro especializado em credito, seguro garantia e fianca locaticia. Analise APENAS este trecho do documento.

ATENCAO ESCALA: Se o titulo/cabecalho indicar "em milhares", "R$ Mil", "Em R$ Mil" — registre escala "milhares". Os valores serao multiplicados por 1.000 na sintese final.

ATENCAO CONSISTENCIA: Para Balanco Patrimonial, verifique se Ativo Total = Passivo Total + Patrimonio Liquido. Se divergir, marque balanco_consistente = false.

CATEGORIAS DE BALANCETE: Se for balancete, agrupe contas em: caixa_e_equivalentes, clientes_a_receber, estoques, impostos_a_recuperar, imobilizado, fornecedores, emprestimos_e_financiamentos, obrigacoes_fiscais, obrigacoes_trabalhistas, capital_social, lucros_acumulados.

Retorne JSON compacto com evidencias NESTE TRECHO:
{"empresas":[{"empresa":"nome da empresa ou null","cnpj":"cnpj ou null","escala":"milhares|unidades|desconhecido","documentos":[{"tipo":"DRE|Balanco Patrimonial|Balancete|null","periodo":"ano ou periodo identificado ou null","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"resultado_operacional":null,"resultado_financeiro":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_bruta":null,"margem_operacional":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"ativo_nao_circulante":null,"passivo_total":null,"passivo_circulante":null,"passivo_nao_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_seca":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null,"caixa_e_equivalentes":null,"clientes_a_receber":null,"estoques":null,"fornecedores":null,"emprestimos_e_financiamentos":null,"obrigacoes_fiscais":null,"obrigacoes_trabalhistas":null},"balanco_consistente":null,"observacoes":"observacoes tecnicas incluindo escala e sinais identificados"}]}],"sinais_pista":["PL negativo","liquidez < 1","prejuizo","endividamento alto","crescimento receita","caixa relevante"],"alertas":["alerta especifico com valores"]}

Regras: valores numericos puros, null quando ausente. Retorne apenas JSON.`;
  }

  if (flow === 'fianca-locaticia') {
    return `${content}

Voce e um subscritor de FIANCA LOCATICIA. Analise APENAS este trecho do contrato de locacao.

Registre em "alertas_chunk" qualquer sinal de risco detectado: sub-rogacao ausente, prazo acima de 30 meses, finalidade comercial, valor de garantia suspeito, clausula que amplia exposicao da seguradora, multa rescisoria ausente.

Retorne um JSON compacto com fatos presentes NESTE TRECHO:
{"dados_gerais":{"imovel":null,"locatario":null,"locador":null,"finalidade":null,"valor_aluguel":null,"encargos_mensais":null,"valor_garantia":null,"vigencia_inicio":null,"vigencia_fim":null,"indice_reajuste":null,"multa_rescisao":null,"sub_rogacao":null,"foro":null},"clausulas_criticas":[{"titulo":"...","descricao":"transcricao fiel da clausula","fonte":"clausula X ou pagina Y","impacto":"Alto|Medio|Baixo"}],"alertas_chunk":["sub-rogacao ausente","prazo > 30 meses","finalidade comercial","garantia insuficiente"],"notas":["resumo tecnico do trecho"]}
Retorne apenas JSON.`;
  }

  if (flow === 'analise-apolice') {
    return `${content}

Voce e um especialista em leitura tecnica de APOLICES DE SEGURO. Analise APENAS este trecho.

Extraia o MAXIMO de informacao explicitamente presente neste trecho: seguradora emissora, numero da apolice, ramo/modalidade, tomador/locatario, segurado/locador, CNPJ/CPF de tomador e segurado, importancia segurada (IS), premio, vigencia, objeto da apolice, coberturas (com limite/IS de cada uma), clausulas/condicoes e riscos excluidos. Em "lacunas_pista" registre coberturas que geralmente existem neste tipo de apolice mas NAO aparecem neste trecho (possivel gap de cobertura). Use null para o que nao estiver presente NESTE trecho.

Formato:
{"dados_gerais":{"seguradora":null,"numero_apolice":null,"ramo":null,"tomador":null,"tomador_documento":null,"segurado":null,"segurado_documento":null,"importancia_segurada":null,"premio":null,"vigencia":null,"objeto_apolice":null},"coberturas":[{"descricao":"cobertura identificada","limite":null,"fonte":"pagina ou clausula"}],"clausulas":[{"titulo":null,"descricao":"clausula/condicao identificada","fonte":"pagina ou clausula"}],"riscos_excluidos":[{"descricao":"exclusao identificada","fonte":"pagina ou clausula"}],"lacunas_pista":["cobertura tipica ausente neste trecho"],"notas":["resumo tecnico do trecho"]}
Retorne apenas JSON.`;
  }

  return `${content}

Voce e um especialista em SEGURO GARANTIA. Analise APENAS este trecho do documento e extraia evidencias para a analise completa.

IDENTIFIQUE TODAS AS MODALIDADES presentes — mesmo sem palavra-chave exata, infira pelo contexto:
- Garantia de Proposta/Licitacao: exigida para participar da licitacao, antes do contrato
- Garantia de Execucao/Fiel Cumprimento: exigida apos assinatura do contrato
- Garantia de Adiantamento de Pagamento
- Garantia de Retencao de Pagamento
- Garantia de Manutencao Corretiva / Perfeito Funcionamento
- Garantia Trabalhista e/ou Previdenciaria
- Outras modalidades especificas

PALAVRAS-CHAVE para buscar: "garantia de proposta", "garantia da proposta", "garantia contratual", "garantia de execucao", "fiel cumprimento", "seguro-garantia", "caucao", "fianca bancaria", "valor estimado", "valor global", "valor do contrato", "valor homologado", "valor adjudicado", "valor arrematado", "valor anual", "prazo de vigencia", "prazo de execucao", "assinatura do contrato", "ordem de servico", "vigencia da contratacao", "90 dias", "multas", "trabalhista", "previdenciaria", "clausula de retomada", "85%", "valor orcado pela Administracao".

Retorne JSON compacto com evidencias NESTE TRECHO:
{"tomador":{"nome":null,"cnpj":null},"segurado":{"nome":null,"cnpj":null,"endereco":null},"dados_licitacao":{"numero_edital":null,"numero_processo":null,"modalidade_licitacao":null,"numero_contrato":null,"numero_ata":null,"objeto":null},"valores":{"estimado":null,"orcado_administracao":null,"contrato":null,"adjudicado":null,"homologado":null,"arrematado":null,"anual":null,"mensal":null},"data_assinatura":null,"modalidades_encontradas":[{"nome":"nome da modalidade","percentual_exigido":null,"valor_is":null,"base_calculo_descricao":null,"vigencia_regra":null,"vigencia_ini":null,"vigencia_fim":null,"acrescimo_90_dias":false,"objeto_pista":null,"clausulas_pista":["clausula especifica"]}],"coberturas_exigidas":{"multas":false,"trabalhista":false,"fiscal":false,"retomada":false,"adiantamento":false,"retencao":false,"manutencao":false,"outras":[]},"apresentacao":{"prazo":null,"momento":null,"forma":null,"arquivo_pdf":false},"alertas":["alerta detectado"],"notas":["resumo tecnico do trecho"]}
Retorne apenas JSON.`;
}

async function loadChunkNotes(env, manifest) {
  const refs = Array.isArray(manifest.chunkNotes) ? manifest.chunkNotes : [];
  const notes = [];

  for (const ref of refs) {
    if (!ref || !ref.index) continue;

    if (ref && ref.note) {
      notes.push(ref);
      continue;
    }

    const key = ref.noteKey || noteKey(manifest.jobId, ref.index);
    const stored = await redisGet(env, key);
    if (stored) notes.push(stored);
  }

  return notes.sort((a, b) => (a.index || 0) - (b.index || 0));
}

function buildFinalPrompt(flow, fileNames, chunkNotes) {
  const notesBlock = chunkNotes
    .map(note => `### ${note.fileName} / ${note.chunkLabel}\n${note.note}`)
    .join('\n\n');

  if (flow === 'analise-financeira') {
    return `Voce e um analista financeiro senior especializado em credito empresarial, seguro garantia e fianca locaticia para seguradoras brasileiras. Consolide as notas parciais abaixo em uma analise financeira completa.

Arquivos analisados: ${fileNames.join(', ')}

REGRAS CRITICAS:
1. Nao misture empresas diferentes. Crie uma entrada separada por empresa com CNPJ diferente ou nome diferente.
2. Nao consolide periodos diferentes. Cada periodo e um objeto separado em "documentos".
3. Se notas indicam escala "milhares", multiplique TODOS os valores monetarios por 1.000 e registre em "observacoes" e "observacao_escala".
4. Use null para campos ausentes. Nunca estime valores.
5. Se houver multiplos periodos, compare a tendencia de receita, lucro e PL em "analise_qualitativa.resultado".
6. Verifique consistencia do Balanco: Ativo Total = Passivo Total + PL. Se divergir, registre em "inconsistencias_ou_limitacoes".

CLASSIFICACAO FINANCEIRA — use criterios objetivos:
- BOA: lucro positivo, PL positivo, liquidez corrente > 1.2, endividamento < 50%, capital de giro positivo
- REGULAR: lucro baixo ou instavel, liquidez 0.8-1.2, endividamento 50-70%, alguns alertas sem sinal critico
- FRACA: prejuizo, liquidez < 0.8, capital de giro negativo, endividamento > 70%
- CRITICA: PL negativo, prejuizo relevante, passivo circulante >> ativo circulante, risco de insolvencia
- INCONCLUSIVA: documentos incompletos, sem DRE, sem balanco, dados contraditórios

NIVEL DE RISCO para analise_credito.classificacao_risco:
- Baixo: PL solido positivo, liquidez > 1.5, endividamento < 40%, lucro consistente
- Moderado: PL positivo, liquidez 1.0-1.5, endividamento 40-60%, resultado variavel
- Alto: PL reduzido ou queda acentuada, liquidez < 1.0, endividamento > 60%, prejuizo recente
- Critico: PL negativo (insolvencia tecnica), multiplos prejuizos, liquidez critica

PARA INDICADORES CALCULADOS — calcule quando possivel:
- liquidez_corrente = Ativo Circulante / Passivo Circulante (use o periodo mais recente)
- liquidez_seca = (Ativo Circulante - Estoques) / Passivo Circulante
- capital_de_giro_liquido = Ativo Circulante - Passivo Circulante
- endividamento_geral = Passivo Total / Ativo Total (como decimal, ex: 0.65 para 65%)
- divida_sobre_pl = Passivo Total / Patrimonio Liquido
- composicao_endividamento = Passivo Circulante / Passivo Total
- margem_bruta = Lucro Bruto / Receita Liquida (como decimal)
- margem_operacional = Resultado Operacional / Receita Liquida (como decimal)
- margem_liquida = Lucro Liquido / Receita Liquida (como decimal)
- roe = Lucro Liquido / Patrimonio Liquido (como decimal)
- roa = Lucro Liquido / Ativo Total (como decimal)

PARA analise_credito.justificativa_garantia: mencione o valor exato do PL e o limite sugerido de SG (ate 15% do PL). Ex: "PL de R$ 5.000.000 permite SG ate R$ 750.000."
PARA analise_credito.recomendacao_seguradora: inclua limite SG (PL x 0.15) e indicacao de FL. Se houver multiplos periodos, mencione tendencia.

Retorne APENAS o JSON:
{"empresas":[{"empresa":"Nome exato da empresa","cnpj":"XX.XXX.XXX/XXXX-XX ou null","periodo_analisado":"ex: 2022-2024 ou jan/2024","moeda":"BRL","observacao_escala":"Valores originais em milhares — multiplicados por 1.000 ou Valores em reais","demonstrativos_identificados":{"balanco_patrimonial":false,"dre":false,"balancete":false,"outros":[]},"documentos":[{"tipo":"DRE|Balanco Patrimonial|Balancete","periodo":"periodo identificado","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"resultado_operacional":null,"resultado_financeiro":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_bruta":null,"margem_operacional":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"ativo_nao_circulante":null,"passivo_total":null,"passivo_circulante":null,"passivo_nao_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_seca":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null,"caixa_e_equivalentes":null,"clientes_a_receber":null,"estoques":null,"fornecedores":null,"emprestimos_e_financiamentos":null,"obrigacoes_fiscais":null,"obrigacoes_trabalhistas":null},"observacoes":"observacoes tecnicas incluindo ajuste de escala"}],"principais_numeros":{"ativo_total":null,"ativo_circulante":null,"passivo_total":null,"passivo_circulante":null,"patrimonio_liquido":null,"receita_bruta":null,"receita_liquida":null,"lucro_liquido":null,"caixa_e_equivalentes":null,"clientes_a_receber":null,"estoques":null,"fornecedores":null,"emprestimos_e_financiamentos":null,"obrigacoes_fiscais":null,"obrigacoes_trabalhistas":null},"indicadores_calculados":{"liquidez_corrente":{"valor":null,"interpretacao":""},"liquidez_seca":{"valor":null,"interpretacao":""},"capital_de_giro_liquido":{"valor":null,"interpretacao":""},"endividamento_geral":{"valor":null,"interpretacao":""},"divida_sobre_pl":{"valor":null,"interpretacao":""},"composicao_endividamento":{"valor":null,"interpretacao":""},"margem_bruta":{"valor":null,"interpretacao":""},"margem_operacional":{"valor":null,"interpretacao":""},"margem_liquida":{"valor":null,"interpretacao":""},"roe":{"valor":null,"interpretacao":""},"roa":{"valor":null,"interpretacao":""}},"analise_qualitativa":{"liquidez":"","endividamento":"","rentabilidade":"","patrimonio_liquido":"","resultado":"","capital_de_giro":"","capacidade_financeira":"","consistencia_contabil":""},"sinais_positivos":["sinal positivo concreto com valores"],"sinais_negativos":["sinal negativo concreto com valores"],"alertas_de_risco":["alerta especifico com valores e impacto"],"inconsistencias_ou_limitacoes":["inconsistencia detectada ou limitacao dos dados"],"documentos_adicionais_recomendados":["documento especifico recomendado"],"classificacao_financeira":{"situacao":"BOA|REGULAR|FRACA|CRITICA|INCONCLUSIVA","nivel_risco":"BAIXO|MODERADO|ALTO|CRITICO|INCONCLUSIVO","justificativa":"justificativa com valores concretos"},"analise_credito":{"classificacao_risco":"Baixo|Moderado|Alto|Critico","resumo_executivo":"analise objetiva em 3-4 frases com valores concretos","capacidade_seguro_garantia":"Alta|Moderada|Baixa|Inapta","justificativa_garantia":"justificativa com PL e limite sugerido","capacidade_fianca_locaticia":"Alta|Moderada|Baixa|Inapta","justificativa_fianca":"justificativa com liquidez e endividamento","pontos_positivos":["ponto positivo com valores"],"pontos_atencao":["ponto de atencao com valores"],"recomendacao_seguradora":"recomendacao com limites sugeridos para SG e FL"},"visao_para_seguro_garantia":{"capacidade_para_assumir_contratos":"boa|moderada|limitada|risco elevado|necessita analise manual","pontos_de_atencao_para_subscricao":["ponto especifico"],"recomendacao_operacional":"conclusao para o analista/corretor"},"conclusao_final":{"empresa_tem_bons_numeros":null,"empresa_tem_numeros_ruins":null,"resumo_da_conclusao":"conclusao operacional para uso interno em 2-4 frases","nivel_confianca_da_analise":"ALTO|MEDIO|BAIXO"}}]}

Regras: monetarios como numero puro em reais (ex: 1500000.50), percentuais/indices como decimal (ex: 25.5 para 25,5%), null quando ausente.

NOTAS PARCIAIS:
${notesBlock}`;
  }

  if (flow === 'fianca-locaticia') {
    return `Voce e um subscritor senior de FIANCA LOCATICIA. Consolide as notas parciais abaixo em uma analise completa do contrato de locacao para emissao de apolice.

Arquivos analisados: ${fileNames.join(', ')}

REGRAS DE SUBSCRICAO — aplique automaticamente ao gerar "riscos[]":
1. Se sub_rogacao = "Nao" ou "Nao mencionado": adicione risco nivel Alto "Ausencia de clausula de sub-rogacao expoe a seguradora a perdas sem direito de regresso".
2. Se valor_garantia numericamente menor que (3 x valor_aluguel): adicione risco nivel Alto "Valor de garantia inferior a 3 alugueis mensais — cobertura possivelmente insuficiente".
3. Se finalidade = "Comercial" ou "Misto": adicione risco nivel Medio "Imovel de uso comercial — risco de inadimplencia tipicamente maior que residencial".
4. Se prazo de vigencia superar 30 meses: adicione risco nivel Medio "Contrato de longa duracao exige acompanhamento periodico da capacidade do locatario".
5. Se multa_rescisao = null: adicione risco nivel Medio "Multa rescisoria nao localizada — verifique exposicao em caso de rescisao antecipada".
6. Se alertas_chunk apareceram nas notas, consolide-os em riscos[] com nivel apropriado.

Para "parecer": seja especifico na justificativa mencionando o valor do aluguel, valor da garantia e os principais riscos identificados.
Para "objeto_apolice": redigir texto completo e preciso para constar na apolice (imovel, locatario, periodo de vigencia, valor garantido).

Retorne APENAS o JSON:
{"tipo":"Fianca Locaticia","documentos_analisados":["nomes dos arquivos"],"dados_gerais":{"imovel":{"valor":"endereco completo ou null","fonte":"..."},"locatario":{"valor":"nome completo ou null","fonte":"..."},"locador":{"valor":"nome completo ou null","fonte":"..."},"finalidade":{"valor":"Residencial|Comercial|Misto ou null","fonte":"..."},"valor_aluguel":{"valor":0.00,"fonte":"..."},"encargos_mensais":{"valor":"descricao dos encargos ou null","fonte":"..."},"valor_garantia":{"valor":0.00,"fonte":"..."},"vigencia_inicio":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"vigencia_fim":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"indice_reajuste":{"valor":"IGPM|IPCA|outro ou null","fonte":"..."},"multa_rescisao":{"valor":"formula ou valor da multa ou null","fonte":"..."},"sub_rogacao":{"valor":"Sim|Nao|Nao mencionado","fonte":"..."},"foro":{"valor":"foro de eleicao ou null","fonte":"..."}},"objeto_apolice":{"valor":"texto completo do objeto para a apolice ou null","fonte":"..."},"clausulas_necessarias":[{"descricao":"clausula que deve constar na apolice","fonte":"localizacao no documento"}],"clausulas_criticas":[{"titulo":"titulo da clausula","descricao":"transcricao ou resumo fiel","fonte":"localizacao","impacto":"Alto|Medio|Baixo"}],"riscos":[{"descricao":"descricao objetiva do risco incluindo alertas de subscricao","fonte":"localizacao ou 'Regra de subscricao'","nivel":"Alto|Medio|Baixo"}],"parecer":{"recomendacao":"Emitir|Emitir com ressalvas|Declinar","justificativa":"justificativa especifica com valores e riscos identificados","condicoes":["condicao especifica para emissao"]},"resumo":"resumo executivo de 3-4 frases com os dados essenciais do contrato"}

NOTAS PARCIAIS:
${notesBlock}`;
  }

  if (flow === 'analise-apolice') {
    return `Voce e um especialista em leitura tecnica de APOLICES DE SEGURO para corretoras. Consolide as notas parciais abaixo em uma analise objetiva e completa da apolice, trazendo o MAXIMO de informacao possivel.

Arquivos analisados: ${fileNames.join(', ')}

INSTRUCOES:
1. Extraia somente dados presentes explicitamente nos documentos: seguradora emissora, numero da apolice, ramo/modalidade, tomador/locatario, segurado/locador, CNPJ/CPF de tomador e segurado, IS, premio, vigencia, objeto, coberturas (com limite/IS de cada), clausulas/condicoes e riscos excluidos.
2. O tomador/locatario pode nao existir em alguns tipos de apolice — nesse caso use valor null. O segurado/locador quase sempre existe.
3. Em "coberturas": liste TODAS as coberturas contratadas; para cada uma preencha o campo "limite" com o limite/IS especifico quando o documento informar.
4. Em "clausulas": liste clausulas particulares, especiais, condicoes especificas, franquias e condicoes de indenizacao relevantes.
5. Para "riscos_excluidos": inclua tanto as exclusoes explicitas quanto coberturas tipicamente presentes neste tipo de apolice que NAO foram encontradas (lacunas de cobertura) — identifique como "Cobertura nao localizada: [nome]" para que o corretor possa verificar.
6. Se lacunas_pista foram registradas nas notas de chunk, inclua-as em riscos_excluidos.
7. Use null para campos nao localizados. Nao estime valores. Monetarios como numero puro em reais (ex: 150000.50).

Retorne APENAS o JSON:
{"tipo":"Analise de Apolice","documentos_analisados":["nomes dos arquivos"],"dados_gerais":{"seguradora":{"valor":"nome da seguradora ou null","fonte":"..."},"numero_apolice":{"valor":"numero da apolice ou null","fonte":"..."},"ramo":{"valor":"ramo/modalidade ou null","fonte":"..."},"tomador":{"valor":"nome do tomador/locatario ou null","fonte":"..."},"tomador_documento":{"valor":"CNPJ/CPF ou null","fonte":"..."},"segurado":{"valor":"nome do segurado/locador ou null","fonte":"..."},"segurado_documento":{"valor":"CNPJ/CPF ou null","fonte":"..."},"importancia_segurada":{"valor":0.00,"fonte":"..."},"premio":{"valor":0.00,"fonte":"..."},"vigencia":{"valor":"inicio e fim da vigencia ou null","fonte":"..."},"objeto_apolice":{"valor":"objeto da apolice ou null","fonte":"..."}},"coberturas":[{"descricao":"cobertura contratada identificada","limite":"limite/IS da cobertura ou null","fonte":"pagina ou clausula"}],"clausulas":[{"titulo":"titulo da clausula ou null","descricao":"resumo fiel da clausula/condicao","fonte":"pagina ou clausula"}],"riscos_excluidos":[{"descricao":"exclusao explicita ou gap de cobertura identificado","fonte":"pagina, clausula ou 'Cobertura nao localizada'"}]}

NOTAS PARCIAIS:
${notesBlock}`;
  }

  return `Voce e um especialista em SEGURO GARANTIA no Brasil, com foco em analise de editais, contratos administrativos, atas, termos de adjudicacao/homologacao, propostas, aditivos e minutas de apolice. Sua funcao e retornar uma analise tecnica, objetiva e operacional para cotacao/emissao de seguro garantia.

Arquivos analisados: ${fileNames.join(', ')}

REGRAS CRITICAS:
1. Nao invente informacoes. Se nao encontrado, use null.
2. Identifique TODAS as modalidades presentes — mesmo sem palavra-chave exata, infira pelo contexto. Diferencie:
   - Garantia de Proposta/Licitacao (exigida ANTES da assinatura do contrato, para participar da licitacao)
   - Garantia de Execucao/Fiel Cumprimento (exigida APOS assinatura do contrato)
   - Garantia de Adiantamento de Pagamento
   - Garantia de Retencao de Pagamento
   - Garantia de Manutencao Corretiva
   - Garantia Trabalhista/Previdenciaria
   - Outras modalidades especificas
3. Para garantia de proposta: a base e geralmente o valor estimado. IS = valor_estimado * percentual_exigido.
4. Para garantia de execucao: a base e geralmente o valor do contrato/adjudicado/homologado. IS = valor_base * percentual_exigido.
5. Se o contrato diz "vigencia a partir da assinatura", procure a data de assinatura e calcule. Se nao encontrar, deixe vigencia_obs com a regra e vigencia_inicio/fim como null.
6. Se houver clausula de acrescimo de 90 dias na apolice, aplique e marque exige_acrescimo_90_dias = true.
7. Hierarquia de documentos: contrato assinado > aditivo > ata de registro/homologacao > edital > minuta contratual > proposta > demais.
8. Calcule garantia adicional se proposta < 85% do valor orcado pela Administracao: garantia_adicional = (valor_orcado * 0.85) - valor_proposta.


REGRAS DE CONCLUSAO:
- pode_cotar: true quando ha informacoes suficientes para gerar cotacao preliminar.
- pode_emitir: true SOMENTE quando ha dados suficientes para emissao segura (contrato assinado, valor base, percentual, vigencia).
- nivel_confianca: ALTA (dados expressos no documento), MEDIA (parcial, com inferencia controlada), BAIXA (faltam dados essenciais).

Retorne APENAS o JSON (sem markdown, sem texto antes ou depois):
{"tipo":"Seguro Garantia","documentos_analisados":["nomes dos arquivos"],"resumo_executivo":"resumo operacional em 3-5 frases com os dados essenciais para cotacao/emissao","tipo_documento_analisado":"edital|contrato|ata|proposta|aditivo|minuta|misto","tomador":{"valor":"nome exato como deve constar na apolice ou null","cnpj":"XX.XXX.XXX/XXXX-XX ou null","fonte":"..."},"segurado":{"valor":"nome exato do beneficiario como deve constar na apolice ou null","cnpj":"XX.XXX.XXX/XXXX-XX ou null","endereco":"endereco ou null","fonte":"..."},"dados_licitacao_contrato":{"numero_edital":null,"numero_processo":null,"modalidade_licitacao":null,"numero_contrato":null,"numero_ata":null,"objeto":"resumo fiel do objeto ou null"},"modalidades":[{"nome":"nome da modalidade","importancia_segurada":{"valor":0.00,"fonte":"clausula ou item exato"},"base_calculo":{"valor":"descricao: ex: 5% do valor contratual de R$ X = R$ Y","fonte":"..."},"vigencia_inicio":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"vigencia_fim":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"vigencia_obs":{"valor":"descricao do prazo quando nao houver datas fixas ou null","fonte":"..."},"exige_acrescimo_90_dias":false,"objeto_apolice":{"valor":"texto completo para o campo Objeto da apolice mencionando edital/contrato e orgao ou null","fonte":"..."},"clausulas_necessarias":[{"descricao":"clausula especifica exigida na apolice","fonte":"item e pagina do documento"}]}],"coberturas_clausulas_exigidas":{"multas":false,"trabalhista_previdenciaria":false,"fiscal":false,"clausula_retomada":false,"adiantamento_pagamento":false,"retencao_pagamento":false,"manutencao_corretiva":false,"outras":[]},"prazo_e_forma_de_apresentacao":{"prazo":null,"momento":null,"forma_envio":null,"arquivo_unico_pdf":false},"trechos_relevantes":[{"tema":"tema do trecho","trecho":"transcricao do trecho relevante","pagina_ou_localizacao":"pag. X ou secao Y"}],"pendencias_para_emissao":["informacao faltante critica"],"perguntas_para_cliente_ou_comercial":["pergunta especifica para o cliente ou comercial"],"alertas_de_risco":["alerta tecnico de subscricao"],"conclusao_operacional":{"pode_cotar":false,"pode_emitir":false,"motivo":"justificativa da conclusao","nivel_confianca":"ALTA|MEDIA|BAIXA"},"parecer":{"recomendacao":"Emitir|Emitir com ressalvas|Declinar","justificativa":"justificativa tecnica especifica com valor de IS, percentual e prazo","pendencias":["pendencia critica para emissao"]}}

Regras: valores monetarios como numero puro em reais (ex: 85430.00), null quando nao encontrado.

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

  // Fila sequencial: uma seguradora por vez (nunca em paralelo).
  // Evita sobrecarregar integracoes como a Onpoint, que agrupa varias
  // seguradoras (essor/sombrero/newe/mitsui/axa) no mesmo endpoint e
  // rejeita chamadas concorrentes para o mesmo CNPJ.
  for (const key of requested) {
    resultados.push(await queryInsurer(env, cnpj, key));
  }

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

// -- Timeout / erro robusto (compartilhado por todas as integracoes de limites) --
// Toda chamada externa usa timeout — ao abortar, a mensagem contem "tempo limite" para
// o front-end classificar como aviso "Sem resposta", nunca como erro tecnico vermelho.
const LIMITS_FETCH_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, options = {}, timeoutMs = LIMITS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Requisicao excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Payload de erro pode vir em formatos heterogeneos (ASP.NET Core, texto puro, arrays) —
// tenta extrair a mensagem mais especifica possivel antes de recorrer ao fallback generico.
async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { rawText: text }; }
}

function extractErrorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (Array.isArray(payload) && payload[0] && payload[0].message) return payload[0].message;
  if (payload.message) return payload.message;
  if (payload.nm_retorno) return payload.nm_retorno;
  if (Array.isArray(payload.Errors) && payload.Errors.length) return payload.Errors.join(' ');
  if (payload.errors && typeof payload.errors === 'object') {
    const msgs = Object.entries(payload.errors)
      .flatMap(([field, m]) => Array.isArray(m) ? m.map(x => `${field}: ${x}`) : []);
    if (msgs.length) return msgs.join(' | ');
  }
  if (payload.title) return payload.title;
  if (payload.rawText) return payload.rawText.slice(0, 300);
  return fallback;
}

// -- JNS Seguros --

async function getJnsToken(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await redisGet(env, 'limits:token:jns');
    if (cached && cached.token) return cached.token;
  }

  const res = await fetchWithTimeout(`${JNS_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-cache' },
    body: JSON.stringify({
      username: env.JNS_USERNAME,
      password: env.JNS_PASSWORD,
      token: env.JNS_TOKEN,
    }),
  });
  if (!res.ok) throw new Error(extractErrorMessage(await parseJsonSafe(res), `JNS login error ${res.status}`));

  const data = await res.json();
  const token = data.token || data.access_token || (data.data && data.data.token);
  if (!token) throw new Error('JNS: token nao encontrado na resposta de login.');

  await redisSet(env, 'limits:token:jns', { token }, LIMITS_TOKEN_TTL_SECONDS);
  return token;
}

async function queryJns(env, cnpj) {
  let token = await getJnsToken(env);
  let res = await fetchWithTimeout(`${JNS_BASE}/issuer?document=${cnpj}`, {
    headers: { Authorization: `Bearer ${token}`, 'cache-control': 'no-cache' },
  });

  if (res.status === 401) {
    token = await getJnsToken(env, true);
    res = await fetchWithTimeout(`${JNS_BASE}/issuer?document=${cnpj}`, {
      headers: { Authorization: `Bearer ${token}`, 'cache-control': 'no-cache' },
    });
  }

  if (!res.ok) throw new Error(extractErrorMessage(await parseJsonSafe(res), `JNS issuer error ${res.status}`));
  return res.json();
}

// -- Junto Seguros --

async function getJuntoToken(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await redisGet(env, 'limits:token:junto');
    if (cached && cached.token) return cached.token;
  }

  const res = await fetchWithTimeout(`${JUNTO_BASE}/authentication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json-patch+json', Accept: '*/*' },
    body: JSON.stringify({
      clientId: env.JUNTO_CLIENT_ID,
      clientSecret: env.JUNTO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(extractErrorMessage(await parseJsonSafe(res), `Junto auth error ${res.status}`));

  const data = await res.json();
  const token = data.accessToken;
  if (!token) throw new Error('Junto: accessToken nao encontrado na resposta de autenticacao.');
  const expiresIn = Number(data.expiresIn) || 300;

  await redisSet(env, 'limits:token:junto', { token }, Math.max(60, expiresIn - 30));
  return token;
}

// Falha em POST /policyholders pode ser benigna: tomador ja nomeado com outro corretor
// (precisa das duas partes juntas — so "corretor" sozinho tambem aparece em mensagens de
// bloqueio nao relacionadas) ou tomador ja cadastrado (duplicate). Qualquer outra falha
// de cadastro e erro tecnico real e deve interromper a consulta.
function isBenignPolicyholderCreateError(message) {
  const t = String(message || '').toLowerCase();
  const nomeadoComOutroCorretor = t.includes('nomead') && (t.includes('corretor') || t.includes('broker'));
  const jaCadastrado = t.includes('duplicate') || t.includes('ja cadastrado') || t.includes('já cadastrado');
  return nomeadoComOutroCorretor || jaCadastrado;
}

// Fluxo completo: autentica, confirma cadastro + modalidades habilitadas e, para cada uma,
// busca a taxa/limite real via /modalities/{id}/rates (a consulta de modalidades sozinha
// so confirma habilitacao, sem valor — ver SPEC.md secao 10.1a).
async function queryJunto(env, cnpj) {
  let token = await getJuntoToken(env);
  const authHeaders = () => ({ Authorization: `Bearer ${token}`, Accept: '*/*' });

  const fetchAuthorized = async (path, options = {}) => {
    let res = await fetchWithTimeout(`${JUNTO_BASE}${path}`, {
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) },
    });
    if (res.status === 401) {
      token = await getJuntoToken(env, true);
      res = await fetchWithTimeout(`${JUNTO_BASE}${path}`, {
        ...options,
        headers: { ...authHeaders(), ...(options.headers || {}) },
      });
    }
    return res;
  };

  let policyholderRes = await fetchAuthorized(`/policyholders/${cnpj}`);
  let modalitiesRes = await fetchAuthorized(`/policyholders/${cnpj}/modalities`);

  if (!policyholderRes.ok || !modalitiesRes.ok) {
    // Tomador ainda nao cadastrado na Junto — cadastra e aguarda propagacao assincrona
    // (9000ms e o valor empirico documentado para esse fluxo) antes de repetir a consulta.
    const createRes = await fetchAuthorized(`/policyholders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ federalId: cnpj }),
    });
    if (!createRes.ok) {
      const msg = extractErrorMessage(await parseJsonSafe(createRes), `Junto policyholders error ${createRes.status}`);
      if (!isBenignPolicyholderCreateError(msg)) throw new Error(msg);
    }
    await sleep(9000);
    policyholderRes = await fetchAuthorized(`/policyholders/${cnpj}`);
    modalitiesRes = await fetchAuthorized(`/policyholders/${cnpj}/modalities`);
    if (!policyholderRes.ok && !modalitiesRes.ok) {
      throw new Error('Junto: tomador nao pode ser consultado apos o cadastro (falha tecnica).');
    }
  }

  if (!modalitiesRes.ok) {
    throw new Error(extractErrorMessage(await parseJsonSafe(modalitiesRes), `Junto modalities error ${modalitiesRes.status}`));
  }

  const modalidades = await modalitiesRes.json();
  const lista = Array.isArray(modalidades) ? modalidades : [];

  // Para cada submodalidade habilitada, busca a taxa/limite real. Uma falha pontual nao
  // deve derrubar a consulta inteira — a submodalidade fica sem valor (front-end oculta).
  const comTaxas = await Promise.all(lista.map(async mod => {
    const subs = Array.isArray(mod.submodalities) && mod.submodalities.length ? mod.submodalities : [{}];
    const subsComTaxa = await Promise.all(subs.map(async sub => {
      const rateId = sub.id ?? mod.id;
      if (rateId === undefined || rateId === null) return { ...sub };
      try {
        const ratesRes = await fetchAuthorized(`/policyholders/${cnpj}/modalities/${rateId}/rates`);
        if (!ratesRes.ok) return { ...sub };
        const rates = await ratesRes.json();
        const first = Array.isArray(rates) ? rates[0] : rates;
        if (!first) return { ...sub };
        return { ...sub, limitAvailable: first.limitAvailable, rate: first.rate };
      } catch {
        return { ...sub };
      }
    }));
    return { ...mod, submodalities: subsComTaxa };
  }));

  return comTaxas;
}

// -- Onpoint (Essor / Sombrero / NEWE / Mitsui) e AXA --

const ONPOINT_IN_PROGRESS_RETRY_MS = 1500;
const ONPOINT_IN_PROGRESS_MAX_ATTEMPTS = 3;

function isOnpointInProgressMessage(message) {
  return /andamento|already.*progress/i.test(String(message || ''));
}

// A Onpoint pode devolver { Errors: [...] } (sem Response) tanto para erros de negocio
// ("bloqueado", "sem alcada") quanto para o erro tecnico "consulta em andamento" — apenas
// o segundo caso recebe retry automatico; qualquer outro Errors[] segue para o front-end
// normalizar como aviso de negocio (nunca como erro tecnico).
async function queryOnpoint(env, cnpj, key, attempt = 1) {
  const insurer = ONPOINT_INSURERS[key];
  if (!insurer) throw new Error(`Seguradora Onpoint desconhecida: ${key}`);

  const base = insurer.axaRoute ? ONPOINT_AXA_BASE : ONPOINT_BASE;
  const res = await fetchWithTimeout(`${base}/GetPolicyHolderLimitsAndRates`, {
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
  }, 25000);

  const payload = await parseJsonSafe(res);
  if (!res.ok) throw new Error(extractErrorMessage(payload, `Onpoint (${insurer.name}) error ${res.status}`));

  const unwrapped = Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
  const errors = unwrapped && Array.isArray(unwrapped.Errors) ? unwrapped.Errors : [];
  const inProgressMsg = errors.find(isOnpointInProgressMessage);
  if (inProgressMsg && attempt < ONPOINT_IN_PROGRESS_MAX_ATTEMPTS) {
    await sleep(ONPOINT_IN_PROGRESS_RETRY_MS * attempt);
    return queryOnpoint(env, cnpj, key, attempt + 1);
  }

  return unwrapped;
}

// -- Fator Seguradora --

async function getFatorToken(env, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = await redisGet(env, 'limits:token:fator');
    if (cached && cached.token) return cached.token;
  }

  const basic = btoa(`${env.FATOR_CLIENT_ID}:${env.FATOR_CLIENT_SECRET}`);
  const res = await fetchWithTimeout(FATOR_AUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(extractErrorMessage(await parseJsonSafe(res), `Fator auth error ${res.status}`));

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

  let res = await fetchWithTimeout(buildUrl(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });

  if (res.status === 401) {
    token = await getFatorToken(env, true);
    res = await fetchWithTimeout(buildUrl(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  }

  // cd_retorno !== 0 e sempre resposta de negocio (sem limite, nomeado etc.), mesmo com
  // HTTP 200 — nunca deve ser tratado como erro tecnico. So HTTP nao-2xx e falha real.
  if (!res.ok) throw new Error(extractErrorMessage(await parseJsonSafe(res), `Fator consulta error ${res.status}`));
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
