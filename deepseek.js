const DEEPSEEK_WORKER_URL = 'https://lucky-hat-b241.kyuri887.workers.dev/';
const DEEPSEEK_JOBS_URL = DEEPSEEK_WORKER_URL.replace(/\/+$/, '') + '/v1/analysis-jobs';
const MAX_PDF_PAGES = 250;
const TEXT_CHUNK_SIZE = 12000;
const MAX_JOB_ITERATIONS = 400;

function parseDeepSeekContent(data) {
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  let raw = msg && msg.content ? String(msg.content).trim() : '';
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  raw = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!raw) throw new Error('Resposta vazia da API. Tente novamente.');
  return raw;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function quebrarTextoEmPartes(texto, maxChars, metaBase = {}) {
  const clean = String(texto || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const partes = [];
  let offset = 0;
  let indice = 1;

  while (offset < clean.length) {
    let end = Math.min(offset + maxChars, clean.length);
    if (end < clean.length) {
      const lastBreak = Math.max(
        clean.lastIndexOf('\n\n', end),
        clean.lastIndexOf('\n', end),
        clean.lastIndexOf('. ', end),
        clean.lastIndexOf('; ', end),
        clean.lastIndexOf(' ', end)
      );
      if (lastBreak > offset + Math.floor(maxChars * 0.6)) end = lastBreak + 1;
    }

    const conteudo = clean.slice(offset, end).trim();
    if (conteudo) {
      partes.push({
        indice,
        conteudo,
        ...metaBase,
      });
      indice += 1;
    }
    offset = end;
  }

  return partes;
}

async function extrairConteudoArquivo(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['xlsx', 'xls'].includes(ext)) return extrairExcel(file);
  if (ext === 'csv' || ext === 'txt') return extrairTexto(file);
  if (ext === 'pdf') return extrairPDF(file);
  if (['png', 'jpg', 'jpeg'].includes(ext)) return extrairImagem(file);
  return { tipo: 'texto', conteudo: '', partes: [] };
}

function extrairExcel(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        let textoCompleto = '';
        const partes = [];

        wb.SheetNames.forEach(nome => {
          const ws = wb.Sheets[nome];
          const csv = XLSX.utils.sheet_to_csv(ws);
          textoCompleto += `[Aba: ${nome}]\n${csv}\n\n`;
          const chunks = quebrarTextoEmPartes(csv, TEXT_CHUNK_SIZE, { origem: `Aba ${nome}` });
          chunks.forEach((chunk, idx) => {
            partes.push({
              indice: partes.length + 1,
              rotulo: `${nome} - parte ${idx + 1}`,
              conteudo: `[Aba: ${nome}]\n${chunk.conteudo}`,
            });
          });
        });

        resolve({
          tipo: 'texto',
          conteudo: textoCompleto.trim(),
          partes,
          meta: { origem: 'excel', totalPartes: partes.length },
        });
      } catch (err) {
        resolve({ tipo: 'texto', conteudo: '[Erro ao ler Excel: ' + err.message + ']', partes: [] });
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function extrairTexto(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const texto = String(e.target.result || '');
      const partes = quebrarTextoEmPartes(texto, TEXT_CHUNK_SIZE).map((chunk, idx) => ({
        indice: idx + 1,
        rotulo: `Parte ${idx + 1}`,
        conteudo: chunk.conteudo,
      }));
      resolve({
        tipo: 'texto',
        conteudo: texto,
        partes,
        meta: { origem: 'texto', totalPartes: partes.length },
      });
    };
    reader.readAsText(file, 'UTF-8');
  });
}

async function extrairPDF(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPaginas = Math.min(pdf.numPages, MAX_PDF_PAGES);
    let textoCompleto = '';
    const partes = [];

    for (let i = 1; i <= totalPaginas; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
      if (!pageText) continue;

      textoCompleto += `[Pagina ${i}]\n${pageText}\n\n`;
      const chunks = quebrarTextoEmPartes(pageText, TEXT_CHUNK_SIZE, { pagina: i });
      chunks.forEach((chunk, idx) => {
        partes.push({
          indice: partes.length + 1,
          pagina: i,
          rotulo: `Pagina ${i}${chunks.length > 1 ? ` - parte ${idx + 1}` : ''}`,
          conteudo: `[Pagina ${i}]\n${chunk.conteudo}`,
        });
      });
    }

    return {
      tipo: 'texto',
      conteudo: textoCompleto.trim(),
      partes,
      meta: { origem: 'pdf', totalPaginas, totalPartes: partes.length },
    };
  } catch (err) {
    return { tipo: 'texto', conteudo: '[PDF nao pode ser lido: ' + err.message + ']', partes: [] };
  }
}

function extrairImagem(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve({ tipo: 'imagem', conteudo: e.target.result });
    reader.readAsDataURL(file);
  });
}

function buildSeguroGarantiaInstruction(nomesArquivos, blocoTexto) {
  return `Voce e um especialista senior em subscricao de SEGURO GARANTIA para seguradoras brasileiras. Analise COMPLETAMENTE os documentos enviados (edital, contrato, aditivo, apostilamento, termo de referencia ou similares) e produza uma analise tecnica detalhada em portugues brasileiro.

Para cada informacao extraida, informe a fonte exata no documento (clausula, item, artigo, pagina). Omita campos nao encontrados em vez de escrever "nao encontrado" ou similar.

Estruture sua resposta cobrindo obrigatoriamente:

## Partes e Dados Gerais
- Tomador (empresa contratada), Segurado/Beneficiario (orgao contratante), objeto do contrato
- Numero do edital/contrato, valor estimado, modalidade de licitacao
- Vigencia inicio e fim, foro de eleicao

## Modalidades de Seguro Garantia Identificadas
Para cada modalidade aplicavel: nome, importancia segurada, percentual, vigencia, fonte exata no documento e parecer (Emitir / Emitir com ressalvas / Declinar). Verifique: Garantia de Proposta, Garantia de Execucao, Adiantamento, Retencao, Manutencao, Fiel Cumprimento.

## Clausulas Criticas
Liste as clausulas que impactam o risco da seguradora (penalidades, rescisao, reajuste, sub-rogacao) com localizacao exata.

## Riscos Identificados
Liste riscos Alto / Medio / Baixo com descricao objetiva e fonte no documento.

## Parecer Geral de Emissao
Recomendacao: Emitir, Emitir com ressalvas ou Declinar, com justificativa tecnica abrangente e condicoes se houver.

## Resumo Executivo
4-5 frases resumindo objeto, partes, modalidades aplicaveis e parecer.

Documentos analisados: ${nomesArquivos}${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;
}

function buildFiancaInstruction(nomesArquivos, blocoTexto) {
  return `Voce e um especialista em subscricao de FIANCA LOCATICIA para seguradoras brasileiras. Analise os documentos fornecidos (contrato de locacao, aditivos, laudos, termos de apostilamento ou similares) e extraia todas as informacoes necessarias para emissao do seguro.

REGRA FUNDAMENTAL: Para CADA campo extraido, informe OBRIGATORIAMENTE a fonte exata no documento, clausula, artigo, item, paragrafo, pagina ou secao onde a informacao aparece. Se nao encontrar a informacao, use null. NUNCA invente ou estime valores.

REGRA SOBRE NULL: Use sempre JSON null, NUNCA a string "null", "N/A", "nao informado" ou similar.

ONDE ENCONTRAR CADA CAMPO NO CONTRATO DE LOCACAO:
- imovel -> endereco no preambulo ou clausula 1a: "imovel situado em", "objeto da locacao", "logradouro"
- locatario -> "LOCATARIO", "ARRENDATARIO", nome/razao social da pessoa ou empresa que aluga, geralmente no preambulo
- locador -> "LOCADOR", "PROPRIETARIO", nome do dono do imovel, geralmente no preambulo
- finalidade -> "FINALIDADE", "destinado a", "uso residencial", "uso comercial", "atividade"
- valor_aluguel -> "valor do aluguel", "aluguel mensal de R$", "contraprestacao mensal", "prestacao mensal"
- encargos_mensais -> "encargos", "condominio", "IPTU", "taxas condominiais", "demais encargos"
- valor_garantia -> "valor da garantia", "importancia segurada", "valor do seguro fianca", "cobertura maxima"
- vigencia_inicio / vigencia_fim -> datas explicitas de inicio e termino, ou prazo em meses a partir de data base
- indice_reajuste -> "IGPM", "IPCA", "indice de reajuste", "correcao anual por"
- multa_rescisao -> "multa contratual", "penalidade", "clausula penal", "multa de X alugueis"
- sub_rogacao -> "sub-rogacao", "direito de regresso", "ressarcimento", clausula sobre direito da seguradora
- foro -> "FORO", "comarca", "eleito o foro de", geralmente ultima clausula

DOCUMENTOS ENVIADOS: ${nomesArquivos}

Retorne APENAS este JSON (sem markdown, sem texto antes ou depois):
{"tipo":"Fianca Locaticia","documentos_analisados":["nomes dos arquivos"],"dados_gerais":{"imovel":{"valor":"endereco completo do imovel ou null","fonte":"ex: Clausula 1a do Contrato"},"locatario":{"valor":"nome completo do locatario ou null","fonte":"..."},"locador":{"valor":"nome completo do locador ou null","fonte":"..."},"finalidade":{"valor":"Residencial | Comercial | Misto ou null","fonte":"..."},"valor_aluguel":{"valor":0.00,"fonte":"..."},"encargos_mensais":{"valor":"descricao dos encargos (condominio, IPTU, etc.) ou null","fonte":"..."},"valor_garantia":{"valor":0.00,"fonte":"..."},"vigencia_inicio":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"vigencia_fim":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"indice_reajuste":{"valor":"IGPM | IPCA | outro ou null","fonte":"..."},"multa_rescisao":{"valor":"valor ou formula da multa ou null","fonte":"..."},"sub_rogacao":{"valor":"Sim | Nao | Nao mencionado","fonte":"..."},"foro":{"valor":"foro de eleicao ou null","fonte":"..."}},"clausulas_criticas":[{"titulo":"nome da clausula","descricao":"transcricao ou resumo fiel do texto da clausula","fonte":"ex: Clausula 8a do Contrato de Locacao","impacto":"Alto"}],"riscos":[{"descricao":"descricao objetiva do risco identificado","fonte":"localizacao exata no documento","nivel":"Alto"}],"parecer":{"recomendacao":"Emitir | Emitir com ressalvas | Declinar","justificativa":"justificativa tecnica detalhada","condicoes":["condicao 1","condicao 2"]},"resumo":"resumo executivo de 3-4 frases sobre o contrato de locacao e a analise"}

Regras: monetarios como numero puro em reais (ex: 2500.00), null quando nao encontrado. Identifique TODAS as clausulas que impactam o risco da seguradora. Responda em portugues brasileiro.${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;
}

function buildFinanceInstruction(blocoTexto) {
  return `Voce e um analista financeiro senior especializado em analise de credito para seguradoras brasileiras. Sua tarefa e analisar documentos financeiros com foco em subscricao de SEGURO GARANTIA e FIANCA LOCATICIA.

REGRAS ABSOLUTAS - NUNCA VIOLE:
1. Se houver documentos de empresas DIFERENTES, crie uma entrada separada para cada empresa no array "empresas". JAMAIS misture dados de empresas distintas.
2. Se houver DRE ou balancos de PERIODOS DIFERENTES da mesma empresa, crie um objeto separado em "documentos" para cada periodo. NUNCA some ou consolide valores entre periodos.
3. Extraia APENAS valores explicitamente presentes nos documentos. Use JSON null (nunca a string "null") para qualquer dado ausente. NUNCA estime ou interpole valores.
4. Identifique a empresa pelo nome no cabecalho, rodape ou CNPJ do documento.
5. Retorne APENAS o JSON, sem markdown, sem texto antes ou depois.

INDICADORES PRIORITARIOS PARA SEGURO GARANTIA E FIANCA LOCATICIA:
- Patrimonio Liquido (principal colateral e capacidade de garantia)
- Liquidez Corrente e Geral (capacidade de pagamento imediato)
- Endividamento Geral e composicao (risco de inadimplencia)
- EBITDA e Margem EBITDA (geracao de caixa operacional)
- Receita Bruta/Liquida e tendencia (solidez operacional)
- Lucro/Prejuizo Liquido (resultado final)
- Divida Liquida / EBITDA (alavancagem real)
- Capital de Giro Liquido (folga operacional)
- Cobertura de Juros (risco de default financeiro)
- Rentabilidade sobre PL (retorno aos socios)

CRITERIOS DE CLASSIFICACAO DE RISCO (para seguradora):
- Baixo: PL positivo e robusto, liquidez > 1,5, endividamento < 40%, lucro consistente
- Moderado: PL positivo, liquidez entre 1,0-1,5, endividamento 40-60%, resultado oscilante
- Alto: PL reduzido ou negativo recente, liquidez < 1,0, endividamento > 60%, prejuizo recente
- Critico: PL negativo, insolvencia tecnica, multiplos exercicios com prejuizo, liquidez critica

Retorne APENAS este JSON:
{"empresas":[{"empresa":"Nome exato da empresa","cnpj":"XX.XXX.XXX/XXXX-XX ou null","documentos":[{"tipo":"DRE|Balanco Patrimonial|Balancete","periodo":"periodo identificado","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"passivo_total":null,"passivo_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null},"observacoes":"observacoes relevantes sobre este documento"}],"analise_credito":{"classificacao_risco":"Baixo|Moderado|Alto|Critico","resumo_executivo":"analise objetiva da saude financeira em 3-4 frases","capacidade_seguro_garantia":"Alta|Moderada|Baixa|Inapta","justificativa_garantia":"justificativa tecnica para seguro garantia","capacidade_fianca_locaticia":"Alta|Moderada|Baixa|Inapta","justificativa_fianca":"justificativa tecnica para fianca locaticia","pontos_positivos":["ponto 1","ponto 2"],"pontos_atencao":["ponto 1","ponto 2"],"recomendacao_seguradora":"recomendacao tecnica objetiva para a seguradora"}}]}

Regras de valores: monetarios como numero puro em reais (ex: 1500000.50), percentuais como decimal (ex: 25.5 para 25,5%), indices como decimal (ex: 1.45), null quando ausente. Responda sempre em portugues brasileiro.${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;
}

function mapArquivosParaJob(arquivosExtraidos) {
  return arquivosExtraidos.map(item => {
    if (item.tipo === 'imagem') {
      return { nome: item.nome, tipo: 'imagem', conteudo: item.conteudo };
    }

    return {
      nome: item.nome,
      tipo: 'texto',
      conteudo: item.conteudo || '',
      partes: (item.partes || []).map((parte, idx) => ({
        indice: parte.indice || idx + 1,
        rotulo: parte.rotulo || `Parte ${idx + 1}`,
        pagina: parte.pagina || null,
        conteudo: parte.conteudo,
      })),
      meta: item.meta || {},
    };
  });
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const error = new Error(text || `Erro HTTP ${resp.status}`);
    error.status = resp.status;
    throw error;
  }

  return resp.json();
}

function shouldFallbackToLegacy(err) {
  return err && (err.status === 404 || err.status === 405 || err.status === 501);
}

async function executarAnaliseEmLotes(flow, arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );

  const payload = {
    flow,
    files: mapArquivosParaJob(extraidos),
  };

  const start = await postJson(DEEPSEEK_JOBS_URL, payload);
  const jobId = start && start.jobId;
  if (!jobId) throw new Error('O Worker nao retornou um jobId valido.');

  for (let i = 0; i < MAX_JOB_ITERATIONS; i++) {
    const data = await postJson(`${DEEPSEEK_JOBS_URL}/${encodeURIComponent(jobId)}/run`, {});
    if (data.status === 'completed') return data.result;
    if (data.status === 'failed') throw new Error(data.error || 'Falha na analise em lotes.');
    await sleep(data.retryAfterMs || 250);
  }

  throw new Error('A analise excedeu o numero maximo de iteracoes. Revise o Worker.');
}

async function chamarWorkerDireto(messages, maxTokens = 8192) {
  const resp = await fetch(DEEPSEEK_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens: maxTokens }),
  });
  if (!resp.ok) throw new Error('Erro na API: ' + await resp.text());
  return resp.json();
}

function parseJsonResult(raw) {
  if (raw && typeof raw === 'object') return raw;
  return JSON.parse(String(raw));
}

async function analisarSeguroGarantiaLegacy(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );
  const textuais = extraidos.filter(a => a.tipo === 'texto');
  const imagens = extraidos.filter(a => a.tipo === 'imagem');
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const blocoTexto = textuais.length
    ? textuais.map((a, i) => `--- DOCUMENTO ${i + 1}: ${a.nome} ---\n${String(a.conteudo || '').slice(0, 50000)}`).join('\n\n')
    : '';

  const instrucao = buildSeguroGarantiaInstruction(nomesArquivos, blocoTexto);
  const mensagens = imagens.length > 0
    ? [{ role: 'user', content: [{ type: 'text', text: instrucao }, ...imagens.map(img => ({ type: 'image_url', image_url: { url: img.conteudo } }))] }]
    : [{ role: 'user', content: instrucao }];

  const data = await chamarWorkerDireto(mensagens, 8192);
  return parseDeepSeekContent(data);
}

async function analisarFiancaLocaticiaLegacy(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );
  const textuais = extraidos.filter(a => a.tipo === 'texto');
  const imagens = extraidos.filter(a => a.tipo === 'imagem');
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const blocoTexto = textuais.length
    ? textuais.map((a, i) => `--- DOCUMENTO ${i + 1}: ${a.nome} ---\n${String(a.conteudo || '').slice(0, 50000)}`).join('\n\n')
    : '';

  const instrucao = buildFiancaInstruction(nomesArquivos, blocoTexto);
  const mensagens = imagens.length > 0
    ? [{ role: 'user', content: [{ type: 'text', text: instrucao }, ...imagens.map(img => ({ type: 'image_url', image_url: { url: img.conteudo } }))] }]
    : [{ role: 'user', content: instrucao }];

  const data = await chamarWorkerDireto(mensagens, 8192);
  return parseJsonResult(parseDeepSeekContent(data));
}

async function analisarDocumentosFinanceirosLegacy(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );

  const textuais = extraidos.filter(a => a.tipo === 'texto');
  const imagens = extraidos.filter(a => a.tipo === 'imagem');
  const blocoTexto = textuais.length
    ? textuais.map((a, i) => `--- ARQUIVO ${i + 1}: ${a.nome} ---\n${String(a.conteudo || '').slice(0, 50000)}`).join('\n\n')
    : '';

  const instrucao = buildFinanceInstruction(blocoTexto);
  const mensagens = imagens.length > 0
    ? [{
        role: 'user',
        content: [
          { type: 'text', text: instrucao },
          ...imagens.map(img => ({ type: 'image_url', image_url: { url: img.conteudo } })),
        ],
      }]
    : [{ role: 'user', content: instrucao }];

  const data = await chamarWorkerDireto(mensagens, 8192);
  return parseJsonResult(parseDeepSeekContent(data));
}

async function analisarSeguroGarantia(arquivos) {
  try {
    const result = await executarAnaliseEmLotes('seguro-garantia', arquivos);
    return typeof result === 'string' ? result : String(result && result.resultado ? result.resultado : '');
  } catch (err) {
    if (!shouldFallbackToLegacy(err)) throw err;
    return analisarSeguroGarantiaLegacy(arquivos);
  }
}

function criarHistoricoSeguroGarantia(arquivos, analiseInicial) {
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  return [
    {
      role: 'user',
      content: `Voce ja concluiu a analise inicial dos seguintes documentos: ${nomesArquivos}. A partir de agora, responda perguntas adicionais do corretor em portugues brasileiro com base APENAS na analise consolidada abaixo. Quando a analise consolidada nao trouxer evidencia suficiente, diga claramente que a informacao nao consta na analise consolidada.`,
    },
    {
      role: 'assistant',
      content: analiseInicial,
    },
  ];
}

async function chatSeguroGarantia(history) {
  const data = await chamarWorkerDireto(history, 4096);
  return parseDeepSeekContent(data);
}

async function analisarFiancaLocaticia(arquivos) {
  try {
    const result = await executarAnaliseEmLotes('fianca-locaticia', arquivos);
    return parseJsonResult(result);
  } catch (err) {
    if (!shouldFallbackToLegacy(err)) throw err;
    return analisarFiancaLocaticiaLegacy(arquivos);
  }
}

async function analisarDocumentosFinanceiros(arquivos) {
  try {
    const result = await executarAnaliseEmLotes('analise-financeira', arquivos);
    return parseJsonResult(result);
  } catch (err) {
    if (!shouldFallbackToLegacy(err)) throw err;
    return analisarDocumentosFinanceirosLegacy(arquivos);
  }
}
