# Sonda ao Idealista (temporária)

Não é um scraper — é um teste único para responder a uma pergunta concreta:
o Idealista está protegido por DataDome, e todos os pedidos HTTP simples
(sem browser) recebidos até agora — de várias origens, com vários
cabeçalhos, em HTTP/1.1 e HTTP/2 — receberam um 403 com um desafio
"interstitial" (`rt:'i'`) já na primeira tentativa, antes de qualquer
padrão de comportamento poder ter sido avaliado.

Um `rt:'i'` não é um bloqueio definitivo de IP (isso seria `rt:'bv'`): é um
desafio que um browser real, a executar JavaScript, por vezes resolve de
forma invisível através da própria pontuação de risco da DataDome. Este
teste corre um Chromium real via Playwright, a partir de um runner do
GitHub Actions (a rede onde o scraper de produção realmente corre — a
sandbox de desenvolvimento não conseguiu nem estabelecer ligação por
TLS a *nenhum* site externo através do Playwright, um problema à parte
sem relação com o Idealista), e regista o resultado (screenshot, HTML,
cookies, se apareceu um cookie `datadome` válido).

Corre apenas via `workflow_dispatch` em `.github/workflows/idealista-probe.yml`,
nunca no agendamento normal. Se o resultado mostrar que o desafio é
ultrapassável, compensa avançar para uma fonte a sério (a integrar como
qualquer outra, com sharding e enriquecimento faseado); se mostrar que
continua bloqueado mesmo com browser real, esta pasta pode ser removida —
terá cumprido o seu propósito de dar uma resposta definitiva.
