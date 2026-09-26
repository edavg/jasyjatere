// Verificación CPU de la niebla §4. Ejecutar: node tools/verify-fog.ts
import process from 'node:process';
// Node type-stripping exige la extensión .ts (tsconfig tiene allowImportingTsExtensions).
import { fogFactor } from '../src/render/fogMath.ts';

// Valores esperados calculados con la fórmula literal §4 (zB 0.0062, BB 120/185,
// KB 0, worldY 0). Tolerancia 1e-4.
const EXPECTED: Array<[dist: number, value: number]> = [
  [0, 0],
  [10, 0.085977],
  [25, 0.201284],
  [50, 0.362053],
  [75, 0.490462],
  [100, 0.593024],
  [125, 0.674941],
  [150, 0.740371],
  [175, 0.936277],
  [185, 1],
  [200, 1],
  [250, 1],
  [400, 1],
];

let fails = 0;

function pass(msg: string): void {
  console.log(`  ok   ${msg}`);
}

function fail(msg: string): void {
  fails += 1;
  console.log(`  FAIL ${msg}`);
}

console.log('fogMath (§4): heightRef=0, density=0.0062, near=120, far=185');
console.log('dist    h=0,KB=0    h=25,KB=0   h=0,KB=1.7  esperado       delta');

for (const [dist, expected] of EXPECTED) {
  const h0 = fogFactor(dist, 0, 0);
  const h25 = fogFactor(dist, 25, 0);
  const kb = fogFactor(dist, 0, 1.7);
  const delta = Math.abs(h0 - expected);
  const mark = delta <= 1e-4 ? '' : '  <-- FAIL';
  if (delta > 1e-4) fails += 1;
  console.log(
    `${String(dist).padStart(4)}  ${h0.toFixed(6).padStart(10)}  ${h25
      .toFixed(6)
      .padStart(10)}  ${kb.toFixed(6).padStart(11)}  ${expected
      .toFixed(6)
      .padStart(8)}  ${delta.toExponential(1)}${mark}`,
  );
}

console.log('');
console.log('Checks:');

const atZero = fogFactor(0, 0, 0);
if (atZero === 0) pass('dist=0 → 0');
else fail(`dist=0 → ${atZero}, se esperaba 0`);

for (const worldY of [0, 10, 25, 1.7]) {
  let prev = -1;
  let monotone = true;
  for (let dist = 0; dist <= 400; dist += 0.5) {
    const v = fogFactor(dist, worldY, 0);
    if (v < prev - 1e-9) {
      monotone = false;
      fail(`no monótono en dist=${dist} (worldY=${worldY}): ${v} < ${prev}`);
      break;
    }
    prev = v;
  }
  if (monotone) pass(`monótono creciente con la distancia (worldY=${worldY})`);
}

for (const dist of [185, 200, 250, 400]) {
  const v = fogFactor(dist, 0, 0);
  if (v === 1) pass(`dist=${dist} a altura 0 → 1 (suelo de distancia)`);
  else fail(`dist=${dist} a altura 0 → ${v}, se esperaba 1`);
}

const high = fogFactor(100, 25, 0);
const low = fogFactor(100, 0, 0);
if (high < low) pass(`el término de altura aclara con la altura (25 m: ${high.toFixed(3)} < 0 m: ${low.toFixed(3)})`);
else fail(`altura 25 m no reduce la niebla (${high} >= ${low})`);

const doubleDensity = fogFactor(100, 0, 0, 0.0124);
if (doubleDensity > low) pass(`densidad ×2 a 100 m → ${doubleDensity.toFixed(3)} > ${low.toFixed(3)}`);
else fail(`densidad ×2 no aumenta el factor (${doubleDensity} <= ${low})`);

const customNearFar = fogFactor(100, 0, 0, 0.0062, 50, 100);
if (customNearFar === 1) pass('near/far personalizados: 100 m con (50,100) → 1');
else fail(`near/far personalizados: ${customNearFar}, se esperaba 1`);

// Decisión: la fórmula literal §4 da ~0.36 a 50 m y ~0.59 a 100 m. La afirmación
// "0 a 100 m" de docs/fase-1-cielo-luz-niebla.md describe solo el suelo y = smoothstep(120,185,f).
console.log('');
console.log(`NOTA: 50 m → ${fogFactor(50, 0, 0).toFixed(3)} y 100 m → ${low.toFixed(3)};`);
console.log('la fórmula literal §4 manda y el doc de fase describe solo el término y.');

console.log('');
console.log(fails === 0 ? 'OK' : `FAIL (${fails})`);
process.exitCode = fails === 0 ? 0 : 1;
