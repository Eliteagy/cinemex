#!/bin/zsh
# Abre o Cinemex no Mac (duplo clique no Finder). Instala as dependências na primeira vez e
# compila sempre a interface, para as alterações que chegaram do GitHub aparecerem logo.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# O pnpm devolve erro só por avisar dos scripts de instalação ignorados (esbuild), por isso o que
# conta é as dependências terem ficado lá.
[ -d node_modules ] || pnpm install
[ -x node_modules/.bin/vite ] && [ -x node_modules/.bin/electron ] || { echo 'A instalação das dependências falhou (pnpm install).'; exit 1; }
pnpm vite build || exit 1
# Em segundo plano, para esta janela do Terminal poder ser fechada.
(node_modules/.bin/electron . >/dev/null 2>&1 &)
