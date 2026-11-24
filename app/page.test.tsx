import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home from "./page";

// The landing page as the server renders it. What it says about the key must
// hold for every wallet Pairy offers: a key on this device, Varial (formerly
// Freighter) and an email or Google wallet held by Privy (O-40).
describe("Home: where your key lives", () => {
  it("names all three wallets and never says every key is made on the device", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain(
      "Your key is never sent to Pairy: it is made on your device, kept in Varial (formerly Freighter), or held by Privy behind your email or Google login.",
    );
    expect(html).not.toContain("Your key is made on your device");
  });
});
