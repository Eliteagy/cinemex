#!/bin/zsh
# Abre o Elite Cinema no Mac (duplo clique no Finder). Instala as dependências na primeira vez e
# compila sempre a interface, para as alterações que chegaram do GitHub aparecerem logo.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -d node_modules ] || pnpm install || exit 1
pnpm vite build || exit 1
# Em segundo plano, para esta janela do Terminal poder ser fechada.
(node_modules/.bin/electron . >/dev/null 2>&1 &)
