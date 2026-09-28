# Gasóleo Raia

Preços do gasóleo entre Tui (ES) e Caminha (PT), do mais barato ao mais caro. Site estático, sem backend.

## Fontes de dados (sem chave de API, CORS aberto)
- **Portugal** — DGEG `PesquisarPostos`, combustível 2101 *Gasóleo simples*, concelhos de Caminha (234), V. N. Cerveira (243) e Valença (241). Cada posto tem a sua data de atualização; preços com mais de 2 dias são assinalados.
- **Espanha** — MITECO `FiltroMunicipio`, *Gasóleo A*, Tui (5322), Tomiño (5321), O Rosal (5315) e A Guarda (5289). Os dados são atualizados a cada 30 min e é mostrada a hora da última atualização. Os postos de venda restrita a sócios (`Tipo Venta = R`) são excluídos.

O browser guarda as respostas em localStorage durante 30 min, o que dá, no máximo, cerca de 5 pedidos por visita.

## Correr localmente
    python3 -m http.server 8000   # depois abrir http://localhost:8000

## Publicar
Qualquer alojamento estático serve. Por exemplo, GitHub Pages: fazer push desta pasta e ativar o Pages na raiz do branch.

## Logótipos
A pasta `logos/` contém PNGs de 120×120 retirados do favicon ou do logótipo do site de cada marca, ou da Wikimedia Commons. As marcas sem logótipo encontrado (p. ex. Guay, Gasolar) não mostram nenhum. Para acrescentar um, colocar o PNG na pasta e juntar uma regex em `LOGOS` no `app.js`.
