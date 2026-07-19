# SPEC — TC Lavoro · Limites + IA Documental

> Versão: 2.2  
> Atualizado em: 2026-07-18

## 1. Visão Geral

Aplicação web estática da **Lavoro Seguros** com cinco fluxos independentes:

| Fluxo | Entrada | Saída |
|---|---|---|
| T&C Dashboard | Planilha Excel `.xlsx/.xls` | Dashboard executivo com limites, comparativos e exportação PDF |
| Análise Financeira IA | DRE, Balanço, Balancete, CSV, PDF e imagem | JSON consolidado multiempresa/multiperíodo renderizado em cards |
| Seguro Garantia IA | Edital, contrato, aditivos, apostilamentos, PDF/imagem/planilhas | Relatório técnico estruturado (primeira resposta) + chat conversacional + exportação PDF |
| Fiança Locatícia IA | Contrato de locação, aditivos, laudos, PDF/imagem/planilhas | JSON contratual renderizado em tela |
| Consulta de Limites | CNPJ do tomador | Consulta em tempo real dos limites disponíveis em cada seguradora integrada (JNS, Junto, Onpoint/Essor/Sombrero/NEWE/Mitsui, AXA, Fator) |

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
- Toda navegação da SPA deve continuar usando apenas `switchTab('upload' | 'dashboard' | 'analise-financeira' | 'seguro-garantia' | 'fianca-locaticia' | 'consulta-limites')`.
- Credenciais das APIs de seguradoras (`JNS_*`, `JUNTO_*`, `ONPOINT_*`, `FATOR_*`) seguem a mesma regra: só existem como secrets do Worker, nunca no front-end.
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

## 9. Fluxo 5 — Consulta de Limites por Seguradora

### 9.0 Visão geral

Consulta em tempo real (sem upload de arquivo) do limite disponível para um CNPJ em cada seguradora integrada. O front-end envia apenas `{ cnpj, seguradoras[] }` para o Worker; toda credencial fica nos secrets do Worker.

### 9.1 Front-end

- Aba `consulta-limites` (`index.html`), sem dependência de IA/chat.
- Campo de CNPJ + checkboxes de seguradoras + botão "Consultar".
- `deepseek.js`: `consultarLimitesSeguradoras(cnpj, seguradoras)` — `POST` para `${DEEPSEEK_WORKER_URL}/v1/limits/query`.
- `app.js`: `consultarLimitesUI()` valida CNPJ (14 dígitos) e ao menos 1 seguradora selecionada, chama `consultarLimitesSeguradoras` e renderiza via `renderLimitesResults(data)`.
- **Importante:** o schema de resposta de cada seguradora (`dados`) ainda não foi normalizado por seguradora — o front-end exibe o JSON bruto retornado por cada uma (`<pre class="lim-raw-json">`) porque os endpoints de consulta de cada seguradora não têm o formato de resposta documentado, apenas o request. Ao validar uma consulta real, extrair os campos de limite/modalidade de cada seguradora e atualizar `renderLimitesResults` para uma tabela normalizada.

### 9.2 Worker — endpoint

#### `POST /v1/limits/query`

Body:
```json
{ "cnpj": "00000000000000", "seguradoras": ["jns","junto","essor","sombrero","newe","mitsui","axa","fator"] }
```
`seguradoras` é opcional — se omitido, consulta todas as 8.

Resposta:
```json
{
  "version": "...",
  "cnpj": "00000000000000",
  "consultadoEm": "ISO-8601",
  "resultados": [
    { "seguradora": "jns", "label": "JNS Seguros", "status": "ok", "dados": { } },
    { "seguradora": "junto", "label": "Junto Seguros", "status": "erro", "erro": "mensagem" }
  ]
}
```

### 9.3 Seguradoras integradas e autenticação

| Seguradora(s) | Chave interna | Autenticação | Secrets |
|---|---|---|---|
| JNS Seguros | `jns` | login (`username`+`password`+`token`) → Bearer, com retry automático em `401` | `JNS_USERNAME`, `JNS_PASSWORD`, `JNS_TOKEN` |
| Junto Seguros | `junto` | `clientId`+`clientSecret` → `accessToken`; cadastra o tomador automaticamente se `policyholders/{cnpj}` ainda não existir | `JUNTO_CLIENT_ID`, `JUNTO_CLIENT_SECRET` |
| Essor / Sombrero / NEWE / Mitsui Sumitomo (via Onpoint) | `essor`, `sombrero`, `newe`, `mitsui` | header fixo `application-key-v2`, sem login | `ONPOINT_APPLICATION_KEY_V2`, `ONPOINT_BROKER_CNPJ` |
| AXA (via Onpoint, rota dedicada `/axa/...`) | `axa` | mesma auth do Onpoint acima | idem |
| Fator Seguradora | `fator` | OAuth2 `client_credentials` (Basic + `grant_type=client_credentials`) → Bearer | `FATOR_CLIENT_ID`, `FATOR_CLIENT_SECRET`, `FATOR_CORRETOR_ID`, `FATOR_NM_LOGIN` |

**Regra crítica — Onpoint/AXA não aceitam chamadas paralelas para o mesmo CNPJ.** O Worker consulta `jns`/`junto`/`fator` em paralelo (`Promise.all`) mas processa `essor`/`sombrero`/`newe`/`mitsui`/`axa` sequencialmente num loop `for...of`.

### 9.4 Cache de token no Redis

Tokens de login (JNS, Junto, Fator) são cacheados no Redis para evitar novo login a cada consulta:

| Chave | TTL |
|---|---|
| `limits:token:jns` | 25 min (fixo — API não informa `expires_in`) |
| `limits:token:junto` | `expiresIn` da resposta menos 30s de margem |
| `limits:token:fator` | `expires_in` da resposta menos 30s de margem |

Em caso de `401`, o token é invalidado e a consulta refeita uma vez com login novo.

### 9.5 Onpoint — IDs estáticos de seguradora

| Seguradora | `InsuranceUniqueId` |
|---|---|
| Essor Seguros S.A. | `406fecd8-bfd7-4cba-a9bd-87efcfd38288` |
| SOMBRERO SEGUROS S/A | `7e3b3e1a-e0db-4067-876f-350f73a38acd` |
| NEWE Seguros S.A. | `d53bda2d-0710-4bff-b5be-51f2ab377362` |
| Mitsui Sumitomo Seguros S.A. | `ff4a046b-d047-4bec-9253-1e3bc83c2df1` |
| AXA Seguros S.A. | `555b5249-1f74-4681-9f49-5958ad720cfb` (rota própria) |

## 10. Dependências Externas

| Biblioteca | Versão | Uso |
|---|---|---|
| Chart.js | 4.4.1 | gráficos |
| XLSX.js | 0.18.5 | leitura de Excel |
| html2canvas | 1.4.1 | captura para PDF |
| jsPDF | 2.5.1 | geração de PDF |
| PDF.js | 3.11.174 | extração de texto de PDFs |

## 11. Observações de Deploy

- O front-end já está preparado para o Worker novo.
- Para ativar memória Redis de fato em produção, é necessário publicar `workers/deepseek-memory-worker.js` no mesmo domínio do Worker atual ou atualizar `DEEPSEEK_WORKER_URL`.
- Se o Worker novo ainda não estiver publicado, o front-end usa fallback automático para o endpoint legado `/`.
- Para a Consulta de Limites, publicar o Worker atualizado (`/v1/limits/query`) e configurar todos os secrets listados na seção 9.3, incluindo `ONPOINT_BROKER_CNPJ` e `FATOR_CORRETOR_ID`.
- CORS do Worker hoje libera `Access-Control-Allow-Origin: '*'` para todos os endpoints. Como a Consulta de Limites expõe dados de crédito mais sensíveis que o proxy de IA, considerar restringir a origem ao domínio de produção do front-end.
