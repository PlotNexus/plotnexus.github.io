# PlotNexus

**Todos os imóveis. Uma só pesquisa.**

O PlotNexus é um hub de pesquisa de imóveis para Portugal. A ideia é simples:
em vez de teres de procurar casa espalhado por vários sites (Imovirtual,
Idealista, SUPERCASA, RE/MAX, CASA SAPO, entre outros), juntamos os anúncios
num único lugar — sempre com link direto para o anúncio e site de origem.

O site está publicado via GitHub Pages a partir deste repositório.

## Estado atual (base do projeto)

Esta primeira versão estabelece a base da plataforma:

- Interface estática (HTML/CSS/JS puro, sem build necessário).
- Pesquisa por localização/palavra-chave, filtro por tipo (comprar/arrendar)
  e por fonte, e ordenação por preço/recência.
- Grelha de cartões de imóveis, cada um com a fonte identificada e um botão
  que encaminha sempre para o anúncio no site de origem.
- Dados de exemplo (`data/listings.sample.json`) para demonstrar o layout —
  **ainda não há recolha real de anúncios**. Isso é o próximo passo.

## Estrutura do projeto

```
.
├── index.html                  # página principal
├── assets/
│   ├── css/styles.css          # estilos
│   ├── js/app.js                # lógica de pesquisa/filtros/render
│   └── img/                     # imagens e logótipo (a preencher)
├── data/
│   └── listings.sample.json    # dados de exemplo (mock)
├── LICENSE
└── README.md
```

## Correr localmente

Como o `app.js` carrega os dados via `fetch`, precisas de servir os ficheiros
por HTTP (abrir o `index.html` diretamente com `file://` não funciona por
restrições de CORS do browser). Por exemplo:

```bash
python3 -m http.server 8000
# ou
npx serve .
```

Depois abre `http://localhost:8000`.

## Sobre o logótipo

O logótipo definitivo ainda está a ser preparado. Por agora existe um
logótipo temporário (ícone + texto "PlotNexus") em `index.html` e um favicon
inline em SVG. Quando o ficheiro final estiver pronto, basta substituir:

- O favicon em `<link rel="icon">` no `<head>` do `index.html`.
- O bloco `.logo` no cabeçalho (`index.html`), idealmente por um `<img>` a
  apontar para `assets/img/logo.svg` (ou `.png`).

## Nota sobre a recolha de dados de terceiros

Este projeto pretende agregar anúncios de imobiliárias e portais terceiros.
Antes de implementar qualquer recolha automática (scraping) de um site,
temos de:

- Verificar os **termos de serviço** e o `robots.txt` de cada site.
- Preferir sempre **APIs oficiais, feeds/RSS ou parcerias** em vez de
  scraping não autorizado, sempre que existam.
- Nunca esconder a origem do anúncio — o utilizador é sempre encaminhado
  para o site original para ver detalhes/contactar o anunciante.
- Respeitar limites de frequência de pedidos (rate limiting) para não
  sobrecarregar os sites de origem.

## Roadmap / próximas ideias

Lista aberta para irmos adicionando ao longo do projeto:

- [ ] Conectores de dados reais (scraping responsável e/ou APIs/parcerias)
      para Imovirtual, Idealista, SUPERCASA, RE/MAX, CASA SAPO e outros.
- [ ] Backend/serviço de agregação (ex.: job agendado que atualiza um JSON
      ou base de dados, servido por uma API própria).
- [ ] Imagens reais dos imóveis.
- [ ] Página de detalhe do imóvel dentro do PlotNexus (com link para o
      original).
- [ ] Filtros avançados: preço mín/máx, área, tipologia, ano de construção,
      certificado energético.
- [ ] Mapa interativo com localização dos imóveis.
- [ ] Favoritos e comparação entre imóveis.
- [ ] Alertas por email para novas pesquisas guardadas.
- [ ] Deteção e remoção de duplicados (o mesmo imóvel anunciado em vários
      sites).
- [ ] Modo escuro.
- [ ] PWA / instalável em telemóvel.
- [ ] Internacionalização (ex.: inglês, para expatriados a comprar em PT).

## Licença

Este projeto está licenciado sob a [Licença MIT](LICENSE) — permissiva,
simples e comum em projetos web deste tipo, permitindo uso, modificação e
reutilização do código (frontend) com atribuição. Note que a licença cobre o
código deste repositório; não concede quaisquer direitos sobre os dados de
imóveis de terceiros que venham a ser agregados.
