# ============================================================
# Planeamento DSL — setup Git local (correr 1x antes do deploy)
# ============================================================
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host "== Limpar artefactos que nao devem ir para o repo ==" -ForegroundColor Cyan
if (Test-Path "node_modules") { Remove-Item -Recurse -Force "node_modules" }
if (Test-Path "package-lock.json") { Remove-Item -Force "package-lock.json" }
# remover ficheiros de teste, se existirem
Get-ChildItem -Filter "_*.js" -ErrorAction SilentlyContinue | Remove-Item -Force

if (-not (Test-Path ".git")) {
  Write-Host "== git init ==" -ForegroundColor Cyan
  git init | Out-Null
  git branch -M main
}

# configurar identidade se ainda nao existir (global)
if (-not (git config user.email)) { git config user.email "rpsilva@corksupply.pt" }
if (-not (git config user.name))  { git config user.name  "Rui Pedro Silva" }

git add .
git commit -m "Planeamento DSL — versao inicial" | Out-Null

Write-Host ""
Write-Host "OK. Proximos passos:" -ForegroundColor Green
Write-Host "  1) Criar repo privado em https://github.com/new  (nome: planeamento-dsl)"
Write-Host "  2) git remote add origin https://github.com/<UTILIZADOR>/planeamento-dsl.git"
Write-Host "  3) git push -u origin main"
Write-Host "  4) Railway: Deploy from GitHub repo + Add PostgreSQL"
Write-Host ""
Write-Host "Ver DEPLOY.md para o detalhe." -ForegroundColor Yellow
