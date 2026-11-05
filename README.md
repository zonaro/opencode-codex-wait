# OpenCode Codex Wait

Plugin para o **OpenCode 2.x** que aguarda o reset de limites de uso do **Codex autenticado pela conta ChatGPT (OAuth)** e deixa o OpenCode tentar novamente **a mesma requisição**, na sessão original.

Inspirado na arquitetura do [opencode-claudinio](https://github.com/zonaro/opencode-claudinio), mas independente: os dois podem ser instalados no mesmo OpenCode/OpenChamber. Não troca automaticamente de modelo, não envia `continue` e não cria uma nova mensagem durante a espera.

> **Estado:** versão 0.2.0, com testes simulados. O fluxo de erro real da sua versão do OpenCode/conta OAuth ainda precisa ser validado. Nem toda resposta de limite informa quando a quota volta: nesses casos, o plugin não inventa um horário.

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
        "unknownResetRetrySeconds": 0,
        "statusFallback": "app-server"
      }
    }
  ]
}
```

O exemplo mostra **os dois plugins juntos**. Se o Claudinio já estiver instalado por outro método, não adicione uma segunda cópia. Reinicie o serviço do OpenCode se não houver recarregamento automático. O OpenChamber usa o servidor do OpenCode: o plugin deve ser instalado/configurado nesse servidor, não diretamente na interface do OpenChamber.

## Como funciona

### Quando a consulta acontece

1. **Após cada resposta HTTP do Codex, inclusive 200:** aproveita os headers `x-codex-primary-*`, `x-codex-secondary-*` e famílias adicionais. Armazena em memória o percentual utilizado, a duração e o reset das janelas. **Não executa chamadas extras** nem consulta credenciais. Por exemplo, `window-minutes: 300` indica uma janela de 5 horas, e `10080` indica sete dias; os nomes `primary`/`secondary` não são tratados como durações fixas.
2. **Somente se ocorrer HTTP 429 reconhecido:** procura primeiro um reset explícito no erro ou nos headers da própria resposta; em seguida, pode aproveitar uma janela **100% utilizada** observada recentemente na mesma sessão/modelo.
3. **Fallback sob demanda:** se ainda não houver um reset confiável, tenta uma única leitura pelo **Codex app-server** (`account/rateLimits/read`), com timeout de 5 segundos e intervalo mínimo de 60 segundos entre consultas. Esse RPC fornece os dados que o comando interativo `/status` também apresenta. Nenhuma geração de texto é solicitada.
4. **Se o fallback falhar:** não inventa um reset; registra uma orientação para abrir o Codex CLI e digitar `/status` manualmente (uma vez por sessão/modelo).

Para o 429 reconhecido, o plugin prioriza:

1. `error.resets_at` (timestamp Unix em segundos) e `error.resets_in_seconds`, quando existirem;
2. headers `x-codex-*-reset-at` de janelas explicitamente esgotadas ou identificadas pelo servidor como ativas;
3. header `Retry-After`, **apenas** se o erro também for reconhecido como limite do Codex;
4. alternativamente, os mesmos campos na mensagem repassada ao hook `retry` do OpenCode;
5. estado de uma janela de quota esgotada, capturado previamente ou confirmado pelo app-server.

Exemplo de resposta reconhecida:

```json
{
  "error": {
    "type": "usage_limit_reached",
    "resets_in_seconds": 3126
  }
}
```

O plugin registra o horário absoluto da liberação, soma a margem de segurança (5 segundos por padrão) e define `event.decision = { retry: true, delay: ... }` no hook nativo do OpenCode. Uma espera de 3126 segundos produz aproximadamente 3131 segundos de delay, descontando o tempo decorrido desde a resposta. Se **ambas** as janelas estiverem esgotadas, prevalece o reset mais tardio.

Logs resumidos, sem tokens, headers ou corpo de erros:

```text
[opencode-codex-wait] Session ses_...: retry #2 in 3131s (http-response).
```

### Se o Codex não informar um reset

O erro OAuth `subscription_sharing_usage_limit_exceeded` pode chegar **sem horário**. A documentação da OpenAI orienta a pausar e consultar o uso, sem inferir um horário a partir do código sozinho. O plugin usa, nessa ordem, os headers já observados e o app-server, se disponível. Por segurança, o padrão `unknownResetRetrySeconds: 0` **não** agenda um retry se nenhuma fonte fornecer um horário confiável.

O comando **`/status` é interativo**, não uma API de terminal. **Não** executamos `codex exec /status` — isso poderia criar uma requisição de inferência e gastar quota. Para consulta automática, iniciamos brevemente `codex app-server` e solicitamos o RPC oficial `account/rateLimits/read`. O Codex CLI deve estar instalado e autenticado separadamente na **mesma conta ChatGPT usada no OpenCode**. Caso contrário, defina `statusFallback: "manual"` e confira no Codex CLI com `/status`. O plugin nunca extrai, lê, grava ou envia seu token OAuth.

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
| `quotaTtlMs` | `300000` | Quanto tempo confiar nos headers de quota observados (5 minutos) |
| `statusFallback` | `"app-server"` | `"app-server"` consulta o Codex CLI somente em 429 sem reset; `"manual"` orienta usar `/status`; `"off"` desliga ambos |
| `statusTimeoutMs` | `5000` | Timeout do processo de consulta, de 1 a 15 segundos |
| `statusCooldownMs` | `60000` | Intervalo mínimo entre consultas externas, de 10 segundos a 1 hora |

Valores inválidos retornam ao padrão. Não é necessário fornecer token OAuth, chave de API ou credencial de conta ao plugin.

## Segurança e limitações

- **Apenas OpenCode 2.x**, com `@opencode/plugin` e hooks `http.response`/`retry`; OpenCode 1.x não foi testado.
- Só processa modelos com `providerID: "openai"` e sinais específicos de limite do Codex. Outros provedores, erros de faturamento, 401/403 e 429 genéricos ficam intocados.
- **O OpenCode tem um limite interno de tentativas.** O plugin modifica o delay de uma tentativa permitida, mas não remove esse limite.
- O app-server utiliza a **sessão separada do Codex CLI**. Se essa sessão pertencer a outra conta, os números podem não representar a conta do OpenCode: nesse cenário use `statusFallback: "manual"` ou `"off"`. Se o binário estiver ausente, a leitura falhar ou o RPC não mostrar uma janela esgotada, a espera não é inventada.
- Os headers e a sessão do app-server podem não mostrar as mesmas famílias de limites do modelo atual. O plugin exige uma janela explicitamente esgotada para utilizar o reset do histórico ou do app-server.
- A espera fica na memória do processo OpenCode. **Reiniciar o servidor encerra a espera**; retomada durável exige controle de duplicidade e não está implementada.
- Respostas com falha após o início do streaming (`response.failed`) podem não chegar ao hook `http.response` como HTTP 429. Nesse caso, o plugin depende do erro disponibilizado no hook `retry`; é necessário validar a integração real.
- Observações simultâneas da mesma sessão/modelo usam associação por sessão/provedor/modelo/variante, com correspondência de melhor esforço.
- Não intercepta WebSocket experimental diretamente. A quota é apenas **observada**; não há painel completo, persistência de métricas ou suporte a múltiplas contas/rotação de credenciais.
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
- [Codex — estrutura do RPC de consulta dos limites](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs)
- [Codex — parser oficial dos headers x-codex-*](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs)
- [Codex — exemplo de erro `usage_limit_reached`](https://github.com/openai/codex/issues/58413)
