# Security

Pairy runs on Stellar testnet only and its server holds no Stellar signing key: a wallet key stays in the user's browser (encrypted under their pincode), in Varial (formerly Freighter), or with Privy for an email or Google wallet, and the server never signs or submits a transaction.

Report a vulnerability privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for it.

Most useful to hear about: anything that lets a server, a stranger or the counterparty move funds the two traders did not agree to, read a key or pincode, sign in as someone else, or make the app record a trade differently from the chain. In a protected trade, also: an escrow created or funded on terms other than the ones both traders accepted, a resolution other than the published rule's outcome offered or recorded, one arbiter signer acting alone, Pairy's server reading or storing a Privy login or token, or signing for a Privy wallet, or the Trustless Work API key reaching a browser.

## Keys added in Phase 2

What each one can and cannot do is in the [README](README.md#every-key-a-protected-trade-adds).

- **Privy wallet key** (email or Google login): held by Privy behind the user's email or Google login. Privy's security documentation says it is split into two shares and is whole only inside Privy's secure enclave while it signs; once the user exports it, it is also whole wherever they import it. Pairy holds only Privy's public App ID and turns on none of the Privy features that let an app sign. Whoever controls the user's email or Google account controls this wallet.
- **Escrow creation key**, one per protected trade: made in the seller's browser, it signs that escrow's creation and is then dropped. It is never sent to Pairy.
- **Arbiter account** `GCAQSD3CRZVO34O7AJJWVIRKI6HGTOKLG5WSX4WJJTNG3QQ6ZWPAXCPH`, the only dispute resolver on every protected escrow. Two signer keys at weight 1, held by Ömer Alpi and Ensar Mert Günay in Varial on their own computers; its own key at weight 0; every threshold 2. Once a trader opens a dispute it can send that escrow's USDC to any address, and only Pairy's code limits it to the rule's outcome.
- **Platform account** `GAHSTUWNAQ2HJ6FPKEY6OJP6RAX4PHEEAOTB7EAZR4A2KBDGVVK3ISFW`, named on every protected escrow at a fee of 0. Its own key is at weight 0 and it has no other signer, so nothing can sign for it.
- **Trustless Work API key**, on Pairy's server only: never in the browser bundle and never in CI. It asks Trustless Work for unsigned transactions and can sign or move nothing.

`SESSION_SECRET` and `CRON_SECRET` (from Phase 1) sign login cookies and start the daily cleanup job. Neither is a Stellar key.
