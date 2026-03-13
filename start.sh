#!/bin/bash
if ! command -v node &> /dev/null; then
    echo "Node.js not found. Install from https://nodejs.org"
    exit 1
fi

[ ! -d node_modules ] && npm install

echo "Starting SimReadyGL dev server..."
npx vite --open
