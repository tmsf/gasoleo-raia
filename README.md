# Gasóleo Raia

Preços do gasóleo entre Tui (ES) e Caminha (PT), do mais barato ao mais caro. Site estático, sem backend.

## Fontes de dados (sem chave de API, CORS aberto)
- **Portugal** — DGEG `PesquisarPostos`, combustível 2101 *Gasóleo simples*, concelhos de Caminha (234), V. N. Cerveira (243) e Valença (241). Cada posto tem a sua data de atualização; preços com mais de 2 dias são assinalados.
- **Espanha** — MITECO `FiltroMunicipio`, *Gasóleo A*, Tui (5322), Tomiño (5321), O Rosal (5315) e A Guarda (5289). Os dados são atualizados a cada 30 min e é mostrada a hora da última atualização. Os postos de venda restrita a sócios (`Tipo Venta = R`) são excluídos.

O browser guarda as respostas em localStorage durante 30 min, o que dá, no máximo, cerca de 5 pedidos por visita.

## Abastecimentos
O botão **Abasteci** de cada posto regista um abastecimento (litros ou valor, um calcula o outro) com o preço pago e o preço do posto mais barato do outro lado da fronteira nesse momento. A poupança é a diferença multiplicada pelos litros. O histórico fica só no localStorage do browser (`diesel-raia:fills`), sem servidor, e pode ser exportado em CSV.

## Correr localmente
    python3 -m http.server 8000   # depois abrir http://localhost:8000

## Publicar
Qualquer alojamento estático serve. Em produção usa-se o Cloudflare Pages: sem framework, sem comando de build e com o diretório de saída `/`.

## Logótipos
A pasta `logos/` contém PNGs de 120×120 retirados do favicon ou do logótipo do site de cada marca, ou da Wikimedia Commons. As marcas sem logótipo encontrado (p. ex. Guay, Gasolar) não mostram nenhum. Para acrescentar um, colocar o PNG na pasta e juntar uma regex em `LOGOS` no `app.js`.

## Licença
O código deste projeto é de domínio público, sob a [Unlicense](LICENSE).
Os logótipos em `logos/` são marcas registadas dos respetivos titulares e não estão abrangidos por esta licença.
