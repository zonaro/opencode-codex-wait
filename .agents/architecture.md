# Arquitetura — Codex OAuth wait

## Problema

As contas ChatGPT usadas no Codex/OpenCode possuem limites de uso distintos dos limites de API key. Alguns erros 429 incluem `usage_limit_reached` com `resets_at`/`resets_in_seconds` ou headers `x-codex-*`; outros, como `subscription_sharing_usage_limit_exceeded`, não garantem horário. Retentativas rápidas podem esgotar o limite interno do OpenCode antes do reset.

## Fluxo implementado

```text
OpenAI/Codex OAuth HTTP 429
  → http.response (verifica provider, copia corpo até limite, lê headers)
  → parser (exige sinal de limite e calcula reset absoluto)
  → cache efêmero por sessão/provedor/modelo/variante
  → retry (combina observação com erro nativo, calcula tempo restante)
  → event.decision = { retry: true, delay }
  → mecanismo nativo OpenCode repete a mesma requisição
```

### Acompanhamento da quota sem polling

```text
Qualquer resposta HTTP de modelo OpenAI (inclui sucesso)
  → http.response lê SOMENTE headers x-codex-*-used-percent/window-minutes/reset-at
  → src/quota.js valida percentuais, durações e timestamps
  → snapshot efêmero por sessão/provedor/modelo/variante (TTL: 5 min)
  → sem chamadas adicionais, sem serializar dados no disco

429 de assinatura reconhecido sem reset no corpo/headers atuais
  → procurar janela explicitamente 100% esgotada no snapshot recente
  → se não houver, iniciar codex app-server apenas sob demanda
  → initialize → initialized → account/rateLimits/read
  → timeout 5 s e cooldown 60 s compartilhado; não faz inferência
  → usa reset somente se houver janela esgotada
  → falha/mismatch/ausência: orientar uso manual de /status (sem retry fictício)
```

O nome `primary` ou `secondary` não determina duração. O parser identifica janelas de 5 horas (300 minutos), 7 dias (10080 minutos) ou outras diretamente pelo `windowDurationMins`. Para duas janelas esgotadas, usa o horário mais tardio.

`/status` é comando interativo da TUI; executá-lo via `codex exec` seria incorreto, pois dispararia geração. A consulta equivalente é o RPC local do app-server, mediante autenticação **pré-existente e separada** no Codex CLI. O plugin não lê nem movimenta credenciais. O RPC pertence ao Codex oficial, enquanto `/wham/usage` e `/api/codex/usage` são rotas internas não utilizadas pelo plugin.

No erro de streaming, o retry pode carregar somente `event.error.message`; o parser aceita JSON serializado ou mensagem contendo o código específico, se o SDK não repassar a resposta original. O plugin não inspeciona tokens de autenticação e não usa prompt de recuperação. O único acesso ativo a estado de conta é o RPC local e opcional do app-server quando a falha requer fallback.

## Proteções

- Restringe a `model.providerID === "openai"` e assinatura Codex OAuth; outros provedores ignorados.
- Exige erro conhecido ou headers Codex específicos; `Retry-After` sozinho não basta.
- `resets_at` interpretado como timestamp Unix em segundos; `resets_in_seconds` como duração. Datas expiradas/invalidas ignoradas.
- Quando há várias informações confiáveis, usa o horário mais tardio para não adiantar o retry.
- Default de 8 dias para cobrir janelas longas; cap configurável até 14 dias e limite do timer Node.
- Capturas expiram após 30s, são consumidas uma única vez e limitadas a 100 entradas.
- Estado de quota expira em 5 minutos, é somente em memória e limitado a 100 entradas.
- O fallback RPC ocorre somente em 429 reconhecidos sem informação de reset e respeita timeout/cooldown; indisponibilidade do binário não quebra o hook.
- Nenhum corpo, header ou credencial é persistido. Logs mostram somente identificador de sessão, tentativa e delay.

## Decisões

1. **Separado do Claudinio:** evita alterar o plugin já utilizado, mantém dois detectores especializados e permite releases independentes. Ambos retornam sem ação quando o erro não pertence ao seu provedor.
2. **Sem polling automático periódico:** a coleta passiva nos headers não consome quota; a consulta app-server só ocorre diante de um 429 reconhecido e incerto. Nunca usar uma janela parcialmente gasta para prever liberação.
3. **Sem persistência na primeira versão:** o hook do OpenCode não cria retomada segura após reinício. Reenviar um prompt poderia repetir efeitos colaterais.
4. **Sem interceptar WebSocket:** HTTP/SSE é coberto; suporte explícito a `experimental.ws.receive` requer teste e tratamento de frames sem replays indevidos.
5. **Sem `session.error` + novo prompt:** retries nativos preservam a semântica da requisição original, sujeitos ao teto interno de tentativas.

## Riscos e pendências

- Formatos de erro variam por versão e rota OAuth; um `response.failed` no stream pode não chegar como `429` no hook de resposta HTTP.
- Headers de janelas e códigos de erro podem mudar; ampliar reconhecimento somente com fixture real anonimizada.
- Chamadas simultâneas à mesma variante de modelo podem compartilhar a chave efêmera; melhorar associação apenas se a API oferecer um identificador de requisição.
- Teste real em OpenCode/OpenChamber ainda pendente.
- O Codex CLI pode estar ausente, deslogado ou vinculado a outra conta OAuth. Se for diferente da conta do OpenCode, configurar `statusFallback: "manual"`; o plugin não consegue verificar identidade cruzada sem acessar credenciais.

## Referências

- https://opencode.ai/v2/docs/build/plugins/server/
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://github.com/openai/codex/issues/58413
- https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs
- https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs
