const DEEPSEEK_WORKER_URL = 'https://lucky-hat-b241.kyuri887.workers.dev/';
const DEEPSEEK_JOBS_URL = DEEPSEEK_WORKER_URL.replace(/\/+$/, '') + '/v1/analysis-jobs';
const MAX_PDF_PAGES = 250;
const TEXT_CHUNK_SIZE = 30000;
const MAX_JOB_ITERATIONS = 400;
const OCR_TEXT_THRESHOLD = 100; // abaixo disto o PDF é tratado como imagem → usa OCR
const RAW_TEXT_CHAT_LIMIT = 50000; // chars do texto bruto incluídos no contexto do chat

// Texto bruto dos documentos por aba — usado para dupla checagem no chat
let _rawFinanceiro = '';
let _rawSeguroGarantia = '';
let _rawFianca = '';
let _rawApolice = '';

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

async function extrairTextosBrutos(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );
  return extraidos
    .filter(a => a.tipo === 'texto')
    .map((a, i) => `--- DOCUMENTO ${i + 1}: ${a.nome} ---\n${String(a.conteudo || '')}`)
    .join('\n\n')
    .slice(0, RAW_TEXT_CHAT_LIMIT);
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

async function carregarTesseract() {
  if (window.Tesseract) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Falha ao carregar Tesseract.js'));
    document.head.appendChild(s);
  });
}

async function extrairPDFcomOCR(pdf, totalPaginas) {
  await carregarTesseract();
  const worker = await Tesseract.createWorker(['por', 'eng']);
  let textoCompleto = '';
  const partes = [];
  let chunkBuffer = '';
  let chunkStartPage = null;

  for (let i = 1; i <= totalPaginas; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const { data: { text } } = await worker.recognize(canvas);
    const pageText = text.replace(/\s+/g, ' ').trim();
    if (!pageText) continue;

    textoCompleto += `[Pagina ${i}]\n${pageText}\n\n`;
    const bloco = `[Pagina ${i}]\n${pageText}\n\n`;

    if (!chunkBuffer) { chunkBuffer = bloco; chunkStartPage = i; continue; }
    if ((chunkBuffer + bloco).length <= TEXT_CHUNK_SIZE) { chunkBuffer += bloco; continue; }

    partes.push({
      indice: partes.length + 1, pagina: chunkStartPage,
      rotulo: chunkStartPage === i - 1 ? `Pagina ${chunkStartPage}` : `Paginas ${chunkStartPage}-${i - 1}`,
      conteudo: chunkBuffer.trim(),
    });
    chunkBuffer = bloco;
    chunkStartPage = i;
  }

  if (chunkBuffer) {
    partes.push({
      indice: partes.length + 1, pagina: chunkStartPage,
      rotulo: chunkStartPage === totalPaginas ? `Pagina ${chunkStartPage}` : `Paginas ${chunkStartPage}-${totalPaginas}`,
      conteudo: chunkBuffer.trim(),
    });
  }

  await worker.terminate();
  return { textoCompleto: textoCompleto.trim(), partes };
}

async function extrairPDF(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPaginas = Math.min(pdf.numPages, MAX_PDF_PAGES);
    let textoCompleto = '';
    const partes = [];
    let chunkBuffer = '';
    let chunkStartPage = null;

    for (let i = 1; i <= totalPaginas; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
      if (!pageText) continue;

      textoCompleto += `[Pagina ${i}]\n${pageText}\n\n`;
      const blocoPagina = `[Pagina ${i}]\n${pageText}\n\n`;

      if (!chunkBuffer) {
        chunkBuffer = blocoPagina;
        chunkStartPage = i;
        continue;
      }

      if ((chunkBuffer + blocoPagina).length <= TEXT_CHUNK_SIZE) {
        chunkBuffer += blocoPagina;
        continue;
      }

      partes.push({
        indice: partes.length + 1,
        pagina: chunkStartPage,
        rotulo: chunkStartPage === i - 1 ? `Pagina ${chunkStartPage}` : `Paginas ${chunkStartPage}-${i - 1}`,
        conteudo: chunkBuffer.trim(),
      });

      chunkBuffer = blocoPagina;
      chunkStartPage = i;
    }

    if (chunkBuffer) {
      partes.push({
        indice: partes.length + 1,
        pagina: chunkStartPage,
        rotulo: chunkStartPage === totalPaginas ? `Pagina ${chunkStartPage}` : `Paginas ${chunkStartPage}-${totalPaginas}`,
        conteudo: chunkBuffer.trim(),
      });
    }

    // PDF sem texto reconhecível → fallback OCR (média de 100 chars/página)
    if (textoCompleto.trim().length < Math.max(OCR_TEXT_THRESHOLD, totalPaginas * 100)) {
      const ocr = await extrairPDFcomOCR(pdf, totalPaginas);
      return {
        tipo: 'texto',
        conteudo: ocr.textoCompleto,
        partes: ocr.partes,
        meta: { origem: 'pdf-ocr', totalPaginas, totalPartes: ocr.partes.length },
      };
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
  return `Voce e um especialista em SEGURO GARANTIA no Brasil, com foco em analise de editais, contratos administrativos, atas, termos de adjudicacao/homologacao, propostas, aditivos e minutas de apolice. Sua funcao e retornar uma analise tecnica, objetiva e operacional para cotacao/emissao de seguro garantia.

REGRAS ABSOLUTAS:
1. Retorne APENAS JSON valido, sem markdown e sem texto antes ou depois.
2. Nao invente, nao estime e nao complete dados ausentes. Use null.
3. Para cada campo, informe a fonte exata (clausula, item, pagina ou trecho).
4. Identifique TODAS as modalidades presentes — mesmo sem palavra-chave exata, infira pelo contexto. Diferencie:
   - Garantia de Proposta/Licitacao (exigida ANTES da assinatura do contrato, para participar da licitacao)
   - Garantia de Execucao/Fiel Cumprimento (exigida APOS assinatura do contrato)
   - Garantia de Adiantamento de Pagamento
   - Garantia de Retencao de Pagamento
   - Garantia de Manutencao Corretiva / Perfeito Funcionamento
   - Garantia Trabalhista/Previdenciaria
   - Outras modalidades especificas
5. Nao use automaticamente o valor estimado para toda garantia. Para garantia de proposta: IS = valor_estimado * percentual. Para garantia de execucao: IS = valor_contrato/adjudicado/homologado * percentual.
6. Palavras-chave para buscar: "garantia de proposta", "garantia da proposta", "garantia contratual", "garantia de execucao", "fiel cumprimento", "seguro-garantia", "caucao", "fianca bancaria", "valor estimado", "valor global", "valor do contrato", "valor homologado", "valor adjudicado", "valor arrematado", "valor anual", "prazo de vigencia", "prazo de execucao", "assinatura do contrato", "ordem de servico", "vigencia da contratacao", "90 dias", "multas", "trabalhista", "previdenciaria", "clausula de retomada", "85%", "valor orcado pela Administracao".
7. Se o contrato exige vigencia a partir da assinatura, procure a data de assinatura. Se nao encontrar, deixe vigencia_obs com a regra e datas como null.
8. Se houver acrescimo de 90 dias exigido, marque exige_acrescimo_90_dias = true e calcule a data_fim_apolice com o acrescimo.
9. Hierarquia de documentos: contrato assinado > aditivo > ata de registro/homologacao > edital > minuta > proposta > demais.
10. pode_cotar = true quando ha IS e modalidade identificadas. pode_emitir = true somente com contrato assinado, valor base, percentual e vigencia.

DOCUMENTOS ENVIADOS: ${nomesArquivos}

Retorne APENAS este JSON:
{"tipo":"Seguro Garantia","documentos_analisados":["nomes dos arquivos"],"resumo_executivo":"resumo operacional em 3-5 frases com dados essenciais para cotacao/emissao","tipo_documento_analisado":"edital|contrato|ata|proposta|aditivo|minuta|misto","tomador":{"valor":"nome exato como deve constar na apolice ou null","cnpj":"XX.XXX.XXX/XXXX-XX ou null","fonte":"..."},"segurado":{"valor":"nome exato do beneficiario como deve constar na apolice ou null","cnpj":"XX.XXX.XXX/XXXX-XX ou null","endereco":"endereco ou null","fonte":"..."},"dados_licitacao_contrato":{"numero_edital":null,"numero_processo":null,"modalidade_licitacao":null,"numero_contrato":null,"numero_ata":null,"objeto":"resumo fiel do objeto ou null"},"modalidades":[{"nome":"nome da modalidade","importancia_segurada":{"valor":0.00,"fonte":"clausula e pagina exatos"},"base_calculo":{"valor":"descricao: ex: 5% do valor contratual de R$ X = R$ Y","fonte":"..."},"vigencia_inicio":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"vigencia_fim":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"vigencia_obs":{"valor":"descricao do prazo quando nao houver datas fixas ou null","fonte":"..."},"exige_acrescimo_90_dias":false,"objeto_apolice":{"valor":"texto completo para o campo Objeto da apolice mencionando edital/contrato e orgao ou null","fonte":"..."},"clausulas_necessarias":[{"descricao":"clausula especifica exigida para constar na apolice","fonte":"item e pagina"}]}],"coberturas_clausulas_exigidas":{"multas":false,"trabalhista_previdenciaria":false,"fiscal":false,"clausula_retomada":false,"adiantamento_pagamento":false,"retencao_pagamento":false,"manutencao_corretiva":false,"outras":[]},"prazo_e_forma_de_apresentacao":{"prazo":null,"momento":null,"forma_envio":null,"arquivo_unico_pdf":false},"trechos_relevantes":[{"tema":"tema do trecho","trecho":"transcricao do trecho relevante","pagina_ou_localizacao":"pag. X ou secao Y"}],"pendencias_para_emissao":["informacao faltante critica"],"perguntas_para_cliente_ou_comercial":["pergunta especifica"],"alertas_de_risco":["alerta tecnico de subscricao"],"conclusao_operacional":{"pode_cotar":false,"pode_emitir":false,"motivo":"justificativa da conclusao","nivel_confianca":"ALTA|MEDIA|BAIXA"},"parecer":{"recomendacao":"Emitir|Emitir com ressalvas|Declinar","justificativa":"justificativa tecnica especifica com valor de IS, percentual e prazo","pendencias":["alerta de subscricao ou informacao faltante"]}}

Regras: valores monetarios como numero puro em reais (ex: 8543.83), null quando nao encontrado. Responda em portugues brasileiro.${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;
}

function buildFiancaInstruction(nomesArquivos, blocoTexto) {
  return `Voce e um subscritor senior de FIANCA LOCATICIA para seguradoras brasileiras. Analise os documentos fornecidos (contrato de locacao, aditivos, laudos, apostilamentos) e extraia todas as informacoes necessarias para emissao do seguro com avaliacao de risco.

REGRA FUNDAMENTAL: Para CADA campo extraido, informe a fonte exata (clausula, artigo, pagina). Use null quando nao encontrar. NUNCA invente ou estime valores.

ONDE ENCONTRAR CADA CAMPO:
- imovel -> preambulo ou clausula 1a: "imovel situado em", "objeto da locacao", "logradouro"
- locatario -> "LOCATARIO", nome/razao social da parte que aluga, geralmente no preambulo
- locador -> "LOCADOR", "PROPRIETARIO", nome do dono do imovel
- finalidade -> "FINALIDADE", "destinado a", "uso residencial", "uso comercial"
- valor_aluguel -> "valor do aluguel", "aluguel mensal de R$", "contraprestacao mensal"
- encargos_mensais -> "condominio", "IPTU", "taxas condominiais", "demais encargos"
- valor_garantia -> "valor da garantia", "importancia segurada", "valor do seguro fianca"
- vigencia -> datas explicitas ou prazo em meses a partir de data base
- indice_reajuste -> "IGPM", "IPCA", "correcao anual por"
- multa_rescisao -> "multa contratual", "clausula penal", "multa de X alugueis"
- sub_rogacao -> "sub-rogacao", "direito de regresso", clausula sobre direito da seguradora reaver valores
- foro -> "FORO", "comarca", "eleito o foro de", geralmente ultima clausula

ALERTAS DE SUBSCRICAO — inclua em "riscos[]" automaticamente:
1. Se sub_rogacao = "Nao" ou "Nao mencionado": risco nivel Alto "Ausencia de clausula de sub-rogacao — seguradora sem direito de regresso".
2. Se valor_garantia numericamente menor que (3 x valor_aluguel): risco nivel Alto "Valor de garantia inferior a 3 alugueis mensais — cobertura possivelmente insuficiente".
3. Se finalidade = "Comercial" ou "Misto": risco nivel Medio "Imovel comercial — risco de inadimplencia tipicamente maior".
4. Se prazo de vigencia superar 30 meses: risco nivel Medio "Contrato de longa duracao — recomenda-se acompanhamento periodico".
5. Se multa_rescisao = null: risco nivel Medio "Multa rescisoria nao localizada — verifique exposicao em rescisao antecipada".
6. Identifique qualquer clausula que amplie responsabilidade da seguradora alem do padrao.

PARA "objeto_apolice": redigir texto completo e preciso para constar na apolice (identificar imovel, locatario, periodo de vigencia, valor garantido).
PARA "parecer.justificativa": mencionar valor do aluguel, valor da garantia e os principais riscos identificados.

DOCUMENTOS ENVIADOS: ${nomesArquivos}

Retorne APENAS este JSON (sem markdown, sem texto antes ou depois):
{"tipo":"Fianca Locaticia","documentos_analisados":["nomes dos arquivos"],"dados_gerais":{"imovel":{"valor":"endereco completo ou null","fonte":"..."},"locatario":{"valor":"nome completo do locatario ou null","fonte":"..."},"locador":{"valor":"nome completo do locador ou null","fonte":"..."},"finalidade":{"valor":"Residencial|Comercial|Misto ou null","fonte":"..."},"valor_aluguel":{"valor":0.00,"fonte":"..."},"encargos_mensais":{"valor":"descricao dos encargos ou null","fonte":"..."},"valor_garantia":{"valor":0.00,"fonte":"..."},"vigencia_inicio":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"vigencia_fim":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"indice_reajuste":{"valor":"IGPM|IPCA|outro ou null","fonte":"..."},"multa_rescisao":{"valor":"formula ou valor da multa ou null","fonte":"..."},"sub_rogacao":{"valor":"Sim|Nao|Nao mencionado","fonte":"..."},"foro":{"valor":"foro de eleicao ou null","fonte":"..."}},"objeto_apolice":{"valor":"texto completo do objeto para a apolice ou null","fonte":"..."},"clausulas_necessarias":[{"descricao":"clausula que deve constar na apolice","fonte":"localizacao no documento"}],"clausulas_criticas":[{"titulo":"titulo da clausula","descricao":"transcricao ou resumo fiel","fonte":"clausula e pagina","impacto":"Alto|Medio|Baixo"}],"riscos":[{"descricao":"descricao objetiva incluindo alertas de subscricao","fonte":"localizacao ou 'Regra de subscricao'","nivel":"Alto|Medio|Baixo"}],"parecer":{"recomendacao":"Emitir|Emitir com ressalvas|Declinar","justificativa":"justificativa especifica com valores e riscos identificados","condicoes":["condicao especifica para emissao"]},"resumo":"resumo executivo de 3-4 frases com os dados essenciais do contrato"}

Regras: monetarios como numero puro em reais (ex: 2500.00), null quando nao encontrado. Responda em portugues brasileiro.${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;
}

function buildApoliceInstruction(nomesArquivos, blocoTexto) {
  return `Voce e um especialista em leitura tecnica de APOLICES DE SEGURO para corretoras brasileiras. Analise os documentos enviados e extraia os dados essenciais para o corretor avaliar a apolice.

REGRAS ABSOLUTAS:
1. Retorne APENAS JSON valido, sem markdown e sem texto antes ou depois.
2. Nao invente, nao estime e nao complete dados ausentes. Use null.
3. Para cada campo, informe a fonte exata: pagina, item, clausula, secao ou quadro.
4. Extraia: tomador, segurado, importancia segurada, vigencia, objeto, coberturas e riscos excluidos.
5. Em "riscos_excluidos" inclua TAMBEM coberturas tipicamente presentes neste tipo de apolice que NAO foram localizadas — registre como "Cobertura nao localizada: [nome]" para alertar o corretor sobre possiveis gaps.

ONDE PROCURAR:
- tomador: "Tomador", "Contratante", "Estipulante" — parte que contrata e paga o seguro.
- segurado: "Segurado", "Beneficiario" — parte protegida pela apolice.
- importancia_segurada: "Importancia Segurada", "LMG", "LMI", "Limite Maximo de Garantia", "Valor segurado".
- vigencia: datas de inicio e fim, ou periodo de cobertura com prazo.
- objeto_apolice: campo "Objeto", "Objeto da apolice", "Descricao do risco" — o que a apolice garante.
- coberturas: coberturas contratadas, modalidades, clausulas de cobertura, garantias adicionais.
- riscos_excluidos: exclusoes explicitas do contrato + gaps de cobertura identificados pelo corretor.

DOCUMENTOS ENVIADOS: ${nomesArquivos}

Retorne APENAS este JSON:
{"tipo":"Analise de Apolice","documentos_analisados":["nomes dos arquivos"],"dados_gerais":{"tomador":{"valor":"nome do tomador ou null","fonte":"..."},"segurado":{"valor":"nome do segurado ou null","fonte":"..."},"importancia_segurada":{"valor":0.00,"fonte":"..."},"vigencia":{"valor":"inicio e fim da vigencia ou null","fonte":"..."},"objeto_apolice":{"valor":"objeto da apolice ou null","fonte":"..."}},"coberturas":[{"descricao":"cobertura contratada identificada","fonte":"pagina ou clausula"}],"riscos_excluidos":[{"descricao":"exclusao explicita ou gap: 'Cobertura nao localizada: X'","fonte":"pagina, clausula ou 'Cobertura nao localizada'"}]}

Regras: valores monetarios como numero puro em reais (ex: 150000.50). Se IS aparecer por cobertura, preserve o texto. Responda em portugues brasileiro.${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;
}

function buildFinanceInstruction(blocoTexto) {
  return `Voce e um analista financeiro senior especializado em credito empresarial, seguro garantia e fianca locaticia para seguradoras brasileiras. Analise os documentos financeiros fornecidos (Balanco Patrimonial, DRE, Balancete, etc.) e retorne uma analise tecnica, objetiva e operacional.

REGRAS ABSOLUTAS — NUNCA VIOLE:
1. Empresas DIFERENTES: crie uma entrada separada por empresa. NUNCA misture dados de empresas distintas.
2. Periodos DIFERENTES: crie um objeto separado em "documentos" por periodo. NUNCA consolide valores entre periodos.
3. Extraia APENAS valores explicitamente presentes. Use null para ausentes. NUNCA estime.
4. Se o documento indicar escala "em milhares" ou "R$ Mil": multiplique TODOS os valores monetarios por 1.000 e registre em "observacao_escala" e em "observacoes" de cada documento.
5. Verifique consistencia do Balanco Patrimonial: Ativo Total = Passivo Total + Patrimonio Liquido. Se divergir, registre em "inconsistencias_ou_limitacoes".
6. Retorne APENAS JSON valido, sem markdown.

CLASSIFICACAO FINANCEIRA — use criterios objetivos:
- BOA: lucro positivo, PL positivo, liquidez corrente > 1.2, endividamento < 50%, capital de giro positivo
- REGULAR: lucro baixo ou instavel, liquidez 0.8-1.2, endividamento 50-70%, alertas sem sinal critico
- FRACA: prejuizo, liquidez < 0.8, capital de giro negativo, endividamento > 70%
- CRITICA: PL negativo, prejuizo relevante, passivo circulante >> ativo circulante, risco de insolvencia
- INCONCLUSIVA: sem DRE, sem balanco, dados contraditórios, periodo insuficiente

NIVEL DE RISCO:
- Baixo: PL solido positivo, liquidez > 1.5, endividamento < 40%, lucro consistente
- Moderado: PL positivo, liquidez 1.0-1.5, endividamento 40-60%, resultado variavel
- Alto: PL reduzido ou queda acentuada, liquidez < 1.0, endividamento > 60%, prejuizo recente
- Critico: PL negativo (insolvencia tecnica), multiplos prejuizos, liquidez critica

INDICADORES A CALCULAR (use periodo mais recente disponivel):
- liquidez_corrente = Ativo Circulante / Passivo Circulante
- liquidez_seca = (Ativo Circulante - Estoques) / Passivo Circulante
- capital_de_giro_liquido = Ativo Circulante - Passivo Circulante
- endividamento_geral = Passivo Total / Ativo Total
- divida_sobre_pl = Passivo Total / Patrimonio Liquido
- composicao_endividamento = Passivo Circulante / Passivo Total
- margem_bruta = Lucro Bruto / Receita Liquida
- margem_operacional = Resultado Operacional / Receita Liquida
- margem_liquida = Lucro Liquido / Receita Liquida
- roe = Lucro Liquido / Patrimonio Liquido
- roa = Lucro Liquido / Ativo Total

PARA justificativa_garantia: mencione o PL exato e o limite SG (PL x 0.15). Ex: "PL de R$ 5.000.000 permite SG ate R$ 750.000."
PARA recomendacao_seguradora: limite SG (PL x 0.15) e indicacao FL. Se houver multiplos periodos, mencione tendencia.

Retorne APENAS este JSON:
{"empresas":[{"empresa":"Nome exato da empresa","cnpj":"XX.XXX.XXX/XXXX-XX ou null","periodo_analisado":"ex: 2022-2024 ou jan/2024","moeda":"BRL","observacao_escala":"Valores em reais ou Valores originais em milhares — multiplicados por 1.000","demonstrativos_identificados":{"balanco_patrimonial":false,"dre":false,"balancete":false,"outros":[]},"documentos":[{"tipo":"DRE|Balanco Patrimonial|Balancete","periodo":"periodo identificado","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"resultado_operacional":null,"resultado_financeiro":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_bruta":null,"margem_operacional":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"ativo_nao_circulante":null,"passivo_total":null,"passivo_circulante":null,"passivo_nao_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_seca":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null,"caixa_e_equivalentes":null,"clientes_a_receber":null,"estoques":null,"fornecedores":null,"emprestimos_e_financiamentos":null,"obrigacoes_fiscais":null,"obrigacoes_trabalhistas":null},"observacoes":"observacoes tecnicas incluindo ajuste de escala"}],"principais_numeros":{"ativo_total":null,"ativo_circulante":null,"passivo_total":null,"passivo_circulante":null,"patrimonio_liquido":null,"receita_bruta":null,"receita_liquida":null,"lucro_liquido":null,"caixa_e_equivalentes":null,"clientes_a_receber":null,"estoques":null,"fornecedores":null,"emprestimos_e_financiamentos":null,"obrigacoes_fiscais":null,"obrigacoes_trabalhistas":null},"indicadores_calculados":{"liquidez_corrente":{"valor":null,"interpretacao":""},"liquidez_seca":{"valor":null,"interpretacao":""},"capital_de_giro_liquido":{"valor":null,"interpretacao":""},"endividamento_geral":{"valor":null,"interpretacao":""},"divida_sobre_pl":{"valor":null,"interpretacao":""},"composicao_endividamento":{"valor":null,"interpretacao":""},"margem_bruta":{"valor":null,"interpretacao":""},"margem_operacional":{"valor":null,"interpretacao":""},"margem_liquida":{"valor":null,"interpretacao":""},"roe":{"valor":null,"interpretacao":""},"roa":{"valor":null,"interpretacao":""}},"analise_qualitativa":{"liquidez":"","endividamento":"","rentabilidade":"","patrimonio_liquido":"","resultado":"","capital_de_giro":"","capacidade_financeira":"","consistencia_contabil":""},"sinais_positivos":["sinal positivo concreto com valores"],"sinais_negativos":["sinal negativo concreto com valores"],"alertas_de_risco":["alerta especifico com valores e impacto"],"inconsistencias_ou_limitacoes":["inconsistencia ou limitacao dos dados"],"documentos_adicionais_recomendados":["documento especifico"],"classificacao_financeira":{"situacao":"BOA|REGULAR|FRACA|CRITICA|INCONCLUSIVA","nivel_risco":"BAIXO|MODERADO|ALTO|CRITICO|INCONCLUSIVO","justificativa":"justificativa com valores concretos"},"analise_credito":{"classificacao_risco":"Baixo|Moderado|Alto|Critico","resumo_executivo":"analise objetiva em 3-4 frases com valores concretos","capacidade_seguro_garantia":"Alta|Moderada|Baixa|Inapta","justificativa_garantia":"justificativa com PL e limite SG sugerido","capacidade_fianca_locaticia":"Alta|Moderada|Baixa|Inapta","justificativa_fianca":"justificativa com liquidez e endividamento","pontos_positivos":["ponto positivo com valores"],"pontos_atencao":["ponto de atencao com valores"],"recomendacao_seguradora":"recomendacao com limites sugeridos e tendencia"},"visao_para_seguro_garantia":{"capacidade_para_assumir_contratos":"boa|moderada|limitada|risco elevado|necessita analise manual","pontos_de_atencao_para_subscricao":["ponto especifico"],"recomendacao_operacional":"conclusao para o analista/corretor em 2-4 frases"},"conclusao_final":{"empresa_tem_bons_numeros":null,"empresa_tem_numeros_ruins":null,"resumo_da_conclusao":"conclusao operacional para uso interno em 2-4 frases","nivel_confianca_da_analise":"ALTO|MEDIO|BAIXO"}}]}

Regras: monetarios como numero puro em reais (ex: 1500000.50), percentuais/indices como decimal (ex: 25.5 para 25,5%, 1.45 para liquidez), null quando ausente. Responda em portugues brasileiro.${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;
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
  const msg = err && err.message ? err.message.toLowerCase() : '';
  return err && (
    err.status === 404 ||
    err.status === 405 ||
    err.status === 501 ||
    msg.includes('flow invalido') ||
    msg.includes('redis error 414') ||
    msg.includes('flow inválido')
  );
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
  return parseJsonResult(parseDeepSeekContent(data));
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

async function analisarApoliceLegacy(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );
  const textuais = extraidos.filter(a => a.tipo === 'texto');
  const imagens = extraidos.filter(a => a.tipo === 'imagem');
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const blocoTexto = textuais.length
    ? textuais.map((a, i) => `--- DOCUMENTO ${i + 1}: ${a.nome} ---\n${String(a.conteudo || '').slice(0, 50000)}`).join('\n\n')
    : '';

  const instrucao = buildApoliceInstruction(nomesArquivos, blocoTexto);
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
  _rawSeguroGarantia = await extrairTextosBrutos(arquivos);
  try {
    const result = await executarAnaliseEmLotes('seguro-garantia', arquivos);
    try {
      return parseJsonResult(result);
    } catch (_jsonErr) {
      // Worker antigo ainda retorna markdown — usa string para renderizar com renderer legado
      return typeof result === 'string' ? result : String(result || '');
    }
  } catch (err) {
    if (!shouldFallbackToLegacy(err)) throw err;
    return analisarSeguroGarantiaLegacy(arquivos);
  }
}

function criarHistoricoSeguroGarantia(arquivos, analiseInicial) {
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const analiseStr = typeof analiseInicial === 'string' ? analiseInicial : JSON.stringify(analiseInicial, null, 2);
  const blocoRaw = _rawSeguroGarantia
    ? `\n\nTEXTO ORIGINAL DOS DOCUMENTOS (use para verificar dados diretamente):\n${_rawSeguroGarantia}\n`
    : '';
  return [
    {
      role: 'user',
      content: `Você já concluiu a análise inicial dos seguintes documentos: ${nomesArquivos}.${blocoRaw}\nA partir de agora, responda perguntas adicionais do corretor em português brasileiro. Para verificar qualquer dado específico, consulte o texto original dos documentos acima. A análise consolidada está abaixo.\n\nAnálise consolidada:\n${analiseStr}`,
    },
    {
      role: 'assistant',
      content: 'Análise concluída. Pode me fazer perguntas sobre os documentos — vou consultar o texto original quando necessário para garantir precisão.',
    },
  ];
}

async function chatSeguroGarantia(history) {
  const data = await chamarWorkerDireto(history, 4096);
  return parseDeepSeekContent(data);
}

function criarHistoricoFiancaLocaticia(arquivos, analiseJson) {
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const blocoRaw = _rawFianca
    ? `\n\nTEXTO ORIGINAL DOS DOCUMENTOS (use para verificar dados diretamente):\n${_rawFianca}\n`
    : '';
  return [
    {
      role: 'user',
      content: `Você já concluiu a análise inicial dos seguintes documentos de fiança locatícia: ${nomesArquivos}.${blocoRaw}\nResponda perguntas sobre o contrato de locação em português brasileiro. Para verificar qualquer dado específico, consulte o texto original acima. O JSON com a análise extraída está abaixo.\n\nJSON da análise:\n${analiseJson}`,
    },
    {
      role: 'assistant',
      content: 'Análise dos documentos concluída. Pode me fazer perguntas sobre o contrato, cláusulas, valores, riscos e qualquer detalhe — vou consultar o texto original quando necessário.',
    },
  ];
}

async function chatFiancaLocaticia(history) {
  const data = await chamarWorkerDireto(history, 4096);
  return parseDeepSeekContent(data);
}

function criarHistoricoAnaliseFinanceira(arquivos, analiseJson) {
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const blocoRaw = _rawFinanceiro
    ? `\n\nTEXTO ORIGINAL DOS DOCUMENTOS (use para verificar dados diretamente — fonte primária):\n${_rawFinanceiro}\n`
    : '';
  return [
    {
      role: 'user',
      content: `Você já concluiu a análise financeira dos seguintes documentos: ${nomesArquivos}.${blocoRaw}\nResponda perguntas em português brasileiro sobre os balanços, indicadores financeiros, risco de crédito e capacidade de emissão de seguros. Sempre que houver dúvida ou a pergunta envolver um valor específico, consulte o texto original dos documentos acima para confirmar. O JSON com a análise está abaixo como referência rápida.\n\nJSON da análise:\n${analiseJson}`,
    },
    {
      role: 'assistant',
      content: 'Análise financeira concluída. Pode me perguntar sobre indicadores, risco de crédito, capacidade de seguro garantia e fiança, ou qualquer detalhe dos demonstrativos — vou consultar o texto original para garantir precisão.',
    },
  ];
}

async function chatAnaliseFinanceira(history) {
  const data = await chamarWorkerDireto(history, 4096);
  return parseDeepSeekContent(data);
}

function criarHistoricoApolice(arquivos, analiseJson) {
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const blocoRaw = _rawApolice
    ? `\n\nTEXTO ORIGINAL DOS DOCUMENTOS (use para verificar dados diretamente):\n${_rawApolice}\n`
    : '';
  return [
    {
      role: 'user',
      content: `Voce ja concluiu a analise de apolice dos seguintes documentos: ${nomesArquivos}.${blocoRaw}\nResponda perguntas em portugues brasileiro sobre a apolice, tomador, segurado, importancia segurada, vigencia, objeto, coberturas e riscos excluidos. Para verificar qualquer dado especifico, consulte o texto original acima. O JSON com a analise extraida esta abaixo.\n\nJSON da analise:\n${analiseJson}`,
    },
    {
      role: 'assistant',
      content: 'Analise da apolice concluida. Pode me fazer perguntas sobre tomador, segurado, importancia segurada, vigencia, objeto, coberturas e riscos excluidos.',
    },
  ];
}

async function chatApolice(history) {
  const data = await chamarWorkerDireto(history, 4096);
  return parseDeepSeekContent(data);
}

async function analisarFiancaLocaticia(arquivos) {
  _rawFianca = await extrairTextosBrutos(arquivos);
  try {
    const result = await executarAnaliseEmLotes('fianca-locaticia', arquivos);
    return parseJsonResult(result);
  } catch (err) {
    if (!shouldFallbackToLegacy(err)) throw err;
    return analisarFiancaLocaticiaLegacy(arquivos);
  }
}

async function analisarApolice(arquivos) {
  _rawApolice = await extrairTextosBrutos(arquivos);
  try {
    const result = await executarAnaliseEmLotes('analise-apolice', arquivos);
    return parseJsonResult(result);
  } catch (err) {
    if (!shouldFallbackToLegacy(err)) throw err;
    return analisarApoliceLegacy(arquivos);
  }
}

async function analisarDocumentosFinanceiros(arquivos) {
  _rawFinanceiro = await extrairTextosBrutos(arquivos);
  try {
    const result = await executarAnaliseEmLotes('analise-financeira', arquivos);
    return parseJsonResult(result);
  } catch (err) {
    if (!shouldFallbackToLegacy(err)) throw err;
    return analisarDocumentosFinanceirosLegacy(arquivos);
  }
}
