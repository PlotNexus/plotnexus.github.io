@echo off
setlocal

REM ============================================================
REM  Corre o scraper do e-Leiloes e publica o resultado.
REM  Corre isto a partir de uma ligacao residencial normal - nao
REM  funciona a partir de redes de datacenter (ver README.md).
REM  Duplo-clique neste ficheiro, ou corre-o num terminal.
REM  (v2 - corrigidos erros de sintaxe do cmd.exe)
REM ============================================================

cd /d "%~dp0"

if not exist ".git" (
    echo ERRO: esta pasta nao e uma copia clonada do repositorio ^(nao tem ".git"^).
    echo Este ficheiro tem de estar dentro de uma copia completa do repositorio,
    echo nao sozinho numa pasta. Se ainda nao tens o repositorio, corre primeiro:
    echo.
    echo     git clone https://github.com/PlotNexus/plotnexus.github.io.git
    echo.
    echo e depois usa o run-eleiloes.bat que fica dentro dessa pasta.
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
echo A correr o scraper do e-Leiloes...
echo.
call node run-eleiloes-manual.js
if errorlevel 1 (
    echo.
    echo O scraper falhou - ve o erro acima. Nada foi enviado para o GitHub.
    pause
    exit /b 1
)

cd /d "%~dp0"

git add data/listings.json data/listings/ sitemap.xml
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "chore: update e-leiloes listings"
    git push
    if errorlevel 1 (
        echo.
        echo O "git push" falhou - provavelmente o repositorio remoto avancou
        echo entretanto ^(ex.: uma execucao agendada^). Corre "git pull" e depois
        echo "git push" manualmente neste terminal.
    ) else (
        echo.
        echo Feito - anuncios do e-Leiloes atualizados e enviados.
    )
) else (
    echo.
    echo Sem alteracoes novas do e-Leiloes desta vez.
)

echo.
pause
