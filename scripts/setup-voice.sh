#!/usr/bin/env bash
# Downloads the Parakeet TDT v3 int8 model that local voice teaching needs.
# Usage: scripts/setup-voice.sh [model-dir]
# Default dir matches the control plane default parakeetModelPath.
set -euo pipefail

MODEL_NAME="sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2"
FILES=(encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx tokens.txt)

if [[ -n "${DEX_AI_HOME:-}" ]]; then
  default_dir="${DEX_AI_HOME}/data/models/parakeet-tdt-0.6b-v3-int8"
else
  default_dir="${HOME}/.local/share/dex-ai/models/parakeet-tdt-0.6b-v3-int8"
fi
model_dir="${1:-$default_dir}"

missing=0
for file in "${FILES[@]}"; do
  [[ -f "${model_dir}/${file}" ]] || missing=1
done
if [[ "$missing" == 0 ]]; then
  echo "Parakeet model already present in ${model_dir}"
  exit 0
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "Downloading ${MODEL_NAME} (about 640 MB)..."
curl -fL --retry 3 -o "${work_dir}/model.tar.bz2" "$MODEL_URL"
tar -xjf "${work_dir}/model.tar.bz2" -C "$work_dir"

mkdir -p "$model_dir"
for file in "${FILES[@]}"; do
  mv "${work_dir}/${MODEL_NAME}/${file}" "${model_dir}/${file}"
done
echo "Parakeet model installed in ${model_dir}"
