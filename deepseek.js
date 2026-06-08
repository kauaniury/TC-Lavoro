const DEEPSEEK_WORKER_URL = 'https://lucky-hat-b241.kyuri887.workers.dev/';

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
    const maxPaginas = Math.min(pdf.numPages, 15);
    for (let i = 1; i <= maxPaginas; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      texto += content.items.map(item => item.str).join(' ') + '\n';
    }
    return { tipo: 'texto', conteudo: texto.trim().slice(0, 10000) };
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

async function analisarDocumentosFinanceiros(arquivos) {
  const extraidos = await Promise.all(
    arquivos.map(async file => ({ nome: file.name, ...await extrairConteudoArquivo(file) }))
  );

  const textuais = extraidos.filter(a => a.tipo === 'texto');
  const imagens  = extraidos.filter(a => a.tipo === 'imagem');

  const blocoTexto = textuais.length
    ? textuais.map((a, i) => `--- ARQUIVO ${i + 1}: ${a.nome} ---\n${a.conteudo}`).join('\n\n')
    : '';

  const instrucao = `Você é um analista financeiro sênior brasileiro. Analise os documentos financeiros fornecidos e retorne APENAS um JSON válido, sem markdown, sem explicação, com esta estrutura exata:

{"tipo_documento":"DRE|Balanço Patrimonial|Balancete|Misto","empresa":null,"periodo":null,"indicadores":{"receita_bruta":null,"receita_liquida":null,"lucro_bruto":null,"lucro_liquido":null,"ebitda":null,"margem_bruta":null,"margem_liquida":null,"ativo_total":null,"passivo_total":null,"patrimonio_liquido":null,"liquidez_corrente":null,"liquidez_geral":null,"endividamento_geral":null,"rentabilidade_pl":null},"resumo_executivo":"string","pontos_positivos":["string"],"pontos_atencao":["string"],"recomendacao":"string","classificacao_risco":"Baixo|Moderado|Alto|Crítico"}

Regras: valores monetários em número puro (ex: 1500000), percentuais como número (ex: 25.5 para 25,5%), null quando não disponível. Responda em português brasileiro.${blocoTexto ? '\n\nDOCUMENTOS:\n' + blocoTexto : ''}`;

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
    body: JSON.stringify({ model: 'deepseek-chat', messages: mensagens, temperature: 0.1, max_tokens: 2000 }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Erro na API: ' + txt);
  }

  const data = await resp.json();
  let raw = data.choices[0].message.content.trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(raw);
}
