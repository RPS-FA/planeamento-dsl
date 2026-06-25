# Planeamento DSL — Web App (Cliente-Servidor)

App de planeamento de produção da unidade **DSL** (Cork Supply / Harv 81 Group).
Arquitectura igual ao projeto *Planeamento DENSIDADES*: Node.js + Express + Postgres no Railway,
frontend HTML estático (single-page) com chamadas `fetch` à API REST.

Substitui o ficheiro `DSL PLAN 2026 - Junho.xlsm` (folhas `Capacidade`, `Plano Dia Linhas 1-5` e
`Plano Dia Linhas 6-10`).

## Modelo

| Conceito Excel | Equivalente na app |
|---|---|
| Folha `Capacidade` (ordens por colocar) | Painel **Capacidade · por planear** (pool à esquerda) |
| `Plano Dia Linhas 1-5` | Quadro **Plano Dia · Linhas 1-5** |
| `Plano Dia Linhas 6-10` | Quadro **Plano Dia · Linhas 6-10** |
| Linhas `B`, `EE`, `T` | Quadro **Áreas Especiais** (Banca, Escolha Eletrónica, Tapete) |
| Coluna `G` (Linha) + `H/AP` (Turno) | atribuição linha + turno por ordem |
| Capacidade `rolhas/h` (DSL 17 / VDSL 8,5 ×1000) | Configurações → capacidade por linha |
| `Começa as` / `Termina as` | calculado pelo motor: `dur(h) = qtd×1000 / (rolhas/h)`, encadeado no turno |
| `Qtd. Desdobramento` / `Motivo 2ª passagem` | secção Desdobramento na ordem (borda laranja no quadro) |
| `QV up/down` (Planning e DSL) | secção QV na ordem |
| `Tempo de Atraso` / `On Time` | coluna On-time (fim real − fim planeado) |

Cada ordem é guardada como um registo `ops` (payload JSONB). As `settings` guardam capacidades e turnos.

## Estrutura

```
Railway/
├── server.js          # Express + API REST
├── db.js              # Persistência (driver pg) + seed + settings por defeito
├── schema.sql         # DDL Postgres (auto-aplicado no arranque)
├── seed_orders.json   # 487 ordens de Junho 2026 (extraídas do Excel)
├── package.json
├── railway.toml / nixpacks.toml
├── public/index.html  # Cliente (toda a UI)
└── README.md / DEPLOY.md
```

## API REST

| Método | Path | Perfil | Função |
|---|---|---|---|
| GET | `/api/state` | qualquer | `{ops, settings, ts}` (boot) |
| GET | `/api/ops` | qualquer | lista ordens |
| POST | `/api/ops` | planeador | cria ordem |
| PUT | `/api/ops/:id` | planeador (tudo) / produção (whitelist) | actualiza |
| DELETE | `/api/ops/:id` | planeador | apaga |
| GET/PUT | `/api/settings` | qualquer / planeador | capacidades, turnos, setup |
| POST | `/api/admin/reset` \| `/wipe` | planeador | repor seed / limpar |
| GET | `/health` | — | healthcheck Railway |

**Header**: `X-Profile: planeador | producao`
**Whitelist Produção** (campos editáveis no chão de fábrica): estado, horas/qtd reais, tempo de
atraso e perdido, lote, motivo/causa de 2ª passagem, QV (DSL), colaborador, observações.

## Perfis

- **Produção** (default) — edita só campos pós-execução; sem drag-and-drop, sem criar/apagar.
- **Planeador** — edita tudo. Entrada protegida por password no cliente (`Cork2026!`, alterar em `index.html`).
  > Nota: a password no cliente é só uma barreira de UI. Para segurança real, a autorização tem de
  > ser reforçada no servidor (ver secção Segurança no DEPLOY).

## Como usar

1. Quadro **Plano Dia · Linhas 1-5 / 6-10** mostra a semana selecionada, por dia e por linha, com
   início/fim calculados.
2. Arrastar ordens do painel **Capacidade** (esquerda) para uma linha/dia; arrastar entre linhas
   para reordenar; arrastar de volta ao painel para "desplanear".
3. Mudar **estado** diretamente no quadro; clicar numa ordem abre o detalhe completo.
4. **Exportar Excel** gera o plano da semana/quadro ativo.
5. **Configurações** — capacidade (rolhas/h) por linha, janelas de turno, setup entre ordens.

## Custos (Railway)

Hobby plan: $5/mês de crédito. Express + Postgres pequeno ≈ $2-4/mês.

---
**Cork Supply / Harv 81 Group** · Planeamento Produção DSL
