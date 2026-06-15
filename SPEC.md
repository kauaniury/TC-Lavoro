# SPEC — TC Lavoro · Limites + IA Documental

> Versão: 2.3  
> Atualizado em: 2026-06-15

## 1. Visão Geral

Aplicação web estática da **Lavoro Seguros** com quatro fluxos independentes:

| Fluxo | Entrada | Saída |
|---|---|---|
| T&C Dashboard | Planilha Excel `.xlsx/.xls` | Dashboard executivo com limites, comparativos e exportação PDF |
| Análise Financeira IA | DRE, Balanço, Balancete, CSV, PDF e imagem | JSON consolidado multiempresa/multiperíodo renderizado em cards |
| Seguro Garantia IA | Edital, contrato, aditivos, apostilamentos, PDF/imagem/planilhas | Relatório técnico estruturado (primeira resposta) + chat conversacional + exportação PDF |
| Fiança Locatícia IA | Contrato de locação, aditivos, laudos, PDF/imagem/planilhas | JSON contratual renderizado em tela |

O fluxo **T&C** continua estável e não deve ser alterado sem necessidade explícita.

## 2. Arquitetura de Arquivos

```text
TC Lavoro/
├── index.html
├── app.js
├── deepseek.js
├── styles.css
├── SPEC.md
├── AGENTS.md
├── CLAUDE.md
├── assets/
│   ├── css/
│   │   ├── variables.css
│   │   └── base.css
│   └── img/
└── workers/
    └── deepseek-memory-worker.js
```

## 3. Regras Críticas

### 3.1 Segurança

- Nunca expor `DEEPSEEK_API_KEY`, `UPSTASH_REDIS_REST_URL` ou `UPSTASH_REDIS_REST_TOKEN` no front-end.
- Secrets ficam somente no Cloudflare Worker.
- Toda navegação da SPA deve continuar usando apenas `switchTab('upload' | 'dashboard' | 'analise-financeira' | 'seguro-garantia' | 'fianca-locaticia')`.
- Toda string inserida em `innerHTML` deve passar por `esc()`.

### 3.2 Front-end

- Usar `fmtBRL()` para monetários em PT-BR.
- Não hardcodar cores/espaçamentos; usar `assets/css/variables.css`.
- `app.js` deve permanecer em UTF-8.

### 3.3 IA / Dados

- Não alterar a estrutura final do JSON sem atualizar esta spec.
- Não misturar empresas nem períodos na análise financeira.
- O Worker pode iterar por partes, mas o resultado final deve respeitar o contrato atual do front-end.

## 4. Fluxo 1 — T&C Dashboard

Mantido sem alteração estrutural.

### 4.1 Parsing

- `handleFile(file)` valida e lê `.xlsx/.xls`
- `parseWorkbook(wb)` localiza cabeçalho `SEGURADORA(S)` e extrai:
  - `tomador`
  - `cnpj`
  - `rows[]`
- Modalidades adicionais entram em `modalidades[]` do registro principal

### 4.2 Estrutura Parsed

```js
{
  rows: [
    {
      seguradora: string,
      status: 'aprovado' | 'declinado' | 'concorrente' | 'bloqueado',
      limite: number,
      modalidade: string,
      valorModal: number,
      taxa: number | string | null,
      venc: string | null,
      modalidades: [{ label, value, taxa }]
    }
  ],
  tomador: string | null,
  cnpj: string | null
}
```

## 5. Fluxos IA

### 5.1 Proxy Cloudflare Worker

URL atual do front-end:

```txt
https://lucky-hat-b241.kyuri887.workers.dev/
```

O front-end agora possui dois modos:

1. **Modo novo**: cria jobs em `/v1/analysis-jobs`, processa em lotes e usa Redis como memória temporária.
2. **Fallback legado**: se o Worker ainda não expuser os endpoints novos, usa a chamada monolítica anterior no `/`.

### 5.1a Modelo e tokens por fluxo

| Fluxo | Chunk (`analyzeChunk`) | Síntese final (`synthesizeFinalResult`) |
|---|---|---|
| Análise Financeira | deepseek-chat / 4.000 tokens | deepseek-chat / 8.000 tokens |
| Seguro Garantia | deepseek-chat / 4.000 tokens | deepseek-chat / **10.000 tokens** |
| Fiança Locatícia | deepseek-chat / 4.000 tokens | deepseek-chat / 8.000 tokens |

### 5.2 Worker com Memória Redis

Arquivo versionado no repositório:

```txt
workers/deepseek-memory-worker.js
```

Responsabilidades:

- receber arquivos já extraídos/chunkados pelo browser
- persistir estado do job no Redis
- persistir o texto completo de cada chunk separadamente no Redis
- processar partes sequencialmente
- armazenar notas parciais por chunk
- sintetizar resultado final só após o documento completo
- expor `version` em respostas do Worker para auditoria de deploy

Secrets esperados no Worker:

- `DEEPSEEK_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Modelo no Worker:

- **Análise de chunks** (`analyzeChunk`): usa `deepseek-chat` diretamente — mais rápido, sem overhead de chain-of-thought que esgotaria o budget de tokens e retornaria `content` vazio.
- **Síntese final** (`synthesizeFinalResult`): usa `deepseek-reasoner` com fallback automático para `deepseek-chat` se a API responder erro de modelo inexistente/não suportado.
- `extractMessageContent` usa `reasoning_content` como fallback caso `content` chegue vazio (defesa extra para o reasoner).

### 5.3 Endpoints do Worker

#### `POST /`

Proxy legado da DeepSeek. Mantido para compatibilidade com chat e fallback.

#### `POST /v1/analysis-jobs`

Cria um job de análise em lotes.

Body:

```json
{
  "flow": "analise-financeira | seguro-garantia | fianca-locaticia",
  "files": [
    {
      "nome": "arquivo.pdf",
      "tipo": "texto",
      "conteudo": "texto completo opcional",
      "partes": [
        {
          "indice": 1,
          "rotulo": "Pagina 1 - parte 1",
          "pagina": 1,
          "conteudo": "trecho..."
        }
      ],
      "meta": {
        "origem": "pdf",
        "totalPaginas": 42,
        "totalPartes": 58
      }
    }
  ]
}
```

#### `POST /v1/analysis-jobs/:jobId/run`

Executa um passo do job:

- processa o próximo chunk, ou
- finaliza a síntese quando todos os chunks já foram lidos

#### `GET /v1/analysis-jobs/:jobId`

Consulta status do job.

#### `GET /health`

Healthcheck simples do Worker. Deve retornar `ok`, `worker` e `version`.

### 5.4 Extração no Front-end

Implementada em `deepseek.js`.

#### Funções principais

| Função | Responsabilidade |
|---|---|
| `extrairConteudoArquivo(file)` | roteia por extensão |
| `extrairExcel(file)` | converte abas para CSV e divide em partes |
| `extrairTexto(file)` | lê UTF-8 e divide em partes |
| `extrairPDF(file)` | extrai até 250 páginas via PDF.js e agrupa várias páginas por chunk para reduzir latência |
| `extrairImagem(file)` | gera DataURL |
| `executarAnaliseEmLotes(flow, arquivos)` | cria job e itera até concluir |

### 5.5 Estratégia para PDFs grandes

Antes:

- PDF era consolidado em uma string única
- havia corte de caracteres
- uma única chamada tentava analisar tudo

Agora:

- PDF é lido página a página
- páginas consecutivas são agrupadas em chunks maiores
- cada chunk vira uma unidade de trabalho no Worker
- o Worker só finaliza após consumir todos os chunks

Isso reduz estouro de contexto e cria memória transacional da análise no Redis.

### 5.6 Arquitetura Redis — chaves e tamanho do manifest

**Convenção de chaves:**

| Chave | Conteúdo |
|---|---|
| `deepseek:job:{jobId}` | Manifest do job (metadados, status, índices) |
| `deepseek:job:{jobId}:chunk:{index}` | Conteúdo textual bruto de cada chunk |
| `deepseek:job:{jobId}:note:{index}` | Nota gerada pela IA para cada chunk |

TTL de todas as chaves: 6 horas (`JOB_TTL_SECONDS`).

**Regra crítica:** as notas de chunk **nunca devem ficar dentro do manifest**. Com 10 arquivos e 50–100 chunks, cada nota pode ter ~16KB (4.000 tokens). Armazenar tudo no manifest resultaria em 800KB–1,6MB por `SETEX`, ultrapassando os limites do Upstash. Cada nota é salva como `noteKey(jobId, index)` e recuperada individualmente na síntese final.

**Chamadas Redis — formato POST body obrigatório:**

A função `redisCall` usa **POST body** para enviar comandos ao Upstash REST API:

```js
fetch(UPSTASH_REDIS_REST_URL, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(command),   // ex.: ["SETEX", "key", "21600", "{...json...}"]
})
```

**Nunca usar path params** (formato `GET /{cmd}/{arg1}/{arg2}`) — o valor JSON encodado na URL ultrapassa os limites de tamanho (~8–32KB de URL).

## 6. Fluxo 2 — Análise Financeira IA

### 6.1 Entrada

- máximo de 6 arquivos (`MAX_FINANCIAL_FILES`)
- formatos: `.xlsx`, `.xls`, `.csv`, `.pdf`, `.jpg`, `.jpeg`, `.png`

### 6.1a Regra crítica de escala — "em milhares"

O prompt de chunk (`analise-financeira`) detecta se o documento indica escala em milhares no título/cabeçalho (`"em milhares"`, `"R$ Mil"`, `"Em R$ Mil"`, etc.) e registra `"escala":"milhares"` na nota. O prompt de síntese final multiplica todos os valores monetários desse documento por 1.000 antes de incluir no JSON final e registra o ajuste em `"observacoes"`.

### 6.1b Renderização — Indicadores Financeiros

`buildDocumentoCard` renderiza os 20 indicadores como tabela 2 colunas (label | valor):
- Linhas com `.af-kpi-row--priority` destacadas (campos principais)
- Linhas com `.af-kpi-row--empty` esmaecidas (valor null → "—")
- Linhas com `.af-kpi-row--neg` em vermelho (valor negativo)

### 6.2 Função pública

```js
analisarDocumentosFinanceiros(arquivos)
```

Comportamento:

- tenta análise em lotes com job Redis
- se o Worker novo não estiver publicado, faz fallback para o fluxo legado

### 6.3 JSON Final Esperado

```json
{
  "empresas": [
    {
      "empresa": "Nome da empresa",
      "cnpj": "XX.XXX.XXX/XXXX-XX",
      "documentos": [
        {
          "tipo": "DRE | Balanço Patrimonial | Balancete",
          "periodo": "2023",
          "indicadores": {
            "receita_bruta": null,
            "receita_liquida": null,
            "lucro_bruto": null,
            "lucro_liquido": null,
            "ebitda": null,
            "margem_ebitda": null,
            "margem_liquida": null,
            "ativo_total": null,
            "ativo_circulante": null,
            "passivo_total": null,
            "passivo_circulante": null,
            "patrimonio_liquido": null,
            "divida_liquida": null,
            "capital_giro_liquido": null,
            "liquidez_corrente": null,
            "liquidez_geral": null,
            "endividamento_geral": null,
            "cobertura_juros": null,
            "divida_ebitda": null,
            "rentabilidade_pl": null
          },
          "observacoes": "string"
        }
      ],
      "analise_credito": {
        "classificacao_risco": "Baixo | Moderado | Alto | Crítico",
        "resumo_executivo": "string",
        "capacidade_seguro_garantia": "Alta | Moderada | Baixa | Inapta",
        "justificativa_garantia": "string",
        "capacidade_fianca_locaticia": "Alta | Moderada | Baixa | Inapta",
        "justificativa_fianca": "string",
        "pontos_positivos": ["string"],
        "pontos_atencao": ["string"],
        "recomendacao_seguradora": "string"
      }
    }
  ]
}
```

## 7. Fluxo 3 — Seguro Garantia IA

### 7.0 Entrada

- máximo de 10 arquivos (`MAX_CONTRATO_FILES`)
- formatos: `.pdf`, `.png`, `.jpg`, `.jpeg`, `.xlsx`, `.xls`, `.csv`

### 7.1 Funções públicas (deepseek.js)

| Função | Responsabilidade |
|---|---|
| `analisarSeguroGarantia(arquivos)` | produz a análise inicial completa via Worker em lotes |
| `criarHistoricoSeguroGarantia(arquivos, analiseInicial)` | semeia o chat com a análise consolidada |
| `chatSeguroGarantia(history)` | responde perguntas subsequentes do usuário |

### 7.1a Prompt de síntese — Seguro Garantia

O prompt final produz uma análise técnica completa em markdown com 12 seções numeradas:

1. Classificação do documento
2. Modalidade sugerida
3. Partes identificadas (tabela: Papel | Nome/Razão Social | CPF/CNPJ | Fonte)
4. Dados principais para emissão (tabela: Campo | Informação | Fonte/Trecho | Confiança)
5. Cálculo da importância segurada
6. Vigência recomendada
7. Objeto sugerido para a apólice
8. Cláusulas e coberturas recomendadas (tabela)
9. Pontos de atenção
10. Documentos ou informações pendentes
11. Conclusão operacional
12. Resumo final para cadastro *(seção especial — fundo verde escuro + campos monoespaçados)*

A seção 12 é renderizada por `renderResumoFinalSection` como grade de campos `label: valor`, não como markdown genérico.

### 7.2 Funções de renderização (app.js)

| Função | Responsabilidade |
|---|---|
| `renderSeguroGarantiaReport(text)` | entry-point: constrói todo o HTML do relatório (masthead, badge de veredicto, seções) |
| `parseReportSections(text)` | divide o markdown por `##` em `[{ title, content }]` |
| `getSectionMeta(title)` | mapeia título para tipo: `dados \| modalidades \| clausulas \| riscos \| parecer \| resumo \| default` |
| `getSectionSvgIcon(type)` | retorna SVG inline por tipo de seção |
| `detectVerdictFromText(text)` | detecta veredicto no texto e retorna `{ cls, label, icon }` para Emitir / Ressalvas / Declinar |
| `renderReportSection(section)` | renderiza um card de seção com cabeçalho com ícone e corpo em markdown |
| `renderReportMarkdown(text)` | markdown aprimorado: tabelas pipe `\| … \|`, `---` HR, headings, bullets, negrito |
| `downloadSgReport()` | exportação A4 multi-página via html2canvas + jsPDF |
| `syncAiChatStickyOffset()` | mede a topbar ativa do relatório e atualiza `--ai-sidebar-sticky-top` para manter o chat lateral visível abaixo dela |

### 7.3 Arquitetura de renderização

A primeira mensagem da IA no chat é renderizada como **relatório completo** (`div.sg-report-wrapper`). Mensagens subsequentes (perguntas e respostas do chat) usam o layout de balão padrão (`sg-chat-msg--user` / `sg-chat-msg--ai`).

Controlado pela flag `sgFirstAnalysis` em `app.js`:

```js
// primeiro assistente → relatório estruturado
if (role === 'assistant' && sgFirstAnalysis) {
  div.className = 'sg-report-wrapper';
  div.innerHTML = renderSeguroGarantiaReport(text);
  sgFirstAnalysis = false;
  // exibe botão "Exportar PDF"
} else {
  div.className = 'sg-chat-msg ' + (role === 'user' ? 'sg-chat-msg--user' : 'sg-chat-msg--ai');
}
```

Um divisor visual (`.sg-chat-divider` com texto "Perguntas sobre a análise") é inserido antes da primeira mensagem do usuário após o relatório.

### 7.4 Estrutura visual do relatório

```
.sg-report-wrapper               ← fade-in, outer container
  .sg-report                     ← white card, shadow, border-radius
    .sg-report-masthead           ← dark green (#192b24) + gold bottom line
      .sg-report-verdict-badge   ← verde (Emitir) / âmbar (Ressalvas) / vermelho (Declinar)
    .sg-report-section × N       ← um card por seção ##
      .sg-report-section-head    ← fundo cinza claro + ícone colorido + título serif
      .sg-report-section-body    ← corpo em markdown com tabelas e bullets
```

Seção `##Parecer Geral` recebe `sg-report-section--parecer` (fundo invertido escuro).

### 7.4a Chat Sidebar — Anexo de arquivos e imagens

Os três sidebars de Q&A (Seguro Garantia, Fiança Locatícia, Análise Financeira) suportam anexo de arquivos durante o chat:

- **Botão de clipe** (`ai-chat-attach-btn`) abre o seletor de arquivos: `.pdf .png .jpg .jpeg .xlsx .xls .csv .txt`
- **Drag-and-drop** na área de input (`ai-sidebar-input-area`) — IDs: `sgInputArea`, `flInputArea`, `afInputArea`
- **Chips visuais** (`ai-chat-file-chip`) exibem arquivos pendentes; podem ser removidos individualmente
- Ao enviar: `_buildChatMessage(flow, text)` extrai conteúdo via `extrairConteudoArquivo()`:
  - Imagens → `{type:'image_url', image_url:{url: base64}}` no array de content
  - Textuais → conteúdo extraído prefixado ao texto da mensagem
- Estado: `_chatFiles = { sg:[], fl:[], af:[] }` — limpo ao enviar e ao "Nova análise"
- O sidebar usa `--ai-sidebar-sticky-top`, calculado por `syncAiChatStickyOffset()`, para permanecer abaixo da topbar ativa do relatório durante o scroll.
- O cabeçalho do sidebar (`.ai-chat-sidebar-header`) permanece visível com `position: sticky`, acompanhando o scroll no topo do card de chat.

### 7.5 Exportação PDF

- Botão "Exportar PDF" (`#sgExportBtn`) fica oculto até a primeira análise ser renderizada.
- Localizado na `.sg-chat-topbar-actions` (flex, lado direito da topbar).
- `downloadSgReport()` usa `html2canvas` para capturar `.sg-report` e `jsPDF` para gerar A4 multi-página (divisão inteligente de página a cada 297 mm de conteúdo).

### 7.6 Mudança arquitetural original

Antes, a análise inicial reenviava todo o conteúdo de uma vez.  
Agora, a análise inicial tenta o fluxo em lotes; o chat posterior conversa sobre a análise consolidada, reduzindo custo e contexto.

## 8. Fluxo 4 — Fiança Locatícia IA

### 8.0 Entrada

- máximo de 10 arquivos (`MAX_CONTRATO_FILES`)
- formatos: `.pdf`, `.png`, `.jpg`, `.jpeg`, `.xlsx`, `.xls`, `.csv`

### 8.1 Função pública

```js
analisarFiancaLocaticia(arquivos)
```

### 8.2 Contrato JSON Final

```json
{
  "tipo": "Fiança Locatícia",
  "documentos_analisados": ["arquivo.pdf"],
  "dados_gerais": {
    "imovel": { "valor": "string|null", "fonte": "string" },
    "locatario": { "valor": "string|null", "fonte": "string" },
    "locador": { "valor": "string|null", "fonte": "string" },
    "finalidade": { "valor": "string|null", "fonte": "string" },
    "valor_aluguel": { "valor": 0, "fonte": "string" },
    "encargos_mensais": { "valor": "string|null", "fonte": "string" },
    "valor_garantia": { "valor": 0, "fonte": "string" },
    "vigencia_inicio": { "valor": "DD/MM/AAAA|null", "fonte": "string" },
    "vigencia_fim": { "valor": "DD/MM/AAAA|null", "fonte": "string" },
    "indice_reajuste": { "valor": "string|null", "fonte": "string" },
    "multa_rescisao": { "valor": "string|null", "fonte": "string" },
    "sub_rogacao": { "valor": "string|null", "fonte": "string" },
    "foro": { "valor": "string|null", "fonte": "string" }
  },
  "clausulas_criticas": [
    {
      "titulo": "string",
      "descricao": "string",
      "fonte": "string",
      "impacto": "Alto | Médio | Baixo"
    }
  ],
  "riscos": [
    {
      "descricao": "string",
      "fonte": "string",
      "nivel": "Alto | Médio | Baixo"
    }
  ],
  "parecer": {
    "recomendacao": "Emitir | Emitir com ressalvas | Declinar",
    "justificativa": "string",
    "condicoes": ["string"]
  },
  "resumo": "string"
}
```

## 9. Dependências Externas

| Biblioteca | Versão | Uso |
|---|---|---|
| Chart.js | 4.4.1 | gráficos |
| XLSX.js | 0.18.5 | leitura de Excel |
| html2canvas | 1.4.1 | captura para PDF |
| jsPDF | 2.5.1 | geração de PDF |
| PDF.js | 3.11.174 | extração de texto de PDFs |

## 10. Observações de Deploy

- O front-end já está preparado para o Worker novo.
- Para ativar memória Redis de fato em produção, é necessário publicar `workers/deepseek-memory-worker.js` no mesmo domínio do Worker atual ou atualizar `DEEPSEEK_WORKER_URL`.
- Se o Worker novo ainda não estiver publicado, o front-end usa fallback automático para o endpoint legado `/`.
