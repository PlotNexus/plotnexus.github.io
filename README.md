# PlotNexus

**Todos os imóveis. Uma só pesquisa.**

O PlotNexus é um hub de pesquisa de imóveis para Portugal: em vez de procurar
casa espalhado por vários sites, agrega os anúncios num único lugar, sempre
com link direto para o anúncio e site de origem. É um projeto pessoal, ainda
em desenvolvimento.

O site está publicado via GitHub Pages a partir deste repositório.

## Capturas de ecrã

**Página inicial** — pesquisa, filtro por tipo (comprar/arrendar), fontes
agregadas identificadas por cor e listagem de imóveis:

![Página inicial do PlotNexus](docs/screenshots/homepage.png)

**Pesquisa por raio num mapa** — escolha de um centro (por morada ou clique
directo no mapa) e um raio de distância:

![Painel de pesquisa no mapa](docs/screenshots/pesquisa-mapa.png)

**Página de detalhe de um imóvel** — galeria de fotos, descrição completa e
link directo para o anúncio original:

![Página de detalhe de um imóvel](docs/screenshots/detalhe-imovel.png)

## Estado atual

- Interface estática (HTML/CSS/JS puro, sem build necessário): página
  inicial com pesquisa/filtros/ordenação e pesquisa por raio num mapa
  (Leaflet + OpenStreetMap, com geocodificação de moradas via Nominatim),
  página de detalhe por imóvel (galeria de fotos, descrição completa,
  características, dados técnicos, mapa e link para o anúncio original) e
  página "Sobre".
- Conectores de dados reais e automáticos, correndo via
  `.github/workflows/scrape.yml` a cada 6 horas:
  - **CASA SAPO** — compra e arrendamento de apartamentos e moradias,
    cobertura de Portugal Continental e Madeira (os Açores não têm
    cobertura própria nesta fonte).
  - **Imovirtual** — a mesma cobertura, mas incluindo também todas as
    ilhas dos Açores e da Madeira individualmente.
  - **RE/MAX** — cobertura nacional completa (incluindo Açores e Madeira),
    através da API de pesquisa pública do site. A descrição de cada anúncio
    é filtrada por um heurístico próprio (`lib/languageGuard.js`) que corta
    o texto assim que deteta uma mudança de idioma (alguns agentes colam a
    mesma descrição em português, inglês e espanhol seguidos no mesmo
    campo), para garantir que nunca aparece texto que não seja português no
    site.
  - **Century 21** — também através de uma API de pesquisa pública
    (`/api/properties`), sem necessidade de distinguir por distrito — a
    cobertura nacional é dividida em 12 "blocos" de páginas em vez de
    localizações. Usa o mesmo heurístico de deteção de mudança de idioma
    da RE/MAX.
  - **KW Portugal** — a API de pesquisa devolve sempre o mesmo lote fixo de
    10 imóveis por pedido, por isso a cobertura nacional (obtida a partir
    do sitemap do site, já que a API nunca devolve o link do próprio
    anúncio) é percorrida em lotes de 10 ids de cada vez, outra vez
    dividida em 12 "blocos" virtuais. Essa mesma chamada já devolve o
    detalhe completo (todas as fotos, descrição integral, dados técnicos),
    mas para não escrever tudo de uma vez num único ficheiro (isso já
    chegou a ultrapassar o limite de 100MB por ficheiro do GitHub), só um
    resumo leve é guardado na primeira passagem — o detalhe completo é
    pedido de novo, um imóvel de cada vez, através da mesma fase de
    enriquecimento gradual usada pelas restantes fontes. A descrição
    passa por uma variante do heurístico de deteção de mudança de idioma
    com granularidade linha-a-linha em vez de parágrafo-a-parágrafo (o
    heurístico aceita um padrão de divisão configurável para isto), já
    que este texto não separa sempre os parágrafos com linha em branco —
    e ainda corta em pontos adicionais específicos desta fonte (uma
    assinatura fixa em inglês, e traduções coladas sem qualquer separador
    a seguir a uma etiqueta como "ENGLISH:").
  - **ERA** — a maior fonte até agora (mais de 30 mil imóveis no total). Ao
    contrário das restantes, não é uma API pública documentada: a pesquisa
    do site é feita inteiramente do lado do cliente por um módulo DotNetNuke,
    e o endpoint só foi encontrado ao vasculhar o próprio bundle JavaScript
    do módulo à procura do nome do controlador/ação e da convenção de
    assinatura de pedidos da DNN Services Framework — cada pedido precisa de
    um par cookie+token anti-forgery e dos ids de módulo/separador extraídos
    de uma página real. Os preços de arrendamento aparecem sistematicamente
    mascarados com um valor fixo idêntico em todos os anúncios (confirmado
    em dezenas de imóveis distintos, incluindo no próprio endpoint de
    detalhe) — provavelmente um portão deliberado para gerar contactos, não
    um erro de raspagem — por isso esta fonte cobre apenas compra, nunca
    arrendamento. Sharding por "blocos" de páginas, à semelhança da
    Century 21.
  - **Idealista** — a única fonte que não usa pedidos HTTP directos: o site
    está protegido por DataDome, e mesmo com automação de browser completo
    (Playwright) só um pedido isolado por sessão passa o desafio antes de a
    própria rede de origem (runners do GitHub Actions, IPs de datacenter)
    ser sinalizada por volume (confirmado com testes reais: um pedido
    isolado passa perfeitamente, mas ao fim de pouco mais de uma dezena de
    pedidos ao longo de ~20 minutos o Idealista respondeu com um bloqueio
    explícito de "acesso temporariamente restrito"). Em vez disso, esta
    fonte usa uma API paga de terceiros
    ([idealista-real-estate no RapidAPI](https://rapidapi.com/kiwimaker/api/idealista-real-estate))
    — um pedido HTTP autenticado normal, sem browser nem contorno de
    anti-bot — mas limitada a 750 pedidos/mês no nível gratuito, uma fracção
    do que as outras fontes usam por execução. Por isso, em vez de uma
    varredura nacional, cada execução faz apenas *um* pedido de pesquisa,
    escolhido por rotação (baseada na hora, sem estado guardado) por uma
    lista de localizações priorizada — Lisboa e Coimbra (e concelhos
    vizinhos, como Oliveira do Hospital, Tábua e Santa Comba Dão) aparecem
    com o dobro da frequência de zonas secundárias como Porto e Faro — mais
    um pequeno lote de enriquecimento de detalhe. Como a API agrega
    anúncios de Espanha, Portugal e Itália ao mesmo tempo, vários campos
    (descrição, endereço) de agências que operam nos dois países vêm às
    vezes em espanhol mesmo para imóveis portugueses — o campo de descrição
    correcto (`propertyComment`, distinto do campo `description` da
    pesquisa) já vem em português, mas ainda assim passa pelo mesmo
    heurístico de deteção de mudança de idioma das outras fontes, que já
    reconhece marcadores espanhóis. Os URLs das fotos desta fonte expiram
    ao fim de cerca de 24 horas (são assinados, verificado experimentalmente
    que deixam de responder sem a assinatura) — muito menos tempo do que o
    intervalo entre reforços de detalhe — por isso esta fonte não guarda
    fotografias; o botão para o anúncio original continua a mostrá-las.
  
  A recolha nacional é dividida em 4 execuções paralelas (cada uma cobrindo
  um subconjunto de distritos/localizações de cada fonte), para que nenhuma
  execução isolada precise de fazer todos os pedidos sozinha.
- Depois de recolher a lista de anúncios, o scraper visita a página de cada
  anúncio para obter detalhe completo (todas as fotos, descrição integral,
  características por categoria e dados técnicos como estado, área útil/
  bruta, ano de construção e certificação energética). Para não multiplicar
  os pedidos contra uma fonte sensível a rate limiting, cada execução só
  enriquece um lote limitado de anúncios ainda não vistos (`data/
  listings-detail.json` guarda o que já foi obtido); a cobertura completa
  cresce ao longo de várias execuções agendadas em vez de tudo de uma vez.
  Um anúncio ainda não enriquecido mostra a foto e descrição resumida da
  página de resultados como reserva. O número de fotos guardadas por
  anúncio é também limitado (20, em `lib/merge.js`) — uma pequena minoria
  de anúncios (sobretudo no Imovirtual) chega a ter mais de 100 fotos, o
  que sozinho já foi o suficiente para o ficheiro final ultrapassar outra
  vez o limite de 100MB do GitHub e travar várias execuções seguidas,
  mesmo com o resto do enriquecimento a crescer de forma controlada.
- Resiliente a falhas parciais: se uma pesquisa falhar numa execução (bloqueio
  de rede pontual, por exemplo), os anúncios dessa zona não desaparecem do
  site — mantêm-se os últimos dados conhecidos durante alguns dias em vez de
  serem substituídos por uma lista vazia. Só são removidos ao fim de vários
  dias sem serem vistos (presume-se vendidos/expirados).
- Deduplicação entre fontes (`lib/dedupe.js`): a mesma imobiliária publica
  muitas vezes o mesmo imóvel em vários portais ao mesmo tempo, e não há um
  identificador partilhado entre fontes para o detectar directamente. Em vez
  disso, dois anúncios de fontes diferentes são considerados o mesmo imóvel
  apenas quando coordenadas quase idênticas (a ~150m, para tolerar pequenas
  diferenças de geocodificação entre fontes), preço exactamente igual e
  (quando ambos são conhecidos) tipologia e área também coincidem — exigir
  tudo isto ao mesmo tempo evita fusões erradas (confirmado com dados reais:
  vários anúncios de um mesmo empreendimento, com preço/tipologia/área
  iguais mas fracções distintas e genuinamente diferentes, não são
  confundidos). Corre a cada execução, por isso mantém-se ao dia sem
  intervenção manual.
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
│   │   ├── listing.js            # lógica da página de detalhe
│   │   └── mapFilter.js          # pesquisa por raio num mapa (Leaflet)
│   ├── vendor/leaflet/            # Leaflet auto-hospedado (sem depender de CDN)
│   └── img/
├── docs/screenshots/              # capturas de ecrã usadas neste README
├── data/
│   ├── listings.json            # dados reais (gerados pelo scraper)
│   ├── listings-detail.json     # cache do detalhe já enriquecido por anúncio
│   └── listings.sample.json     # dados de exemplo (fallback)
├── scripts/scrape/               # scraper Node.js
│   ├── index.js                  # ponto de entrada para correr tudo localmente, sequencial
│   ├── worker.js                 # ponto de entrada por shard (usado pelo GitHub Actions)
│   ├── finalize.js               # combina os shards e escreve os ficheiros finais
│   ├── lib/
│   │   ├── http.js               # fetch com retry/backoff (429 e falhas de rede)
│   │   ├── merge.js              # junção com dados anteriores + seleção de detalhe
│   │   ├── languageGuard.js      # corta descrições no ponto onde mudam de idioma
│   │   └── normalize.js
│   └── sources/
│       ├── casaSapo.js
│       ├── imovirtual.js
│       ├── remax.js
│       ├── century21.js
│       ├── kwportugal.js
│       ├── era.js
│       └── idealista.js
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
da lista completa. A fonte Idealista precisa também de `RAPIDAPI_KEY`
(a mesma usada em produção, guardada como *secret* do GitHub Actions) —
sem ela, essa fonte é simplesmente ignorada em vez de falhar a execução.

No GitHub Actions, o mesmo trabalho corre dividido: `worker.js` trata de um
subconjunto de distritos (`SHARD_INDEX`/`SHARD_COUNT`) e escreve o seu próprio
ficheiro parcial; `finalize.js` junta os ficheiros de todos os shards com os
dados anteriores e escreve `data/listings.json` e `data/listings-detail.json`
— só este último passo faz commit, por isso os shards nunca competem entre
si para fazer push.

## Nota sobre a recolha de dados de terceiros

Este projeto agrega anúncios de imobiliárias e portais de terceiros. Por
agora é um projeto pessoal e de pequena escala; antes de qualquer utilização
pública/comercial, será necessário revisitar os termos de serviço de cada
fonte. Princípios seguidos desde já:

- Nunca esconder a origem do anúncio: cada imóvel tem sempre um botão que
  encaminha para o site original.
- Respeitar limites de frequência de pedidos (rate limiting) — os scrapers
  esperam um intervalo (com variação aleatória, não fixo) entre pedidos e
  tentam novamente com backoff em caso de bloqueio ou falha de rede.
- Identificar os scrapers com um User-Agent próprio.

## Fontes investigadas mas ainda não viáveis

Algumas fontes generalistas populares usam proteção anti-bot que o método
actual (pedidos HTTP simples, sem browser) não consegue contornar:

- **SUPERCASA** — desafio Cloudflare com JavaScript obrigatório.
- **CustoJusto** — proíbe scraping explicitamente no próprio `robots.txt`.

Ultrapassar isto exigiria pelo menos automação de browser completo
(Playwright/Puppeteer) — um investimento de engenharia maior que fica para
mais tarde. O Idealista tinha exactamente este problema (DataDome, mais uma
camada de bloqueio por volume de pedidos que nem automação de browser
resolvia sozinha) até ser resolvido através de uma API paga de terceiros —
ver a fonte **Idealista** mais acima.

## Roadmap / próximas ideias

- [x] Deteção e remoção de duplicados entre fontes (o mesmo imóvel anunciado
      tanto na CASA SAPO como no Imovirtual, por exemplo) —
      `lib/dedupe.js`, correndo a cada execução do scraper.
- [ ] Favoritos e comparação entre imóveis.
- [ ] Alertas por email para novas pesquisas guardadas.
- [ ] Modo escuro.
- [ ] PWA / instalável em telemóvel.
- [ ] Internacionalização (ex.: inglês, para expatriados a comprar em PT).

## Licença

Este código está disponível publicamente apenas para consulta — todos os
direitos estão reservados (ver [LICENSE](LICENSE)). Não é concedida
nenhuma licença para o copiar, modificar, redistribuir ou reutilizar,
total ou parcialmente, nem para fins comerciais. Isto cobre apenas o
código deste repositório; não concede (nem retira) quaisquer direitos
sobre os dados de imóveis de terceiros que sejam agregados.
