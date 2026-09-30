@echo off
setlocal

REM ============================================================
REM  Corre o scraper completo (CASA SAPO, Imovirtual, KW Portugal,
REM  Century 21, ERA, RE/MAX, Idealista) com enriquecimento de
REM  detalhe incluido, e publica o resultado.
REM  NAO inclui o e-Leiloes - para esse usa o run-eleiloes.bat.
REM  E o mesmo trabalho que o scrape agendado no GitHub Actions faz
REM  em 4 execucoes paralelas (ver .github/workflows/scrape.yml),
REM  mas tudo a serio numa maquina so - demora MUITO mais tempo
REM  (pode ir a varias horas, sobretudo na primeira vez). Deixa
REM  esta janela aberta a correr em segundo plano.
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

git add data/listings.json data/listings-detail.json data/listings/ sitemap.xml
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "chore: update scraped listings (manual full run)"
    git push
    if errorlevel 1 (
        echo.
        echo O "git push" falhou - provavelmente o repositorio remoto avancou
        echo entretanto ^(ex.: uma execucao agendada^). Corre "git pull" e depois
        echo "git push" manualmente neste terminal.
    ) else (
        echo.
        echo Feito - anuncios atualizados e enviados.
    )
) else (
    echo.
    echo Sem alteracoes novas desta vez.
)

echo.
pause
