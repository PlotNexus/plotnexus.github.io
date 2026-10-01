@echo off
setlocal

REM ============================================================
REM  Corre o scraper completo (CASA SAPO, Imovirtual, KW Portugal,
REM  Century 21, ERA, RE/MAX, Idealista) com enriquecimento de
REM  detalhe incluido, e publica o resultado.
REM  NAO inclui o e-Leiloes - para esse usa o run-eleiloes.bat.
REM  E o mesmo trabalho que o scrape agendado no GitHub Actions faz
REM  em 4 execucoes paralelas (ver .github/workflows/scrape.yml),
REM  mas tudo a serio numa maquina so - por isso pausa mais entre
REM  pedidos do que cada execucao paralela pausaria sozinha (senao
REM  fontes como a CASA SAPO bloqueiam por excesso de pedidos vindos
REM  do mesmo IP), e ainda assim demora MUITO mais tempo (pode ir a
REM  varias horas, sobretudo na primeira vez). Deixa esta janela
REM  aberta a correr em segundo plano.
REM  Duplo-clique neste ficheiro, ou corre-o num terminal.
REM ============================================================

cd /d "%~dp0"

if not exist ".git" (
    echo ERRO: esta pasta nao e uma copia clonada do repositorio ^(nao tem ".git"^).
    echo Este ficheiro tem de estar dentro de uma copia completa do repositorio,
    echo nao sozinho numa pasta. Se ainda nao tens o repositorio, corre primeiro:
    echo.
    echo     git clone https://github.com/PlotNexus/plotnexus.github.io.git
    echo.
    echo e depois usa o run-full-scrape.bat que fica dentro dessa pasta.
    pause
    exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
    echo ERRO: git nao encontrado no PATH. Instala o Git for Windows e tenta de novo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo ERRO: node nao encontrado no PATH. Instala o Node.js e tenta de novo.
    pause
    exit /b 1
)

echo A atualizar o repositorio local...
git pull
if errorlevel 1 (
    echo.
    echo ERRO ao fazer "git pull". Resolve isso primeiro ^(ex.: alteracoes locais
    echo por gravar^) e corre este ficheiro de novo.
    pause
    exit /b 1
)

cd /d "%~dp0scripts\scrape"

if not exist node_modules (
    echo A instalar dependencias do scraper...
    call npm install
    if errorlevel 1 (
        echo npm install falhou.
        pause
        exit /b 1
    )
)

echo.
echo A correr o scraper completo ^(CASA SAPO, Imovirtual, KW Portugal, Century 21,
echo ERA, RE/MAX, Idealista^) com enriquecimento de detalhe incluido.
echo Isto demora bastante ^(pode ir a varias horas na primeira vez^) - deixa esta
echo janela aberta a correr, nao precisas de fazer nada enquanto corre.
echo.
call node index.js
if errorlevel 1 (
    echo.
    echo O scraper falhou - ve o erro acima. Nada foi enviado para o GitHub.
    pause
    exit /b 1
)

cd /d "%~dp0"

call :commit_and_push "chore: update scraped listings (manual full run)" "data/listings.json data/listings-detail.json data/listings/ sitemap.xml"

echo.
pause
exit /b 0

REM ------------------------------------------------------------
REM  Faz commit+push dos ficheiros indicados; se o push falhar
REM  por o remoto ter avancado entretanto - ex.: uma execucao
REM  agendada - sincroniza automaticamente, usando "git fetch" e
REM  "git reset" para a ultima versao sem tocar nos ficheiros ja
REM  escritos no disco, e tenta de novo, ate 3 vezes. Nunca usa
REM  "git pull" nem "git merge", que podem deixar marcadores de
REM  conflito do git por resolver dentro dos ficheiros JSON se
REM  alguem os aceitar sem reparar - ja aconteceu e partiu o site.
REM  Parametro 1: mensagem do commit. Parametro 2: caminhos a
REM  adicionar.
REM ------------------------------------------------------------
:commit_and_push
set "commit_msg=%~1"
set "add_paths=%~2"
set attempt=1

:commit_and_push_loop
git add %add_paths%
git diff --cached --quiet
if not errorlevel 1 (
    echo.
    echo Sem alteracoes novas desta vez.
    goto :eof
)
git commit -m "%commit_msg%"
git push
if not errorlevel 1 (
    echo.
    echo Feito - anuncios atualizados e enviados.
    goto :eof
)
if %attempt% GEQ 3 (
    echo.
    echo O "git push" continua a falhar depois de %attempt% tentativas. Corre
    echo "git fetch origin main" e "git reset origin/main" manualmente neste
    echo terminal para investigar.
    goto :eof
)
echo.
echo O "git push" falhou - provavelmente o repositorio remoto avancou entretanto
echo ^(ex.: uma execucao agendada^). A sincronizar e a tentar de novo automaticamente...
git fetch origin main
if errorlevel 1 (
    echo ERRO ao fazer "git fetch". Corre "git pull" manualmente para investigar.
    goto :eof
)
git reset origin/main
set /a attempt+=1
goto :commit_and_push_loop
