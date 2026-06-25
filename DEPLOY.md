# Deploy — Planeamento DSL (GitHub + Railway)

Tempo: ~20 min na primeira vez (com Postgres). Atualizações depois: ~30 s.

## Pré-requisitos (uma vez)
1. Git para Windows — https://git-scm.com/download/win
2. Conta GitHub — https://github.com/signup
3. Conta Railway — https://railway.app

## Passo 1 — Git local
PowerShell na pasta Railway:
```powershell
cd "C:\Users\rpsilva\OneDrive - Harv 81\Documents\Claude\Projects\Planeamento DSL\Railway"
.\deploy-setup.ps1
```
> Se der erro de execution policy: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

O script apaga `node_modules`/`package-lock.json`, faz `git init` e o primeiro commit.

## Passo 2 — Repositório GitHub
1. https://github.com/new
2. Nome: `planeamento-dsl` · Visibility: **Private** · não marcar README/gitignore/license
3. Create repository

## Passo 3 — Ligar e enviar
```powershell
git remote add origin https://github.com/<TEU_UTILIZADOR>/planeamento-dsl.git
git push -u origin main
```

## Passo 4 — Serviço web no Railway
1. https://railway.app/new → **Deploy from GitHub repo**
2. Autorizar e selecionar `planeamento-dsl`
3. Railway deteta `package.json` + `nixpacks.toml` (Node 20) + `railway.toml`
4. Build ~1-2 min. Arranca em **modo demo** (sem BD) — esperado.

## Passo 5 — Adicionar Postgres
1. Projeto Railway → **+ New** → **Database** → **Add PostgreSQL**
2. `DATABASE_URL` é injetada automaticamente no serviço web → redeploy automático
3. Logs esperados:
   ```
   [db] Pool Postgres inicializado.
   [db] Schema inicializado.
   [db] Tabela ops vazia — a inserir 487 ordens iniciais...
   [db] Seed concluído (487 ordens).
   ```

## Passo 6 — URL público
Serviço web → **Settings → Networking → Generate Domain** → abre no browser.
Chip do header deve ficar **🟢 ligado**.

## Verificar
```powershell
curl https://<TEU_URL>/health         # {"status":"ok","db":"connected"}
curl https://<TEU_URL>/api/ops        # 487 ordens
```

## Atualizar (workflow normal)
```powershell
cd "C:\Users\rpsilva\OneDrive - Harv 81\Documents\Claude\Projects\Planeamento DSL\Railway"
git add .
git commit -m "Atualização"
git push
```
Railway re-deploya em ~1 min. A BD não é tocada.

## Segurança (importante)
A password do planeador (`Cork2026!`) está no `public/index.html` e é só barreira de UI.
Para uso real, restringir o acesso:
- Railway → Settings → Networking → **Basic Auth**, ou
- Cloudflare Access à frente do domínio, ou
- login Microsoft 365 no `server.js`.

## Problemas comuns
| Erro | Solução |
|---|---|
| `git not recognized` | Instalar Git e reabrir PowerShell |
| Build failed | Ver Logs no Railway (normalmente versão Node/dependência) |
| Chip sempre 🔴 | Postgres não adicionado ou `DATABASE_URL` ausente no serviço web |
| Conteúdo desatualizado | `Ctrl+Shift+R` |

---
**Cork Supply / Harv 81 Group**
