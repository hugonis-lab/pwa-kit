.PHONY: wasm shell build test typecheck gate clean

PORT ?= 4173
HOST ?= 127.0.0.1

wasm:
	bash wasm/zig-core/build.sh

shell: wasm
	cd shell && npm run build

build: shell

typecheck:
	cd shell && npm run typecheck

test: wasm
	node --test tests/zig-core.test.mjs
	cd shell && npm test

clean:
	rm -rf shell/dist shell/public/core.wasm wasm/zig-core/core.wasm wasm/zig-core/core.raw.wasm
