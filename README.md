# OpenCode Codex Wait

Plugin para o **OpenCode 2.x** que aguarda o reset de limites de uso do **Codex autenticado pela conta ChatGPT (OAuth)** e deixa o OpenCode tentar novamente **a mesma requisição**, na sessão original.

Inspirado na arquitetura do [opencode-claudinio](https://github.com/zonaro/opencode-claudinio), mas independente: os dois podem ser instalados no mesmo OpenCode/OpenChamber. Não troca automaticamente de modelo, não envia `continue` e não cria uma nova mensagem durante a espera.

> **Estado:** versão inicial, com testes simulados. O fluxo de erro real da sua versão do OpenCode/conta OAuth ainda precisa ser validado. Nem toda resposta de limite informa quando a quota volta: nesses casos, o plugin não inventa um horário.

## Instalação

No OpenCode 2.x:

```bash
opencode plugin add github:zonaro/opencode-codex-wait
opencode plugin list
```

Ou configure `~/.config/opencode/opencode.jsonc` (sem instalar pelo comando acima novamente):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:zonaro/opencode-claudinio",
    {
      "package": "github:zonaro/opencode-codex-wait",
      "options": {
        "safetyMarginMs": 5000,
        "maxWaitSeconds": 691200,
        "unknownResetRetrySeconds": 0
      }
    }
  ]
}
```

O exemplo mostra **os dois plugins juntos**. Se o Claudinio já estiver instalado por outro método, não adicione uma segunda cópia. Reinicie o serviço do OpenCode se não houver recarregamento automático. O OpenChamber usa o servidor do OpenCode: o plugin deve ser instalado/configurado nesse servidor, não diretamente na interface do OpenChamber.

## Como funciona

Quando a chamada do modelo `openai/...` recebe HTTP **429** com erro reconhecido de limite do Codex, o plugin consulta:

1. `error.resets_at` (timestamp Unix em segundos) e `error.resets_in_seconds`, quando existirem;
2. headers `x-codex-*-reset-at` de janelas explicitamente esgotadas ou identificadas pelo servidor como ativas;
3. header `Retry-After`, **apenas** se o erro também for reconhecido como limite do Codex;
4. alternativamente, os mesmos campos na mensagem repassada ao hook `retry` do OpenCode.

Exemplo de resposta reconhecida:

```json
{
  "error": {
    "type": "usage_limit_reached",
    "resets_in_seconds": 3126
  }
}
```

O plugin registra o horário absoluto da liberação, soma a margem de segurança (5 segundos por padrão) e define `event.decision = { retry: true, delay: ... }` no hook nativo do OpenCode. Uma espera de 3126 segundos produz aproximadamente 3131 segundos de delay, descontando o tempo decorrido desde a resposta.

Logs resumidos, sem tokens, headers ou corpo de erros:

```text
[opencode-codex-wait] Session ses_...: retry #2 in 3131s (http-response).
```

### Se o Codex não informar um reset

O erro OAuth `subscription_sharing_usage_limit_exceeded` pode chegar **sem horário**. A documentação da OpenAI orienta a pausar e consultar o uso, sem inferir um horário a partir do código sozinho. Por segurança, o padrão `unknownResetRetrySeconds: 0` **não** agenda um retry nesses casos.

Opcionalmente, é possível configurar `unknownResetRetrySeconds: 900` para aguardar 15 minutos antes de **uma tentativa nativa permitida**, mas isso é uma sondagem, **não uma previsão de reset**, e continua sujeita ao limite interno de tentativas do OpenCode. Não use esse valor para contornar políticas de uso.

## Configuração

As opções são inseridas em `plugins[].options` e todas são opcionais:

| Opção | Padrão | Finalidade |
| --- | ---: | --- |
| `safetyMarginMs` | `5000` | Margem adicional após o reset (0 a 60.000 ms) |
| `maxWaitSeconds` | `691200` | Limite máximo de espera (até 14 dias) |
| `unknownResetRetrySeconds` | `0` | Espera opcional para 429 reconhecido sem horário (0 desliga; máximo 3600 s) |
| `captureTtlMs` | `30000` | Prazo para associar a resposta HTTP ao hook de retry |
| `maxEntries` | `100` | Máximo de observações em memória |

Valores inválidos retornam ao padrão. Não é necessário fornecer token OAuth, chave de API ou credencial de conta ao plugin.

## Segurança e limitações

- **Apenas OpenCode 2.x**, com `@opencode/plugin` e hooks `http.response`/`retry`; OpenCode 1.x não foi testado.
- Só processa modelos com `providerID: "openai"` e sinais específicos de limite do Codex. Outros provedores, erros de faturamento, 401/403 e 429 genéricos ficam intocados.
- **O OpenCode tem um limite interno de tentativas.** O plugin modifica o delay de uma tentativa permitida, mas não remove esse limite.
- A espera fica na memória do processo OpenCode. **Reiniciar o servidor encerra a espera**; retomada durável exige controle de duplicidade e não está implementada.
- Respostas com falha após o início do streaming (`response.failed`) podem não chegar ao hook `http.response` como HTTP 429. Nesse caso, o plugin depende do erro disponibilizado no hook `retry`; é necessário validar a integração real.
- Observações simultâneas da mesma sessão/modelo usam associação por sessão/provedor/modelo/variante, com correspondência de melhor esforço.
- Não intercepta WebSocket experimental diretamente, não mede quota de conta e não suporta múltiplas contas/rotação de credenciais.
- **Não há garantia de compatibilidade funcional com versões específicas do OpenChamber até o teste real.**

## Desenvolvimento e testes

```bash
git clone https://github.com/zonaro/opencode-codex-wait.git
cd opencode-codex-wait
node --test
```

Os testes usam respostas HTTP simuladas e relógio controlado, sem rede ou consumo de cota. Para testar a integração real, instale no OpenCode, reproduza um erro de limite do Codex OAuth e confira o log do servidor e a retomada na sessão original. Consulte [`.agents/testing.md`](.agents/testing.md).

## Documentação

- [AGENTS.md](AGENTS.md): regras para quem alterar o plugin.
- [`.agents/architecture.md`](.agents/architecture.md): arquitetura, decisões e riscos.
- [`.agents/roadmap.md`](.agents/roadmap.md): evolução planejada.
- [`.agents/testing.md`](.agents/testing.md): matriz de testes e validação manual.

## Referências

- [OpenCode 2.x — hooks de plugin](https://opencode.ai/v2/docs/build/plugins/server/)
- [OpenAI — erros de uso com login ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [OpenAI — comportamento de falhas durante o streaming](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI — limites e Retry-After](https://developers.openai.com/api/docs/guides/rate-limits)
- [Codex — exemplo de erro `usage_limit_reached`](https://github.com/openai/codex/issues/58413)
