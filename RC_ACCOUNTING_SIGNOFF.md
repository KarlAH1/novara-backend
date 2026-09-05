# RC — accounting classification, for external professional sign-off

> `ACCOUNTING_CLASSIFICATION_REQUIRES_PROFESSIONAL_SIGNOFF`
>
> Raisium does not answer the questions below in code, does not post journal
> entries, and does not specify account numbers. This document exists so the
> company's accountant or auditor can review the exact remaining question
> without reading the codebase.

## What the instrument is

Raisium RC is a contractual, equity-oriented investment framework intended to
result in a later share capital increase under Chapter 10 of the Norwegian
Private Limited Liability Companies Act (aksjeloven).

It is **not** implemented as a loan, a convertible loan, an interest-bearing
instrument, a debt claim, a claim intended for later set-off, a freestanding
subscription right under § 11-12, or a warrant. No set-off (motregning) occurs
at any point.

## Year 0

- The investor signs the RC agreement and pays the **Investment Amount** to the
  company.
- **No shares are issued.** No share capital increase occurs. No share premium
  arises from a Chapter 10 capital increase at this point.
- The investor is **not** entered in the shareholder register and is **not** a
  shareholder.
- No loan claim is created and no amount is reserved for later set-off.
- What the investor holds is a contractual right concerning a possible future
  Chapter 10 process.

## Trigger and conversion (Year 2 in the example)

1. A Trigger Event occurs (a new capital increase, a corporate transaction, or
   the long-stop date).
2. The number of RC shares is calculated and frozen.
3. The company proposes, and the general meeting resolves, a capital increase
   under Chapter 10.
4. The investor subscribes for the allocated shares.
5. The investor pays the **Par Amount** — the aggregate par value of the new
   shares — in cash, as the share contribution.
6. The capital increase is completed and registered.

The Investment Amount is **not** applied as consideration in the later
subscription. It is reflected in how many shares the investor is allocated:

```
RC Shares  = Investment Amount / (Share Price − Par Value)
Par Amount = RC Shares × Par Value
```

## Worked example

Company before the RC round:

| | |
|---|---|
| Share capital | NOK 30,000 |
| Shares | 30,000 |
| Par value | NOK 1.00 |
| Valuation cap | NOK 1,000,000 |
| Round target | NOK 100,000 |
| Investors | 10 × NOK 10,000 |
| Long-stop | 24 months |

Cap share price: 1,000,000 / 30,000 = NOK 33.33 per share.

Per investor: 10,000 / (33.33 − 1.00) = 309.31 → **309 shares** (rounded down),
Par Amount **NOK 309**.

| | |
|---|---|
| Year 0 — Investment Amounts received | NOK 100,000 |
| Year 2 — Par Amounts received | NOK 3,090 |
| **Total historical cash received** | **NOK 103,090** |
| Increase in registered share capital | NOK 3,090 |
| Share capital after conversion | NOK 33,090 (30,000 + 3,090) |
| Shares after conversion | 33,090 |
| Ownership per RC investor | 309 / 33,090 ≈ 0.934 % |
| All RC investors together | 3,090 / 33,090 ≈ 9.34 % |

Note that the registered share capital increases by **NOK 3,090**, not by
NOK 103,090.

## What we are asking the reviewer to confirm

1. **Classification of the Investment Amount during the active RC period.** How
   should the NOK 100,000 be classified in the accounts between Year 0 and
   conversion, given that no shares have been issued, no loan claim exists, and
   there is no obligation of ordinary repayment?
2. **Presentation in the financial statements.** Where does the amount belong,
   and under what caption?
3. **Accounting treatment at conversion.** How are the Investment Amount and the
   Par Amount treated when the Chapter 10 capital increase is completed, given
   that the increase in share capital equals only the Par Amount and no share
   premium arises from that resolution?
4. **Note and disclosure requirements.** What disclosure is required while RC
   agreements are outstanding?

## One term that needs specific attention

The RC agreement's Change of Control clause (clause 6.2(b)) lets the investor
elect a **cash settlement instead of shares**, at the higher of the Investment
Amount and the as-converted value, and clause 6.3 makes cash settlement the
**default** if the investor does not elect within the deadline.

This is the one place where the instrument can pay cash back to the investor.
It has deliberately not been changed, but the reviewer should be aware of it,
since a guaranteed floor at the Investment Amount may affect classification.

## Attachments to give the reviewer

- The signed RC agreement (Raisium → Dokumenter).
- The payment overview for the round (Investment Amounts, Year 0).
- Where a conversion has occurred: the frozen calculation summary, the general
  meeting resolution, and the Par Amount payment records.
