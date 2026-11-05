# Roadmap

## MVP — implementação inicial

- [x] Repositório público independente do `opencode-claudinio`.
- [x] Plugin OpenCode 2.x com hooks `http.response` e `retry`.
- [x] Identificação de limites Codex OAuth sem alterar 429 genéricos.
- [x] Parsing de `resets_at`, `resets_in_seconds`, `Retry-After` e headers Codex.
- [x] Margem de segurança, limite de espera e cache temporário.
- [x] Testes offline, README, AGENTS.md e documentação técnica.
- [ ] Testar erro real e retomada em OpenCode e OpenChamber do Zonaro.

## Iterações futuras

- [ ] Coletar fixtures anonimizadas de variantes reais de 429 e falhas de streaming.
- [ ] Melhorar observabilidade e indicar tempo restante sem expor tokens/headers.
- [ ] Avaliar transporte WebSocket sem replay de saída parcial.
- [ ] Implementar recuperação durável pós-reinício, apenas com locks, cancelamento e validação idempotente.
- [ ] Avaliar fallback inteligente entre modelos/provedores em projeto separado; fora do escopo deste plugin.

## Critério para marcar como validado

Verificar versão do OpenCode 2.x, provider `openai` com login ChatGPT, formato real do erro, agendamento, cancelamento e retomada da requisição original. Somente então declarar compatibilidade testada com versões específicas.
