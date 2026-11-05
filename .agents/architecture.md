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

No erro de streaming, o retry pode carregar somente `event.error.message`; o parser aceita JSON serializado ou mensagem contendo o código específico, se o SDK não repassar a resposta original. O plugin não inspeciona tokens de autenticação, não consulta endpoints de conta e não usa prompt de recuperação.

## Proteções

- Restringe a `model.providerID === "openai"` e assinatura Codex OAuth; outros provedores ignorados.
- Exige erro conhecido ou headers Codex específicos; `Retry-After` sozinho não basta.
- `resets_at` interpretado como timestamp Unix em segundos; `resets_in_seconds` como duração. Datas expiradas/invalidas ignoradas.
- Quando há várias informações confiáveis, usa o horário mais tardio para não adiantar o retry.
- Default de 8 dias para cobrir janelas longas; cap configurável até 14 dias e limite do timer Node.
- Capturas expiram após 30s, são consumidas uma única vez e limitadas a 100 entradas.
- Nenhum corpo, header ou credencial é persistido. Logs mostram somente identificador de sessão, tentativa e delay.

## Decisões

1. **Separado do Claudinio:** evita alterar o plugin já utilizado, mantém dois detectores especializados e permite releases independentes. Ambos retornam sem ação quando o erro não pertence ao seu provedor.
2. **Sem polling automático por padrão:** a documentação OpenAI diz para não inferir reset só pelo código de erro. O fallback opcional é uma tentativa controlada, não previsão de reabertura.
3. **Sem persistência na primeira versão:** o hook do OpenCode não cria retomada segura após reinício. Reenviar um prompt poderia repetir efeitos colaterais.
4. **Sem interceptar WebSocket:** HTTP/SSE é coberto; suporte explícito a `experimental.ws.receive` requer teste e tratamento de frames sem replays indevidos.
5. **Sem `session.error` + novo prompt:** retries nativos preservam a semântica da requisição original, sujeitos ao teto interno de tentativas.

## Riscos e pendências

- Formatos de erro variam por versão e rota OAuth; um `response.failed` no stream pode não chegar como `429` no hook de resposta HTTP.
- Headers de janelas e códigos de erro podem mudar; ampliar reconhecimento somente com fixture real anonimizada.
- Chamadas simultâneas à mesma variante de modelo podem compartilhar a chave efêmera; melhorar associação apenas se a API oferecer um identificador de requisição.
- Teste real em OpenCode/OpenChamber ainda pendente.

## Referências

- https://opencode.ai/v2/docs/build/plugins/server/
- https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://github.com/openai/codex/issues/58413
