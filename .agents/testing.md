# Testes e validação

## Automatizados

Execute:

```bash
node --test
```

Matriz de cenários:

- Erro `usage_limit_reached` com timestamp Unix absoluto.
- Erro com segundos relativos e mensagem JSON serializada.
- Erro `subscription_sharing_usage_limit_exceeded` sem reset (não presume horário).
- Erros 429 genéricos, faturamento, 401/403 e provedores não OpenAI (ignorar).
- `Retry-After` em segundos ou data HTTP.
- Janelas Codex explicitamente esgotadas e família ativa de limites.
- Relógio controlado: descontar tempo entre resposta HTTP e retry.
- Cap de espera, opções inválidas e expiração do cache.
- Registro e descarte dos hooks, sem prompts artificiais.
- Headers de sucesso: 5 horas e semanal no mesmo snapshot, inclusive famílias `codex_other`.
- Quota parcialmente gasta, malformada, velha e pertencente a outra sessão/modelo não antecipa retries.
- Leitura app-server simulada: initialize → initialized → account/rateLimits/read; nenhuma inferência.
- Fallback apenas no 429 reconhecido e incerto; timeout/cooldown e orientação manual para `/status`.

Os testes são totalmente simulados: não exigem acesso OAuth, não enviam requisições e não gastam quota.

## Validação manual pendente — Fedora / OpenChamber

1. Confirme `opencode --version` (é necessário 2.x), e instale por `opencode plugin add github:zonaro/opencode-codex-wait`.
2. Confirme que `opencode plugin list` contém **Codex Wait** e, se instalado, também **Claudinio** apenas uma vez cada.
3. Inicie uma sessão com um modelo `openai/...` autenticado por **Sign in with ChatGPT**, sem API key.
4. Quando atingir limite real, observe os logs **sem compartilhar tokens nem corpos completos**. Procure a linha `[opencode-codex-wait] Session ... retry #...`.
5. Confirme que a espera corresponde ao reset apresentado pela conta. O OpenCode deve repetir a requisição original sem adicionar outra mensagem do usuário.
6. Se houver erro reconhecido sem reset, confirme o comportamento conservador por padrão; opcionalmente teste `unknownResetRetrySeconds` com valor baixo.
7. Repita uma verificação no Claudinio e confirme que nenhum erro dele foi capturado pelo Codex Wait.
8. Cancele uma espera e confirme que não houve nova tentativa espontânea; reiniciar o servidor não deve prometer retomada.
9. Antes de alcançar a quota, faça uma chamada normal com modelo Codex e confira se os headers `x-codex-*-window-minutes` são enviados pela rota usada no OpenCode. Não copie valores ou tokens dos headers de autenticação.
10. Quando um 429 não tiver reset, verifique se o Codex CLI está instalado e logado na **mesma conta** (`codex` → `/status`). Compare o horário exibido com a espera planejada, caso o app-server consiga responder.
11. Teste `statusFallback: "manual"` sem Codex CLI e confirme que o plugin orienta usar `/status` sem marcar um horário fictício.

Se a integração real não reconhecer um erro, registre somente um **exemplo anonimizado** contendo código/tipo e nomes dos campos de reset, sem credenciais, IDs de conta nem headers de autenticação. Adicione um teste de regressão antes de ampliar o parser.
