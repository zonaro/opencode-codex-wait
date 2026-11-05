# Roadmap

## MVP — implementação inicial

- [x] Repositório público independente do `opencode-claudinio`.
- [x] Plugin OpenCode 2.x com hooks `http.response` e `retry`.
- [x] Identificação de limites Codex OAuth sem alterar 429 genéricos.
- [x] Parsing de `resets_at`, `resets_in_seconds`, `Retry-After` e headers Codex.
- [x] Margem de segurança, limite de espera e cache temporário.
- [x] Testes offline, README, AGENTS.md e documentação técnica.
- [x] Observar janelas de quota pelo HTTP normal, com duração/percentual/reset e sem polling.
- [x] Fallback sob demanda pelo app-server (mesmos dados de `/status`) e orientação manual quando indisponível.
- [x] Timeout, cooldown, expiração do cache e testes simulados para as duas janelas.
- [ ] Testar erro real e retomada em OpenCode e OpenChamber do Zonaro.

## Iterações futuras

- [ ] Coletar fixtures anonimizadas de variantes reais de 429 e falhas de streaming.
- [ ] Expor um status resumido por janela no OpenCode/OpenChamber, sem tokens/headers de autenticação e sem novo prompt.
- [ ] Verificar a associação da conta OpenCode com a conta CLI sem obter credenciais, se houver API de identidade não sensível.
- [ ] Avaliar transporte WebSocket sem replay de saída parcial.
- [ ] Implementar recuperação durável pós-reinício, apenas com locks, cancelamento e validação idempotente.
- [ ] Avaliar fallback inteligente entre modelos/provedores em projeto separado; fora do escopo deste plugin.

## Critério para marcar como validado

Verificar versão do OpenCode 2.x, provider `openai` com login ChatGPT, formato real do erro, agendamento, cancelamento e retomada da requisição original. Somente então declarar compatibilidade testada com versões específicas.
