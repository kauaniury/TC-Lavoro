const DEEPSEEK_WORKER_URL = 'https://lucky-hat-b241.kyuri887.workers.dev/';

function parseDeepSeekContent(data) {
  const msg = data.choices[0].message;
  // Para deepseek-v4-pro o thinking pode vir em msg.thinking ou inline no content com tags
  let raw = (msg.content || '').trim();
  // Remove blocos de thinking/reasoning que alguns modelos embutem no content
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  raw = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  // Remove fences de markdown
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!raw) throw new Error('Resposta vazia da API. Tente novamente.');
  return raw;
}

async function extrairConteudoArquivo(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (['xlsx', 'xls'].includes(ext)) return extrairExcel(file);
  if (ext === 'csv') return extrairTexto(file);
  if (ext === 'pdf') return extrairPDF(file);
  if (['png', 'jpg', 'jpeg'].includes(ext)) return extrairImagem(file);
  return { tipo: 'texto', conteudo: '' };
}

function extrairExcel(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        let texto = '';
        wb.SheetNames.forEach(nome => {
          const ws = wb.Sheets[nome];
          texto += `[Aba: ${nome}]\n${XLSX.utils.sheet_to_csv(ws)}\n\n`;
        });
        resolve({ tipo: 'texto', conteudo: texto.slice(0, 10000) });
      } catch (err) {
        resolve({ tipo: 'texto', conteudo: '[Erro ao ler Excel: ' + err.message + ']' });
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function extrairTexto(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve({ tipo: 'texto', conteudo: e.target.result.slice(0, 10000) });
    reader.readAsText(file, 'UTF-8');
  });
}

async function extrairPDF(file) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let texto = '';
    const maxPaginas = Math.min(pdf.numPages, 40);
    for (let i = 1; i <= maxPaginas; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      texto += content.items.map(item => item.str).join(' ') + '\n';
    }
    return { tipo: 'texto', conteudo: texto.trim().slice(0, 50000) };
  } catch (err) {
    return { tipo: 'texto', conteudo: '[PDF não pôde ser lido: ' + err.message + ']' };
  }
}

function extrairImagem(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve({ tipo: 'imagem', conteudo: e.target.result });
    reader.readAsDataURL(file);
  });
}

// ── Seguro Garantia — extrai conteudo dos arquivos e monta historico inicial
async function iniciarChatSeguroGarantia(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );
  const textuais = extraidos.filter(a => a.tipo === 'texto');
  const imagens  = extraidos.filter(a => a.tipo === 'imagem');
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const blocoTexto = textuais.length
    ? textuais.map((a, i) => `--- DOCUMENTO ${i + 1}: ${a.nome} ---\n${a.conteudo}`).join('\n\n')
    : '';

  const instrucao = `Voce e um especialista senior em subscricao de SEGURO GARANTIA para seguradoras brasileiras. Analise COMPLETAMENTE os documentos enviados (edital, contrato, aditivo, apostilamento, termo de referencia ou similares) e produza uma analise tecnica detalhada em portugues brasileiro.

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
Recomendacao: Emitir, Emitir com ressalvas ou Declinar — com justificativa tecnica abrangente e condicoes se houver.

## Resumo Executivo
4-5 frases resumindo objeto, partes, modalidades aplicaveis e parecer.

Documentos analisados: ${nomesArquivos}${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;

  const primeiraMsg = imagens.length > 0
    ? { role: 'user', content: [{ type: 'text', text: instrucao }, ...imagens.map(img => ({ type: 'image_url', image_url: { url: img.conteudo } }))] }
    : { role: 'user', content: instrucao };

  return [primeiraMsg];
}

// ── Envia mensagens para o chat e retorna resposta em texto
async function chatSeguroGarantia(history) {
  const resp = await fetch(DEEPSEEK_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: history, max_tokens: 8192 }),
  });
  if (!resp.ok) throw new Error('Erro na API: ' + await resp.text());
  const data = await resp.json();
  let raw = (data.choices[0].message.content || '').trim();
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  raw = raw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  if (!raw) throw new Error('Resposta vazia da API. Tente novamente.');
  return raw;
}

// ── Fianca Locaticia
async function analisarFiancaLocaticia(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );
  const textuais = extraidos.filter(a => a.tipo === 'texto');
  const imagens  = extraidos.filter(a => a.tipo === 'imagem');
  const nomesArquivos = arquivos.map(f => f.name).join(', ');
  const blocoTexto = textuais.length
    ? textuais.map((a, i) => `--- DOCUMENTO ${i + 1}: ${a.nome} ---\n${a.conteudo}`).join('\n\n')
    : '';

  const instrucao = `Você é um especialista em subscrição de FIANÇA LOCATÍCIA para seguradoras brasileiras. Analise os documentos fornecidos (contrato de locação, aditivos, laudos, termos de apostilamento ou similares) e extraia todas as informações necessárias para emissão do seguro.

REGRA FUNDAMENTAL: Para CADA campo extraído, informe OBRIGATORIAMENTE a fonte exata no documento — cláusula, artigo, item, parágrafo, página ou seção onde a informação aparece. Se não encontrar a informação, use null. NUNCA invente ou estime valores.

REGRA SOBRE NULL: Use sempre JSON null — NUNCA a string "null", "N/A", "não informado" ou similar.

ONDE ENCONTRAR CADA CAMPO NO CONTRATO DE LOCAÇÃO:
• imovel → endereço no preâmbulo ou cláusula 1ª: "imóvel situado em", "objeto da locação", "logradouro"
• locatario → "LOCATÁRIO", "ARRENDATÁRIO", nome/razão social da pessoa ou empresa que aluga, geralmente no preâmbulo
• locador → "LOCADOR", "PROPRIETÁRIO", nome do dono do imóvel, geralmente no preâmbulo
• finalidade → "FINALIDADE", "destinado a", "uso residencial", "uso comercial", "atividade"
• valor_aluguel → "valor do aluguel", "aluguel mensal de R$", "contraprestação mensal", "prestação mensal"
• encargos_mensais → "encargos", "condomínio", "IPTU", "taxas condominiais", "demais encargos"
• valor_garantia → "valor da garantia", "importância segurada", "valor do seguro fiança", "cobertura máxima"
• vigencia_inicio / vigencia_fim → datas explícitas de início e término, ou prazo em meses a partir de data base
• indice_reajuste → "IGPM", "IPCA", "índice de reajuste", "correção anual por"
• multa_rescisao → "multa contratual", "penalidade", "cláusula penal", "multa de X aluguéis"
• sub_rogacao → "sub-rogação", "direito de regresso", "ressarcimento", cláusula sobre direito da seguradora
• foro → "FORO", "comarca", "eleito o foro de", geralmente última cláusula

DOCUMENTOS ENVIADOS: ${nomesArquivos}

Retorne APENAS este JSON (sem markdown, sem texto antes ou depois):
{"tipo":"Fiança Locatícia","documentos_analisados":["nomes dos arquivos"],"dados_gerais":{"imovel":{"valor":"endereço completo do imóvel ou null","fonte":"ex: Cláusula 1ª do Contrato"},"locatario":{"valor":"nome completo do locatário ou null","fonte":"..."},"locador":{"valor":"nome completo do locador ou null","fonte":"..."},"finalidade":{"valor":"Residencial | Comercial | Misto ou null","fonte":"..."},"valor_aluguel":{"valor":0.00,"fonte":"..."},"encargos_mensais":{"valor":"descrição dos encargos (condomínio, IPTU, etc.) ou null","fonte":"..."},"valor_garantia":{"valor":0.00,"fonte":"..."},"vigencia_inicio":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"vigencia_fim":{"valor":"DD/MM/AAAA ou null","fonte":"..."},"indice_reajuste":{"valor":"IGPM | IPCA | outro ou null","fonte":"..."},"multa_rescisao":{"valor":"valor ou fórmula da multa ou null","fonte":"..."},"sub_rogacao":{"valor":"Sim | Não | Não mencionado","fonte":"..."},"foro":{"valor":"foro de eleição ou null","fonte":"..."}},"clausulas_criticas":[{"titulo":"nome da cláusula","descricao":"transcrição ou resumo fiel do texto da cláusula","fonte":"ex: Cláusula 8ª do Contrato de Locação","impacto":"Alto"}],"riscos":[{"descricao":"descrição objetiva do risco identificado","fonte":"localização exata no documento","nivel":"Alto"}],"parecer":{"recomendacao":"Emitir | Emitir com ressalvas | Declinar","justificativa":"justificativa técnica detalhada","condicoes":["condição 1","condição 2"]},"resumo":"resumo executivo de 3-4 frases sobre o contrato de locação e a análise"}

Regras: monetários como número puro em reais (ex: 2500.00), null quando não encontrado. Identifique TODAS as cláusulas que impactam o risco da seguradora. Responda em português brasileiro.${blocoTexto ? '\n\nDOCUMENTOS PARA ANALISE:\n' + blocoTexto : ''}`;

  const mensagens = imagens.length > 0
    ? [{ role: 'user', content: [{ type: 'text', text: instrucao }, ...imagens.map(img => ({ type: 'image_url', image_url: { url: img.conteudo } }))] }]
    : [{ role: 'user', content: instrucao }];

  const resp = await fetch(DEEPSEEK_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: mensagens, max_tokens: 8192 }),
  });
  if (!resp.ok) throw new Error('Erro na API: ' + await resp.text());
  const data = await resp.json();
  let raw = parseDeepSeekContent(data);
  return JSON.parse(raw);
}

async function analisarDocumentosFinanceiros(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );

  const textuais = extraidos.filter(a => a.tipo === 'texto');
  const imagens  = extraidos.filter(a => a.tipo === 'imagem');

  const blocoTexto = textuais.length
    ? textuais.map((a, i) => `--- ARQUIVO ${i + 1}: ${a.nome} ---\n${a.conteudo}`).join('\n\n')
    : '';

  const instrucao = `Você é um analista financeiro sênior especializado em análise de crédito para seguradoras brasileiras. Sua tarefa é analisar documentos financeiros com foco em subscrição de SEGURO GARANTIA e FIANÇA LOCATÍCIA.

REGRAS ABSOLUTAS — NUNCA VIOLE:
1. Se houver documentos de empresas DIFERENTES, crie uma entrada separada para cada empresa no array "empresas". JAMAIS misture dados de empresas distintas.
2. Se houver DRE ou balanços de PERÍODOS DIFERENTES da mesma empresa, crie um objeto separado em "documentos" para cada período. NUNCA some ou consolide valores entre períodos.
3. Extraia APENAS valores explicitamente presentes nos documentos. Use JSON null (nunca a string "null") para qualquer dado ausente. NUNCA estime ou interpole valores.
4. Identifique a empresa pelo nome no cabeçalho, rodapé ou CNPJ do documento.
5. Retorne APENAS o JSON, sem markdown, sem texto antes ou depois.

INDICADORES PRIORITÁRIOS PARA SEGURO GARANTIA E FIANÇA LOCATÍCIA:
- Patrimônio Líquido (principal colateral e capacidade de garantia)
- Liquidez Corrente e Geral (capacidade de pagamento imediato)
- Endividamento Geral e composição (risco de inadimplência)
- EBITDA e Margem EBITDA (geração de caixa operacional)
- Receita Bruta/Líquida e tendência (solidez operacional)
- Lucro/Prejuízo Líquido (resultado final)
- Dívida Líquida / EBITDA (alavancagem real)
- Capital de Giro Líquido (folga operacional)
- Cobertura de Juros (risco de default financeiro)
- Rentabilidade sobre PL (retorno aos sócios)

CRITÉRIOS DE CLASSIFICAÇÃO DE RISCO (para seguradora):
- Baixo: PL positivo e robusto, liquidez > 1,5, endividamento < 40%, lucro consistente
- Moderado: PL positivo, liquidez entre 1,0-1,5, endividamento 40-60%, resultado oscilante
- Alto: PL reduzido ou negativo recente, liquidez < 1,0, endividamento > 60%, prejuízo recente
- Crítico: PL negativo, insolvência técnica, múltiplos exercícios com prejuízo, liquidez crítica

Retorne APENAS este JSON:
{"empresas":[{"empresa":"Nome exato da empresa","cnpj":"XX.XXX.XXX/XXXX-XX ou null","documentos":[{"tipo":"DRE|Balanço Patrimonial|Balancete","periodo":"período identificado","indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"lucro_liquido":null,"ebitda":null,"margem_ebitda":null,"margem_liquida":null,"ativo_total":null,"ativo_circulante":null,"passivo_total":null,"passivo_circulante":null,"patrimonio_liquido":null,"divida_liquida":null,"capital_giro_liquido":null,"liquidez_corrente":null,"liquidez_geral":null,"endividamento_geral":null,"cobertura_juros":null,"divida_ebitda":null,"rentabilidade_pl":null},"observacoes":"observações relevantes sobre este documento"}],"analise_credito":{"classificacao_risco":"Baixo|Moderado|Alto|Crítico","resumo_executivo":"análise objetiva da saúde financeira em 3-4 frases","capacidade_seguro_garantia":"Alta|Moderada|Baixa|Inapta","justificativa_garantia":"justificativa técnica para seguro garantia","capacidade_fianca_locaticia":"Alta|Moderada|Baixa|Inapta","justificativa_fianca":"justificativa técnica para fiança locatícia","pontos_positivos":["ponto 1","ponto 2"],"pontos_atencao":["ponto 1","ponto 2"],"recomendacao_seguradora":"recomendação técnica objetiva para a seguradora"}}]}

Regras de valores: monetários como número puro em reais (ex: 1500000.50), percentuais como decimal (ex: 25.5 para 25,5%), índices como decimal (ex: 1.45), null quando ausente. Responda sempre em português brasileiro.${blocoTexto ? '\n\nDOCUMENTOS PARA ANÁLISE:\n' + blocoTexto : ''}`;

  let mensagens;
  if (imagens.length > 0) {
    mensagens = [{
      role: 'user',
      content: [
        { type: 'text', text: instrucao },
        ...imagens.map(img => ({ type: 'image_url', image_url: { url: img.conteudo } }))
      ]
    }];
  } else {
    mensagens = [{ role: 'user', content: instrucao }];
  }

  const resp = await fetch(DEEPSEEK_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: mensagens, max_tokens: 8192 }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Erro na API: ' + txt);
  }

  const data = await resp.json();
  let raw = parseDeepSeekContent(data);
  return JSON.parse(raw);
}
