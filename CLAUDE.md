# CLAUDE.md — TC Lavoro · Instruções para Claude Code

## Regra obrigatória: leia a SPEC antes de qualquer mudança

**Antes de editar qualquer arquivo deste projeto, leia `SPEC.md` na íntegra.**

A spec é a fonte de verdade do projeto. Ela define:
- Arquitetura de arquivos
- Contratos de JSON de cada fluxo (Financeiro, Seguro Garantia, Fiança Locatícia)
- Regras de segurança (secrets no Worker apenas, `esc()` em `innerHTML`, etc.)
- Endpoints do Cloudflare Worker e Redis
- Estratégia de chunking de PDFs e fluxo em lotes

## Regra obrigatória: atualize a SPEC após qualquer mudança estrutural

Se você alterar qualquer um dos itens abaixo, atualize `SPEC.md` imediatamente na mesma sessão:

- Estrutura de JSON produzido ou consumido por qualquer fluxo IA
- Novos endpoints no Worker (`deepseek-memory-worker.js`)
- Novas dependências externas (CDN ou Worker)
- Mudança nos arquivos do projeto (novo arquivo, renomeação, remoção)
- Mudança na lógica de extração/chunking em `deepseek.js`
- Mudança na lógica de renderização de resultados em `app.js`
- Mudança na arquitetura Redis (formato de chave, TTL, estratégia de armazenamento)

## Contexto rápido do projeto

| Arquivo | Papel |
|---|---|
| `index.html` | SPA estática — estrutura de abas e modais |
| `app.js` | Lógica de UI, renderização, T&C Dashboard |
| `deepseek.js` | Extração de arquivos no browser, envio para Worker |
| `styles.css` | Estilos — não hardcodar cores, usar `assets/css/variables.css` |
| `workers/deepseek-memory-worker.js` | Cloudflare Worker: proxy DeepSeek + jobs Redis |
| `SPEC.md` | **Fonte de verdade** — leia primeiro, atualize sempre |

## Regras críticas (resumo)

- Secrets (`DEEPSEEK_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) ficam **somente** no Worker.
- Todo `innerHTML` passa por `esc()`.
- Monetários usam `fmtBRL()`.
- O fluxo T&C Dashboard não deve ser alterado sem necessidade explícita.
- Não misturar empresas nem períodos na análise financeira.

## Sobre a spec

A spec em `SPEC.md` é versionada. Ao atualizá-la, incremente a versão menor (ex.: `1.7` → `1.8`) e atualize a data no cabeçalho.
