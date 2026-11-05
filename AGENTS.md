# AGENTS.md — opencode-codex-wait

## Objetivo

Manter um plugin pequeno, previsível e seguro que aguarda um reset **explicitamente informado** por respostas de limite do Codex OAuth no OpenCode 2.x. O plugin pode coexistir com `opencode-claudinio`.

## Regras para agentes

1. **Preserve a solicitação original.** Não envie mensagens `continue`, não crie prompts e não altere modelo ou conta. Use o hook nativo `retry`.
2. Só altere o retry para sinais específicos de `usage_limit_reached` ou `subscription_sharing_usage_limit_exceeded` associados ao provedor `openai`, ou headers `x-codex-*` válidos. **Nunca intercepte qualquer HTTP 429 genericamente.**
3. Sem reset explícito, não invente um horário. O fallback é opcional, limitado e desabilitado por padrão.
4. Não grave OAuth tokens, chaves, cookies, headers, corpos de respostas ou mensagens completas em logs, arquivos ou testes.
5. Mantenha o parser e o relógio separados da integração OpenCode; testes devem ser offline e determinísticos.
6. Use JavaScript ESM simples, Node >=20 e sem dependências extras além do SDK. Respeite o limite de timers e de tentativas nativas.
7. Não prometa retomada após reinício nem após término da sessão. Uma implementação durável exige controle de duplicidade, cancelamento e proteção contra efeitos colaterais.
8. Antes de alterações no adaptador, verifique a documentação atual: https://opencode.ai/v2/docs/build/plugins/server/.
9. Execute `node --test` antes de concluir. Não provoque erros reais de quota no CI.
10. Atualize README, `.agents/` e issues quando houver mudança de comportamento. Não mude compatibilidade declarada sem teste correspondente.

## Estrutura

- `src/parser.js`: identificação de erros Codex OAuth e interpretação de headers/reset.
- `src/retry.js`: capturas temporárias, cálculo de delay, limites de segurança.
- `src/server.js`: registro e descarte dos hooks do OpenCode 2.x.
- `src/index.js`: ponto de entrada do pacote.
- `test/`: testes simulados, sem rede e sem credenciais.
- `.agents/`: memória técnica, roadmap e plano de validação.

## Critérios de aceite

- Um 429 reconhecido com `resets_in_seconds: 3126` define cerca de 3.131.000 ms (menos tempo transcorrido), incluindo margem padrão.
- O retry permanece na sessão/modelo originais, sem prompt artificial.
- Erros genéricos ou de outros provedores não são modificados.
- Sem reset informado, o comportamento padrão não agenda espera fictícia.
- O plugin funciona ao lado do `opencode-claudinio` sem assumir controle dos erros dele.
