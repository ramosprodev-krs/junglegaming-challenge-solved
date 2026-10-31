import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from', () => {
  test('aceita decimal válido e serializa com escala fixa de 2 casas', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('25').toJSON().amount).toBe('25.00');
    expect(brl('25.5').toJSON().amount).toBe('25.50');
    expect(brl('0.00').toJSON().amount).toBe('0.00');
  });

  test.each([
    ['vazio', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['notação científica', '1e3'],
    ['notação científica maiúscula', '1E3'],
    ['negativo', '-1.00'],
    ['sinal positivo', '+1.00'],
    ['mais de 2 casas', '1.234'],
    ['espaço no início', ' 1.00'],
    ['espaço no fim', '1.00 '],
    ['sem parte inteira', '.50'],
    ['ponto sem decimais', '5.'],
    ['vírgula decimal', '1,00'],
    ['texto', 'abc'],
  ])('rejeita amount inválido: %s', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (ex.: number vindo de JSON)', () => {
    expect(() =>
      Money.from({ amount: 25 as unknown as string, currency: 'BRL' }),
    ).toThrow(InvalidMoneyError);
    expect(() => Money.from(undefined as unknown as never)).toThrow(InvalidMoneyError);
  });

  test.each(['', 'br', 'BRLL', 'brl', 'B1L', ' BRL'])(
    'rejeita currency inválida: "%s"',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    },
  );
});

describe('Money.zero', () => {
  test('cria zero na moeda informada', () => {
    const z = Money.zero('BRL');
    expect(z.isZero()).toBe(true);
    expect(z.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('valida a moeda', () => {
    expect(() => Money.zero('real')).toThrow(InvalidMoneyError);
  });
});

describe('aritmética', () => {
  test('add soma sem erro de ponto flutuante (0.10 + 0.20 = 0.30)', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('subtract pode resultar negativo', () => {
    const r = brl('10.00').subtract(brl('25.50'));
    expect(r.isNegative()).toBe(true);
    expect(r.toJSON().amount).toBe('-15.50');
  });

  test('negate inverte o sinal', () => {
    expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
    expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
  });

  test('nunca produz "-0.00"', () => {
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).toJSON().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).isNegative()).toBe(false);
  });

  test('soma e subtração repetidas mantêm a exatidão', () => {
    let acc = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) acc = acc.add(brl('0.01'));
    expect(acc.toJSON().amount).toBe('10.00');
  });
});

describe('imutabilidade', () => {
  test('operações retornam nova instância e não alteram a original', () => {
    const a = brl('10.00');
    const b = brl('5.00');
    const sum = a.add(b);
    a.subtract(b);
    a.negate();
    expect(sum).not.toBe(a);
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('5.00');
  });
});

describe('predicados e comparações', () => {
  test('isZero / isPositive / isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
  });

  test('isLessThan', () => {
    expect(brl('10.00').isLessThan(brl('10.01'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
    expect(brl('10.01').isLessThan(brl('10.00'))).toBe(false);
  });

  test('equals compara valor, não escala nem referência', () => {
    expect(brl('1.0').equals(brl('1.00'))).toBe(true);
    expect(brl('1').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
  });

  test('equals com moedas diferentes retorna false (sem lançar)', () => {
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });
});

describe('conflito de moeda', () => {
  test('add, subtract e isLessThan lançam CurrencyMismatchError', () => {
    expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(CurrencyMismatchError);
  });
});

describe('serialização', () => {
  test('toJSON produz MoneyProps estável', () => {
    expect(JSON.stringify(brl('25'))).toBe('{"amount":"25.00","currency":"BRL"}');
  });

  test('toJSON -> from faz round-trip', () => {
    const original = brl('1234.56');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });

  test('toString', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});