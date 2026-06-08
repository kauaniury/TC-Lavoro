# SPEC — TC Lavoro · Limites + IA Documental

> Versão: 1.4  
> Atualizado em: 2026-06-08

## 1. Visão Geral

Aplicação web estática da **Lavoro Seguros** com quatro fluxos independentes:

| Fluxo | Entrada | Saída |
|---|---|---|
| T&C Dashboard | Planilha Excel `.xlsx/.xls` | Dashboard executivo com limites, comparativos e exportação PDF |
| Análise Financeira IA | DRE, Balanço, Balancete, CSV, PDF e imagem | JSON consolidado multiempresa/multiperíodo renderizado em cards |
| Seguro Garantia IA | Edital, contrato, aditivos, apostilamentos, PDF/imagem/planilhas | Análise técnica em formato conversacional |
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

## 6. Fluxo 2 — Análise Financeira IA

### 6.1 Entrada

- máximo de 6 arquivos
- formatos: `.xlsx`, `.xls`, `.csv`, `.pdf`, `.jpg`, `.jpeg`, `.png`

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

### 7.1 Funções públicas

| Função | Responsabilidade |
|---|---|
| `analisarSeguroGarantia(arquivos)` | produz a análise inicial completa |
| `criarHistoricoSeguroGarantia(arquivos, analiseInicial)` | semeia o chat com a análise consolidada |
| `chatSeguroGarantia(history)` | responde perguntas subsequentes do usuário |

### 7.2 Mudança arquitetural

Antes, a análise inicial reenviava todo o conteúdo de uma vez.  
Agora, a análise inicial tenta o fluxo em lotes; o chat posterior conversa sobre a análise consolidada, reduzindo custo e contexto.

## 8. Fluxo 4 — Fiança Locatícia IA

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
