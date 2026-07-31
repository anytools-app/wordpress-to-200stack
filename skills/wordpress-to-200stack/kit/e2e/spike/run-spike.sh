#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
kit_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
template_dir="$kit_dir/templates/next-app"
inject_module="$script_dir/mock-inject.mjs"

run_probe() {
  MICROCMS_SERVICE_DOMAIN=golden-spike \
  MICROCMS_API_KEY=spike-key \
  NODE_OPTIONS="--import $inject_module" \
  node --input-type=module -e '
    const response = await fetch("https://golden-spike.microcms.io/api/v1/spike?limit=50&offset=0", {
      headers: { "X-MICROCMS-API-KEY": "spike-key" },
    });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.contents) || body.totalCount !== 0) process.exit(1);
    console.log("[spike] probe passed status=" + response.status);
  '
}

if [ "${1:-}" != "--build-only" ]; then
  run_probe
fi

if [ "${1:-}" = "--probe-only" ]; then
  exit 0
fi

cd "$template_dir"
MICROCMS_SERVICE_DOMAIN=golden-spike \
MICROCMS_API_KEY=spike-key \
NODE_OPTIONS="--import $inject_module" \
node scripts/build-app.mjs
