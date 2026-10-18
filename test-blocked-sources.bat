@echo off
setlocal

REM ============================================================
REM  Testa, a partir desta ligacao residencial, se alguns sites
REM  anteriormente bloqueados a partir do GitHub Actions (ver
REM  README.md, seccao "Fontes investigadas mas ainda nao
REM  viaveis") respondem de forma diferente a partir de aqui.
REM
REM  So FAZ PEDIDOS GET normais e MOSTRA o resultado no ecra -
REM  nao grava nada, nao faz scrape, nao faz commit nem push.
REM  Depois de correr, copia toda a saida e envia-a de volta.
REM
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
    echo e depois usa o test-blocked-sources.bat que fica dentro dessa pasta.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo ERRO: node nao encontrado no PATH. Instala o Node.js e tenta de novo.
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
echo A testar sites anteriormente bloqueados...
echo.
call node test-blocked-sources.js

echo.
echo ============================================================
echo  Copia toda a saida acima ^(desde "A testar sites..."^) e
echo  envia-a de volta para interpretarmos o resultado.
echo ============================================================
pause
exit /b 0
