# PlotNexus

**Todos os imóveis. Uma só pesquisa.**

O PlotNexus é um hub de pesquisa de imóveis para Portugal: em vez de procurar
casa espalhado por vários sites, agrega os anúncios num único lugar, sempre
com link direto para o anúncio e site de origem. É um projeto pessoal, ainda
em desenvolvimento.

O site está publicado via GitHub Pages a partir deste repositório.

## Estado atual

- Interface estática (HTML/CSS/JS puro, sem build necessário): página
  inicial com pesquisa/filtros/ordenação, página de detalhe por imóvel
  (galeria de fotos, descrição completa, características, dados técnicos,
  mapa e link para o anúncio original) e página "Sobre".
- Um conector de dados real e automático: `scripts/scrape` recolhe anúncios
  de apartamentos e moradias da CASA SAPO (compra e arrendamento, cobertura
  de Portugal Continental e Madeira; os Açores ainda não têm cobertura
  própria nesta fonte) via `.github/workflows/scrape.yml`, agendado a cada
  6 horas.
- Depois de recolher a lista de anúncios, o scraper visita a página de cada
  anúncio para obter detalhe completo (todas as fotos, descrição integral,
  características por categoria e dados técnicos como estado, área útil/
  bruta, ano de construção e certificação energética). Para não multiplicar
  os pedidos contra uma fonte sensível a rate limiting, cada execução só
  enriquece um lote limitado de anúncios ainda não vistos (`data/
  listings-detail.json` guarda o que já foi obtido); a cobertura completa
  cresce ao longo de várias execuções agendadas em vez de tudo de uma vez.
  Um anúncio ainda não enriquecido mostra a foto e descrição resumida da
  página de resultados como reserva.
- Dados de exemplo (`data/listings.sample.json`) servem de fallback caso
  `data/listings.json` (dados reais) ainda não exista ou esteja vazio.

## Estrutura do projeto

```
.
├── index.html                   # página inicial
├── imovel.html                  # página de detalhe de um imóvel (?id=...)
├── sobre.html                   # página "Sobre"
├── assets/
│   ├── css/styles.css
│   ├── js/
│   │   ├── shared.js             # helpers partilhados entre páginas
│   │   ├── app.js                # lógica da página inicial
│   │   └── listing.js            # lógica da página de detalhe
│   └── img/
├── data/
│   ├── listings.json            # dados reais (gerados pelo scraper)
│   ├── listings-detail.json     # cache do detalhe já enriquecido por anúncio
│   └── listings.sample.json     # dados de exemplo (fallback)
├── scripts/scrape/               # scraper Node.js
│   ├── index.js
│   ├── lib/
│   │   ├── http.js               # fetch com retry/backoff para pedidos 429
│   │   └── normalize.js
│   └── sources/casaSapo.js
├── .github/workflows/scrape.yml  # agendamento do scraper
├── LICENSE
└── README.md
```

## Correr localmente

Como o site carrega dados via `fetch`, é preciso servir os ficheiros por
HTTP (abrir `index.html` diretamente com `file://` não funciona por
restrições de CORS do browser). Por exemplo:

```bash
python3 -m http.server 8000
```

Depois abre `http://localhost:8000`.

Para correr o scraper localmente:

```bash
cd scripts/scrape
npm install
node index.js
```

A variável de ambiente `SCRAPE_DISTRICTS` (lista separada por vírgulas, ex.
`SCRAPE_DISTRICTS=braga,evora`) permite testar apenas alguns distritos em vez
da lista completa.

## Nota sobre a recolha de dados de terceiros

Este projeto agrega anúncios de imobiliárias e portais de terceiros. Por
agora é um projeto pessoal e de pequena escala; antes de qualquer utilização
pública/comercial, será necessário revisitar os termos de serviço de cada
fonte. Princípios seguidos desde já:

- Nunca esconder a origem do anúncio: cada imóvel tem sempre um botão que
  encaminha para o site original.
- Respeitar limites de frequência de pedidos (rate limiting) — o scraper da
  CASA SAPO espera vários segundos entre pedidos e tenta novamente com
  backoff em caso de bloqueio.
- Identificar o scraper com um User-Agent próprio.

## Roadmap / próximas ideias

- [ ] Conectores de dados reais para outras fontes (Imovirtual, Idealista,
      SUPERCASA, RE/MAX).
- [ ] Favoritos e comparação entre imóveis.
- [ ] Alertas por email para novas pesquisas guardadas.
- [ ] Deteção e remoção de duplicados (o mesmo imóvel anunciado em vários
      sites).
- [ ] Modo escuro.
- [ ] PWA / instalável em telemóvel.
- [ ] Internacionalização (ex.: inglês, para expatriados a comprar em PT).

## Licença

Este projeto está licenciado sob a [Licença MIT](LICENSE): permissiva,
simples e comum em projetos web deste tipo, permitindo uso, modificação e
reutilização do código (frontend) com atribuição. Note que a licença cobre o
código deste repositório; não concede quaisquer direitos sobre os dados de
imóveis de terceiros que sejam agregados.
