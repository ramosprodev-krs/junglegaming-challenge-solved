import { describe, expect, test } from 'bun:test';
import { Money } from './money';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletOperationError,
} from './domain-error';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const T0 = new Date('2026-10-30T12:00:00.000Z');
const T1 = new Date('2026-10-30T12:00:01.000Z');

let seq = 0;
const move = (amount: string, at: Date = T1) => {
  seq += 1;
  return { entryId: `entry-${seq}`, transactionId: `tx-${seq}`, money: brl(amount), at };
};

const openWallet = (initial: string) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-open',
    openingEntryId: 'entry-open',
    at: T0,
  });

const replay = (entries: WalletLedgerEntry[], currency = 'BRL') =>
  entries.reduce(
    (acc, e) =>
      e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money),
    Money.zero(currency),
  );

describe('Wallet.open', () => {
  test('saldo inicial > 0: version 1 e lançamento CREDIT de abertura', () => {
    const { wallet, openingEntry } = openWallet('1000.00');

    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.balanceBefore.isZero()).toBe(true);
    expect(openingEntry!.balanceAfter.equals(brl('1000.00'))).toBe(true);
    expect(openingEntry!.transactionId).toBe('tx-open');
    expect(openingEntry!.isBalanced()).toBe(true);
  });

  test('saldo inicial zero: version 1 e nenhum lançamento', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test('a moeda da wallet vem do saldo inicial', () => {
    const { wallet } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: usd('10.00'),
      openingTransactionId: 't',
      openingEntryId: 'e',
      at: T0,
    });
    expect(wallet.currency).toBe('USD');
  });

  test('rejeita saldo inicial negativo', () => {
    const negative = brl('1.00').negate();
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: negative,
        openingTransactionId: 't',
        openingEntryId: 'e',
        at: T0,
      }),
    ).toThrow(InvalidWalletOperationError);
  });
});

describe('Wallet.debit', () => {
  test('reduz o saldo, incrementa version e devolve lançamento DEBIT', () => {
    const { wallet } = openWallet('100.00');
    const m = move('30.00');

    const entry = wallet.debit(m);

    expect(wallet.balance.equals(brl('70.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe(m.transactionId);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('70.00'))).toBe(true);
  });

  test('permite zerar o saldo exatamente', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(move('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('saldo insuficiente lança erro e não altera nada', () => {
    const { wallet } = openWallet('100.00');

    expect(() => wallet.debit(move('100.01'))).toThrow(InsufficientFundsError);

    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });
});

describe('Wallet.credit', () => {
  test('aumenta o saldo, incrementa version e devolve lançamento CREDIT', () => {
    const { wallet } = openWallet('100.00');

    const entry = wallet.credit(move('25.50'));

    expect(wallet.balance.equals(brl('125.50'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
    expect(entry.balanceAfter.equals(brl('125.50'))).toBe(true);
  });
});

describe('validações de movimento', () => {
  test('moeda diferente: lança CurrencyMismatchError e não altera nada', () => {
    const { wallet } = openWallet('100.00');
    const foreign = { entryId: 'e', transactionId: 't', money: usd('10.00'), at: T1 };

    expect(() => wallet.debit(foreign)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(foreign)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('valor zero ou negativo é rejeitado', () => {
    const { wallet } = openWallet('100.00');
    const zero = { entryId: 'e', transactionId: 't', money: brl('0.00'), at: T1 };
    const negative = { ...zero, money: brl('5.00').negate() };

    expect(() => wallet.debit(zero)).toThrow(InvalidWalletOperationError);
    expect(() => wallet.credit(zero)).toThrow(InvalidWalletOperationError);
    expect(() => wallet.debit(negative)).toThrow(InvalidWalletOperationError);
    expect(() => wallet.credit(negative)).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });
});

describe('version', () => {
  test('incrementa a cada mudança de saldo e só nelas', () => {
    const { wallet } = openWallet('100.00');
    expect(wallet.version).toBe(1);

    wallet.debit(move('10.00'));
    expect(wallet.version).toBe(2);

    expect(() => wallet.debit(move('999.00'))).toThrow(InsufficientFundsError);
    expect(wallet.version).toBe(2);

    wallet.credit(move('5.00'));
    expect(wallet.version).toBe(3);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado sem gerar lançamentos e continua operável', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('50.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });

    expect(wallet.version).toBe(7);
    expect(wallet.balance.equals(brl('50.00'))).toBe(true);

    const entry = wallet.debit(move('20.00'));
    expect(wallet.version).toBe(8);
    expect(entry.balanceBefore.equals(brl('50.00'))).toBe(true);
    expect(wallet.balance.equals(brl('30.00'))).toBe(true);
  });
});

describe('invariante: saldo == saldo reconstruído pelo ledger', () => {
  test('após uma sequência de operações, o replay do ledger bate com o saldo', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries = [openingEntry!];

    entries.push(wallet.debit(move('30.00')));
    entries.push(wallet.credit(move('10.50')));
    entries.push(wallet.debit(move('80.50')));
    expect(() => wallet.debit(move('0.01'))).toThrow(InsufficientFundsError);

    expect(replay(entries).equals(wallet.balance)).toBe(true);
    expect(wallet.balance.isZero()).toBe(true);
    expect(entries.every((e) => e.isBalanced())).toBe(true);
  });
});