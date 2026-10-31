import { Money } from './money';
import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletOperationError } from './domain-error';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): {
    wallet: Wallet;
    openingEntry: WalletLedgerEntry | undefined;
  } {
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError('initial balance cannot be negative');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      props.at,
      props.at,
    );

    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    this.assertPositive(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(this._balance.toString(), movement.money.toString());
    }
    return this.apply(
      LedgerDirection.Debit,
      this._balance.subtract(movement.money),
      movement,
    );
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    this.assertPositive(movement.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(movement.money), movement);
  }

  private apply(
    direction: LedgerDirection,
    newBalance: Money,
    movement: WalletMovement,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter: newBalance,
      createdAt: movement.at,
    });

    this._balance = newBalance;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError('movement amount must be positive');
    }
  }
}