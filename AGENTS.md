# AGENTS.md — TC Lavoro · Instruções para Codex e agentes automatizados

## Regra obrigatória: leia a SPEC antes de qualquer mudança

**Antes de editar qualquer arquivo deste projeto, leia `SPEC.md` na íntegra.**

A spec é a fonte de verdade do projeto. Ela descreve contratos de dados, endpoints, arquitetura de arquivos e regras de segurança. Qualquer mudança feita sem ler a spec pode quebrar fluxos existentes ou violar invariantes críticos.

## Regra obrigatória: atualize a SPEC após qualquer mudança estrutural

Após concluir mudanças que afetem os itens abaixo, atualize `SPEC.md` na mesma tarefa:

- Contratos de JSON de qualquer fluxo IA (Financeiro, Seguro Garantia, Fiança Locatícia)
- Endpoints do Cloudflare Worker em `workers/deepseek-memory-worker.js`
- Novas dependências externas (CDN ou pacotes do Worker)
- Adição, renomeação ou remoção de arquivos
- Lógica de extração/chunking em `deepseek.js`
- Lógica de renderização de resultados em `app.js`
- Estratégia de armazenamento Redis (formato de chave, TTL, estrutura do manifest)

Ao atualizar a spec, incremente a versão menor (ex.: `1.7` → `1.8`) e atualize a data no cabeçalho.

## Estrutura do projeto

```
TC Lavoro/
├── index.html                        SPA estática
├── app.js                            UI, renderização, T&C Dashboard
├── deepseek.js                       Extração de arquivos, envio ao Worker
├── styles.css                        Estilos globais
├── SPEC.md                           FONTE DE VERDADE — leia primeiro
├── CLAUDE.md                         Instruções para Claude Code
├── AGENTS.md                         Este arquivo
├── assets/
│   ├── css/variables.css             Tokens de design (cores, espaçamentos)
│   └── img/
└── workers/
    └── deepseek-memory-worker.js     Cloudflare Worker + Redis
```

## Regras invioláveis

- Secrets (`DEEPSEEK_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) ficam **exclusivamente** no Cloudflare Worker. Nunca expô-los no front-end.
- Todo conteúdo inserido via `innerHTML` deve passar pela função `esc()`.
- Valores monetários usam `fmtBRL()`.
- Não hardcodar cores ou espaçamentos — usar variáveis de `assets/css/variables.css`.
- O fluxo T&C Dashboard não deve ser alterado sem necessidade explícita do usuário.
- Não misturar empresas nem períodos na análise financeira.
- Não alterar contratos de JSON sem atualizar a spec.

## Antes de submeter

1. Confirme que leu `SPEC.md`.
2. Confirme que `SPEC.md` foi atualizado se necessário.
3. Confirme que nenhum secret foi exposto no front-end.
4. Confirme que todo `innerHTML` usa `esc()`.
