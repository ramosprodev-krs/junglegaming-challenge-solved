import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';
import { CurrencyMismatchError, InvalidLedgerEntryError } from './domain-error';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const base = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  createdAt: new Date('2026-10-30T12:00:00.000Z'),
};

describe('WalletLedgerEntry.create', () => {
  test('aceita CREDIT balanceado', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('aceita DEBIT balanceado', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejeita aritmética errada', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('126.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita direção incompatível com os saldos', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('125.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita valor zero ou negativo', () => {
    for (const money of [brl('0.00'), brl('5.00').negate()]) {
      expect(() =>
        WalletLedgerEntry.create({
          ...base,
          direction: LedgerDirection.Credit,
          money,
          balanceBefore: brl('100.00'),
          balanceAfter: brl('100.00'),
        }),
      ).toThrow(InvalidLedgerEntryError);
    }
  });

  test('rejeita saldo final negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('100.00'),
        balanceBefore: brl('50.00'),
        balanceAfter: brl('50.00').subtract(brl('100.00')),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita moedas divergentes', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: usd('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('90.00'),
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('não revalida: reconstrói o estado persistido como está', () => {
    const entry = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('999.00'),
    });
    expect(entry.isBalanced()).toBe(false);
  });
});