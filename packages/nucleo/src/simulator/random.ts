// Seeded pseudo-random generator. Same seed, same sequence, on any machine: that is what makes
// the simulation reproducible. Not for cryptography.

/** Hash de texto em 32 bits (FNV-1a), para transformar a semente em estado inicial. */
export function hash32(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: pequeno, rápido e com boa distribuição para simulação. */
export class Aleatorio {
  private estado: number;

  constructor(semente: string | number) {
    this.estado = hash32(String(semente));
  }

  /** Número em [0, 1). */
  proximo(): number {
    this.estado = (this.estado + 0x6d2b79f5) >>> 0;
    let t = this.estado;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Inteiro em [min, max], inclusive. */
  inteiro(min: number, max: number): number {
    return min + Math.floor(this.proximo() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.proximo() < p;
  }

  escolher<T>(itens: readonly T[]): T {
    if (itens.length === 0) throw new RangeError('lista vazia');
    return itens[Math.floor(this.proximo() * itens.length)];
  }

  /** Cópia embaralhada (Fisher-Yates); a lista original não muda. */
  embaralhar<T>(itens: readonly T[]): T[] {
    const copia = [...itens];
    for (let i = copia.length - 1; i > 0; i--) {
      const j = Math.floor(this.proximo() * (i + 1));
      [copia[i], copia[j]] = [copia[j], copia[i]];
    }
    return copia;
  }
}
