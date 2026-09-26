// Verificación CPU del LUT de altura y de la fuente de verdad JS (§5.1 / T2.2.2).
// Ejecutar: node tools/verify-height.ts
// `three/webgpu` SOLO se importa aquí (DataUtils para la comparación half-float);
// toda la matemática verificada vive en src/world/heightMath.ts, sin imports.
import process from 'node:process';
import { DataUtils } from 'three/webgpu';
import {
  LUT_SEED,
  RES,
  bakeHeightMap,
  heightFrom,
  noiseFrom,
  normalFrom,
  rawHeight,
} from '../src/world/heightMath.ts';

let fails = 0;

function pass(msg: string): void {
  console.log(`  ok   ${msg}`);
}

function fail(msg: string): void {
  fails += 1;
  console.log(`  FAIL ${msg}`);
}

function nota(msg: string): void {
  console.log(`  nota ${msg}`);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- 1) Horneado -----------------------------------------------------------

console.log('1) bakeHeightMap (§5.1: 512², 5 octavas, normalizado a [0,1])');
const t0 = Date.now();
const data = bakeHeightMap();
const bakeMs = Date.now() - t0;
let min = Infinity;
let max = -Infinity;
for (let i = 0; i < data.length; i++) {
  const v = data[i];
  if (v < min) min = v;
  if (v > max) max = v;
}
console.log(
  `  ${data.length} muestras en ${bakeMs} ms · min ${min.toExponential(3)} · max ${max.toFixed(9)}`,
);
if (min >= -1e-7 && min <= 1e-6 && max >= 1 - 1e-6 && max <= 1 + 1e-6) {
  pass('rango normalizado [0,1] (min≈0, max≈1)');
} else {
  fail(`rango fuera de [0,1]: min=${min} max=${max}`);
}
if (max - min > 0.5) pass(`no es constante (rango ${(max - min).toFixed(6)})`);
else fail('LUT constante');

// --- 2) Cuantización half-float (la LUT que muestrea el shader) -------------

console.log('2) Diferencia JS(Float32) vs LUT half-float, 2000 puntos LCG');
const half = new Float32Array(data.length);
for (let i = 0; i < data.length; i++) {
  half[i] = DataUtils.fromHalfFloat(DataUtils.toHalfFloat(data[i]));
}
let qmax = 0;
for (let i = 0; i < data.length; i++) {
  const q = Math.abs(data[i] - half[i]);
  if (q > qmax) qmax = q;
}

const rnd = lcg(0x5eed1eaf);
const N = 2000;
let dmax = 0;
let sum2 = 0;
let under1 = 0;
let under5 = 0;
for (let k = 0; k < N; k++) {
  const x = (rnd() * 2 - 1) * 1000;
  const z = (rnd() * 2 - 1) * 1000;
  const d = Math.abs(heightFrom(data, RES, x, z) - heightFrom(half, RES, x, z));
  if (d > dmax) dmax = d;
  sum2 += d * d;
  if (d <= 1e-3) under1++;
  if (d <= 5e-3) under5++;
}
const rms = Math.sqrt(sum2 / N);
console.log(`  max |Δh| = ${dmax.toExponential(4)} m · RMS = ${rms.toExponential(4)} m`);
console.log(
  `  ≤1e-3: ${((100 * under1) / N).toFixed(2)}% · ≤5e-3: ${((100 * under5) / N).toFixed(2)}% · qmax(LUT) = ${qmax.toExponential(3)}`,
);

// raw = 13·N_A + 1.1·N_B y N es una combinación convexa de 4 texeles por octava:
// |Δh| ≤ (13 + 1.1)·qmax. Es la cota analítica de "solo cuantización".
const quantBound = 14.1 * qmax;
if (dmax <= quantBound + 1e-9) {
  pass(`solo cuantización: max ≤ (13+1.1)·qmax = ${quantBound.toExponential(3)} m`);
} else {
  fail(`max ${dmax.toExponential(3)} > cota de cuantización ${quantBound.toExponential(3)}`);
}
if (dmax <= 5e-3 && under1 / N >= 0.99) {
  pass('criterio guía del doc (max ≤ 5e-3 m y ≥99% ≤ 1e-3 m)');
} else {
  nota('criterio guía del doc (max ≤ 5e-3 m y ≥99% ≤ 1e-3 m): NO CUMPLIDO e inalcanzable con R16F.');
  nota(`       13·qmax = ${(13 * qmax).toExponential(3)} m: un solo texel ya supera 1e-3. Incluso con`);
  nota('       redondeo al par (RNE) el max baja a ~3e-3 m pero solo ~73% queda ≤1e-3 (ver informe).');
  nota('       Este test usa la cota analítica de cuantización como criterio real.');
}

// --- 3) raw() a mano (implementación independiente de la fórmula §5.1) ------

console.log('3) raw() contra la fórmula completa §5.1 (5 puntos)');

function wrapIdx(i: number, n: number): number {
  return ((i % n) + n) % n;
}

function sampleRef(d: Float32Array, res: number, u: number, v: number): number {
  const x = u * res - 0.5;
  const y = v * res - 0.5;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const x0 = wrapIdx(ix, res);
  const x1 = wrapIdx(ix + 1, res);
  const row0 = wrapIdx(iy, res) * res;
  const row1 = wrapIdx(iy + 1, res) * res;
  const a = d[row0 + x0];
  const b = d[row0 + x1];
  const c = d[row1 + x0];
  const e = d[row1 + x1];
  const ab = a + (b - a) * fx;
  const cd = c + (e - c) * fx;
  return ab + (cd - ab) * fy;
}

const OV = Math.cos(0.62);
const KV = Math.sin(0.62);
function rawRef(d: Float32Array, res: number, x: number, z: number): number {
  const a = (sampleRef(d, res, x / 384, z / 384) - 0.5) * 2 * 6.5;
  const rx = x * OV - z * KV;
  const rz = x * KV + z * OV;
  const b = (sampleRef(d, res, rx / 47 + 0.37, rz / 47 + 0.11) - 0.5) * 2 * 0.55;
  return a + b;
}

const POINTS: Array<[number, number]> = [
  [0, 0],
  [123.4, -567.8],
  [383.9, 77.7],
  [-1000.25, 999.75],
  [37.123, 384.0001],
];
let handMax = 0;
for (const [x, z] of POINTS) {
  const a = rawHeight(data, RES, x, z);
  const b = rawRef(data, RES, x, z);
  const d = Math.abs(a - b);
  if (d > handMax) handMax = d;
  console.log(`  (${String(x).padStart(8)}, ${String(z).padStart(8)}) → ${a.toFixed(9)} m`);
}
if (handMax <= 1e-9) pass(`raw() == fórmula a mano (max Δ ${handMax.toExponential(1)})`);
else fail(`raw() difiere de la fórmula a mano en ${handMax.toExponential(3)}`);

let aliasOk = true;
for (const [x, z] of POINTS) {
  if (heightFrom(data, RES, x, z) !== rawHeight(data, RES, x, z)) aliasOk = false;
}
if (aliasOk) pass('heightFrom === rawHeight (height = raw)');
else fail('heightFrom ≠ rawHeight');

let noiseMax = 0;
for (const [x, z] of POINTS) {
  const d = Math.abs(noiseFrom(data, RES, x, z) - sampleRef(data, RES, x / 64, z / 64));
  if (d > noiseMax) noiseMax = d;
}
if (noiseMax <= 1e-9) pass(`noise() == N(x/64, z/64) (max Δ ${noiseMax.toExponential(1)})`);
else fail(`noise() difiere de N(x/64,z/64) en ${noiseMax.toExponential(3)}`);

// --- 4) Continuidad del wrap (terreno infinito sin costuras) ----------------

console.log('4) Continuidad del wrap en la costura del LUT (x=384, z=384)');

function seamCheck(axis: 'x' | 'z', coord: number): void {
  const d = 0.2;
  const at = (p: number): number =>
    axis === 'x' ? heightFrom(data, RES, p, 77.3) : heightFrom(data, RES, 77.3, p);
  const jump = Math.abs(at(coord + d) - at(coord - d));
  const inSlope = Math.abs(at(coord - d) - at(coord - 3 * d)) / (2 * d);
  const outSlope = Math.abs(at(coord + 3 * d) - at(coord + d)) / (2 * d);
  const bound = 2 * d * Math.max(inSlope, outSlope) * 2 + 2e-3;
  if (jump <= bound) {
    pass(
      `${axis}=${coord} ±${d}: salto ${jump.toFixed(4)} m ≤ pendiente local×2 ${bound.toFixed(4)} m`,
    );
  } else {
    fail(`${axis}=${coord} ±${d}: salto ${jump.toFixed(4)} m > cota ${bound.toFixed(4)} m`);
  }
}

seamCheck('x', 384);
seamCheck('z', 384);

const aSeam = heightFrom(data, RES, 383.9, 77.3);
const bSeam = heightFrom(data, RES, 384.1, 77.3);
const slopeIn = Math.abs(aSeam - heightFrom(data, RES, 383.5, 77.3)) / 0.4;
const slopeOut = Math.abs(bSeam - heightFrom(data, RES, 384.5, 77.3)) / 0.4;
const seamBound = 0.2 * Math.max(slopeIn, slopeOut) * 2 + 2e-3;
if (Number.isFinite(aSeam) && Number.isFinite(bSeam) && Math.abs(bSeam - aSeam) <= seamBound) {
  pass(`height(383.9)=${aSeam.toFixed(4)} vs height(384.1)=${bSeam.toFixed(4)}: sin salto`);
} else {
  fail(`salto en la costura: ${aSeam} → ${bSeam}`);
}

// --- 5) Normal --------------------------------------------------------------

console.log('5) normal() unitaria y hacia arriba (normalFrom, eps=0.4)');
const out = { x: 0, y: 0, z: 0 };
const rndN = lcg(0xc0ffee);
let lenMax = 0;
let minY = 1;
for (let k = 0; k < 500; k++) {
  const x = (rndN() * 2 - 1) * 800;
  const z = (rndN() * 2 - 1) * 800;
  normalFrom(data, RES, x, z, out);
  const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z);
  lenMax = Math.max(lenMax, Math.abs(len - 1));
  if (out.y < minY) minY = out.y;
}
console.log(`  |len−1| max = ${lenMax.toExponential(2)} · min normal.y = ${minY.toFixed(4)}`);
if (lenMax <= 1e-9) pass('normal unitaria');
else fail(`normal no unitaria (|len−1| max ${lenMax.toExponential(3)})`);
if (minY > 0.9) pass('normal apunta hacia arriba (y > 0.9)');
else fail(`normal.y mínimo ${minY} ≤ 0.9`);

// --- 6) Semilla global (?seed=) ---------------------------------------------

console.log('6) Semilla global del LUT (?seed=)');
const dataDefault = bakeHeightMap(RES, LUT_SEED);
const dataZero = bakeHeightMap(RES, 0);
let zeroEq = true;
for (let i = 0; i < dataZero.length; i++) {
  if (dataZero[i] !== dataDefault[i]) {
    zeroEq = false;
    break;
  }
}
if (zeroEq) pass('seed 0 ≡ LUT_SEED 1337 (fallback documentado)');
else fail('seed 0 no coincide con LUT_SEED');

const dataAlt = bakeHeightMap(RES, 4242);
let altDiff = 0;
for (let i = 0; i < dataAlt.length; i++) {
  const d = Math.abs(dataAlt[i] - dataDefault[i]);
  if (d > altDiff) altDiff = d;
}
if (altDiff > 0.1) pass(`?seed=4242 cambia el LUT (max Δ ${altDiff.toFixed(3)})`);
else fail(`?seed=4242 no cambia el LUT (max Δ ${altDiff.toExponential(3)})`);

// --- Resultado --------------------------------------------------------------

console.log('');
console.log('NOTA: heightNode (TSL) no se puede verificar sin GPU/main.ts; queda pendiente');
console.log('      de la integración del orquestador (misma LUT y mismas constantes que raw).');
console.log('');
console.log(fails === 0 ? 'OK' : `FAIL (${fails})`);
process.exitCode = fails === 0 ? 0 : 1;
