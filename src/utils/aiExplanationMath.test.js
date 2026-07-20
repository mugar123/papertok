import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAIExplanationMath } from './aiExplanationMath.js';

test('normalizes raw scientific subscripts from an AI explanation', () => {
  assert.equal(
    normalizeAIExplanationMath('Los parámetros son ω_b, Ω_K, z_re y A_s.'),
    'Los parámetros son $\\omega_{b}$, $\\Omega_{K}$, $z_{re}$ y $A_{s}$.',
  );
});

test('preserves LaTeX that is already delimited', () => {
  assert.equal(
    normalizeAIExplanationMath('La relación es $\\omega_b$ y $A_s$.'),
    'La relación es $\\omega_b$ y $A_s$.',
  );
});
